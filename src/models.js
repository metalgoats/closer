// The model registry (TASK-098).
//
// Ivan wanted to switch models without asking me, and to trial Fable 5 against its price.
// That is only safe if the code knows how each model differs — the differences are not
// cosmetic, and two of them return a 400 rather than degrading:
//
//   * FABLE 5 THINKS ALWAYS. Any explicit `thinking` config is rejected — including
//     `{type:"disabled"}`, which is exactly what this app sends for the debrief pass. Naively
//     pointing the existing code at Fable would have 400'd on the first generation.
//   * OPUS 5 accepts `{type:"disabled"}` only at effort `high` or below; `xhigh`/`max` 400.
//   * `budget_tokens` and temperature/top_p/top_k are removed on all three — we send none.
//
// Prices are USD per million tokens, kept here so the picker can show the cost of a choice at
// the moment it is made rather than in a doc nobody opens.
export const MODELS = {
  "claude-opus-5": {
    label: "Opus 5", tier: "Flagship",
    inPerM: 5, outPerM: 25,
    thinking: "optional-capped",   // disabled allowed at effort <= high
    cacheMinTokens: 512,
    note: "Best reasoning. Half the price of Fable.",
  },
  "claude-fable-5": {
    label: "Fable 5", tier: "Most capable",
    inPerM: 10, outPerM: 50,
    thinking: "always-on",         // ANY thinking config is a 400
    cacheMinTokens: 512,
    note: "Most capable, 2× the price. Thinking is always on and cannot be turned off.",
  },
  "claude-sonnet-5": {
    label: "Sonnet 5", tier: "Fast",
    inPerM: 3, outPerM: 15,
    thinking: "optional",
    cacheMinTokens: 1024,
    note: "Cheapest and quickest. What Closer shipped on.",
  },
};

export const DEFAULT_MODEL = "claude-opus-5";

// Reasoning depth for the DEBRIEF pass — the analytical one. The follow-up drafts stay at
// "low" whatever this is set to: they are short pieces of writing, not reasoning problems,
// and paying max-effort prices to write a two-line SMS is waste with no quality upside.
export const EFFORTS = {
  low:    { label: "Low",     note: "Quickest and cheapest. Thin analysis." },
  medium: { label: "Medium",  note: "The balance Closer shipped on." },
  high:   { label: "High",    note: "Deeper read. Recommended for sales calls." },
  xhigh:  { label: "X-High",  note: "Hardest calls. Forces thinking on — costs more." },
  max:    { label: "Max",     note: "Ceiling. Diminishing returns and can overthink." },
};
export const DEFAULT_EFFORT = "medium";

// Above `high`, Opus 5 refuses a disabled-thinking request, so the guard turns thinking on.
// That is a real cost change, not a footnote — the UI says so rather than surprising Ivan
// with a bigger bill.
export function forcesThinking(modelId, effort) {
  const spec = modelSpec(modelId);
  if (spec.thinking === "always-on") return true;
  return spec.thinking === "optional-capped" && (effort === "xhigh" || effort === "max");
}

export function modelSpec(id) {
  return MODELS[id] || MODELS[DEFAULT_MODEL];
}

// The whole reason this file exists. Returns the `thinking` value to send, or undefined
// meaning OMIT THE KEY ENTIRELY — which is not the same as sending null, and is the only
// accepted form on Fable 5.
export function thinkingFor(modelId, think, effort) {
  const spec = modelSpec(modelId);
  if (spec.thinking === "always-on") return undefined;
  if (think) return { type: "adaptive" };
  // Opus 5 rejects disabled thinking above `high`. Prefer adaptive over a 400: a slightly
  // more expensive call beats a failed generation Gabriel has to retry.
  if (spec.thinking === "optional-capped" && (effort === "xhigh" || effort === "max")) {
    return { type: "adaptive" };
  }
  return { type: "disabled" };
}

// Dollars for a run, so Activity can price a generation against the model that produced it
// instead of a constant that silently goes stale when the model changes.
export function costOf(modelId, inTokens, outTokens) {
  const s = modelSpec(modelId);
  return (inTokens / 1e6) * s.inPerM + (outTokens / 1e6) * s.outPerM;
}
