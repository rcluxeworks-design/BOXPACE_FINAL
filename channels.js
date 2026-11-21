// OTA iCalendar (ICS) import. Ported from the Netlify channel-manager; behaviour is unchanged:
// it reads each OTA's exported calendar, merges the blocked dates, and keeps the last good dates when a feed fails.

import { randomHex, sha256Hex } from "./http.js";

export function safeFeedUrl(value) {
  try {
    const normalized = String(value || "").trim().replace(/^webcal:\/\//i, "https://").replace(/^http:\/\//i, "https://");
    const url = new URL(normalized);
    const supported = ["airbnb.com", "booking.com", "vrbo.com", "expedia.com", "agoda.com", "makemytrip.com", "goibibo.com", "tripadvisor.com"];
    if (url.protocol !== "https:" || url.username || url.password || url.hostname === "localhost" ||
        url.hostname.endsWith(".local") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.includes(":") ||
        !supported.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
    return url.toString();
  } catch { return null; }
}

export function parseCalendar(text) {
  if (text.length > 1_000_000 || !text.includes("BEGIN:VCALENDAR")) throw new Error("This URL did not return a supported iCalendar feed.");
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { current = {}; continue; }
    if (line === "END:VEVENT" && current) {
      const start = current.dtstart?.match(/^(\d{4})(\d{2})(\d{2})/);
      const end = current.dtend?.match(/^(\d{4})(\d{2})(\d{2})/);
      if (start && end && current.status !== "CANCELLED") {
        const from = `${start[1]}-${start[2]}-${start[3]}`;
        const to = `${end[1]}-${end[2]}-${end[3]}`;
        if (to > from) events.push({ from, to });
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const match = line.match(/^(DTSTART|DTEND|STATUS)(?:;[^:]*)?:(.*)$/i);
    if (match) current[match[1].toLowerCase()] = match[2].trim().toUpperCase();
  }
  return events;
}

export function datesFromEvents(events) {
  const dates = new Set();
  for (const { from, to } of events) {
    const cursor = new Date(`${from}T00:00:00Z`);
    const finish = new Date(`${to}T00:00:00Z`);
    for (let guard = 0; cursor < finish && guard < 740; guard++) {
      dates.add(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return [...dates].sort();
}

async function fetchCalendar(url) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(current, {
      signal: AbortSignal.timeout(7000),
      redirect: "manual",
      headers: { accept: "text/calendar,text/plain;q=0.9,*/*;q=0.1", "user-agent": "BoxpaceCalendarSync/1.0" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("The OTA calendar redirected without a destination.");
      current = safeFeedUrl(new URL(location, current).toString());
      if (!current) throw new Error("The OTA calendar redirected to an unsupported address. Re-export its HTTPS iCal link.");
      continue;
    }
    return response;
  }
  throw new Error("The OTA calendar redirected too many times. Re-export its HTTPS iCal link.");
}

const labelOf = (feed, index) => String(feed?.label || `Calendar ${index + 1}`).slice(0, 60);

export async function refreshProperty(store, propertyId, suppliedFeeds) {
  if (!/^[\w-]{1,100}$/.test(propertyId)) throw new Error("Invalid property.");
  const [property, existingConfig, previous] = await Promise.all([
    store.get(`property:${propertyId}`),
    store.get(`channel-config:${propertyId}`),
    store.get(`channel-state:${propertyId}`),
  ]);
  if (!property) throw new Error("Save this property in the Desk before connecting its calendars.");
  const feeds = suppliedFeeds || existingConfig?.feeds || [];
  if (!Array.isArray(feeds) || feeds.length > 5) throw new Error("Add up to five OTA calendar links.");
  const previousFeeds = previous?.feedDates || {};

  const results = await Promise.all(feeds.map(async (feed, index) => {
    const label = labelOf(feed, index);
    const url = safeFeedUrl(feed.url);
    if (!url) return { label, ok: false, error: "Use a public HTTPS iCalendar link.", key: await sha256Hex(String(feed.url || index)), dates: [] };
    const key = await sha256Hex(url);
    try {
      const response = await fetchCalendar(url);
      if (!response.ok) throw new Error(`Calendar returned HTTP ${response.status}.`);
      const events = parseCalendar(await response.text());
      return { key, label, ok: true, events, dates: datesFromEvents(events) };
    } catch (error) {
      const message = error.name === "TimeoutError"
        ? "Calendar request timed out. The last imported dates have been kept."
        : error instanceof TypeError
          ? "Could not reach this OTA calendar. Check that the exported HTTPS iCal link is current; the last imported dates have been kept."
          : `${(error.message || "Could not read calendar.").slice(0, 120)} The last imported dates have been kept.`;
      return { key, label, ok: false, error: message, dates: previousFeeds[key]?.dates || [] };
    }
  }));

  const now = new Date().toISOString();
  const feedDates = Object.fromEntries(results.map((item) => [item.key, {
    label: item.label,
    dates: item.dates,
    lastSuccessAt: item.ok ? now : (previousFeeds[item.key]?.lastSuccessAt || null),
  }]));
  const blockedDates = [...new Set(Object.values(feedDates).flatMap((item) => item.dates))].sort();

  const config = existingConfig || {};
  config.token ||= randomHex(32);
  if (suppliedFeeds) config.feeds = suppliedFeeds.map((feed, index) => ({ label: labelOf(feed, index), url: safeFeedUrl(feed.url) || "" }));
  config.feeds ||= [];
  config.updatedAt = now;

  const snapshot = {
    propertyId,
    blockedDates,
    feedDates,
    feeds: results.map(({ label, ok, error, events, dates }) => ({ label, ok, error, eventCount: events?.length || 0, retainedDates: ok ? 0 : dates?.length || 0 })),
    feedCount: feeds.length,
    successfulFeeds: results.filter((item) => item.ok).length,
    lastSyncAt: now,
  };
  await store.setMany([[`channel-config:${propertyId}`, config], [`channel-state:${propertyId}`, snapshot]]);
  return { ...snapshot, exportToken: config.token };
}
