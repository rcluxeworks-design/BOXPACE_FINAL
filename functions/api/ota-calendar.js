// Tokenised iCalendar feed that OTAs import so Boxpace-booked dates close on their side.

import { createStore } from "../../lib/store.js";
import { safeEqual } from "../../lib/http.js";

const icsDate = (value) => value.replaceAll("-", "");

export async function onRequest({ request, env }) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const url = new URL(request.url);
  const propertyId = url.searchParams.get("property") || "";
  const token = url.searchParams.get("token") || "";
  if (!/^[\w-]{1,100}$/.test(propertyId) || !token) return new Response("Not found", { status: 404 });

  let store;
  try { store = createStore(env); } catch { return new Response("Unavailable", { status: 503 }); }
  try {
    const [config, property, snapshot, bookingRows] = await Promise.all([
      store.get(`channel-config:${propertyId}`),
      store.get(`property:${propertyId}`),
      store.get(`channel-state:${propertyId}`),
      store.listWithValues("booking:"),
    ]);
    if (!property || !config?.token || !safeEqual(token, config.token)) return new Response("Not found", { status: 404 });

    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Boxpace Hospitality//Availability Calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      `X-WR-CALNAME:${String(property.name || "Boxpace property").replace(/[\r\n,;]/g, " ")} availability`];
    for (const day of snapshot?.blockedDates || []) {
      const next = new Date(`${day}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      lines.push("BEGIN:VEVENT", `UID:${propertyId}-${icsDate(day)}@boxpacehospitality.com`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${icsDate(day)}`,
        `DTEND;VALUE=DATE:${icsDate(next.toISOString().slice(0, 10))}`, "SUMMARY:Unavailable", "TRANSP:OPAQUE", "END:VEVENT");
    }
    for (const { value: booking } of bookingRows) {
      if (!booking || booking.propertyId !== propertyId || booking.status === "Cancelled") continue;
      lines.push("BEGIN:VEVENT", `UID:${propertyId}-${booking.id}@boxpacehospitality.com`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${icsDate(booking.checkIn)}`,
        `DTEND;VALUE=DATE:${icsDate(booking.checkOut)}`, "SUMMARY:Unavailable", "TRANSP:OPAQUE", "END:VEVENT");
    }
    lines.push("END:VCALENDAR", "");
    return new Response(lines.join("\r\n"), {
      headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store", "content-disposition": "inline; filename=boxpace-availability.ics" },
    });
  } catch {
    return new Response("Unavailable", { status: 503 });
  }
}
