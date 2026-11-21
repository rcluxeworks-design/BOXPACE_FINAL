// Private booking register. Each booking is its own record ("booking:<id>"), so two people saving
// at the same moment can no longer overwrite each other's bookings.

import { createStore, StoreConfigError } from "../../lib/store.js";
import { checkDeskAuth } from "../../lib/guard.js";
import { readJson, reply } from "../../lib/http.js";

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(+date) && date.toISOString().slice(0, 10) === value;
}
function datesBetween(from, to) {
  const result = [];
  const day = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
  for (let guard = 0; day < end && guard < 367; guard++) { result.push(day.toISOString().slice(0, 10)); day.setUTCDate(day.getUTCDate() + 1); }
  return result;
}
function price(property, date) {
  if (property.rateByDate?.[date]) return Number(property.rateByDate[date]) || 0;
  if (property.seasonalRate && property.seasonalFrom && property.seasonalTo && date >= property.seasonalFrom && date <= property.seasonalTo) return Number(property.seasonalRate) || 0;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return [5, 6].includes(weekday) ? (Number(property.weekendRate) || Number(property.weekdayRate) || 0) : (Number(property.weekdayRate) || 0);
}
const CHANNELS = ["Direct", "Airbnb", "Booking.com", "MakeMyTrip", "Goibibo", "Other OTA", "Offline"];

export async function onRequest({ request, env }) {
  let store;
  try { store = createStore(env); }
  catch (error) { return reply({ error: error instanceof StoreConfigError ? "The database is not configured yet." : "Service unavailable." }, 503); }

  try {
    const auth = await checkDeskAuth(request, env, store);
    if (!auth.ok) return auth.response;

    if (request.method === "GET") {
      const [bookingRows, propertyRows, stateRows] = await Promise.all([
        store.listWithValues("booking:"), store.listWithValues("property:"), store.listWithValues("channel-state:"),
      ]);
      const states = new Map(stateRows.map((row) => [row.key.slice("channel-state:".length), row.value]));
      const otaBlocks = propertyRows.map(({ key, value }) => {
        const id = key.slice("property:".length);
        const snapshot = states.get(id);
        return value && snapshot?.blockedDates?.length ? { propertyId: id, propertyName: value.name, dates: snapshot.blockedDates } : null;
      }).filter(Boolean);
      const bookings = bookingRows.map((row) => row.value).filter(Boolean).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      return reply({ bookings, otaBlocks });
    }
    if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);

    const data = await readJson(request);
    if (!data) return reply({ error: "Invalid request." }, 400);

    if (data.action === "cancel") {
      if (typeof data.id !== "string" || !/^[\w-]{8,80}$/.test(data.id)) return reply({ error: "Booking not found." }, 404);
      const booking = await store.get(`booking:${data.id}`);
      if (!booking) return reply({ error: "Booking not found." }, 404);
      booking.status = "Cancelled";
      booking.updatedAt = new Date().toISOString();
      await store.setJSON(`booking:${booking.id}`, booking);
      return reply({ booking });
    }
    if (data.action !== "create") return reply({ error: "Unknown booking action." }, 400);

    const { propertyId, guestName, contact, checkIn, checkOut } = data;
    if (typeof guestName !== "string" || !guestName.trim() || guestName.length > 120) return reply({ error: "Enter the guest name." }, 400);
    if (!validDate(checkIn) || !validDate(checkOut) || checkOut <= checkIn) return reply({ error: "Choose a valid check-in and later check-out date." }, 400);
    const nights = datesBetween(checkIn, checkOut);
    if (nights.length > 90) return reply({ error: "A booking cannot exceed 90 nights." }, 400);
    if (typeof contact !== "string" || contact.length > 160) return reply({ error: "Enter a guest phone or email." }, 400);
    if (typeof propertyId !== "string" || !/^[\w-]{1,100}$/.test(propertyId)) return reply({ error: "Choose an active property." }, 404);

    const [property, otaState, bookingRows] = await Promise.all([
      store.get(`property:${propertyId}`), store.get(`channel-state:${propertyId}`), store.listWithValues("booking:"),
    ]);
    if (!property || property.status === "Archived") return reply({ error: "Choose an active property." }, 404);
    const guests = Math.max(1, Number(data.guests) || 1);
    if (property.guests && guests > Number(property.guests)) return reply({ error: `This property accommodates up to ${property.guests} guests.` }, 409);

    const overlap = bookingRows.map((row) => row.value).find((row) => row && row.propertyId === propertyId && row.status !== "Cancelled" && row.checkIn < checkOut && checkIn < row.checkOut);
    if (overlap) return reply({ error: `These dates overlap an active booking (${overlap.checkIn} to ${overlap.checkOut}).` }, 409);
    const blocked = new Set(otaState?.blockedDates || []);
    const conflictingDate = nights.find((day) => blocked.has(day));
    if (conflictingDate) return reply({ error: `The property is blocked by an imported OTA calendar on ${conflictingDate}. Refresh and check the source calendar.` }, 409);

    const tariffs = nights.map((date) => ({ date, rate: price(property, date) }));
    const total = tariffs.reduce((sum, item) => sum + item.rate, 0);
    if (!total) return reply({ error: "Add nightly rates in the Tariff Desk before recording a booking." }, 409);

    const now = new Date().toISOString();
    const booking = {
      id: crypto.randomUUID(), propertyId, propertyName: property.name,
      guestName: guestName.trim(), contact: contact.trim(), guests,
      checkIn, checkOut, nights: nights.length,
      channel: CHANNELS.includes(data.channel) ? data.channel : "Direct",
      status: data.status === "Pending" ? "Pending" : "Confirmed",
      tariffs, total, notes: typeof data.notes === "string" ? data.notes.slice(0, 1200) : "",
      createdAt: now, updatedAt: now,
    };
    await store.setJSON(`booking:${booking.id}`, booking, { onlyIfNew: true });
    return reply({ booking }, 201);
  } catch {
    return reply({ error: "Something went wrong. Please try again." }, 500);
  }
}
