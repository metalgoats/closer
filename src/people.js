// People — the manager tier (TASK-118).
//
// WHAT THIS IS FOR. Nathan's third and fourth conditions on the 2026-09-09 call: scores across
// the team in a dashboard, and a per-person view he can click into. Until TASK-117 there was no
// data for it at all — `calls` had no owner — so this module is the first thing in the codebase
// that can answer "how is this person doing" rather than "how did this call go".
//
// > [!important] RAW NUMBERS ONLY. No targets, no benchmarks, no red and green.
// > Gabriel stopped Ivan mid-sentence on the call to say this:
// >   "What a healthy number is, is something that Nathan's going to be able to figure out.
// >    That's on him. I'm just presenting him the raw data."
// > So nothing here computes a verdict, a grade, a colour or a "needs improvement". It reports
// > averages and counts and says how many calls each one rests on. If you are about to add a
// > threshold, that is a product decision that was already taken the other way.
//
// The second discipline, and the one that actually costs something: EVERY average ships its `n`.
// Scorecard dimensions vary by call type — a type with `dimensions_json='[]'` has none at all —
// so a dimension can be averaged over three calls while its neighbour rests on forty. An average
// without its sample size is how a single 10/10 becomes a trend.

import { bucketOf } from "./spend.js";

// The windows Ivan named: "the last week, month, six months, year". `all` exists because on a
// young account every other window is mostly empty, and an empty dashboard reads as broken
// rather than as new.
export const WINDOWS = Object.freeze({
  week:  { days: 7,    label: "Week",     bucket: "day"   },
  month: { days: 30,   label: "Month",    bucket: "week"  },
  half:  { days: 182,  label: "6 months", bucket: "month" },
  year:  { days: 365,  label: "Year",     bucket: "month" },
  all:   { days: null, label: "All time", bucket: "month" },
});

// Pure, so it can be tested without a database. Returns an ISO instant, or null for `all`.
// UTC throughout, matching bucketOf — a local-time boundary moves calls between buckets
// depending on who is looking at the page.
export function windowStart(view, now = new Date()) {
  const w = WINDOWS[view] || WINDOWS.month;
  if (w.days === null) return null;
  return new Date(now.getTime() - w.days * 86400000).toISOString();
}

// A rep is identified by email, which may be null: a manually pasted call made before TASK-117
// has no owner and nothing in the record can supply one. It is reported as unattributed rather
// than folded into somebody's numbers or dropped from the totals. Both of those would be lies,
// and the second is the quieter one.
export const UNATTRIBUTED = "(unattributed)";
export const repKey = email => email || UNATTRIBUTED;

// Averages arrive from SQLite as full floats. One decimal is all a 1-10 score can carry.
export const round1 = n => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

// ---------------------------------------------------------------------------------------------
// The roster: one row per person, for the window.
// ---------------------------------------------------------------------------------------------
export async function roster(env, { view = "month", accountId = null } = {}) {
  const since = windowStart(view);
  const where = [];
  const binds = [];
  where.push("c.archived_at IS NULL");
  if (since)    { where.push("c.occurred_at >= ?"); binds.push(since); }
  if (accountId) { where.push("c.account_id = ?");  binds.push(accountId); }
  const W = `WHERE ${where.join(" AND ")}`;

  // Two passes rather than one clever query. The scorecard average needs json_each, which
  // multiplies rows by the number of dimensions — joining that to a call count in one statement
  // gives you a call count multiplied by ten and no error to tell you so.
  const { results: counts } = await env.DB.prepare(
    `SELECT c.rep_email AS email,
            COUNT(*) AS calls,
            SUM(CASE WHEN json_extract(c.debrief_json,'$.scorecard') IS NOT NULL THEN 1 ELSE 0 END) AS scored,
            MAX(date(c.occurred_at)) AS last_call,
            SUM(COALESCE(c.duration_min, 0)) AS minutes
       FROM calls c ${W}
       GROUP BY c.rep_email`
  ).bind(...binds).all();

  const { results: scores } = await env.DB.prepare(
    `SELECT c.rep_email AS email,
            AVG(json_extract(j.value,'$[1]')) AS avg_score,
            COUNT(*) AS dims
       FROM calls c, json_each(json_extract(c.debrief_json,'$.scorecard')) j
       ${W}
       GROUP BY c.rep_email`
  ).bind(...binds).all();

  // What kind of work each person's time went to. This is NOT the setter-vs-closer split Nathan
  // asked for — that needs a job role nobody has recorded yet, and inventing one with a single
  // value would be the `events.model` mistake again. Call type is a real axis that exists today
  // and answers a real question: how much of this went to selling.
  const { results: types } = await env.DB.prepare(
    `SELECT c.rep_email AS email, COALESCE(ct.name, 'Unlabelled') AS type, COUNT(*) AS n
       FROM calls c LEFT JOIN call_types ct ON ct.id = c.call_type_id
       ${W}
       GROUP BY c.rep_email, type`
  ).bind(...binds).all();

  const scoreBy = new Map(scores.map(r => [repKey(r.email), r]));
  const typeBy = new Map();
  for (const t of types) {
    const k = repKey(t.email);
    if (!typeBy.has(k)) typeBy.set(k, []);
    typeBy.get(k).push({ type: t.type, n: t.n });
  }

  const people = counts.map(r => {
    const k = repKey(r.email);
    const s = scoreBy.get(k);
    return {
      email: r.email || null,
      name: k,
      calls: r.calls,
      scored: r.scored || 0,
      minutes: r.minutes || 0,
      lastCall: r.last_call,
      avgScore: round1(s?.avg_score ?? null),
      // The sample size behind avgScore, in CALLS not dimensions — `dims` counts scorecard rows,
      // which is calls x dimensions and would read as ten times the work.
      avgScoreCalls: r.scored || 0,
      byType: (typeBy.get(k) || []).sort((a, b) => b.n - a.n),
    };
  });

  // Busiest first. Not "best first": ranking people by score on the landing view is the verdict
  // the page is explicitly not supposed to render.
  people.sort((a, b) => b.calls - a.calls);

  return {
    view,
    since,
    window: WINDOWS[view]?.label || view,
    people,
    totals: {
      people: people.length,
      calls: people.reduce((s, p) => s + p.calls, 0),
      scored: people.reduce((s, p) => s + p.scored, 0),
      minutes: people.reduce((s, p) => s + p.minutes, 0),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// One person: dimension averages, the trend under them, and their calls.
// ---------------------------------------------------------------------------------------------
export async function person(env, email, { view = "month", accountId = null } = {}) {
  const since = windowStart(view);
  const bucket = (WINDOWS[view] || WINDOWS.month).bucket;

  const where = ["c.archived_at IS NULL"];
  const binds = [];
  // `email` null means the unattributed bucket, which is a real group and needs IS NULL rather
  // than `= NULL` — the latter matches nothing and would render an empty page that looks like
  // a person with no calls.
  if (email) { where.push("c.rep_email = ?"); binds.push(email); }
  else       { where.push("c.rep_email IS NULL"); }
  if (since)     { where.push("c.occurred_at >= ?"); binds.push(since); }
  if (accountId) { where.push("c.account_id = ?");  binds.push(accountId); }
  const W = `WHERE ${where.join(" AND ")}`;

  const { results: dims } = await env.DB.prepare(
    `SELECT json_extract(j.value,'$[0]') AS dim,
            AVG(json_extract(j.value,'$[1]')) AS avg_score,
            MIN(json_extract(j.value,'$[1]')) AS low,
            MAX(json_extract(j.value,'$[1]')) AS high,
            COUNT(*) AS n
       FROM calls c, json_each(json_extract(c.debrief_json,'$.scorecard')) j
       ${W}
       GROUP BY dim`
  ).bind(...binds).all();

  // The trend. One row per (bucket, dimension) so the page can draw a dimension moving over
  // time — Ivan's "health bar" — rather than a single blended number that hides which part
  // changed. Bucketing happens here in JS via bucketOf so weeks match the Spend page exactly
  // instead of being re-derived in SQL and drifting by a day.
  const { results: raw } = await env.DB.prepare(
    `SELECT date(c.occurred_at) AS d,
            json_extract(j.value,'$[0]') AS dim,
            json_extract(j.value,'$[1]') AS score
       FROM calls c, json_each(json_extract(c.debrief_json,'$.scorecard')) j
       ${W}
       ORDER BY d`
  ).bind(...binds).all();

  const trendMap = new Map();
  for (const r of raw) {
    if (!r.d || r.score === null) continue;
    const b = bucketOf(r.d, bucket);
    if (!trendMap.has(b.key)) trendMap.set(b.key, { key: b.key, label: b.label, sum: 0, n: 0, dims: new Map() });
    const t = trendMap.get(b.key);
    t.sum += r.score; t.n += 1;
    if (!t.dims.has(r.dim)) t.dims.set(r.dim, { sum: 0, n: 0 });
    const dd = t.dims.get(r.dim); dd.sum += r.score; dd.n += 1;
  }
  const trend = [...trendMap.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map(t => ({
    key: t.key, label: t.label, n: t.n, avg: round1(t.sum / t.n),
    dims: Object.fromEntries([...t.dims].map(([k, v]) => [k, round1(v.sum / v.n)])),
  }));

  const { results: calls } = await env.DB.prepare(
    `SELECT c.id, c.client_name, date(c.occurred_at) AS occurred_at, c.duration_min,
            COALESCE(ct.name, 'Unlabelled') AS call_type,
            c.processing_status,
            (SELECT AVG(json_extract(x.value,'$[1]'))
               FROM json_each(json_extract(c.debrief_json,'$.scorecard')) x) AS avg_score
       FROM calls c LEFT JOIN call_types ct ON ct.id = c.call_type_id
       ${W}
       ORDER BY c.occurred_at DESC LIMIT 100`
  ).bind(...binds).all();

  return {
    email: email || null,
    name: repKey(email),
    view,
    since,
    window: WINDOWS[view]?.label || view,
    bucket,
    dimensions: dims
      .map(d => ({ dim: d.dim, avg: round1(d.avg_score), low: d.low, high: d.high, n: d.n }))
      .sort((a, b) => b.n - a.n || (a.dim < b.dim ? -1 : 1)),
    trend,
    calls: calls.map(c => ({ ...c, avg_score: round1(c.avg_score) })),
  };
}
