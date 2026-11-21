import { createStore, StoreConfigError } from "../../lib/store.js";
import { checkDeskAuth } from "../../lib/guard.js";
import { readJson, reply } from "../../lib/http.js";
import { refreshProperty, safeFeedUrl } from "../../lib/channels.js";

// Cloudflare's free plan allows 50 outbound requests per invocation, so a manual "sync all" handles a few
// properties per click. The hourly cron job (see worker-cron/) refreshes every property separately.
const SYNC_ALL_LIMIT = 4;

export async function onRequest({ request, env }) {
  let store;
  try { store = createStore(env); }
  catch (error) { return reply({ error: error instanceof StoreConfigError ? "The database is not configured yet." : "Service unavailable." }, 503); }

  try {
    const auth = await checkDeskAuth(request, env, store);
    if (!auth.ok) return auth.response;

    if (request.method === "GET") {
      const [propertyRows, configRows, stateRows] = await Promise.all([
        store.listWithValues("property:"), store.listWithValues("channel-config:"), store.listWithValues("channel-state:"),
      ]);
      const configs = new Map(configRows.map((row) => [row.key.slice("channel-config:".length), row.value]));
      const states = new Map(stateRows.map((row) => [row.key.slice("channel-state:".length), row.value]));
      const calendars = propertyRows.map(({ key, value }) => {
        const id = key.slice("property:".length);
        return value ? { propertyId: id, propertyName: value.name, feeds: configs.get(id)?.feeds || [], exportToken: configs.get(id)?.token || "", sync: states.get(id) || null } : null;
      }).filter(Boolean);
      return reply({ calendars });
    }
    if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);

    const data = await readJson(request);
    if (!data) return reply({ error: "Invalid request." }, 400);
    try {
      if (data.action === "sync-one") return reply({ calendar: await refreshProperty(store, String(data.propertyId || "")) });
      if (data.action === "configure") {
        const feeds = Array.isArray(data.feeds) ? data.feeds.filter((feed) => feed?.url?.trim()).map((feed) => ({ label: feed.label, url: feed.url.trim() })) : [];
        if (feeds.length > 5) return reply({ error: "You can connect up to five OTA calendars per property." }, 400);
        if (feeds.some((feed) => !safeFeedUrl(feed.url))) return reply({ error: "Each calendar link must be a public HTTPS iCalendar URL." }, 400);
        return reply({ calendar: await refreshProperty(store, String(data.propertyId || ""), feeds) });
      }
      if (data.action === "sync-all") {
        const { blobs } = await store.list({ prefix: "channel-config:" });
        const ids = blobs.map(({ key }) => key.slice("channel-config:".length));
        const results = [];
        for (const id of ids.slice(0, SYNC_ALL_LIMIT)) {
          try { results.push(await refreshProperty(store, id)); }
          catch (error) { results.push({ propertyId: id, error: error.message }); }
        }
        return reply({ calendars: results, remaining: Math.max(0, ids.length - SYNC_ALL_LIMIT) });
      }
      return reply({ error: "Unknown calendar action." }, 400);
    } catch (error) {
      return reply({ error: error.message || "Calendar sync failed." }, 400);
    }
  } catch {
    return reply({ error: "Something went wrong. Please try again." }, 500);
  }
}
