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

export async function generateOutputs(env, { account, call, masterPrompt, onStep }) {
  const provider = account.llm_provider || "anthropic";
  const key = await resolveKey(env, account.id, provider);
  if (!key) return mockOutputs(call);

  // Sum real usage across all 4 calls so cost is measured, not estimated.
  const total = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const tally = u => { for (const k of Object.keys(total)) total[k] += (u?.[k] || 0); };

  const t0 = Date.now();
  const debriefRes = await complete(env, provider, key, [
    { role: "user", content: `${masterPrompt}\n\nReturn ONLY valid JSON with keys: scorecard (array of [label, score1to10] pairs for rapport, authority, trust, emotional connection, pain amplification, vision building, objection handling, certainty transfer, close attempt, follow-up positioning), didWell (string[]), hurtSale (string[]), objections (array of {said, meant, felt, should, follow, loop}), profile (string[]), buyingSignals (string[]), lessons (string[]), suggestedTone ("casual"|"balanced"|"formal"), toneReason (string), outcome ("closed"|"followup"), ghlNote (string, under 10000 chars: client name, personal details for rapport, buying profile, objections, next-call guidance).\n\nTranscript:\n${call.transcript}` }
  ], { effort: "medium", think: false });
  tally(debriefRes.usage);
  const parsed = JSON.parse(extractJson(debriefRes.text));
  const debriefMs = Date.now() - t0;
  if (onStep) await onStep({ step: "debrief", duration_ms: debriefMs, usage: debriefRes.usage });

  // SMS + email in all three tones, generated in parallel (the v1.5 speed fix).
  const msgJobs = TONES.map(async tone => {
    const res = await complete(env, provider, key, [
      { role: "user", content: `Based on this sales call transcript, write a follow-up SMS and a follow-up email from the closer (Gabriel) to the client. Tone: ${tone}. Match the call outcome (${parsed.outcome}). Return ONLY JSON: {"sms": "...", "emailSubject": "...", "email": "..."}\n\nTranscript:\n${call.transcript}` }
    ], { effort: "low", think: false });
    tally(res.usage);
    return { tone, ...JSON.parse(extractJson(res.text)) };
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

// opts.effort: "low" | "medium" | "high" | "xhigh" | "max"
// opts.think:  false disables thinking entirely.
//
// WHY THIS IS EXPLICIT: Sonnet 5 runs ADAPTIVE THINKING when `thinking` is omitted,
// and `effort` defaults to `high`. Leaving either unset made every call reason at high
// effort over a 19k-token transcript — 10+ minutes for 4 calls, and thinking competes
// with the response for the max_tokens budget. Never omit these.
async function complete(env, provider, key, messages, opts = {}) {
  const { effort = "medium", think = false } = opts;
  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.2", messages, max_completion_tokens: 16000 })
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.choices[0].finish_reason === "length") {
      throw new Error("The model's response was cut off before it finished (hit the output limit). Try a shorter transcript or raise max_tokens.");
    }
    return { text: data.choices[0].message.content, usage: {
      input_tokens: data.usage?.prompt_tokens, output_tokens: data.usage?.completion_tokens } };
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 16000,
      thinking: think ? { type: "adaptive" } : { type: "disabled" },
      output_config: { effort },
      messages
    })
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.stop_reason === "max_tokens") {
    throw new Error("The model's response was cut off before it finished (hit the output limit). Try a shorter transcript or raise max_tokens.");
  }
  if (data.stop_reason === "refusal") {
    throw new Error("The model declined to answer this request.");
  }
  const block = (data.content || []).find(b => b.type === "text");
  if (!block) throw new Error("Model returned no text content.");
  return { text: block.text, usage: data.usage || {} };
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in model response");
  return text.slice(start, end + 1);
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
