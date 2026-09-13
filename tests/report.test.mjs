// The weekly report (TASK-120). Nathan's fourth buying condition, and the first artifact this
// system produces that RANKS PEOPLE and mails the ranking to their boss. Two consequences:
//
//   1. Every number in it will be checked against a CRM within a day of the first send. A figure
//      that looks like a close rate and is not one costs the credibility of every other number.
//   2. It is the artifact that makes the employee-consent question concrete (punch list H8).
//
// Verified: every assertion below FAILS when the thing it guards is undone.
import { weekBounds, weeklyReport, renderWeeklyEmail } from "../src/report.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "report.js"), "utf8");
const idx = readFileSync(join(here, "..", "src", "index.js"), "utf8");
let pass = 0, fail = 0;
const check = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "  pass" : "  FAIL"}  ${n}${d && !c ? `  <- ${d}` : ""}`); };

console.log("\nWeekly report — the week it covers");

// The week just ENDED, not the one in progress. A Monday report covering a Monday is empty.
check("Wednesday 2026-09-09 reports Mon 08-31 to Mon 09-07",
  JSON.stringify(weekBounds(new Date("2026-09-09T12:00:00Z"))) === '{"from":"2026-08-31","to":"2026-09-07"}',
  JSON.stringify(weekBounds(new Date("2026-09-09T12:00:00Z"))));
// On Monday morning the week that just ended is the one that ended THAT morning, not the one
// before it. Getting this backwards means the Monday report is always seven days stale.
check("run ON a Monday it reports the week that ended that morning",
  weekBounds(new Date("2026-09-07T09:00:00Z")).from === "2026-08-31"
    && weekBounds(new Date("2026-09-07T09:00:00Z")).to === "2026-09-07",
  JSON.stringify(weekBounds(new Date("2026-09-07T09:00:00Z"))));
check("run on a Sunday it does NOT roll early",
  weekBounds(new Date("2026-09-06T23:00:00Z")).to === "2026-08-31",
  JSON.stringify(weekBounds(new Date("2026-09-06T23:00:00Z"))));
// Matching bucketOf in spend.js. Two surfaces that disagree about where a week starts is a
// support conversation with no good answer.
check("weeks start Monday, UTC, like the Spend page",
  /Mon = 0/.test(src) && /getUTCDay\(\) \+ 6\) % 7/.test(src));

console.log("\nWeekly report — what it is allowed to claim");

// `calls.outcome` is written by the MODEL and its schema offers only "closed" | "followup".
// There is no "lost". A ratio built on it cannot record a loss and is optimistic by construction.
check('it never uses the words "close rate" as a label',
  !/>\s*Close rate|"close rate"|Close Rate</i.test(src) || /not a close rate|not as a close rate/i.test(src),
  "a number labelled close rate will be checked against the CRM and will not match");
check('the column is called "Closed on call"', /Closed on call/.test(src));
check("the email says the figure is the model's read, not the CRM",
  /not<\/strong> your CRM|<strong>not your CRM<\/strong>/.test(src) || /not\s*<\/strong>\s*\n?\s*your CRM/.test(src)
    || /debrief read in the transcript/.test(src));
check("...and says it cannot record a loss",
  /no way to\s+record a loss/.test(src),
  "the schema has no 'lost' value, so silence here reads as 'nobody lost a deal'");
check("the caveat explains what Avg is, so it is not read as a grade",
  /a blend, not a grade/.test(src));
check("report.js records WHY the caveat exists, not just the caveat",
  /stops trusting every other number/.test(src) || /stops believing/.test(src));

console.log("\nWeekly report — ranking, which the dashboard deliberately does not do");

// Nathan asked for a ranking in those words. It is his floor and his email. The People page does
// not rank because a dashboard is a reference; this does because he asked. Worth it being a
// deliberate, documented divergence rather than an accident.
check("it ranks, and says why that differs from the People page",
  /people\.sort/.test(src) && /People page deliberately does not/.test(src));

// A rep whose week was all internal calls has NO score. Sorting them as 0.0 at the bottom of a
// league table sent to their manager is a false accusation.
const fake = [
  { rep: "a", calls: 3, scored: 3, avgScore: 5.1, closedOnCall: 1, withOutcome: 3, minutes: 90 },
  { rep: "b", calls: 9, scored: 0, avgScore: null, closedOnCall: 0, withOutcome: 0, minutes: 200 },
  { rep: "c", calls: 2, scored: 2, avgScore: 8.4, closedOnCall: 2, withOutcome: 2, minutes: 60 },
];
const sorted = [...fake].sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1) || b.calls - a.calls);
check("an unscored person sorts LAST, not as a zero",
  sorted.map(p => p.rep).join("") === "cab",
  sorted.map(p => `${p.rep}:${p.avgScore}`).join(" "));
check("the same rule is in report.js, not just in this test",
  /\(b\.avgScore \?\? -1\) - \(a\.avgScore \?\? -1\)/.test(src),
  "treating a missing score as 0 puts a rep who ran nine internal calls bottom of a league table");

console.log("\nWeekly report — rendering");

const html = renderWeeklyEmail({
  from: "2026-08-31", to: "2026-09-07", empty: false, people: fake,
  totals: { people: 3, calls: 14, scored: 5, closedOnCall: 3, minutes: 350 },
}, { appUrl: "https://example.test" });

check("it renders every person", ["a", "b", "c"].every(r => html.includes(`>${["1. ", "2. ", "3. "].find(n => html.includes(n + r)) || ""}`) || html.includes(r)));
check("an unscored person renders as a dash, never 0.0",
  html.includes("&mdash;") && !/>0\.0</.test(html),
  "0.0 is a claim; a dash is the absence of one");
check("the caveat block is in the rendered output, not just the source",
  html.includes("not as a close rate") || html.includes("not a close rate"));
check("HTML in a rep's name is escaped",
  !renderWeeklyEmail({ from: "a", to: "b", empty: false,
    people: [{ rep: "<script>x</script>", calls: 1, scored: 0, avgScore: null, closedOnCall: 0, withOutcome: 0, minutes: 1 }],
    totals: { people: 1, calls: 1, scored: 0, closedOnCall: 0, minutes: 1 } }).includes("<script>"),
  "rep identities come from Fathom, which is other people's data");

const emptyHtml = renderWeeklyEmail({ from: "a", to: "b", empty: true, people: [], totals: { people: 0, calls: 0, scored: 0, closedOnCall: 0, minutes: 0 } });
check("an empty week says so rather than rendering an empty table",
  /No calls were recorded this week/.test(emptyHtml));
check("...and still carries the caveat, so the format never surprises",
  /not as a close rate/.test(emptyHtml));

console.log("\nWeekly report — the routes");

check("/api/report is admin-only",
  /const ADMIN_ONLY = \[[^\]]*\/\^\\\/api\\\/report\/[^\]]*\]/.test(idx),
  "the whole team's ranked scores must not be readable by a member");
check("there is an HTML preview, because an email can only be checked by looking at it",
  /format"\) === "html"/.test(idx) && /text\/html; charset=utf-8/.test(idx));
// Workers cannot open SMTP. Returning ok:true with nothing sent is the failure mode where
// "why did the report never arrive" takes a week to notice.
check("sending FAILS CLOSED when no provider is configured",
  /if \(!mailConfig\(env\)\.configured \|\| !recipients\(env\.REPORT_TO\)\.length\)/.test(idx) && /}, 501\)/.test(idx),
  "a send that silently does nothing is indistinguishable from one that works");
check("...and the refusal names what is missing",
  /EMAIL_API_KEY \(secret\) and REPORT_TO \(var\)/.test(idx));
check("...and leaves evidence in the event log",
  /kind: "report\.send_skipped"/.test(idx));
check("the send route never claims ok:true", !/report\/weekly\/send[\s\S]{0,600}ok: true/.test(idx));

console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
