import { hashPassword, verifyPassword, newSessionToken, sessionCookie, readSessionToken, requireUser } from "./auth.js";
import { roster, person, WINDOWS } from "./people.js";
import { weeklyReport, renderWeeklyEmail, weekBounds } from "./report.js";
import { verifyStripeSignature, createCheckoutSession, createPortalSession, accessFromEvent, HANDLED_EVENTS } from "./billing.js";
import { deriveClientName, deriveAttendeeName, isGenericTitle } from "./naming.js";
import { resolveKey, keyForRow, debriefLine } from "./llm.js";
import { MODELS, DEFAULT_MODEL, EFFORTS, DEFAULT_EFFORT } from "./models.js";
import { runBackup } from "./backup.js";
import { chatTurn, analyseEdits } from "./llm.js";
import { logEvent } from "./log.js";
import { spendReport, importUsage, reconcile } from "./spend.js";

// The Workflow class must be exported from the Worker entrypoint for the binding to resolve.
export { GenerateWorkflow } from "./workflow.js";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request); // static UI
    }
    try {
      return await route(request, env, url, ctx);
    } catch (err) {
      console.error(err);
      return json({ error: err.message }, 500);
    }
  },

  // AWAIT, don't ctx.waitUntil: waitUntil is capped at 30 seconds (see src/workflow.js), and
  // the runtime already waits for whatever this handler returns. Both jobs are short —
  // pollFathom only imports and hands off; the minutes-long LLM work happens in the Workflow.
  async scheduled(event, env, ctx) {
    try {
      // Dispatch EXHAUSTIVELY, never `else -> pollFathom`. That default was fine with two
      // triggers and becomes a trap the moment a third is added: a new cron with no branch
      // would silently run the Fathom poller on someone else's schedule, and the only symptom
      // would be the new job never appearing to run.
      if (event.cron === "0 17 * * SUN")      await weeklyEditAnalysis(env);
      else if (event.cron === "0 9 * * *")    await nightlyBackup(env);
      else if (event.cron === "*/5 * * * *")  await pollFathom(env);
      else {
        await logEvent(env, { level: "warn", kind: "cron.unrouted",
          detail: `no handler for cron "${event.cron}" — it fired and did nothing` });
      }
    } catch (err) {
      // A cron that throws is invisible — nobody is watching. Record it.
      console.error("cron failed", event.cron, err);
      await logEvent(env, { level: "error", kind: "cron.failed",
        detail: `${event.cron}: ${String(err?.message || err)}` });
    }
  }
};

// TASK-023. Leaves a dated line on EVERY run, success or failure (Law 3): a silent success and
// a dead job look identical from the outside, and this one runs at 2am with nobody watching.
async function nightlyBackup(env) {
  const t0 = Date.now();
  try {
    const r = await runBackup(env);
    await logEvent(env, { kind: "backup.succeeded", duration_ms: Date.now() - t0,
      detail: `${r.key} · ${(r.size / 1024).toFixed(0)}KB · ${r.tables} tables · ${r.rows} rows` +
              (r.pruned ? ` · pruned ${r.pruned} older than 30d` : "") });
  } catch (err) {
    // Rethrow so scheduled()'s cron.failed also fires — two log lines is the right price for
    // never having a backup fail quietly.
    await logEvent(env, { level: "error", kind: "backup.failed", duration_ms: Date.now() - t0,
      detail: String(err?.message || err) });
    throw err;
  }
}

async function route(request, env, url, ctx) {
  const path = url.pathname;
  const method = request.method;

  // ---- unauthenticated ----
  if (path === "/api/setup" && method === "POST") return setup(request, env);
  if (path === "/api/login" && method === "POST") return login(request, env);
  if (path === "/api/logout" && method === "POST") return logout(request, env);

  // ---- Stripe webhook (TASK-122) ----
  //
  // UNAUTHENTICATED BY NECESSITY and that is the whole risk. Stripe has no session cookie, so
  // this sits above requireUser and anyone on the internet can POST to it. The SIGNATURE is the
  // only authentication it has: without verification this endpoint is a free-account dispenser,
  // because "this customer paid" would be a claim anyone could make with curl.
  //
  // Two things must happen in this exact order, and both are easy to get wrong:
  //   1. Read the RAW body text before anything parses it. Stripe signs the exact bytes; any
  //      reserialisation (even key reordering) breaks verification for reasons that look random.
  //   2. Verify BEFORE looking at the contents. Reading the event first and verifying after is
  //      how a handler ends up acting on an unverified payload during a refactor.
  if (path === "/api/stripe/webhook" && method === "POST") {
    const raw = await request.text();
    const sig = request.headers.get("stripe-signature");
    const check = await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET);
    if (!check.ok) {
      // Logged at warn because a burst of these is either a misconfigured secret or somebody
      // probing, and both are worth seeing. The reason never contains the payload or the secret.
      await logEvent(env, { level: "warn", kind: "stripe.webhook_rejected", detail: check.reason });
      return json({ error: "signature verification failed" }, 400);
    }
    return handleStripeEvent(env, raw);
  }

  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);

  // ---- what a member cannot reach (TASK-112) ----
  //
  // ENFORCED HERE, SERVER-SIDE, not by hiding menu items. A front-end that omits a button is a
  // suggestion; this is the boundary. The front end hides the same pages purely so a member
  // does not click into a 403.
  //
  // The four, and why each:
  //   spend        — billing. The whole point of a permission level.
  //   integrations — it holds the API keys. The GET already refuses to return a raw secret, but
  //                  the POST WRITES one: a member could replace the account's Anthropic key
  //                  with their own, or point Fathom somewhere else. Write access is the risk,
  //                  not read access.
  //   backup       — `/api/backup` returns a dump of every table, which means every transcript
  //                  of every sales call. This is the strongest of the four and the least
  //                  obvious; it was reachable by anyone with a session until today.
  //   users        — creating logins.
  //
  // Activity is deliberately NOT on the list. It is the reliability surface Gabriel needed on
  // 08-04 ("does generation actually fail?"), and its cost figures describe spend on his own
  // key. Revisit if the roles are ever inverted.
  const ADMIN_ONLY = [/^\/api\/spend/, /^\/api\/integrations/, /^\/api\/backup/, /^\/api\/users/, /^\/api\/people/, /^\/api\/report/, /^\/api\/billing/];
  if (user.role !== "admin" && ADMIN_ONLY.some(re => re.test(path))) {
    return json({ error: "This account does not have access to that." }, 403);
  }

  if (path === "/api/me") return json({ user, build: env.BUILD_ID || "dev" });

  // ---- users & access (TASK-112) ----
  if (path === "/api/users" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, email, COALESCE(role,'member') AS role, created_at FROM users ORDER BY id").all();
    return json({ users: results, me: user.id });
  }
  // The second login. /api/setup stays first-run-gated exactly as it was — this is the route
  // that did not exist, which is why there has only ever been one credential.
  if (path === "/api/users" && method === "POST") {
    const b = await request.json();
    const email = String(b.email || "").trim().toLowerCase();
    const role = b.role === "admin" ? "admin" : "member";
    if (!email || !b.password || String(b.password).length < 8) {
      return json({ error: "email + password (8+ chars) required" }, 400);
    }
    const clash = await env.DB.prepare("SELECT id FROM users WHERE lower(email) = ?").bind(email).first();
    if (clash) return json({ error: "that email already has a login" }, 409);
    const { hash, salt } = await hashPassword(b.password);
    await env.DB.prepare("INSERT INTO users (email, pw_hash, pw_salt, role) VALUES (?, ?, ?, ?)")
      .bind(email, hash, salt, role).run();
    await logEvent(env, { kind: "user.created", detail: `${email} · ${role}` });
    return json({ ok: true, email, role });
  }
  // Self-serve password change — for ANY role, including a member changing their own. There was
  // no way to change a password at all before this, which is its own reason the credential was
  // shared and stayed shared.
  if (path === "/api/password" && method === "POST") {
    const b = await request.json();
    if (!b.next || String(b.next).length < 8) return json({ error: "new password must be 8+ characters" }, 400);
    const row = await env.DB.prepare("SELECT pw_hash, pw_salt FROM users WHERE id = ?").bind(user.id).first();
    if (!row || !(await verifyPassword(String(b.current || ""), row.pw_salt, row.pw_hash))) {
      return json({ error: "current password is wrong" }, 403);
    }
    const { hash, salt } = await hashPassword(String(b.next));
    await env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?").bind(hash, salt, user.id).run();
    // Every OTHER session for this user dies. A password change that leaves old sessions alive
    // is not a password change — it is a new way to log in beside the old one.
    const tok = readSessionToken(request);
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").bind(user.id, tok).run();
    await logEvent(env, { kind: "user.password_changed", detail: user.email });
    return json({ ok: true });
  }

  // ---- accounts ----
  if (path === "/api/accounts" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM accounts ORDER BY id").all();
    return json({ accounts: results });
  }

  // ---- integrations ----
  // NOTE: secret_value is deliberately NOT selected. The raw key must never reach
  // the browser — only a masked preview derived server-side.
  if (path === "/api/integrations" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT i.id, i.account_id, i.kind, i.status, i.secret_name, i.updated_at, i.label, i.owner_email,
              a.name AS account_name,
              CASE WHEN i.secret_value IS NULL OR i.secret_value = '' THEN 0 ELSE 1 END AS has_key,
              CASE WHEN i.secret_value IS NULL OR i.secret_value = '' THEN NULL
                   ELSE substr(i.secret_value, 1, 7) || '...' || substr(i.secret_value, -4) END AS key_preview
       FROM integrations i JOIN accounts a ON a.id = i.account_id
       ORDER BY i.account_id, i.kind`
    ).all();
    // env_fallback is reported as false, always, and the field is kept only so an older cached
    // front-end does not read `undefined` and render "set via wrangler" over a key that is not
    // there. There ARE no platform fallbacks any more (TASK-108) — every account uses its own
    // key, and a missing one is now a visible failure rather than a silent substitution.
    return json({ integrations: results.map(i => ({ ...i, env_fallback: false })) });
  }

  const intMatch = path.match(/^\/api\/integrations\/(\d+)$/);
  if (intMatch && method === "PUT") {
    const { secret_value } = await request.json();
    if (!secret_value || !secret_value.trim()) return json({ error: "key required" }, 400);
    await env.DB.prepare(
      "UPDATE integrations SET secret_value = ?, status = 'connected', updated_at = datetime('now') WHERE id = ?"
    ).bind(secret_value.trim(), +intMatch[1]).run();
    // Log THAT a key changed — never the value.
    await logEvent(env, { kind: "integration.key_saved", detail: `integration #${intMatch[1]}` });
    return json({ ok: true });
  }
  if (intMatch && method === "DELETE") {
    await env.DB.prepare(
      "UPDATE integrations SET secret_value = NULL, status = 'disconnected', updated_at = datetime('now') WHERE id = ?"
    ).bind(+intMatch[1]).run();
    return json({ ok: true });
  }

  const intLabelMatch = path.match(/^\/api\/integrations\/(\d+)\/label$/);
  if (intLabelMatch && method === "POST") {
    const { label, owner_email } = await request.json();
    if (owner_email !== undefined) {
      await env.DB.prepare("UPDATE integrations SET owner_email = ? WHERE id = ?")
        .bind((owner_email || "").trim() || null, +intLabelMatch[1]).run();
    }
    if (label !== undefined) {
      await env.DB.prepare("UPDATE integrations SET label = ? WHERE id = ?")
        .bind((label || "").trim() || null, +intLabelMatch[1]).run();
    }
    // A label is not a secret — safe to log.
    await logEvent(env, { kind: "integration.labeled", detail: `#${intLabelMatch[1]} -> ${(label||"").trim() || "(cleared)"}` });
    return json({ ok: true });
  }

  const intTestMatch = path.match(/^\/api\/integrations\/(\d+)\/test$/);
  if (intTestMatch && method === "POST") return testIntegration(env, +intTestMatch[1]);

  // Read-only: what does Fathom have that we don't, and why was it skipped? Answers
  // "are we missing calls?" without importing anything or pulling a single transcript.
  const peekMatch = path.match(/^\/api\/integrations\/(\d+)\/preview$/);
  if (peekMatch && method === "GET") {
    const days = Math.min(90, Math.max(1, +(url.searchParams.get("days") || 3)));
    return fathomPreview(env, +peekMatch[1], days);
  }

  const importOneMatch = path.match(/^\/api\/integrations\/(\d+)\/import\/([\w-]+)$/);
  if (importOneMatch && method === "POST") {
    return fathomImportOne(env, +importOneMatch[1], importOneMatch[2]);
  }

  const titleMatch = path.match(/^\/api\/integrations\/(\d+)\/backfill-titles$/);
  if (titleMatch && method === "POST") {
    const days = Math.min(365, Math.max(1, +(url.searchParams.get("days") || 30)));
    return fathomBackfillTitles(env, +titleMatch[1], days, url.searchParams.get("dry") === "1");
  }
  // Dry by default, the opposite of the titles backfill, because this one writes to calls rather
  // than to a field nobody reads. Pass ?apply=1 to actually write.
  const urlMatch = /^\/api\/integrations\/(\d+)\/backfill-urls$/.exec(path);
  if (urlMatch && method === "POST") {
    const days = Math.min(365, Math.max(1, +(url.searchParams.get("days") || 90)));
    return fathomBackfillUrls(env, +urlMatch[1], days, url.searchParams.get("apply") !== "1");
  }

  // ---- calls ----
  if (path === "/api/calls" && method === "GET") {
    const accountId = url.searchParams.get("account");
    const q = (url.searchParams.get("q") || "").trim();
    // Bounded by default (TASK-052). Search runs SERVER-side so it can reach the transcript
    // and isn't limited to whatever page the browser happens to be holding.
    const limit = Math.min(500, Math.max(1, +(url.searchParams.get("limit") || 100)));
    const offset = Math.max(0, +(url.searchParams.get("offset") || 0));
    const archived = url.searchParams.get("archived") === "1";
    const where = [archived ? "c.archived_at IS NOT NULL" : "c.archived_at IS NULL"];
    const binds = [];
    if (accountId) { where.push("c.account_id = ?"); binds.push(accountId); }
    if (q) {
      where.push("(c.client_name LIKE ? OR c.transcript LIKE ? OR ct.name LIKE ? OR si.label LIKE ?)");
      const like = `%${q}%`; binds.push(like, like, like, like);
    }
    const { results } = await env.DB.prepare(
      `${CALL_LIST_SQL} WHERE ${where.join(" AND ")} ORDER BY c.occurred_at DESC LIMIT ? OFFSET ?`
    ).bind(...binds, limit + 1, offset).all();
    const hasMore = results.length > limit;
    // Sidebar counts (TASK-079). Deliberately computed server-side and independently of q /
    // offset / archived: counting the loaded page would undercount as soon as there are more
    // than `limit` calls, would report 0 archived unless the archived filter happened to be
    // open, and would swing wildly while you type in the search box. Only the account filter
    // applies. One aggregate pass, not four queries.
    const cWhere = accountId ? "WHERE account_id = ?" : "";
    const cBinds = accountId ? [accountId] : [];
    const counts = await env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END),0) AS all_n,
         COALESCE(SUM(CASE WHEN archived_at IS NULL AND outcome = 'followup' THEN 1 ELSE 0 END),0) AS followup_n,
         COALESCE(SUM(CASE WHEN archived_at IS NULL AND outcome = 'closed'   THEN 1 ELSE 0 END),0) AS closed_n,
         COALESCE(SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END),0) AS archived_n
       FROM calls ${cWhere}`
    ).bind(...cBinds).first();
    return json({ calls: hasMore ? results.slice(0, limit) : results, hasMore, offset, limit, counts });
  }

  const callMatch = path.match(/^\/api\/calls\/(\d+)$/);
  if (callMatch && method === "GET") return getCall(env, +callMatch[1]);
  if (callMatch && method === "PATCH") return patchCall(request, env, +callMatch[1]);

  if (path === "/api/calls" && method === "POST") return createCall(request, env, ctx, user);

  const processMatch = path.match(/^\/api\/calls\/(\d+)\/process$/);
  if (processMatch && method === "POST") return startProcessing(env, +processMatch[1], ctx);

  const archiveMatch = path.match(/^\/api\/calls\/(\d+)\/archive$/);
  if (archiveMatch && method === "POST") return setArchived(request, env, +archiveMatch[1]);

  if (callMatch && method === "DELETE") return deleteCall(env, +callMatch[1]);

  // ---- outputs ----
  const outMatch = path.match(/^\/api\/outputs\/(\d+)$/);
  if (outMatch && method === "PATCH") return patchOutput(request, env, +outMatch[1]);

  const outActionMatch = path.match(/^\/api\/outputs\/(\d+)\/(sent|copied)$/);
  if (outActionMatch && method === "POST") {
    const [, id, action] = outActionMatch;
    if (action === "sent") {
      const { sent } = await request.json();
      await env.DB.prepare("UPDATE outputs SET sent_at = ? WHERE id = ?")
        .bind(sent ? new Date().toISOString() : null, +id).run();
    } else {
      await env.DB.prepare("UPDATE outputs SET copied_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), +id).run();
    }
    // Which outputs actually get used — evidence for the deferred "trim the debrief" decision.
    const o = await env.DB.prepare("SELECT call_id, kind, tone FROM outputs WHERE id = ?").bind(+id).first();
    await logEvent(env, { kind: `output.${action}`, call_id: o?.call_id,
      detail: `${o?.kind}${o?.tone ? " · " + o.tone : ""}` });
    return json({ ok: true });
  }

  // ---- call types (prompt library) ----
  if (path === "/api/call-types" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM call_types WHERE archived_at IS NULL ORDER BY sort_order, id"
    ).all();
    return json({ call_types: results });
  }
  if (path === "/api/call-types" && method === "POST") {
    const b = await request.json();
    if (!b.name?.trim()) return json({ error: "name required" }, 400);
    const r = await env.DB.prepare(
      `INSERT INTO call_types (account_id, name, description, prompt_body, dimensions_json,
                               produces_messages, produces_crm_note, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM call_types)) RETURNING id`
    ).bind(b.account_id || 1, b.name.trim(), b.description || null, b.prompt_body || "",
           JSON.stringify(b.dimensions || []), b.produces_messages ? 1 : 0, b.produces_crm_note ? 1 : 0).first();
    await logEvent(env, { kind: "call_type.created", detail: b.name.trim() });
    return json({ ok: true, id: r.id });
  }
  const ctMatch = path.match(/^\/api\/call-types\/(\d+)$/);
  if (ctMatch && method === "PUT") {
    const b = await request.json();
    const sets = [], vals = [];
    for (const k of ["name", "description", "prompt_body"]) if (k in b) { sets.push(`${k} = ?`); vals.push(b[k]); }
    if ("dimensions" in b) { sets.push("dimensions_json = ?"); vals.push(JSON.stringify(b.dimensions || [])); }
    for (const k of ["produces_messages", "produces_crm_note"]) if (k in b) { sets.push(`${k} = ?`); vals.push(b[k] ? 1 : 0); }
    if (!sets.length) return json({ error: "nothing to update" }, 400);
    sets.push("updated_at = datetime('now')");
    await env.DB.prepare(`UPDATE call_types SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, +ctMatch[1]).run();
    await logEvent(env, { kind: "call_type.updated", detail: `#${ctMatch[1]}${b.name ? " " + b.name : ""}` });
    return json({ ok: true });
  }
  if (ctMatch && method === "DELETE") {
    // Archive, never hard-delete: existing calls reference this type.
    const t = await env.DB.prepare("SELECT is_default FROM call_types WHERE id = ?").bind(+ctMatch[1]).first();
    if (t?.is_default) return json({ error: "Can't remove the default call type — make another one the default first." }, 400);
    await env.DB.prepare("UPDATE call_types SET archived_at = datetime('now') WHERE id = ?").bind(+ctMatch[1]).run();
    return json({ ok: true });
  }

  // ---- templates ----
  // The model picker (TASK-098). Lives beside the prompts because choosing a model IS a
  // prompt-level decision — the same prompt behaves differently across them.
  if (path === "/api/model" && method === "GET") {
    const row = await env.DB.prepare(
      "SELECT llm_model, llm_effort FROM accounts ORDER BY id LIMIT 1").first();
    // Cost is computed from THIS account's real generations, not a guessed shape. An average
    // that came from my head told Ivan nothing he could act on; his own last N runs do.
    const u = await env.DB.prepare(
      `SELECT COUNT(*) AS runs,
              AVG(input_tokens)      AS in_avg,
              AVG(output_tokens)     AS out_avg,
              AVG(COALESCE(cache_read_tokens, 0)) AS cache_avg
         FROM events
        WHERE kind = 'generation.succeeded' AND input_tokens IS NOT NULL`
    ).first();
    return json({
      current: row?.llm_model || DEFAULT_MODEL, default: DEFAULT_MODEL, models: MODELS,
      effort: row?.llm_effort || DEFAULT_EFFORT, defaultEffort: DEFAULT_EFFORT, efforts: EFFORTS,
      usage: {
        runs: u?.runs || 0,
        inAvg: Math.round(u?.in_avg || 0),
        outAvg: Math.round(u?.out_avg || 0),
        cacheAvg: Math.round(u?.cache_avg || 0),
      },
    });
  }
  if (path === "/api/effort" && method === "PUT") {
    const { effort } = await request.json().catch(() => ({}));
    if (!Object.prototype.hasOwnProperty.call(EFFORTS, effort)) {
      return json({ error: "Unknown effort level" }, 400);
    }
    await env.DB.prepare("UPDATE accounts SET llm_effort = ?").bind(effort).run();
    return json({ ok: true, effort });
  }
  if (path === "/api/model" && method === "PUT") {
    const { model } = await request.json().catch(() => ({}));
    // Allowlisted, not free text: an unknown id would 404 on every generation, and each model
    // needs its own thinking handling (see models.js) that only exists for these three.
    if (!Object.prototype.hasOwnProperty.call(MODELS, model)) {
      return json({ error: "Unknown model" }, 400);
    }
    await env.DB.prepare("UPDATE accounts SET llm_model = ?").bind(model).run();
    return json({ ok: true, current: model });
  }

  if (path === "/api/templates" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM prompt_templates WHERE active = 1 ORDER BY account_id, tone"
    ).all();
    return json({ templates: results });
  }
  const tplMatch = path.match(/^\/api\/templates\/(\d+)$/);
  if (tplMatch && method === "PUT") {
    const { body } = await request.json();
    const old = await env.DB.prepare("SELECT * FROM prompt_templates WHERE id = ?").bind(+tplMatch[1]).first();
    if (!old) return json({ error: "not found" }, 404);
    await env.DB.batch([
      env.DB.prepare("UPDATE prompt_templates SET active = 0 WHERE id = ?").bind(old.id),
      env.DB.prepare(
        "INSERT INTO prompt_templates (account_id, tone, version, body, active) VALUES (?, ?, ?, ?, 1)"
      ).bind(old.account_id, old.tone, old.version + 1, body)
    ]);
    return json({ ok: true, version: old.version + 1 });
  }

  // ---- insights ----
  if (path === "/api/insights" && method === "GET") return insights(env, url.searchParams.get("account"), url.searchParams.get("type"));

  // ---- per-call chat (TASK-105) ----
  const chatMatch = path.match(/^\/api\/calls\/(\d+)\/chat$/);
  if (chatMatch && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, role, body, updated_kind, created_at FROM chat_messages WHERE call_id = ? ORDER BY id"
    ).bind(+chatMatch[1]).all();
    return json({ messages: results });
  }
  if (chatMatch && method === "POST") {
    const callId = +chatMatch[1];
    const { message } = await request.json();
    if (!message || !message.trim()) return json({ error: "message required" }, 400);

    const call = await env.DB.prepare("SELECT * FROM calls WHERE id = ?").bind(callId).first();
    if (!call) return json({ error: "not found" }, 404);
    if (call.processing_status !== "processed") {
      return json({ error: "This call has not been generated yet — there is nothing to talk about." }, 400);
    }
    const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(call.account_id).first();
    const { results: outputs } = await env.DB.prepare("SELECT * FROM outputs WHERE call_id = ?").bind(callId).all();
    // Bounded history. An unbounded conversation re-sends every prior turn on every request, so
    // a long thread would grow the bill quadratically for no added usefulness.
    const { results: history } = await env.DB.prepare(
      "SELECT role, body FROM chat_messages WHERE call_id = ? ORDER BY id DESC LIMIT 20"
    ).bind(callId).all();
    history.reverse();

    const t0 = Date.now();
    let out;
    try {
      out = await chatTurn(env, { account, call, debrief: JSON.parse(call.debrief_json || "{}"),
        outputs, history, message: message.trim() });
    } catch (err) {
      await logEvent(env, { level: "error", kind: "chat.failed", call_id: callId, account_id: call.account_id,
        detail: String(err?.message || err) });
      return json({ error: String(err?.message || err) }, 502);
    }

    // Persist the user turn only once the model answered. Saving it first would leave an
    // unanswered question in the thread every time a request failed.
    await env.DB.prepare("INSERT INTO chat_messages (call_id, role, body) VALUES (?, 'user', ?)")
      .bind(callId, message.trim()).run();

    let updatedKind = null;
    if (out.updated) {
      const u = out.updated;
      // Replace the matching output IN PLACE. Matching on (kind, tone) rather than id because
      // the model is told which output it replaced, not our row ids.
      const row = await env.DB.prepare(
        "SELECT id FROM outputs WHERE call_id = ? AND kind = ? AND (tone IS ? OR tone = ?) LIMIT 1"
      ).bind(callId, u.kind, u.tone || null, u.tone || "").first();
      if (row) {
        await env.DB.prepare("UPDATE outputs SET body = ?, subject = COALESCE(?, subject) WHERE id = ?")
          .bind(u.body, u.subject || null, row.id).run();
        updatedKind = u.kind;
      }
    }
    await env.DB.prepare("INSERT INTO chat_messages (call_id, role, body, updated_kind) VALUES (?, 'assistant', ?, ?)")
      .bind(callId, out.reply, updatedKind).run();
    await logEvent(env, { kind: "chat.turn", call_id: callId, account_id: call.account_id,
      duration_ms: Date.now() - t0, usage: out.usage, model: out.model,
      detail: `${call.client_name}${updatedKind ? ` · rewrote ${updatedKind}` : ""}` });

    return json({ reply: out.reply, updatedKind });
  }

  // ---- backups ----
  // On demand, so a backup is something you can TAKE before a risky migration rather than only
  // something that happened at 2am. Same code path as the cron, so exercising this proves the
  // scheduled one works. POST because it writes; a GET would be pre-fetched by something one day.
  if (path === "/api/backup" && method === "POST") {
    const r = await runBackup(env);
    await logEvent(env, { kind: "backup.succeeded",
      detail: `${r.key} · ${(r.size / 1024).toFixed(0)}KB · ${r.tables} tables · ${r.rows} rows · manual` });
    return json({ ok: true, ...r });
  }
  if (path === "/api/backup" && method === "GET") {
    const listed = await env.BACKUPS.list({ prefix: "d1/" });
    return json({ backups: listed.objects
      .map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded }))
      .sort((a, b) => b.key.localeCompare(a.key)) });
  }

  // ---- spend (TASK-110) ----
  // Dollars, by day/week/month/year, split by model. Separate from /api/events on purpose:
  // Activity answers "is it working", Spend answers "what did it cost", and the last time
  // those two questions shared one surface the page grew three stat strips that disagreed.
  // ---- billing (TASK-122) ----
  //
  // ADMIN ONLY. Note that /api/stripe/webhook is NOT under this prefix and is handled above the
  // auth gate on purpose; if you move it under /api/billing it starts 401-ing Stripe.
  if (path === "/api/billing" && method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM billing ORDER BY account_id LIMIT 1").first();
    return json({
      billing: row || null,
      // What is missing, named. A blank billing page with no explanation is indistinguishable
      // from a broken one, and this is the page someone opens when a payment did not arrive.
      configured: {
        secretKey: Boolean(env.STRIPE_SECRET_KEY),
        webhookSecret: Boolean(env.STRIPE_WEBHOOK_SECRET),
        seatPrice: Boolean(env.STRIPE_PRICE_SEAT),
        activationPrice: Boolean(env.STRIPE_PRICE_ACTIVATION),
      },
    });
  }

  // Creates the link we send a buyer. Nothing is charged here and no card is touched: this
  // returns a URL on Stripe's domain and the buyer does the rest there.
  if (path === "/api/billing/checkout" && method === "POST") {
    const { email, seats, account_id, trial_days } = await request.json().catch(() => ({}));
    if (!email) return json({ error: "email required" }, 400);
    const n = Number(seats || 1);
    if (!Number.isInteger(n) || n < 1) return json({ error: "seats must be a whole number, 1 or more" }, 400);
    try {
      const sess = await createCheckoutSession(env, {
        email, seats: n, accountId: account_id ?? null,
        trialDays: trial_days ? Number(trial_days) : null, origin: url.origin,
      });
      await logEvent(env, { kind: "billing.checkout_created", account_id: account_id ?? null,
        detail: `${email} · ${n} seat${n === 1 ? "" : "s"}${trial_days ? ` · ${trial_days}d before the licence starts` : ""}` });
      return json({ ok: true, url: sess.url, id: sess.id });
    } catch (err) {
      return json({ error: String(err?.message || err) }, 400);
    }
  }

  // The Billing Portal is why we are not the billing department: the customer changes their own
  // card, downloads their own invoices and cancels themselves, on Stripe's pages.
  if (path === "/api/billing/portal" && method === "POST") {
    const row = await env.DB.prepare("SELECT * FROM billing WHERE stripe_customer_id IS NOT NULL ORDER BY account_id LIMIT 1").first();
    if (!row?.stripe_customer_id) return json({ error: "No Stripe customer yet — this account has not been through checkout." }, 400);
    try {
      const sess = await createPortalSession(env, { customerId: row.stripe_customer_id, returnUrl: url.origin });
      return json({ ok: true, url: sess.url });
    } catch (err) {
      return json({ error: String(err?.message || err) }, 400);
    }
  }

  // ---- the weekly report (TASK-120) ----
  //
  // ADMIN ONLY. `?format=html` returns the rendered email itself rather than JSON, because the
  // only way to know an email looks right is to look at it, and a JSON blob of numbers does not
  // answer that question. Reading code is not verification.
  if (path === "/api/report/weekly" && method === "GET") {
    const r = await weeklyReport(env);
    if (url.searchParams.get("format") === "html") {
      return new Response(renderWeeklyEmail(r, { appUrl: url.origin }),
        { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return json({ ...r, canSend: Boolean(env.EMAIL_API_KEY && env.REPORT_TO) });
  }

  // Sending is NOT implemented and this says so out loud rather than returning ok.
  //
  // Cloudflare Workers cannot open SMTP connections, so a weekly email needs an HTTP email
  // provider (Resend, Postmark) plus a verified sending domain. Both are accounts a human has to
  // create; see `2026-09-09 Nathan round/Third-party connections.md` §5.
  //
  // Failing closed with the reason is the same rule BYOK established on 2026-08-05: a feature
  // that quietly does nothing is indistinguishable from one that works, right up until someone
  // asks why the report never arrived.
  if (path === "/api/report/weekly/send" && method === "POST") {
    if (!env.EMAIL_API_KEY || !env.REPORT_TO) {
      await logEvent(env, { level: "warn", kind: "report.send_skipped",
        detail: "No email provider configured — set EMAIL_API_KEY and REPORT_TO. The report was generated but not sent." });
      return json({ ok: false, generated: true, sent: false,
        error: "No email provider is connected yet. The report generates and can be previewed, but sending needs an email service (Resend or Postmark) and a verified sending domain." }, 501);
    }
    return json({ ok: false, error: "Provider configured but the send adapter is not written yet." }, 501);
  }

  // ---- people: the manager tier (TASK-118) ----
  //
  // ADMIN ONLY, and the gate above is the boundary — this is every rep's scores in one place,
  // which is precisely the thing a member must not be able to open about their colleagues.
  //
  // `rep` is a query parameter rather than a path segment because the identifier is an email
  // address: `/api/people/gabriel@x.com` puts an @ and a dot in a path and gets mangled by
  // something eventually. Absent `rep` means the roster; `rep=` (empty) means the unattributed
  // group, which is a real group and not the same as "no filter".
  if (path === "/api/people" && method === "GET") {
    const view = url.searchParams.get("view") || "month";
    if (!WINDOWS[view]) return json({ error: `Unknown window "${view}".` }, 400);
    const acct = url.searchParams.get("account_id");
    const accountId = acct ? +acct : null;

    if (url.searchParams.has("rep")) {
      const rep = url.searchParams.get("rep") || null;   // "" -> null -> the unattributed group
      return json(await person(env, rep, { view, accountId }));
    }
    return json(await roster(env, { view, accountId }));
  }

  if (path === "/api/spend" && method === "GET") {
    const view = url.searchParams.get("view") || "day";
    const limit = +(url.searchParams.get("limit") || (view === "day" ? 30 : view === "week" ? 12 : view === "month" ? 12 : 5));
    const acct = await env.DB.prepare("SELECT llm_model FROM accounts ORDER BY id LIMIT 1").first();
    const currentModel = acct?.llm_model || DEFAULT_MODEL;

    const report = await spendReport(env, { view, limit });
    const rec = await reconcile(env, { fallbackModel: currentModel });

    // The live tail: days Closer has logged that no export covers yet. Shown as an ESTIMATE,
    // never folded into the imported total — the whole design rests on not blending a measured
    // number with an inferred one and presenting the result as a fact.
    const through = report.imported.to;
    const live = rec.days
      .filter(d => !through || d.date > through)
      .map(d => ({ date: d.date, usd: d.loggedUsd, tokensIn: d.loggedIn, tokensOut: d.loggedOut }));

    return json({
      ...report,
      live: {
        days: live,
        usd: live.reduce((s, d) => s + d.usd, 0),
        pricedAt: currentModel,   // history has no per-row model; see spend.js
        since: through,
      },
      reconciliation: rec.summary,
      reconciliationDays: rec.days.slice(-30),
      currentModel,
    });
  }

  // CSV in the body rather than multipart: the file is a few KB of text, the Worker has no
  // form parser, and this keeps the import path identical whether it comes from the UI or a
  // curl one-liner during a backfill.
  if (path === "/api/spend/import" && method === "POST") {
    const text = await request.text();
    if (!text || text.length < 20) return json({ error: "Paste or upload the CSV from platform.claude.com › Usage." }, 400);
    try {
      const r = await importUsage(env, text);
      await logEvent(env, { kind: "spend.imported",
        detail: `${r.rows} rows · ${r.from}..${r.to} · ${r.models.join(", ")}` });
      return json({ ok: true, ...r });
    } catch (err) {
      // A rejected import must say WHY. An import that silently drops rows shows up later as
      // a month that looks cheap, which is the failure mode this whole page exists to prevent.
      await logEvent(env, { level: "warn", kind: "spend.import_failed", detail: String(err?.message || err) });
      return json({ error: String(err?.message || err) }, 400);
    }
  }

  // ---- events / activity log ----
  if (path === "/api/events" && method === "GET") {
    const level = url.searchParams.get("level");
    const kind = url.searchParams.get("kind");
    const limit = Math.min(500, Math.max(1, +(url.searchParams.get("limit") || 100)));
    const where = [], binds = [];
    if (level) { where.push("level = ?"); binds.push(level); }
    if (kind) { where.push("kind LIKE ?"); binds.push(kind + "%"); }
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY at DESC, id DESC LIMIT ?`;
    const { results } = await env.DB.prepare(sql).bind(...binds, limit).all();
    const totals = await env.DB.prepare(
      `SELECT COUNT(*) AS runs, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
              AVG(duration_ms) AS avg_ms
       FROM events WHERE kind = 'generation.succeeded'`
    ).first();
    const fails = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE level = 'error'").first();

    // TASK-102. Gabriel said generation fails "more often than not" and nobody could check,
    // because the only counter here was every error-level event of any kind. This answers the
    // actual question, and it MUST count `started` rather than just succeeded-vs-failed:
    // this app's whole history of outages (TASK-041, 043, 045) is runs that died leaving no
    // failure row at all. A run that vanished is invisible to `generation.failed` and is
    // exactly the kind Gabriel would remember. started - succeeded - failed = vanished.
    // `attempts` is the retry counter (TASK-053) and is the honest answer to "are we billed
    // for the ones that fail" — every attempt is a real request that bills for what it produced.
    const rel = await env.DB.prepare(
      `SELECT
         COALESCE(SUM(kind = 'generation.started'),0)   AS started,
         COALESCE(SUM(kind = 'generation.succeeded'),0) AS succeeded,
         COALESCE(SUM(kind = 'generation.failed'),0)    AS failed,
         COALESCE(SUM(kind = 'generation.attempt'),0)   AS attempts,
         COALESCE(SUM(kind = 'generation.started'   AND at >= date('now','-30 days')),0) AS d30_started,
         COALESCE(SUM(kind = 'generation.succeeded' AND at >= date('now','-30 days')),0) AS d30_succeeded,
         COALESCE(SUM(kind = 'generation.failed'    AND at >= date('now','-30 days')),0) AS d30_failed,
         COALESCE(SUM(kind = 'generation.attempt'   AND at >= date('now','-30 days')),0) AS d30_attempts
       FROM events WHERE kind LIKE 'generation.%'`
    ).first();
    const window = (s, ok, f, a) => ({
      started: s, succeeded: ok, failed: f, attempts: a,
      // Clamped: a run that started before this window but finished inside it would otherwise
      // push this negative, which would read as a bug rather than as a boundary effect.
      vanished: Math.max(0, s - ok - f),
    });
    const reliability = {
      all: window(rel?.started || 0, rel?.succeeded || 0, rel?.failed || 0, rel?.attempts || 0),
      d30: window(rel?.d30_started || 0, rel?.d30_succeeded || 0, rel?.d30_failed || 0, rel?.d30_attempts || 0),
    };
    // Rolling spend so cost is visible without exporting the log. One pass over the same rows —
    // separate queries per window would scan events four times for the same answer.
    // NOTE: this is OUR logged token spend, not Anthropic's billed total. Anthropic exposes real
    // cost only through the Admin API (a separate sk-ant-admin key), and exposes account balance
    // nowhere at all — see TASK-076.
    const w = await env.DB.prepare(
      `SELECT
         COUNT(*) AS runs,
         COALESCE(SUM(input_tokens),0)  AS input_tokens,
         COALESCE(SUM(output_tokens),0) AS output_tokens,
         COALESCE(SUM(CASE WHEN at >= date('now')                  THEN 1 ELSE 0 END),0) AS d_runs,
         COALESCE(SUM(CASE WHEN at >= date('now')                  THEN input_tokens  ELSE 0 END),0) AS d_in,
         COALESCE(SUM(CASE WHEN at >= date('now')                  THEN output_tokens ELSE 0 END),0) AS d_out,
         COALESCE(SUM(CASE WHEN at >= date('now') THEN cache_read_tokens  ELSE 0 END),0) AS d_cr,
         COALESCE(SUM(CASE WHEN at >= date('now') THEN cache_write_tokens ELSE 0 END),0) AS d_cw,
         COALESCE(SUM(CASE WHEN at >= date('now','-7 days')         THEN 1 ELSE 0 END),0) AS w_runs,
         COALESCE(SUM(CASE WHEN at >= date('now','-7 days')         THEN input_tokens  ELSE 0 END),0) AS w_in,
         COALESCE(SUM(CASE WHEN at >= date('now','-7 days')         THEN output_tokens ELSE 0 END),0) AS w_out,
         COALESCE(SUM(CASE WHEN at >= date('now','-7 days') THEN cache_read_tokens  ELSE 0 END),0) AS w_cr,
         COALESCE(SUM(CASE WHEN at >= date('now','-7 days') THEN cache_write_tokens ELSE 0 END),0) AS w_cw,
         COALESCE(SUM(CASE WHEN at >= date('now','start of month')  THEN 1 ELSE 0 END),0) AS m_runs,
         COALESCE(SUM(CASE WHEN at >= date('now','start of month')  THEN input_tokens  ELSE 0 END),0) AS m_in,
         COALESCE(SUM(CASE WHEN at >= date('now','start of month')  THEN output_tokens ELSE 0 END),0) AS m_out
       FROM events WHERE kind = 'generation.succeeded'`
    ).first();
    const today = { runs: w?.d_runs || 0, input_tokens: w?.d_in || 0, output_tokens: w?.d_out || 0,
                    cache_read_tokens: w?.d_cr || 0, cache_write_tokens: w?.d_cw || 0 };
    const week  = { runs: w?.w_runs || 0, input_tokens: w?.w_in || 0, output_tokens: w?.w_out || 0,
                    cache_read_tokens: w?.w_cr || 0, cache_write_tokens: w?.w_cw || 0 };
    const month = { runs: w?.m_runs || 0, input_tokens: w?.m_in || 0, output_tokens: w?.m_out || 0,
                    cache_read_tokens: w?.m_cr || 0, cache_write_tokens: w?.m_cw || 0 };
    // The model this account actually runs on, so the UI can price spend at the right rate
    // instead of the Sonnet 5 constant it was hardcoded to before TASK-098 made model a setting.
    const acct = await env.DB.prepare("SELECT llm_model FROM accounts ORDER BY id LIMIT 1").first();
    const mid = acct?.llm_model || DEFAULT_MODEL;
    const mspec = MODELS[mid] || MODELS[DEFAULT_MODEL];
    // Rates ride along so the Activity view prices spend without a second round trip — and so
    // there is no second copy of the price table in the front-end to drift out of date.
    const model = { id: mid, label: mspec.label, inPerM: mspec.inPerM, outPerM: mspec.outPerM };
    return json({
      events: results, totals: { ...totals, failures: fails?.n || 0 }, today, week, month,
      reliability, model,
    });
  }

  // ---- suggestions ----
  if (path === "/api/suggestions" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM suggestions ORDER BY created_at DESC LIMIT 50"
    ).all();
    return json({ suggestions: results });
  }
  const sugMatch = path.match(/^\/api\/suggestions\/(\d+)$/);
  if (sugMatch && method === "PATCH") {
    const { status } = await request.json();
    await env.DB.prepare("UPDATE suggestions SET status = ? WHERE id = ?").bind(status, +sugMatch[1]).run();
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

const CALL_LIST_SQL = `
  SELECT c.id, c.account_id, c.client_name, c.occurred_at, c.duration_min, c.source, c.outcome,
         c.callback_note, c.processed_at, c.processing_status, c.processing_error, c.archived_at,
         c.attendee_name,
         a.name AS account_name, si.label AS source_label,
         c.call_type_id, ct.name AS call_type_name, c.duplicate_of,
         COALESCE(o.sms_sent, 0) AS sms_sent, COALESCE(o.email_sent, 0) AS email_sent
  FROM calls c
  JOIN accounts a ON a.id = c.account_id
  LEFT JOIN integrations si ON si.id = c.source_integration_id
  LEFT JOIN call_types ct ON ct.id = c.call_type_id
  -- One grouped pass instead of two correlated subqueries PER ROW (TASK-052).
  LEFT JOIN (
    SELECT call_id,
           SUM(CASE WHEN kind='sms'   AND sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sms_sent,
           SUM(CASE WHEN kind='email' AND sent_at IS NOT NULL THEN 1 ELSE 0 END) AS email_sent
    FROM outputs GROUP BY call_id
  ) o ON o.call_id = c.id`;

// ---------- auth handlers ----------


// Applies a verified Stripe event. Split out from the route so the signature check and the
// business logic cannot accidentally be reordered, and so this is readable on its own.
//
// Returns 200 for anything it does not act on. A non-2xx makes Stripe retry for three days, so
// answering "I do not handle customer.discount.created" with an error creates three days of
// pointless traffic and an alarming failure count in their dashboard.
async function handleStripeEvent(env, raw) {
  let event; try { event = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
  const type = event?.type;
  const obj = event?.data?.object || {};

  // Idempotency FIRST, before any effect. Stripe does not guarantee ordering and will redeliver:
  // it retries for three days on a non-2xx and the dashboard can resend by hand. Provisioning
  // twice on a duplicate checkout.session.completed is the failure this prevents.
  // A duplicate is a 200, not an error — the delivery genuinely succeeded, we just did it already.
  try {
    await env.DB.prepare("INSERT INTO billing_events (stripe_event_id, type) VALUES (?, ?)")
      .bind(event.id, type || "unknown").run();
  } catch {
    return json({ ok: true, duplicate: true });
  }

  if (!HANDLED_EVENTS.includes(type)) return json({ ok: true, ignored: type });

  const access = accessFromEvent(type, obj);
  if (!access) return json({ ok: true, ignored: type });

  // Which account? `client_reference_id` and metadata are set when we create the checkout, so a
  // payment made on Stripe's domain can be matched to a row here. Falling back to the customer id
  // covers renewals, where the invoice carries no metadata of ours.
  const accountId = Number(obj.client_reference_id || obj.metadata?.account_id || event?.data?.object?.subscription_details?.metadata?.account_id) || null;
  const customerId = typeof obj.customer === "string" ? obj.customer : obj.customer?.id || null;
  const subscriptionId = typeof obj.subscription === "string" ? obj.subscription
    : (type.startsWith("customer.subscription") ? obj.id : null);
  const seats = Number(obj.metadata?.seats) || obj.items?.data?.[0]?.quantity || null;
  const periodEnd = obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null;

  const target = accountId
    ?? (await env.DB.prepare("SELECT account_id FROM billing WHERE stripe_customer_id = ?").bind(customerId).first())?.account_id
    ?? (await env.DB.prepare("SELECT id FROM accounts ORDER BY id LIMIT 1").first())?.id
    ?? null;

  if (!target) {
    // Never silently drop a paid event. Somebody paid us and we could not say who.
    await logEvent(env, { level: "error", kind: "stripe.unmatched_event",
      detail: `${type} for customer ${customerId || "?"} could not be matched to an account — money may have moved with nothing provisioned.` });
    return json({ ok: true, unmatched: true });
  }

  await env.DB.prepare(
    `INSERT INTO billing (account_id, stripe_customer_id, stripe_subscription_id, status, seats, current_period_end, billing_email, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(account_id) DO UPDATE SET
       stripe_customer_id     = COALESCE(excluded.stripe_customer_id, billing.stripe_customer_id),
       stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, billing.stripe_subscription_id),
       status                 = excluded.status,
       seats                  = COALESCE(excluded.seats, billing.seats),
       current_period_end     = COALESCE(excluded.current_period_end, billing.current_period_end),
       billing_email          = COALESCE(excluded.billing_email, billing.billing_email),
       updated_at             = datetime('now')`
  ).bind(target, customerId, subscriptionId, access.status, seats, periodEnd,
         obj.customer_email || obj.customer_details?.email || null).run();

  await env.DB.prepare("UPDATE billing_events SET account_id = ? WHERE stripe_event_id = ?")
    .bind(target, event.id).run();

  await logEvent(env, {
    level: access.status === "past_due" ? "warn" : "info",
    kind: `billing.${type.replace(/[.]/g, "_")}`, account_id: target,
    detail: `${type} → ${access.status}${seats ? ` · ${seats} seats` : ""}${periodEnd ? ` · paid through ${periodEnd.slice(0, 10)}` : ""}` });

  return json({ ok: true, status: access.status });
}

async function setup(request, env) {
  const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  if (existing.n > 0) return json({ error: "already set up" }, 403);
  const { email, password } = await request.json();
  if (!email || !password || password.length < 8) return json({ error: "email + password (8+ chars) required" }, 400);
  const { hash, salt } = await hashPassword(password);
  // The first-run user OWNS the deployment, so they are the admin. This was previously left to
  // the column default -- 'member' -- and it worked in production only by accident of ordering:
  // migration 0019 promoted MIN(id) at migration time, and production's user already existed.
  //
  // On a FRESH deployment setup runs AFTER migrations, so the owner was created as a member and
  // locked out of Integrations, Spend, Users and People. That is not a dev annoyance: Integrations
  // is where a new tenant pastes the Anthropic key without which the product cannot generate at
  // all. The first customer to onboard would have been unable to finish onboarding.
  // Found 2026-09-09 on a fresh local database.
  await env.DB.prepare("INSERT INTO users (email, pw_hash, pw_salt, role) VALUES (?, ?, ?, 'admin')")
    .bind(email, hash, salt).run();
  return startSession(env, email);
}

async function login(request, env) {
  const { email, password } = await request.json();
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  if (!user || !(await verifyPassword(password, user.pw_salt, user.pw_hash))) {
    return json({ error: "invalid credentials" }, 401);
  }
  return startSession(env, email);
}

async function startSession(env, email) {
  // `role` must be in the login response, not just in /api/me (TASK-112). The front end sets
  // state.user straight from this payload and immediately calls applyRoleVisibility(); without
  // the role an ADMIN who has just signed in is treated as a member and loses Spend and
  // Integrations from their own menu until they reload. Caught in the browser, not by a test —
  // every assertion still passed.
  const user = await env.DB.prepare(
    "SELECT id, email, COALESCE(role, 'member') AS role FROM users WHERE email = ?").bind(email).first();
  const token = newSessionToken();
  const maxAge = 30 * 24 * 3600;
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))")
    .bind(token, user.id).run();
  return json({ user }, 200, { "Set-Cookie": sessionCookie(token, maxAge) });
}

async function logout(request, env) {
  const token = readSessionToken(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
}

// ---------- call handlers ----------

async function getCall(env, id) {
  const call = await env.DB.prepare(
    "SELECT c.*, a.name AS account_name, a.llm_provider, si.label AS source_label, ct.name AS call_type_name FROM calls c JOIN accounts a ON a.id = c.account_id LEFT JOIN integrations si ON si.id = c.source_integration_id LEFT JOIN call_types ct ON ct.id = c.call_type_id WHERE c.id = ?"
  ).bind(id).first();
  if (!call) return json({ error: "not found" }, 404);
  const { results: outputs } = await env.DB.prepare("SELECT * FROM outputs WHERE call_id = ?").bind(id).all();
  return json({ call, outputs });
}

async function patchCall(request, env, id) {
  const body = await request.json();
  const allowed = ["selected_tone", "outcome", "callback_note", "client_name", "call_type_id"];
  const sets = [], vals = [];
  for (const k of allowed) if (k in body) { sets.push(`${k} = ?`); vals.push(body[k]); }
  if (!sets.length) return json({ error: "nothing to update" }, 400);
  // Stamp a manual rename so the title backfill can never overwrite a name a human chose.
  if ("client_name" in body) sets.push("renamed_at = datetime('now')");
  await env.DB.prepare(`UPDATE calls SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
  return json({ ok: true });
}

// Archive is a VIEW change, not a data change: nothing is moved or dropped, the row simply
// stops appearing in the working inbox. Instant and reversible.
async function setArchived(request, env, id) {
  const { archived } = await request.json();
  const call = await env.DB.prepare("SELECT id, client_name FROM calls WHERE id = ?").bind(id).first();
  if (!call) return json({ error: "not found" }, 404);
  await env.DB.prepare("UPDATE calls SET archived_at = ? WHERE id = ?")
    .bind(archived ? new Date().toISOString() : null, id).run();
  await logEvent(env, { kind: archived ? "call.archived" : "call.unarchived", call_id: id, detail: call.client_name });
  return json({ ok: true, archived: !!archived });
}

// Permanent. Archive is the reversible option; delete means delete — a soft-delete that
// secretly keeps the row would be exactly wrong if a client asks to be removed.
async function deleteCall(env, id) {
  const call = await env.DB.prepare("SELECT * FROM calls WHERE id = ?").bind(id).first();
  if (!call) return json({ error: "not found" }, 404);

  // Don't delete a call out from under a running Workflow: the step would then fail on a
  // vanished row and write a confusing error, and we would have paid for nothing.
  if (call.processing_status === "processing") {
    const started = call.processing_started_at ? Date.parse(call.processing_started_at + "Z") : 0;
    if (started && Date.now() - started < STALE_PROCESSING_MS) {
      return json({ error: "This call is generating right now — wait for it to finish, then delete." }, 409);
    }
  }

  // Log BEFORE the row disappears, and deliberately keep the event afterwards: events.call_id
  // has no FK precisely so the audit trail outlives what it describes.
  await logEvent(env, { level: "warn", kind: "call.deleted", call_id: id, account_id: call.account_id,
    detail: `${call.client_name} · ${(call.transcript || "").length.toLocaleString()} chars · permanently deleted`,
    meta: { occurred_at: call.occurred_at, external_id: call.external_id, source: call.source } });

  // No ON DELETE CASCADE exists (checked migrations/0001), so dependants must go explicitly
  // and in FK order: edits -> outputs -> call. Skipping this leaves silent orphans.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM edits WHERE output_id IN (SELECT id FROM outputs WHERE call_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM outputs WHERE call_id = ?").bind(id),
    env.DB.prepare("DELETE FROM calls WHERE id = ?").bind(id)
  ]);
  return json({ ok: true, deleted: id });
}

async function createCall(request, env, ctx, user) {
  const { account_id, client_name, transcript, occurred_at } = await request.json();
  if (!account_id || !client_name || !transcript) return json({ error: "account_id, client_name, transcript required" }, 400);
  // Capture the real call date when given (TASK-034); fall back to now for a same-day paste.
  // Normalise a date-only value (YYYY-MM-DD) to an ISO instant so ordering is stable.
  let when = "datetime('now')", bindWhen = null;
  if (occurred_at && /^\d{4}-\d{2}-\d{2}/.test(occurred_at)) {
    when = "?"; bindWhen = occurred_at.length === 10 ? occurred_at + "T12:00:00Z" : occurred_at;
  }
  // A manual paste is attributed to whoever pasted it (TASK-117). This is the only record of
  // who ran that call -- nothing in a pasted transcript says so -- and guessing from the account
  // owner would fabricate attribution the same way `events.model` fabricated a model name.
  // `user` is passed in from the router, which already resolved it. Reading it off `request`
  // would have been silently undefined forever -- every paste attributed to nobody, no error.
  const repEmail = user?.email || null;
  const stmt = `INSERT INTO calls (account_id, client_name, occurred_at, transcript, source, rep_email) VALUES (?, ?, ${when}, ?, 'manual', ?) RETURNING id`;
  const binds = bindWhen
    ? [account_id, client_name, bindWhen, transcript, repEmail]
    : [account_id, client_name, transcript, repEmail];
  const res = await env.DB.prepare(stmt).bind(...binds).first();
  return startProcessing(env, res.id, ctx);
}

// Generation is slow (4 LLM calls). Running it inline in the request meant a client
// disconnect could cancel it, and because processed_at was only written at the very end,
// a killed run was indistinguishable from one that never started. Now: mark 'processing',
// hand the work to ctx.waitUntil so it survives the client leaving, and return at once.
const STALE_PROCESSING_MS = 10 * 60 * 1000;

// Launches a generation. Shared by the Generate button and the Fathom cron, so both go
// through the same double-spend guard. Returns { ok, already?, reason?, workflowId? }.
async function launchGeneration(env, call) {
  if (!call.transcript) return { ok: false, reason: "call has no transcript" };

  // Guard against double spend: a second Generate while one is already in flight
  // would fire another 4 paid LLM calls. Allow retry only once a run is clearly stale.
  if (call.processing_status === "processing") {
    const started = call.processing_started_at ? Date.parse(call.processing_started_at + "Z") : 0;
    if (started && Date.now() - started < STALE_PROCESSING_MS) {
      return { ok: true, already: true, reason: "already generating" };
    }
    // else: stale (worker died mid-run) — fall through and retry
  }

  await env.DB.prepare(
    `UPDATE calls SET processing_status = 'processing', processing_started_at = datetime('now'),
            processing_error = NULL, processing_progress = 0, processing_step = 'Starting' WHERE id = ?`
  ).bind(call.id).run();

  await logEvent(env, { kind: "generation.started", call_id: call.id, account_id: call.account_id,
    detail: `${call.client_name} · ${(call.transcript || "").length.toLocaleString()} chars` });

  // Hand off to a Workflow, NOT ctx.waitUntil. waitUntil is capped at 30 seconds after the
  // response is sent (Cloudflare's documented limit), which is why every run in this
  // project's history died at 0:30. See src/workflow.js.
  const instance = await env.GENERATE.create({ params: { callId: call.id } });
  await env.DB.prepare("UPDATE calls SET processing_workflow_id = ? WHERE id = ?")
    .bind(instance.id, call.id).run();
  return { ok: true, workflowId: instance.id };
}

async function startProcessing(env, id, ctx) {
  const call = await env.DB.prepare("SELECT * FROM calls WHERE id = ?").bind(id).first();
  if (!call) return json({ error: "not found" }, 404);

  const r = await launchGeneration(env, call);
  if (!r.ok) return json({ error: r.reason }, 400);
  if (r.already) return json({ ok: true, status: "processing", already: true,
    message: "Already generating — hang tight." }, 202);
  return json({ ok: true, status: "processing", workflow_id: r.workflowId }, 202);
}

// ---------- output edit capture ----------

async function patchOutput(request, env, id) {
  const { body, subject } = await request.json();
  const out = await env.DB.prepare(
    "SELECT o.*, c.account_id FROM outputs o JOIN calls c ON c.id = o.call_id WHERE o.id = ?"
  ).bind(id).first();
  if (!out) return json({ error: "not found" }, 404);

  const changed = (body !== undefined && body !== out.body) || (subject !== undefined && subject !== out.subject);
  if (!changed) return json({ ok: true, unchanged: true });

  await env.DB.batch([
    env.DB.prepare("UPDATE outputs SET body = COALESCE(?, body), subject = COALESCE(?, subject), updated_at = datetime('now') WHERE id = ?")
      .bind(body ?? null, subject ?? null, id),
    // capture the edit for the Sunday learning pass
    env.DB.prepare("INSERT INTO edits (output_id, account_id, kind, tone, original, edited) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, out.account_id, out.kind, out.tone, out.body, body ?? out.body)
  ]);
  return json({ ok: true });
}

// ---------- Fathom ----------
// API verified against developers.fathom.ai (2026-07-16), not inferred.

const FATHOM_BASE = "https://api.fathom.ai/external/v1";

// Flatten Fathom's structured transcript into the same "0:02 — Name: text" shape
// the app already uses for pasted transcripts.
function flattenTranscript(t) {
  if (!Array.isArray(t)) return "";
  return t.map(l => `${l.timestamp || ""} — ${l.speaker?.display_name || "Unknown"}: ${l.text || ""}`).join("\n");
}

// The client is the external invitee — Gabriel is the internal one recording.
// Naming rules live in ./naming.js so they can be unit-tested — see that file for why.

// Imports EXACTLY ONE call: the most recent within `days`. Bounded by created_after
// so it is structurally incapable of pulling full history. Lands unprocessed —
// import must never trigger LLM generation (see TASK-033).
// Fetches meetings from Fathom. Returns { ok, items } or { ok:false, message } — the caller
// decides whether that becomes an HTTP response or a log line, so the manual pull and the
// cron share one implementation rather than drifting apart.
async function fetchFathomMeetings(key, sinceIso, ownerEmail, { includeTranscript = true } = {}) {
  // recorded_by[] limits results to THIS person's recordings. Without it Fathom returns the
  // whole org's meetings (documented behaviour) — see TASK-063.
  const scope = ownerEmail ? `&recorded_by[]=${encodeURIComponent(ownerEmail)}` : "";
  // The URL backfill needs metadata only. Defaulting to true keeps the poller unchanged; passing
  // false stops a backfill from re-downloading 134 transcripts to fill in a link, which is both
  // wasteful and re-fetches other people's words for no reason.
  const url = `${FATHOM_BASE}/meetings?created_after=${encodeURIComponent(sinceIso)}&include_transcript=${includeTranscript ? "true" : "false"}${scope}`;
  let data;
  try {
    const res = await fetch(url, { headers: { "X-Api-Key": key }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      return { ok: false, message: res.status === 401 || res.status === 403
        ? `Fathom rejected the key (${res.status}).`
        : `Fathom returned ${res.status}.` };
    }
    data = await res.json();
  } catch (err) {
    return { ok: false, message: `Could not reach Fathom: ${err.message}` };
  }
  // Distinguish "no calls" from "the response isn't the shape we expect". Treating a
  // shape mismatch as an empty list would report "no calls" when parsing actually failed.
  if (!Array.isArray(data.items)) {
    return { ok: false, message:
      `Unexpected response from Fathom — no 'items' array (got: ${Object.keys(data || {}).join(", ") || "nothing"}). The API shape may have changed.` };
  }
  return { ok: true, items: data.items };
}

// Fathom does NOT document sort order — never trust items[0]. Sort ourselves.
const meetingWhen = m => m.recording_start_time || m.scheduled_start_time || m.created_at || "";
const newestFirst = items => items.slice().sort((a, b) => String(meetingWhen(b)).localeCompare(String(meetingWhen(a))));

// Inserts one meeting. Idempotent via the unique (account_id, external_id) index.
// Returns { imported, callId, name, reason }.
// Suggest a call type from signals we already have — costs nothing, no API call (TASK-059).
// It only SUGGESTS: whatever it picks is editable, and Generate always shows the chosen type.
async function suggestCallType(env, accountId, m, transcript) {
  const types = await env.DB.prepare(
    "SELECT id, name, is_default FROM call_types WHERE account_id = ? AND archived_at IS NULL"
  ).bind(accountId).all();
  const byName = n => (types.results || []).find(t => t.name.toLowerCase().startsWith(n));
  const fallback = (types.results || []).find(t => t.is_default) || (types.results || [])[0];

  const invitees = m.calendar_invitees || [];
  const externals = invitees.filter(i => i.is_external).length;
  const t = (transcript || "").toLowerCase().slice(0, 60000);
  const hits = words => words.reduce((n, w) => n + (t.split(w).length - 1), 0);

  // No external attendee at all => almost certainly internal.
  if (invitees.length && externals === 0) return (byName("internal") || fallback)?.id ?? null;

  const internalScore = hits(["standup", "stand-up", "sprint", "roadmap", "our team", "internal",
    "sync up", "kpi", "headcount", "hiring", "team meeting"]);
  const vendorScore = hits(["invoice", "contract terms", "sow", "statement of work", "vendor",
    "supplier", "renewal", "procurement"]);
  const salesScore = hits(["objection", "investment", "price", "pricing", "sign up", "get started",
    "guarantee", "close", "deposit", "payment plan", "book a call"]);

  if (internalScore >= 4 && internalScore > salesScore) return (byName("internal") || fallback)?.id ?? null;
  if (vendorScore >= 3 && vendorScore > salesScore) return (byName("vendor") || fallback)?.id ?? null;
  return fallback?.id ?? null;
}

async function importMeeting(env, integ, m) {
  const accountId = integ.account_id;
  const externalId = String(m.recording_id);
  const existing = await env.DB.prepare(
    "SELECT id, client_name FROM calls WHERE account_id = ? AND external_id = ?"
  ).bind(accountId, externalId).first();
  if (existing) return { imported: false, callId: existing.id, name: existing.client_name, reason: "already imported" };

  const transcript = flattenTranscript(m.transcript);
  // Do NOT insert a transcript-less call: external_id dedupe would then block re-import once
  // Fathom finishes transcribing, and the call would be stranded empty forever. Skipping means
  // a later poll picks it up properly.
  if (!transcript.trim()) return { imported: false, reason: "no transcript yet" };

  const start = m.recording_start_time || m.scheduled_start_time || m.created_at;
  const end = m.recording_end_time || m.scheduled_end_time;
  const durationMin = start && end ? Math.max(1, Math.round((new Date(end) - new Date(start)) / 60000)) : null;
  const name = deriveClientName(m);

  // Possible duplicate? (TASK-064) One group call recorded by several attendees arrives as
  // several recordings with DIFFERENT recording_ids, so external_id dedupe cannot see it.
  // Flag, never auto-discard — Gabriel: "maybe it tells you, hey, this is a duplicate".
  // recorded_by[] scoping (TASK-063) removes most of these; this catches the residue.
  const dup = start ? await env.DB.prepare(
    `SELECT id FROM calls
      WHERE account_id = ? AND archived_at IS NULL
        AND ABS((julianday(occurred_at) - julianday(?)) * 1440) <= 20
      ORDER BY ABS((julianday(occurred_at) - julianday(?)) * 1440) LIMIT 1`
  ).bind(accountId, start, start).first() : null;

  const suggestedType = await suggestCallType(env, accountId, m, transcript);

  // Who ran the call (TASK-117). `recorded_by` has always been in this payload -- the preview
  // endpoint reads it and the manual-import log prints it -- and we threw it away at INSERT.
  // Falling back to the integration's owner_email is safe rather than a guess: the poll is
  // scoped by `recorded_by[]=owner_email`, so a recording that reached here was recorded by
  // that owner. Both can be null; null is honest and a later join can fill it.
  const repEmail = m.recorded_by?.email || integ.owner_email || null;

  // The link back into the recording (TASK-123). `share_url` first: the core use is a MANAGER
  // opening a rep's call, and `url` is the owner's own view. external_id is Fathom's numeric
  // recording id and their public URLs use an opaque token, so this cannot be derived -- storing
  // what the API returns is the only correct option. Null is fine; the moment renders as text.
  const recordingUrl = m.share_url || m.url || null;

  const ins = await env.DB.prepare(
    `INSERT INTO calls (account_id, client_name, attendee_name, occurred_at, duration_min, transcript, source, external_id, source_integration_id, duplicate_of, call_type_id, rep_email, recording_url)
     VALUES (?, ?, ?, ?, ?, ?, 'fathom', ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(accountId, name, deriveAttendeeName(m), start, durationMin, transcript, externalId, integ.id, dup?.id ?? null, suggestedType, repEmail, recordingUrl).first();
  if (dup) {
    await logEvent(env, { level: "warn", kind: "call.possible_duplicate", call_id: ins.id, account_id: accountId,
      detail: `${name} overlaps call #${dup.id} (within 20 min) — flagged, not discarded` });
  }

  await logEvent(env, { kind: "fathom.imported", call_id: ins.id, account_id: accountId,
    detail: `${name} · ${transcript.length.toLocaleString()} chars · ${durationMin ?? "?"} min`,
    meta: { recording_id: externalId, occurred_at: start } });
  return { imported: true, callId: ins.id, name, occurred_at: start };
}

// Read-only diagnostic (TASK-081). Lists what Fathom holds for this key over `days`, WITHOUT
// the recorded_by[] scope, and marks each row imported / not-imported and who recorded it.
// Deliberately:
//   - include_transcript=false — a colleague's transcript is never fetched, held, or stored
//   - no INSERTs of any kind
//   - metadata only (when, title, who recorded, duration)
// This exists so "are we missing calls?" can be answered by looking, instead of by widening the
// import and hoovering up the whole org — which is the thing Gabriel noticed and objected to.
async function fathomPreview(env, id, days = 3) {
  const row = await env.DB.prepare("SELECT * FROM integrations WHERE id = ?").bind(id).first();
  if (!row || row.kind !== "fathom") return json({ error: "not a Fathom integration" }, 400);
  const key = keyForRow(row);
  if (!key) return json({ ok: false, message: "No Fathom key saved yet." });

  const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
  const url = `${FATHOM_BASE}/meetings?created_after=${encodeURIComponent(sinceIso)}&include_transcript=false`;
  let data;
  try {
    const res = await fetch(url, { headers: { "X-Api-Key": key }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return json({ ok: false, message: `Fathom returned ${res.status}.` });
    data = await res.json();
  } catch (err) {
    return json({ ok: false, message: `Could not reach Fathom: ${err.message}` });
  }
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];

  const owner = (row.owner_email || "").toLowerCase();
  const out = [];
  for (const m of items) {
    const externalId = String(m.recording_id ?? m.id ?? "");
    const hit = externalId
      ? await env.DB.prepare("SELECT id FROM calls WHERE external_id = ? LIMIT 1").bind(externalId).first()
      : null;
    const by = m.recorded_by || {};
    const byEmail = (by.email || "").toLowerCase();
    out.push({
      external_id: externalId,
      title: m.title || m.meeting_title || "(untitled)",
      occurred_at: m.scheduled_start_time || m.started_at || m.created_at || null,
      duration_min: m.duration_minutes ?? null,
      recorded_by: by.email || by.name || "(unknown)",
      imported: !!hit,
      call_id: hit?.id ?? null,
      // The two reasons a call legitimately never arrives.
      // Who recorded it is already its own column — repeating it here just made the row noisy.
      // The useful signal is simply that it isn't Gabriel's, so it wasn't pulled automatically.
      skipped_reason: hit ? null
        : (owner && byEmail && byEmail !== owner) ? "not yours — import if you want it"
        : null
    });
  }
  out.sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
  return json({ ok: true, label: row.label, owner_email: row.owner_email, days,
                total: out.length,
                imported: out.filter(x => x.imported).length,
                missing: out.filter(x => !x.imported).length,
                meetings: out });
}

// One-off repair for calls imported before titles were stored (TASK-082). Fetches METADATA
// ONLY (include_transcript=false) and rewrites client_name to the Fathom meeting title.
//
// Two guards, because this rewrites a user-visible field:
//   - never touches a row with renamed_at set (a human chose that name)
//   - never touches a row whose current name isn't exactly the attendee name we would have
//     derived — i.e. it only "un-does" its own old behaviour and leaves anything else alone
// Returns what it changed and what it deliberately left, so the result is auditable.
// Import ONE specific recording, chosen by hand from the preview (TASK-083).
//
// This is the deliberate alternative to dropping recorded_by[] from the poller. The cron stays
// scoped to Gabriel's own recordings; when Ivan sees a colleague's call he actually wants, he
// imports that one. Nothing arrives because it happened to be in the org.
async function fathomImportOne(env, id, externalId) {
  const row = await env.DB.prepare("SELECT * FROM integrations WHERE id = ?").bind(id).first();
  if (!row || row.kind !== "fathom") return json({ error: "not a Fathom integration" }, 400);
  const key = keyForRow(row);
  if (!key) return json({ ok: false, message: "No Fathom key saved yet." });

  const existing = await env.DB.prepare(
    "SELECT id, client_name FROM calls WHERE account_id = ? AND external_id = ?"
  ).bind(row.account_id, String(externalId)).first();
  if (existing) return json({ ok: true, imported: false, call_id: existing.id,
                              message: `Already in the app: ${existing.client_name}` });

  // Deliberately unscoped: the whole point is to reach a recording the automatic poll skips.
  // Bounded to 30 days so this can't become a whole-history pull.
  const sinceIso = new Date(Date.now() - 30 * 86400_000).toISOString();
  let data;
  try {
    const res = await fetch(
      `${FATHOM_BASE}/meetings?created_after=${encodeURIComponent(sinceIso)}&include_transcript=true`,
      { headers: { "X-Api-Key": key }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return json({ ok: false, message: `Fathom returned ${res.status}.` });
    data = await res.json();
  } catch (err) { return json({ ok: false, message: `Could not reach Fathom: ${err.message}` }); }

  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
  const m = items.find(x => String(x.recording_id ?? x.id ?? "") === String(externalId));
  if (!m) return json({ ok: false, message: "Fathom no longer lists that recording." });

  const r = await importMeeting(env, row, m);
  if (!r.imported) {
    return json({ ok: true, imported: false, call_id: r.callId ?? null,
                  message: r.reason === "no transcript yet"
                    ? "Fathom hasn't finished transcribing this one yet — try again shortly."
                    : `Not imported: ${r.reason}` });
  }
  // Log it as a human decision, not a poll result — this one was chosen, and by whom matters
  // if a colleague's call ever needs accounting for.
  await logEvent(env, { kind: "fathom.imported_manually", call_id: r.callId, account_id: row.account_id,
    detail: `${r.name} — imported by hand from ${row.label || "Fathom"} (recorded by ${m.recorded_by?.email || "unknown"})` });
  return json({ ok: true, imported: true, call_id: r.callId, message: `Imported ${r.name}`, name: r.name });
}

// Backfill recording URLs for calls imported before the column existed (TASK-123).
//
// Modelled on fathomBackfillTitles deliberately: same bounded window, same dry-run default, same
// "report what it would change" shape. Read-only against Fathom; the only write is one column on
// calls that already exist, matched by external_id. Never creates a call.
async function fathomBackfillUrls(env, id, days = 90, dry = true) {
  const row = await env.DB.prepare("SELECT * FROM integrations WHERE id = ?").bind(id).first();
  if (!row || row.kind !== "fathom") return json({ error: "not a Fathom integration" }, 400);
  const key = keyForRow(row);
  if (!key) return json({ ok: false, message: "No Fathom key saved yet." });

  const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
  // Metadata only: this needs URLs, not content.
  const res = await fetchFathomMeetings(key, sinceIso, row.owner_email, { includeTranscript: false });
  if (!res.ok) return json({ ok: false, message: res.message });

  const updates = [];
  for (const m of res.items) {
    const url = m.share_url || m.url;
    if (!url) continue;
    const ext = String(m.recording_id);
    const call = await env.DB.prepare(
      "SELECT id, client_name, recording_url FROM calls WHERE account_id = ? AND external_id = ?"
    ).bind(row.account_id, ext).first();
    if (!call || call.recording_url) continue;      // never overwrite one that is already set
    updates.push({ id: call.id, name: call.client_name, url });
  }

  if (!dry) {
    for (const u of updates) {
      await env.DB.prepare("UPDATE calls SET recording_url = ? WHERE id = ?").bind(u.url, u.id).run();
    }
    await logEvent(env, { kind: "fathom.urls_backfilled", account_id: row.account_id,
      detail: `${updates.length} call${updates.length === 1 ? "" : "s"} linked to their recording` });
  }
  // Report what is LEFT, not just what was touched.
  //
  // Fathom's /meetings endpoint returns ONE page and this client does not paginate, so a run
  // covers only the most recent meetings in the window. Without `remaining`, a result reading
  // "found 10, updated 10" looks like completion when a hundred calls still have no link — the
  // same shape as a backup that reports success having copied nothing.
  const left = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM calls WHERE account_id = ? AND source = 'fathom' AND recording_url IS NULL"
  ).bind(row.account_id).first();
  const remaining = dry ? left.n : Math.max(0, left.n);

  return json({ ok: true, dry, found: res.items.length, updated: updates.length,
                remaining,
                note: remaining
                  ? `Fathom returns one page per request and this does not paginate, so ${remaining} older call${remaining === 1 ? "" : "s"} still ${remaining === 1 ? "has" : "have"} no recording link. Their key moments render as plain timestamps.`
                  : "Every Fathom call on this account now links to its recording.",
                calls: updates.slice(0, 40).map(u => ({ id: u.id, name: u.name })) });
}

async function fathomBackfillTitles(env, id, days = 30, dry = false) {
  const row = await env.DB.prepare("SELECT * FROM integrations WHERE id = ?").bind(id).first();
  if (!row || row.kind !== "fathom") return json({ error: "not a Fathom integration" }, 400);
  const key = keyForRow(row);
  if (!key) return json({ ok: false, message: "No Fathom key saved yet." });

  const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
  let data;
  try {
    const res = await fetch(
      `${FATHOM_BASE}/meetings?created_after=${encodeURIComponent(sinceIso)}&include_transcript=false`,
      { headers: { "X-Api-Key": key }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return json({ ok: false, message: `Fathom returned ${res.status}.` });
    data = await res.json();
  } catch (err) { return json({ ok: false, message: `Could not reach Fathom: ${err.message}` }); }
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];

  const changed = [], skipped = [];
  for (const m of items) {
    const externalId = String(m.recording_id ?? m.id ?? "");
    if (!externalId) continue;
    const call = await env.DB.prepare(
      "SELECT id, client_name, renamed_at FROM calls WHERE external_id = ? LIMIT 1"
    ).bind(externalId).first();
    if (!call) continue;

    // Go through deriveClientName, NOT a local copy of the rule — an earlier version of this
    // function had its own logic and would still have renamed "Kyle" and "Evette" both to
    // "Impromptu Zoom Meeting" after the generic-title guard was added elsewhere.
    const title = deriveClientName(m);
    const attendee = deriveAttendeeName(m);
    if (!title || title === call.client_name) continue;
    // Never trade a real name for a generic one. deriveClientName falls back to the auto-title
    // when Fathom lists no external invitee — which is how "Kyle" and "Evette" were both still
    // headed for "Impromptu Zoom Meeting". Whatever the row is called now beats that.
    if (isGenericTitle(title)) {
      skipped.push({ id: call.id, name: call.client_name, why: `Fathom's title is generic ("${title}") — keeping the current name` });
      continue;
    }
    if (call.renamed_at) { skipped.push({ id: call.id, name: call.client_name, why: "renamed by hand" }); continue; }
    if (attendee && call.client_name !== attendee) {
      skipped.push({ id: call.id, name: call.client_name, why: "name is not the auto-derived attendee" });
      continue;
    }
    changed.push({ id: call.id, from: call.client_name, to: title });
    if (!dry) {
      await env.DB.prepare("UPDATE calls SET client_name = ?, attendee_name = COALESCE(attendee_name, ?) WHERE id = ?")
        .bind(title, attendee, call.id).run();
    }
  }
  if (!dry && changed.length) {
    await logEvent(env, { kind: "fathom.titles_backfilled", account_id: row.account_id,
      detail: `${row.label}: retitled ${changed.length} call${changed.length === 1 ? "" : "s"} from attendee names to Fathom titles` });
  }
  return json({ ok: true, dry, label: row.label, changed, skipped });
}

async function testIntegration(env, id) {
  const row = await env.DB.prepare("SELECT * FROM integrations WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "not found" }, 404);

  const key = await resolveKey(env, row.account_id, row.kind);
  if (!key) return json({ ok: false, message: "No key saved yet — paste one and hit Save first." });

  const endpoints = {
    anthropic: { url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } },
    openai:    { url: "https://api.openai.com/v1/models",    headers: { "Authorization": `Bearer ${key}` } }
  };
  // Fathom: a real auth check. Asks for a 1-minute window so it returns (almost
  // certainly) nothing — we only care that the key authenticates.
  if (row.kind === "fathom") {
    const since = new Date(Date.now() - 60_000).toISOString();
    try {
      const res = await fetch(`${FATHOM_BASE}/meetings?created_after=${encodeURIComponent(since)}`,
        { headers: { "X-Api-Key": key } });
      if (res.ok) {
        await env.DB.prepare("UPDATE integrations SET status = 'connected' WHERE id = ?").bind(id).run();
        await logEvent(env, { kind: "integration.tested", account_id: row.account_id, detail: "fathom · pass" });
        return json({ ok: true, message: "Fathom key works — connected." });
      }
      await logEvent(env, { level: "warn", kind: "integration.tested", account_id: row.account_id, detail: `fathom · fail (${res.status})` });
      await env.DB.prepare("UPDATE integrations SET status = 'disconnected' WHERE id = ?").bind(id).run();
      return json({ ok: false, message: res.status === 401 || res.status === 403
        ? `Fathom rejected the key (${res.status}). Check it was copied in full.`
        : `Fathom returned ${res.status}.` });
    } catch (err) {
      return json({ ok: false, message: `Could not reach Fathom: ${err.message}` });
    }
  }

  const ep = endpoints[row.kind];
  if (!ep) {
    // Don't guess at an API we haven't verified (GHL is OAuth — see TASK-018/019).
    return json({ ok: false, message: `No connection test available for ${row.kind} yet — the key is saved.` });
  }

  try {
    const res = await fetch(ep.url, { headers: ep.headers });
    if (res.ok) {
      await env.DB.prepare("UPDATE integrations SET status = 'connected' WHERE id = ?").bind(id).run();
      await logEvent(env, { kind: "integration.tested", account_id: row.account_id, detail: `${row.kind} · pass` });
      return json({ ok: true, message: "Key works — connected." });
    }
    await logEvent(env, { level: "warn", kind: "integration.tested", account_id: row.account_id, detail: `${row.kind} · fail (${res.status})` });
    await env.DB.prepare("UPDATE integrations SET status = 'disconnected' WHERE id = ?").bind(id).run();
    const hint = res.status === 401 ? "Key was rejected (401). Check for a typo or a revoked key."
               : res.status === 403 ? "Key authenticated but lacks permission (403)."
               : `Provider returned ${res.status}.`;
    return json({ ok: false, message: hint });
  } catch (err) {
    return json({ ok: false, message: `Could not reach the provider: ${err.message}` });
  }
}

// ---------- insights ----------

async function insights(env, accountId, callTypeId) {
  // Scoped BY CALL TYPE. Averaging a client call's scorecard together with a sales call's mixes
  // incompatible scales now that each type defines its own dimensions — and a type with no
  // scorecard would otherwise pad the denominator while contributing nothing.
  const where = ["c.processed_at IS NOT NULL", "c.archived_at IS NULL"];
  const binds = [];
  if (accountId) { where.push("c.account_id = ?"); binds.push(accountId); }
  if (callTypeId) { where.push("c.call_type_id = ?"); binds.push(callTypeId); }
  const { results } = await env.DB.prepare(
    `SELECT c.debrief_json, c.call_type_id, ct.name AS call_type_name
       FROM calls c LEFT JOIN call_types ct ON ct.id = c.call_type_id
      WHERE ${where.join(" AND ")}`
  ).bind(...binds).all();

  const dims = {}, hurt = [], lessons = [];
  let scored = 0;
  for (const row of results) {
    if (!row.debrief_json) continue;
    let d; try { d = JSON.parse(row.debrief_json); } catch { continue; }
    if ((d.scorecard || []).length) scored++;
    for (const [k, v] of d.scorecard || []) (dims[k] = dims[k] || []).push(v);
    // hurtSale entries became objects in TASK-089 — read via debriefLine or this renders
    // "[object Object]" in the Insights view.
    const h = debriefLine(d.hurtSale?.[0]); if (h) hurt.push(h);
    if (d.lessons?.[0]) lessons.push(d.lessons[0]);
  }
  const averages = Object.entries(dims)
    .map(([k, vals]) => [k, +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1), vals.length]);

  // Which types actually have scored calls, so the UI can offer a real chooser.
  const { results: typeCounts } = await env.DB.prepare(
    `SELECT ct.id, ct.name, COUNT(c.id) AS n
       FROM call_types ct LEFT JOIN calls c
         ON c.call_type_id = ct.id AND c.processed_at IS NOT NULL AND c.archived_at IS NULL
      WHERE ct.archived_at IS NULL GROUP BY ct.id, ct.name ORDER BY ct.sort_order`
  ).all();

  return json({ calls: results.length, scored, averages, hurt, lessons,
                types: typeCounts, call_type_id: callTypeId ? +callTypeId : null });
}


// ---------- cron jobs ----------

// How far back each poll looks. Bounded on purpose: with the unique (account_id, external_id)
// index making imports idempotent, a window + dedupe is safer than a stored cursor — a corrupt
// or reset cursor could re-import history, but a 12h window structurally cannot.
// 12h covers "Gabriel records early, Ivan looks at midday" with room to spare.
const POLL_LOOKBACK_MS = 12 * 3600_000;

// MASTER SWITCH for the cron (TASK-058). false = import-only: new Fathom meetings land in the
// inbox as 'new' and a human clicks Generate. Fathom captures EVERY meeting on the account —
// internal ones included — and we cannot tell a sales call from an internal one without paying
// for an LLM, which is what made this the safe default.
//
// TURNED ON 2026-08-12, decided on the 08-11 call, after confirming the defence against the
// TASK-058 incident actually holds in production:
//
//   * Both Fathom tokens have `owner_email` set, so the poll is scoped to `recorded_by[]=`.
//     OSA      -> gabriel@onscreenauthority.com   56 calls imported
//     Hypnosis -> gabriel@domthehypnotist.com      9 calls imported
//   * A token with NO owner_email is skipped entirely — it fails closed, not open.
//   * Both addresses are demonstrably live: a wrong address imports zero, and neither is zero.
//     (The vault recorded the second as `donthehypnotist.com`. Production says `dom`, and
//     production is importing calls, so the vault had the typo. Corrected there.)
//
// ‼️ THIS IS A BILL, NOT A CONVENIENCE. Measured over the 14 days to 2026-08-11: 35 calls
// imported, 16 of which Gabriel chose to generate on. Auto-processing pays for all 35 — a
// **2.2x** increase, ~$28/mo -> ~$62/mo at the current Opus 5 default, or ~$10/mo on Sonnet 5.
// The 19 he skipped are not waste the flag removes; they are a human filter the flag deletes.
// Revert is this one line. See the model-default note in the 2026-08-12 CHANGELOG entry.
const AUTO_PROCESS_IMPORTS = true;

// Hard cap on paid runs launched per tick, used ONLY when AUTO_PROCESS_IMPORTS is true. The
// cron fires every 5 minutes, so this bounds the blast radius if anything upstream goes wrong.
const MAX_AUTO_PROCESS_PER_TICK = 3;

// The "like Gmail" behaviour (TASK-017): new calls arrive and are processed with nobody
// logged in and no laptop open. Runs on the */5 cron.
async function pollFathom(env) {
  const { results: integrations } = await env.DB.prepare(
    "SELECT * FROM integrations WHERE kind = 'fathom'"
  ).all();

  const seenKeys = new Set();                 // two rows resolving to the same key => poll once
  for (const row of integrations || []) {
    const key = keyForRow(row);
    if (!key || seenKeys.has(key)) continue;   // not configured, or a duplicate key — skip
    seenKeys.add(key);

    // FAIL CLOSED: an unscoped token pulls colleagues' calls into our database. Skip it and
    // say why, rather than quietly ingesting third-party transcripts.
    if (!row.owner_email) {
      await logEvent(env, { level: "warn", kind: "fathom.poll_skipped", account_id: row.account_id,
        detail: `Token "${row.label || row.id}" has no owner email set — skipping. Fathom returns the whole org's recordings without recorded_by[], so polling unscoped would import other people's calls.` });
      continue;
    }

    const fetched = await fetchFathomMeetings(key, new Date(Date.now() - POLL_LOOKBACK_MS).toISOString(), row.owner_email);
    if (!fetched.ok) {
      // Log and move on: a Fathom outage must not stop other accounts polling.
      await logEvent(env, { level: "error", kind: "fathom.poll_failed", account_id: row.account_id,
        detail: fetched.message });
      continue;
    }
    if (!fetched.items.length) continue;      // nothing new — stay quiet, this runs every 5 min

    let imported = 0, launched = 0, deferred = 0, skippedNoOutputs = 0;
    // Oldest first, so if auto-processing is on and the cap bites, the EARLIEST calls generate
    // first — Gabriel reads them in the order he made them.
    for (const m of newestFirst(fetched.items).reverse()) {
      const r = await importMeeting(env, row, m);
      if (!r.imported) continue;              // already have it, or no transcript yet
      imported++;

      // AUTO_PROCESS_IMPORTS is ON as of 2026-08-12 (TASK-114) — this comment said OFF until
      // then, and the flag above carries the evidence the gate was checked before flipping.
      //
      // The original TASK-058 reasoning still stands and is why the scope matters: Fathom sends
      // every meeting on the account, internal ones included (the three "Nathan Macias"
      // meetings), and one internal meeting was even tagged with an external-looking name. What
      // makes auto-processing safe now is `integrations.owner_email` scoping the poll to
      // `recorded_by[]=`, which fails closed — not any ability to tell a sales call from an
      // internal one.
      //
      // NOTE THE SCOPE: this only auto-processes what THIS tick imported. Calls already sitting
      // in the inbox as 'new' are never swept — as of 2026-08-12 that is 19 calls Gabriel chose
      // not to generate, and flipping the flag deliberately does not go back and bill for them.
      if (!AUTO_PROCESS_IMPORTS) continue;

      // Fetched WITH its call type, because the next decision needs it. One indexed read.
      const call = await env.DB.prepare(
        `SELECT c.*, ct.name AS ct_name, ct.produces_messages AS ct_messages, ct.produces_crm_note AS ct_crm
           FROM calls c LEFT JOIN call_types ct ON ct.id = c.call_type_id WHERE c.id = ?`
      ).bind(r.callId).first();

      // DON'T PAY, UNATTENDED, FOR A CALL TYPE THAT PRODUCES NOTHING TO SEND (TASK-116).
      //
      // A type with produces_messages = 0 AND produces_crm_note = 0 still yields a debrief —
      // call 10071 on 2026-08-13 got 38,372 characters of one — it just yields no follow-up and
      // no CRM note. That is worth paying for when a human asks for it. It is not worth paying
      // for at 3am on a meeting nobody chose. In production this is exactly one type,
      // "Internal / team", and it already carries 13 calls.
      //
      // Checked BEFORE the per-tick cap on purpose: a skipped call costs nothing, so it must not
      // consume a slot or be counted as "deferred", which would misreport the cap as the reason.
      //
      // ‼️ THE SAFETY PROPERTY THAT MAKES THIS OK. `suggestCallType` is a keyword heuristic, not
      // a model — "no external invitee" or four internal-sounding words beat the sales score. It
      // WILL mislabel a real sales call eventually. When it does, the call still imports and
      // still sits in the inbox as 'new' with a Generate button: the worst case is exactly the
      // world before auto-processing existed, one click. It is never silently dropped, and the
      // skip is logged so a wrong label is findable in Activity rather than invisible.
      if (call.call_type_id && !call.ct_messages && !call.ct_crm) {
        skippedNoOutputs++;
        await logEvent(env, { kind: "auto_process.skipped", call_id: call.id, account_id: call.account_id,
          detail: `${call.client_name} · "${call.ct_name}" produces no outputs — imported only. Click Generate to run it.` });
        continue;
      }

      if (launched >= MAX_AUTO_PROCESS_PER_TICK) { deferred++; continue; }
      const g = await launchGeneration(env, call);
      if (g.ok && !g.already) launched++;
    }

    if (imported) {
      await logEvent(env, { kind: "fathom.poll", account_id: row.account_id,
        detail: AUTO_PROCESS_IMPORTS
          ? `Imported ${imported}, started ${launched}`
            + `${skippedNoOutputs ? `, skipped ${skippedNoOutputs} (call type produces no outputs)` : ""}`
            + `${deferred ? `, deferred ${deferred} (cap ${MAX_AUTO_PROCESS_PER_TICK})` : ""}`
          : `Imported ${imported} — waiting in the inbox for manual Generate (auto-process off)`,
        meta: { imported, launched, deferred, skippedNoOutputs } });
    }
  }
}

async function weeklyEditAnalysis(env) {
  // Batch rule from the Gabriel call: only analyze once >= 10 unfolded edits exist
  // for an (account, tone) pair; produce a SUGGESTION (never auto-apply).
  const { results } = await env.DB.prepare(
    "SELECT account_id, tone, COUNT(*) AS n FROM edits WHERE folded_into_version IS NULL GROUP BY account_id, tone HAVING n >= 10"
  ).all();
  for (const group of results) {
    const { results: edits } = await env.DB.prepare(
      "SELECT original, edited FROM edits WHERE account_id = ? AND tone IS ? AND folded_into_version IS NULL LIMIT 50"
    ).bind(group.account_id, group.tone).all();
    const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(group.account_id).first();

    // TASK-022. This wrote a placeholder string for weeks. It is real now — but it still fails
    // SOFT: a suggestion is a nicety, and a Sunday cron that throws would take the whole job
    // down for every other group behind it.
    let analysis;
    try {
      const r = await analyseEdits(env, { account, tone: group.tone, edits });
      if (r.skipped) {
        analysis = `${group.n} edits accumulated for "${group.tone || "master"}", but no analysis: ${r.skipped}.`;
      } else {
        const a = r.analysis || {};
        analysis = a.notAPattern
          ? `No reliable pattern across ${r.usable} edits yet. ${a.notAPattern}`
          : [
              `${a.headline || "Pattern found."}  (confidence: ${a.confidence || "unstated"})`,
              "",
              "EVIDENCE",
              ...(a.evidence || []).map(e => `· ${e}`),
              "",
              "SUGGESTED PROMPT CHANGE",
              a.promptChange || "(none returned)",
              "",
              `Based on ${r.usable} usable edits${r.dropped ? `; ${r.dropped} whole-document replacements ignored` : ""}.`,
            ].join("\n");
      }
      await logEvent(env, { kind: "edits.analysed", account_id: group.account_id, usage: r.usage,
        model: r.model,
        detail: `${group.tone || "master"} · ${r.usable ?? 0} usable of ${group.n}` });
    } catch (err) {
      analysis = `${group.n} edits accumulated for "${group.tone || "master"}". Analysis failed: ${String(err?.message || err)}`;
      await logEvent(env, { level: "error", kind: "edits.analysis_failed", account_id: group.account_id,
        detail: String(err?.message || err) });
    }

    await env.DB.prepare(
      "INSERT INTO suggestions (account_id, tone, week_of, analysis) VALUES (?, ?, date('now', 'weekday 0', '-7 days'), ?)"
    ).bind(group.account_id, group.tone, analysis).run();
  }
}
