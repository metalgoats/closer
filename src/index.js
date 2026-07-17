import { hashPassword, verifyPassword, newSessionToken, sessionCookie, readSessionToken, requireUser } from "./auth.js";
import { resolveKey } from "./llm.js";
import { logEvent } from "./log.js";

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
      if (event.cron === "0 17 * * SUN") await weeklyEditAnalysis(env);
      else await pollFathom(env);
    } catch (err) {
      // A cron that throws is invisible — nobody is watching. Record it.
      console.error("cron failed", event.cron, err);
      await logEvent(env, { level: "error", kind: "cron.failed",
        detail: `${event.cron}: ${String(err?.message || err)}` });
    }
  }
};

async function route(request, env, url, ctx) {
  const path = url.pathname;
  const method = request.method;

  // ---- unauthenticated ----
  if (path === "/api/setup" && method === "POST") return setup(request, env);
  if (path === "/api/login" && method === "POST") return login(request, env);
  if (path === "/api/logout" && method === "POST") return logout(request, env);

  const user = await requireUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);

  if (path === "/api/me") return json({ user });

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
      `SELECT i.id, i.account_id, i.kind, i.status, i.secret_name, i.updated_at,
              a.name AS account_name,
              CASE WHEN i.secret_value IS NULL OR i.secret_value = '' THEN 0 ELSE 1 END AS has_key,
              CASE WHEN i.secret_value IS NULL OR i.secret_value = '' THEN NULL
                   ELSE substr(i.secret_value, 1, 7) || '...' || substr(i.secret_value, -4) END AS key_preview
       FROM integrations i JOIN accounts a ON a.id = i.account_id
       ORDER BY i.account_id, i.kind`
    ).all();
    // Surface env-var fallbacks so the UI can show "set via wrangler" without exposing them.
    const envFallback = { anthropic: !!env.ANTHROPIC_API_KEY, openai: !!env.OPENAI_API_KEY, fathom: !!env.FATHOM_API_KEY_OSA };
    return json({ integrations: results.map(i => ({ ...i, env_fallback: !!envFallback[i.kind] })) });
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

  const intTestMatch = path.match(/^\/api\/integrations\/(\d+)\/test$/);
  if (intTestMatch && method === "POST") return testIntegration(env, +intTestMatch[1]);

  const pullMatch = path.match(/^\/api\/integrations\/(\d+)\/pull-latest$/);
  if (pullMatch && method === "POST") {
    const days = Math.min(90, Math.max(1, +(url.searchParams.get("days") || 7)));
    return fathomPullLatest(env, +pullMatch[1], days);
  }

  // ---- calls ----
  if (path === "/api/calls" && method === "GET") {
    const accountId = url.searchParams.get("account");
    // Archived calls are excluded by default — that IS the feature. ?archived=1 shows only them.
    const archived = url.searchParams.get("archived") === "1";
    const where = [archived ? "c.archived_at IS NOT NULL" : "c.archived_at IS NULL"];
    const binds = [];
    if (accountId) { where.push("c.account_id = ?"); binds.push(accountId); }
    const { results } = await env.DB.prepare(
      `${CALL_LIST_SQL} WHERE ${where.join(" AND ")} ORDER BY c.occurred_at DESC`
    ).bind(...binds).all();
    return json({ calls: results });
  }

  const callMatch = path.match(/^\/api\/calls\/(\d+)$/);
  if (callMatch && method === "GET") return getCall(env, +callMatch[1]);
  if (callMatch && method === "PATCH") return patchCall(request, env, +callMatch[1]);

  if (path === "/api/calls" && method === "POST") return createCall(request, env, ctx);

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

  // ---- templates ----
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
  if (path === "/api/insights" && method === "GET") return insights(env, url.searchParams.get("account"));

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
              SUM(cache_read_tokens) AS cache_read_tokens, AVG(duration_ms) AS avg_ms
       FROM events WHERE kind = 'generation.succeeded'`
    ).first();
    const fails = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE level = 'error'").first();
    return json({ events: results, totals: { ...totals, failures: fails?.n || 0 } });
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
         c.callback_note, c.processed_at, c.processing_status, c.processing_error, c.archived_at, a.name AS account_name,
         (SELECT COUNT(*) FROM outputs o WHERE o.call_id = c.id AND o.kind='sms' AND o.sent_at IS NOT NULL) AS sms_sent,
         (SELECT COUNT(*) FROM outputs o WHERE o.call_id = c.id AND o.kind='email' AND o.sent_at IS NOT NULL) AS email_sent
  FROM calls c JOIN accounts a ON a.id = c.account_id`;

// ---------- auth handlers ----------

async function setup(request, env) {
  const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  if (existing.n > 0) return json({ error: "already set up" }, 403);
  const { email, password } = await request.json();
  if (!email || !password || password.length < 8) return json({ error: "email + password (8+ chars) required" }, 400);
  const { hash, salt } = await hashPassword(password);
  await env.DB.prepare("INSERT INTO users (email, pw_hash, pw_salt) VALUES (?, ?, ?)").bind(email, hash, salt).run();
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
  const user = await env.DB.prepare("SELECT id, email FROM users WHERE email = ?").bind(email).first();
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
    "SELECT c.*, a.name AS account_name, a.llm_provider FROM calls c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?"
  ).bind(id).first();
  if (!call) return json({ error: "not found" }, 404);
  const { results: outputs } = await env.DB.prepare("SELECT * FROM outputs WHERE call_id = ?").bind(id).all();
  return json({ call, outputs });
}

async function patchCall(request, env, id) {
  const body = await request.json();
  const allowed = ["selected_tone", "outcome", "callback_note", "client_name"];
  const sets = [], vals = [];
  for (const k of allowed) if (k in body) { sets.push(`${k} = ?`); vals.push(body[k]); }
  if (!sets.length) return json({ error: "nothing to update" }, 400);
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

async function createCall(request, env, ctx) {
  const { account_id, client_name, transcript } = await request.json();
  if (!account_id || !client_name || !transcript) return json({ error: "account_id, client_name, transcript required" }, 400);
  const res = await env.DB.prepare(
    "INSERT INTO calls (account_id, client_name, occurred_at, transcript, source) VALUES (?, ?, datetime('now'), ?, 'manual') RETURNING id"
  ).bind(account_id, client_name, transcript).first();
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
function deriveClientName(m) {
  const ext = (m.calendar_invitees || []).find(i => i.is_external && i.name);
  return ext?.name || m.meeting_title || m.title || "Unknown client";
}

// Imports EXACTLY ONE call: the most recent within `days`. Bounded by created_after
// so it is structurally incapable of pulling full history. Lands unprocessed —
// import must never trigger LLM generation (see TASK-033).
// Fetches meetings from Fathom. Returns { ok, items } or { ok:false, message } — the caller
// decides whether that becomes an HTTP response or a log line, so the manual pull and the
// cron share one implementation rather than drifting apart.
async function fetchFathomMeetings(key, sinceIso) {
  const url = `${FATHOM_BASE}/meetings?created_after=${encodeURIComponent(sinceIso)}&include_transcript=true`;
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
async function importMeeting(env, accountId, m) {
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

  const ins = await env.DB.prepare(
    `INSERT INTO calls (account_id, client_name, occurred_at, duration_min, transcript, source, external_id)
     VALUES (?, ?, ?, ?, ?, 'fathom', ?) RETURNING id`
  ).bind(accountId, name, start, durationMin, transcript, externalId).first();

  await logEvent(env, { kind: "fathom.imported", call_id: ins.id, account_id: accountId,
    detail: `${name} · ${transcript.length.toLocaleString()} chars · ${durationMin ?? "?"} min`,
    meta: { recording_id: externalId, occurred_at: start } });
  return { imported: true, callId: ins.id, name, occurred_at: start };
}

async function fathomPullLatest(env, id, days = 7) {
  const row = await env.DB.prepare("SELECT * FROM integrations WHERE id = ?").bind(id).first();
  if (!row || row.kind !== "fathom") return json({ error: "not a Fathom integration" }, 400);

  const key = await resolveKey(env, row.account_id, "fathom");
  if (!key) return json({ ok: false, message: "No Fathom key saved yet — paste one and hit Save first." });

  const fetched = await fetchFathomMeetings(key, new Date(Date.now() - days * 86400_000).toISOString());
  if (!fetched.ok) return json({ ok: false, message: fetched.message });
  if (!fetched.items.length) {
    await logEvent(env, { kind: "fathom.pull", account_id: row.account_id, detail: `No calls in the last ${days} days` });
    return json({ ok: true, imported: false, message: `No Fathom calls in the last ${days} days.` });
  }

  const m = newestFirst(fetched.items)[0];
  const r = await importMeeting(env, row.account_id, m);
  if (!r.imported) {
    return json({ ok: r.reason !== "no transcript yet", imported: false, call_id: r.callId,
      message: r.reason === "no transcript yet"
        ? "Fathom returned that call without a transcript — it may still be processing."
        : `Already imported: ${r.name}. Nothing new to pull.` });
  }
  return json({ ok: true, imported: true, call_id: r.callId, client_name: r.name, occurred_at: r.occurred_at,
    message: `Imported "${r.name}" — open it and hit Generate when you're ready.` });
}

// ---------- integration test ----------

// Verifies a key actually authenticates, so a bad paste fails here rather than
// silently surfacing as a failed generation later. Uses each provider's models
// endpoint: a real auth check that costs zero tokens.
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

async function insights(env, accountId) {
  const q = accountId
    ? env.DB.prepare("SELECT debrief_json FROM calls WHERE processed_at IS NOT NULL AND account_id = ?").bind(accountId)
    : env.DB.prepare("SELECT debrief_json FROM calls WHERE processed_at IS NOT NULL");
  const { results } = await q.all();
  const dims = {}, hurt = [], lessons = [];
  for (const row of results) {
    if (!row.debrief_json) continue;
    const d = JSON.parse(row.debrief_json);
    for (const [k, v] of d.scorecard || []) (dims[k] = dims[k] || []).push(v);
    if (d.hurtSale?.[0]) hurt.push(d.hurtSale[0]);
    if (d.lessons?.[0]) lessons.push(d.lessons[0]);
  }
  const averages = Object.entries(dims).map(([k, vals]) => [k, +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)]);
  return json({ calls: results.length, averages, hurt, lessons });
}

// ---------- cron jobs ----------

// How far back each poll looks. Bounded on purpose: with the unique (account_id, external_id)
// index making imports idempotent, a window + dedupe is safer than a stored cursor — a corrupt
// or reset cursor could re-import history, but a 12h window structurally cannot.
// 12h covers "Gabriel records early, Ivan looks at midday" with room to spare.
const POLL_LOOKBACK_MS = 12 * 3600_000;

// Hard cap on paid runs launched per tick. The cron fires every 5 minutes, so this is the
// blast radius if anything upstream goes wrong (Fathom replays history, dedupe breaks, a
// key is repointed at a different workspace). Overflow is NOT dropped — it is imported and
// logged, and the next tick picks it up, so the cap delays spend rather than losing calls.
const MAX_AUTO_PROCESS_PER_TICK = 3;

// The "like Gmail" behaviour (TASK-017): new calls arrive and are processed with nobody
// logged in and no laptop open. Runs on the */5 cron.
async function pollFathom(env) {
  const { results: integrations } = await env.DB.prepare(
    "SELECT * FROM integrations WHERE kind = 'fathom'"
  ).all();

  for (const row of integrations || []) {
    const key = await resolveKey(env, row.account_id, "fathom");
    if (!key) continue;                       // not configured — silently skip, not an error

    const fetched = await fetchFathomMeetings(key, new Date(Date.now() - POLL_LOOKBACK_MS).toISOString());
    if (!fetched.ok) {
      // Log and move on: a Fathom outage must not stop other accounts polling.
      await logEvent(env, { level: "error", kind: "fathom.poll_failed", account_id: row.account_id,
        detail: fetched.message });
      continue;
    }
    if (!fetched.items.length) continue;      // nothing new — stay quiet, this runs every 5 min

    let imported = 0, launched = 0, deferred = 0;
    // Oldest first, so if the cap bites, the EARLIEST calls generate first — Gabriel reads
    // them in the order he made them.
    for (const m of newestFirst(fetched.items).reverse()) {
      const r = await importMeeting(env, row.account_id, m);
      if (!r.imported) continue;              // already have it, or no transcript yet
      imported++;

      if (launched >= MAX_AUTO_PROCESS_PER_TICK) { deferred++; continue; }
      const call = await env.DB.prepare("SELECT * FROM calls WHERE id = ?").bind(r.callId).first();
      const g = await launchGeneration(env, call);
      if (g.ok && !g.already) launched++;
    }

    if (imported) {
      await logEvent(env, { kind: "fathom.poll", account_id: row.account_id,
        detail: `Imported ${imported}, started ${launched}${deferred ? `, deferred ${deferred} to the next tick (cap ${MAX_AUTO_PROCESS_PER_TICK})` : ""}`,
        meta: { imported, launched, deferred } });
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
    const analysis = `${group.n} edits accumulated for tone "${group.tone || "n/a"}". ` +
      `Review the diffs and consider updating the ${group.tone || "master"} template. ` +
      `(LLM-written analysis lands here once an API key is configured.)`;
    await env.DB.prepare(
      "INSERT INTO suggestions (account_id, tone, week_of, analysis) VALUES (?, ?, date('now', 'weekday 0', '-7 days'), ?)"
    ).bind(group.account_id, group.tone, analysis).run();
  }
}
