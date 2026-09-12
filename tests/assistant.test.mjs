// The assistant (TASK-126). Almost every assertion here is about ONE thing: a rep must not be
// able to ask about a colleague.
//
// Ivan, 2026-09-11: "if I am the super admin and Gabriel is a user, I can ask questions about my
// calls and his calls, but he can only ask questions about his. So make sure that the data access
// is controlled at the level of the little helper bot."
//
// The scoping is enforced when the CONTEXT IS BUILT, not by asking the model to be discreet. That
// distinction is the whole design: a prompt is a request, a WHERE clause is a boundary. These
// tests therefore inspect the SQL and its bindings, because that is where the guarantee lives.
import { buildContext, systemPrompt, MAX_CONTEXT_CALLS } from "../src/assistant.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const a = readFileSync(join(here, "..", "src", "assistant.js"), "utf8");
const idx = readFileSync(join(here, "..", "src", "index.js"), "utf8");
let pass = 0, fail = 0;
const check = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "  pass" : "  FAIL"}  ${n}${d && !c ? `  <- ${d}` : ""}`); };

// A DB stub that records exactly what was asked for.
function stubDb(rows = []) {
  const seen = [];
  return {
    seen,
    prepare(sql) {
      const rec = { sql, binds: [] };
      seen.push(rec);
      return { bind: (...b) => { rec.binds = b; return { all: async () => ({ results: rows }) }; } };
    },
  };
}
const CALL = {
  id: 7, client_name: "Someone", on_date: "2026-09-10", duration_min: 44, outcome: "closed",
  rep_email: "rep@x.com", call_type: "Sales call",
  diagnosis: "A strong call that stalled on price. Second sentence that should be dropped.",
  scorecard: JSON.stringify([["rapport", 8], ["close attempt", 4]]),
  moments: JSON.stringify([{ at: "00:12:58", label: "price raised" }]),
};

console.log("\nAssistant — the boundary");

{
  const db = stubDb([CALL]);
  await buildContext({ DB: db }, { user: { email: "rep@x.com", role: "member" }, view: "month", accountId: 1 });
  const q = db.seen[0];
  check("a MEMBER's query filters on their own rep_email",
    /c\.rep_email = \?/.test(q.sql) && q.binds.includes("rep@x.com"),
    q.sql.replace(/\s+/g, " ").slice(0, 200));
  check("...and the filter is in the SQL, not left to the prompt",
    /c\.rep_email = \?/.test(q.sql),
    "a prompt asking the model to be discreet is a request; a WHERE clause is a boundary");
}

{
  const db = stubDb([CALL]);
  await buildContext({ DB: db }, { user: { email: "boss@x.com", role: "admin" }, view: "month", accountId: 1 });
  check("an ADMIN's query has no rep filter", !/c\.rep_email = \?/.test(db.seen[0].sql));
}

{
  // A member with no email must match NOTHING, never everything.
  const db = stubDb([]);
  await buildContext({ DB: db }, { user: { role: "member" }, view: "month", accountId: 1 });
  check("a member with no email matches an impossible value, not every row",
    db.seen[0].binds.some(b => typeof b === "string" && /no such rep/.test(b)),
    JSON.stringify(db.seen[0].binds));
}

check("the code does NOT widen the query when a member has no calls",
  /does NOT do: fall back to "show everything"/.test(a),
  "widening on empty is how a scoping bug becomes a leak that only appears for new users");
check("the reason the boundary lives in SQL is recorded",
  /a prompt is a request; a WHERE clause is a boundary|A\s*\n?\/\/ > prompt saying/.test(a)
    || /WHERE clause is a boundary/.test(a));

console.log("\nAssistant — what the two roles are told");

{
  const admin = systemPrompt({ isAdmin: true, callCount: 40, scope: "every rep on this account", window: "month", truncated: false });
  const member = systemPrompt({ isAdmin: false, callCount: 12, scope: "only r@x.com's own calls", window: "month", truncated: false });
  check("a member is told to refuse questions about colleagues",
    /only has access to their own calls/.test(member) && /do not\s*\n?speculate/.test(member));
  check("an admin gets no such restriction", !/This reader is a REP/.test(admin));
  check("both are told the exact scope in words",
    /every rep on this account/.test(admin) && /only r@x\.com's own calls/.test(member),
    "the model should state its own limits accurately if asked");
  check("truncation is disclosed when it happens",
    /you can see the 60 most recent calls only/.test(
      systemPrompt({ isAdmin: true, callCount: 60, scope: "x", window: "all", truncated: true })));
  check("the model is told never to invent a call, score or quote",
    /Never invent a\s*\n?call, a score, a client or a quote/.test(member));
}

console.log("\nAssistant — the context pack");

{
  const db = stubDb([CALL]);
  const ctx = await buildContext({ DB: db }, { user: { email: "boss@x.com", role: "admin" }, view: "month", accountId: 1 });
  check("scores are included", /rapport 8/.test(ctx.text) && /close attempt 4/.test(ctx.text));
  check("timestamped moments are included", /00:12:58 price raised/.test(ctx.text));
  check("only the FIRST sentence of the diagnosis is sent",
    /stalled on price/.test(ctx.text) && !/Second sentence/.test(ctx.text),
    "sixty full diagnoses is most of the budget spent on prose the question may not need");
  check("an admin pack names the rep on each call", /rep: rep@x\.com/.test(ctx.text));

  const m = await buildContext({ DB: stubDb([CALL]) }, { user: { email: "rep@x.com", role: "member" }, view: "month", accountId: 1 });
  check("a member pack does NOT label rows by rep", !/rep: /.test(m.text),
    "there is only one rep in it, and naming them invites the model to compare");
}

check("the pack is capped, and the cap is a real number", MAX_CONTEXT_CALLS === 60);
check("full transcripts are never sent",
  !/c\.transcript/.test(a) && /never the debriefs themselves|COMPRESSED INDEX/.test(a),
  "136 calls of transcript is 8.5MB; the pack is an index, not the archive");

console.log("\nAssistant — arithmetic is done in SQL, not by the model");

// The first production run's analysis was good and its counting was wrong: it reported "13 of 30
// calls score 1 across the board" when the true figure is 4, and cited ids that were not among
// them. Same lesson as the timestamps: counting is what models are worst at and surest about.
{
  const db = stubDb([CALL]);
  const ctx = await buildContext({ DB: db }, { user: { email: "b@x.com", role: "admin" }, view: "month", accountId: 1 });
  check("a second query computes the dimension averages",
    db.seen.length >= 2 && /AVG\(json_extract\(j\.value,'\$\[1\]'\)\)/.test(db.seen[1].sql),
    "the model must not be asked to average 60 lines by eye");
  check("the aggregate query is scoped the SAME way as the index",
    db.seen[1].sql.includes("c.archived_at IS NULL") && db.seen[1].binds.length === db.seen[0].binds.length,
    "an unscoped aggregate would leak team averages to a member through the back door");
  check("the model is told to use the supplied numbers and not recount",
    /use THESE numbers, do not recount/.test(a) || /use THESE "\n\s*\+ "numbers/.test(a));
  check("...and the prompt says so too",
    /Do not recompute them by counting index lines/.test(a));
  check("a count it was not given must be refused, not guessed",
    /do not state a count you were\s*\n\s*not given/.test(a));
}

{
  // A member's aggregates must be their own, not the team's.
  const db = stubDb([CALL]);
  await buildContext({ DB: db }, { user: { email: "rep@x.com", role: "member" }, view: "month", accountId: 1 });
  check("a MEMBER's aggregate query is filtered to them as well",
    /c\.rep_email = \?/.test(db.seen[1].sql) && db.seen[1].binds.includes("rep@x.com"),
    "scoping the index but not the averages is the subtle version of the same leak");
}

console.log("\nAssistant — the routes");

// Deliberately NOT admin-only: a rep asking about their own calls is half the product.
check("/api/ask is NOT behind the admin gate",
  !/ADMIN_ONLY = \[[^\]]*\\\/api\\\/ask/.test(idx),
  "gating it would be the lazy way to be safe and would delete half the feature");
check("...and the reason is written down", /would have removed half the product/.test(idx));
check("the caller's own user object drives the scope, not a request parameter",
  /assistantAsk\(env, \{ user, account/.test(idx)
    && !/rep_email: (req|body|params)/.test(idx),
  "if the client could name the rep, the boundary would be client-side, which is no boundary");
check("a scope endpoint exists so the boundary can be inspected without paying for a model call",
  /path === "\/api\/ask\/scope"/.test(idx));
check("questions are length-capped", /String\(message\)\.slice\(0, 2000\)/.test(idx));
check("asks are logged with who asked and how much they could see",
  /kind: "assistant\.asked"/.test(idx) && /\$\{user\.role\}\) - \$\{r\.callCount\} calls in scope/.test(idx));

console.log("\nAssistant — rendering model output");

const app = readFileSync(join(here, "..", "public", "app.js"), "utf8");
check("model output is escaped before any markdown is applied",
  /return esc\(String\(t\)\)\s*\n?\s*\.replace/.test(app),
  "this text was produced by a model that just read a client's transcript");
check("...and only a tiny markdown subset is honoured",
  !/innerHTML = .*marked|markdown-it|DOMPurify/.test(app)
    && /a full markdown parser here would be a script-injection surface/.test(app));

console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
