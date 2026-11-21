import { createStore, StoreConfigError } from "../../lib/store.js";
import { checkDeskAuth } from "../../lib/guard.js";
import { offloadPhotos } from "../../lib/photos.js";
import { reply } from "../../lib/http.js";

const COLLECTIONS = ["leads", "operations", "transactions", "events", "properties"];

export async function onRequest({ request, env }) {
  let store;
  try { store = createStore(env); }
  catch (error) { return reply({ error: error instanceof StoreConfigError ? "The database is not configured yet." : "Service unavailable." }, 503); }

  try {
    const auth = await checkDeskAuth(request, env, store);
    if (!auth.ok) return auth.response;

    if (request.method === "GET") {
      const [saved, propertyRows] = await Promise.all([store.get("desk-state"), store.listWithValues("property:")]);
      const rows = propertyRows.map((row) => row.value).filter(Boolean);
      return reply({ state: { ...(saved || {}), properties: rows.length ? rows : (Array.isArray(saved?.properties) ? saved.properties : []) } });
    }

    if (request.method === "PUT") {
      const text = await request.text();
      if (text.length > 4_500_000) return reply({ error: "Dashboard data is too large." }, 413);
      let state;
      try { state = JSON.parse(text).state; } catch { return reply({ error: "Invalid data." }, 400); }
      if (!state || typeof state !== "object" || COLLECTIONS.some((key) => !Array.isArray(state[key]))) return reply({ error: "Invalid dashboard data." }, 400);
      const properties = state.properties;
      if (properties.some((item) => !item || typeof item.id !== "string" || !/^[\w-]{1,100}$/.test(item.id))) return reply({ error: "Invalid property record." }, 400);

      // Move new photos into Supabase Storage so property records stay small.
      const photosNotMoved = await offloadPhotos(env, properties);

      const existing = (await store.list({ prefix: "property:" })).blobs.map((blob) => blob.key);
      const keep = new Set(properties.map((item) => `property:${item.id}`));
      const removed = existing.filter((key) => !keep.has(key));

      // Safety net: a property that disappears from the Desk is copied to "trash:" first, together with its
      // OTA calendar settings, so a stale browser tab can never destroy it permanently.
      const trash = [];
      for (const key of removed) {
        const id = key.slice("property:".length);
        const [property, config, snapshot] = await Promise.all([store.get(key), store.get(`channel-config:${id}`), store.get(`channel-state:${id}`)]);
        trash.push([`trash:property:${id}:${Date.now()}`, { deletedAt: new Date().toISOString(), property, channelConfig: config, channelState: snapshot }]);
      }

      const summary = Object.fromEntries(COLLECTIONS.filter((key) => key !== "properties").map((key) => [key, state[key]]));
      await store.setMany([...trash, ["desk-state", summary], ...properties.map((item) => [`property:${item.id}`, item])]);
      await store.deleteMany(removed.flatMap((key) => {
        const id = key.slice("property:".length);
        return [key, `channel-config:${id}`, `channel-state:${id}`];
      }));

      return reply({
        ok: true,
        savedAt: new Date().toISOString(),
        properties: properties.map((item) => ({ id: item.id, photos: item.photos || [] })),
        photosNotMoved,
      });
    }
    return reply({ error: "Method not allowed." }, 405);
  } catch {
    return reply({ error: "Something went wrong while saving. Please try again." }, 500);
  }
}
