// One Cloudflare Worker that serves everything:
//   - /api/*        -> the backend handlers in functions/api/
//   - everything else -> the static website in website/ (through the ASSETS binding)
//   - hourly cron   -> refreshes OTA calendars (see wrangler.jsonc "triggers")

import { onRequest as enquiries } from "../functions/api/enquiries.js";
import { onRequest as deskSync } from "../functions/api/desk-sync.js";
import { onRequest as properties } from "../functions/api/properties.js";
import { onRequest as bookingManager } from "../functions/api/booking-manager.js";
import { onRequest as channelManager } from "../functions/api/channel-manager.js";
import { onRequest as otaCalendar } from "../functions/api/ota-calendar.js";
import { onRequest as calendarRefresh } from "../functions/api/calendar-refresh.js";
import { createStore } from "../lib/store.js";
import { refreshProperty } from "../lib/channels.js";
import { reply } from "../lib/http.js";

const routes = {
  "/api/enquiries": enquiries,
  "/api/desk-sync": deskSync,
  "/api/properties": properties,
  "/api/booking-manager": bookingManager,
  "/api/channel-manager": channelManager,
  "/api/ota-calendar": otaCalendar,
  "/api/calendar-refresh": calendarRefresh,
};

// A free Worker may make 50 outbound requests per run, so each hourly run refreshes the properties
// that were synced longest ago (5 at a time). With up to ~10 villas every one is refreshed within 2 hours.
const CRON_BATCH = 5;

export async function refreshStalestCalendars(env, batch = CRON_BATCH) {
  let store;
  try { store = createStore(env); }
  catch { console.log("Calendar refresh skipped: database settings are missing."); return []; }

  const { blobs } = await store.list({ prefix: "channel-config:" });
  const ids = blobs.map(({ key }) => key.slice("channel-config:".length));
  const states = new Map((await store.listWithValues("channel-state:")).map((row) => [row.key.slice("channel-state:".length), row.value]));
  ids.sort((a, b) => String(states.get(a)?.lastSyncAt || "").localeCompare(String(states.get(b)?.lastSyncAt || "")));

  const results = [];
  for (const id of ids.slice(0, batch)) {
    try { await refreshProperty(store, id); results.push({ id, ok: true }); }
    catch (error) { results.push({ id, ok: false, error: String(error.message || error) }); }
  }
  console.log(JSON.stringify({ calendarsRefreshed: results.length, of: ids.length, failed: results.filter((r) => !r.ok) }));
  return results;
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const handler = routes[pathname.replace(/\/+$/, "")];
    if (handler) return handler({ request, env, ctx });
    if (pathname.startsWith("/api/")) return reply({ error: "Not found." }, 404);
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshStalestCalendars(env));
  },
};
