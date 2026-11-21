# Boxpace on Cloudflare + Supabase — setup guide

This folder is the Boxpace website moved off Netlify:

- **Website pages** (`website/`) → Cloudflare Pages (free)
- **Backend** (`functions/api/`) → Cloudflare Pages Functions (free)
- **Hourly OTA calendar refresh** (`worker-cron/`) → one small Cloudflare Worker with a cron trigger (free)
- **Database + photos** → your Supabase project (free plan)

Never paste a password or key into chat, into a file in this folder, or into GitHub. Enter them only in the Cloudflare/Supabase pages named below.

---

## 0. Gather four values (2 minutes)

You need these four values. Keep them in a password manager.

| Name | What it is | How to get it |
|---|---|---|
| `SUPABASE_URL` | Your project address, like `https://abcd1234.supabase.co` | Supabase → **Connect** button (top bar) or Project Settings → Data API |
| `SUPABASE_SECRET_KEY` | Full-access database key, starts with `sb_secret_` | Supabase → Project Settings → **API Keys** → Secret key. Do not use the "publishable" key |
| `BOXPACE_DASHBOARD_PASSWORD` | The password your team types into the Team Desk | **Make a new strong one** (14+ characters). Don't reuse the old Netlify one |
| `CRON_SECRET` | A long random value only the hourly job knows | Windows PowerShell: `[guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")` |

## 1. Supabase (once)

1. Supabase → **SQL Editor** → paste all of `supabase/schema.sql` → **Run**. It creates the `boxpace_records` table (private) and a public photo bucket called `property-photos`.
2. Check: **Table Editor** shows `boxpace_records`; **Storage** shows `property-photos`.

## 2. Cloudflare Pages (the website + backend)

Pick **A** (recommended, updates itself when you change code) or **B** (no GitHub).

### A. Connect a GitHub repository

1. Put this folder's contents in a **private** GitHub repository (the folder that contains `website/` and `functions/` must be the repository root). `.gitignore` already keeps keys and `node_modules` out.
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → choose the repository.
3. Build settings: Framework preset **None**, Build command **(leave empty)**, Build output directory **`website`**. Save and Deploy.
4. Open the project → **Settings → Variables and Secrets** → add for **Production**:
   `SUPABASE_URL` (Text), `SUPABASE_SECRET_KEY` (**Secret**), `BOXPACE_DASHBOARD_PASSWORD` (**Secret**), `CRON_SECRET` (**Secret**).
5. **Deployments** → latest deployment → **Retry deployment** (variables only apply to new deployments).

### B. Upload directly from your computer

Needs Node.js 20+ installed. In a terminal, inside this folder:

```
npm install
npx wrangler login
npx wrangler pages project create boxpace-hospitality --production-branch main
npx wrangler pages deploy website --project-name boxpace-hospitality
npx wrangler pages secret put SUPABASE_SECRET_KEY --project-name boxpace-hospitality
npx wrangler pages secret put BOXPACE_DASHBOARD_PASSWORD --project-name boxpace-hospitality
npx wrangler pages secret put CRON_SECRET --project-name boxpace-hospitality
npx wrangler pages secret put SUPABASE_URL --project-name boxpace-hospitality
npx wrangler pages deploy website --project-name boxpace-hospitality
```

(Each `secret put` asks you to type the value. The last line redeploys so they take effect.)

Your site will be at `https://boxpace-hospitality.pages.dev` (the name may differ slightly).

## 3. Hourly calendar job (5 minutes)

It refreshes OTA calendars every hour, and its hourly database read also stops the free Supabase project from pausing.

Dashboard route: **Workers & Pages → Create → Worker** → name `boxpace-calendar-cron` → **Deploy** → **Edit code** → replace everything with `worker-cron/index.js` → **Deploy**. Then in the Worker: **Settings → Variables and Secrets** → add `SITE_URL` (Text, your `https://….pages.dev` address with no trailing slash) and `CRON_SECRET` (Secret, **the same value** as in step 2). Then **Settings → Trigger Events → Cron Triggers → Add** `0 * * * *`.

Command-line route: `cd worker-cron`, edit `SITE_URL` in `wrangler.toml`, `npx wrangler deploy`, `npx wrangler secret put CRON_SECRET`.

## 4. Check it works (10 minutes)

1. Open the site. **Properties** should say new stays are being prepared (not "temporarily unavailable").
2. On **Contact**, send a test enquiry. In Supabase → Table Editor → `boxpace_records`, a row with key `enquiry:…` appears.
3. Open `/desk.html`, enter the dashboard password. The test enquiry shows under Sales & leads. Delete it there.
4. In the Desk add a **test** property with one photo, publish it, then check it appears on the public Properties page and the photo link points at `…supabase.co/storage/v1/object/public/property-photos/…`. Archive or delete the test property afterwards.
5. Try a wrong password 10 times on the Desk: it should then say to wait 15 minutes. (Use a different network or wait if you lock yourself out.)

## 5. Switching your address over

Keep the Netlify site running until step 4 passes. To use `boxpace.in`: Pages project → **Custom domains** → Set up a domain, and follow Cloudflare's DNS instructions. If you used the old Desk with real data, open the **old** Desk first and use its backup/export, then **Import backup** on the new Desk.

---

## What changed from the Netlify version

- Backend rewritten for Cloudflare; it talks only to Supabase (the Netlify Blobs fallback was removed).
- **Bookings are now one record each**, so two people saving at once can't overwrite each other.
- **Deleting a property is recoverable**: a copy (with its OTA calendar settings) goes to `trash:property:…` first.
- **Photos move to Supabase Storage** instead of living inside database rows. `desk.html` got a small change so it adopts the new photo links.
- **Login lockout** after 10 wrong passwords per connection for 15 minutes, and a limit of 8 public enquiries per hour per connection.
- **Bug fix:** the old OTA importer read event dates under the wrong name, so it never blocked any dates. Fixed and tested.
- Hourly refresh is split per property (Cloudflare's free plan allows 50 outbound requests per run).

## Tests

`node test/run.mjs` runs 20 checks against a built-in fake Supabase (no accounts needed). All pass.

## Honest limits

- **Not yet tried against your real Supabase and Cloudflare accounts.** The step-4 checks are how you confirm it.
- Uploading photos with the new `sb_secret_` key is the part I'm least sure of. If photos fail to move, the Desk keeps them inline (nothing is lost) and the save response reports `photosNotMoved`. Tell me and I'll adjust.
- Cloudflare's free plan limits each request to about 10 ms of computing time. Saving several large photos at once might hit it. If you see errors like "Error 1102", Workers Paid ($5/month) removes the limit.
- The shared Desk password is still one password for everyone. Per-person logins would be a further change.
- Photos you delete in the Desk stay in the storage bucket (small, but not cleaned up automatically).
- OTA calendars (ICS) only block dates. There is still no Airbnb/Booking.com API, payment, or guest-detail sync.
