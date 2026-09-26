// lib/api/llmClient.ts
// LLM client for any OpenAI-compatible provider (Groq, DeepSeek, OpenAI,
// OpenRouter, Ollama, custom). Runs ONLY in the background service worker.

import { withTimeout, formatError } from '@/lib/utils/errorHandler';
import type { LLMConfig } from '@/lib/api/providers';

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
}

// Learned per baseUrl + model, so only the first request pays for a rejected field
const learnedFixes = new Map<string, ParamFixes>();

export function buildRequestBody(model: string, messages: ChatMessage[], opts: CallOptions, fixes: ParamFixes): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages };
  body[fixes.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = opts.maxTokens ?? 2048;
  if (!fixes.noTemperature) body.temperature = opts.temperature ?? 0.3;
  if (!fixes.noTopP) body.top_p = opts.topP ?? 1;
  if (opts.jsonMode && !fixes.noJsonMode) body.response_format = { type: 'json_object' };
  return body;
}

/**
 * Given a 400 error body, the field change that should fix it, or null if the
 * error isn't about a request field we can drop or rename.
 */
export function adaptParams(errorBody: string, fixes: ParamFixes): ParamFixes | null {
  const e = errorBody.toLowerCase();
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
    const parsed = JSON.parse(body);
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
        if (response.status === 400) {
          const recovered = recoverFailedGeneration(errorBody);
          if (recovered !== null) return recovered;

          const adapted = adaptParams(errorBody, fixes);
          if (adapted && fixesTried < MAX_PARAM_FIXES) {
            fixes = adapted;
            fixesTried++;
            learnedFixes.set(fixKey, fixes);
            attempt--; // a field fix is not a failed attempt
            continue;
          }
        }

        if (response.status === 401 || response.status === 403) {
          throw new Error(`${config.label} rejected the API key (${response.status}): ${errorMessage(errorBody)}. Update it in the Genesis popup.`);
        }

        if (isModelNotFound(response.status, errorBody)) {
          throw new Error(`${config.label} doesn't offer the model "${config.model}" to this key. Pick another with "Load models" in the Genesis popup.`);
        }

        if (response.status === 429 && attempt < MAX_RETRIES) {
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
          const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? Math.min(retryAfterSeconds * 1000, 15000)
            : Math.min(1000 * (2 ** attempt), 12000);
          await sleep(delayMs);
          continue;
        }

        if (response.status === 429) {
          throw new Error(`Rate limit exceeded on ${config.label}: ${errorMessage(errorBody)}`);
        }

        throw new Error(`${config.label} API error ${response.status}: ${errorMessage(errorBody)}`);
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
      const message = formatError(error);
      const isRetryable = /timed out|network|failed to fetch|rate limit exceeded/i.test(message);

      if (attempt < MAX_RETRIES && isRetryable) {
        await sleep(Math.min(1000 * (2 ** attempt), 12000));
        continue;
      }

      throw error;
    }
  }

  throw new Error(`${config.label} request failed after retries.`);
}

/** Model IDs this config's key can use, from the provider's /models endpoint. */
export async function listModels(config: LLMConfig): Promise<string[]> {
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
  const items: unknown[] = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : [];
  const ids = items
    .map((m: any) => (typeof m === 'string' ? m : m?.id ?? m?.name))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
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
 * Agent step planner — given a goal, DOM snapshot, and action history,
 * returns the next action to take as structured JSON.
 */
export async function planAgentStep(
  goal: string,
  domSnapshot: string,
  actionHistory: string[],
  config: LLMConfig,
): Promise<string> {
  const historyText = actionHistory.length > 0
    ? `\n\nACTION HISTORY (steps already taken):\n${actionHistory.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
    : '';

  return callLLM([
    {
      role: 'system',
      content: `You are a browser automation agent called Genesis. You control a web browser by issuing ONE action at a time.

AVAILABLE ACTIONS (respond with exactly ONE as JSON):
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
1. Output ONLY a single JSON object. No explanation, no markdown, no extra text.
2. Use element IDs from the DOM snapshot [0], [1], [2]... to target elements.
3. Think step by step — do ONE thing at a time.
4. After typing in a search box, press Enter or click the search button.
5. If the page doesn't have what you need, navigate to the right URL first.
6. If you've completed the goal, use "done" with a summary.
7. If you're stuck or the goal is impossible, use "done" with an explanation.
8. On long pages the element list is cut short. If the element you need is not listed, use "find" with a keyword before scrolling or guessing URLs.
9. You only see the current page. Once you leave it, its content is gone; your ACTION HISTORY is your only memory. Before leaving a page, "note" anything you need from it. Never revisit a page just to re-read it: use your notes.
10. Maximum 20 steps per task — be efficient.`,
    },
    {
      role: 'user',
      content: `GOAL: ${goal}\n\nCURRENT PAGE DOM SNAPSHOT:\n${domSnapshot.substring(0, SNAPSHOT_SAFETY_CAP)}${historyText}\n\nWhat is the NEXT single action? Respond with JSON only.`,
    },
  ], config, { maxTokens: 4096, temperature: 0, topP: 1, jsonMode: true }); // headroom: reasoning models think before answering
}

