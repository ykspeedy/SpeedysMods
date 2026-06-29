/**
 * netlify/functions/stripe-webhook.js
 *
 * Receives Stripe "checkout.session.completed" webhook events.
 * On a successful payment it emails the buyer their license key via EmailJS.
 *
 * ── Required environment variables ──
 *   STRIPE_WEBHOOK_SECRET   whsec_... from Stripe Dashboard → Webhooks
 *   EMAILJS_PUBLIC_KEY      your EmailJS public key
 *   EMAILJS_SERVICE_ID      e.g. service_h2fj1oc
 *   EMAILJS_TEMPLATE_ID     e.g. template_v4you2s  (must include {{license_key}} variable)
 *   SITE_URL                https://speedysmods.shop (no trailing slash)
 *
 * ── Stripe Payment Link setup ──
 *   For each product add a custom metadata field:
 *     Key: modSlug   Value: paymod   (or: spawner)
 *
 * ── Key pool (Netlify Blobs, store: "license-keys") ──
 *   Keys are pre-seeded. This function picks the next unused one for the
 *   purchased mod and marks it as "assigned" (not yet "used" — that happens
 *   when the buyer redeems it on the site).
 *
 *   Seed keys via CLI:
 *     npx netlify blobs:set license-keys <uuid> \
 *       '{"modSlug":"paymod","modName":"PayMod v1","downloadUrl":"https://github.com/ykspeedy/SpeedysMods/releases/download/v1/PayMod-v1.jar","used":false,"assigned":false,"exp":0}'
 */

import crypto from 'crypto';
import { getStore } from '@netlify/blobs';

// ── Stripe signature validation ───────────────────────────────────────────────

function stripeSignatureValid(rawBody, sigHeader, secret) {
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const signed = `${parts.t}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signed, 'utf8')
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(parts.v1 || '', 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

// ── Pick an unassigned key for the given modSlug ──────────────────────────────

async function claimKey(store, modSlug) {
  // List all keys in the store
  const { blobs } = await store.list();

  for (const blob of blobs) {
    let raw, data;
    try {
      raw  = await store.get(blob.key);
      data = JSON.parse(raw);
    } catch { continue; }

    if (data.modSlug !== modSlug) continue;
    if (data.used || data.assigned)  continue;

    // Claim it atomically-ish (best effort — Blobs has no transactions)
    data.assigned   = true;
    data.assignedAt = new Date().toISOString();
    await store.set(blob.key, JSON.stringify(data));
    return { key: blob.key, data };
  }

  return null; // no keys left
}

// ── Send email via EmailJS REST API ──────────────────────────────────────────

async function sendKeyEmail({ toEmail, modName, licenseKey, siteUrl }) {
  const payload = {
    service_id:  process.env.EMAILJS_SERVICE_ID,
    template_id: process.env.EMAILJS_TEMPLATE_ID,
    user_id:     process.env.EMAILJS_PUBLIC_KEY,
    template_params: {
      to_email:    toEmail,
      username:    toEmail.split('@')[0],
      mod_name:    modName,
      license_key: licenseKey,
      redeem_url:  siteUrl,           // buyers click "Redeem Key" on the site
      reply_to:    'support@speedysmods.shop',
    },
  };
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`EmailJS ${res.status}: ${await res.text()}`);
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const rawBody   = await req.text();
  const sigHeader = req.headers.get('stripe-signature') || '';

  // 1. Validate Stripe signature
  if (!stripeSignatureValid(rawBody, sigHeader, process.env.STRIPE_WEBHOOK_SECRET)) {
    console.error('Stripe signature invalid');
    return new Response('Bad signature', { status: 400 });
  }

  const event = JSON.parse(rawBody);

  // 2. Only handle completed checkouts
  if (event.type !== 'checkout.session.completed') {
    return new Response('OK', { status: 200 });
  }

  const session  = event.data.object;
  const modSlug  = (session.metadata?.modSlug || '').toLowerCase().trim();
  const email    = session.customer_details?.email || '';

  const slugToName = { paymod: 'PayMod v1', spawner: 'Spawner v1' };
  const modName    = slugToName[modSlug];

  if (!modName || !email) {
    console.error('Missing modSlug or email in session', { modSlug, email });
    return new Response('OK', { status: 200 }); // 200 so Stripe doesn't retry
  }

  // 3. Claim an unused key from Netlify Blobs
  const store  = getStore('license-keys');
  const result = await claimKey(store, modSlug);

  if (!result) {
    // No keys left — log loudly so you can top up
    console.error(`KEY POOL EMPTY for ${modSlug} — purchase by ${email} could not be fulfilled`);
    // TODO: send yourself an alert email here
    return new Response('OK', { status: 200 });
  }

  const { key: licenseKey } = result;
  const siteUrl = (process.env.SITE_URL || '').replace(/\/$/, '');

  // 4. Email the key to the buyer
  try {
    await sendKeyEmail({ toEmail: email, modName, licenseKey, siteUrl });
    console.log(`Key emailed to ${email} for ${modSlug} (key: ${licenseKey})`);
  } catch (err) {
    // Don't fail — key is already claimed. Log the error and alert manually.
    console.error('EmailJS send failed:', err.message, '| key:', licenseKey, '| email:', email);
  }

  return new Response('OK', { status: 200 });
}

export const config = { path: '/api/stripe-webhook' };
