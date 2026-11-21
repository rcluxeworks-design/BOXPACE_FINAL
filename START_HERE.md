# Boxpace on Cloudflare + Supabase — setup guide (single Worker)

One Cloudflare Worker, named **boxpace-final**, now does everything:

- serves the **website** (`website/`),
- runs the **backend** (`/api/*`, code in `functions/api/`),
- runs the **hourly OTA calendar refresh** (cron trigger).

Data and villa photos live in your **Supabase** project. Every push to the `main` branch of your GitHub repo redeploys the Worker automatically.

Never paste a password or key into chat, into a file in this folder, or into GitHub. Enter them only in the Cloudflare/Supabase pages named below.

---

## 1. Supabase (once)

Supabase → **SQL Editor** → paste all of `supabase/schema.sql` → **Run**. Check that **Table Editor** shows `boxpace_records` and **Storage** shows `property-photos`.

## 2. Put these files in GitHub

Upload the contents of this folder to your repository (GitHub → **Add file → Upload files**, drag everything in, **Commit changes** to `main`). `website/`, `functions/`, `src/`, `lib/` and `wrangler.jsonc` must be at the top level of the repository. If an old `worker-cron` folder is in the repository, delete it (open it on GitHub → **⋯ → Delete directory**).

## 3. Check the Worker's Git settings (once)

Cloudflare → **Workers & Pages** → **boxpace-final** → **Settings → Build**:

- Git repository: your Boxpace repo, branch `main`
- Build command: **leave empty**
- Deploy command: `npx wrangler deploy`
- Root directory: `/`

Then **Deployments** should show a new build starting after your upload. Wait for **Ready**.

## 4. Add the three secrets

**boxpace-final → Settings → Variables and Secrets → Add**. Add each one as type **Secret**:

| Name | What to enter |
|---|---|
| `SUPABASE_URL` | Your project address, like `https://abcd1234.supabase.co` (Supabase → Connect button) |
| `SUPABASE_SECRET_KEY` | The key starting `sb_secret_` (Supabase → Project Settings → **API Keys** → Secret key). Not the "publishable" key |
| `BOXPACE_DASHBOARD_PASSWORD` | A **new** strong password (14+ characters) for the Team Desk |

Save/Deploy. You can delete the old `SITE_URL` and `CRON_SECRET` variables from the earlier calendar-job setup; they are no longer used.

## 5. Check it works (10 minutes)

Use your `https://boxpace-final.….workers.dev` address.

1. The home page shows the Boxpace website. **Properties** says new stays are being prepared (not "temporarily unavailable").
2. Send a test enquiry from **Contact**. In Supabase → Table Editor → `boxpace_records`, a row whose key starts `enquiry:` appears.
3. Open `/desk`, enter the dashboard password. The test enquiry shows under leads. Delete it there.
4. In the Desk add a **test** property with one photo and publish it. It should appear on the public Properties page, with the photo link pointing at `…supabase.co/storage/v1/object/public/property-photos/…`. Delete the test property afterwards.
5. Type a wrong Desk password 10 times: it should then say to wait 15 minutes.
6. **Worker → Settings → Triggers** shows the cron `0 * * * *`. After the next hour, **Observability → Logs** shows a line starting `{"calendarsRefreshed"`.

## 6. Switch boxpace.in to the Worker (the live cutover)

Do this only after step 5 passes. Until then boxpace.in keeps loading from Netlify.

1. In Cloudflare open **boxpace-final → Settings → Domains & Routes → Add → Custom domain**, enter `boxpace.in`, and confirm. Repeat for `www.boxpace.in`.
2. If Cloudflare says a DNS record already exists, open **DNS → Records** for boxpace.in, delete the `A` record for `boxpace.in` (75.2.60.5) and the `www` CNAME, then add the custom domain again. The site may be unreachable for a minute or two.
3. Wait a few minutes for the SSL certificate, then open https://boxpace.in and https://boxpace.in/desk.

The old Netlify site can stay until you are happy; it just won't receive traffic any more.

If you used the old Desk with real data, export a backup from the **old** Desk first and import it into the new one.

---

## What changed from the Netlify version

- Backend rewritten for Cloudflare; it talks only to Supabase (the Netlify Blobs fallback was removed).
- **Bookings are one record each**, so two people saving at once can't overwrite each other.
- **Deleting a property is recoverable**: a copy (with its OTA calendar settings) goes to `trash:property:…` first.
- **Photos move to Supabase Storage** instead of sitting inside database rows; `desk.html` got a small change to adopt the new photo links.
- **Login lockout** after 10 wrong passwords per connection for 15 minutes; public enquiries limited to 8 per hour per connection.
- **Bug fix:** the old OTA importer read event dates under the wrong name, so it never blocked any dates. Fixed and tested.
- The hourly refresh handles the 5 longest-unsynced properties each hour (Cloudflare's free plan allows 50 outbound requests per run).

## Tests

`npm install` then `node test/run.mjs` runs 22 checks against a built-in fake Supabase. All pass. The Worker was also started in Cloudflare's local runtime to confirm pages, `/api/*` routes, headers and the cron job work.

## Honest limits

- **Not yet tried against your real Supabase and Cloudflare accounts.** The step-5 checks confirm it.
- Uploading photos with the new `sb_secret_` key is the part I'm least sure of. If a photo fails to upload, the Desk keeps it inline (nothing is lost) and the save reports `photosNotMoved`.
- Cloudflare's free plan limits each request to about 10 ms of computing time. Saving several large photos at once might hit it ("Error 1102"); Workers Paid ($5/month) removes the limit.
- One shared Desk password for everyone. Per-person logins would be a further change.
- Photos deleted in the Desk stay in the storage bucket until you clear them.
- OTA calendars (iCal) only block dates. There is no Airbnb/Booking.com API, payment, or guest-detail sync.
