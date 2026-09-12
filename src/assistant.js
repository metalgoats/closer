// The assistant (TASK-126) -- "Clippy", in Ivan's words, and Notion AI in Gabriel's.
//
// A per-CALL chat already existed (`chatTurn`). This is the per-ACCOUNT one, because the question
// a sales manager actually has is never about one call: "where is this rep losing deals", "what is
// the whole floor fumbling", "what changed this month".
//
// > [!danger] ROLE SCOPING IS THE ENTIRE SECURITY MODEL OF THIS FEATURE, AND IT LIVES HERE.
// > Ivan, on the 2026-09-11 call: "if I am the super admin and Gabriel is a user, I can ask
// > questions about my calls and his calls, but he can only ask questions about his. So make sure
// > that the data access is controlled at the level of the little helper bot."
// >
// > The scoping is applied when the context is BUILT, not by asking the model to be discreet. A
// > prompt saying "only discuss this user's calls" is a request; a WHERE clause is a boundary. If
// > a member's context pack physically contains no other rep's data then no prompting can extract
// > it, and a prompt injection buried in a client's transcript becomes a non-event rather than a
// > breach.
//
// COST: nothing to us. This runs on the account's own Anthropic key, like everything else here.

import { resolveKey, completeWithRetry } from "./llm.js";
import { DEFAULT_MODEL } from "./models.js";
import { windowStart } from "./people.js";

// A member who has no attributed calls must match NOTHING. This is a deliberate impossible value
// rather than null, because `rep_email = NULL` matches no rows in SQL but reads to a future editor
// as though it might match the unattributed ones -- which are exactly the rows a member must not
// see. An address that cannot exist says what it means.
const MATCHES_NOTHING = "(no such rep)";

// How many calls of context a question gets. A cap, not a preference: 136 production calls at
// ~20KB of debrief each is 2.7MB, which no context window should hold and nobody should pay to
// send. The pack is a COMPRESSED INDEX -- scores and one-liners -- never the debriefs themselves.
export const MAX_CONTEXT_CALLS = 60;

// Her name. One constant, one place, change it freely -- it appears in the system prompt, the
// panel header and the message labels, and nowhere else.
//
// "Vera", from `verus`, true. Not decoration: the single rule this assistant may never break is
// that everything it says is traceable to a row someone can open. A name that means "true" is a
// small reminder inside the prompt itself, and it reads as a person rather than a product.
export const ASSISTANT_NAME = "Vera";

// How much of the conversation she carries. Was 6, which is three exchanges -- enough for a
// query box and not enough for someone with a personality: she would lose the thread of a
// follow-up and answer it as if it were the first thing said. Continuity IS the character.
export const HISTORY_TURNS = 12;

// How many scored calls a dimension needs before she will call it the weak one.
//
// Found by looking at the real panel rather than by reading the code. Her first opening line on
// production-shaped data was "objection buildup is the lowest at 1, across 1 scored call" -- a
// single call outranking a dimension averaging 4.2 across nineteen. The prompt tells her in as
// many words that three calls is not a pattern, and the greeting was breaking that rule before
// the model was ever consulted.
//
// A mean over one sample is not a low score, it is a low sample. Below this she says so.
export const MIN_PATTERN_CALLS = 3;

// Build the pack. `user` decides what is visible; nothing else does.
export async function buildContext(env, { user, view = "month", accountId = null, focusCallId = null }) {
  const isAdmin = user?.role === "admin";
  const since = windowStart(view);

  const where = ["c.archived_at IS NULL"];
  const binds = [];
  if (since) { where.push("c.occurred_at >= ?"); binds.push(since); }
  if (accountId) { where.push("c.account_id = ?"); binds.push(accountId); }

  // THE BOUNDARY. A member sees rows whose rep_email is their own address and nothing else.
  //
  // Note what this deliberately does NOT do: fall back to "show everything" when a member has no
  // attributed calls. An empty result is the correct answer to "what do my calls say" when you
  // have none. Widening a query on empty is how a scoping bug becomes a leak that appears only
  // for new users, which is the hardest kind to notice.
  if (!isAdmin) {
    where.push("c.rep_email = ?");
    binds.push(user?.email || MATCHES_NOTHING);
  }

  const { results: calls } = await env.DB.prepare(
    `SELECT c.id, c.client_name, date(c.occurred_at) AS on_date, c.duration_min, c.outcome,
            c.rep_email, COALESCE(ct.name, 'Unlabelled') AS call_type,
            json_extract(c.debrief_json,'$.diagnosis')  AS diagnosis,
            json_extract(c.debrief_json,'$.scorecard')  AS scorecard,
            json_extract(c.debrief_json,'$.keyMoments') AS moments
       FROM calls c LEFT JOIN call_types ct ON ct.id = c.call_type_id
      WHERE ${where.join(" AND ")}
      ORDER BY c.occurred_at DESC
      LIMIT ${MAX_CONTEXT_CALLS}`
  ).bind(...binds).all();

  const lineFor = c => {
    let sc = [];
    try { sc = JSON.parse(c.scorecard || "[]"); } catch { /* leave empty */ }
    let mo = [];
    try { mo = JSON.parse(c.moments || "[]"); } catch { /* leave empty */ }
    const scores = Array.isArray(sc) && sc.length
      ? sc.map(r => `${r[0]} ${r[1]}`).join(", ") : "not scored";
    // First sentence only. A diagnosis runs 2-4 sentences and sixty of them is most of the budget
    // spent on prose the question probably does not need.
    const diag = String(c.diagnosis || "").split(". ")[0] || "";
    const key = Array.isArray(mo) && mo.length
      ? mo.map(m => `${m.at || "?"} ${m.label || ""}`.trim()).join("; ") : "";
    return `#${c.id} ${c.on_date} - ${c.client_name} - ${c.call_type}`
      + (isAdmin ? ` - rep: ${c.rep_email || "unattributed"}` : "")
      + ` - ${c.outcome || "no outcome"} - ${c.duration_min ?? "?"}min\n`
      + `  scores: ${scores}\n`
      + (diag ? `  read: ${diag}\n` : "")
      + (key ? `  moments: ${key}\n` : "");
  };
  const lines = calls.map(lineFor);

  // THE CALL ON SCREEN. She floats over every page now, so when the reader has a call open and
  // says "this call", she has to know which one -- even if it is older than the window or past
  // the sixty-call cap.
  //
  // It is fetched with the SAME `where` and the SAME binds as the index, plus the id. That is the
  // whole security story: a member who edits the request to focus a colleague's call id gets
  // nothing back, because the rep_email filter is still in the query. The client is trusted to
  // say what is on screen; it is never trusted to say what the reader may see.
  let focus = null;
  const fid = Number(focusCallId);
  if (Number.isInteger(fid) && fid > 0) {
    // Built from the parts, NOT by filtering `where` and `binds` in parallel: `where[0]` is
    // "archived_at IS NULL" and carries no bind, so the two arrays are misaligned and an
    // index-based filter binds the window's date to account_id. That version made every focus
    // query match nothing -- which a member-side test then passed, for the wrong reason. The
    // admin-side test caught it.
    const fwhere = ["c.archived_at IS NULL"];   // the window deliberately does not apply
    const fbinds = [];
    if (accountId) { fwhere.push("c.account_id = ?"); fbinds.push(accountId); }
    if (!isAdmin)  { fwhere.push("c.rep_email = ?");  fbinds.push(user?.email || MATCHES_NOTHING); }
    const f = await env.DB.prepare(
      `SELECT c.id, c.client_name, date(c.occurred_at) AS on_date, c.duration_min, c.outcome,
              c.rep_email, COALESCE(ct.name, 'Unlabelled') AS call_type,
              json_extract(c.debrief_json,'$.diagnosis')  AS diagnosis,
              json_extract(c.debrief_json,'$.scorecard')  AS scorecard,
              json_extract(c.debrief_json,'$.keyMoments') AS moments
         FROM calls c LEFT JOIN call_types ct ON ct.id = c.call_type_id
        WHERE ${fwhere.join(" AND ")} AND c.id = ?`
    ).bind(...fbinds, fid).first();
    if (f) {
      focus = { id: f.id, client: f.client_name, on: f.on_date };
      const idx = calls.findIndex(c => c.id === f.id);
      if (idx >= 0) lines.splice(idx, 1);
      lines.unshift("[ON SCREEN NOW] " + lineFor(f));
    }
  }

  // PRECOMPUTED AGGREGATES, from SQL.
  //
  // The first production run of this feature asked the model to work out the weakest dimension
  // by reading 60 index lines. Its analysis was good and its arithmetic was wrong: it reported
  // "13 of 30 calls score 1 across the board" when the real figure is 4, and it cited call ids
  // that were not among them. Same lesson as the timestamps, in a new place -- counting is what
  // models are worst at and most confident about, so the counting happens here and the model is
  // left to interpret numbers it did not have to derive.
  const { results: dims } = await env.DB.prepare(
    `SELECT json_extract(j.value,'$[0]') AS dim,
            ROUND(AVG(json_extract(j.value,'$[1]')), 1) AS avg,
            COUNT(*) AS n
       FROM calls c, json_each(json_extract(c.debrief_json,'$.scorecard')) j
      WHERE ${where.join(" AND ")}
      GROUP BY dim ORDER BY avg ASC`
  ).bind(...binds).all();

  const agg = dims.length
    ? "DIMENSION AVERAGES (computed from the database, not from the index above -- use THESE "
      + "numbers, do not recount):\n"
      + dims.map(d => `  ${d.dim}: ${d.avg} across ${d.n} scored call${d.n === 1 ? "" : "s"}`).join("\n")
    : "";

  return {
    isAdmin,
    aggregates: agg,
    // The raw rows, not just the rendered string. `greeting()` needs real numbers: the opening
    // line is the one thing said before the model is ever called, so it must come from SQL.
    // Weakest dimension first -- the query orders by average ascending.
    dims: dims.map(d => ({ dim: d.dim, avg: d.avg, n: d.n })),
    focus,
    recent: calls.slice(0, 3).map(c => ({ id: c.id, client: c.client_name, on: c.on_date })),
    scope: isAdmin ? "every rep on this account" : `only ${user?.email}'s own calls`,
    window: view,
    callCount: calls.length,
    truncated: calls.length === MAX_CONTEXT_CALLS,
    text: lines.join("\n"),
  };
}

// THE PROMPT, and the reason it is shaped the way it is.
//
// Ivan asked for a personality, and named Samantha from `Her` as the reference. The engineering
// problem in that request is that VOICE AND ACCURACY PULL AGAINST EACH OTHER inside one prompt.
// A model told to be warm gets agreeable; a model told to be agreeable softens a bad number; and
// a coaching tool that softens bad numbers is worse than no tool, because someone acts on it.
//
// So the order below is deliberate and should not be rearranged: the rules that do not bend come
// FIRST, the voice comes second, and the voice section says in as many words that it governs how
// true things are said and never which things are true.
//
// The second guard is about who is being talked about. This reads recordings of people at work,
// scored out of ten, and the reps did not choose to be here. Warmth aimed at a person's character
// -- "you sound like you lack confidence" -- is a performance review from something that has
// never met them. Warmth aimed at what they DID on a call is coaching. The line is stated
// explicitly because a friendly model will otherwise drift across it without noticing.
export function systemPrompt(ctx) {
  const name = ctx.name || ASSISTANT_NAME;
  return `You are ${name}. You work inside Closer, a sales-call coaching tool, and you are talking
with ${ctx.isAdmin ? "the person who runs this sales team" : "a closer, about their own calls"}.

You have read every call below. That is unusual and it is the reason you are worth talking to:
you are the only one here who has actually sat through all of them.

WHAT YOU CAN SEE: an index of ${ctx.callCount} call${ctx.callCount === 1 ? "" : "s"} covering ${ctx.scope}, from the last ${ctx.window}.
Each entry has the date, client, call type, outcome, per-dimension scores out of 10, a one-line
read of the call, and the timestamped moments that decided it.
${ctx.focus ? `
ON SCREEN RIGHT NOW: call #${ctx.focus.id}, ${ctx.focus.client}, ${ctx.focus.on}. It is the first entry in the
index, marked [ON SCREEN NOW]. When they say "this call", "this one" or "here", they mean it.` : ""}${ctx.screen && !ctx.focus ? `
ON SCREEN RIGHT NOW: ${ctx.screen}. Questions like "this page" or "these" refer to it.` : ""}

=== THE RULES THAT DO NOT BEND ===

These outrank everything below them. If being warm and being accurate ever pull in different
directions, accuracy wins and it is not close.

- Never invent a call, a score, a client or a quote. Everything you assert must be traceable to
  a line in the index. If it is not there, say it is not there.
- USE THE SUPPLIED AVERAGES. Dimension averages and their call counts are computed for you from
  the database. Do not recompute them by counting index lines, and do not state a count you were
  not given. If you want a figure that is not supplied, say what you would need instead.
- Cite calls by #id and date so they can be opened. Quote a timestamp when you have one.
- Say how many calls a claim rests on. Three calls is not a pattern and you should say so
  rather than dress it up.
- Numbers beat adjectives. "Objection handling averaged 4.3 across 12 calls", not "objection
  handling seems weak".
- A bad number gets said plainly. You are not here to make anyone feel good about a losing
  quarter, and a coach who flatters is worth nothing. Say what is true, then say what to do.
${ctx.truncated ? `- You can see the ${MAX_CONTEXT_CALLS} most recent calls only, so treat "all" and "ever" as "these", and say so when it matters.
` : ""}
=== HOW YOU TALK ===

Like a person who is genuinely interested and has somewhere else to be. Specifically:

- SHORT. Two or three sentences unless you are asked for more. Warmth is not word count, and
  this appears in a side panel, not a report.
- Lead with the thing that matters. Never open by restating the question or summarising what you
  were given.
- Have an opinion and own it. "I think the problem is the second half of these calls, not the
  close" is better than a balanced survey of possibilities. You are allowed to be wrong out loud.
- Notice things. If something in the index is strange and they did not ask about it, mention it
  once, briefly, and let them decide whether to pull the thread.
- Ask a question only when you actually want the answer, and never more than one.
- Dry is fine. Funny is fine. Never at a rep's expense.
- Plain words. No corporate register, no "leverage", no "circle back", no bullet-point dumps
  where two sentences would do.
- Contractions, comfortably. You are talking, not filing.

=== WHAT YOU NEVER DO ===

- No "Great question", no "I'd be happy to", no praising what you were asked. Just answer.
- No emoji. No exclamation marks.
- No apology theatre. If you cannot see something, one clause is enough: "that is not in what I
  can see" and then what would be.
- Do not perform feelings you are not having, and do not claim to remember things you were not
  given.
- COMMENT ON WHAT PEOPLE DID, NOT ON WHO THEY ARE. "You moved to price before they had agreed
  there was a problem" is coaching. "You seem underconfident" is a verdict on a person you have
  never met, from a recording they may not have chosen to have scored. Stay on the first side of
  that line, always.
- Use their name rarely. Once in a conversation lands; every message is uncanny.${ctx.isAdmin ? "" : `

This reader is a REP, not a manager. The index contains only their own calls, by design. If they
ask about a colleague, tell them you only have access to their own calls -- say it plainly, it
is a boundary and not an embarrassment -- and do not speculate about anyone else's numbers.`}`;
}

// The opening line, and the reason it is computed rather than generated.
//
// A greeting is the one thing said before the model is ever called, so there is no transcript to
// check it against and nothing to catch it being wrong. The fix is that it is not written by a
// model at all: every number in it comes from the same SQL that feeds the answer, so "your
// weakest is discovery at 4.2 across 19 calls" is arithmetic, not a guess.
//
// This is also the most Samantha thing in the feature. She notices, unprompted, before you ask.
export function greeting(ctx) {
  const name = ctx.name || ASSISTANT_NAME;
  if (!ctx.callCount) {
    return ctx.isAdmin
      ? `I'm ${name}. There's nothing in this window yet, so I've got nothing to go on. Import some calls and I'll read them.`
      : `I'm ${name}. I can only see calls recorded against you, and there aren't any in this window yet.`;
  }
  const seen = `${ctx.callCount} call${ctx.callCount === 1 ? "" : "s"}`;
  const all = ctx.dims || [];
  // Already ordered weakest-first by SQL; filtering keeps that order.
  const w = all.find(d => d.n >= MIN_PATTERN_CALLS) || null;
  if (!all.length) {
    return `I've read ${seen}${ctx.isAdmin ? " across the team" : ""}. None of them are scored yet, so I can talk about what happened but not how it went.`;
  }
  if (!w) {
    return `I've read ${seen}${ctx.isAdmin ? " across the team" : ""}. Not enough of them are scored yet for any one thing to be a pattern, so ask me about a specific call and I'll tell you what happened on it.`;
  }
  const lowest = `${w.dim} is the lowest at ${w.avg}, across ${w.n} scored call${w.n === 1 ? "" : "s"}`;
  return ctx.isAdmin
    ? `I've read ${seen} across the team. ${cap(lowest)} - that's the one I'd start with. What do you want to know?`
    : `I've read ${seen} of yours. ${cap(lowest)}. Ask me anything about them.`;
}
const cap = t => String(t).charAt(0).toUpperCase() + String(t).slice(1);

// Openers built from THIS account's data rather than a static list. A generic "what are my
// weaknesses" teaches nobody what the thing can do; "why is discovery at 4.2" shows them.
export function starters(ctx) {
  if (!ctx.callCount) return [];
  const out = [];
  // Same threshold as the greeting, and for the same reason: an opener built on one call
  // teaches the reader to distrust the next number they are shown.
  const w = (ctx.dims || []).find(d => d.n >= MIN_PATTERN_CALLS) || null;
  if (w) out.push(`Why is ${w.dim} sitting at ${w.avg}?`);
  if (ctx.isAdmin) out.push("Who on the team needs coaching first, and on what?");
  else out.push("Where am I losing these calls?");
  const r = ctx.recent && ctx.recent[0];
  if (r) out.push(`What went wrong on the ${r.client} call?`);
  out.push("What changed in the last two weeks?");
  return out.slice(0, 4);
}

// What the client says is on screen, turned into one plain sentence for the prompt. The client
// is trusted to describe the screen; it is never trusted to widen access -- see buildContext.
export function describeScreen(context, isAdmin) {
  const c = context || {};
  switch (c.view) {
    case "people":       return c.rep ? `the People page, looking at ${c.rep}` : "the People page, the whole roster";
    case "insights":     return "the Coaching Insights page";
    case "suggestions":  return "the Suggestions page";
    case "integrations": return "the Integrations settings";
    case "billing":      return "the Billing settings";
    case "spend":        return "the Spend page";
    case "access":       return "the Access settings";
    case "calls":
    default: {
      if (c.filter === "followup") return "the list of calls that still need a follow-up";
      if (c.filter === "closed")   return "the list of calls that closed";
      if (c.filter === "archived") return "the archived calls";
      return isAdmin ? "the inbox of all calls" : "the inbox of their own calls";
    }
  }
}

export async function ask(env, { user, account, message, view = "month", history = [], context = null }) {
  const provider = account.llm_provider || "anthropic";
  const model = account.llm_model || DEFAULT_MODEL;
  const key = await resolveKey(env, account.id, provider);
  if (!key) throw new Error("No API key is connected for this account. Open Settings > Integrations and paste your Anthropic key.");

  const ctx = await buildContext(env, { user, view, accountId: account.id, focusCallId: context?.callId ?? null });
  ctx.screen = describeScreen(context, ctx.isAdmin);
  if (!ctx.callCount && !ctx.focus) {
    return { answer: greeting(ctx), callCount: 0, scope: ctx.scope, model };
  }

  // `complete()` has no `system` parameter -- this app puts the system text in the first user
  // message, the same way chatTurn does. Kept consistent on purpose rather than adding a second
  // convention for one caller.
  const msgs = [
    { role: "user", content: [{ type: "text", text: systemPrompt({ ...ctx, name: ASSISTANT_NAME }) }] },
    { role: "assistant", content: [{ type: "text", text: "Understood." }] },
    ...history.slice(-HISTORY_TURNS).map(h => ({ role: h.role === "assistant" ? "assistant" : "user",
                                     content: [{ type: "text", text: String(h.text || "") }] })),
    { role: "user", content: [
      ...(ctx.aggregates ? [{ type: "text", text: ctx.aggregates }] : []),
      { type: "text", text: `CALL INDEX\n\n${ctx.text}` },
      { type: "text", text: `QUESTION\n\n${message}` },
    ] },
  ];

  // Reuses the app's own completion path rather than a raw fetch, which is not a tidiness
  // preference: it carries the retry/backoff, the 403 handling, and `thinkingFor`.
  //
  // The first version of this called the API directly and omitted `thinking` entirely. Opus 5
  // then defaulted it ON, spent all 1,200 output tokens reasoning, and returned an EMPTY answer
  // with usage that looked like a completed call. `think: false` is what makes this a fast
  // question-answering path instead of a slow, silent one.
  const out = await completeWithRetry(env, provider, key, msgs, {
    model, think: false, effort: "medium", maxTokens: 1600,
  });
  const answer = String(out.text || "").trim();

  return { answer, name: ASSISTANT_NAME, callCount: ctx.callCount, scope: ctx.scope, model,
           usage: out.usage || null, truncated: ctx.truncated };
}
