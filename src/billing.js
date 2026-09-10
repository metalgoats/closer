// Stripe billing (TASK-122).
//
// WHAT THIS IS AND IS NOT.
//
// It is NOT self-serve signup. At $2,500 to install and roughly $2,000/month, nobody buys
// unattended — this product is sold by a closer on a call. An open signup form at this price
// would collect fraud, not customers. The shape is: we generate a checkout link for a named
// buyer, they pay on Stripe's page, a webhook provisions them, and from then on they manage
// their own card and cancellation in Stripe's portal without us in the middle.
//
// > [!important] WE NEVER SEE A CARD NUMBER. That is the whole design, not a side effect.
// > Every card detail is entered on a page Stripe hosts, on Stripe's domain. Nothing sensitive
// > touches this Worker, this database, or a support conversation. There is no code path here
// > that accepts a PAN, and there must never be one.
//
// PRICES LIVE IN STRIPE, NOT IN THIS FILE. The price is not settled (three options are open in
// `2026-09-09 Nathan round/Business model — three options.md`), so hardcoding a number would
// mean a deploy to change it. Instead the Worker holds Stripe *Price IDs* as config, and the
// amounts live in the Stripe dashboard where a non-engineer can change them.

// ---------------------------------------------------------------------------------------------
// Webhook signature verification. This is the only authentication the webhook has.
// ---------------------------------------------------------------------------------------------
//
// > [!danger] Without this, the endpoint is a free-account dispenser.
// > The webhook route is necessarily unauthenticated — Stripe has no session cookie. Anyone on
// > the internet can POST to it. The signature is what separates "Stripe told us this customer
// > paid" from "someone told us this customer paid", and provisioning on an unverified payload
// > means anyone can grant themselves a subscription by typing a curl command.
//
// Implemented against Stripe's documented manual-verification steps rather than the SDK: this
// app has zero runtime dependencies and calls every third party with `fetch`, and the Stripe
// Node SDK needs a non-default HTTP client and async webhook parsing to work on Workers at all.
//
//   Stripe-Signature: t=1492774577,v1=5257a869...,v0=6ffbb59b...
//   signed_payload   = `${t}.${rawBody}`
//   expected         = HMAC-SHA256(signing_secret, signed_payload) as hex
//
// Four details that are each a real vulnerability if skipped:
//   1. IGNORE every scheme that is not `v1`. Stripe sends a fake `v0` on test events, and
//      accepting an arbitrary scheme is a downgrade attack.
//   2. There can be MORE THAN ONE v1 signature — during a secret roll both the old and new
//      secrets sign for up to 24 hours. Checking only the first would reject live traffic mid-roll.
//   3. Compare in constant time. A short-circuiting `===` leaks the expected signature one byte
//      at a time to anyone willing to measure.
//   4. Enforce a timestamp tolerance, or a captured payload can be replayed forever. Stripe's
//      libraries default to 5 minutes. Never 0 — that disables the check entirely.
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

// Constant time over the WHOLE string. Returning early on a length mismatch is fine (length is
// not secret) but the byte loop must never break early.
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseStripeSignature(header) {
  const out = { t: null, v1: [] };
  for (const part of String(header || "").split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") out.t = v;
    else if (k === "v1") out.v1.push(v);      // every other scheme, v0 included, is discarded
  }
  return out;
}

// Returns { ok, reason } — never throws, because a malformed payload from the open internet is
// an expected input, not an exception.
export async function verifyStripeSignature(rawBody, header, secret, {
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS, now = Date.now(),
} = {}) {
  if (!secret) return { ok: false, reason: "no signing secret configured" };
  const { t, v1 } = parseStripeSignature(header);
  if (!t || !v1.length) return { ok: false, reason: "malformed Stripe-Signature header" };

  const ts = Number(t);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad timestamp" };
  const ageSeconds = Math.abs(now / 1000 - ts);
  if (toleranceSeconds > 0 && ageSeconds > toleranceSeconds) {
    return { ok: false, reason: `timestamp outside tolerance (${Math.round(ageSeconds)}s)` };
  }

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const expected = hex(mac);

  // Every candidate is checked; no early exit on the first match either, so the number of
  // comparisons does not depend on which signature matched.
  let matched = false;
  for (const candidate of v1) if (constantTimeEqual(candidate, expected)) matched = true;
  return matched ? { ok: true } : { ok: false, reason: "no v1 signature matched" };
}

// ---------------------------------------------------------------------------------------------
// Talking to Stripe. Form-encoded REST over fetch, no SDK.
// ---------------------------------------------------------------------------------------------

// Stripe's API is application/x-www-form-urlencoded with bracket notation for nesting:
//   line_items[0][price]=price_123&line_items[0][quantity]=6
export function formEncode(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) =>
      typeof item === "object" && item !== null
        ? formEncode(item, `${key}[${i}]`, out)
        : out.append(`${key}[${i}]`, String(item)));
    else if (typeof v === "object") formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripeApi(env, path, body, { idempotencyKey } = {}) {
  if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
  const headers = {
    authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "content-type": "application/x-www-form-urlencoded",
  };
  // Stripe retries are safe with this; without it a double-clicked button can create two
  // subscriptions for the same customer and only one of them gets cancelled.
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST", headers,
    body: body ? formEncode(body).toString() : "",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    // Stripe's own message is the useful one and is safe to surface: it says "no such price",
    // not anything about the key. Never include the key or the raw request in an error.
    throw new Error(data?.error?.message || `Stripe returned ${res.status}`);
  }
  return data;
}

// ---------------------------------------------------------------------------------------------
// Checkout: one link, activation fee + per-seat subscription, paid on Stripe's page.
// ---------------------------------------------------------------------------------------------
//
// `mode: "subscription"` accepts BOTH a recurring price and a one-time price as line items (up
// to 20 of each); the one-time price appears on the first invoice only. That is exactly the
// commercial shape: $2,500 once to install, then $X per seat per month, in a single payment.
//
// `subscription_data.trial_period_days` exists because onboarding is not instant. Billing the
// monthly licence from the moment they sign means charging for software a technician has not
// finished connecting. Set it to the onboarding window and the activation fee still bills today.
export async function createCheckoutSession(env, {
  email, seats = 1, accountId = null, trialDays = null, origin,
}) {
  if (!env.STRIPE_PRICE_SEAT) throw new Error("STRIPE_PRICE_SEAT is not set");
  if (!Number.isInteger(seats) || seats < 1) throw new Error("seats must be a positive integer");

  const line_items = [{ price: env.STRIPE_PRICE_SEAT, quantity: seats }];
  // The activation fee is optional config: a customer who is not paying one (a beta, a second
  // business under an existing agreement) simply gets a checkout without that line.
  if (env.STRIPE_PRICE_ACTIVATION) line_items.push({ price: env.STRIPE_PRICE_ACTIVATION, quantity: 1 });

  return stripeApi(env, "checkout/sessions", {
    mode: "subscription",
    line_items,
    customer_email: email || undefined,
    success_url: `${origin}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?billing=cancelled`,
    // Both of these come back on the webhook. They are how a payment made on Stripe's domain is
    // matched to a row in our database — without them the webhook knows a stranger paid.
    client_reference_id: accountId ? String(accountId) : undefined,
    metadata: { account_id: accountId ?? "", seats: String(seats) },
    subscription_data: {
      metadata: { account_id: accountId ?? "", seats: String(seats) },
      ...(trialDays ? { trial_period_days: trialDays } : {}),
    },
    // Sales tax on software is a real liability and it is not optional to think about. Stripe
    // Tax must also be switched on in the dashboard; this flag alone does nothing.
    automatic_tax: { enabled: true },
    // Lets the buyer correct their own company address and VAT/ABN details at checkout rather
    // than emailing us to reissue an invoice.
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
  }, { idempotencyKey: `checkout:${accountId ?? "new"}:${email}:${seats}:${new Date().toISOString().slice(0, 13)}` });
}

// The Billing Portal is the part that stops us being the billing department. Stripe hosts it:
// the customer updates their card, downloads invoices, changes seat count and cancels, all
// without a support email and without us handling anything sensitive.
export async function createPortalSession(env, { customerId, returnUrl }) {
  if (!customerId) throw new Error("no Stripe customer for this account yet");
  return stripeApi(env, "billing_portal/sessions", { customer: customerId, return_url: returnUrl });
}

// What the app should do with an event. Kept separate from the route so it can be tested without
// a Worker, a database or a network.
//
// Deliberately a SMALL set. Stripe sends dozens of event types and subscribing to all of them
// puts load on the Worker for events nothing acts on.
export const HANDLED_EVENTS = Object.freeze([
  "checkout.session.completed",      // they paid — provision
  "invoice.paid",                    // a renewal succeeded — extend
  "invoice.payment_failed",          // card failed — Stripe dunns them; we flag it
  "customer.subscription.updated",   // seat count or status changed
  "customer.subscription.deleted",   // cancelled — access ends at period end
]);

// Which access state an event implies. Returns null for anything we do not act on, so an
// unknown event type is ignored rather than guessed at.
export function accessFromEvent(type, obj = {}) {
  switch (type) {
    case "checkout.session.completed":
      // `payment_status` matters: a session can complete while the payment is still processing
      // (bank debits), and provisioning on that is provisioning an unpaid customer.
      return obj.payment_status === "paid" || obj.payment_status === "no_payment_required"
        ? { status: "active" } : { status: "pending" };
    case "invoice.paid":               return { status: "active" };
    case "invoice.payment_failed":     return { status: "past_due" };
    case "customer.subscription.updated":
      return { status: obj.status === "active" || obj.status === "trialing" ? "active" : obj.status };
    case "customer.subscription.deleted": return { status: "cancelled" };
    default: return null;
  }
}
