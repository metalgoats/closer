// Anthropic list pricing, in one place, with dates (TASK-110 — the Spend page).
//
// This file exists because the same rate constants had already gone stale twice in this app,
// each time silently understating real money:
//
//   * Activity hardcoded Sonnet 5 ($3/$15) and kept using it after the default model moved to
//     Opus 5 ($5/$25) — every figure on that page was ~65% low for weeks.
//   * Cached input was priced at ZERO until 2026-08-06, while every debrief carries a cached
//     specimen prefix. A live chat turn showed 42 fresh input tokens against a ~10k cached
//     prefix, so almost the whole cost of a turn was invisible.
//
// The lesson both times: a price written next to the thing that uses it drifts away from the
// thing that sets it. Prices live here, are keyed by DATE, and nothing else in the app is
// allowed to hold a rate constant.
//
// ── Why rates are dated ─────────────────────────────────────────────────────────────────
// Sonnet 5 is on introductory pricing ($2/$10) through 2026-08-31, reverting to $3/$15 on
// 2026-09-01. Every Sonnet row in Closer's July history bills at the INTRO rate. Pricing that
// history at $3/$15 — which is what `models.js` says, because that is the price of a run
// started today — would overstate July by 50%. A spend page that reprices the past every time
// a list price changes is not a ledger, it is a rumour.
//
// ── Cache multipliers ───────────────────────────────────────────────────────────────────
// Cached tokens are billed against the INPUT rate, scaled. These are Anthropic's published
// multipliers and they are the reason a "tokens in / tokens out" summary cannot be converted
// to dollars without the cache columns:
//
//   no-cache input   1.00x   ordinary input
//   cache write 5m   1.25x   default TTL — what `cache_control: {type:"ephemeral"}` writes
//   cache write 1h   2.00x   the `ttl: "1h"` variant. Closer does not use it; priced anyway,
//                            because Anthropic's export has a column for it and a column we
//                            cannot price is a hole in the total.
//   cache read       0.10x   the saving that makes caching worth doing
//
// Sources: the model table and prompt-caching economics in the `claude-api` skill, read
// 2026-08-06. Re-check on any model launch; that is what `RATES_CHECKED` is for.

export const RATES_CHECKED = "2026-08-06";

export const CACHE_MULT = Object.freeze({
  noCache:      1.00,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2.00,
  cacheRead:    0.10,
});

// USD per million tokens. Each model is a list of periods, newest LAST. `from` is inclusive,
// `until` inclusive; a period with no `until` runs forever. Overlapping periods are a bug —
// `rateFor` takes the first match, so order matters.
export const RATES = Object.freeze({
  "claude-opus-5":    [{ from: "2000-01-01", inPerM: 5,  outPerM: 25 }],
  "claude-fable-5":   [{ from: "2000-01-01", inPerM: 10, outPerM: 50 }],
  "claude-mythos-5":  [{ from: "2000-01-01", inPerM: 10, outPerM: 50 }],
  "claude-sonnet-5":  [
    { from: "2000-01-01", until: "2026-08-31", inPerM: 2, outPerM: 10, note: "introductory" },
    { from: "2026-09-01",                      inPerM: 3, outPerM: 15 },
  ],
  // Older models still appear in historical exports. Closer never ran them, but an import of
  // someone else's key would otherwise land in the "unpriced" bucket for no good reason.
  "claude-opus-4-8":   [{ from: "2000-01-01", inPerM: 5, outPerM: 25 }],
  "claude-opus-4-7":   [{ from: "2000-01-01", inPerM: 5, outPerM: 25 }],
  "claude-opus-4-6":   [{ from: "2000-01-01", inPerM: 5, outPerM: 25 }],
  "claude-sonnet-4-6": [{ from: "2000-01-01", inPerM: 3, outPerM: 15 }],
  "claude-haiku-4-5":  [{ from: "2000-01-01", inPerM: 1, outPerM: 5  }],
});

// Returns {inPerM, outPerM, note} or NULL for a model we have no price for.
//
// Null is deliberate and load-bearing. The tempting alternative — fall back to the default
// model's rate — makes an unknown model silently cost whatever Opus costs, which is wrong in
// both directions and impossible to notice. The Spend page surfaces unpriced tokens as their
// own line instead, so a model launch shows up as "we cannot price this" rather than as a
// number that happens to be false.
export function rateFor(model, date) {
  const periods = RATES[model];
  if (!periods) return null;
  const d = String(date || "").slice(0, 10);
  for (const p of periods) {
    if (d >= p.from && (!p.until || d <= p.until)) return p;
  }
  return null;
}

// The one function that turns Anthropic's five token columns into dollars.
//
// Shape matches the export's columns exactly (`usage_input_tokens_*`, `usage_output_tokens`)
// so there is no lossy translation step between what Anthropic bills and what we display.
// Returns { usd, priced, rate, parts } — `priced: false` means we summed the tokens but have
// no rate, and the caller must show them as unpriced rather than as $0.
export function priceUsage(model, date, u = {}) {
  const noCache = +u.noCache      || 0;
  const cw5m    = +u.cacheWrite5m || 0;
  const cw1h    = +u.cacheWrite1h || 0;
  const cr      = +u.cacheRead    || 0;
  const out     = +u.output       || 0;

  const rate = rateFor(model, date);
  if (!rate) {
    return {
      usd: 0, priced: false, rate: null,
      parts: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
      tokens: { noCache, cw5m, cw1h, cr, out },
    };
  }

  const perIn = rate.inPerM / 1e6;
  const parts = {
    input:      noCache * perIn * CACHE_MULT.noCache,
    cacheWrite: cw5m * perIn * CACHE_MULT.cacheWrite5m + cw1h * perIn * CACHE_MULT.cacheWrite1h,
    cacheRead:  cr * perIn * CACHE_MULT.cacheRead,
    output:     out * (rate.outPerM / 1e6),
  };
  return {
    usd: parts.input + parts.cacheWrite + parts.cacheRead + parts.output,
    priced: true, rate,
    parts,
    tokens: { noCache, cw5m, cw1h, cr, out },
  };
}

// Display label for a model id. Falls back to the raw id rather than "Unknown" — when an
// unrecognised model appears in an import, its actual name is the useful thing to show.
const LABELS = {
  "claude-opus-5": "Opus 5", "claude-fable-5": "Fable 5", "claude-mythos-5": "Mythos 5",
  "claude-sonnet-5": "Sonnet 5", "claude-opus-4-8": "Opus 4.8", "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-6": "Opus 4.6", "claude-sonnet-4-6": "Sonnet 4.6", "claude-haiku-4-5": "Haiku 4.5",
};
export function modelLabel(id) { return LABELS[id] || id || "unknown"; }
