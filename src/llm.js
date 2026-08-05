// All model calls happen here, server-side only. With no API keys configured, generation
// falls back to clearly-labeled mock output so the app is fully usable before setup.
import { SPECIMEN } from "./specimen.js";
import { thinkingFor, DEFAULT_MODEL, modelSpec, DEFAULT_EFFORT } from "./models.js";

const TONES = ["casual", "balanced", "formal"];

// What a call scored on before call types existed. Used ONLY as the fallback for a call with no
// type, so pre-existing calls keep behaving exactly as they did.
const LEGACY_DIMENSIONS = ["rapport", "authority", "trust", "emotional connection",
  "pain amplification", "vision building", "objection handling", "certainty transfer",
  "close attempt", "follow-up positioning"];

// Resolves an API key for an account+provider. Prefers the key pasted into the
// Integrations UI (stored in D1); falls back to a Cloudflare secret so anything
// previously set via `wrangler secret put` keeps working. Returns null if neither
// exists, which puts generation into labeled mock mode rather than erroring.
// EVERY ACCOUNT USES ITS OWN KEY. There is no platform fallback, and adding one back is a
// product decision, not a convenience (TASK-108).
//
// This used to end with `return envKeys[kind] || null`, so an account with no key silently
// borrowed the platform's. With a single tenant that was a harmless convenience. It becomes two
// separate incidents the moment a second account exists:
//
//   COST — Ivan, 2026-08-04, on why clients bring their own key: owning their model access
//   "leaves us open to having our API abused and owing hundreds of thousands." An account with
//   no key would have billed him, with no ceiling and no error to notice.
//
//   CROSS-TENANT DATA — worse, and not what the task was opened for. An empty `fathom` row fell
//   back to FATHOM_API_KEY_OSA, so a new tenant who created a Fathom integration and never
//   pasted a key would have polled GABRIEL'S calls into their own account. Real client
//   transcripts, delivered to a stranger, with every log line reading as success.
//
// A missing key must be visible. Silence is what made both of those possible.
export async function resolveKey(env, accountId, kind) {
  const row = await env.DB.prepare(
    "SELECT secret_value FROM integrations WHERE account_id = ? AND kind = ?"
  ).bind(accountId, kind).first();
  return row?.secret_value || null;
}

// Resolves the key for a SPECIFIC integration row, not a re-query by (account_id, kind).
// This matters once an account has more than one row of a kind (a second Fathom key,
// TASK-054): resolveKey would return whichever row it found first, so both Fathom rows would
// use the same key — polling one workspace twice and the other never. Always use this when
// you already hold the row.
//
// No env argument, deliberately. It took one only to reach the platform fallback, and removing
// the parameter means a future edit cannot quietly reintroduce it here (TASK-108).
export function keyForRow(row) {
  return row?.secret_value || null;
}

// Rough expected output sizes, used ONLY to turn streamed bytes into a percentage.
// They are estimates and are treated as such: progress is capped at each step's ceiling
// rather than allowed to overshoot, and it cannot advance unless real bytes arrive.
const EXPECTED_DEBRIEF_CHARS = 20000;   // enriched, structured debrief + richer GHL note (TASK-089)
const EXPECTED_MESSAGE_CHARS = 1500;    // one tone's SMS + email
const DEBRIEF_SHARE = 70;               // debrief is the long pole: 0-70%, messages 70-100%

// `callType` (from the call's label) supplies the prompt, the scorecard dimensions and which
// outputs to produce. NOTHING about the output shape is hardcoded here any more — that was the
// TASK-021 blocker: 10 dimensions incl. "pain amplification" were baked in, so editing a prompt
// could never change what got scored, and a team call was graded like a sales call.
// TASK-101 — turn the raw stream into something worth watching.
//
// The debrief pass streams JSON, so showing the tail verbatim gives Gabriel `","sayInstead":"`
// which reads as breakage, not progress. This pulls out the VALUES and drops the keys, so what
// he sees is the analysis being written in prose, a few lines behind the model.
//
// Deliberately forgiving: it runs on a half-finished document on every tick, so it must never
// throw and must never block the generation it is only decorating. Worst case it returns "".
const PREVIEW_CHARS = 900;
export function readableTail(raw, limit = PREVIEW_CHARS) {
  if (!raw) return "";
  try {
    const out = [];
    // Walk complete "..." literals, honouring backslash escapes so an escaped quote inside a
    // sentence does not end the string early and shred the line.
    const re = /"((?:[^"\\]|\\.)*)"(\s*:)?/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m[2]) continue;                       // trailed by ':' -> it is a key, not content
      const v = m[1].replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim();
      if (v) out.push(v);
    }
    // Whatever is mid-flight after the last complete literal — the sentence being typed now.
    // This is the part that actually makes it feel live, so it is worth the extra care.
    const openQuote = raw.lastIndexOf('"');
    if (openQuote !== -1) {
      const trailing = raw.slice(openQuote + 1);
      if (trailing && !trailing.includes('"')) {
        const v = trailing.replace(/\\n/g, " ").trim();
        if (v) out.push(v);
      }
    }
    const joined = out.join(" · ");
    return joined.length > limit ? "…" + joined.slice(-limit) : joined;
  } catch {
    return "";   // a preview must never be able to break a paid generation
  }
}

export async function generateOutputs(env, { account, call, masterPrompt, callType, onStep, onProgress, onPreview }) {
  const provider = account.llm_provider || "anthropic";
  // One model for the whole run. Mixing models mid-generation would let the debrief and the
  // drafts disagree about register, and would make the logged cost unattributable.
  const model = account.llm_model || DEFAULT_MODEL;
  // The setting governs the DEBRIEF pass only. The drafts stay at "low" — they are short
  // pieces of writing, and paying max-effort rates to compose a two-line SMS buys nothing.
  const effort = account.llm_effort || DEFAULT_EFFORT;
  const key = await resolveKey(env, account.id, provider);
  if (!key) {
    // Mock mode is now OPT-IN, and production never opts in (TASK-108).
    //
    // This used to be `if (!key) return mockOutputs(call)` unconditionally, which is the right
    // behaviour on a laptop and the wrong one everywhere else. A second tenant who had not
    // pasted a key would not have seen an error — they would have received a fabricated
    // debrief, a fabricated scorecard, and three fabricated client-facing drafts. The `[mock]`
    // prefixes are honest, but nothing about the flow says "this is not your call", and the
    // drafts are the part someone copies into an email to a real buyer.
    //
    // Failing closed is the safer default: an error costs someone a confused minute, and
    // invented analysis of a sales call they just had costs them the deal.
    if (env.ALLOW_MOCK_GENERATION === "1") return mockOutputs(call);
    throw new Error(
      "No API key is connected for this account. Open Settings > Integrations and paste your " +
      "Anthropic key — Closer runs every generation on your own key, so nothing happens until it is there."
    );
  }

  // Resolve the type config, falling back to legacy sales behaviour if a call has no type.
  //
  // NOTE the two different empty cases, they are NOT the same thing:
  //   • callType exists with dimensions_json '[]'  -> deliberately NO scorecard (internal call)
  //   • callType missing entirely (legacy/unlabelled) -> the original 10 sales dimensions
  // Defaulting the legacy case to [] silently stripped the scorecard off every unlabelled call.
  const dims = (() => {
    if (!callType) return LEGACY_DIMENSIONS;
    try { const d = JSON.parse(callType.dimensions_json || "[]"); return Array.isArray(d) ? d : []; }
    catch { return LEGACY_DIMENSIONS; }
  })();
  const wantMessages = callType ? !!callType.produces_messages : true;
  const wantCrmNote  = callType ? !!callType.produces_crm_note  : true;
  const prompt = callType?.prompt_body || masterPrompt || "";

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
  // OUTPUT-DEPTH REBUILD (TASK-089). The old schema asked for flat string[] fields, which ground
  // ChatGPT's titled, quote-backed, rewrite-carrying analysis (Gabriel's "GAB sales" standard)
  // down to thin bullets. The schema WAS the bottleneck, not the prompt. Every analytical field
  // is now a structured object that preserves the specific quoted moment, the reasoning, and —
  // for every criticism — the exact better wording. Reference: the Brandon specimen in the vault
  // (60 Reference/GAB sales report — the output-quality target).
  const schemaParts = [];
  // Sales-frame fields (diagnosis, overall score, outcome summary, missed openings) are gated to
  // scored/sales types — a client or internal call should not be forced into a sales narrative.
  if (dims.length) {
    schemaParts.push(
      'diagnosis (string, 2-4 sentences: the opinionated executive read that opens the report. Name what this call ACTUALLY was (e.g. a strong technical sale stalled at diligence, not a failed call), the SINGLE central issue that decides the deal, and the correct next move. Take a position.)',
      `scorecard (array of [label, score1to10, note] triples, one for EACH of exactly these dimensions in this order: ${dims.join(", ")}. note = a short one-line diagnosis of WHY that score.)`,
      "overallScore (number 1-10, one decimal allowed: the overall call score)",
      "outcomeSummary (string, one sentence: the precise commercial outcome — what was agreed, what is pending, and why payment/signature did or did not happen)"
    );
  }
  schemaParts.push(
    "didWell (array of {move (string: the specific thing done well; quote the client's reaction verbatim where there is one), why (string: why it worked)})",
    "hurtSale (array of {issue (string: what worked against the goal of this call; quote it), why (string: why it cost trust or momentum), sayInstead (string, REQUIRED: the exact better wording or move — never just name the problem without the fix)})",
    "objections (array of {said (string: the client's VERBATIM words), meant (string), felt (string), rootFear (string: the deep emotional driver beneath the surface excuse), should (string: the exact better line to have said), follow (string: the best follow-up question to have asked), loop (string: how to loop back to it later)} — use [] if the call had none)",
    "profile (object: {dominantFears (string[]), valuesHierarchy (string[], ranked most-important first), decisionSpeed (string), certaintyNeed (string), emotionalWound (string: include the client's verbatim quote if there is one), trustTriggers (string[]), resistancePatterns (string[]), identityStyle (string), disc (string, e.g. \"High D / High C\")})",
    "buyingSignals (object: {genuine (string[]: real intent signals), false (string[]: acknowledgements like 'yep'/'makes sense' that were understanding, not commitment)})",
    "lessons (string[]: generalizable coaching principles, each a titled one-liner)",
    'outcome ("closed"|"followup")',
    'followUp (object: {nextStep (string: the single concrete next action actually agreed), timing (string: when the next contact was agreed, or ""), commitments (string[]: anything the host promised to do or send), personalDetails (string[]: specifics worth referencing in a follow-up)})',
    // TASK-085 (adaptive output selection). Gabriel narrates his own follow-up on the call
    // ("I'm going to send you an email, and it's going to have this, and this"). This is the
    // ONLY pass that sees the transcript, so it must capture those commitments verbatim; the
    // drafts are built downstream from what we extract here, never from the transcript.
    'statedFollowUps (array of {channel ("email"|"text"|"other"), said (string: Gabriel\'s own words where he told the client what he would send or do next), contains (string[]: the specific items/links/documents he said it would include)} — read the transcript for moments where Gabriel commits to sending something after the call; capture each; use [] if he committed to nothing specific)',
    // TASK-086 (recipient profile). A profile of the CLIENT, from THEIR language — not to make
    // the follow-up sound like Gabriel, but like exactly what this person needs to hear. The
    // "disclosed" list is the point: the personal facts a client volunteers (a doctor, a
    // sister) that never register live but matter to them.
    'recipientProfile (object: {communicationStyle (string: how this client actually talks and takes in information, inferred from their own words on the call — e.g. brief and bottom-line, warm and story-led, detail-hungry, guarded), caresAbout (string[]: what the client signalled matters to them), disclosed (string[]: personal facts the client volunteered — job, family, life details worth referencing in a follow-up), bestReceivedAs (string: one line on how to shape a follow-up so it lands for THIS person), detailPreference ("brief" if this person wants a short warm note, "detailed" if this analytical/high-C person wants a structured follow-up that itemises the specifics and unresolved points)})'
  );
  // Missed micro-commitments — the coaching gold in the specimen: the exact question that would
  // have converted a moment of excitement into defined scope. Sales-frame only.
  if (dims.length) {
    schemaParts.push('missedOpenings (array of {moment (string: the point in the call), askInstead (string: the exact micro-commitment question to have asked there)} — use [] if none)');
  }
  if (wantMessages) schemaParts.push('suggestedTone ("casual"|"balanced"|"formal")', "toneReason (string)");
  // TASK-089 (GHL note, finished against the specimen). The Brandon report is now the reference,
  // so the note matches its richer section set — not just a recap, but retention risk, upsell
  // openings, personal rapport, and a follow-up task checklist a teammate could act on cold.
  // Plain text, because a GoHighLevel note is pasted plain and markdown may not render.
  if (wantCrmNote) schemaParts.push(
    'ghlNote (string, under 8000 chars: a scannable CRM note anyone on the team could act on cold. ' +
    'PLAIN TEXT ONLY — no markdown, no # or *. Format: a SHORT UPPERCASE section header on its own line, ' +
    'then "- " bullets, then a blank line before the next section. Bullets, not paragraphs. Be concise. ' +
    'Sections in this order, each included only if there is genuinely something to say: ' +
    'OUTCOME (what was agreed, what is pending, the next step + date), ' +
    'CLIENT (who they are and their situation), ' +
    'GOALS (what they want / why they took the call), ' +
    'PAIN POINTS (the real problems, not inflated ones), ' +
    'OBJECTIONS (the concerns raised and the root fear behind them), ' +
    'SELLING POINTS (angles likely to land next time), ' +
    'WATCH OUT FOR (sensitivities and pitfalls to avoid), ' +
    'FOLLOW-UP TASKS (a checklist of the concrete next actions), ' +
    'RETENTION RISK (what could lose this client, and what reduces it), ' +
    'UPSELL (specific expansion openings, if any), ' +
    'PERSONAL RAPPORT (personal details the client volunteered, for the next human touch))');

  // The worked example goes FIRST and in its own content block (TASK-096): first because a
  // cached prefix has to be a prefix, and separate because it is static across every call
  // while everything after it changes. Scoped to the debrief pass alone — see the warning in
  // specimen.js; this is criticism OF GABRIEL and must never reach a client-facing draft.
  const debriefRes = await completeWithRetry(env, provider, key, [
    { role: "user", content: [
      { type: "text", text: SPECIMEN, cache_control: { type: "ephemeral" } },
      { type: "text", text: `${prompt}\n\nReturn ONLY valid JSON with keys: ${schemaParts.join(", ")}.\n\nTranscript:\n${call.transcript}` }
    ] }
  ], { model, effort, think: false, maxTokens: 24000,
       onRetry: r => onStep && onStep({ step: "retry", detail: `debrief attempt ${r.attempt} failed (${r.error}) — retrying in ${r.backoffMs}ms` }),
       onProgress: (chars, raw) => {
         report(Math.min(chars / EXPECTED_DEBRIEF_CHARS, 1) * DEBRIEF_SHARE, "Analysing the call");
         // Only the debrief streams a preview. It is the pass that takes minutes and the only
         // one Gabriel ever waits on; the three draft passes finish fast enough that a preview
         // would flicker. It is also the ONLY pass that has read the transcript, so this stays
         // inside the app for Gabriel and never travels — same boundary as the specimen.
         //
         // Hands over the RAW text and does no work here. This fires on every single delta —
         // thousands of times per generation — so running the extraction at this point would
         // re-scan a document that grows to ~90KB on every token and burn the Worker's CPU
         // budget on decoration. The consumer extracts once, only when it is about to write.
         if (onPreview) onPreview(raw);
       } });
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
  if (wantMessages) assertDraftable(parsed);
  const ctx = draftContext(call, parsed);
  const toneChars = new Map(TONES.map(t => [t, 0]));   // shared so the 3 jobs report one combined bar
  const msgJobs = !wantMessages ? [] : TONES.map(async tone => {
    const res = await completeWithRetry(env, provider, key, [
      { role: "user", content: `You are drafting a follow-up SMS and email from Gabriel, a high-ticket sales closer, to a client he just got off a call with.

You are NOT given the transcript. The summary below was extracted from it by a prior analysis pass — treat it as the complete and authoritative record of what happened. Do NOT invent facts, commitments, prices, or dates that are not in it.

Tone: ${tone}.
Write to the actual outcome (${parsed.outcome}) — do not imply a close that did not happen.

DELIVER WHAT GABRIEL PROMISED. If "statedFollowUps" is non-empty, it is what Gabriel told the client on the call he would send or do next. The email must deliver exactly those things, including the specific items he named in "contains" — do not drop anything he promised, and do not add promises he did not make.

WRITE BOTH, ALWAYS. Return a non-empty SMS and a non-empty email even if Gabriel only mentioned one of them on the call. The SMS is a short, warm note that ends the conversation on a good note — worth sending whether or not there was a sale. Never return an empty "sms".

WRITE FOR THE RECIPIENT, NOT FOR GABRIEL. Use "recipientProfile" to shape how this lands: match how this specific client takes in information and reference what they disclosed and care about. The goal is not to sound like Gabriel — it is to say exactly what this person needs to hear, in the way they best receive it.

MATCH THE SHAPE TO THE PERSON. If recipientProfile.detailPreference is "detailed" (an analytical, high-C buyer), the EMAIL should be structured and specific: acknowledge alignment briefly, then itemise the concrete points — what was agreed, what is pending, what happens next — as a short bulleted list they can act on. If it is "brief" (a relational buyer), the email is a short warm note, no lists. The SMS is always short regardless.

USE BOUNDED CERTAINTY. Skeptical and technical buyers lose trust on absolute claims. Do NOT write "perfect", "always", "never", "guaranteed", or "we do anything" unless the call summary explicitly states that promise. Prefer "designed to", "typically", "we'll confirm", "the plan is".

Ground everything in the specific details below — their situation, their own phrasing, what was agreed — so it reads like a real message about a real call, not a template.

Call summary:
${ctx}

Return ONLY JSON: {"sms": "...", "emailSubject": "...", "email": "..."}` }
    ], { model, effort: "low", think: false,
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
  if (wantMessages && onStep) await onStep({ step: "messages", duration_ms: Date.now() - t1 });
  if (!wantMessages) report(99, "Finishing up");

  return {
    model: provider,
    usage: total,
    debrief: parsed,
    ghlNote: wantCrmNote ? parsed.ghlNote : null,
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
  // profile is now a structured object (TASK-089) or, on legacy calls, a string[]. Carry only
  // the parts that help a draft LAND — what the client values and trusts — not the whole
  // behavioural analysis. Tolerate both shapes so old processed calls still draft correctly.
  const p = parsed.profile;
  const clientProfile = Array.isArray(p) ? p
    : (p && typeof p === "object") ? { values: p.valuesHierarchy, trustTriggers: p.trustTriggers, style: p.communicationStyle }
    : p;
  // buyingSignals is now {genuine, false} or, on legacy calls, a string[]. The drafts only want
  // the genuine signals.
  const bs = parsed.buyingSignals;
  const buyingSignals = Array.isArray(bs) ? bs : (bs && typeof bs === "object" ? bs.genuine : bs);
  return JSON.stringify({
    clientName: call.client_name,
    outcome: parsed.outcome,
    nextStep: f.nextStep,
    timing: f.timing,
    gabrielCommitted: f.commitments,
    personalDetails: f.personalDetails,
    clientProfile,
    buyingSignals,
    // TASK-085: what Gabriel told the client he would send. The email/SMS must DELIVER exactly
    // this, so it has to cross into the draft pass. It is his own words to the client, not
    // critique of him, so it is safe under the guard below.
    statedFollowUps: parsed.statedFollowUps,
    // TASK-086: how THIS client best receives a message. Also client-facing, also safe.
    recipientProfile: parsed.recipientProfile,
    // `said` is the client's verbatim objection; `rootFear` is the client's real concern — both
    // client-facing, and a draft that addresses the real fear lands better. `should`/`felt` are
    // coaching notes for Gabriel and stay OUT.
    objections: (parsed.objections || []).map(o => ({ said: o.said, meant: o.meant, rootFear: o.rootFear, resolveWith: o.follow }))
  }, null, 1);
  // GUARD (TASK-042/089): the executive diagnosis, scorecard, didWell, hurtSale, lessons,
  // missedOpenings and ghlNote are NEVER included — every one of them is coaching critique OF
  // Gabriel (or a strategy note for his next call), and a client-facing draft must not be built
  // from them. Everything above is the client's own words/situation or Gabriel's commitments to
  // the client. If you add a field here, it must pass that same test.
}

// TASK-089 turned several flat string[] fields into structured objects. These two helpers are
// the ONE place that knows how to read either shape, so every consumer — the draftable guard,
// the insights aggregate in index.js, the front end — agrees. Do not re-implement locally.

// Does this field carry anything, whether it is a string, an array, or an object of arrays?
export function hasContent(v) {
  if (!v) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.values(v).some(hasContent);
  return String(v).trim().length > 0;
}

// A didWell / hurtSale entry is a string (legacy) or {move|issue, why, sayInstead} (TASK-089).
// Returns the human-readable line, so an aggregate never renders "[object Object]".
export function debriefLine(x) {
  if (!x) return "";
  if (typeof x === "string") return x;
  return x.issue || x.move || "";
}

// A draft built from an empty distillation does not fail — it produces fluent, generic filler
// that reads fine and says nothing about the actual call. That is worse than an error, because
// nobody catches it. Fail loudly instead.
function assertDraftable(parsed) {
  const f = parsed.followUp || {};
  const missing = [];
  if (!parsed.outcome) missing.push("outcome");
  if (!f.nextStep) missing.push("followUp.nextStep");
  // Shape-tolerant (TASK-090). `profile` became an OBJECT in TASK-089, and the old
  // `Array.isArray(profile)` check silently stopped counting it as colour — so a smooth call
  // with a rich profile but no objections and no personalDetails would fail the WHOLE
  // generation after the debrief had already been paid for. Count content in either shape.
  const hasColour = [f.personalDetails, parsed.profile, parsed.objections, parsed.recipientProfile]
    .some(hasContent);
  if (!hasColour) missing.push("followUp.personalDetails / profile / objections / recipientProfile (all empty)");
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
  // maxTokens is per-call: the enriched debrief (TASK-089) can run long, and a truncated JSON
  // fails the WHOLE call (there is no partial parse). The drafts are short and keep the default.
  const { effort = "medium", think = false, onProgress, maxTokens = 16000,
          model = DEFAULT_MODEL } = opts;
  // Resolved once, here, so every caller gets the per-model handling without knowing about it.
  const thinkingParam = thinkingFor(model, think, effort);
  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.2", messages, max_completion_tokens: maxTokens }),
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
      // `thinking` is OMITTED entirely when the model requires it (Fable 5) rather than sent
      // as null — see models.js. Sending {type:"disabled"} to Fable is a 400, not a downgrade.
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(thinkingParam === undefined ? {} : { thinking: thinkingParam }),
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
            // The accumulated text rides along as the second argument (TASK-101). It was
            // already here and was being discarded — every caller got a character count and
            // nothing else, which is why the UI could only ever draw a progress bar while
            // Gabriel waited three minutes at a screen that looked frozen. Callers that only
            // want the count keep working: they just ignore the second argument.
            if (onProgress) onProgress(text.length, text);
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
      // Enriched shapes (TASK-089) so dev/mock mode shows the real structure.
      diagnosis: `[Mock] Executive read appears here once an LLM key is configured — what this call actually was, the one issue that decides it, and the next move.`,
      scorecard: dims.map(d => [d, 5 + Math.floor(rand() * 5), "[mock] one-line why"]),
      overallScore: 7.0,
      outcomeSummary: "[Mock] The precise commercial outcome appears here once an LLM key is configured.",
      didWell: [{ move: `[Mock] Built rapport early with ${name}.`, why: "[mock] why it worked" }],
      hurtSale: [{ issue: "[Mock] a moment that cost momentum", why: "[mock] why", sayInstead: "[mock] the exact better line" }],
      objections: [{ said: "[Mock objection]", meant: "—", felt: "—", rootFear: "—", should: "—", follow: "—", loop: "—" }],
      profile: { dominantFears: ["[mock] fear"], valuesHierarchy: ["[mock] reliability", "[mock] price"],
        decisionSpeed: "[mock]", certaintyNeed: "[mock]", emotionalWound: "[mock]",
        trustTriggers: ["[mock] specificity"], resistancePatterns: ["[mock]"], identityStyle: "[mock]", disc: "[mock] High D / High C" },
      buyingSignals: { genuine: ["[Mock] a real intent signal"], false: ["[Mock] a polite 'yep' mistaken for commitment"] },
      lessons: ["[Mock] a generalizable coaching lesson appears here once an LLM key is configured."],
      missedOpenings: [{ moment: "[mock] a moment of excitement", askInstead: "[mock] the exact question to have asked" }],
      statedFollowUps: [{ channel: "email", said: `[Mock] "I'll send you an email with the details."`, contains: ["[Mock] the item Gabriel said he'd include"] }],
      recipientProfile: { communicationStyle: "[Mock] how this client talks — real analysis needs an LLM key.",
        caresAbout: ["[Mock] what the client cares about"], disclosed: ["[Mock] a personal detail the client volunteered"],
        bestReceivedAs: "[Mock] how to shape the follow-up for this person.", detailPreference: "brief" }
    },
    ghlNote: [
      `OUTCOME`, `- [mock] what was agreed + what's pending + next step`, ``,
      `CLIENT`, `- ${call.client_name} — [mock] connect an LLM key for the real profile`, ``,
      `GOALS`, `- [mock] what they came for`, ``,
      `PAIN POINTS`, `- [mock] the real problems`, ``,
      `OBJECTIONS`, `- [mock] concern + the root fear`, ``,
      `SELLING POINTS`, `- [mock] angles likely to land next time`, ``,
      `WATCH OUT FOR`, `- [mock] sensitivities and pitfalls`, ``,
      `FOLLOW-UP TASKS`, `- [mock] next concrete action`, ``,
      `RETENTION RISK`, `- [mock] what could lose them`, ``,
      `UPSELL`, `- [mock] expansion opening`, ``,
      `PERSONAL RAPPORT`, `- [mock] a personal detail for the next touch`
    ].join("\n"),
    messages: TONES.map(tone => ({
      tone,
      sms: `[Mock ${tone} SMS] Hi ${name}, great talking today — I'll follow up shortly.`,
      emailSubject: `[Mock ${tone}] Following up on our call`,
      email: `Hi ${name},\n\n[Mock ${tone} email body — connect an LLM API key in Integrations to generate the real draft.]\n\n— Gabriel`
    }))
  };
}
