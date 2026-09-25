// lib/api/groqClient.ts
// Stage 6 — Groq API client (runs ONLY in background service worker)

import { withTimeout, formatError } from '@/lib/utils/errorHandler';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Chosen by the eval baseline: qwen3.8-27b and gpt-oss-120b both passed 30/30
// standard runs; qwen used ~23% fewer tokens and was ~24% faster.
// (llama-3.1-8b-instant, the original default, was retired by Groq.)
// Users/evals can override via chrome.storage.local 'groqModel'.
export const DEFAULT_MODEL = 'qwen/qwen3.8-27b';
const REQUEST_TIMEOUT = 15000;
const GROQ_MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface GroqResponse {
  choices: {
    message: {
      content: string;
    };
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface GroqAuth {
  apiKey: string;
  model: string;
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

async function callGroq(
  messages: GroqMessage[],
  { apiKey, model }: GroqAuth,
  maxTokens = 2048,
  temperature = 0.3,
  topP = 1,
  jsonMode = false,
): Promise<string> {
  for (let attempt = 0; attempt <= GROQ_MAX_RETRIES; attempt++) {
    try {
      const response = await withTimeout(
        fetch(GROQ_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            temperature,
            top_p: topP,
            ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          }),
        }),
        REQUEST_TIMEOUT,
        'Groq API request'
      );

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');
        if (response.status === 400) {
          const recovered = recoverFailedGeneration(errorBody);
          if (recovered !== null) return recovered;
        }

        if (response.status === 401) {
          throw new Error('Invalid API key. Please update your Groq API key in the popup.');
        }

        if (response.status === 429 && attempt < GROQ_MAX_RETRIES) {
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
          const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? Math.min(retryAfterSeconds * 1000, 15000)
            : Math.min(1000 * (2 ** attempt), 12000);
          await sleep(delayMs);
          continue;
        }

        if (response.status === 429) {
          throw new Error('Rate limit exceeded. Please wait a moment and try again.');
        }

        throw new Error(`Groq API error ${response.status}: ${errorBody}`);
      }

      const data: GroqResponse = await response.json();
      return data.choices?.[0]?.message?.content?.trim() || 'No response received.';
    } catch (error) {
      const message = formatError(error);
      const isRetryable = /timed out|network|fetch|rate limit exceeded/i.test(message);

      if (attempt < GROQ_MAX_RETRIES && isRetryable) {
        await sleep(Math.min(1000 * (2 ** attempt), 12000));
        continue;
      }

      throw error;
    }
  }

  throw new Error('Groq API request failed after retries.');
}

/**
 * Summarize page content
 */
export async function summarizePage(text: string, auth: GroqAuth): Promise<string> {
  return callGroq([
    {
      role: 'system',
      content: 'You are a helpful assistant that creates clear, concise summaries. Summarize the following webpage content in well-structured bullet points. Focus on the key information and main ideas. Use markdown formatting.',
    },
    {
      role: 'user',
      content: `Please summarize the following webpage content:\n\n${text}`,
    },
  ], auth);
}

/**
 * Explain selected text
 */
export async function explainText(text: string, auth: GroqAuth): Promise<string> {
  return callGroq([
    {
      role: 'system',
      content: 'You are a helpful assistant that explains concepts clearly and concisely. Provide a clear explanation of the following text. If it contains technical terms, explain them simply. Use markdown formatting.',
    },
    {
      role: 'user',
      content: `Please explain the following text:\n\n"${text}"`,
    },
  ], auth);
}

/**
 * Free-form chat about the page content
 */
export async function chatWithPage(message: string, pageContext: string, auth: GroqAuth): Promise<string> {
  return callGroq([
    {
      role: 'system',
      content: `You are Genesis, an AI browser assistant. You have access to the current webpage's content. Answer the user's questions about the page clearly and helpfully. If the question isn't about the page, still try your best to help. Use markdown formatting.\n\nWebpage content:\n${pageContext.substring(0, 10000)}`,
    },
    {
      role: 'user',
      content: message,
    },
  ], auth);
}

/**
 * Agent step planner — given a goal, DOM snapshot, and action history,
 * returns the next action to take as structured JSON.
 */
export async function planAgentStep(
  goal: string,
  domSnapshot: string,
  actionHistory: string[],
  auth: GroqAuth,
): Promise<string> {
  const historyText = actionHistory.length > 0
    ? `\n\nACTION HISTORY (steps already taken):\n${actionHistory.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
    : '';

  return callGroq([
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
8. Maximum 20 steps per task — be efficient.`,
    },
    {
      role: 'user',
      content: `GOAL: ${goal}\n\nCURRENT PAGE DOM SNAPSHOT:\n${domSnapshot.substring(0, 6000)}${historyText}\n\nWhat is the NEXT single action? Respond with JSON only.`,
    },
  ], auth, 1024, 0, 1, true); // headroom: reasoning models think before answering
}

