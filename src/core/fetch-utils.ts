/**
 * fetchWithByteCap — fetch a URL and stream the body, aborting if it
 * exceeds `maxBytes`. Returns `{ text, truncated }` where `truncated`
 * is true when the cap was hit before the stream completed.
 *
 * Rationale: `response.text()` / `response.arrayBuffer()` read the full
 * body into memory first, which is unsafe for attacker-controlled URLs.
 * Streaming via `response.body.getReader()` lets us bail out early.
 *
 * Bytes are decoded as UTF-8 at the end via TextDecoder. The cap is
 * measured against accumulated bytes, not UTF-16 code units, so it is
 * a real memory guard.
 */

export interface FetchCapResult {
  text: string;
  truncated: boolean;
  status: number;
  finalUrl: string;
  /** Location header for 3xx responses. Callers using `redirect: "manual"`
   *  must read this and re-validate before following the redirect. */
  location: string | null;
}

export async function fetchWithByteCap(
  url: string,
  init: RequestInit,
  maxBytes: number
): Promise<FetchCapResult> {
  const res = await fetch(url, init);

  const location = res.headers.get("location");

  // Short-circuit for 3xx redirects under `redirect: "manual"`. The body
  // is uninteresting; just hand the Location header back to the caller.
  if (init.redirect === "manual" && res.status >= 300 && res.status < 400) {
    return {
      text: "",
      truncated: false,
      status: res.status,
      finalUrl: res.url || url,
      location,
    };
  }

  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming body (some runtimes) — fall back to text() with a soft check.
    const text = await res.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    return {
      text,
      truncated: bytes > maxBytes,
      status: res.status,
      finalUrl: res.url || url,
      location,
    };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      truncated = true;
      // Keep the bytes we have so the partial text is still usable.
      const remaining = maxBytes - (total - value.byteLength);
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    chunks.push(value);
  }

  // Concatenate into a single buffer for decoding.
  const buf = new Uint8Array(truncated ? maxBytes : total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8").decode(buf.subarray(0, offset));

  return {
    text,
    truncated,
    status: res.status,
    finalUrl: res.url || url,
    location,
  };
}
