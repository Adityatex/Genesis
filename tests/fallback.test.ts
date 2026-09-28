import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProviderPool, modelLabel } from '@/lib/api/fallback';
import { LLMError, callLLM } from '@/lib/api/llmClient';
import { resolveChain, readSettings, SETTINGS_KEY, type LLMConfig, type StoredLLMSettings } from '@/lib/api/providers';

const groq: LLMConfig = { provider: 'groq', label: 'Groq', baseUrl: 'https://groq.test/v1', apiKey: 'k1', model: 'qwen' };
const gemini: LLMConfig = { provider: 'gemini', label: 'Gemini', baseUrl: 'https://gemini.test/v1', apiKey: 'k2', model: 'flash-lite' };
const mistral: LLMConfig = { provider: 'mistral', label: 'Mistral', baseUrl: 'https://mistral.test/v1', apiKey: 'k3', model: 'small' };

/** A pool on a fake clock; `fail` maps provider → the error it throws. */
function setup(fail: Partial<Record<string, LLMError>> = {}) {
  let now = 1_000_000;
  const sleep = vi.fn(async (ms: number) => { now += ms; });
  const pool = new ProviderPool(() => now, sleep);
  const calls: { provider: string; failFast?: boolean }[] = [];
  const call = vi.fn(async (config: LLMConfig) => {
    calls.push({ provider: config.provider, failFast: config.failFast });
    const error = fail[config.provider];
    if (error) throw error;
    return `answer from ${config.provider}`;
  });
  return { pool, call, calls, sleep, advance: (ms: number) => { now += ms; } };
}

describe('provider fallback', () => {
  it('uses the main provider when it answers, and lets a lone provider retry patiently', async () => {
    const { pool, call, calls } = setup();
    const result = await pool.run([groq, gemini], call);
    expect(result.value).toBe('answer from groq');
    expect(result.skipped).toEqual([]);
    expect(calls).toEqual([{ provider: 'groq', failFast: true }]);

    const alone = setup();
    await alone.pool.run([groq], alone.call);
    expect(alone.calls).toEqual([{ provider: 'groq', failFast: undefined }]); // no backup: wait out limits as before
  });

  it('moves to the next provider on a rate limit and says why', async () => {
    const { pool, call, calls } = setup({ groq: new LLMError('Rate limit exceeded on Groq', 'rate-limit') });
    const result = await pool.run([groq, gemini, mistral], call);
    expect(result.value).toBe('answer from gemini');
    expect(result.config).toBe(gemini);
    expect(result.skipped).toEqual([{ label: 'Groq · qwen', reason: 'hit its rate limit' }]);
    expect(calls.map((c) => c.provider)).toEqual(['groq', 'gemini']);
  });

  it('skips a resting provider, then goes back to it once its rest is over', async () => {
    const env = setup({ groq: new LLMError('Rate limit', 'rate-limit', 5_000) });
    await env.pool.run([groq, gemini], env.call);

    env.calls.length = 0;
    const whileResting = await env.pool.run([groq, gemini], env.call);
    expect(env.calls.map((c) => c.provider)).toEqual(['gemini']); // not even tried
    expect(whileResting.skipped).toEqual([{ label: 'Groq · qwen', reason: 'hit its rate limit' }]);
    // The last provider available retries patiently rather than failing fast
    expect(env.calls[0].failFast).toBeUndefined();

    env.advance(5_001); // its retry-after has passed
    env.calls.length = 0;
    env.call.mockImplementation(async (config: LLMConfig) => `answer from ${config.provider}`);
    const after = await env.pool.run([groq, gemini], env.call);
    expect(after.config).toBe(groq);
  });

  it('rests a provider for the rest of the session when its daily quota or key is the problem', async () => {
    const env = setup({ groq: new LLMError('Daily limit reached', 'daily'), gemini: new LLMError('bad key', 'auth') });
    await env.pool.run([groq, gemini, mistral], env.call);
    env.advance(10 * 60_000);
    expect(env.pool.restingReason(groq)).toBe('used up its daily quota');
    expect(env.pool.restingReason(gemini)).toBe('rejected its API key');
  });

  it('throws the last error when every provider fails', async () => {
    const last = new LLMError('Mistral API error 500', 'unavailable');
    const { pool, call } = setup({ groq: new LLMError('rl', 'rate-limit'), gemini: new LLMError('rl', 'rate-limit'), mistral: last });
    await expect(pool.run([groq, gemini, mistral], call)).rejects.toBe(last);
  });

  it('when everyone is resting, waits for the first one back if that is soon', async () => {
    const env = setup({ groq: new LLMError('rl', 'rate-limit', 3_000), gemini: new LLMError('rl', 'rate-limit', 8_000) });
    await expect(env.pool.run([groq, gemini], env.call)).rejects.toThrow();
    env.call.mockImplementation(async (config: LLMConfig) => `answer from ${config.provider}`);
    const result = await env.pool.run([groq, gemini], env.call);
    expect(env.sleep).toHaveBeenCalledWith(3_000);
    expect(result.config).toBe(groq);
  });

  it('gives up with a clear message when nobody is back for a long time', async () => {
    const env = setup({ groq: new LLMError('d', 'daily'), gemini: new LLMError('d', 'daily') });
    await expect(env.pool.run([groq, gemini], env.call)).rejects.toThrow();
    await expect(env.pool.run([groq, gemini], env.call)).rejects.toThrow(/No provider can answer right now: Groq · qwen used up its daily quota; Gemini · flash-lite used up its daily quota/);
  });

  it('labels a model as provider · model', () => {
    expect(modelLabel(gemini)).toBe('Gemini · flash-lite');
  });
});

describe('callLLM errors, for the fallback', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (...responses: Response[]) => {
    const fetchMock = vi.fn();
    for (const r of responses) fetchMock.mockResolvedValueOnce(r);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('fails fast on a rate limit, passing on retry-after', async () => {
    const fetchMock = respond(new Response('{"error":{"message":"Rate limit reached for model qwen on tokens per minute"}}', { status: 429, headers: { 'retry-after': '7' } }));
    const error = await callLLM([], { ...groq, failFast: true }).catch((e) => e);
    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({ kind: 'rate-limit', retryAfterMs: 7_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never retries a used-up daily quota', async () => {
    const fetchMock = respond(new Response('{"error":{"message":"Rate limit reached for model qwen on tokens per day (TPD): Limit 200000"}}', { status: 429 }));
    await expect(callLLM([], groq)).rejects.toMatchObject({ kind: 'daily' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies bad keys and server errors', async () => {
    respond(new Response('{"error":{"message":"Invalid API Key"}}', { status: 401 }));
    await expect(callLLM([], groq)).rejects.toMatchObject({ kind: 'auth' });
    respond(new Response('{"error":{"message":"overloaded"}}', { status: 503 }));
    await expect(callLLM([], groq)).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('the provider chain', () => {
  const settings: StoredLLMSettings = {
    provider: 'groq',
    models: { gemini: 'flash-lite', mistral: 'small' },
    keys: { groq: 'k1', gemini: 'k2' },
    fallbacks: ['mistral', 'gemini', 'groq'],
  };

  it('is the main provider, then each backup that has a key and model', () => {
    // mistral has no key, and groq is already the main provider
    expect(resolveChain(settings).map((c) => c.provider)).toEqual(['groq', 'gemini']);
  });

  it('drops unknown providers and the main one from saved backups', () => {
    const read = readSettings({ [SETTINGS_KEY]: { ...settings, fallbacks: ['nope', 'groq', 'gemini'] } });
    expect(read.fallbacks).toEqual(['gemini']);
  });
});
