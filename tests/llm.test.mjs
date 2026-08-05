// Generation-pipeline guarantees, verified against the REAL generateOutputs
// (TASK-085/086/087/088/089). Deterministic — no API key. It cannot judge wording (that needs a
// live model), but it proves the plumbing that is a RELEASE BLOCKER:
//
//   1. THE GUARD. Coaching critique of Gabriel — the executive diagnosis, scorecard (+notes),
//      overall score/outcome summary, didWell, hurtSale (incl. the "say instead" rewrites),
//      lessons, missed openings, and the GHL note — must NEVER reach a client-facing draft.
//      draftContext() is the only thing between the debrief and the email. Every critique field
//      carries a SENTINEL, and we assert none appear in what the drafts are built from. Verified
//      to FAIL if a leak is reintroduced.
//   2. THE SMS IS NEVER SUPPRESSED, even on an email-only call.
//   3. The enriched debrief (TASK-089) and adaptive-draft plumbing (recipientProfile.detailPreference,
//      bounded-certainty) are wired, and the new fields survive into what workflow.js persists.
import { generateOutputs, hasContent, debriefLine } from "../src/llm.js";
import { SPECIMEN_APPROX_TOKENS as SPECIMEN_TOKENS } from "../src/specimen.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let pass = 0, fail = 0;
const check = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "  pass" : "  FAIL"}  ${n}${d && !c ? `  <- ${d}` : ""}`); };

function sseStream(text, { chunk = 24 } = {}) {
  let sse = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } })}\n\n`;
  for (let i = 0; i < text.length; i += 40) {
    sse += `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: text.slice(i, i + 40) } })}\n\n`;
  }
  sse += `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 200 } })}\n\n`;
  sse += `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
  const bytes = new TextEncoder().encode(sse);
  let pos = 0;
  return new ReadableStream({ pull(c) { if (pos >= bytes.length) return c.close(); c.enqueue(bytes.slice(pos, pos + chunk)); pos += chunk; } });
}

// Enriched debrief (TASK-089). Every CRITIQUE-of-Gabriel field is seeded with a sentinel we then
// hunt for in the drafts; client-facing fields carry sentinels we expect TO cross.
const DEBRIEF = {
  diagnosis: "SENTINEL_DIAGNOSIS a strong technical sale stalled at diligence",
  scorecard: [["SENTINEL_SCORELABEL rapport", 5, "SENTINEL_SCORENOTE weak on isolation"]],
  overallScore: 7.7,
  outcomeSummary: "SENTINEL_OUTCOMESUMMARY verbal yes, payment pending contract",
  didWell: [{ move: "SENTINEL_DIDWELL opened with authority", why: "SENTINEL_DIDWELLWHY set the frame" }],
  hurtSale: [{ issue: "SENTINEL_HURTSALE talked over the client", why: "SENTINEL_HURTWHY lost trust", sayInstead: "SENTINEL_SAYINSTEAD ask, then stop" }],
  lessons: ["SENTINEL_LESSON isolate the price before answering"],
  missedOpenings: [{ moment: "SENTINEL_MISSEDMOMENT after he praised switching", askInstead: "SENTINEL_MISSEDASK would three environments cover it" }],
  objections: [{ said: "SENTINEL_SAID I need to talk to my wife", meant: "not sold yet",
                 felt: "SENTINEL_FELT cornered", rootFear: "SENTINEL_ROOTFEAR being burned again",
                 should: "SENTINEL_SHOULD what will her first question be", follow: "loop back on cost of waiting", loop: "revisit after onboarding" }],
  profile: { dominantFears: ["SENTINEL_FEAR abandonment after payment"], valuesHierarchy: ["SENTINEL_VALUE reliability", "price"],
             decisionSpeed: "fast after evidence", certaintyNeed: "very high", emotionalWound: "SENTINEL_WOUND burned by vendors",
             trustTriggers: ["SENTINEL_TRUST specificity"], resistancePatterns: ["stress-tests the contract"], identityStyle: "competent operator", disc: "High D / High C" },
  buyingSignals: { genuine: ["SENTINEL_GENUINE asked for ACH"], false: ["SENTINEL_FALSE a polite yep"] },
  outcome: "followup",
  followUp: { nextStep: "Call Thursday", timing: "Thu 4pm", commitments: ["send the onboarding overview"], personalDetails: ["daughter graduates in May"] },
  statedFollowUps: [{ channel: "email", said: "SENTINEL_STATED I'll send you an email with the onboarding steps", contains: ["SENTINEL_CONTAINS the onboarding steps", "the pricing breakdown"] }],
  recipientProfile: { communicationStyle: "SENTINEL_RECIPSTYLE brief and bottom-line", caresAbout: ["SENTINEL_CARES protecting his crew's time"],
                      disclosed: ["SENTINEL_DISCLOSED his daughter is graduating"], bestReceivedAs: "SENTINEL_BESTAS short concrete bullets", detailPreference: "detailed" },
  suggestedTone: "balanced", toneReason: "warm but businesslike",
  ghlNote: "SENTINEL_GHLNOTE OUTCOME\n- verbal yes"
};
const DRAFT = { sms: "Hey Marcus, great talking today.", emailSubject: "Following up", email: "Hi Marcus, as promised..." };

const CALLTYPE = { name: "Sales call", prompt_body: "SALES PROMPT", dimensions_json: JSON.stringify(["rapport"]), produces_messages: 1, produces_crm_note: 1 };
const call = { id: 1, client_name: "Marcus Webb", transcript: "Gabriel: hi.\n" + "Client: I'm stuck.\n".repeat(400) };
const account = { id: 1, llm_provider: "anthropic" };
const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ secret_value: "sk-test" }) }) }) } };

// The debrief pass sends an ARRAY of content blocks (the cached worked example, then the
// prompt); the draft passes still send a plain string. Every assertion below reads through
// this, so adding or removing a block cannot silently change what the tests inspect.
const textOf = c => Array.isArray(c) ? c.map(b => b.text || "").join("\n") : String(c || "");

let bodies = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  bodies.push(body);
  const isDebrief = textOf(body.messages[0].content).includes("Return ONLY valid JSON with keys");
  return { ok: true, body: sseStream(JSON.stringify(isDebrief ? DEBRIEF : DRAFT)) };
};

const out = await generateOutputs(env, { account, call, masterPrompt: "M", callType: CALLTYPE });
const debriefBody = bodies[0];
const debriefPrompt = textOf(debriefBody.messages[0].content);
const draftPrompts = bodies.slice(1).map(b => textOf(b.messages[0].content));
const allDrafts = draftPrompts.join("\n");

console.log("\n== the pipeline ran the expected calls ==");
check("1 debrief + 3 tone drafts", bodies.length === 4, `got ${bodies.length}`);
check("the debrief is the only call carrying the transcript",
  bodies.filter(b => textOf(b.messages[0].content).includes("Client: I'm stuck")).length === 1);

// The smooth-call scenario below resets `bodies`. Snapshot the first run so later assertions
// inspect the run they were written about.
const firstRun = bodies.slice();

console.log("\n== THE GUARD: no coaching critique of Gabriel reaches a client-facing draft ==");
for (const [label, sentinel] of [
  ["executive diagnosis", "SENTINEL_DIAGNOSIS"], ["scorecard label", "SENTINEL_SCORELABEL"], ["scorecard note", "SENTINEL_SCORENOTE"],
  ["outcome summary", "SENTINEL_OUTCOMESUMMARY"], ["didWell", "SENTINEL_DIDWELL"], ["didWell why", "SENTINEL_DIDWELLWHY"],
  ["hurtSale", "SENTINEL_HURTSALE"], ["hurtSale why", "SENTINEL_HURTWHY"], ["hurtSale 'say instead' rewrite", "SENTINEL_SAYINSTEAD"],
  ["lessons", "SENTINEL_LESSON"], ["missed opening moment", "SENTINEL_MISSEDMOMENT"], ["missed opening ask", "SENTINEL_MISSEDASK"],
  ["ghlNote", "SENTINEL_GHLNOTE"], ["objection.felt", "SENTINEL_FELT"], ["objection.should (coaching)", "SENTINEL_SHOULD"],
  ["profile.emotionalWound", "SENTINEL_WOUND"], ["profile.dominantFears", "SENTINEL_FEAR"], ["buyingSignals.false", "SENTINEL_FALSE"]
]) {
  check(`${label} never appears in any draft prompt`, !allDrafts.includes(sentinel), `LEAKED — release blocker`);
}

console.log("\n== carry-forward: the drafts DO get what they legitimately need ==");
for (const [label, sentinel] of [
  ["statedFollowUps ('said')", "SENTINEL_STATED"], ["statedFollowUps contents", "SENTINEL_CONTAINS"],
  ["recipientProfile.communicationStyle", "SENTINEL_RECIPSTYLE"], ["recipientProfile.disclosed (the 'doctor' fix)", "SENTINEL_DISCLOSED"],
  ["recipientProfile.bestReceivedAs", "SENTINEL_BESTAS"], ["the client's verbatim objection", "SENTINEL_SAID"],
  ["the objection's root fear (client-facing)", "SENTINEL_ROOTFEAR"], ["profile.valuesHierarchy", "SENTINEL_VALUE"],
  ["profile.trustTriggers", "SENTINEL_TRUST"], ["genuine buying signals", "SENTINEL_GENUINE"]
]) {
  check(`${label} crosses into the drafts`, allDrafts.includes(sentinel));
}

console.log("\n== adaptive draft shape + bounded certainty (TASK-089) ==");
check("recipientProfile.detailPreference crosses into the draft context", allDrafts.includes('"detailPreference": "detailed"'));
check("draft prompt: match the shape to the person", draftPrompts.every(p => /MATCH THE SHAPE TO THE PERSON/.test(p) && /detailPreference/.test(p)));
check("draft prompt: use bounded certainty (no absolute claims)", draftPrompts.every(p => /USE BOUNDED CERTAINTY/.test(p)));
check("draft prompt still tells the model to deliver what Gabriel promised", draftPrompts.every(p => /DELIVER WHAT GABRIEL PROMISED/.test(p)));

console.log("\n== the SMS is never suppressed (email-only call) ==");
check("all three tones generated", out.messages.length === 3, `got ${out.messages.length}`);
check("every tone returns a non-empty SMS", out.messages.every(m => m.sms && m.sms.trim().length));
check("the draft prompt instructs: never return an empty SMS", draftPrompts.every(p => /Never return an empty "sms"|Return a non-empty SMS/i.test(p)));

console.log("\n== token budget: the enriched debrief gets more headroom so it can't silently truncate ==");
check("debrief request uses max_tokens 24000", debriefBody.max_tokens === 24000, String(debriefBody.max_tokens));
check("draft requests keep max_tokens 16000", bodies.slice(1).every(b => b.max_tokens === 16000));

console.log("\n== new fields survive into what workflow.js persists ==");
check("gen.debrief.diagnosis present", typeof out.debrief.diagnosis === "string" && out.debrief.diagnosis.length > 0);
check("gen.debrief.profile is the structured object", out.debrief.profile && !Array.isArray(out.debrief.profile) && !!out.debrief.profile.disc);
check("gen.debrief.buyingSignals is {genuine,false}", out.debrief.buyingSignals && Array.isArray(out.debrief.buyingSignals.genuine));
check("gen.debrief.missedOpenings present", Array.isArray(out.debrief.missedOpenings) && out.debrief.missedOpenings.length === 1);
check("gen.debrief.recipientProfile.detailPreference persisted", out.debrief.recipientProfile.detailPreference === "detailed");
check("gen.ghlNote still surfaced (fine in the CRM, barred from DRAFTS)", out.ghlNote === DEBRIEF.ghlNote);

console.log("\n== the debrief schema actually ASKS for the enriched shape ==");
check("asks for the executive diagnosis", /diagnosis \(string/.test(debriefPrompt));
check("scorecard asks for [label, score, note] triples", /\[label, score1to10, note\]/.test(debriefPrompt));
check("asks for overallScore + outcomeSummary", /overallScore/.test(debriefPrompt) && /outcomeSummary/.test(debriefPrompt));
check("hurtSale must carry 'sayInstead'", /sayInstead \(string, REQUIRED/.test(debriefPrompt));
check("objection asks for rootFear", /rootFear/.test(debriefPrompt));
check("profile is the structured behavioural object", /valuesHierarchy/.test(debriefPrompt) && /trustTriggers/.test(debriefPrompt) && /disc/.test(debriefPrompt));
check("asks for missedOpenings", /missedOpenings/.test(debriefPrompt));
check("recipientProfile asks for detailPreference", /detailPreference \("brief"/.test(debriefPrompt));
check("GHL note demands the richer section set",
  /OUTCOME[\s\S]*CLIENT[\s\S]*GOALS[\s\S]*PAIN POINTS[\s\S]*OBJECTIONS[\s\S]*SELLING POINTS[\s\S]*WATCH OUT FOR[\s\S]*FOLLOW-UP TASKS[\s\S]*RETENTION RISK[\s\S]*UPSELL[\s\S]*PERSONAL RAPPORT/.test(debriefPrompt));

// ---------------------------------------------------------------------------------------
// TASK-090 — the shape-change regressions. TASK-089 turned `profile` and `hurtSale` from flat
// arrays into objects, and two consumers still did Array.isArray()/[0] on them. Neither was
// caught by the suite above because its fixture populates EVERY field. These are the cases
// that actually break in production.
// ---------------------------------------------------------------------------------------
console.log("\n== a smooth call must still be draftable (assertDraftable shape bug) ==");
// Rich behavioural profile, but NO objections and NO personalDetails — a clean close. Under the
// old Array.isArray(profile) check this threw and killed the whole generation AFTER the debrief
// had been paid for.
const SMOOTH = {
  outcome: "closed",
  followUp: { nextStep: "Send the onboarding link", timing: "today", commitments: [], personalDetails: [] },
  objections: [],
  profile: { dominantFears: ["being sold to"], valuesHierarchy: ["speed"], disc: "High D", trustTriggers: ["directness"] },
  buyingSignals: { genuine: ["signed on the call"], false: [] },
  recipientProfile: { communicationStyle: "brief", caresAbout: [], disclosed: [], bestReceivedAs: "short", detailPreference: "brief" },
  statedFollowUps: [], suggestedTone: "casual", toneReason: "warm", ghlNote: "OUTCOME\n- closed"
};
bodies = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body); bodies.push(body);
  const isDebrief = textOf(body.messages[0].content).includes("Return ONLY valid JSON with keys");
  return { ok: true, body: sseStream(JSON.stringify(isDebrief ? SMOOTH : DRAFT)) };
};
let smoothErr = null, smoothOut = null;
try { smoothOut = await generateOutputs(env, { account, call, masterPrompt: "M", callType: CALLTYPE }); }
catch (e) { smoothErr = e; }
check("a call with a rich profile but no objections/personalDetails still drafts", !smoothErr,
  smoothErr ? `${smoothErr.message.slice(0, 140)}` : "");
check("...and still produces all three tones with an SMS",
  !!smoothOut && smoothOut.messages.length === 3 && smoothOut.messages.every(m => m.sms));

console.log("\n== hasContent reads either shape ==");
check("array with items -> true", hasContent(["x"]));
check("empty array -> false", !hasContent([]));
check("object of arrays with items -> true", hasContent({ a: [], b: ["x"] }));
check("object of empty arrays -> false", !hasContent({ a: [], b: [] }));
check("non-empty string -> true", hasContent("x"));
check("null/undefined -> false", !hasContent(null) && !hasContent(undefined));

console.log("\n== debriefLine never renders [object Object] ==");
check("legacy string passes through", debriefLine("plain text") === "plain text");
check("hurtSale object -> its issue", debriefLine({ issue: "talked over them", why: "w", sayInstead: "s" }) === "talked over them");
check("didWell object -> its move", debriefLine({ move: "opened strong", why: "w" }) === "opened strong");
check("empty -> empty string, never '[object Object]'", debriefLine(null) === "" && !debriefLine({}).includes("object"));
// The Insights aggregate lives in index.js and needs a DB, so assert at the source that it goes
// through the helper rather than indexing the raw (now object-shaped) entry.
const indexSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js"), "utf8");
check("insights aggregates hurtSale via debriefLine, not d.hurtSale[0] directly",
  /debriefLine\(d\.hurtSale\?\.\[0\]\)/.test(indexSrc) && !/hurt\.push\(d\.hurtSale\[0\]\)/.test(indexSrc));

console.log("\n== the worked example is debrief-only (TASK-096) ==");
// The specimen is a coaching report ABOUT THE SELLER: absolutes he used, what he should have
// said, "stop selling". Reaching a draft would ship criticism of Gabriel to Gabriel's client —
// exactly the failure the draft guard exists to prevent.
{
  const { SPECIMEN } = await import("../src/specimen.js");
  // One line in the source: a probe that spans a newline silently never matches.
  const probe = "Root emotional objection: Prior vendor betrayal.";
  const carrying = firstRun.filter(b => textOf(b.messages[0].content).includes(probe));
  check("the specimen reaches exactly one call — the debrief", carrying.length === 1,
    `${carrying.length} of ${firstRun.length} calls carried it`);
  check("no draft prompt carries it", !allDrafts.includes(probe),
    "a draft prompt contains coaching material about Gabriel");
  const blocks = firstRun[0].messages[0].content;
  check("the debrief sends content blocks, not one string", Array.isArray(blocks));
  check("the example is the FIRST block", Array.isArray(blocks) &&
    /^Here is one complete example/.test(blocks[0].text || ""),
    "a cached prefix has to actually be the prefix");
  check("the example block is marked for caching",
    Array.isArray(blocks) && !!blocks[0].cache_control);
  check("the transcript is NOT inside the cached block",
    Array.isArray(blocks) && !blocks[0].text.includes(call.transcript.slice(0, 40)),
    "a per-call transcript in the cached prefix defeats the cache entirely");
  check("the example tells the model not to copy its content",
    /Do NOT copy its content/.test(SPECIMEN),
    "without this the model can lift Brandon's details into an unrelated call");
  check("the specimen is not empty", SPECIMEN.length > 2000, String(SPECIMEN.length));
}

console.log("\n== per-model thinking, the part that 400s if wrong (TASK-098) ==");
{
  const { MODELS, DEFAULT_MODEL, thinkingFor, costOf, modelSpec } = await import("../src/models.js");

  // Fable 5 thinks always. ANY explicit thinking config is a 400 — including the
  // {type:"disabled"} this app sends for the debrief pass. This is the assertion that stops
  // "switch to Fable" from breaking generation on the first call.
  check("Fable 5 gets NO thinking key at all",
    thinkingFor("claude-fable-5", false, "medium") === undefined,
    JSON.stringify(thinkingFor("claude-fable-5", false, "medium")));
  check("...not even when thinking is requested",
    thinkingFor("claude-fable-5", true, "high") === undefined);

  // Opus 5 rejects disabled thinking above `high`.
  check("Opus 5 may disable thinking at medium effort",
    thinkingFor("claude-opus-5", false, "medium").type === "disabled");
  for (const e of ["xhigh", "max"]) {
    check(`Opus 5 does NOT send disabled at ${e} effort`,
      thinkingFor("claude-opus-5", false, e).type === "adaptive",
      "this combination is a 400");
  }
  check("Sonnet 5 keeps the original behaviour",
    thinkingFor("claude-sonnet-5", false, "medium").type === "disabled" &&
    thinkingFor("claude-sonnet-5", true, "medium").type === "adaptive");
  check("an unknown model falls back to the default rather than throwing",
    thinkingFor("claude-nonexistent", false, "medium") !== null);

  check("the default is Opus 5", DEFAULT_MODEL === "claude-opus-5", DEFAULT_MODEL);
  check("every model carries a price", Object.values(MODELS).every(m => m.inPerM > 0 && m.outPerM > 0));
  check("Fable is priced above Opus", MODELS["claude-fable-5"].inPerM > MODELS["claude-opus-5"].inPerM);
  check("cost is computed per model, not from a constant",
    costOf("claude-fable-5", 1e6, 0) === 10 && costOf("claude-opus-5", 1e6, 0) === 5);
  check("the specimen clears the cache minimum on the default model",
    SPECIMEN_TOKENS >= modelSpec(DEFAULT_MODEL).cacheMinTokens,
    `${SPECIMEN_TOKENS} vs ${modelSpec(DEFAULT_MODEL).cacheMinTokens}`);

  // The request body must OMIT the key, not send undefined/null.
  const body = JSON.parse(bodies[0] ? JSON.stringify(bodies[0]) : "{}");
  check("the live debrief body names a model", typeof body.model === "string", body.model);

  const { EFFORTS, DEFAULT_EFFORT, forcesThinking } = await import("../src/models.js");
  check("five reasoning levels exist", Object.keys(EFFORTS).length === 5);
  check("High is one of them", !!EFFORTS.high);
  check("the default stays medium so nothing silently changes", DEFAULT_EFFORT === "medium");
  check("Opus 5 at high does NOT force thinking", forcesThinking("claude-opus-5", "high") === false);
  check("Opus 5 at xhigh/max DOES force thinking",
    forcesThinking("claude-opus-5", "xhigh") && forcesThinking("claude-opus-5", "max"));
  check("Fable always forces thinking, at every level",
    Object.keys(EFFORTS).every(e => forcesThinking("claude-fable-5", e)));
  check("the effort the account chose reaches the debrief call",
    body.output_config && typeof body.output_config.effort === "string",
    JSON.stringify(body.output_config));
}

// ---------------------------------------------------------------- TASK-101: live preview
console.log("\n== streaming preview (TASK-101) ==");
{
  const { readableTail } = await import("../src/llm.js");
  const llmSrc = readFileSync(new URL("../src/llm.js", import.meta.url), "utf8");

  const partial = '{"diagnosis":{"headline":"He is already closed emotionally","body":"Mike agreed twice."},'
                + '"didWell":[{"what":"Named the objection","sayInstead":"You held the frame when he pushed on pri';
  const tail = readableTail(partial);

  check("the preview shows values, never JSON keys",
    !/diagnosis|headline|sayInstead|didWell/.test(tail) && tail.includes("He is already closed emotionally"),
    "showing raw JSON reads as breakage, not progress: " + tail);
  check("the half-written sentence is kept",
    tail.includes("You held the frame when he pushed on pri"),
    "the in-flight sentence is the part that makes it feel live");
  check("a preview can never break a paid generation",
    readableTail("") === "" && readableTail(null) === "" && readableTail('{"a":"\\"unterminated') !== undefined,
    "readableTail must swallow everything — it decorates a run that costs real money");
  check("the preview is bounded",
    readableTail(Array.from({length: 400}, (_, i) => `"sentence ${i}"`).join(","), 300).length <= 301,
    "this column is rewritten every 1.5s for ~3 minutes; unbounded growth is a hundred growing D1 writes");

  check("extraction does NOT run on every delta",
    /if \(onPreview\) onPreview\(raw\)/.test(llmSrc) && !/onPreview\(readableTail/.test(llmSrc),
    "re-scanning a ~90KB document on every token would burn the Worker CPU budget on decoration");
  check("the stream hands out the text, not just a length",
    /onProgress\(text\.length, text\)/.test(llmSrc),
    "this is the whole bug — the tokens were always here and were being thrown away");

  // THE BOUNDARY. The debrief is the only pass that sees the transcript; its preview is
  // Gabriel's coaching analysis and must never be wired to a draft pass.
  const previewSites = (llmSrc.match(/onPreview\(/g) || []).length;
  check("the preview is wired to exactly ONE pass",
    previewSites === 1 && /const debriefRes[\s\S]*?onPreview\(raw\)/.test(llmSrc)
      && llmSrc.indexOf("onPreview(raw)") < llmSrc.indexOf("draftContext"),
    `onPreview is invoked ${previewSites} time(s), and it must be exactly once, inside the DEBRIEF call. `
    + `A draft pass streaming a preview would put coaching critique of Gabriel on screen built from the transcript.`);
}

// ------------------------------------------------- TASK-108: BYOK, no platform fallback
console.log("\n== every account uses its own key (TASK-108) ==");
{
  const { resolveKey, keyForRow, generateOutputs } = await import("../src/llm.js");
  const llmSrc = readFileSync(new URL("../src/llm.js", import.meta.url), "utf8");

  const noKeyEnv = {
    ANTHROPIC_API_KEY: "sk-PLATFORM-KEY-MUST-NEVER-BE-USED",
    OPENAI_API_KEY: "sk-PLATFORM", FATHOM_API_KEY_OSA: "fathom-PLATFORM",
    DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
  };

  check("an account with no key resolves to null, not the platform key",
    (await resolveKey(noKeyEnv, 99, "anthropic")) === null,
    "an account with no key would silently bill Ivan, with no ceiling and no error");
  check("an empty Fathom row resolves to null, not Ivan's Fathom key",
    keyForRow({ kind: "fathom", secret_value: null }) === null,
    "this is the cross-tenant one: it would poll GABRIEL'S calls into a stranger's account");
  check("keyForRow no longer takes env at all",
    /export function keyForRow\(row\)/.test(llmSrc),
    "keeping the parameter is an invitation to reach for the platform key again");
  check("no platform key is read anywhere in llm.js",
    !/env\.ANTHROPIC_API_KEY|env\.OPENAI_API_KEY|env\.FATHOM_API_KEY_OSA/.test(llmSrc),
    "the whole point of TASK-108 is that these are unreachable from key resolution");

  // The one that matters most: a keyless account must NOT receive invented analysis.
  let threw = null, out = null;
  try {
    out = await generateOutputs(noKeyEnv, {
      account: { id: 99, llm_model: "claude-opus-5" },
      call: { id: 1, client_name: "Test", transcript: "hello" },
      masterPrompt: "x", callType: null,
    });
  } catch (e) { threw = e; }
  check("a keyless account CANNOT generate — it throws instead of returning mock output",
    threw !== null && out === null,
    "it returned output instead of failing: a real closer would have been handed a fabricated debrief and three fabricated client drafts");
  check("the refusal tells them exactly what to do",
    threw && /Settings > Integrations/.test(threw.message) && /your own key/.test(threw.message),
    "an error nobody can act on is only marginally better than mock data");
  check("mock mode is opt-in and production never opts in",
    /env\.ALLOW_MOCK_GENERATION === "1"/.test(llmSrc)
      && !/ALLOW_MOCK_GENERATION/.test(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8")),
    "if the flag were set in wrangler.toml it would apply in production, which is the entire bug");
}

console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);