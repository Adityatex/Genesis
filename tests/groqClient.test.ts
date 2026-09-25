import { describe, it, expect } from 'vitest';
import { recoverFailedGeneration } from '@/lib/api/groqClient';

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
