// lib/api/providers.ts
// LLM provider presets and settings. Every provider here speaks the OpenAI
// chat-completions API, so one client (llmClient.ts) serves them all.

export type ProviderId = 'groq' | 'deepseek' | 'openai' | 'openrouter' | 'ollama' | 'custom';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  /** Base URL of the OpenAI-compatible API ('' for custom: the user supplies it). */
  baseUrl: string;
  needsKey: boolean;
  keyUrl?: string;
  /**
   * Only set where it has been benchmarked. Model names change and get
   * retired (Groq retired this project's original default), so for other
   * providers the popup lists what the key can actually use via /models.
   */
  defaultModel?: string;
  note?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  groq: {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    defaultModel: 'qwen/qwen3.8-27b',
    note: 'Free tier: about 8k tokens/minute and 200k tokens/day per model.',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    needsKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    note: 'Runs on your machine; nothing leaves it. Start Ollama with OLLAMA_ORIGINS=chrome-extension://* so the extension may call it.',
  },
  custom: {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    needsKey: false,
    note: 'Any server with an OpenAI-compatible /chat/completions endpoint.',
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/** What's saved in chrome.storage.local under SETTINGS_KEY. */
export interface StoredLLMSettings {
  provider: ProviderId;
  /** Chosen model per provider, so switching back and forth keeps each choice. */
  models: Partial<Record<ProviderId, string>>;
  /** API key per provider. Only the background service worker reads these. */
  keys: Partial<Record<ProviderId, string>>;
  customBaseUrl?: string;
}

export const SETTINGS_KEY = 'genesis_llm';
/** Storage keys from before multi-provider support (Groq only). */
export const LEGACY_KEYS = ['groqApiKey', 'groqModel'] as const;

/** Everything a request needs, resolved from settings. */
export interface LLMConfig {
  provider: ProviderId;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Stored settings, migrating the old Groq-only keys if that's all there is. */
export function readSettings(stored: Record<string, unknown>): StoredLLMSettings {
  const saved = stored[SETTINGS_KEY] as StoredLLMSettings | undefined;
  if (saved?.provider && PROVIDERS[saved.provider]) {
    return { provider: saved.provider, models: saved.models ?? {}, keys: saved.keys ?? {}, customBaseUrl: saved.customBaseUrl };
  }
  const legacyKey = typeof stored.groqApiKey === 'string' ? stored.groqApiKey : '';
  const legacyModel = typeof stored.groqModel === 'string' ? stored.groqModel : '';
  return {
    provider: 'groq',
    models: legacyModel ? { groq: legacyModel } : {},
    keys: legacyKey ? { groq: legacyKey } : {},
  };
}

/** Config for the active provider (or `provider`, when given). */
export function resolveConfig(settings: StoredLLMSettings, provider: ProviderId = settings.provider): LLMConfig {
  const preset = PROVIDERS[provider];
  return {
    provider,
    label: preset.label,
    baseUrl: (provider === 'custom' ? settings.customBaseUrl ?? '' : preset.baseUrl).replace(/\/+$/, ''),
    apiKey: settings.keys[provider] ?? '',
    model: settings.models[provider] || preset.defaultModel || '',
  };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * API keys and page content go to this URL, so it must be HTTPS. Plain HTTP is
 * allowed only for servers on this machine (e.g. Ollama). Returns an error
 * message, or null if the URL is fine.
 */
export function validateBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter a full URL, e.g. https://api.example.com/v1';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return null;
  if (url.protocol === 'http:') return 'Use https:// (http:// is only allowed for localhost), since your API key and page content are sent to this URL';
  return 'The URL must start with https://';
}

/** Why this config can't make requests yet, or null if it's ready. */
export function configProblem(config: LLMConfig): string | null {
  const preset = PROVIDERS[config.provider];
  if (!config.baseUrl) return `Set the server URL for ${config.label} in the Genesis popup.`;
  const urlError = validateBaseUrl(config.baseUrl);
  if (urlError) return `${config.label} URL: ${urlError}.`;
  if (preset.needsKey && !config.apiKey) return `No API key for ${config.label}. Add one in the Genesis popup.`;
  if (!config.model) return `Choose a ${config.label} model in the Genesis popup ("Load models" lists what your key can use).`;
  return null;
}

export function maskKey(key: string): string {
  if (!key) return '';
  return key.length <= 12 ? '••••' : `${key.slice(0, 6)}…${key.slice(-4)}`;
}
