// Small shared helpers. Uses only Web APIs (no Node built-ins), so it runs on Cloudflare Workers as-is.

export const reply = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });

export const clientIp = (request) => request.headers.get("cf-connecting-ip") || "unknown";

export async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

/** Constant-time string comparison. Returns false for an empty value. */
export function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a ?? ""));
  const y = enc.encode(String(b ?? ""));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0 && x.length > 0;
}

export const bearer = (request) => (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
export const randomHex = (byteCount) => toHex(crypto.getRandomValues(new Uint8Array(byteCount)));
export async function sha256Hex(text) {
  const data = typeof text === "string" ? new TextEncoder().encode(text) : text;
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}
