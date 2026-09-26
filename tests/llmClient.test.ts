import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recoverFailedGeneration, adaptParams, buildRequestBody, callLLM, listModels } from '@/lib/api/llmClient';
import type { LLMConfig } from '@/lib/api/providers';

describe('recoverFailedGeneration', () => {
  it('recovers the action a gpt-oss model wrapped in a fake tool call', () => {
    // Real Groq response body captured by the live eval
    const body = JSON.stringify({
      error: {
        message: 'Tool choice is none, but model called a tool',
        type: 'invalid_request_error',
        code: 'tool_use_failed',
        failed_generation: '{"name": "assistant", "arguments": {"action":"navigate","url":"http://127.0.0.1:51118/search?q=x"}}',
      },
    });
    expect(JSON.parse(recoverFailedGeneration(body)!)).toEqual({ action: 'navigate', url: 'http://127.0.0.1:51118/search?q=x' });
  });

  it('handles arguments encoded as a JSON string', () => {
    const body = JSON.stringify({
      error: { code: 'tool_use_failed', failed_generation: JSON.stringify({ name: 'x', arguments: '{"action":"click","elementId":2}' }) },
    });
    expect(JSON.parse(recoverFailedGeneration(body)!)).toEqual({ action: 'click', elementId: 2 });
  });

  it('returns the raw (often empty) output for JSON-mode validation failures', () => {
    const body = JSON.stringify({ error: { code: 'json_validate_failed', failed_generation: '' } });
    expect(recoverFailedGeneration(body)).toBe('');
  });

  it('ignores other errors', () => {
    expect(recoverFailedGeneration('{"error":{"code":"model_not_found"}}')).toBeNull();
    expect(recoverFailedGeneration('not json')).toBeNull();
  });
});

describe('adaptParams', () => {
  it('drops JSON mode when the server rejects response_format', () => {
    expect(adaptParams('{"error":{"message":"response_format is not supported by this model"}}', {}))
      .toEqual({ noJsonMode: true });
  });

  it('switches to max_completion_tokens when max_tokens is refused', () => {
    expect(adaptParams("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.", {}))
      .toEqual({ useMaxCompletionTokens: true });
  });

  it('drops temperature for models that refuse it, keeping earlier fixes', () => {
    expect(adaptParams('temperature is not supported with this model', { noJsonMode: true }))
      .toEqual({ noJsonMode: true, noTemperature: true });
  });

  it('returns null for errors it cannot fix', () => {
    expect(adaptParams('invalid api key', {})).toBeNull();
    expect(adaptParams('response_format bad', { noJsonMode: true })).toBeNull(); // already tried
  });
});

describe('buildRequestBody', () => {
  it('applies fixes', () => {
    const body = buildRequestBody('m', [], { maxTokens: 50, jsonMode: true }, { useMaxCompletionTokens: true, noTemperature: true });
    expect(body).toEqual({ model: 'm', messages: [], max_completion_tokens: 50, top_p: 1, response_format: { type: 'json_object' } });
  });
});

describe('callLLM / listModels with a stubbed provider', () => {
  const config: LLMConfig = { provider: 'openai', label: 'OpenAI', baseUrl: 'https://api.test/v1', apiKey: 'sk-test', model: 'model-x' };
  const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('retries without JSON mode when the server rejects it', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":{"message":"response_format json_object is not supported"}}', { status: 400 }))
      .mockResolvedValueOnce(ok('{"action":"done"}'));

    await expect(callLLM([{ role: 'user', content: 'hi' }], { ...config, model: 'no-json' }, { jsonMode: true })).resolves.toBe('{"action":"done"}');
    const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(second.response_format).toBeUndefined();
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.test/v1/chat/completions');
  });

  it('explains a rejected key', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 }));
    await expect(callLLM([], config)).rejects.toThrow(/OpenAI rejected the API key \(401\): Incorrect API key/);
  });

  it('explains an unknown or retired model', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"The model does not exist","code":"model_not_found"}}', { status: 404 }));
    await expect(callLLM([], config)).rejects.toThrow(/doesn't offer the model "model-x".*Load models/);
  });

  it('sends no Authorization header without a key (local Ollama)', async () => {
    fetchMock.mockResolvedValue(ok('hi'));
    await callLLM([], { ...config, provider: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434/v1' });
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  it('lists model ids, sorted and de-duplicated', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] }), { status: 200 }));
    await expect(listModels(config)).resolves.toEqual(['a', 'b']);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/v1/models');
  });
});

describe('empty responses', () => {
  const config = { provider: 'openai' as const, label: 'OpenAI', baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' };
  afterEach(() => vi.unstubAllGlobals());

  it('says when a reasoning model used up its token budget without answering', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }), { status: 200 })));
    await expect(callLLM([], config)).resolves.toMatch(/used its entire token budget/);
  });
});
