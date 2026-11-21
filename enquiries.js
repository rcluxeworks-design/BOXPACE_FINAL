import { createStore, StoreConfigError } from "../../lib/store.js";
import { checkDeskAuth, allowEnquiry } from "../../lib/guard.js";
import { reply } from "../../lib/http.js";

export async function onRequest({ request, env }) {
  let store;
  try { store = createStore(env); }
  catch (error) { return reply({ error: error instanceof StoreConfigError ? "The database is not configured yet." : "Service unavailable." }, 503); }

  try {
    if (request.method === "POST") return await createEnquiry(request, store);

    const auth = await checkDeskAuth(request, env, store);
    if (!auth.ok) return auth.response;

    if (request.method === "GET") {
      const [saved, enquiryRows, propertyRows] = await Promise.all([
        store.get("desk-state"),
        store.listWithValues("enquiry:"),
        store.listWithValues("property:"),
      ]);
      const properties = propertyRows.map((row) => row.value).filter(Boolean);
      return reply({
        state: { ...(saved || {}), properties: properties.length ? properties : (Array.isArray(saved?.properties) ? saved.properties : []) },
        websiteLeads: enquiryRows.map((row) => row.value).filter(Boolean),
      });
    }

    if (request.method === "DELETE") {
      const id = new URL(request.url).searchParams.get("id") || "";
      if (!/^[\w-]{16,80}$/.test(id)) return reply({ error: "Invalid enquiry id." }, 400);
      await store.delete(`enquiry:${id}`);
      return reply({ ok: true });
    }
    return reply({ error: "Method not allowed." }, 405);
  } catch {
    return reply({ error: "Something went wrong. Please try again." }, 500);
  }
}

async function createEnquiry(request, store) {
  let body;
  try {
    const isJson = (request.headers.get("content-type") || "").includes("application/json");
    body = isJson ? await request.json() : Object.fromEntries(await request.formData());
    body.__json = isJson;
  } catch {
    return reply({ error: "We could not read your enquiry. Please try again." }, 400);
  }
  if (body.website) return reply({ ok: true }); // honeypot field: bots fill it, people don't

  const text = (value, max) => String(value || "").trim().slice(0, max);
  const name = text(body.name, 120);
  const contact = text(body.contact, 160);
  const type = text(body.enquiry_type || "Something else", 80);
  const area = text(body.area, 80);
  const message = text(body.message, 2000);
  const property = text(body.property, 180);
  const dates = text(body.dates, 100);
  const guests = text(body.guests, 40);
  const bedrooms = text(body.bedrooms, 40);
  const serviceInterest = text(body.service_interest, 120);
  const channels = text(body.channels, 160);
  if (!name || !contact || !/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|[+()\d][+()\d\s.-]{6,}/.test(contact)) {
    return reply({ error: "Please enter your name and a valid email address or phone number." }, 400);
  }
  if (!(await allowEnquiry(request, store))) {
    return reply({ error: "Too many enquiries from this connection. Please call or email us instead." }, 429);
  }

  const id = crypto.randomUUID();
  const lead = {
    id, name, contact,
    type: type === "Villa owner partnership" ? "Villa owner" : "Guest enquiry",
    requirement: [property && `Property: ${property}`, area, bedrooms && `Type: ${bedrooms}`, dates && `Dates: ${dates}`, guests && `Guests: ${guests}`,
      serviceInterest && `Service interest: ${serviceInterest}`, channels && `Channels: ${channels}`, message].filter(Boolean).join(" · "),
    stage: "New", follow: "", value: 0, next: "Reply to website enquiry",
    source: "Website enquiry", createdAt: new Date().toISOString(),
  };
  await store.setJSON(`enquiry:${id}`, lead, { onlyIfNew: true });
  if (!body.__json) return new Response(null, { status: 303, headers: { location: "/enquiry-received.html", "cache-control": "no-store" } });
  return reply({ ok: true, id });
}
