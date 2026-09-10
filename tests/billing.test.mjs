// Stripe billing (TASK-122). This file is mostly about ONE endpoint, because that endpoint is
// the only unauthenticated write path in the entire application.
//
// /api/stripe/webhook has to be reachable without a session — Stripe does not carry a cookie —
// so anyone on the internet can POST to it. The signature is the sole authentication. Get it
// wrong and the endpoint hands out paid subscriptions to anyone who can type curl.
//
// Every assertion below was verified to FAIL when the protection it guards is removed.
import { verifyStripeSignature, parseStripeSignature, formEncode, accessFromEvent,
         HANDLED_EVENTS, SIGNATURE_TOLERANCE_SECONDS } from "../src/billing.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bill = readFileSync(join(here, "..", "src", "billing.js"), "utf8");
const idx  = readFileSync(join(here, "..", "src", "index.js"), "utf8");
const mig  = readFileSync(join(here, "..", "migrations", "0021_billing.sql"), "utf8");
let pass = 0, fail = 0;
const check = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "  pass" : "  FAIL"}  ${n}${d && !c ? `  <- ${d}` : ""}`); };

const SECRET = "whsec_test";
const sign = async (body, ts, secret = SECRET) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`));
  return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
};

console.log("\nBilling — webhook signature, the only thing guarding an open endpoint");

const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
const ts = Math.floor(Date.now() / 1000);
const good = await sign(body, ts);

check("a correctly signed payload verifies",
  (await verifyStripeSignature(body, `t=${ts},v1=${good}`, SECRET)).ok);
check("a tampered body does not",
  !(await verifyStripeSignature(body + " ", `t=${ts},v1=${good}`, SECRET)).ok,
  "the signature covers the exact bytes; any reserialisation must fail");
check("a signature from a different secret does not",
  !(await verifyStripeSignature(body, `t=${ts},v1=${good}`, "whsec_other")).ok);
check("a forged signature does not",
  !(await verifyStripeSignature(body, `t=${ts},v1=${"0".repeat(64)}`, SECRET)).ok);
check("no secret configured means no verification passes",
  !(await verifyStripeSignature(body, `t=${ts},v1=${good}`, "")).ok,
  "an unset secret must fail closed, never skip the check");

// Stripe sends a fake v0 on test events. Accepting any scheme other than v1 is a downgrade attack.
check("a v0-only signature is rejected",
  !(await verifyStripeSignature(body, `t=${ts},v0=${good}`, SECRET)).ok);
check("the parser discards every scheme except v1",
  parseStripeSignature(`t=1,v1=a,v0=b,v2=c`).v1.join(",") === "a"
    && parseStripeSignature(`t=1,v1=a,v0=b`).t === "1");
check("...and the reason is stated in the source", /downgrade attack/.test(bill));

// During a secret roll BOTH the old and new secrets sign, for up to 24 hours. Checking only the
// first v1 rejects live traffic mid-roll.
check("multiple v1 signatures are all checked, not just the first",
  (await verifyStripeSignature(body, `t=${ts},v1=deadbeef,v1=${good}`, SECRET)).ok,
  "a secret roll produces two signatures and would break checkout for 24 hours");

// Replay protection.
check("an old timestamp is rejected",
  !(await verifyStripeSignature(body, `t=${ts - 9999},v1=${await sign(body, ts - 9999)}`, SECRET)).ok,
  "without a tolerance a captured payload replays forever");
check("the tolerance is 5 minutes, matching Stripe's own libraries",
  SIGNATURE_TOLERANCE_SECONDS === 300);
check("a tolerance of 0 does NOT silently disable the check",
  /toleranceSeconds > 0/.test(bill),
  "Stripe's docs say explicitly: do not use 0, it disables the recency check");

// Timing.
check("signatures are compared in constant time",
  /constantTimeEqual/.test(bill) && /diff \|= a\.charCodeAt\(i\) \^ b\.charCodeAt\(i\)/.test(bill)
    && !/candidate === expected/.test(bill),
  "a short-circuiting compare leaks the expected signature one byte at a time");
check("the compare loop has no early exit", !/if \(a\[i\] !== b\[i\]\) return false/.test(bill));

console.log("\nBilling — the route, which is the part that is easy to reorder wrongly");

check("the webhook is handled ABOVE the auth gate",
  idx.indexOf('path === "/api/stripe/webhook"') < idx.indexOf("const user = await requireUser"),
  "below it, Stripe gets a 401 and every payment silently fails to provision");
check("the raw body is read as text, never parsed first",
  /const raw = await request\.text\(\);/.test(idx)
    && idx.indexOf("const raw = await request.text()") < idx.indexOf("await verifyStripeSignature"));
check("verification happens BEFORE the payload is inspected",
  idx.indexOf("await verifyStripeSignature") < idx.indexOf("handleStripeEvent"),
  "reading the event first and verifying after is how a refactor ends up acting on a forgery");
check("a failed verification returns 400 and provisions nothing",
  /if \(!check\.ok\) \{[\s\S]{0,400}return json\(\{ error: "signature verification failed" \}, 400\)/.test(idx));
check("a rejected webhook is logged", /kind: "stripe\.webhook_rejected"/.test(idx));
check("the rejection log does not include the payload or the secret",
  /kind: "stripe\.webhook_rejected", detail: check\.reason/.test(idx));

// The webhook must NOT live under /api/billing, which is admin-gated.
check("/api/billing is admin-only",
  /const ADMIN_ONLY = \[[^\]]*\/\^\\\/api\\\/billing\/[^\]]*\]/.test(idx));
check("...and the webhook is deliberately NOT under that prefix",
  /"\/api\/stripe\/webhook"/.test(idx) && !/"\/api\/billing\/webhook"/.test(idx),
  "under /api/billing the admin gate would 401 Stripe on every event");

console.log("\nBilling — idempotency, because Stripe redelivers by design");

check("the event id is the primary key",
  /stripe_event_id TEXT PRIMARY KEY/.test(mig));
// Anchored on the EFFECT — the upsert that grants access — not on accessFromEvent, which is a
// pure function that changes nothing. The first version of this assertion compared against the
// pure call and therefore stayed green when the ledger write was moved; found by insisting the
// guard go red before trusting it.
check("the ledger insert happens BEFORE the write that grants access",
  idx.indexOf("INSERT INTO billing_events") < idx.indexOf("INSERT INTO billing (account_id"),
  "recording after acting means a crash between the two re-provisions on the retry");
check("...and before the event is logged as applied",
  idx.indexOf("INSERT INTO billing_events") < idx.indexOf("kind: `billing.${type"));
check("a duplicate returns 200, not an error",
  /return json\(\{ ok: true, duplicate: true \}\)/.test(idx),
  "a non-2xx makes Stripe retry for three days for a delivery that actually succeeded");
check("the reason Stripe redelivers is written down",
  /retries for three days/.test(idx) || /retries for\n?\s*\/\/ three days/.test(idx));

console.log("\nBilling — what an event is allowed to mean");

// A Checkout Session can complete while the payment is still processing.
check("a completed-but-unpaid session does NOT grant access",
  accessFromEvent("checkout.session.completed", { payment_status: "unpaid" }).status === "pending",
  "bank debits complete the session before the money arrives");
check("a paid session does", accessFromEvent("checkout.session.completed", { payment_status: "paid" }).status === "active");
check("a zero-value session (100% coupon) also does",
  accessFromEvent("checkout.session.completed", { payment_status: "no_payment_required" }).status === "active");
check("a failed payment is past_due, NOT cancelled",
  accessFromEvent("invoice.payment_failed", {}).status === "past_due",
  "Stripe dunns for days; cutting a paying customer off on the first failed charge is the angry-phone-call bug");
check("past_due is a distinct state in the schema, not a boolean",
  /Deliberately NOT a boolean/.test(mig));
check("a deletion is cancelled", accessFromEvent("customer.subscription.deleted", {}).status === "cancelled");
check("an unknown event type means nothing", accessFromEvent("customer.discount.created", {}) === null);
check("unhandled types are answered 200, not with an error",
  /return json\(\{ ok: true, ignored: type \}\)/.test(idx),
  "erroring on an event we ignore buys three days of retries and a red dashboard");
check("the handled set is small and explicit", HANDLED_EVENTS.length <= 6 && HANDLED_EVENTS.includes("invoice.paid"));

// Money moved and we could not say for whom: that must never be silent.
check("an unmatchable event is logged at error level",
  /kind: "stripe\.unmatched_event"/.test(idx) && /level: "error", kind: "stripe\.unmatched_event"/.test(idx),
  "somebody paid and nothing was provisioned is the one failure that must never be quiet");

console.log("\nBilling — we never touch a card, and the price is not in the code");

// Comments stripped first: the prose in billing.js legitimately says "no code path accepts a
// PAN", and matching our own warning would make this assertion permanently red for the wrong
// reason. Checking CODE, not commentary, is also the stronger test.
const stripComments = t => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("no card field is accepted anywhere in the code",
  !/\b(card_number|cardNumber|cvc|cvv|exp_month|exp_year)\b/i.test(stripComments(bill) + stripComments(idx)),
  "there is no code path that accepts a card, and there must never be one");
check("checkout returns a Stripe-hosted URL rather than collecting anything",
  /createCheckoutSession/.test(idx) && /return json\(\{ ok: true, url: sess\.url/.test(idx));
check("the design reason is recorded, not just the behaviour",
  /WE NEVER SEE A CARD NUMBER/.test(bill));
check("prices are Stripe Price IDs from config, not amounts in code",
  /env\.STRIPE_PRICE_SEAT/.test(bill) && !/\b(2500|39700|197|397)\b/.test(bill),
  "the price is still undecided; a hardcoded amount means a deploy to change it");
// Narrow on purpose: `${key}` appears legitimately inside formEncode as a loop variable. What
// must never happen is the SECRET reaching a thrown message or a log line.
// The key has exactly ONE legitimate use: the Authorization header. This pins that rather than
// banning the string, because banning it outright would flag the one place it belongs.
{
  const uses = [...(bill + idx).matchAll(/^.*STRIPE_SECRET_KEY.*$/gm)].map(m => m[0].trim());
  const illegitimate = uses.filter(l =>
    !/authorization: `Bearer \$\{env\.STRIPE_SECRET_KEY\}`/.test(l) &&  // the one real use
    !/if \(!env\.STRIPE_SECRET_KEY\) throw new Error\("STRIPE_SECRET_KEY is not set"\)/.test(l) && // name only
    !/Boolean\(env\.STRIPE_SECRET_KEY\)/.test(l));                       // presence only
  check("the secret key is only ever sent in the Authorization header",
    illegitimate.length === 0,
    illegitimate.length ? `also used at: ${illegitimate.join(" | ").slice(0, 160)}` : "");
  check("...and the 'not set' error names the variable, never its value",
    /throw new Error\("STRIPE_SECRET_KEY is not set"\)/.test(bill),
    "an error containing the live key ends up in an event log and then in a screenshot");
}
check("a missing key fails loudly rather than calling Stripe anonymously",
  /if \(!env\.STRIPE_SECRET_KEY\) throw new Error/.test(bill));
check("checkout sends an idempotency key",
  /idempotencyKey: `checkout:/.test(bill),
  "a double-clicked button otherwise creates two subscriptions for one customer");
check("seats are validated as a whole number",
  /Number\.isInteger\(seats\) \|\| seats < 1/.test(bill));
check("sales tax is switched on in the request",
  /automatic_tax: \{ enabled: true \}/.test(bill));

console.log("\nBilling — form encoding, because Stripe is not JSON");

check("nested arrays use bracket notation",
  formEncode({ line_items: [{ price: "p1", quantity: 6 }] }).toString()
    === "line_items%5B0%5D%5Bprice%5D=p1&line_items%5B0%5D%5Bquantity%5D=6");
check("null and undefined are omitted rather than sent as strings",
  formEncode({ a: 1, b: null, c: undefined }).toString() === "a=1",
  "sending the literal string 'undefined' to Stripe is a 400 with a confusing message");
check("nested objects flatten", formEncode({ metadata: { account_id: "1" } }).toString() === "metadata%5Baccount_id%5D=1");

console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
