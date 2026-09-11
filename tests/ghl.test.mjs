// GoHighLevel via Private Integration Token (TASK-019).
//
// Context worth keeping: TASK-018 sat blocked for EIGHT WEEKS on registering a marketplace app
// that GoHighLevel's own docs say is not required. A Private Integration Token needs no developer
// account, no review and — the part it was actually waiting on — no product name.
//
// Verified live: a save-then-test against a fake token reached services.leadconnectorhq.com and
// came back 401, which proves the base URL, the headers and the auth mechanism are right. What is
// still UNVERIFIED is the success path, because no valid token exists yet. Tests below pin the
// request shape and the failure handling; the shape of a 200 response is marked as an assumption.
import { GHL_BASE, GHL_VERSION, ghlHeaders, explainGhlFailure, testGhl } from "../src/ghl.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ghl = readFileSync(join(here, "..", "src", "ghl.js"), "utf8");
const idx = readFileSync(join(here, "..", "src", "index.js"), "utf8");
const app = readFileSync(join(here, "..", "public", "app.js"), "utf8");
const css = readFileSync(join(here, "..", "public", "styles.css"), "utf8");
let pass = 0, fail = 0;
const check = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "  pass" : "  FAIL"}  ${n}${d && !c ? `  <- ${d}` : ""}`); };

console.log("\nGoHighLevel — the request shape");

check("the base URL is the v2 services host", GHL_BASE === "https://services.leadconnectorhq.com");
// GHL versions by HEADER, not by URL path. Omitting it is a 4xx with an unhelpful message.
check("a Version header is sent", ghlHeaders("t").Version === GHL_VERSION && GHL_VERSION === "2021-07-28",
  "GoHighLevel versions its API by request header; without it every call fails");
check("the token is a bearer token", ghlHeaders("pit_x").Authorization === "Bearer pit_x");
check("JSON is asked for and sent", ghlHeaders("t").Accept === "application/json"
  && ghlHeaders("t")["Content-Type"] === "application/json");

console.log("\nGoHighLevel — failures, which are the only paths a wrong token can take");

check("no token is refused before any request",
  (await testGhl("", "loc_1")).ok === false);
check("a missing Location ID is refused with the reason",
  /the token alone does not say which sub-account/.test((await testGhl("tok", "")).message),
  "the token does not identify a sub-account, and this is the likeliest setup mistake");
check("401 explains what to check", /copied in full/.test(explainGhlFailure(401, "x")));
check("403 names the fix AND quotes HighLevel",
  /tick the scopes/i.test(explainGhlFailure(403, "missing scope"))
    && /HighLevel said: missing scope/.test(explainGhlFailure(403, "missing scope")));
check("404 points at the most likely cause",
  /Location ID probably belongs to a different sub-account/.test(explainGhlFailure(404, "x")));
check("429 is named as rate limiting", /Rate limited/.test(explainGhlFailure(429, "x")));
// The integration is unverified against a live success. A wrong assumption of ours must read as
// "HighLevel said X" rather than as a confident sentence we invented.
check("an unrecognised status falls through to GoHighLevel's own words",
  explainGhlFailure(500, "HighLevel is having a moment") === "HighLevel is having a moment",
  "inventing an explanation for a status we have never seen is how a wrong guess reads as fact");
check("the file records that it is unverified against a live account",
  /NOTHING IN THIS FILE HAS BEEN RUN AGAINST A REAL GOHIGHLEVEL ACCOUNT/.test(ghl));
check("network failure is distinguished from an API failure",
  /Could not reach GoHighLevel/.test(ghl),
  "a DNS failure and a rejected token need different fixes and must not read the same");

console.log("\nGoHighLevel — the test probe");

// GET /locations/{id} validates token AND location together, and returns the business name.
check("the probe is read-only", /ghlFetch\(token, `\/locations\/\$\{encodeURIComponent\(locationId\)\}`\)/.test(ghl),
  "a connection test must never write anything to a customer's CRM");
check("the location id is URL-encoded", /encodeURIComponent\(locationId\)/.test(ghl));
check("success reports WHICH account it connected to",
  /Connected to \$\{name\}/.test(ghl),
  '"OK" does not tell you whether you connected the right sub-account');

console.log("\nGoHighLevel — where it is wired in");

check("the Location ID is stored in config_json, not the secret store",
  /cfg\.location_id = body\.location_id\.trim\(\)/.test(idx)
    && /a value you\s*\n?\s*\/\/ must read back is not a secret/.test(idx),
  "it has to be read back to build every request URL, so it is not a secret");
check("/config is a real route", /const intCfgMatch = path\.match\(\/\^\\\/api\\\/integrations\\\/\(\\d\+\)\\\/config\$\/\)/.test(idx));
check("the integrations list returns config_json so the UI can show it",
  /i\.config_json/.test(idx));
check("a GHL test updates status from the RESULT, not from the key existing",
  /UPDATE integrations SET status = \? WHERE id = \?"\)\s*\n?\s*\.bind\(r\.ok \? "connected" : "disconnected", id\)/.test(idx));
check("the test is logged with its outcome", /detail: `ghl · \$\{r\.ok \?/.test(idx));

console.log("\nIntegrations page — the three states, and why there are three");

// The first version showed "Connected" whenever a credential existed, so a row whose last test
// returned 401 still read as connected. A page claiming a working connection that does not work
// is the exact failure this codebase keeps designing against.
check("a saved-but-unverified credential does NOT say Connected",
  /Saved, not verified/.test(app) && /const verified = i\.status === "connected";/.test(app),
  "a token existing and a token working are different facts");
check("...and that state is styled distinctly from both connected and absent",
  /\.ig-state\.ig-unver/.test(css) && /ig-state ig-unver/.test(app));
check("...and the reason is recorded in the source",
  /a page\s*\n?\s*\/\/ claiming a working connection that does not work/.test(app));
check("no credential exists -> Not connected", /Not connected<\/span>/.test(app));

console.log("\nIntegrations page — the rebuild");

check("integrations render as rows, not always-open cards",
  /class="ig-row/.test(app) && !/class="integration-card/.test(app));
check("a collapsed row shows state and an expanded row shows controls",
  /A COLLAPSED row shows state; an EXPANDED row shows\s*\n?\s*controls/.test(css));
check("only one row opens at a time",
  /state\.openIntegration = state\.openIntegration === id \? null : id;/.test(app),
  "two open panels turns the list back into the wall it replaced");
check("each integration carries its own where-do-I-find-this steps",
  /Where do I find this\?/.test(app) && /Settings → Private Integrations → Create new integration\./.test(app),
  "instructions at the point of use; the old prose block at the page bottom went stale for 8 weeks");
// Comments stripped: the file legitimately EXPLAINS why the marketplace text was removed, and
// matching our own explanation would keep this red for the wrong reason. Checking what a user
// can read is also the stronger test. (Third time this exact care has been needed in this repo.)
{
  const noComments = app.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the stale OAuth/marketplace prose is gone from what a user can read",
    !/marketplace app/i.test(noComments) && !/Login \(OAuth\)/.test(noComments),
    "it described GoHighLevel as needing a registration that was never required");
  check("...and the page no longer claims GHL is a Connect-with-login button",
    !/data-connect-ghl/.test(noComments),
    "that button showed a toast saying the marketplace app was needed first");
}
check("the test result lands in the panel, not in a toast",
  /class="ig-result"/.test(app) && /is-ok|is-bad/.test(app),
  "the one sentence explaining a failed connection must not vanish after 3 seconds");
check("the page calls routes that exist",
  /api\.put\(`\/integrations\/\$\{id\}`, \{ secret_value:/.test(app)
    && /api\.del\(`\/integrations\/\$\{id\}`\)/.test(app),
  "an earlier draft invented POST /integrations/:id/key, which would have failed on the page's main action");
check("dead CSS from the old page was removed, not left behind",
  !/\.integration-card|\.key-row|\.label-hint|\.key-state/.test(css),
  "this project already has a trap logged about every feature leaving its own permanent strip");

console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
