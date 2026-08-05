// Spend: dollars, by day/week/month/year, broken down by model (TASK-110).
//
// TWO SOURCES, AND THE DIFFERENCE BETWEEN THEM IS THE POINT
//
// `usage_daily`  — Anthropic's billing export, imported. Authoritative. Has the model.
// `events`       — what Closer logged as it ran. Live. Until now, had NO usable model.
//
// Reconciling them on 2026-08-06 produced the number that decided this design:
//
//     2026-07-17 .. 07-29   our log captured 24–55% of what Anthropic billed
//     2026-07-30 .. 08-04   exact, to the token, every single day
//
// So the log is now trustworthy and was not before. The page therefore reports IMPORTED
// figures as spend and LOGGED figures as an estimate for the tail end that no export covers
// yet, and it shows the reconciliation instead of quietly picking one. A single blended
// number would have been more comfortable and would have been a lie about July.

import { priceUsage, modelLabel, RATES_CHECKED, CACHE_MULT } from "./pricing.js";

// ── CSV ────────────────────────────────────────────────────────────────────────────────

// Anthropic's export header, verbatim. Checked on import: a silently-renamed column would
// otherwise import as zeros and read as "we spent nothing that month".
const REQUIRED = [
  "usage_date_utc", "model_version",
  "usage_input_tokens_no_cache", "usage_input_tokens_cache_write_5m",
  "usage_input_tokens_cache_write_1h", "usage_input_tokens_cache_read",
  "usage_output_tokens",
];

// Minimal RFC4180 parser. Anthropic's export is plain, but `workspace` is a free-text field a
// user can put a comma in, and a naive split() would shift every column after it — turning
// token counts into garbage that still parses as a number.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const s = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r[0] || "").trim() !== "");
}

export function parseUsageCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("That file is empty.");
  const header = rows[0].map(h => h.trim());
  const missing = REQUIRED.filter(c => !header.includes(c));
  if (missing.length) {
    throw new Error(
      `This does not look like an Anthropic usage export — missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
      `Download it from platform.claude.com › Usage › Export.`
    );
  }
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const num = (r, c) => { const v = +String(r[idx[c]] ?? "").trim(); return Number.isFinite(v) ? v : 0; };
  const str = (r, c) => (idx[c] === undefined ? "" : String(r[idx[c]] ?? "").trim());

  const out = [];
  for (const r of rows.slice(1)) {
    const date = str(r, "usage_date_utc");
    const model = str(r, "model_version");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !model) continue;   // trailing blank lines
    out.push({
      usage_date: date, model,
      api_key: str(r, "api_key"), workspace: str(r, "workspace"),
      usage_type: str(r, "usage_type"), context_window: str(r, "context_window"),
      input_no_cache: num(r, "usage_input_tokens_no_cache"),
      cache_write_5m: num(r, "usage_input_tokens_cache_write_5m"),
      cache_write_1h: num(r, "usage_input_tokens_cache_write_1h"),
      cache_read:     num(r, "usage_input_tokens_cache_read"),
      output_tokens:  num(r, "usage_output_tokens"),
      web_search_count: num(r, "web_search_count"),
    });
  }
  if (!out.length) throw new Error("No usable rows in that export.");
  return out;
}

// Upsert, never append. Anthropic's exports overlap month to month, and today's row grows all
// day — so the same (date, model) is legitimately imported many times with different numbers.
// Appending would double-count the overlap, which is the single easiest way to make a spend
// page confidently wrong.
export async function importUsage(env, text) {
  const rows = parseUsageCsv(text);
  const stmts = rows.map(r => env.DB.prepare(
    `INSERT INTO usage_daily
       (usage_date, model, api_key, workspace, usage_type, context_window,
        input_no_cache, cache_write_5m, cache_write_1h, cache_read, output_tokens,
        web_search_count, imported_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(usage_date, model, api_key, workspace, usage_type, context_window)
     DO UPDATE SET
       input_no_cache = excluded.input_no_cache,
       cache_write_5m = excluded.cache_write_5m,
       cache_write_1h = excluded.cache_write_1h,
       cache_read     = excluded.cache_read,
       output_tokens  = excluded.output_tokens,
       web_search_count = excluded.web_search_count,
       imported_at    = excluded.imported_at`
  ).bind(
    r.usage_date, r.model, r.api_key, r.workspace, r.usage_type, r.context_window,
    r.input_no_cache, r.cache_write_5m, r.cache_write_1h, r.cache_read, r.output_tokens,
    r.web_search_count
  ));
  // Batched so a half-applied import cannot leave the ledger in a state nobody can explain.
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));

  const dates = rows.map(r => r.usage_date).sort();
  return {
    rows: rows.length,
    from: dates[0], to: dates[dates.length - 1],
    models: [...new Set(rows.map(r => r.model))].sort(),
  };
}

// ── Buckets ────────────────────────────────────────────────────────────────────────────

// Bucket keys are computed in JS rather than SQL because pricing is per (date, model) — a
// SQL GROUP BY would have to sum tokens BEFORE the rate is known, which silently prices
// Sonnet's July at its September rate. Group after pricing, never before.
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function bucketOf(date, view) {
  const [y, m, d] = date.split("-").map(Number);
  if (view === "year")  return { key: String(y), label: String(y) };
  if (view === "month") return { key: date.slice(0, 7), label: `${MONTHS[m - 1]} ${y}` };
  if (view === "week") {
    // ISO-ish: weeks start Monday. UTC throughout — the export is UTC and a local-time
    // bucket would move rows across boundaries depending on who is looking.
    const t = Date.UTC(y, m - 1, d);
    const dow = (new Date(t).getUTCDay() + 6) % 7;         // Mon=0
    const start = new Date(t - dow * 86400000);
    const key = start.toISOString().slice(0, 10);
    return { key, label: `${MONTHS[start.getUTCMonth()]} ${start.getUTCDate()}` };
  }
  return { key: date, label: `${MONTHS[m - 1]} ${d}` };      // day
}

const EMPTY = () => ({
  usd: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0,
  tokensIn: 0, tokensOut: 0, unpriced: 0,
});

function addInto(acc, p) {
  acc.usd        += p.usd;
  acc.input      += p.parts.input;
  acc.cacheWrite += p.parts.cacheWrite;
  acc.cacheRead  += p.parts.cacheRead;
  acc.output     += p.parts.output;
  acc.tokensIn   += p.tokens.noCache + p.tokens.cw5m + p.tokens.cw1h + p.tokens.cr;
  acc.tokensOut  += p.tokens.out;
  if (!p.priced) acc.unpriced += p.tokens.noCache + p.tokens.cw5m + p.tokens.cw1h + p.tokens.cr + p.tokens.out;
}

// The report. `view` sets the bucket size; `limit` how many buckets back to show.
export async function spendReport(env, { view = "day", limit = 30 } = {}) {
  if (!["day", "week", "month", "year"].includes(view)) view = "day";
  limit = Math.min(60, Math.max(1, +limit || 30));

  const { results: rows } = await env.DB.prepare(
    `SELECT usage_date, model,
            SUM(input_no_cache) input_no_cache, SUM(cache_write_5m) cache_write_5m,
            SUM(cache_write_1h) cache_write_1h, SUM(cache_read) cache_read,
            SUM(output_tokens) output_tokens
       FROM usage_daily GROUP BY usage_date, model ORDER BY usage_date`
  ).all();

  const buckets = new Map();     // key -> {key,label,total,byModel}
  const byModel = new Map();     // model -> accumulator (grand total)
  const unpricedModels = new Map();

  for (const r of rows) {
    const p = priceUsage(r.model, r.usage_date, {
      noCache: r.input_no_cache, cacheWrite5m: r.cache_write_5m,
      cacheWrite1h: r.cache_write_1h, cacheRead: r.cache_read, output: r.output_tokens,
    });
    const b = bucketOf(r.usage_date, view);
    if (!buckets.has(b.key)) buckets.set(b.key, { key: b.key, label: b.label, total: EMPTY(), byModel: {} });
    const bucket = buckets.get(b.key);
    addInto(bucket.total, p);
    bucket.byModel[r.model] = bucket.byModel[r.model] || EMPTY();
    addInto(bucket.byModel[r.model], p);

    if (!byModel.has(r.model)) byModel.set(r.model, EMPTY());
    addInto(byModel.get(r.model), p);
    if (!p.priced) unpricedModels.set(r.model, (unpricedModels.get(r.model) || 0) + 1);
  }

  const ordered = [...buckets.values()].sort((a, b) => a.key < b.key ? -1 : 1).slice(-limit);
  const total = EMPTY();
  for (const b of ordered) {
    total.usd += b.total.usd; total.input += b.total.input; total.cacheWrite += b.total.cacheWrite;
    total.cacheRead += b.total.cacheRead; total.output += b.total.output;
    total.tokensIn += b.total.tokensIn; total.tokensOut += b.total.tokensOut;
    total.unpriced += b.total.unpriced;
  }

  const models = [...byModel.entries()]
    .map(([id, acc]) => ({ id, label: modelLabel(id), ...acc, priced: !unpricedModels.has(id) }))
    .sort((a, b) => b.usd - a.usd);

  const span = rows.length
    ? { from: rows[0].usage_date, to: rows[rows.length - 1].usage_date }
    : { from: null, to: null };

  return {
    view, buckets: ordered, total, models, imported: span,
    windowTotal: total,
    rates: { checked: RATES_CHECKED, cache: CACHE_MULT },
  };
}

// ── Live tail + reconciliation ─────────────────────────────────────────────────────────

// What Closer logged, per day. Two pieces, and the second is the one that gets forgotten:
//
//   succeeded — the whole run's usage, summed across its four sub-calls.
//   orphaned  — a debrief that billed on a run which then DIED. There is no succeeded row for
//               it, so every "cost" query in this app has always missed it. On 2026-07-17
//               that was 84k input tokens of real money, invisible.
//
// Deliberately NOT summed: the per-step `generation.*_done` events of runs that DID succeed.
// Their tokens are already inside the succeeded row, and adding them would double-count.
export async function loggedDaily(env, sinceDays = 45) {
  const { results } = await env.DB.prepare(
    `SELECT date(at) d,
            COALESCE(model, '') model,
            SUM(CASE WHEN kind = 'generation.succeeded' THEN COALESCE(input_tokens,0)  ELSE 0 END) succ_in,
            SUM(CASE WHEN kind = 'generation.succeeded' THEN COALESCE(output_tokens,0) ELSE 0 END) succ_out,
            SUM(CASE WHEN kind = 'generation.succeeded' THEN COALESCE(cache_read_tokens,0)  ELSE 0 END) succ_cr,
            SUM(CASE WHEN kind = 'generation.succeeded' THEN COALESCE(cache_write_tokens,0) ELSE 0 END) succ_cw,
            SUM(CASE WHEN kind = 'generation.debrief_done'
                       AND call_id NOT IN (SELECT call_id FROM events
                                            WHERE kind = 'generation.succeeded' AND call_id IS NOT NULL)
                     THEN COALESCE(input_tokens,0)  ELSE 0 END) orph_in,
            SUM(CASE WHEN kind = 'generation.debrief_done'
                       AND call_id NOT IN (SELECT call_id FROM events
                                            WHERE kind = 'generation.succeeded' AND call_id IS NOT NULL)
                     THEN COALESCE(output_tokens,0) ELSE 0 END) orph_out,
            SUM(CASE WHEN kind IN ('chat.turn','edits.analysed') THEN COALESCE(input_tokens,0)  ELSE 0 END) aux_in,
            SUM(CASE WHEN kind IN ('chat.turn','edits.analysed') THEN COALESCE(output_tokens,0) ELSE 0 END) aux_out
       FROM events
      WHERE input_tokens IS NOT NULL AND at >= date('now', ?)
      GROUP BY d, model ORDER BY d`
  ).bind(`-${Math.max(1, +sinceDays || 45)} days`).all();

  return results.map(r => ({
    date: r.d,
    model: r.model || null,
    noCache: (r.succ_in || 0) + (r.orph_in || 0) + (r.aux_in || 0),
    output:  (r.succ_out || 0) + (r.orph_out || 0) + (r.aux_out || 0),
    cacheRead:  r.succ_cr || 0,
    cacheWrite: r.succ_cw || 0,
    orphanedIn: r.orph_in || 0,
  }));
}

// Day-by-day logged-vs-billed. This is the honesty check that made the whole design: it is
// what proves the live estimate can be trusted for the days no export covers yet, and it is
// the thing to look at first if the two ever drift apart again.
export async function reconcile(env, { fallbackModel = null } = {}) {
  const logged = await loggedDaily(env, 400);
  const { results: billedRows } = await env.DB.prepare(
    `SELECT usage_date, model,
            SUM(input_no_cache) nc, SUM(cache_write_5m) cw5, SUM(cache_write_1h) cw1,
            SUM(cache_read) cr, SUM(output_tokens) out
       FROM usage_daily GROUP BY usage_date, model`
  ).all();

  const billed = new Map();
  for (const r of billedRows) {
    const cur = billed.get(r.usage_date) || { in: 0, out: 0, usd: 0 };
    const p = priceUsage(r.model, r.usage_date, {
      noCache: r.nc, cacheWrite5m: r.cw5, cacheWrite1h: r.cw1, cacheRead: r.cr, output: r.out,
    });
    cur.in += r.nc + r.cw5 + r.cw1 + r.cr;
    cur.out += r.out;
    cur.usd += p.usd;
    billed.set(r.usage_date, cur);
  }

  const byDate = new Map();
  for (const l of logged) {
    const cur = byDate.get(l.date) || { date: l.date, loggedIn: 0, loggedOut: 0, loggedUsd: 0, orphanedIn: 0 };
    // Priced at the model the row records; where history has none (everything before
    // 2026-08-06, because `meta.model` held the provider name) fall back to the account's
    // current model and SAY SO — the caller labels this an estimate.
    const p = priceUsage(l.model || fallbackModel, l.date, {
      noCache: l.noCache, cacheWrite5m: l.cacheWrite, cacheRead: l.cacheRead, output: l.output,
    });
    cur.loggedIn += l.noCache + l.cacheRead + l.cacheWrite;
    cur.loggedOut += l.output;
    cur.loggedUsd += p.usd;
    cur.orphanedIn += l.orphanedIn;
    byDate.set(l.date, cur);
  }
  for (const [d, b] of billed) {
    const cur = byDate.get(d) || { date: d, loggedIn: 0, loggedOut: 0, loggedUsd: 0, orphanedIn: 0 };
    byDate.set(d, cur);
  }

  const days = [...byDate.values()].map(r => {
    const b = billed.get(r.date);
    return {
      ...r,
      billedIn: b?.in ?? null, billedOut: b?.out ?? null, billedUsd: b?.usd ?? null,
      // null (not 0) when there is no export for that day — "we don't know" and "we captured
      // nothing" are different answers and must not render the same.
      coverage: b && b.in ? r.loggedIn / b.in : null,
    };
  }).sort((a, b) => a.date < b.date ? -1 : 1);

  const covered = days.filter(d => d.coverage !== null);
  const exact = covered.filter(d => d.coverage >= 0.999).length;
  return {
    days,
    summary: {
      daysCompared: covered.length,
      exactDays: exact,
      // The date from which the log has been reliable — the start of the current unbroken run
      // of exact days. This is what licenses trusting the live tail at all.
      trustedFrom: (() => {
        let from = null;
        for (let i = covered.length - 1; i >= 0; i--) {
          if (covered[i].coverage >= 0.985) from = covered[i].date; else break;
        }
        return from;
      })(),
    },
  };
}
