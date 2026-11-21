// Boxpace hourly calendar refresh. One self-contained file: paste it into a Cloudflare Worker, or deploy with wrangler.
// Variables needed on this Worker:
//   SITE_URL     e.g. https://boxpace-hospitality.pages.dev   (no trailing slash)
//   CRON_SECRET  the same long random value you set on the Pages project (add it as a Secret)

const MAX_PROPERTIES = 40; // a free Worker may make 50 outbound requests per run

async function refreshAll(env) {
  const base = String(env.SITE_URL || "").replace(/\/+$/, "");
  if (!base || !env.CRON_SECRET) throw new Error("SITE_URL and CRON_SECRET must be set on this Worker.");
  const headers = { authorization: `Bearer ${env.CRON_SECRET}` };

  const listing = await fetch(`${base}/api/calendar-refresh`, { headers });
  if (!listing.ok) throw new Error(`Could not list properties (HTTP ${listing.status}).`);
  const { propertyIds = [] } = await listing.json();

  const results = [];
  for (const id of propertyIds.slice(0, MAX_PROPERTIES)) {
    try {
      const response = await fetch(`${base}/api/calendar-refresh?property=${encodeURIComponent(id)}`, { method: "POST", headers });
      const body = await response.json().catch(() => ({}));
      results.push({ id, ok: response.ok && !body.error, error: body.error });
    } catch (error) {
      results.push({ id, ok: false, error: String(error.message || error) });
    }
  }
  console.log(JSON.stringify({ refreshed: results.length, failed: results.filter((r) => !r.ok) }));
  return results;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshAll(env));
  },
  async fetch() {
    return new Response("Boxpace calendar cron is running. It has no public page.", { status: 200 });
  },
};
