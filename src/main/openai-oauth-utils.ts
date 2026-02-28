export type ParsedOpenAIOAuthInput = {
  code: string;
  state?: string;
};

export function parseOpenAIOAuthInput(value: string): ParsedOpenAIOAuthInput | null {
  const trimmed = (typeof value === 'string' ? value : String(value ?? '')).trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const code = (url.searchParams.get('code') || '').trim();
      const state = (url.searchParams.get('state') || '').trim() || undefined;
      if (!code || !state) return null;
      return { code, state };
    } catch {
      return null;
    }
  }

  if (trimmed.includes('code=')) {
    const params = new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed);
    const code = (params.get('code') || '').trim();
    const state = (params.get('state') || '').trim() || undefined;
    if (!code || !state) return null;
    return { code, state };
  }

  return null;
}
