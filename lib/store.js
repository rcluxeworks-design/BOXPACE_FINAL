// Supabase REST storage for Boxpace records (table: public.boxpace_records).
// Same interface the Netlify version exposed, plus batch helpers that keep the number of
// outbound requests low (Cloudflare's free plan allows 50 subrequests per invocation).

const TABLE = "boxpace_records";
const NAMESPACE = "boxpace-hospitality";

export class StoreConfigError extends Error {}

export function supabaseConfig(env) {
  const url = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const key = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) throw new StoreConfigError("Storage is not configured.");
  return { url, key };
}

export function authHeaders(key, extra = {}) {
  // New-style sb_secret_ keys are sent in the apikey header only; legacy JWT keys also need Authorization.
  return { apikey: key, ...(key.startsWith("sb_secret_") ? {} : { authorization: `Bearer ${key}` }), ...extra };
}

export function createStore(env, namespace = NAMESPACE) {
  const { url, key } = supabaseConfig(env);

  async function rest(path, options = {}) {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      ...options,
      headers: authHeaders(key, { accept: "application/json", "content-type": "application/json", ...options.headers }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Supabase request failed (${response.status}): ${detail}`);
    }
    return response;
  }

  const base = () => ({ namespace: `eq.${namespace}` });
  const quoteIn = (k) => `"${String(k).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

  async function get(recordKey) {
    const q = new URLSearchParams({ select: "payload", ...base(), record_key: `eq.${recordKey}`, limit: "1" });
    const rows = await (await rest(`${TABLE}?${q}`)).json();
    return rows.length ? rows[0].payload : null;
  }

  async function list({ prefix = "" } = {}) {
    const q = new URLSearchParams({ select: "record_key", ...base(), order: "record_key.asc", limit: "1000" });
    if (prefix) q.set("record_key", `like.${prefix}*`);
    const rows = await (await rest(`${TABLE}?${q}`)).json();
    return { blobs: rows.map((r) => ({ key: r.record_key })) };
  }

  /** One request that returns every record whose key starts with `prefix`: [{ key, value }]. */
  async function listWithValues(prefix) {
    const q = new URLSearchParams({ select: "record_key,payload", ...base(), order: "record_key.asc", limit: "1000" });
    q.set("record_key", `like.${prefix}*`);
    const rows = await (await rest(`${TABLE}?${q}`)).json();
    return rows.map((r) => ({ key: r.record_key, value: r.payload }));
  }

  /** Upsert many records in one request. entries: [[key, value], ...] */
  async function setMany(entries, { onlyIfNew = false } = {}) {
    if (!entries.length) return;
    const q = new URLSearchParams({ on_conflict: "namespace,record_key" });
    const now = new Date().toISOString();
    await rest(`${TABLE}?${q}`, {
      method: "POST",
      headers: { prefer: `resolution=${onlyIfNew ? "ignore" : "merge"}-duplicates,return=minimal` },
      body: JSON.stringify(entries.map(([k, v]) => ({ namespace, record_key: String(k), payload: v, updated_at: now }))),
    });
  }

  const setJSON = (recordKey, value, options = {}) => setMany([[recordKey, value]], options);

  async function deleteMany(keys) {
    if (!keys.length) return;
    const q = new URLSearchParams({ ...base(), record_key: `in.(${keys.map(quoteIn).join(",")})` });
    await rest(`${TABLE}?${q}`, { method: "DELETE", headers: { prefer: "return=minimal" } });
  }

  return { get, list, listWithValues, setMany, setJSON, deleteMany, delete: (k) => deleteMany([k]) };
}
