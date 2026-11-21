// Desk authentication with brute-force lockout, and a simple per-IP limit for public enquiries.
// Counters live in the same Supabase table (keys "ratelimit:*"), so no extra Cloudflare service is needed.

import { bearer, clientIp, reply, safeEqual } from "./http.js";

const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_FAILS = 10;
const ENQUIRY_WINDOW_MS = 60 * 60 * 1000;
const ENQUIRY_MAX = 8;

/** Returns { ok: true } or { ok: false, response }. */
export async function checkDeskAuth(request, env, store) {
  const secret = String(env.BOXPACE_DASHBOARD_PASSWORD || "");
  const denied = () => reply({ error: "Dashboard access is not configured or the password is incorrect." }, 401);
  if (!secret) return { ok: false, response: denied() };

  const now = Date.now();
  const key = `ratelimit:auth:${clientIp(request)}`;
  const record = await store.get(key);
  const active = record && now - record.first < AUTH_WINDOW_MS;
  if (active && record.count >= AUTH_MAX_FAILS) {
    return { ok: false, response: reply({ error: "Too many incorrect attempts. Please wait 15 minutes and try again." }, 429, { "retry-after": "900" }) };
  }

  const supplied = bearer(request);
  if (supplied && safeEqual(secret, supplied)) {
    if (record) await store.delete(key);
    return { ok: true };
  }
  if (supplied) await store.setJSON(key, active ? { first: record.first, count: record.count + 1 } : { first: now, count: 1 });
  return { ok: false, response: denied() };
}

/** Returns true if this IP may submit another public enquiry. */
export async function allowEnquiry(request, store) {
  const now = Date.now();
  const key = `ratelimit:enquiry:${clientIp(request)}`;
  const record = await store.get(key);
  const active = record && now - record.first < ENQUIRY_WINDOW_MS;
  if (active && record.count >= ENQUIRY_MAX) return false;
  await store.setJSON(key, active ? { first: record.first, count: record.count + 1 } : { first: now, count: 1 });
  return true;
}
