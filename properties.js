// Public endpoint: returns only published properties and only guest-safe fields.
// Owner contacts, commercial terms, internal notes and private booking data are never included.

import { createStore } from "../../lib/store.js";
import { reply } from "../../lib/http.js";

const publicFields = [
  "id", "name", "area", "type", "description", "highlights", "bedrooms", "beds", "minimumStay",
  "bathrooms", "guests", "checkin", "checkout", "weekdayRate", "weekendRate",
  "seasonalRate", "seasonalFrom", "seasonalTo", "amenities", "rules", "cancellation", "photos", "availability", "updatedAt",
];

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return reply({ error: "Method not allowed." }, 405);
  try {
    const store = createStore(env);
    const [propertyRows, stateRows, bookingRows, desk] = await Promise.all([
      store.listWithValues("property:"),
      store.listWithValues("channel-state:"),
      store.listWithValues("booking:"),
      store.get("desk-state"),
    ]);
    const records = propertyRows.map((row) => row.value).filter(Boolean);
    const properties = records.length ? records : (Array.isArray(desk?.properties) ? desk.properties : []);
    const snapshots = new Map(stateRows.map((row) => [row.key.slice("channel-state:".length), row.value]));
    const bookings = bookingRows.map((row) => row.value).filter((b) => b && b.status !== "Cancelled");

    const published = properties.filter((property) => property?.status === "Published").map((property) => {
      const snapshot = snapshots.get(property.id);
      const merged = { ...property, availability: { ...(property.availability || {}) } };
      // If any OTA calendar failed to refresh, do not promise "available" nights.
      if (snapshot?.feedCount && snapshot.successfulFeeds < snapshot.feedCount) {
        for (const [day, status] of Object.entries(merged.availability)) if (status === "available") merged.availability[day] = "on-request";
      }
      for (const day of snapshot?.blockedDates || []) merged.availability[day] = "unavailable";
      for (const booking of bookings) {
        if (booking.propertyId !== property.id) continue;
        const day = new Date(`${booking.checkIn}T00:00:00Z`), end = new Date(`${booking.checkOut}T00:00:00Z`);
        for (let guard = 0; day < end && guard < 367; guard++) { merged.availability[day.toISOString().slice(0, 10)] = "unavailable"; day.setUTCDate(day.getUTCDate() + 1); }
      }
      return Object.fromEntries(publicFields.filter((key) => merged[key] !== undefined).map((key) => [key, merged[key]]));
    });
    return reply({ properties: published });
  } catch {
    return reply({ error: "Property listings are temporarily unavailable." }, 503);
  }
}
