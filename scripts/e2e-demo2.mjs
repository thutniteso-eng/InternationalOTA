#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import process from 'node:process';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const MAILPIT_URL = (process.env.MAILPIT_URL ?? `${BASE_URL}/mailpit`).replace(/\/+$/, '');
const BASIC_USER = process.env.BASIC_AUTH_USER ?? '';
const BASIC_PASS = process.env.BASIC_AUTH_PASS ?? '';

const cookieJar = new Map();

function basicAuthHeader() {
  if (!BASIC_USER || !BASIC_PASS) {
    return {};
  }
  const encoded = Buffer.from(`${BASIC_USER}:${BASIC_PASS}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${encoded}` };
}

function storeCookies(res) {
  const setCookies =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of setCookies) {
    const firstPart = raw.split(';')[0];
    if (!firstPart) continue;
    const eqIdx = firstPart.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = firstPart.slice(0, eqIdx).trim();
    const val = firstPart.slice(eqIdx + 1).trim();
    if (val === '' || raw.toLowerCase().includes('max-age=0')) {
      cookieJar.delete(name);
    } else {
      cookieJar.set(name, val);
    }
  }
}

function cookieHeader() {
  if (cookieJar.size === 0) return '';
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function http(url, init = {}) {
  const headers = {
    Origin: BASE_URL,
    ...basicAuthHeader(),
    ...(cookieHeader() ? { Cookie: cookieHeader() } : {}),
    ...(init.headers ?? {}),
  };
  const res = await fetch(url, { ...init, headers });
  storeCookies(res);
  return res;
}

async function pollUntil(label, fn, timeoutMs = 30_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastVal;
  while (Date.now() < deadline) {
    lastVal = await fn();
    if (lastVal) {
      return lastVal;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

function assert(cond, message) {
  if (!cond) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function listMailpitMessages() {
  const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=50`, {
    headers: { ...basicAuthHeader() },
  });
  assert(res.ok, `Mailpit list failed with ${res.status}`);
  return res.json();
}

async function getMailpitMessage(id) {
  const res = await fetch(`${MAILPIT_URL}/api/v1/message/${encodeURIComponent(id)}`, {
    headers: { ...basicAuthHeader() },
  });
  assert(res.ok, `Mailpit detail failed with ${res.status}`);
  return res.json();
}

async function main() {
  const runId = `${Date.now()}-${randomUUID().slice(0, 6)}`;
  const email = `e2e-demo2-${runId}@example.com`;
  const password = 'Demo2E2ePassword!2026';
  const name = `Demo2 User ${runId.slice(-4)}`;

  console.log(`[e2e-demo2] Target BASE_URL=${BASE_URL}`);
  console.log(`[e2e-demo2] Target MAILPIT_URL=${MAILPIT_URL}`);

  // 1. Sign up & request email verification
  const signUpRes = await http(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  if (signUpRes.status !== 200) {
    throw new Error(`sign-up failed: ${signUpRes.status} ${await signUpRes.text()}`);
  }

  const sendVerifyRes = await http(`${BASE_URL}/api/auth/send-verification-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, callbackURL: '/vi' }),
  });
  if (sendVerifyRes.status !== 200) {
    throw new Error(
      `send-verification-email failed: ${sendVerifyRes.status} ${await sendVerifyRes.text()}`,
    );
  }

  // 2. Verify email via Mailpit
  const verifyLink = await pollUntil('Mailpit verification email', async () => {
    const inbox = await listMailpitMessages();
    const msgMeta = (inbox.messages ?? []).find((m) =>
      (m.To ?? []).some((t) => String(t.Address ?? '').toLowerCase() === email.toLowerCase()),
    );
    if (!msgMeta) return null;
    const msg = await getMailpitMessage(msgMeta.ID);
    const haystack = `${msg.Text ?? ''}\n${msg.HTML ?? ''}`;
    const match = /(https?:\/\/[^\s"'<>]+\/api\/auth\/verify-email[^\s"'<>]*)/.exec(haystack);
    return match ? match[1].replace(/&amp;/g, '&') : null;
  });

  const parsedVerifyUrl = new URL(verifyLink);
  const localVerifyUrl = `${BASE_URL}${parsedVerifyUrl.pathname}${parsedVerifyUrl.search}`;
  const verifyFollow = await http(localVerifyUrl, { redirect: 'manual' });
  assert(
    [200, 302, 303].includes(verifyFollow.status),
    `verify-email returned ${verifyFollow.status}`,
  );
  console.log(`[e2e-demo2] Email verified for ${email}`);

  // 3. Explicit sign-in
  const signInRes = await http(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert(signInRes.status === 200, `sign-in failed: ${signInRes.status}`);

  const sessionRes = await http(`${BASE_URL}/api/auth/get-session`);
  assert(sessionRes.status === 200, `get-session failed: ${sessionRes.status}`);
  const sessionData = await sessionRes.json();
  assert(sessionData?.user?.emailVerified === true, 'expected user.emailVerified === true');
  console.log(`[e2e-demo2] Signed in cleanly (verified session)`);

  // 4. Find tour + open departure > 48h in the future + quote
  const catalogRes = await http(`${BASE_URL}/api/catalog/products?locale=vi&limit=20`);
  assert(catalogRes.status === 200, `catalog list failed: ${catalogRes.status}`);
  const catalogData = await catalogRes.json();
  assert(Array.isArray(catalogData.items) && catalogData.items.length > 0, 'no catalog products');

  const thresholdMs = Date.now() + 50 * 3600_000;
  let chosenProduct = null;
  let chosenDep = null;
  let chosenQuote = null;

  for (const product of catalogData.items) {
    const fromDate = new Date(thresholdMs).toISOString().slice(0, 10);
    const toDate = new Date(thresholdMs + 14 * 86_400_000).toISOString().slice(0, 10);
    const availRes = await http(
      `${BASE_URL}/api/catalog/products/${encodeURIComponent(product.id)}/availability?from=${fromDate}&to=${toDate}`,
    );
    if (!availRes.ok) continue;
    const avail = await availRes.json();
    const dep = (avail.items ?? []).find(
      (d) =>
        d.status === 'available' &&
        d.remaining >= 2 &&
        Date.parse(d.startsAt) > thresholdMs,
    );
    if (!dep) continue;

    const quoteRes = await http(
      `${BASE_URL}/api/catalog/products/${encodeURIComponent(product.id)}/quote?departureId=${encodeURIComponent(dep.id)}&adult=1&child=0&infant=0&locale=vi`,
    );
    if (!quoteRes.ok) continue;
    chosenProduct = product;
    chosenDep = dep;
    chosenQuote = await quoteRes.json();
    break;
  }

  assert(
    chosenProduct && chosenDep && chosenQuote,
    'could not find a published tour departure >48h ahead with active quote',
  );
  console.log(
    `[e2e-demo2] Quoted tour=${chosenProduct.slug} dep=${chosenDep.localDate} total=${chosenQuote.totalFormatted}`,
  );

  // 5. Place hold
  const holdRes = await http(`${BASE_URL}/api/bookings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `e2e-hold-${runId}`,
    },
    body: JSON.stringify({
      departureId: chosenDep.id,
      pax: { adult: 1, child: 0, infant: 0 },
      contact: { name, email, phone: '+84901234567', locale: 'vi' },
      expectedSnapshotHash: chosenQuote.snapshotHash,
    }),
  });
  if (holdRes.status !== 201) {
    throw new Error(`create hold failed: ${holdRes.status} ${await holdRes.text()}`);
  }
  const hold = await holdRes.json();
  console.log(`[e2e-demo2] Hold created: ref=${hold.reference} status=${hold.status}`);

  // 6. Checkout -> Mock PSP "Pay successfully" form
  const returnUrl = `/vi/bookings/${hold.reference}/return`;
  const checkoutRes = await http(`${BASE_URL}/api/bookings/${hold.reference}/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `e2e-checkout-${runId}`,
    },
    body: JSON.stringify({ returnUrl }),
  });
  if (checkoutRes.status !== 200) {
    throw new Error(`checkout failed: ${checkoutRes.status} ${await checkoutRes.text()}`);
  }
  const checkout = await checkoutRes.json();

  const mockPageRes = await http(`${BASE_URL}${checkout.redirectUrl}`);
  assert(mockPageRes.status === 200, `mock checkout page returned ${mockPageRes.status}`);

  const actionRes = await http(`${BASE_URL}${checkout.redirectUrl}/action`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'action=success',
  });
  assert(actionRes.status === 303, `mock action failed: ${actionRes.status}`);
  console.log(`[e2e-demo2] Submitted Mock PSP Pay successfully`);

  // 7. Poll booking until confirmed
  const confirmedBooking = await pollUntil('booking confirmed', async () => {
    const res = await http(`${BASE_URL}/api/bookings/${hold.reference}`);
    if (!res.ok) return null;
    const b = await res.json();
    return b.status === 'confirmed' ? b : null;
  });
  console.log(`[e2e-demo2] Server confirmed booking ref=${confirmedBooking.reference}`);

  // 8. Assert held + confirmed emails in Mailpit
  const bookingEmails = await pollUntil('2 booking emails in Mailpit', async () => {
    const inbox = await listMailpitMessages();
    const matches = (inbox.messages ?? []).filter(
      (m) =>
        (m.To ?? []).some((t) => String(t.Address ?? '').toLowerCase() === email.toLowerCase()) &&
        String(m.Subject ?? '').includes(hold.reference),
    );
    const hasHeld = matches.some((m) => String(m.Subject).includes('[Giữ chỗ]'));
    const hasConfirmed = matches.some((m) => String(m.Subject).includes('[Xác nhận]'));
    return hasHeld && hasConfirmed ? matches : null;
  });
  console.log(`[e2e-demo2] Mailpit verified ${bookingEmails.length} booking emails (held + confirmed)`);

  // 9. Cancellation preview (>48h -> 100%)
  const previewRes = await http(`${BASE_URL}/api/bookings/${hold.reference}/cancellation-preview`);
  assert(previewRes.status === 200, `cancellation-preview failed: ${previewRes.status}`);
  const preview = await previewRes.json();
  assert(preview.cancellable === true, 'expected cancellable === true');
  assert(preview.refundPercent === 100, `expected 100% refund, got ${preview.refundPercent}`);
  assert(
    preview.refundAmountMinor === hold.totalAmountMinor,
    `expected full refund ${hold.totalAmountMinor}, got ${preview.refundAmountMinor}`,
  );
  console.log(
    `[e2e-demo2] Cancellation preview: ${preview.refundPercent}% (${preview.refundAmountMinor} ${preview.currency})`,
  );

  // 10. Cancel booking
  const cancelRes = await http(`${BASE_URL}/api/bookings/${hold.reference}/cancel`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `e2e-cancel-${runId}` },
  });
  assert(cancelRes.status === 200, `cancel failed: ${cancelRes.status}`);
  const cancelDto = await cancelRes.json();
  assert(cancelDto.status === 'cancelled', `expected cancelled, got ${cancelDto.status}`);
  assert(cancelDto.refundPercent === 100, `expected cancel 100%, got ${cancelDto.refundPercent}`);

  // 11. Poll until refund status === 'succeeded'
  const refundedBooking = await pollUntil('refund succeeded', async () => {
    const res = await http(`${BASE_URL}/api/bookings/${hold.reference}`);
    if (!res.ok) return null;
    const b = await res.json();
    return b.refund?.status === 'succeeded' ? b : null;
  });
  console.log(
    `[e2e-demo2] Refund succeeded: amount=${refundedBooking.refund.amountMinor} status=${refundedBooking.refund.status}`,
  );
  console.log(`[e2e-demo2] PASS — all steps verified for ${hold.reference}`);
}

main().catch((err) => {
  console.error('[e2e-demo2] FAILED:', err);
  process.exit(1);
});
