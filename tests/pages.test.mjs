// The proposal and onboarding pages (TASK-131). Two audiences read these: a customer, and the
// internet if the link ever leaks. So the assertions are mostly about what must NOT be on them.
import { pitchHtml, pitchResponse, PITCH_TOKEN, OFFER } from "../src/pitch.js";
import { snapshotHtml, snapshotResponse, SNAPSHOT_TOKEN, SNAPSHOT_OFFER } from "../src/pitch_snapshot.js";
import { onboardHtml, onboardResponse, ONBOARD_TOKEN, sanitizeIntake, INTAKE_FIELDS, INTAKE_MAX_BYTES } from "../src/onboard.js";
import { REPORT_TOKEN } from "../src/pricingreport.js";
import { PAGE_CSS } from "../src/pagekit.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const idx = readFileSync(join(here, "..", "src", "index.js"), "utf8");
const app = readFileSync(join(here, "..", "public", "app.js"), "utf8");
let pass = 0, fail = 0;
const check = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "  pass" : "  FAIL"}  ${n}${d && !c ? `  <- ${d}` : ""}`); };

const pitch = pitchHtml({ ...OFFER, onboardingPath: "/r/x" });
const onboard = onboardHtml();

console.log("\nPages — three tokens, three doors");
check("the four page tokens are distinct 128-bit hex", new Set([PITCH_TOKEN, ONBOARD_TOKEN, REPORT_TOKEN, SNAPSHOT_TOKEN]).size === 4
  && [PITCH_TOKEN, ONBOARD_TOKEN, SNAPSHOT_TOKEN].every(t => /^[0-9a-f]{32}$/.test(t)));
check("a wrong token yields nothing, not a 404 page", pitchResponse("/r/" + "0".repeat(32)) === null && onboardResponse("/r/nope") === null);
{
  const r = pitchResponse("/r/" + PITCH_TOKEN);
  check("the right token serves HTML with noindex and no-store", r && r.headers.get("X-Robots-Tag").includes("noindex") && /no-store/.test(r.headers.get("Cache-Control")));
}
check("the dispatcher tries all four pages",
  /reportResponse\(url\.pathname\)\s*\|\| pitchResponse\(url\.pathname, \{ onboardingPath \}\)\s*\|\| snapshotResponse\(url\.pathname\)\s*\|\| onboardResponse\(/.test(idx));

console.log("\nPages — nothing internal reaches the customer");
// Every phrase here has appeared in an internal document about this product.
const LEAKS = [/\$8\.41/, /85 ?KB/, /11\.9 ?MB/, /gross margin/i, /\b9[0-9]% margin/i, /vibecode/i, /Gabriel/, /Ivan/, /Sonny/, /Vera is a WHERE clause/,
  /Gong\b/, /Chorus/, /Fireflies/, /derikgab|onscreenauthority|domthehypnotist/, /\$3,500|\$1,497|\$297 per seat|\$397/, /TASK-\d+/, /activation fee is (a wage|funding)/i,
  /only technician/i, /costs us nothing/i, /API key(s)? (we|that we) (hold|already)/i, /fathom\.video\/share/];
for (const html of [["proposal", pitch], ["onboarding", onboard]]) {
  const hits = LEAKS.filter(re => re.test(html[1])).map(String);
  check(`${html[0]}: no internal figure, name or document leaks`, hits.length === 0, hits.join(" "));
}
check("the proposal never claims the CRM note is pushed into the CRM (it is pasted)", !/push(es|ed)? (the )?(CRM )?note/i.test(pitch) && /ready to paste/.test(pitch));
check("...and the in-app release note no longer claims it either", !/CRM notes push/.test(app) && /ready to paste/.test(app));
check("the proposal does not promise the weekly email, which has no sender configured", !/weekly (email|report)/i.test(pitch));

console.log("\nPages — the commercial terms live in ONE place (14 Sep terms)");
check("price, seats and links come from the OFFER constant", pitch.includes("$1,997") && pitch.includes("$197") && /3 closers and 1 administrator/.test(pitch)
  && /export const OFFER = Object\.freeze/.test(readFileSync(join(here, "..", "src", "pitch.js"), "utf8")));
check("the first 30 days are included in activation and the monthly begins on day 31; no 'trial' anywhere",
  OFFER.includedDays === 30 && /first 30 days are included/.test(pitch) && /begins on day 31/.test(pitch) && !/trial/i.test(pitch) && !("trialDays" in OFFER));
check("$47 per additional seat, closer OR administrator, same price", OFFER.extraSeat === 47 && /\$47 per month for each additional seat<\/strong>, closer or administrator, same price/.test(pitch));
check("the offer is the Founding Partner Deployment for the customer's business", /Founding Partner Deployment for On Screen Authority/.test(pitch) && OFFER.business === "On Screen Authority");
check("the 'why the pricing is different right now' block and the guarantee are on the page",
  /Why the pricing is different right now/.test(pitch) && /30-Day CloserAI Deployment Guarantee/.test(pitch) && /book onboarding within 72 hours/.test(pitch) && /80% of eligible sales calls/.test(pitch));
check("...and the guarantee says what it is not", /not a guarantee of sales, revenue or close rate/.test(pitch));
check("the payment button is live and opens in a new tab", /href="https:\/\/collectcheckout\.com\/r\/[a-z0-9]+" target="_blank" rel="noopener">Start CloserAI/.test(pitch));
check("NO onboarding link and NO booking button on the proposal (Gabriel sends onboarding after payment)",
  !/calendly\.com/.test(pitch) && !/Book the 30-minute setup call/.test(pitch) && !/onboarding page/.test(pitch) && OFFER.bookUrl === null && OFFER.onboardingPath === null);
check("no monetary value is ever put on the hours", !/\$[0-9,]+ (of|in) (selling|revenue)/i.test(pitch) && !/per hour/i.test(pitch) && !/economics/i.test(pitch));

console.log("\nPages — what Gabriel asked for is on them");
for (const [what, re, where] of [
  ["rep scorecard per call", /scorecard for the call/i, pitch],
  ["patterns across all their calls", /across every call they have taken/i, pitch],
  ["text + email drafted from the transcript", /A text and an email drafted/i, pitch],
  ["CRM note ready after every call", /CRM note, done/i, pitch],
  ["1-2h/day admin framed as an estimate, not a promise", /Estimates, from your inputs/i, pitch],
  ["team page + per-person trend", /whole team on one page/i, pitch],
  ["timestamps into the recording for training", /timestamped and linked straight into the recording/i, pitch],
  ["AI suggests training moments (Vera)", /Which three moments should I bring to training/i, pitch],
  ["Gabriel's problem line", /The sales floor is about to scale faster than manual call review can\./, pitch],
  ["Today / With CloserAI, one dashboard, training starts with the moment", /class="bh">Today</.test(pitch) && /from one dashboard/.test(pitch) && /Training starts with the moment, not the search for it/.test(pitch), pitch],
  ["manager-adjustable rubric/prompt", /rubric you write/i, pitch],
  ["setter and closer attribution", /setter who booked it comes across from your CRM/i, pitch],
  ["interactive hours calculator (the original, simple one)", /id="inClosers"/.test(pitch) && /Estimates, from your inputs\./.test(pitch), pitch],
  ["the text rail is back, and it has no line of its own", /class="rail"/.test(pitch) && /class="rail"/.test(onboard) && !/class="line"|class="fill"/.test(pitch) && /id="prog"/.test(pitch), pitch],
  ["four steps, and no DELIVERY day counts (Gabriel, 13 Sep); the agreement's 30 days and 72 hours are allowed (14 Sep)", /<h2>Four steps<\/h2>/.test(pitch) && !/seven days|\bDay [0-7]\b|live in \w+ days/i.test(pitch), pitch],
  ["onboarding: Fathom key on the call, never emailed", /never sent to us/i, onboard],
  ["onboarding: GHL admin login + Location ID", /administrator login to your GoHighLevel/i, onboard],
  ["onboarding: who books the calls (setter workflow)", /Who books your calls/i, onboard],
  ["onboarding: tags and pipeline", /tags and pipeline/i, onboard],
  ["onboarding: emails for every seat", /Name, email and role[^.]*for every seat/i, onboard],
  ["onboarding: the intake form posts to /api/intake", /fetch\("\/api\/intake"/, onboard],
  ["onboarding: the reps script is gone (Gabriel, 13 Sep)", !/Two sentences that work|your own game/i.test(onboard), onboard],
  ["onboarding: booking + payment placeholders", /booking link|Book the setup call/.test(onboard) && /Pay the activation/.test(onboard), onboard],
]) check(what, re instanceof RegExp ? re.test(where) : !!re);

// What Gabriel asked to remove on the 13 Sep call stays removed. Each of these was a real line
// on a page Nathan reads; inverting them means the old copy cannot come back without a red test.
console.log("\nPages — what Gabriel asked to remove on 13 Sep stays removed");
check("no 'Will my reps feel watched' on either page, so we do not plant the fear ourselves", !/feel watched/i.test(pitch) && !/feel watched/i.test(onboard));
check("no 'held hostage'; the line is 'your data is your own'", !/held hostage/i.test(pitch) && /Your data is your own/.test(pitch));
check("no delivery-timeline promises on either page (contract periods like '30 days' and '72 hours' are terms, not promises)",
  !/\bDay [0-7]\b|seven days|day three|after day 7|day-two|live in \w+ days/i.test(pitch) && !/\bDay [0-7]\b|seven days|day three|after day 7|day-two|live in \w+ days/i.test(onboard));
check("the product is CloserAI on both pages, and the button is spelled that way", /Start CloserAI/.test(pitch) && /CloserAI/.test(onboard) && !/>Closer</.test(pitch));
check("checkout opens in a new tab on both pages", /target="_blank" rel="noopener">Start CloserAI/.test(pitch) && /target="_blank" rel="noopener">Pay the activation/.test(onboardHtml({ payUrl: OFFER.payUrl, bookUrl: OFFER.bookUrl })));
check("cost FAQ names any frontier model and the measured per-call range, never a monthly guess", /any frontier model with API access/i.test(pitch) && /between fifty cents and a dollar a call/.test(pitch) && !/tens of dollars a month/i.test(pitch));

console.log("\nPages — the 13 September snapshot, frozen for comparison");
{
  const snap = snapshotHtml(SNAPSHOT_OFFER);
  const r = snapshotResponse("/r/" + SNAPSHOT_TOKEN);
  check("the snapshot is served at its own token with the same headers", r && r.headers.get("X-Robots-Tag").includes("noindex"));
  check("it is labelled as the reference copy, not the live proposal", /Reference copy/.test(snap) && /13 September version/.test(snap));
  check("it carries no live payment or booking button", SNAPSHOT_OFFER.payUrl === null && SNAPSHOT_OFFER.bookUrl === null && !/collectcheckout|calendly/.test(snap));
  check("it still passes the leak guard", LEAKS.filter(re => re.test(snap)).length === 0, LEAKS.filter(re => re.test(snap)).map(String).join(" "));
  check("the live page and the snapshot differ where they should", /Three steps/.test(snap) && /Four steps/.test(pitch));
}

console.log("\nIntake — the public endpoint is defended");
check("the POST is above requireUser and checks the token in constant time", idx.indexOf('path === "/api/intake" && method === "POST"') < idx.indexOf("const user = await requireUser(request, env);")
  && /tokenMatches\(b\.token, ONBOARD_TOKEN\)/.test(idx));
check("the body is capped before it is parsed", /raw\.length > INTAKE_MAX_BYTES/.test(idx) && INTAKE_MAX_BYTES <= 50_000);
check("unknown fields are dropped, known ones are capped", (() => { const o = sanitizeIntake({ company: "X", api_key: "sk-secret", closers: "a".repeat(5000) }); return !("api_key" in o) && o.closers.length === 4000 && o.company === "X"; })());
check("the form declares no key field, and the sanitiser has none to keep", !INTAKE_FIELDS.some(f => /key|token|secret|password/i.test(f)) && !/name="(api_key|fathom_key|claude_key|ghl_token)"/.test(onboard));
check("the admin GET refuses a member", /path === "\/api\/intake" && method === "GET"[\s\S]{0,120}user\.role !== "admin"/.test(idx));
check("an admin can remove a single form, and it is logged", idx.includes('path.match(/^\\/api\\/intake\\/(\\d+)$/)') && /DELETE FROM intake WHERE id = \?/.test(idx) && /kind: "intake\.removed"/.test(idx)
  && /inDel && method === "DELETE"[\s\S]{0,80}user\.role !== "admin"/.test(idx));
check("the IP is stored as a hint, never whole", /replace\(\/\\\.\\d\+\$\/, "\.x"\)/.test(idx));

console.log("\nPages — adaptive and honest to the eye");
check("light palette defined on :root, dark tokens never their only definition", /:root\[data-theme="light"\]\{/.test(PAGE_CSS) && /@media \(prefers-color-scheme: light\)/.test(PAGE_CSS));
check("no id is used twice on the proposal (the calculator once read a SECTION and showed NaN)",
  (() => { const ids = [...pitch.matchAll(/ id="([^"]+)"/g)].map(m => m[1]); return new Set(ids).size === ids.length; })(),
  "getElementById returns the first match, silently");
check("the browser scrollbar is hidden on these pages, scrolling is not", /html\{ scrollbar-width:none;/.test(PAGE_CSS) && /html::-webkit-scrollbar\{ width:0; height:0; display:none; \}/.test(PAGE_CSS) && !/overflow:\s*hidden;?\s*\}/.test(PAGE_CSS.split("html{")[1].split("}")[0]));
check("the rail is words only: no .line or .fill rule, and it hides where there is no room", /\.rail a\.on\{/.test(PAGE_CSS) && !/\.rail \.line|\.rail \.fill/.test(PAGE_CSS) && /@media \(max-width:1100px\)\{ \.rail\{ display:none; \} \}/.test(PAGE_CSS));
check("reduced motion is respected page-wide", /prefers-reduced-motion: reduce\)\{ html\{scroll-behavior:auto;\}/.test(PAGE_CSS));
check("no horizontal scroll: body clips x and grids collapse on phones", /overflow-x:hidden/.test(PAGE_CSS) && /@media \(max-width:640px\)\{ \.grid2, \.grid3\{ grid-template-columns:1fr; \} \}/.test(PAGE_CSS));

console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
