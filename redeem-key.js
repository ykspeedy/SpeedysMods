/**
 * netlify/functions/redeem-key.js
 *
 * POST body: { key: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" }
 *
 * Returns:
 *   { ok: true,  modName: "PayMod v1", downloadUrl: "https://..." }
 *   { ok: false, reason: "invalid" | "used" | "expired" }
 *
 * ── Key store layout (Netlify Blobs, store: "license-keys") ──
 *   key: <uuid>
 *   value: JSON { modSlug, modName, downloadUrl, used: false, exp: <ms> }
 *
 * ── Seeding keys (run once from CLI after deploy) ──
 *   npx netlify blobs:set license-keys <uuid> \
 *     '{"modSlug":"paymod","modName":"PayMod v1","downloadUrl":"https://github.com/ykspeedy/SpeedysMods/releases/download/v1/PayMod-v1.jar","used":false,"exp":0}'
 *
 *   Set exp: 0 to mean "never expires" (0 is treated as no expiry below).
 *   Or set a Unix-ms timestamp for a timed key.
 *
 * ── Generating keys in bulk ──
 *   node -e "for(let i=0;i<50;i++) console.log(crypto.randomUUID())" --input-type=module
 *   Then seed each one via the CLI above (or a small seed script).
 */

import { getStore } from '@netlify/blobs';

export default async function handler(req) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, reason: 'method' }), { status: 405, headers });
  }

  let key = '';
  try {
    const body = await req.json();
    key = (body.key || '').trim().toLowerCase();
  } catch {
    return new Response(JSON.stringify({ ok: false, reason: 'invalid' }), { status: 400, headers });
  }

  if (!key) {
    return new Response(JSON.stringify({ ok: false, reason: 'invalid' }), { status: 400, headers });
  }

  const store = getStore('license-keys');

  // 1. Look up the key
  let raw;
  try {
    raw = await store.get(key);
  } catch {
    return new Response(JSON.stringify({ ok: false, reason: 'invalid' }), { status: 200, headers });
  }

  if (!raw) {
    return new Response(JSON.stringify({ ok: false, reason: 'invalid' }), { status: 200, headers });
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ ok: false, reason: 'invalid' }), { status: 200, headers });
  }

  // 2. Already used?
  if (data.used) {
    return new Response(JSON.stringify({ ok: false, reason: 'used' }), { status: 200, headers });
  }

  // 3. Expired? (exp: 0 = never expires)
  if (data.exp && Date.now() > data.exp) {
    return new Response(JSON.stringify({ ok: false, reason: 'expired' }), { status: 200, headers });
  }

  // 4. Mark as used (one-time)
  data.used = true;
  data.redeemedAt = new Date().toISOString();
  await store.set(key, JSON.stringify(data));

  // 5. Return the download URL
  return new Response(
    JSON.stringify({
      ok:          true,
      modName:     data.modName     || 'Your mod',
      downloadUrl: data.downloadUrl || '',
    }),
    { status: 200, headers }
  );
}

export const config = { path: '/.netlify/functions/redeem-key' };
