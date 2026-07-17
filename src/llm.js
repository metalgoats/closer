// All model calls happen here, server-side only. With no API keys configured, generation
// falls back to clearly-labeled mock output so the app is fully usable before setup.

const TONES = ["casual", "balanced", "formal"];

// Resolves an API key for an account+provider. Prefers the key pasted into the
// Integrations UI (stored in D1); falls back to a Cloudflare secret so anything
// previously set via `wrangler secret put` keeps working. Returns null if neither
// exists, which puts generation into labeled mock mode rather than erroring.
export async function resolveKey(env, accountId, kind) {
  const row = await env.DB.prepare(
    "SELECT secret_value FROM integrations WHERE account_id = ? AND kind = ?"
  ).bind(accountId, kind).first();
  if (row?.secret_value) return row.secret_value;

  const envKeys = { anthropic: env.ANTHROPIC_API_KEY, openai: env.OPENAI_API_KEY, fathom: env.FATHOM_API_KEY_OSA };
  return envKeys[kind] || null;
}

// Resolves the key for a SPECIFIC integration row, not a re-query by (account_id, kind).
// This matters once an account has more than one row of a kind (a second Fathom key,
// TASK-054): resolveKey would return whichever row it found first, so both Fathom rows would
// use the same key — polling one workspace twice and the other never. Always use this when
// you already hold the row.
export function keyForRow(env, row) {
  if (row?.secret_value) return row.secret_value;
  const envKeys = { anthropic: env.ANTHROPIC_API_KEY, openai: env.OPENAI_API_KEY, fathom: env.FATHOM_API_KEY_OSA };
  return envKeys[row?.kind] || null;
}

// Rough expected output sizes, used ONLY to turn streamed bytes into a percentage.
// They are estimates and are treated as such: progress is capped at each step's ceiling
// rather than allowed to overshoot, and it cannot advance unless real bytes arrive.
const EXPECTED_DEBRIEF_CHARS = 14000;   // 9 sections + a GHL note that can reach 10k
const EXPECTED_MESSAGE_CHARS = 1500;    // one tone's SMS + email
const DEBRIEF_SHARE = 70;               // debrief is the long pole: 0-70%, messages 70-100%

export async function generateOutputs(env, { account, call, masterPrompt, onStep, onProgress }) {
  const provider = account.llm_provider || "anthropic";
  const key = await resolveKey(env, account.id, provider);
  if (!key) return mockOutputs(call);

  // Never let the bar go backwards: parallel tone jobs report independently.
  let lastPct = 0;
  const report = (pct, step) => {
    const next = Math.max(lastPct, Math.min(Math.round(pct), 99));  // 100 is earned by saved outputs, not by a stream
    if (onProgress && next > lastPct) { lastPct = next; onProgress({ percent: next, step }); }
  };

  // Sum real usage across all 4 calls so cost is measured, not estimated.
  const total = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const tally = u => { for (const k of Object.keys(total)) total[k] += (u?.[k] || 0); };

  // The ONLY request that carries the transcript (TASK-042). Everything downstream is built
  // from what this pass extracts.
  const t0 = Date.now();
  const debriefRes = await completeWithRetry(env, provider, key, [
    { role: "user", content: `${masterPrompt}\n\nReturn ONLY valid JSON with keys: scorecard (array of [label, score1to10] pairs for rapport, authority, trust, emotional connection, pain amplification, vision building, objection handling, certainty transfer, close attempt, follow-up positioning), didWell (string[]), hurtSale (string[]), objections (array of {said, meant, felt, should, follow, loop}), profile (string[]), buyingSignals (string[]), lessons (string[]), suggestedTone ("casual"|"balanced"|"formal"), toneReason (string), outcome ("closed"|"followup"), followUp (object: {nextStep (string: the single concrete next action that was actually agreed on the call), timing (string: when the next contact or call was agreed, or "" if nothing was agreed), commitments (string[]: anything Gabriel promised to do or send), personalDetails (string[]: specifics said on the call worth referencing in a follow-up — names, dates, goals, situations, their own phrasing)}), ghlNote (string, under 10000 chars: client name, personal details for rapport, buying profile, objections, next-call guidance).\n\nTranscript:\n${call.transcript}` }
  ], { effort: "medium", think: false,
       onRetry: r => onStep && onStep({ step: "retry", detail: `debrief attempt ${r.attempt} failed (${r.error}) — retrying in ${r.backoffMs}ms` }),
       onProgress: chars => report(Math.min(chars / EXPECTED_DEBRIEF_CHARS, 1) * DEBRIEF_SHARE, "Analysing the call") });
  tally(debriefRes.usage);
  const parsed = parseModelJson(debriefRes.text);
  const debriefMs = Date.now() - t0;
  // The debrief is genuinely finished, so claim its full share even if the output came in
  // under the estimate. Otherwise the bar sits at whatever fraction the estimate implied
  // and then lurches when the first draft byte lands.
  report(DEBRIEF_SHARE, "Writing the follow-ups");
  if (onStep) await onStep({ step: "debrief", duration_ms: debriefMs, usage: debriefRes.usage });

  // SMS + email in all three tones, generated in parallel so switching the tone slider is
  // instant. Each job is fed the debrief's distillation, NOT the transcript — see draftContext.
  assertDraftable(parsed);
  const ctx = draftContext(call, parsed);
  const toneChars = new Map(TONES.map(t => [t, 0]));   // shared so the 3 jobs report one combined bar
  const msgJobs = TONES.map(async tone => {
    const res = await completeWithRetry(env, provider, key, [
      { role: "user", content: `You are drafting a follow-up SMS and email from Gabriel, a high-ticket sales closer, to a client he just got off a call with.\n\nYou are NOT given the transcript. The summary below was extracted from it by a prior analysis pass — treat it as the complete and authoritative record of what happened. Do NOT invent facts, commitments, prices, or dates that are not in it.\n\nTone: ${tone}.\nWrite to the actual outcome (${parsed.outcome}) — do not imply a close that did not happen.\nReference the specific details below — their situation, their own phrasing, what was agreed — so this reads like Gabriel wrote it and not like a template.\n\nCall summary:\n${ctx}\n\nReturn ONLY JSON: {"sms": "...", "emailSubject": "...", "email": "..."}` }
    ], { effort: "low", think: false,
         onRetry: r => onStep && onStep({ step: "retry", detail: `${tone} attempt ${r.attempt} failed (${r.error}) — retrying in ${r.backoffMs}ms` }),
         onProgress: chars => {
      toneChars.set(tone, chars);
      const done = [...toneChars.values()].reduce((a, b) => a + b, 0);
      report(DEBRIEF_SHARE + Math.min(done / (EXPECTED_MESSAGE_CHARS * TONES.length), 1) * (100 - DEBRIEF_SHARE),
        "Writing the follow-ups");
    }});
    tally(res.usage);
    return { tone, ...parseModelJson(res.text) };
  });
  const t1 = Date.now();
  const messages = await Promise.all(msgJobs);
  if (onStep) await onStep({ step: "messages", duration_ms: Date.now() - t1 });

  return {
    model: provider,
    usage: total,
    debrief: parsed,
    ghlNote: parsed.ghlNote,
    messages,
    suggestedTone: parsed.suggestedTone,
    toneReason: parsed.toneReason,
    outcome: parsed.outcome
  };
}

// What the follow-up drafts are built from instead of the transcript (TASK-042).
//
// DO NOT "fix" this by passing call.transcript back in. The debrief has already read the
// transcript and extracted every fact a follow-up needs; re-sending it to each of the 3 tone
// jobs cost ~57k extra input tokens and 3 extra prefills of a 19k-token document per call, so
// the model could re-derive facts we were already holding in `parsed`.
//
// Note what is deliberately EXCLUDED: scorecard, didWell, hurtSale, lessons. Those are coaching
// critique OF Gabriel and have no business anywhere near a client-facing email. ghlNote is also
// excluded — it is prose that restates the fields below and can run to 10k chars.
function draftContext(call, parsed) {
  const f = parsed.followUp || {};
  return JSON.stringify({
    clientName: call.client_name,
    outcome: parsed.outcome,
    nextStep: f.nextStep,
    timing: f.timing,
    gabrielCommitted: f.commitments,
    personalDetails: f.personalDetails,
    clientProfile: parsed.profile,
    buyingSignals: parsed.buyingSignals,
    // `said` is the client's verbatim objection — the phrasing worth mirroring back.
    objections: (parsed.objections || []).map(o => ({ said: o.said, meant: o.meant, resolveWith: o.follow }))
  }, null, 1);
}

// A draft built from an empty distillation does not fail — it produces fluent, generic filler
// that reads fine and says nothing about the actual call. That is worse than an error, because
// nobody catches it. Fail loudly instead.
function assertDraftable(parsed) {
  const f = parsed.followUp || {};
  const missing = [];
  if (!parsed.outcome) missing.push("outcome");
  if (!f.nextStep) missing.push("followUp.nextStep");
  const hasColour = [f.personalDetails, parsed.profile, parsed.objections]
    .some(v => Array.isArray(v) && v.length);
  if (!hasColour) missing.push("followUp.personalDetails / profile / objections (all empty)");
  if (missing.length) {
    throw new Error(
      `The debrief did not return the fields the follow-up drafts are built from: ${missing.join("; ")}. ` +
      `Drafting from an empty summary would produce generic filler that looks correct, so the run stopped instead.`
    );
  }
}

// Abort a request that produces nothing for this long. Streaming means bytes should arrive
// steadily, so a long silence is a dead connection, not slow work. Throwing is the whole
// point: TASK-043's hangs were invisible precisely because nothing ever threw.
const STREAM_TIMEOUT_MS = 5 * 60 * 1000;

// Transient vs permanent (TASK-053). The FIRST autonomous cron run died on
// `overloaded_error` — a 529 that Anthropic's docs say to retry with backoff, and which the
// official SDKs retry for you. We call fetch directly, so we must do it ourselves. Without
// this, an Anthropic hiccup at 6am fails every one of Gabriel's calls permanently, with
// nobody awake to hit Regenerate.
//
// Retry ONLY what is genuinely transient. A refusal, a truncation, a bad key or malformed
// JSON will fail identically every time — retrying those just burns money.
const TRANSIENT_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const TRANSIENT_STREAM_ERRORS = new Set(["overloaded_error", "api_error", "rate_limit_error", "timeout_error"]);
const MAX_ATTEMPTS = 4;

class TransientError extends Error {
  constructor(msg) { super(msg); this.transient = true; }
}

// Retries the whole request on transient failures with exponential backoff.
// COST NOTE: a retry re-sends the input, so it is not free. It is worth it because the
// failures we retry die early (an overload at 8.6s had generated almost nothing), and the
// alternative is an unattended run failing permanently overnight.
async function completeWithRetry(env, provider, key, messages, opts = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await complete(env, provider, key, messages, opts);
    } catch (err) {
      lastErr = err;
      if (!err.transient || attempt === MAX_ATTEMPTS) throw err;
      const backoffMs = Math.min(1500 * 2 ** (attempt - 1), 15000);   // 1.5s, 3s, 6s
      if (opts.onRetry) await opts.onRetry({ attempt, backoffMs, error: String(err.message).slice(0, 200) });
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

// opts.effort: "low" | "medium" | "high" | "xhigh" | "max"
// opts.think:  false disables thinking entirely.
// opts.onProgress(charsSoFar): called as text streams in. Real bytes, real progress.
//
// WHY thinking/effort ARE EXPLICIT (TASK-041): Sonnet 5 runs ADAPTIVE THINKING when
// `thinking` is omitted, and `effort` defaults to `high`. Leaving either unset made every
// call reason at high effort over a 19k-token transcript, and thinking competes with the
// response for the max_tokens budget. Never omit these.
//
// WHY WE STREAM (TASK-043): this is not for looks. A non-streaming request sends ZERO bytes
// until the whole message is generated, so with max_tokens 16000 the connection sits idle
// for minutes. Per Anthropic's docs, "some networks may drop idle connections after a
// variable period of time, which can cause the request to fail or time out without receiving
// a response" — and a dropped connection never resolves OR rejects, so the catch block never
// runs and the run vanishes with no log entry. That is exactly what happened twice, at 18 min
// and 12.6 min. The SDKs guard against this (10-min validation + TCP keep-alive); we call
// fetch directly, so we must stream. Do NOT set stream:false here.
async function complete(env, provider, key, messages, opts = {}) {
  const { effort = "medium", think = false, onProgress } = opts;
  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.2", messages, max_completion_tokens: 16000 }),
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS)
    });
    if (!res.ok) {
      const body = await res.text();
      if (TRANSIENT_STATUS.has(res.status)) throw new TransientError(`OpenAI ${res.status}: ${body}`);
      throw new Error(`OpenAI ${res.status}: ${body}`);
    }
    const data = await res.json();
    if (data.choices[0].finish_reason === "length") {
      throw new Error("The model's response was cut off before it finished (hit the output limit). Try a shorter transcript or raise max_tokens.");
    }
    return { text: data.choices[0].message.content, usage: {
      input_tokens: data.usage?.prompt_tokens, output_tokens: data.usage?.completion_tokens } };
  }
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 16000,
        thinking: think ? { type: "adaptive" } : { type: "disabled" },
        output_config: { effort },
        stream: true,
        messages
      }),
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS)
    });
  } catch (err) {
    // Only a NETWORK failure or our own abort lands here — the request never got a verdict,
    // so it is safe to retry. Do NOT widen this catch to cover the classification below, or a
    // bad API key would be retried four times instead of failing immediately.
    throw new TransientError(`Anthropic request failed: ${err.message}`);
  }
  if (!res.ok) {
    const body = await res.text();
    // 429/529/5xx are load, not a bug in our request — retry them. 400/401/403 never change.
    if (TRANSIENT_STATUS.has(res.status)) throw new TransientError(`Anthropic ${res.status}: ${body}`);
    throw new Error(`Anthropic ${res.status}: ${body}`);
  }
  if (!res.body) throw new TransientError("Anthropic returned no response body to stream.");
  return readStream(res.body, onProgress);
}

// Accumulates an Anthropic SSE stream into the same {text, usage} shape the non-streaming
// path used to return, so callers are unaffected.
async function readStream(body, onProgress) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "", text = "", stopReason = null;
  const usage = {};

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // A read() boundary can land anywhere — including mid-event. Process whole lines only
    // and carry the remainder into the next read, or we silently corrupt split events.
    const lines = buf.split("\n");
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;   // skip `event:` names and blank separators
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }

      switch (ev.type) {
        case "message_start":
          Object.assign(usage, ev.message?.usage || {});
          break;
        case "content_block_delta":
          if (ev.delta?.type === "text_delta") {
            text += ev.delta.text;
            if (onProgress) onProgress(text.length);
          }
          break;
        case "message_delta":
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          // Per the docs these counts are CUMULATIVE — assign, never add, or the bill
          // we report is wrong by a growing multiple.
          if (ev.usage) Object.assign(usage, ev.usage);
          break;
        case "error": {
          // Arrives AFTER a 200 (e.g. overloaded_error). Swallowing it would look like a
          // short-but-successful response and fail JSON parsing with a useless message.
          // This is exactly what killed the first autonomous cron run, so classify it:
          // an overload is transient and must be retried, a refusal never will be.
          const type = ev.error?.type || "unknown";
          const msg = `Anthropic stream error: ${type} — ${ev.error?.message || payload}`;
          throw TRANSIENT_STREAM_ERRORS.has(type) ? new TransientError(msg) : new Error(msg);
        }
      }
    }
  }

  if (stopReason === "max_tokens") {
    throw new Error("The model's response was cut off before it finished (hit the output limit). Try a shorter transcript or raise max_tokens.");
  }
  if (stopReason === "refusal") throw new Error("The model declined to answer this request.");
  if (!text) throw new Error("Model returned no text content.");
  return { text, usage };
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in model response");
  return text.slice(start, end + 1);
}

// The model routinely puts LITERAL newlines and tabs inside string values — an email body is
// the obvious case — but strict JSON forbids raw control characters in strings (they must be
// \n, \t, etc.). JSON.parse then dies with "Bad control character in string literal", which is
// what failed the John Vachalek call AFTER the 68s debrief had already succeeded. Rather than
// throw away a completed, paid-for generation over an unescaped newline, escape control chars
// that sit INSIDE strings and retry. A parser walk (not a blind regex) is required so we only
// touch characters within string literals and respect existing backslash escapes.
function escapeControlCharsInStrings(s) {
  let out = "", inStr = false, esc = false;
  const MAP = { 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], code = s.charCodeAt(i);
    if (esc) { out += ch; esc = false; continue; }       // previous char was a backslash
    if (ch === "\\") { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && code < 0x20) {                            // a raw control char inside a string
      out += MAP[code] || "\\u" + code.toString(16).padStart(4, "0");
      continue;
    }
    out += ch;
  }
  return out;
}

// Parse a JSON object out of a model response, tolerating the one thing the model reliably gets
// wrong (raw control chars in strings). Everything else still throws — a genuinely malformed
// response should fail loudly, not be silently coerced.
function parseModelJson(text) {
  const raw = extractJson(text);
  try {
    return JSON.parse(raw);
  } catch (first) {
    if (!/control character/i.test(first.message)) throw first;   // only rescue the known case
    return JSON.parse(escapeControlCharsInStrings(raw));          // may still throw — that's fine
  }
}

// Deterministic placeholder output used until API keys are configured.
function mockOutputs(call) {
  const name = call.client_name.split(" ")[0];
  const dims = ["Rapport","Authority","Trust","Emotional Connection","Pain Amplification","Vision Building","Objection Handling","Certainty Transfer","Close Attempt","Follow-up Positioning"];
  let seed = [...call.client_name].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  return {
    model: "mock",
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    suggestedTone: "balanced",
    toneReason: "Mock generation — connect an LLM API key in Integrations for real tone analysis",
    outcome: "followup",
    debrief: {
      scorecard: dims.map(d => [d, 5 + Math.floor(rand() * 5)]),
      didWell: [`[Mock] Built rapport early with ${name}.`, "[Mock] Asked a strong discovery question mid-call."],
      hurtSale: ["[Mock] Connect an API key to get a real analysis of this transcript."],
      objections: [{ said: "[Mock objection]", meant: "—", felt: "—", should: "—", follow: "—", loop: "—" }],
      profile: ["[Mock] Real psychological profiling appears here once an LLM key is configured."],
      buyingSignals: ["[Mock] Real buying-signal detection appears here once an LLM key is configured."],
      lessons: ["[Mock] Real coaching lessons appear here once an LLM key is configured."]
    },
    ghlNote: `[Mock CRM note for ${call.client_name}] Connect an LLM API key to generate the real client profile and call summary.`,
    messages: TONES.map(tone => ({
      tone,
      sms: `[Mock ${tone} SMS] Hi ${name}, great talking today — I'll follow up shortly.`,
      emailSubject: `[Mock ${tone}] Following up on our call`,
      email: `Hi ${name},\n\n[Mock ${tone} email body — connect an LLM API key in Integrations to generate the real draft.]\n\n— Gabriel`
    }))
  };
}
