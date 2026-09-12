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
import { buildContext, systemPrompt, greeting, starters, ASSISTANT_NAME, HISTORY_TURNS, MIN_PATTERN_CALLS, MAX_CONTEXT_CALLS } from "../src/assistant.js";
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
  const flat = t => String(t).replace(/\s+/g, " ");
  check("a member is told to refuse questions about colleagues",
    /only have access to their own calls/.test(flat(member))
      && /do not speculate about anyone else's numbers/.test(flat(member)));
  check("an admin gets no such restriction", !/This reader is a REP/.test(admin));
  check("both are told the exact scope in words",
    /every rep on this account/.test(admin) && /only r@x\.com's own calls/.test(member),
    "the model should state its own limits accurately if asked");
  check("truncation is disclosed when it happens",
    /You can see the 60 most recent calls only/.test(
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
const css = readFileSync(join(here, "..", "public", "styles.css"), "utf8");
check("model output is escaped before any markdown is applied",
  /return esc\(String\(t\)\)\s*\n?\s*\.replace/.test(app),
  "this text was produced by a model that just read a client's transcript");
check("...and only a tiny markdown subset is honoured",
  !/innerHTML = .*marked|markdown-it|DOMPurify/.test(app)
    && /a full markdown parser here would be a script-injection surface/.test(app));

console.log("\nVera — a personality that cannot overrule the arithmetic (TASK-128)");

{
  const flat = t => String(t).replace(/\s+/g, " ");
  const m = systemPrompt({ isAdmin: false, callCount: 12, scope: "only r@x.com's own calls", window: "month", truncated: false });

  // THE ORDER IS THE GUARANTEE. A model told to be warm gets agreeable, and an agreeable model
  // softens a bad number. The accuracy block is placed above the voice block and says in words
  // that it wins; if a future edit moves the voice first, that ranking is gone and nothing else
  // in the file would notice.
  check("the rules that do not bend are stated BEFORE the voice",
    m.indexOf("THE RULES THAT DO NOT BEND") < m.indexOf("HOW YOU TALK"),
    "voice above accuracy is how a coaching tool starts flattering");
  check("...and accuracy is declared the winner when they conflict",
    /accuracy wins and it is not close/.test(flat(m)));
  check("a bad number must still be said plainly",
    /a coach who flatters is worth nothing/.test(flat(m)));

  // The guard that matters most for a tool that scores employees.
  check("she is told to judge the behaviour, not the person",
    /COMMENT ON WHAT PEOPLE DID, NOT ON WHO THEY ARE/.test(m)
      && /a person you have never met/.test(flat(m)),
    "a warm model will drift from 'you moved to price early' to 'you seem underconfident'");

  check("the sycophancy openers are banned by name",
    /No "Great question"/.test(m) && /No emoji/.test(m));
  check("she is told to be short, and told why",
    /Warmth is not word count/.test(flat(m)));
  check("she is allowed an opinion", /Have an opinion and own it/.test(flat(m)));

  // Personality without memory reads as a bad personality, not a short one.
  check("she carries more than three exchanges", HISTORY_TURNS >= 10);
  check("...and the slice actually uses the constant",
    /history\.slice\(-HISTORY_TURNS\)/.test(a),
    "a hardcoded -6 next to a HISTORY_TURNS of 12 is a lie in the source");

  check("she has a name and it reaches the prompt", ASSISTANT_NAME.length > 0
    && new RegExp(`You are ${ASSISTANT_NAME}`).test(systemPrompt({ isAdmin: true, callCount: 1, scope: "x", window: "month", name: ASSISTANT_NAME })));
}

console.log("\nVera — the opening line is arithmetic, not a guess");

{
  const base = { isAdmin: true, callCount: 30, scope: "every rep", window: "month" };

  // The greeting is the ONLY thing said before the model is ever called, so nothing downstream
  // can catch it being wrong. It is therefore computed from the same SQL rows that feed an
  // answer, and these assertions are what stop it drifting back into prose.
  const g = greeting({ ...base, dims: [{ dim: "discovery", avg: 4.2, n: 19 }, { dim: "rapport", avg: 8.1, n: 19 }] });
  check("she opens with the weakest dimension, by name and number",
    /discovery is the lowest at 4\.2/i.test(g) && /19 scored calls/.test(g));
  check("...and the number is the one she was given, not one she picked",
    !/8\.1/.test(g), "the lowest is dims[0]; the query orders ascending");
  check("she says how many calls she read", /read 30 calls/.test(g));

  // The failure that matters: no scores at all must not become an invented score.
  const none = greeting({ ...base, dims: [] });
  check("with nothing scored she says so instead of naming a figure",
    /None of them are scored yet/.test(none) && !/[0-9]+\.[0-9]/.test(none),
    "a greeting that invents a number is unverifiable by design");

  const empty = greeting({ ...base, callCount: 0, dims: [] });
  check("with no calls she does not claim to have read any", !/I've read/.test(empty));
  const emptyMember = greeting({ ...base, isAdmin: false, callCount: 0, dims: [] });
  check("...and a rep's empty state names the boundary, not a failure",
    /only see calls recorded against you/.test(emptyMember));

  const mg = greeting({ ...base, isAdmin: false, callCount: 7, dims: [{ dim: "close attempt", avg: 3.5, n: 7 }] });
  check("a rep is never told anything about the team",
    !/team/.test(mg) && /7 calls of yours/.test(mg));

  // Singular/plural is the kind of thing nobody tests and everybody notices.
  const one = greeting({ ...base, callCount: 1, dims: [{ dim: "discovery", avg: 5, n: 1 }] });
  check("one call reads as '1 call', not '1 calls'", /read 1 call\b/.test(one) && !/1 calls/.test(one));
  const three = greeting({ ...base, callCount: 3, dims: [{ dim: "discovery", avg: 5, n: 3 }] });
  check("...and the scored count agrees with itself", /across 3 scored calls\b/.test(three));

  // Found by opening the panel, not by reading the code: on real data her first line was
  // "objection buildup is the lowest at 1, across 1 scored call". One call is not a low score,
  // it is a low sample, and naming it contradicts the rule the prompt itself states.
  const thin = greeting({ ...base, dims: [{ dim: "objection buildup", avg: 1, n: 1 }, { dim: "discovery", avg: 4.2, n: 19 }] });
  check("a one-call dimension does NOT get called the weak one",
    !/objection buildup/.test(thin),
    "a mean over one sample outranking a mean over nineteen is how a dashboard loses trust");
  check("...the well-sampled one is named instead", /discovery is the lowest at 4\.2/i.test(thin));
  const allThin = greeting({ ...base, dims: [{ dim: "rapport", avg: 2, n: 1 }] });
  check("when NOTHING clears the threshold she says so rather than picking the thinnest",
    /Not enough of them are scored yet/.test(allThin) && !/rapport/.test(allThin));
  check("the threshold is a named constant, not a literal", MIN_PATTERN_CALLS >= 3);
}

console.log("\nVera — the openers come from the data");

{
  const st = starters({ isAdmin: true, callCount: 30,
    dims: [{ dim: "discovery", avg: 4.2, n: 19 }],
    recent: [{ id: 9, client: "Northwind", on: "2026-09-01" }] });
  check("an opener names the real weak dimension and its real average",
    st.some(q => /discovery/.test(q) && /4\.2/.test(q)),
    "a static 'where am I losing calls' teaches nobody what this can do");
  check("...and another names a real client from the index",
    st.some(q => /Northwind/.test(q)));
  check("an admin is offered a team question", st.some(q => /team/i.test(q)));
  check("a rep is not", !starters({ isAdmin: false, callCount: 5, dims: [], recent: [] }).some(q => /team/i.test(q)));
  check("no calls means no openers to offer", starters({ callCount: 0 }).length === 0);
}

console.log("\nVera — the panel");

{
  check("the nav label comes from the constant, not the markup",
    /navAsk\.textContent = ASSISTANT_NAME/.test(app));
  check("the client name mirrors the server's and says so",
    /Mirrors ASSISTANT_NAME in src\/assistant\.js/.test(app));
  check("the greeting is rendered as her message, not empty-state furniture",
    /scope\?\.greeting/.test(app) && /ask-msg ask-assistant/.test(app));
  check("the greeting is ESCAPED like any other server string",
    /esc\(scope\.greeting\)/.test(app),
    "it is built from client names out of the database");
  check("the waiting state names her and what she is doing",
    /is reading/.test(app) && !/_Thinking\.\.\._/.test(app));
  check("the idle animation respects prefers-reduced-motion",
    /prefers-reduced-motion: reduce/.test(css) && /\.ask-dots i\{ animation:none/.test(css));
  // Both found by opening the panel and triggering a real 401, not by reading the code.
  check("an error message is escaped ONCE, not twice",
    !/text: `\*\*\$\{esc\(e\.message/.test(app) && /mdish\(m\.text\)/.test(app),
    "esc() here plus esc() in mdish() puts literal &quot; on the screen");
  check("a long unbroken token cannot push the composer off-screen",
    /\.ask-body\{ overflow-wrap:anywhere/.test(css),
    "a raw API error is one long token; the column grew and took the send button with it");
  check("the scope endpoint serves the greeting so the panel opens populated",
    /greeting: greeting\(ctx\), starters: starters\(ctx\)/.test(idx));
}

console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
