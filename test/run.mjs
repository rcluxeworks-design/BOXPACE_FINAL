// Local test: runs the real function code against an in-memory fake of Supabase (database + storage).
// Run with:  node test/run.mjs      (needs Node 20+; no accounts, keys or internet required)

import assert from "node:assert/strict";
import http from "node:http";

import { onRequest as enquiries } from "../functions/api/enquiries.js";
import { onRequest as deskSync } from "../functions/api/desk-sync.js";
import { onRequest as properties } from "../functions/api/properties.js";
import { onRequest as bookings } from "../functions/api/booking-manager.js";
import { onRequest as channels } from "../functions/api/channel-manager.js";
import { onRequest as otaCalendar } from "../functions/api/ota-calendar.js";
import { onRequest as calendarRefresh } from "../functions/api/calendar-refresh.js";
import worker, { refreshStalestCalendars } from "../src/worker.js";

// ---------- fake Supabase ----------
const rows = new Map(); // "namespace|key" -> { namespace, record_key, payload }
const uploads = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body ?? {})); };
  if (!req.headers.apikey) return send(401, { message: "no apikey" });

  if (url.pathname.startsWith("/storage/v1/object/property-photos/")) {
    uploads.push({ path: url.pathname, type: req.headers["content-type"], bytes: raw.length });
    return send(200, { Key: "ok" });
  }
  if (url.pathname !== "/rest/v1/boxpace_records") return send(404, {});
  const ns = (url.searchParams.get("namespace") || "").replace(/^eq\./, "");
  const rk = url.searchParams.get("record_key") || "";
  const match = (row) => {
    if (ns && row.namespace !== ns) return false;
    if (rk.startsWith("eq.")) return row.record_key === rk.slice(3);
    if (rk.startsWith("like.")) return row.record_key.startsWith(rk.slice(5).replace(/\*$/, ""));
    if (rk.startsWith("in.(")) { const keys = [...rk.slice(4, -1).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1")); return keys.includes(row.record_key); }
    return true;
  };
  if (req.method === "GET") {
    const select = (url.searchParams.get("select") || "").split(",");
    const out = [...rows.values()].filter(match).sort((a, b) => a.record_key.localeCompare(b.record_key)).slice(0, Number(url.searchParams.get("limit") || 1000))
      .map((r) => Object.fromEntries(select.map((k) => [k, r[k]])));
    return send(200, out);
  }
  if (req.method === "POST") {
    const ignore = String(req.headers.prefer).includes("ignore-duplicates");
    for (const item of JSON.parse(raw.toString())) {
      const id = `${item.namespace}|${item.record_key}`;
      if (ignore && rows.has(id)) continue;
      rows.set(id, JSON.parse(JSON.stringify(item)));
    }
    return send(201, {});
  }
  if (req.method === "DELETE") { for (const [id, row] of [...rows]) if (match(row)) rows.delete(id); return send(204, {}); }
  send(405, {});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const SUPA = `http://127.0.0.1:${server.address().port}`;

// Intercept calendar downloads; everything else (the fake Supabase) goes through the real fetch.
const realFetch = globalThis.fetch;
let airbnbFeed = null; // string = ICS body, null = simulate outage
globalThis.fetch = (input, init) => {
  const u = String(input?.url || input);
  if (u.startsWith("https://www.airbnb.com/")) return airbnbFeed === null ? Promise.reject(new TypeError("fetch failed")) : Promise.resolve(new Response(airbnbFeed, { status: 200 }));
  return realFetch(input, init);
};

const env = { SUPABASE_URL: SUPA, SUPABASE_SECRET_KEY: "sb_secret_test", BOXPACE_DASHBOARD_PASSWORD: "correct horse battery", CRON_SECRET: "cron-secret-value" };
const call = (fn, path, { method = "GET", body, password, ip = "1.1.1.1", headers = {}, e = env } = {}) =>
  fn({ env: e, request: new Request(`https://site.test${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(password ? { authorization: `Bearer ${password}` } : {}), "cf-connecting-ip": ip, ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }) });
const PW = env.BOXPACE_DASHBOARD_PASSWORD;
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log("  ok  ", name); } catch (error) { console.log("  FAIL", name, "\n      ", error.message); process.exitCode = 1; } };

// 1x1 transparent PNG
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const day = (offset) => { const d = new Date(Date.UTC(2027, 0, 10 + offset)); return d.toISOString().slice(0, 10); };

console.log("Boxpace Cloudflare functions - local tests");

await test("missing database settings give a clear 503, not a crash", async () => {
  const res = await call(enquiries, "/api/enquiries", { e: {} });
  assert.equal(res.status, 503);
});

await test("public enquiry is saved and appears for the Desk", async () => {
  const res = await call(enquiries, "/api/enquiries", { method: "POST", body: { name: "Asha", contact: "asha@example.com", enquiry_type: "Guest enquiry", message: "Weekend stay", guests: "8" } });
  assert.equal(res.status, 200);
  const list = await (await call(enquiries, "/api/enquiries", { password: PW })).json();
  assert.equal(list.websiteLeads.length, 1);
  assert.equal(list.websiteLeads[0].type, "Guest enquiry");
});

await test("bad enquiry is rejected and honeypot is silently dropped", async () => {
  assert.equal((await call(enquiries, "/api/enquiries", { method: "POST", body: { name: "x", contact: "nope" } })).status, 400);
  const before = [...rows.keys()].filter((k) => k.includes("enquiry:")).length;
  assert.equal((await call(enquiries, "/api/enquiries", { method: "POST", body: { name: "Bot", contact: "bot@example.com", website: "spam" } })).status, 200);
  assert.equal([...rows.keys()].filter((k) => k.includes("enquiry:")).length, before);
});

await test("public enquiries are limited per IP", async () => {
  let last;
  for (let i = 0; i < 10; i++) last = await call(enquiries, "/api/enquiries", { method: "POST", ip: "9.9.9.9", body: { name: "Spam", contact: "spam@example.com" } });
  assert.equal(last.status, 429);
});

await test("Desk endpoints reject missing and wrong passwords", async () => {
  assert.equal((await call(deskSync, "/api/desk-sync")).status, 401);
  assert.equal((await call(deskSync, "/api/desk-sync", { password: "wrong" })).status, 401);
  assert.equal((await call(deskSync, "/api/desk-sync", { password: PW })).status, 200);
});

await test("lockout: 10 wrong passwords block even the right one, other IPs unaffected, then reset", async () => {
  for (let i = 0; i < 10; i++) await call(deskSync, "/api/desk-sync", { password: `guess${i}`, ip: "6.6.6.6" });
  assert.equal((await call(deskSync, "/api/desk-sync", { password: PW, ip: "6.6.6.6" })).status, 429);
  assert.equal((await call(deskSync, "/api/desk-sync", { password: PW, ip: "7.7.7.7" })).status, 200);
  for (const [k, v] of rows) if (k.includes("ratelimit:auth:6.6.6.6")) v.payload.first -= 16 * 60 * 1000; // pretend 16 minutes passed
  assert.equal((await call(deskSync, "/api/desk-sync", { password: PW, ip: "6.6.6.6" })).status, 200);
});

const villa = {
  id: "villa-1", name: "Test Villa", area: "Karjat", type: "Villa", description: "Nice", bedrooms: 4, bathrooms: 4, guests: 10,
  weekdayRate: 10000, weekendRate: 15000, status: "Published", photos: [PNG],
  owner: "Owner Name +91 99999 99999", terms: "SECRET 15% commission", notes: "SECRET internal note",
  availability: { [day(0)]: "available", [day(1)]: "available", [day(2)]: "available", [day(3)]: "available" },
};
const baseState = { leads: [], operations: [], transactions: [], events: [] };

await test("saving a property moves its photo to storage and returns the public URL", async () => {
  const res = await call(deskSync, "/api/desk-sync", { method: "PUT", password: PW, body: { state: { ...baseState, properties: [structuredClone(villa)] } } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].type, "image/png");
  assert.match(body.properties[0].photos[0], /\/storage\/v1\/object\/public\/property-photos\/villa-1\/[0-9a-f]{32}\.png$/);
  assert.equal(body.photosNotMoved, 0);
  const stored = rows.get("boxpace-hospitality|property:villa-1").payload;
  assert.ok(!stored.photos[0].startsWith("data:"), "database must not hold the base64 image");
});

await test("a failed photo upload keeps the image instead of losing it", async () => {
  const broken = { ...env, SUPABASE_URL: SUPA };
  const orig = globalThis.fetch;
  globalThis.fetch = (i, n) => String(i?.url || i).includes("/storage/") ? Promise.resolve(new Response("nope", { status: 500 })) : orig(i, n);
  const v = structuredClone(villa); v.photos = [PNG.replace("AAAADUlE", "AAAADUlF")];
  const res = await call(deskSync, "/api/desk-sync", { method: "PUT", password: PW, body: { state: { ...baseState, properties: [v] } }, e: broken });
  globalThis.fetch = orig;
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.photosNotMoved, 1);
  assert.ok(body.properties[0].photos[0].startsWith("data:"));
  await call(deskSync, "/api/desk-sync", { method: "PUT", password: PW, body: { state: { ...baseState, properties: [structuredClone(villa)] } } }); // restore
});

await test("public properties endpoint exposes guest fields only", async () => {
  const body = await (await call(properties, "/api/properties")).json();
  assert.equal(body.properties.length, 1);
  const text = JSON.stringify(body);
  for (const secret of ["SECRET", "Owner Name", "owner", "terms", "notes"]) assert.ok(!text.includes(secret), `leaked: ${secret}`);
  assert.equal(body.properties[0].weekdayRate, 10000);
});

await test("draft properties are not public", async () => {
  const draft = { ...structuredClone(villa), id: "draft-1", name: "Draft Villa", status: "Draft" };
  await call(deskSync, "/api/desk-sync", { method: "PUT", password: PW, body: { state: { ...baseState, properties: [structuredClone(villa), draft] } } });
  const names = (await (await call(properties, "/api/properties")).json()).properties.map((p) => p.name);
  assert.deepEqual(names, ["Test Villa"]);
});

let firstBooking;
await test("booking is priced, saved, and closes the dates publicly", async () => {
  const res = await call(bookings, "/api/booking-manager", { method: "POST", password: PW, body: { action: "create", propertyId: "villa-1", guestName: "Ravi", contact: "9800000000", checkIn: day(0), checkOut: day(2), guests: 6, channel: "Direct" } });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.booking.nights, 2);
  assert.equal(body.booking.total, body.booking.tariffs.reduce((s, t) => s + t.rate, 0));
  firstBooking = body.booking;
  const pub = (await (await call(properties, "/api/properties")).json()).properties[0];
  assert.equal(pub.availability[day(0)], "unavailable");
  assert.equal(pub.availability[day(1)], "unavailable");
  assert.equal(pub.availability[day(2)], "available");
  assert.ok(!JSON.stringify(pub).includes("Ravi"), "guest name must not be public");
});

await test("overlapping, oversize and invalid bookings are refused", async () => {
  const make = (extra) => call(bookings, "/api/booking-manager", { method: "POST", password: PW, body: { action: "create", propertyId: "villa-1", guestName: "X", contact: "1", guests: 2, ...extra } });
  assert.equal((await make({ checkIn: day(1), checkOut: day(3) })).status, 409);
  assert.equal((await make({ checkIn: day(5), checkOut: day(6), guests: 50 })).status, 409);
  assert.equal((await make({ checkIn: day(6), checkOut: day(5) })).status, 400);
  assert.equal((await make({ propertyId: "nope", checkIn: day(5), checkOut: day(6) })).status, 404);
});

await test("concurrent bookings for different dates both survive (no lost update)", async () => {
  const make = (a, b, n) => call(bookings, "/api/booking-manager", { method: "POST", password: PW, body: { action: "create", propertyId: "villa-1", guestName: n, contact: "1", checkIn: day(a), checkOut: day(b), guests: 2 } });
  const [r1, r2] = await Promise.all([make(10, 12, "A"), make(20, 22, "B")]);
  assert.equal(r1.status, 201); assert.equal(r2.status, 201);
  const list = (await (await call(bookings, "/api/booking-manager", { password: PW })).json()).bookings;
  assert.equal(list.length, 3);
});

await test("cancelling a booking reopens the dates", async () => {
  const res = await call(bookings, "/api/booking-manager", { method: "POST", password: PW, body: { action: "cancel", id: firstBooking.id } });
  assert.equal((await res.json()).booking.status, "Cancelled");
  const pub = (await (await call(properties, "/api/properties")).json()).properties[0];
  assert.equal(pub.availability[day(0)], "available");
});

let exportToken;
await test("OTA calendars: unsupported links refused, real feed imported and blocks dates", async () => {
  const bad = await call(channels, "/api/channel-manager", { method: "POST", password: PW, body: { action: "configure", propertyId: "villa-1", feeds: [{ label: "Evil", url: "https://169.254.169.254/latest" }] } });
  assert.equal(bad.status, 400);
  airbnbFeed = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${day(3).replaceAll("-", "")}\r\nDTEND;VALUE=DATE:${day(4).replaceAll("-", "")}\r\nSUMMARY:Reserved\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const ok = await call(channels, "/api/channel-manager", { method: "POST", password: PW, body: { action: "configure", propertyId: "villa-1", feeds: [{ label: "Airbnb", url: "https://www.airbnb.com/calendar/ical/123.ics?s=abc" }] } });
  const body = await ok.json();
  assert.equal(ok.status, 200);
  assert.deepEqual(body.calendar.blockedDates, [day(3)]);
  assert.equal(body.calendar.successfulFeeds, 1);
  exportToken = body.calendar.exportToken;
  assert.equal(exportToken.length, 64);
  const pub = (await (await call(properties, "/api/properties")).json()).properties[0];
  assert.equal(pub.availability[day(3)], "unavailable");
  const conflict = await call(bookings, "/api/booking-manager", { method: "POST", password: PW, body: { action: "create", propertyId: "villa-1", guestName: "Z", contact: "1", checkIn: day(3), checkOut: day(4), guests: 2 } });
  assert.equal(conflict.status, 409);
});

await test("OTA outage keeps the last good dates and stops promising 'available'", async () => {
  airbnbFeed = null;
  const res = await call(channels, "/api/channel-manager", { method: "POST", password: PW, body: { action: "sync-one", propertyId: "villa-1" } });
  const body = (await res.json()).calendar;
  assert.equal(body.successfulFeeds, 0);
  assert.deepEqual(body.blockedDates, [day(3)]);
  const pub = (await (await call(properties, "/api/properties")).json()).properties[0];
  assert.equal(pub.availability[day(3)], "unavailable"); // last imported OTA block is kept
  assert.equal(pub.availability[day(1)], "on-request");  // formerly "available" nights now need confirmation
});

await test("Boxpace export calendar needs the right token and lists bookings", async () => {
  assert.equal((await call(otaCalendar, "/api/ota-calendar?property=villa-1&token=wrong")).status, 404);
  assert.equal((await call(otaCalendar, `/api/ota-calendar?property=nope&token=${exportToken}`)).status, 404);
  const res = await call(otaCalendar, `/api/ota-calendar?property=villa-1&token=${exportToken}`);
  const ics = await res.text();
  assert.equal(res.status, 200);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, new RegExp(`DTSTART;VALUE=DATE:${day(10).replaceAll("-", "")}`)); // the "A" booking
  assert.ok(!ics.includes(`DTSTART;VALUE=DATE:${day(0).replaceAll("-", "")}\r\nDTEND;VALUE=DATE:${day(2).replaceAll("-", "")}`), "cancelled booking must not be exported");
  assert.ok(!ics.includes("Ravi") && !ics.includes("9800000000"), "no guest details in the feed");
});

await test("cron endpoint: needs its own secret, lists properties, refreshes one", async () => {
  assert.equal((await call(calendarRefresh, "/api/calendar-refresh")).status, 401);
  assert.equal((await call(calendarRefresh, "/api/calendar-refresh", { password: PW })).status, 401); // Desk password must not work here
  const list = await (await call(calendarRefresh, "/api/calendar-refresh", { password: env.CRON_SECRET })).json();
  assert.deepEqual(list.propertyIds, ["villa-1"]);
  airbnbFeed = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${day(7).replaceAll("-", "")}\r\nDTEND;VALUE=DATE:${day(9).replaceAll("-", "")}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const res = await call(calendarRefresh, "/api/calendar-refresh?property=villa-1", { method: "POST", password: env.CRON_SECRET });
  const body = await res.json();
  assert.deepEqual(body.result.blockedDates.includes(day(7)) && body.result.blockedDates.includes(day(8)), true);
});

await test("removing a property from the Desk keeps a recoverable copy in trash", async () => {
  const res = await call(deskSync, "/api/desk-sync", { method: "PUT", password: PW, body: { state: { ...baseState, properties: [] } } });
  assert.equal(res.status, 200);
  assert.ok(![...rows.keys()].some((k) => k.endsWith("property:villa-1")));
  assert.ok(![...rows.keys()].some((k) => k.endsWith("channel-config:villa-1")));
  const trash = [...rows.entries()].find(([k]) => k.includes("trash:property:villa-1"));
  assert.ok(trash, "trash copy exists");
  assert.equal(trash[1].payload.property.name, "Test Villa");
  assert.equal(trash[1].payload.channelConfig.token, exportToken, "OTA settings are recoverable too");
});

await test("invalid Desk data is rejected", async () => {
  assert.equal((await call(deskSync, "/api/desk-sync", { method: "PUT", password: PW, body: "{not json" })).status, 400);
  assert.equal((await call(deskSync, "/api/desk-sync", { method: "PUT", password: PW, body: { state: { leads: [] } } })).status, 400);
  assert.equal((await call(deskSync, "/api/desk-sync", { method: "PUT", password: PW, body: { state: { ...baseState, properties: [{ id: "../x" }] } } })).status, 400);
});

await test("Worker routes /api/* to handlers, unknown /api/* to 404, everything else to the website files", async () => {
  const assets = { fetch: async (req) => new Response(`asset:${new URL(req.url).pathname}`) };
  const w = (path, init) => worker.fetch(new Request(`https://site.test${path}`, init), { ...env, ASSETS: assets }, {});
  assert.equal((await w("/api/properties")).status, 200);
  assert.equal((await w("/api/properties/")).status, 200);
  assert.equal((await w("/api/unknown")).status, 404);
  assert.equal(await (await w("/properties")).text(), "asset:/properties");
  assert.equal(await (await w("/")).text(), "asset:/");
});

await test("hourly job refreshes the longest-unsynced properties first and survives missing settings", async () => {
  assert.deepEqual(await refreshStalestCalendars({}), []);
  const mk = (id) => ({ id, name: id, status: "Published", availability: {} });
  const st = { ...baseState, properties: ["p-a", "p-b", "p-c"].map(mk) };
  await call(deskSync, "/api/desk-sync", { method: "PUT", password: PW, body: { state: st } });
  airbnbFeed = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
  for (const id of ["p-a", "p-b", "p-c"]) await call(channels, "/api/channel-manager", { method: "POST", password: PW, body: { action: "configure", propertyId: id, feeds: [{ label: "Airbnb", url: `https://www.airbnb.com/calendar/ical/${id}.ics` }] } });
  // make p-b the stalest
  rows.get("boxpace-hospitality|channel-state:p-b").payload.lastSyncAt = "2000-01-01T00:00:00.000Z";
  const before = rows.get("boxpace-hospitality|channel-state:p-b").payload.lastSyncAt;
  const results = await refreshStalestCalendars(env, 1);
  assert.deepEqual(results.map((r) => r.id), ["p-b"]);
  assert.notEqual(rows.get("boxpace-hospitality|channel-state:p-b").payload.lastSyncAt, before);
});

server.close();
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ", 0 failed"}`);
