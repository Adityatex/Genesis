// lib/api/llmClient.ts
// LLM client for any OpenAI-compatible provider (Groq, DeepSeek, OpenAI,
// OpenRouter, Ollama, custom). Runs ONLY in the background service worker.

import { withTimeout, formatError } from '@/lib/utils/errorHandler';
import { PROVIDERS, type LLMConfig } from '@/lib/api/providers';
import { promptHistory } from '@/lib/agent/history';
import { MAX_BATCH } from '@/lib/agent/parseAction';

const REQUEST_TIMEOUT = 15000;
const MODELS_TIMEOUT = 10000;
const MAX_RETRIES = 3;
/** Parameter fixes (see adaptParams) attempted per request before giving up. */
const MAX_PARAM_FIXES = 3;
// The snapshot budgets its own size (SNAPSHOT_BUDGET); this only guards
// against a runaway page. Cutting it blindly used to hide whole page regions.
const SNAPSHOT_SAFETY_CAP = 9000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatResponse {
  choices: {
    message: {
      content: string | null;
    };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface CallOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** Ask for a JSON object (response_format json_object). */
  jsonMode?: boolean;
  /**
   * Throw at the first rate limit or connection failure instead of waiting and
   * retrying: used when another provider can take the request.
   */
  failFast?: boolean;
}

/**
 * Why a provider couldn't answer:
 * - rate-limit: per-minute limits; retryAfterMs says when to try again, if known
 * - daily: a per-day quota is used up
 * - auth: key rejected; model: the key can't use this model
 * - unavailable: timeout, network error or server error
 * - other: any other error response
 */
export type LLMErrorKind = 'rate-limit' | 'daily' | 'auth' | 'model' | 'unavailable' | 'other';

export class LLMError extends Error {
  constructor(message: string, readonly kind: LLMErrorKind, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'LLMError';
  }
}

/** Per-day quota messages: Groq (TPD/RPD), Gemini (PerDay), and others' "per day". */
export function isDailyLimit(message: string): boolean {
  return /per ?day|\bTPD\b|\bRPD\b/i.test(message);
}

/**
 * Request fields some providers or models reject. Reasoning models often
 * refuse temperature/top_p, newer OpenAI models want max_completion_tokens,
 * and not every server supports JSON mode.
 */
export interface ParamFixes {
  noJsonMode?: boolean;
  useMaxCompletionTokens?: boolean;
  noTemperature?: boolean;
  noTopP?: boolean;
  /**
   * A lower response cap. Some providers count the cap against a per-request
   * limit (Groq's free tier: prompt + max_tokens must fit in 8k tokens/minute).
   */
  maxTokens?: number;
}

/** The response cap is never reduced below this. */
const MIN_MAX_TOKENS = 256;

// Learned per baseUrl + model, so only the first request pays for a rejected field
const learnedFixes = new Map<string, ParamFixes>();

export function buildRequestBody(model: string, messages: ChatMessage[], opts: CallOptions, fixes: ParamFixes): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages };
  body[fixes.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = fixes.maxTokens ?? opts.maxTokens ?? 2048;
  if (!fixes.noTemperature) body.temperature = opts.temperature ?? 0.3;
  if (!fixes.noTopP) body.top_p = opts.topP ?? 1;
  if (opts.jsonMode && !fixes.noJsonMode) body.response_format = { type: 'json_object' };
  return body;
}

/**
 * Given a 400 error body, the field change that should fix it, or null if the
 * error isn't about a request field we can drop or rename.
 */
export function adaptParams(errorBody: string, fixes: ParamFixes, requestedMaxTokens = 2048): ParamFixes | null {
  const e = errorBody.toLowerCase();
  // "Request too large": the response cap is over a limit. If the error names an
  // output-tokens-per-minute limit (Groq's OTPM), go safely under it; else halve.
  const cap = fixes.maxTokens ?? requestedMaxTokens;
  if (/request too large|reduce your message size|reduce max_tokens|exceeds the (token|context) limit/.test(e) && cap > MIN_MAX_TOKENS) {
    const outputLimit = /output tokens per minute|otpm/.test(e) ? Number(/limit (\d+)/.exec(e)?.[1]) : NaN;
    const next = Number.isFinite(outputLimit) ? Math.floor(outputLimit * 0.8) : Math.floor(cap / 2);
    return { ...fixes, maxTokens: Math.max(MIN_MAX_TOKENS, Math.min(next, cap - 1)) };
  }
  if (!fixes.noJsonMode && /response_format|json_object|json mode/.test(e)) return { ...fixes, noJsonMode: true };
  if (!fixes.useMaxCompletionTokens && /max_tokens/.test(e) && /max_completion_tokens|not supported|unsupported/.test(e)) {
    return { ...fixes, useMaxCompletionTokens: true };
  }
  if (!fixes.noTemperature && /temperature/.test(e)) return { ...fixes, noTemperature: true };
  if (!fixes.noTopP && /top_p/.test(e)) return { ...fixes, noTopP: true };
  return null;
}

/**
 * Groq rejects some model outputs with a 400 but includes what the model
 * generated as `failed_generation`. Returns that output so the caller can use
 * or validate it, or null for any other error.
 * - tool_use_failed: gpt-oss wrapped its answer in a tool call although no
 *   tools were offered, e.g. {"name": "assistant", "arguments": {"action": ...}}
 *   → returns the arguments as JSON.
 * - json_validate_failed: JSON mode output wasn't valid JSON (often empty)
 *   → returns the raw text; the agent's parser reports it and the loop retries.
 */
export function recoverFailedGeneration(errorBody: string): string | null {
  let err: any;
  try {
    err = JSON.parse(errorBody)?.error;
  } catch {
    return null;
  }
  if (typeof err?.failed_generation !== 'string') return null;

  if (err.code === 'json_validate_failed') return err.failed_generation;
  if (err.code === 'tool_use_failed') {
    try {
      const call = JSON.parse(err.failed_generation);
      const args = typeof call?.arguments === 'string' ? JSON.parse(call.arguments) : call?.arguments;
      if (args && typeof args === 'object') return JSON.stringify(args);
    } catch { /* fall through to raw text */ }
    return err.failed_generation;
  }
  return null;
}

function authHeaders(config: LLMConfig): Record<string, string> {
  // Local servers (Ollama) need no key; never send an empty Bearer header
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

/** Short message from a provider's error body, without echoing anything huge. */
function errorMessage(body: string): string {
  try {
    let parsed = JSON.parse(body);
    if (Array.isArray(parsed)) parsed = parsed[0]; // Gemini wraps errors in an array
    const msg = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    if (typeof msg === 'string') return msg.slice(0, 300);
  } catch { /* not JSON */ }
  return body.slice(0, 300);
}

function isModelNotFound(status: number, body: string): boolean {
  return status === 404 || /model_not_found|model .*(does not exist|not found)|unknown model|invalid model/i.test(body);
}

export async function callLLM(messages: ChatMessage[], config: LLMConfig, opts: CallOptions = {}): Promise<string> {
  const url = `${config.baseUrl}/chat/completions`;
  const fixKey = `${config.baseUrl}|${config.model}`;
  let fixes: ParamFixes = learnedFixes.get(fixKey) ?? {};
  let fixesTried = 0;
  const failFast = opts.failFast ?? config.failFast ?? false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(config) },
          body: JSON.stringify(buildRequestBody(config.model, messages, opts, fixes)),
        }),
        REQUEST_TIMEOUT,
        `${config.label} request`,
      );

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');
        // 400 = a field was rejected; 413, or 429 "Request too large", = the request
        // (prompt + response cap) is over a size limit. Both are fixable by adjusting it.
        const tooLarge = response.status === 413 || (response.status === 429 && /request too large/i.test(errorBody));
        if (response.status === 400 || tooLarge) {
          const recovered = recoverFailedGeneration(errorBody);
          if (recovered !== null) return recovered;

          const adapted = adaptParams(errorBody, fixes, opts.maxTokens);
          if (adapted && fixesTried < MAX_PARAM_FIXES) {
            fixes = adapted;
            fixesTried++;
            learnedFixes.set(fixKey, fixes);
            attempt--; // a field fix is not a failed attempt
            continue;
          }
        }

        if (response.status === 401 || response.status === 403) {
          throw new LLMError(`${config.label} rejected the API key (${response.status}): ${errorMessage(errorBody)}. Update it in the Genesis popup.`, 'auth');
        }

        if (isModelNotFound(response.status, errorBody)) {
          throw new LLMError(`${config.label} doesn't offer the model "${config.model}" to this key. Pick another with "Load models" in the Genesis popup.`, 'model');
        }

        if (response.status === 429) {
          const detail = errorMessage(errorBody);
          const retryAfterSeconds = Number(response.headers.get('retry-after') ?? NaN);
          const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : undefined;
          // A per-day quota won't come back within any retry
          if (isDailyLimit(detail)) throw new LLMError(`Daily limit reached on ${config.label}: ${detail}`, 'daily', retryAfterMs);
          if (failFast || attempt >= MAX_RETRIES) {
            throw new LLMError(`Rate limit exceeded on ${config.label}: ${detail}`, 'rate-limit', retryAfterMs);
          }
          await sleep(retryAfterMs ? Math.min(retryAfterMs, 15000) : Math.min(1000 * (2 ** attempt), 12000));
          continue;
        }

        const kind: LLMErrorKind = response.status >= 500 ? 'unavailable' : 'other';
        throw new LLMError(`${config.label} API error ${response.status}: ${errorMessage(errorBody)}`, kind);
      }

      const data: ChatResponse = await response.json();
      const choice = data.choices?.[0];
      const content = choice?.message?.content?.trim();
      if (content) return content;
      // Reasoning models can spend the whole token budget thinking and answer nothing
      return choice?.finish_reason === 'length'
        ? '(empty response: the model used its entire token budget before answering)'
        : 'No response received.';
    } catch (error) {
      if (error instanceof LLMError) throw error; // already classified (and retried where useful)
      const message = formatError(error);
      const isConnection = /timed out|network|failed to fetch/i.test(message);
      if (!isConnection) throw error;
      if (attempt < MAX_RETRIES && !failFast) {
        await sleep(Math.min(1000 * (2 ** attempt), 12000));
        continue;
      }
      throw new LLMError(`${config.label} is unreachable: ${message}`, 'unavailable');
    }
  }

  throw new LLMError(`${config.label} request failed after retries.`, 'unavailable');
}

export interface ModelInfo {
  id: string;
  free?: boolean;
  /** The provider says it may train on your prompts (which include page content). */
  mayTrain?: boolean;
}

/**
 * Models this config's key can use, from the provider's /models endpoint:
 * free ones first, without models Genesis can't use (non-text output, or an
 * API other than chat completions).
 */
export async function listModels(config: LLMConfig): Promise<ModelInfo[]> {
  const response = await withTimeout(
    fetch(`${config.baseUrl}/models`, { headers: authHeaders(config) }),
    MODELS_TIMEOUT,
    `${config.label} model list`,
  );
  const body = await response.text().catch(() => '');
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${config.label} rejected the API key (${response.status}): ${errorMessage(body)}`);
  }
  if (!response.ok) throw new Error(`${config.label} could not list models (${response.status}): ${errorMessage(body)}`);

  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${config.label} returned an unexpected model list`);
  }
  const items: any[] = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : [];
  const preset = PROVIDERS[config.provider];
  const models = new Map<string, ModelInfo>();
  for (const m of items) {
    const rawId = typeof m === 'string' ? m : m?.id ?? m?.name;
    if (typeof rawId !== 'string' || !rawId) continue;
    const id = rawId.replace(/^models\//, ''); // Gemini lists "models/<id>" but takes "<id>"
    if (m?.capabilities?.completion_chat === false) continue; // Mistral: embedding/OCR/moderation models
    // Skip image/audio generators: the agent needs text out
    const outputs = m?.architecture?.output_modalities;
    if (Array.isArray(outputs) && !outputs.includes('text')) continue;
    if (preset.modelFilter && !preset.modelFilter(id)) continue;

    const price = m?.pricing;
    const free = m?.isFree === true
      || /(:free|-free)$/.test(id)
      || (price && Number(price.prompt) === 0 && Number(price.completion) === 0)
      || !!preset.freeModels?.includes(id);
    models.set(id, { id, ...(free ? { free: true } : {}), ...(m?.mayTrainOnYourPrompts === true ? { mayTrain: true } : {}) });
  }
  return [...models.values()].sort((a, b) => Number(!!b.free) - Number(!!a.free) || a.id.localeCompare(b.id));
}

/**
 * Summarize page content
 */
export async function summarizePage(text: string, config: LLMConfig): Promise<string> {
  return callLLM([
    {
      role: 'system',
      content: 'You are a helpful assistant that creates clear, concise summaries. Summarize the following webpage content in well-structured bullet points. Focus on the key information and main ideas. Use markdown formatting.',
    },
    {
      role: 'user',
      content: `Please summarize the following webpage content:\n\n${text}`,
    },
  ], config);
}

/**
 * Explain selected text
 */
export async function explainText(text: string, config: LLMConfig): Promise<string> {
  return callLLM([
    {
      role: 'system',
      content: 'You are a helpful assistant that explains concepts clearly and concisely. Provide a clear explanation of the following text. If it contains technical terms, explain them simply. Use markdown formatting.',
    },
    {
      role: 'user',
      content: `Please explain the following text:\n\n"${text}"`,
    },
  ], config);
}

/**
 * Free-form chat about the page content
 */
export async function chatWithPage(message: string, pageContext: string, config: LLMConfig): Promise<string> {
  return callLLM([
    {
      role: 'system',
      content: `You are Genesis, an AI browser assistant. You have access to the current webpage's content. Answer the user's questions about the page clearly and helpfully. If the question isn't about the page, still try your best to help. Use markdown formatting.\n\nWebpage content:\n${pageContext.substring(0, 10000)}`,
    },
    {
      role: 'user',
      content: message,
    },
  ], config);
}

/**
 * Agent step planner: given a goal, DOM snapshot, action history and the
 * model's own plan so far, returns its next actions as JSON (see the prompt).
 */
export async function planAgentStep(
  goal: string,
  domSnapshot: string,
  actionHistory: string[],
  currentPlan: string[],
  config: LLMConfig,
): Promise<string> {
  const planText = currentPlan.length > 0
    ? `\n\nYOUR PLAN (from your last response):\n${currentPlan.join('\n')}`
    : '';
  const historyText = actionHistory.length > 0
    ? `\n\nACTION HISTORY (steps already taken):\n${promptHistory(actionHistory).join('\n')}`
    : '';

  return callLLM([
    {
      role: 'system',
      content: `You are a browser automation agent called Genesis. You control a web browser to reach the user's goal, quickly and reliably.

RESPONSE FORMAT (one JSON object, nothing else):
{"plan": ["[x] finished step", "[ ] next step", "[ ] later step"], "actions": [<action>, <action>, ...]}
- "plan": your short checklist for the whole goal (at most 8 items). Send it in your first response, and again whenever it changes or an item gets done. Leave it out otherwise.
- "actions": 1 to ${MAX_BATCH} actions, run in order.

ACTIONS:
- {"action": "click", "elementId": <number>} — Click an interactive element by its ID
- {"action": "type", "elementId": <number>, "text": "<text>"} — Append text to an input
- {"action": "clear_and_type", "elementId": <number>, "text": "<text>"} — Clear input then type text
- {"action": "select", "elementId": <number>, "value": "<option label>"} — Choose an option in a dropdown: a native <select> (use one of its options=[...]) or a custom one (combobox, [popup=listbox], ...), which it opens for you
- {"action": "navigate", "url": "<full url>"} — Navigate to a URL
- {"action": "scroll", "direction": "up"|"down"} — Scroll the page
- {"action": "press_key", "key": "<key name>", "elementId": <optional number>} — Press a keyboard key (Enter, Tab, Escape, etc.)
- {"action": "read", "elementId": <optional number>} — Read text content
- {"action": "find", "text": "<words>"} — Search ALL elements on the page, including ones not listed in the snapshot; returns their IDs
- {"action": "note", "text": "<facts>"} — Write down facts you will need later (prices, specs, amounts, names). Notes stay in your ACTION HISTORY after you leave the page
- {"action": "wait", "text": "<milliseconds>"} — Wait for content to load
- {"action": "done", "summary": "<what was accomplished>"} — Task is complete

RULES:
1. Output ONLY the JSON object. No explanation, no markdown, no extra text.
2. Use element IDs from the DOM snapshot [0], [1], [2]... to target elements.
3. Send several actions at once when you can already see everything they need, e.g. fill every field of a form and then click its submit button. Put an action that changes the page (submitting, following a link, opening a menu or dialog) LAST: the rest of the list is skipped if the page changes or an action fails, and you'll get a fresh snapshot.
4. After typing in a search box, press Enter or click the search button.
5. If the page doesn't have what you need, navigate to the right URL first.
6. When the goal is complete, send "done" with a summary, on its own, after you've seen the result of your last actions. Only "note" actions may come before it in the same list.
7. If you're stuck or the goal is impossible, send "done" with an explanation.
8. On long pages the element list is cut short. If the element you need is not listed, use "find" with a keyword before scrolling or guessing URLs.
9. You only see the current page. Once you leave it, its content is gone; your ACTION HISTORY is your only memory. Before leaving a page, "note" anything you need from it. The snapshot may also end with PAGES YOU VISITED EARLIER, excerpts of pages you already read. Never revisit a page just to re-read it: use your notes and those excerpts.
10. Be efficient: take the shortest path to the goal. If an action didn't change anything, don't repeat it; try something else.`,
    },
    {
      role: 'user',
      content: `GOAL: ${goal}\n\nCURRENT PAGE DOM SNAPSHOT:\n${domSnapshot.substring(0, SNAPSHOT_SAFETY_CAP)}${planText}${historyText}\n\nWhat are the NEXT actions? Respond with JSON only.`,
    },
  // Headroom: reasoning models think before answering (deepseek-v4-pro used >1k)
  ], config, { maxTokens: config.maxOutputTokens ?? 4096, temperature: 0, topP: 1, jsonMode: true });
}

