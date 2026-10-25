export type Transport = (req: {
  method: 'GET' | 'POST';
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal: AbortSignal;
}) => Promise<{ status: number; body: unknown }>;

/** Transport over global fetch. `url` is a path appended to baseUrl. Non-JSON bodies come back as text. */
export function fetchTransport(baseUrl: string): Transport {
  const base = baseUrl.replace(/\/+$/, '');
  return async ({ method, url, body, headers, signal }) => {
    const res = await fetch(base + url, {
      method,
      signal,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = text;
    if (text.length === 0) parsed = undefined;
    else {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
    }
    return { status: res.status, body: parsed };
  };
}
