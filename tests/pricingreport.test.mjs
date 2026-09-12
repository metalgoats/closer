// The hidden pricing report (TASK-128).
//
// The URL is the credential. There is no login on this route by design — Gabriel has none, and
// making him get one to read a document he asked for is friction standing in for security. That
// puts the whole burden on the token, so most of what follows is about the token: it must be
// long, it must be compared without leaking its contents through timing, and a wrong one must
// not reveal that a report exists at that path at all.
//
// The other half is arithmetic. The page ships a live calculator, and a calculator that disagrees
// with the table printed beneath it is worse than no calculator, because a reader will trust
// whichever one they saw last. So the constants in the page are evaluated here against the four
// published rows.
import { REPORT_TOKEN, tokenMatches, reportResponse } from "../src/pricingreport.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "pricingreport.js"), "utf8");
const idx = readFileSync(join(here, "..", "src", "index.js"), "utf8");
let pass = 0, fail = 0;
const check = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "  pass" : "  FAIL"}  ${n}${d && !c ? `  <- ${d}` : ""}`); };

console.log("\nThe token is the only thing protecting this page");

check("the token is 128 bits of hex, not a guessable slug",
  REPORT_TOKEN.length === 32 && /^[0-9a-f]{32}$/.test(REPORT_TOKEN),
  "a short or wordy token is walkable; this route has no other gate");

check("the right token matches", tokenMatches(REPORT_TOKEN));
check("a wrong token of the SAME LENGTH does not match",
  !tokenMatches("f".repeat(32)),
  "the length check must not be the only check");
check("a token differing in the last character only does not match",
  !tokenMatches(REPORT_TOKEN.slice(0, 31) + (REPORT_TOKEN.endsWith("0") ? "1" : "0")),
  "an early-exit compare would pass everything up to the final character");
check("a prefix of the real token does not match", !tokenMatches(REPORT_TOKEN.slice(0, 20)));
check("the real token plus a suffix does not match", !tokenMatches(REPORT_TOKEN + "aa"));
check("empty, null and undefined do not match",
  !tokenMatches("") && !tokenMatches(null) && !tokenMatches(undefined),
  "String(null) is 'null', which is a real string and must still be rejected");

// The comparison must look at every character every time. `===` on strings short-circuits at the
// first difference, which hands an attacker one character at a time.
check("the compare is constant time over the whole token",
  /diff \|=/.test(src) && /for \(let i = 0; i < expected\.length/.test(src)
    && !/given === expected|a === expected/.test(src),
  "an XOR-accumulate loop, not === and not an early return inside the loop");

console.log("\nThe route");

check("a correct token returns the page", (() => {
  const r = reportResponse("/r/" + REPORT_TOKEN);
  return r && r.status === 200 && /text\/html/.test(r.headers.get("Content-Type"));
})());

check("a trailing slash still works", !!reportResponse("/r/" + REPORT_TOKEN + "/"),
  "a link that survives a copy-paste with a slash on the end");

check("a wrong token returns null rather than a 403", (() => {
  const r = reportResponse("/r/deadbeefdeadbeefdeadbeefdeadbeef");
  return r === null;
})(), "null falls through to the SPA; a 403 would confirm that something exists at that path");

check("a bare /r/ returns null", reportResponse("/r/") === null);

// Everything that is not /api/ goes to env.ASSETS. A route registered below that line is dead
// code that returns the SPA and looks like a caching problem for an hour.
check("the route is wired ABOVE the static-assets fallthrough", (() => {
  const route = idx.indexOf('url.pathname.startsWith("/r/")');
  const assets = idx.indexOf("env.ASSETS.fetch(request)");
  return route !== -1 && assets !== -1 && route < assets;
})(), "below it, every request would be answered by the SPA instead");

check("the report is NOT behind requireUser", (() => {
  const route = idx.indexOf('url.pathname.startsWith("/r/")');
  const gate = idx.indexOf("await requireUser(request, env)");
  return route !== -1 && gate !== -1 && route < gate;
})(), "Gabriel has no login; a gate here makes the link useless");

console.log("\nIt must not be indexed, cached or leaked by referrer");

const res = reportResponse("/r/" + REPORT_TOKEN);
check("the noindex header is sent", /noindex/.test(res.headers.get("X-Robots-Tag") || ""),
  "for crawlers that read headers and never parse the document");
check("the noindex meta tag is in the document too",
  /<meta name="robots" content="noindex/.test(src),
  "for the ones that parse the document and ignore headers");
check("the page is not cached by shared caches",
  /private/.test(res.headers.get("Cache-Control") || "") && /no-store/.test(res.headers.get("Cache-Control") || ""));
check("the referrer is not passed to anything the reader clicks",
  (res.headers.get("Referrer-Policy") || "") === "no-referrer",
  "otherwise the secret URL travels in the Referer header of every outbound link");

console.log("\nThe live calculator must agree with the printed table");

// Pull the constants out of the shipped page rather than restating them here. Restating them
// would make this test pass while the page said something else, which is the whole failure mode.
const BASE = Number(/var BASE = (\d+)/.exec(src)[1]);
const INCLUDED = Number(/INCLUDED = (\d+)/.exec(src)[1]);
const ACTIVATION = Number(/ACTIVATION = (\d+)/.exec(src)[1]);
const monthly = (seats, rate = 297) => BASE + Math.max(0, seats - INCLUDED) * rate;
const yearOne = (seats, rate = 297) => ACTIVATION + monthly(seats, rate) * 12;

for (const [seats, mo, ps, y1] of [[3, 1497, 499, 21464], [6, 2388, 398, 32156], [10, 3576, 358, 46412], [20, 6546, 327, 82052]]) {
  check(`${seats} seats: the calculator produces the row printed under it`,
    monthly(seats) === mo && Math.round(monthly(seats) / seats) === ps && yearOne(seats) === y1,
    `expected ${mo}/${ps}/${y1}, got ${monthly(seats)}/${Math.round(monthly(seats) / seats)}/${yearOne(seats)}`);
  check(`${seats} seats: that row is actually on the page`, src.includes("$" + mo.toLocaleString("en-US")));
}

check("Nathan's headline figure is the one three methods agreed on",
  yearOne(6) === 32156 && src.includes("$32,156"),
  "the 04 Aug decision gave $31,084 and Gabriel's instinct $2-3k/mo; this is the third route");

check("the $397 list price is reachable and is not the default",
  /data-rate="397"/.test(src) && /var BASE = 1497, INCLUDED = 3, ACTIVATION = 3500, rate = 297/.test(src),
  "$297 is Nathan's reference-account rate; $397 is list from customer two");

console.log("\nThe comparison chart must not argue against its own numbers");

// Caught by rendering the page and looking at it. The bars were hand-set widths: Gong at 100%
// and us at 88% — while we cost $32,156 against Gong's $28,000. A chart drawn in our favour,
// in the one document whose case depends on not doing that.
check("bar widths are computed from the values, never hand-set",
  !/data-w=/.test(src) && /data-val=/.test(src) && /vals\[i\] \/ max/.test(src),
  "a hand-set width drifts the moment a number next to it changes");

check("every bar carries the figure it is drawn from", (() => {
  const rows = [...src.matchAll(/data-val="(\d+)"[^>]*><\/div><div class="bval"[^>]*>~?\$([\d,]+)/g)];
  return rows.length >= 4 && rows.every(([, val, label]) => Number(val) === Number(label.replace(/,/g, "")));
})(), "the width and the caption must come from one number, not two");

check("we are drawn ABOVE Gong, because we cost more than Gong", (() => {
  const vals = Object.fromEntries([...src.matchAll(/data-val="(\d+)"/g)].map((m, i) => [i, +m[1]]));
  const gong = vals[0], us = vals[1];
  return us > gong && yearOne(6) === us;
})(), "understating our own price is the exact dishonesty this report warns against");

check("the 'us' bar follows the calculator rather than freezing at six seats",
  /fill\.setAttribute\("data-val", String\(yearOne\)\)/.test(src) && /drawBars\(\)/.test(src),
  "a reader who drags to 20 seats must not see a bar still drawn for 6");

check("the chart says out loud that we sit above Gong",
  /We are <em>above<\/em> Gong on price and the chart says so/.test(src),
  "so nobody reads the taller bar as an error");

console.log("\nThe honest-version guards have to survive an edit");

check("the 100% admin-conversion figure is labelled as not shippable",
  /do not ship this/.test(src) && /Do not put the 100% number in a deck/.test(src),
  "$36k-47k is what the arithmetic says and it will not survive a buyer saying it out loud");
check("10% is the default conversion, not 100%",
  /conv = 0\.10/.test(src) && /data-conv="0\.10"[^>]*aria-pressed="true"/.test(src),
  "whichever is default is the number that gets screenshotted");
check("speed-to-lead is attributed to MIT/InsideSales and not to HBR",
  /MIT \/ InsideSales study \(Oldroyd, 2007\)/.test(src) && /not Harvard Business Review/.test(src),
  "Nathan is exactly the buyer who looks it up");
check("the 21x is explicitly scoped to inbound first contact",
  /first contact with an inbound lead, not post-call follow-up/.test(src),
  "our claim is a 3-minute follow-up draft, which the 21x does not support");

console.log("\nIt has to be readable on a phone and in daylight");

check("there is a viewport meta", /<meta name="viewport"[^>]*width=device-width/.test(src));
check("light mode is defined on a [data-theme] selector AND a media query",
  /:root\[data-theme="light"\]/.test(src) && /prefers-color-scheme: light/.test(src),
  "the media query alone means the manual toggle cannot win in both directions");
check("no colour has its only definition inside the media query", (() => {
  const media = /@media \(prefers-color-scheme: light\)\{([\s\S]*?)\n\}/.exec(src);
  if (!media) return false;
  const vars = [...media[1].matchAll(/(--[a-z0-9-]+):/g)].map(m => m[1]);
  const base = /^:root\{([\s\S]*?)\n\}/m.exec(src);
  return vars.length > 0 && vars.every(v => base[1].includes(v + ":"));
})(), "a token defined only in dark mode renders as nothing in the other one");
check("wide content scrolls inside its own container", (() => {
  const wraps = (src.match(/class="tablewrap"/g) || []).length;
  return /\.tablewrap\{[^}]*overflow-x:auto/.test(src) && wraps >= 2;
})(), "otherwise the table sets the page width and the body scrolls sideways on a phone");
check("motion is disabled for anyone who asked for that",
  /prefers-reduced-motion: reduce/.test(src));
check("the section nav collapses rather than overflowing the bar",
  /@media \(max-width:720px\)\{ \.bar-nav\{ display:none/.test(src));

console.log("\nNo dead controls");

// Every id the script reaches for must exist in the markup, or the page silently half-works.
const ids = [...src.matchAll(/\$\("([a-zA-Z0-9]+)"\)/g)].map(m => m[1]);
const missing = [...new Set(ids)].filter(id => !new RegExp(`id="${id}"`).test(src));
check("every element the script touches exists in the markup", missing.length === 0,
  `missing: ${missing.join(", ")}`);
check("the check above is not vacuous", ids.length >= 10, "no ids scanned means it proves nothing");

const anchors = [...src.matchAll(/<a href="#([a-z]+)"/g)].map(m => m[1]);
const deadAnchors = anchors.filter(a => !new RegExp(`id="${a}"`).test(src));
check("every nav link points at a section that exists", deadAnchors.length === 0,
  `dead: ${deadAnchors.join(", ")}`);
check("the anchor check is not vacuous", anchors.length >= 5);

console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
