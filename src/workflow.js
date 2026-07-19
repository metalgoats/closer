// Generation runs here, in a Cloudflare Workflow (TASK-045).
//
// WHY THIS EXISTS — read before "simplifying" it back:
// This used to be `ctx.waitUntil(runGeneration(env, id))` behind an immediate 202. That is
// capped at THIRTY SECONDS. Cloudflare's limits doc, verbatim: "waitUntil() can extend
// execution for up to 30 seconds after the response is sent or the client disconnects."
// Generation takes minutes, so EVERY run in this project's history died at 0:30 — silently,
// because the isolate is gone, so nothing throws, no catch runs, no log line is written, and
// even an AbortSignal.timeout never fires. The 10 / 12.6 / 18-minute figures in the log were
// never durations; they were just when somebody looked at a corpse.
//
// Workflows is the right primitive because per-step WALL-CLOCK is unlimited ("waiting on
// network I/O calls or querying a database" does not count) and only CPU is capped. Our work
// is ~100% waiting on Anthropic. It also genuinely runs with nobody logged in, which is the
// "like Gmail" requirement waitUntil only ever pretended to satisfy.
import { WorkflowEntrypoint } from "cloudflare:workers";
import { generateOutputs } from "./llm.js";
import { logEvent } from "./log.js";

export class GenerateWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { callId } = event.payload;
    const env = this.env;
    const t0 = Date.now();

    try {
      // MONEY-BOMB GUARD: Workflows retries steps automatically by default. A silent retry
      // here is another four paid calls over a 19k-token transcript. This step must never
      // auto-retry — a failed generation is the user's decision to re-run, not ours.
      //
      // `delay` is REQUIRED whenever `retries` is present, even when limit is 0. Omitting it
      // fails the whole run with "Step config for "generate" is in a invalid format" — which
      // is exactly what happened on the first real Workflow run.
      //
      // UNVERIFIED: Cloudflare's docs do not actually state what limit:0 does. Standard retry
      // semantics say "no retries", but this guard protects real money, so it is instrumented
      // rather than trusted — the attempt log below makes a silent retry immediately visible
      // instead of quietly doubling the bill.
      const gen = await step.do("generate", {
        retries: { limit: 0, delay: "1 second" },
        timeout: "15 minutes"
      }, async () => {
        await logEvent(env, { kind: "generation.attempt", call_id: callId,
          detail: `workflow ${event.instanceId || "?"} · if this appears more than once per generation.started, retries:{limit:0} does NOT mean zero and we are double-spending` });
        const call = await env.DB.prepare("SELECT * FROM calls WHERE id = ?").bind(callId).first();
        if (!call) throw new Error(`call ${callId} vanished`);
        const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(call.account_id).first();
        const tpl = await env.DB.prepare(
          "SELECT body FROM prompt_templates WHERE account_id = ? AND tone IS NULL AND active = 1"
        ).bind(account.id).first();

        // The call's type supplies the prompt, scorecard dimensions and which outputs to make.
        // Fall back to the account default so an unlabelled call still behaves as before.
        const callType = await env.DB.prepare(
          `SELECT * FROM call_types WHERE id = COALESCE(?, (SELECT id FROM call_types WHERE account_id = ? AND is_default = 1 LIMIT 1))`
        ).bind(call.call_type_id, account.id).first();

        // Throttle progress writes: the stream reports on every text delta, far too often
        // for D1. 1.5s is frequent enough to look live and cheap enough to ignore.
        let lastWrite = 0;
        const writeProgress = async ({ percent, step: label }) => {
          if (Date.now() - lastWrite < 1500) return;
          lastWrite = Date.now();
          try {
            await env.DB.prepare("UPDATE calls SET processing_progress = ?, processing_step = ? WHERE id = ?")
              .bind(percent, label, callId).run();
          } catch (e) {
            // Same rule as logEvent: reporting must never break the run it reports on.
            console.error("progress write failed (non-fatal)", e?.message);
          }
        };

        const out = await generateOutputs(env, {
          account, call, masterPrompt: tpl?.body || "", callType,
          onStep: ({ step: s, duration_ms, usage }) => logEvent(env, {
            kind: `generation.${s}_done`, call_id: callId, account_id: account.id,
            duration_ms, usage, detail: `${call.client_name} · ${s}`
          }),
          onProgress: writeProgress
        });
        return { ...out, account_id: account.id, client_name: call.client_name };
      });

      // Cheap and idempotent (it deletes prior outputs first), so retrying costs nothing
      // and protects against a transient D1 blip discarding a generation we already paid for.
      await step.do("save", { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } }, async () => {
        const stmts = [
          env.DB.prepare("DELETE FROM outputs WHERE call_id = ?").bind(callId),
          env.DB.prepare(
            `UPDATE calls SET processing_status = 'processed', processed_at = datetime('now'),
                    processing_error = NULL, processing_progress = 100, processing_step = 'Done',
                    debrief_json = ?, suggested_tone = ?, tone_reason = ?,
                    selected_tone = COALESCE(selected_tone, ?), outcome = COALESCE(outcome, ?) WHERE id = ?`
          ).bind(JSON.stringify(gen.debrief), gen.suggestedTone, gen.toneReason, gen.suggestedTone, gen.outcome, callId),
        ];
        if (gen.ghlNote) {
          stmts.push(env.DB.prepare("INSERT INTO outputs (call_id, kind, body, model) VALUES (?, 'ghl_note', ?, ?)")
            .bind(callId, gen.ghlNote, gen.model));
        }
        for (const m of gen.messages) {
          stmts.push(env.DB.prepare("INSERT INTO outputs (call_id, kind, tone, body, model) VALUES (?, 'sms', ?, ?, ?)")
            .bind(callId, m.tone, m.sms, gen.model));
          stmts.push(env.DB.prepare("INSERT INTO outputs (call_id, kind, tone, subject, body, model) VALUES (?, 'email', ?, ?, ?, ?)")
            .bind(callId, m.tone, m.emailSubject, m.email, gen.model));
        }
        await env.DB.batch(stmts);
      });

      await logEvent(env, { kind: "generation.succeeded", call_id: callId, account_id: gen.account_id,
        duration_ms: Date.now() - t0, usage: gen.usage,
        detail: `${gen.client_name} · ${gen.model} · outcome=${gen.outcome}`,
        meta: { model: gen.model, outputs: 1 + gen.messages.length * 2 } });
    } catch (err) {
      // A wedged 'processing' row is what made every previous failure look like a hang.
      // Whatever else breaks, the call must not be left spinning.
      console.error("generation failed", callId, err);
      const msg = String(err?.message || err).slice(0, 500);
      try {
        await env.DB.prepare(
          "UPDATE calls SET processing_status = 'failed', processing_step = 'Failed', processing_error = ? WHERE id = ?"
        ).bind(msg, callId).run();
      } catch (e) { console.error("could not mark failed", e?.message); }
      await logEvent(env, { level: "error", kind: "generation.failed", call_id: callId,
        duration_ms: Date.now() - t0, detail: msg });
      throw err;
    }
  }
}
