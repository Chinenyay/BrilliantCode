import { describe, expect, it } from 'vitest';
import { parseOpenAIOAuthInput } from './openai-oauth-utils.js';

describe('parseOpenAIOAuthInput', () => {
  it('parses full redirect URL with code and state', () => {
    const parsed = parseOpenAIOAuthInput('http://127.0.0.1:1455/auth/callback?code=abc123&state=st_xyz');
    expect(parsed).toEqual({ code: 'abc123', state: 'st_xyz' });
  });

  it('parses query-string payload with code and state', () => {
    const parsed = parseOpenAIOAuthInput('?code=abc123&state=st_xyz');
    expect(parsed).toEqual({ code: 'abc123', state: 'st_xyz' });
  });

  it('returns null when state is missing', () => {
    expect(parseOpenAIOAuthInput('http://127.0.0.1:1455/auth/callback?code=abc123')).toBeNull();
    expect(parseOpenAIOAuthInput('?code=abc123')).toBeNull();
  });

  it('returns null for plain code input', () => {
    expect(parseOpenAIOAuthInput('abc123')).toBeNull();
  });

  it('returns null for invalid URL input', () => {
    expect(parseOpenAIOAuthInput('http://%%%%')).toBeNull();
  });
});
