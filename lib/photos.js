// Moves property photos out of the database record and into a public Supabase Storage bucket.
// The Desk stores photos as base64 data URLs; keeping those inside JSON rows makes every request
// slow and heavy. After this runs, a property's `photos` are short https URLs.
// If an upload fails the original data URL is kept, so a photo is never lost.

import { authHeaders, supabaseConfig } from "./store.js";
import { sha256Hex } from "./http.js";

export const PHOTO_BUCKET = "property-photos";
const MAX_BYTES = 2_500_000;
const TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

function decodeDataUrl(value) {
  const match = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
  if (!match || !TYPES[match[1].toLowerCase()]) return null;
  const binary = atob(match[2].replace(/\s/g, ""));
  if (binary.length > MAX_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { mime: match[1].toLowerCase(), bytes };
}

/**
 * Uploads any data-URL photos on `properties` and swaps them for public URLs (in place).
 * `budget.left` caps uploads per request to stay inside Cloudflare's subrequest limit.
 * Returns the number of photos that could not be uploaded.
 */
export async function offloadPhotos(env, properties, budget = { left: 20 }) {
  const { url, key } = supabaseConfig(env);
  let failed = 0;
  for (const property of properties) {
    if (!Array.isArray(property.photos)) continue;
    for (let i = 0; i < property.photos.length; i++) {
      const photo = property.photos[i];
      if (typeof photo !== "string" || !photo.startsWith("data:")) continue;
      if (budget.left <= 0) { failed++; continue; }
      const decoded = decodeDataUrl(photo);
      if (!decoded) { failed++; continue; }
      budget.left--;
      try {
        const hash = (await sha256Hex(decoded.bytes)).slice(0, 32);
        const path = `${property.id}/${hash}.${TYPES[decoded.mime]}`;
        const response = await fetch(`${url}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
          method: "POST",
          headers: authHeaders(key, { "content-type": decoded.mime, "x-upsert": "true", "cache-control": "max-age=31536000" }),
          body: decoded.bytes,
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        property.photos[i] = `${url}/storage/v1/object/public/${PHOTO_BUCKET}/${path}`;
      } catch {
        failed++;
      }
    }
  }
  return failed;
}
