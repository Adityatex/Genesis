import { describe, it, expect } from 'vitest';
import {
  PROVIDERS, SETTINGS_KEY, readSettings, resolveConfig, validateBaseUrl, configProblem, maskKey,
  type StoredLLMSettings,
} from '@/lib/api/providers';

describe('readSettings', () => {
  it('migrates the old Groq-only storage keys', () => {
    const s = readSettings({ groqApiKey: 'gsk_old', groqModel: 'openai/gpt-oss-120b' });
    expect(s).toEqual({ provider: 'groq', models: { groq: 'openai/gpt-oss-120b' }, keys: { groq: 'gsk_old' } });
  });

  it('prefers saved multi-provider settings', () => {
    const saved: StoredLLMSettings = { provider: 'deepseek', models: { deepseek: 'm' }, keys: { deepseek: 'k' } };
    expect(readSettings({ [SETTINGS_KEY]: saved, groqApiKey: 'gsk_old' }).provider).toBe('deepseek');
  });

  it('defaults to Groq with nothing saved', () => {
    expect(readSettings({})).toEqual({ provider: 'groq', models: {}, keys: {} });
  });

  it('ignores a saved unknown provider', () => {
    expect(readSettings({ [SETTINGS_KEY]: { provider: 'nope', models: {}, keys: {} } }).provider).toBe('groq');
  });
});

describe('resolveConfig', () => {
  const settings: StoredLLMSettings = {
    provider: 'groq',
    models: { deepseek: 'deepseek-x' },
    keys: { groq: 'gsk_1', deepseek: 'sk-2' },
    customBaseUrl: 'https://llm.example.com/v1/',
  };

  it('uses the preset URL, the saved key and the benchmarked default model', () => {
    expect(resolveConfig(settings)).toEqual({
      provider: 'groq', label: 'Groq', baseUrl: PROVIDERS.groq.baseUrl, apiKey: 'gsk_1', model: PROVIDERS.groq.defaultModel,
    });
  });

  it('keeps a separate key and model per provider', () => {
    const c = resolveConfig(settings, 'deepseek');
    expect([c.apiKey, c.model]).toEqual(['sk-2', 'deepseek-x']);
  });

  it('uses the custom URL without a trailing slash', () => {
    expect(resolveConfig(settings, 'custom').baseUrl).toBe('https://llm.example.com/v1');
  });
});

describe('validateBaseUrl', () => {
  it('accepts https anywhere and http only on this machine', () => {
    expect(validateBaseUrl('https://api.example.com/v1')).toBeNull();
    expect(validateBaseUrl('http://localhost:11434/v1')).toBeNull();
    expect(validateBaseUrl('http://127.0.0.1:8080/v1')).toBeNull();
  });

  it('refuses to send keys over plain http to other hosts', () => {
    expect(validateBaseUrl('http://api.example.com/v1')).toMatch(/Use https:\/\//);
    expect(validateBaseUrl('ftp://example.com')).toMatch(/https/);
    expect(validateBaseUrl('not a url')).toMatch(/full URL/);
  });
});

describe('configProblem', () => {
  const base = { provider: 'groq' as const, label: 'Groq', baseUrl: PROVIDERS.groq.baseUrl, apiKey: 'k', model: 'm' };

  it('is null when ready', () => {
    expect(configProblem(base)).toBeNull();
  });

  it('asks for a missing key or model', () => {
    expect(configProblem({ ...base, apiKey: '' })).toMatch(/No API key for Groq/);
    expect(configProblem({ ...base, model: '' })).toMatch(/Choose a Groq model/);
  });

  it('does not require a key for local Ollama', () => {
    expect(configProblem({ provider: 'ollama', label: 'Ollama', baseUrl: PROVIDERS.ollama.baseUrl, apiKey: '', model: 'llama' })).toBeNull();
  });
});

describe('maskKey', () => {
  it('shows only the ends of a key', () => {
    expect(maskKey('gsk_abcdefghijklmnop1234')).toBe('gsk_ab…1234');
    expect(maskKey('short')).toBe('••••');
    expect(maskKey('')).toBe('');
  });
});
