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

import { resolveKey } from "./llm.js";
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

// Build the pack. `user` decides what is visible; nothing else does.
export async function buildContext(env, { user, view = "month", accountId = null }) {
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

  const lines = calls.map(c => {
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
  });

  return {
    isAdmin,
    scope: isAdmin ? "every rep on this account" : `only ${user?.email}'s own calls`,
    window: view,
    callCount: calls.length,
    truncated: calls.length === MAX_CONTEXT_CALLS,
    text: lines.join("\n"),
  };
}

export function systemPrompt(ctx) {
  return `You are the assistant inside Closer, a sales-call coaching tool. You are answering a
question from ${ctx.isAdmin ? "a sales manager who can see their whole team" : "a sales rep about their own calls"}.

WHAT YOU CAN SEE: an index of ${ctx.callCount} call${ctx.callCount === 1 ? "" : "s"} covering ${ctx.scope}, from the last ${ctx.window}.
Each entry has the date, client, call type, outcome, per-dimension scores out of 10, a one-line
read of the call, and the timestamped moments that decided it.

HOW TO ANSWER:
- Answer the question asked. Do not open by summarising what you were given.
- Cite calls by #id and date so the reader can open them. Quote a timestamp when you have one.
- Numbers beat adjectives: "objection handling averaged 4.3 across 12 calls", not "objection
  handling seems weak".
- Say how many calls a claim rests on. A pattern across three calls is not a pattern and you
  should say so rather than dress it up.
- If the index does not contain the answer, say so plainly and say what would. Never invent a
  call, a score, a client or a quote: everything you assert must be traceable to a line below.
- Be brief. This appears in a side panel, not a report.
${ctx.truncated ? `\nNOTE: you can see the ${MAX_CONTEXT_CALLS} most recent calls only, so treat "all" and "ever" as "these", and say so if it matters to the answer.` : ""}
${ctx.isAdmin ? "" : `
This reader is a REP, not a manager. The index contains only their own calls, by design. If they
ask about a colleague, tell them the assistant only has access to their own calls; do not
speculate about anyone else's numbers.`}`;
}

export async function ask(env, { user, account, message, view = "month", history = [] }) {
  const provider = account.llm_provider || "anthropic";
  const model = account.llm_model || DEFAULT_MODEL;
  const key = await resolveKey(env, account.id, provider);
  if (!key) throw new Error("No API key is connected for this account. Open Settings > Integrations and paste your Anthropic key.");

  const ctx = await buildContext(env, { user, view, accountId: account.id });
  if (!ctx.callCount) {
    return { answer: ctx.isAdmin
      ? "There are no calls in this window yet, so there is nothing for me to read."
      : "I can only see calls recorded against your own account, and there are none in this window yet.",
      callCount: 0, scope: ctx.scope, model };
  }

  const msgs = [
    ...history.slice(-6).map(h => ({ role: h.role === "assistant" ? "assistant" : "user",
                                     content: [{ type: "text", text: String(h.text || "") }] })),
    { role: "user", content: [
      { type: "text", text: `CALL INDEX\n\n${ctx.text}` },
      { type: "text", text: `QUESTION\n\n${message}` },
    ] },
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 1200, system: systemPrompt(ctx), messages: msgs, stream: false }),
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg; try { msg = JSON.parse(text)?.error?.message; } catch { /* raw */ }
    throw new Error(msg || `Anthropic returned ${res.status}`);
  }
  const data = JSON.parse(text);
  const answer = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  return { answer, callCount: ctx.callCount, scope: ctx.scope, model,
           usage: data.usage || null, truncated: ctx.truncated };
}
