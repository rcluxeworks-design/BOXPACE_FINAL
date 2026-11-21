// Called hourly by the cron Worker (worker-cron/). Protected by CRON_SECRET, not the Desk password.
//   GET  /api/calendar-refresh               -> { propertyIds: [...] }
//   POST /api/calendar-refresh?property=<id> -> refreshes one property's OTA calendars
// Splitting the work per property keeps each call under Cloudflare's free-plan limit of 50 outbound requests.
// The hourly database read also keeps a free Supabase project from being paused for inactivity.

import { createStore } from "../../lib/store.js";
import { bearer, reply, safeEqual } from "../../lib/http.js";
import { refreshProperty } from "../../lib/channels.js";

export async function onRequest({ request, env }) {
  if (!safeEqual(env.CRON_SECRET || "", bearer(request))) return reply({ error: "Not authorised." }, 401);
  let store;
  try { store = createStore(env); } catch { return reply({ error: "The database is not configured yet." }, 503); }

  const id = new URL(request.url).searchParams.get("property");
  try {
    if (request.method === "GET" && !id) {
      const { blobs } = await store.list({ prefix: "channel-config:" });
      return reply({ propertyIds: blobs.map(({ key }) => key.slice("channel-config:".length)) });
    }
    if (request.method === "POST" && id) {
      try { return reply({ propertyId: id, result: await refreshProperty(store, id) }); }
      catch (error) { return reply({ propertyId: id, error: error.message || "Calendar refresh failed." }); }
    }
    return reply({ error: "Method not allowed." }, 405);
  } catch {
    return reply({ error: "Something went wrong." }, 500);
  }
}
