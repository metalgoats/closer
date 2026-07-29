// Generation-pipeline guarantees, verified against the REAL generateOutputs (TASK-085/086/087).
//
// This is the deterministic half of "render it and look": it cannot judge wording (that needs a
// live model), but it proves the two things that are RELEASE BLOCKERS and are pure plumbing:
//
//   1. THE GUARD. Coaching critique of Gabriel — scorecard, didWell, hurtSale, lessons, and the
//      GHL note — must NEVER reach a client-facing draft. draftContext() is the only thing
//      standing between the debrief and the email. If it ever leaks, that ships in a message to
//      a real client. So every critique field carries a SENTINEL string here, and we assert none
//      of them appear in what the message pass is asked to write from.
//   2. THE SMS IS NEVER SUPPRESSED. Even when Gabriel only mentioned an email on the call, all
//      three tones still generate, and the prompt still tells the model to write a warm SMS.
//
// It also proves the new fields (statedFollowUps, recipientProfile) actually cross into the
// draft pass and survive into what workflow.js persists.
//
// No API key is used: fetch is stubbed with a faithful Anthropic SSE stream, the exact wire
// shape readStream() parses.
import { generateOutputs } from "../src/llm.js";

let pass = 0, fail = 0;
const check = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "  pass" : "  FAIL"}  ${n}${d && !c ? `  <- ${d}` : ""}`); };

// --- a real Anthropic SSE stream carrying `text`, chunked, so readStream's line-boundary
//     handling is genuinely exercised (a read() can land mid-event). ---
function sseStream(text, { chunk = 24 } = {}) {
  let sse = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } })}\n\n`;
  for (let i = 0; i < text.length; i += 40) {
    sse += `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: text.slice(i, i + 40) } })}\n\n`;
  }
  sse += `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 200 } })}\n\n`;
  sse += `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
  const bytes = new TextEncoder().encode(sse);
  let pos = 0;
  return new ReadableStream({
    pull(c) { if (pos >= bytes.length) return c.close(); c.enqueue(bytes.slice(pos, pos + chunk)); pos += chunk; }
  });
}

// The debrief the model "returns" — every critique field seeded with a sentinel we then hunt
// for in the drafts. statedFollowUps deliberately names ONLY an email (the email-only case).
const DEBRIEF = {
  scorecard: [["SENTINEL_SCORECARD_rapport", 5]],
  didWell: ["SENTINEL_DIDWELL Gabriel opened with authority"],
  hurtSale: ["SENTINEL_HURTSALE Gabriel talked over the client twice"],
  lessons: ["SENTINEL_LESSON isolate the price before answering it"],
  objections: [{ said: "SENTINEL_SAID I need to talk to my wife", meant: "not sold yet",
                 felt: "SENTINEL_FELT cornered", should: "SENTINEL_SHOULD what will her first question be",
                 follow: "loop back on cost of waiting", loop: "revisit after onboarding" }],
  profile: ["SENTINEL_PROFILE runs a 12-person roofing crew"],
  buyingSignals: ["asked about start dates"],
  outcome: "followup",
  followUp: { nextStep: "Call Thursday", timing: "Thu 4pm",
              commitments: ["send the onboarding overview"], personalDetails: ["daughter graduates in May"] },
  statedFollowUps: [{ channel: "email", said: "SENTINEL_STATED I'll send you an email with the onboarding steps",
                      contains: ["SENTINEL_CONTAINS the onboarding steps", "the pricing breakdown"] }],
  recipientProfile: { communicationStyle: "SENTINEL_RECIPSTYLE brief and bottom-line",
                      caresAbout: ["SENTINEL_CARES protecting his crew's time"],
                      disclosed: ["SENTINEL_DISCLOSED his daughter is graduating"],
                      bestReceivedAs: "SENTINEL_BESTAS short, concrete bullets" },
  suggestedTone: "balanced", toneReason: "warm but businesslike",
  ghlNote: "SENTINEL_GHLNOTE CLIENT\n- roofing crew of 12"
};
const DRAFT = { sms: "Hey Marcus, great talking today.", emailSubject: "Following up", email: "Hi Marcus, as promised..." };

const CALLTYPE = { name: "Sales call", prompt_body: "SALES PROMPT", dimensions_json: JSON.stringify(["rapport"]),
                   produces_messages: 1, produces_crm_note: 1 };
const call = { id: 1, client_name: "Marcus Webb", transcript: "Gabriel: hi.\n" + "Client: I'm stuck.\n".repeat(400) };
const account = { id: 1, llm_provider: "anthropic" };
const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ secret_value: "sk-test" }) }) }) } };

// Capture every outgoing request body; answer debrief vs message by the prompt marker.
let bodies = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  bodies.push(body);
  const prompt = body.messages[0].content;
  const isDebrief = prompt.includes("Return ONLY valid JSON with keys");
  return { ok: true, body: sseStream(JSON.stringify(isDebrief ? DEBRIEF : DRAFT)) };
};

const out = await generateOutputs(env, { account, call, masterPrompt: "M", callType: CALLTYPE });

// The three draft prompts (indices 1..3); index 0 is the debrief.
const draftPrompts = bodies.slice(1).map(b => b.messages[0].content);
const allDrafts = draftPrompts.join("\n");

console.log("\n== the pipeline ran the expected calls ==");
check("1 debrief + 3 tone drafts", bodies.length === 4, `got ${bodies.length}`);
check("the debrief is the only call carrying the transcript",
  bodies.filter(b => b.messages[0].content.includes("Client: I'm stuck")).length === 1);

console.log("\n== THE GUARD: no coaching critique of Gabriel reaches a client-facing draft ==");
for (const [label, sentinel] of [
  ["scorecard", "SENTINEL_SCORECARD"], ["didWell", "SENTINEL_DIDWELL"], ["hurtSale", "SENTINEL_HURTSALE"],
  ["lessons", "SENTINEL_LESSON"], ["ghlNote", "SENTINEL_GHLNOTE"],
  ["objection.felt", "SENTINEL_FELT"], ["objection.should (coaching 'say instead')", "SENTINEL_SHOULD"]
]) {
  check(`${label} never appears in any draft prompt`, !allDrafts.includes(sentinel),
    `LEAKED into a client-facing draft — this is a release blocker`);
}

console.log("\n== carry-forward: the drafts DO get what they legitimately need ==");
check("statedFollowUps ('said') crosses into the drafts", allDrafts.includes("SENTINEL_STATED"));
check("statedFollowUps contents cross in", allDrafts.includes("SENTINEL_CONTAINS"));
check("recipientProfile.communicationStyle crosses in", allDrafts.includes("SENTINEL_RECIPSTYLE"));
check("recipientProfile.disclosed crosses in (the 'I had no idea they were a doctor' fix)", allDrafts.includes("SENTINEL_DISCLOSED"));
check("recipientProfile.bestReceivedAs crosses in", allDrafts.includes("SENTINEL_BESTAS"));
check("the client's verbatim objection ('said') crosses in", allDrafts.includes("SENTINEL_SAID"));
check("client profile crosses in", allDrafts.includes("SENTINEL_PROFILE"));

console.log("\n== the SMS is never suppressed (email-only call) ==");
// DEBRIEF.statedFollowUps names only an email; all three tones must still produce a real SMS.
check("all three tones generated", out.messages.length === 3, `got ${out.messages.length}`);
check("every tone returns a non-empty SMS", out.messages.every(m => m.sms && m.sms.trim().length));
check("the draft prompt instructs: never return an empty SMS",
  draftPrompts.every(p => /Return a non-empty SMS|Never return an empty "sms"/i.test(p)));
check("the draft prompt tells the model to deliver what Gabriel promised",
  draftPrompts.every(p => /DELIVER WHAT GABRIEL PROMISED/.test(p)));
check("the draft prompt tells the model to write for the recipient",
  draftPrompts.every(p => /WRITE FOR THE RECIPIENT/.test(p)));

console.log("\n== new fields survive into what workflow.js persists ==");
check("gen.debrief.statedFollowUps present", Array.isArray(out.debrief.statedFollowUps) && out.debrief.statedFollowUps.length === 1);
check("gen.debrief.recipientProfile present", !!out.debrief.recipientProfile && !!out.debrief.recipientProfile.disclosed);
check("gen.ghlNote still surfaced (it is fine in the CRM, only barred from the DRAFTS)", out.ghlNote === DEBRIEF.ghlNote);
check("outcome/suggestedTone still surfaced", out.outcome === "followup" && out.suggestedTone === "balanced");

console.log("\n== the debrief schema actually ASKS for the new fields ==");
const debriefPrompt = bodies[0].messages[0].content;
check("debrief schema requests statedFollowUps", /statedFollowUps/.test(debriefPrompt));
check("debrief schema requests recipientProfile", /recipientProfile/.test(debriefPrompt));
check("GHL note schema demands the scannable six-section structure",
  /CLIENT[\s\S]*GOALS[\s\S]*OUTCOME[\s\S]*WHAT WAS SAID[\s\S]*SELLING POINTS[\s\S]*WATCH OUT FOR/.test(debriefPrompt));
check("GHL note schema forbids markdown (plain text for a pasted CRM note)", /PLAIN TEXT ONLY/.test(debriefPrompt));

console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
