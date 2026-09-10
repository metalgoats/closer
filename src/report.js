// The weekly report (TASK-120).
//
// Nathan's fourth condition, in his words via Gabriel on the 2026-09-09 call:
//   "maybe even like a weekly report that gets sent out via email. That shows, hey, these
//    employees had the highest score and then this was the closing rate for those calls."
//
// So: a ranked table, per rep, once a week. Deliberately dumb — no commentary, no coaching, no
// "areas for improvement". A paragraph of generated analysis in a weekly email is the part that
// gets unsubscribed from.
//
// > [!danger] There is no close rate in this system yet, and calling one "close rate" would lie.
// > `calls.outcome` is written by the MODEL from the transcript, and the schema it is generated
// > against offers exactly two values: `"closed"` or `"followup"`. There is no `"lost"`. So the
// > field is structurally incapable of recording a loss, and any ratio built on it is optimistic
// > by construction — not by a little, by design.
// >
// > A sales manager will check a number labelled "close rate" against his CRM within a day. When
// > it does not match, he stops trusting every other number on the page, and he is right to.
// > So this reports **"closed on the call"** — a count, labelled as the model's read of the
// > transcript — and says plainly that the real figure lives in the CRM. It becomes a true close
// > rate when GoHighLevel is connected (TASK-019) and not before.
//
// > [!note] This ranks people, and the People page deliberately does not.
// > That is not an inconsistency to tidy up. Nathan asked for a ranking, in those words, and it
// > is his floor. The dashboard does not rank because ranking is a verdict and the dashboard is
// > a reference. An email he asked for, sent to him, is a different object. Worth knowing that
// > this is the artifact that makes the employee-consent question real: see the punch list, H8.

import { round1 } from "./people.js";

// Weeks start Monday, UTC, matching bucketOf in spend.js. A report whose week boundary disagrees
// with the Spend page's is a support conversation nobody needs.
export function weekBounds(now = new Date()) {
  const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dow = (new Date(t).getUTCDay() + 6) % 7;            // Mon = 0
  const thisMon = t - dow * 86400000;
  const start = new Date(thisMon - 7 * 86400000);            // the week just ended
  const end = new Date(thisMon);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

export async function weeklyReport(env, { now = new Date() } = {}) {
  const { from, to } = weekBounds(now);

  const { results: rows } = await env.DB.prepare(
    `SELECT COALESCE(c.rep_email, '(unattributed)') AS rep,
            COUNT(*) AS calls,
            SUM(CASE WHEN json_extract(c.debrief_json,'$.scorecard') IS NOT NULL THEN 1 ELSE 0 END) AS scored,
            SUM(CASE WHEN c.outcome = 'closed' THEN 1 ELSE 0 END) AS closed,
            SUM(CASE WHEN c.outcome IS NOT NULL AND c.outcome != '' THEN 1 ELSE 0 END) AS with_outcome,
            SUM(COALESCE(c.duration_min,0)) AS minutes
       FROM calls c
      WHERE c.archived_at IS NULL AND date(c.occurred_at) >= ? AND date(c.occurred_at) < ?
      GROUP BY rep`
  ).bind(from, to).all();

  const { results: scores } = await env.DB.prepare(
    `SELECT COALESCE(c.rep_email, '(unattributed)') AS rep,
            AVG(json_extract(j.value,'$[1]')) AS avg_score
       FROM calls c, json_each(json_extract(c.debrief_json,'$.scorecard')) j
      WHERE c.archived_at IS NULL AND date(c.occurred_at) >= ? AND date(c.occurred_at) < ?
      GROUP BY rep`
  ).bind(from, to).all();

  const scoreBy = new Map(scores.map(r => [r.rep, round1(r.avg_score)]));
  const people = rows.map(r => ({
    rep: r.rep,
    calls: r.calls,
    scored: r.scored || 0,
    avgScore: scoreBy.get(r.rep) ?? null,
    closedOnCall: r.closed || 0,
    withOutcome: r.with_outcome || 0,
    minutes: r.minutes || 0,
  }));

  // Ranked by score, as asked. Unscored people sort last rather than as zero — a rep whose calls
  // were all internal has no score, and printing them at the bottom of a league table as "0.0"
  // is a false accusation.
  people.sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1) || b.calls - a.calls);

  const totals = {
    people: people.length,
    calls: people.reduce((s, p) => s + p.calls, 0),
    scored: people.reduce((s, p) => s + p.scored, 0),
    closedOnCall: people.reduce((s, p) => s + p.closedOnCall, 0),
    minutes: people.reduce((s, p) => s + p.minutes, 0),
  };

  return { from, to, people, totals, empty: totals.calls === 0 };
}

const esc = v => String(v ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function renderWeeklyEmail(r, { appUrl = "" } = {}) {
  const rows = r.people.map((p, i) => `<tr>
      <td style="padding:9px 10px;border-bottom:1px solid #E8E2D5;">${i + 1}. ${esc(p.rep)}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #E8E2D5;text-align:right;font-variant-numeric:tabular-nums;">${p.avgScore === null ? "&mdash;" : p.avgScore.toFixed(1)}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #E8E2D5;text-align:right;font-variant-numeric:tabular-nums;">${p.scored}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #E8E2D5;text-align:right;font-variant-numeric:tabular-nums;">${p.calls}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #E8E2D5;text-align:right;font-variant-numeric:tabular-nums;">${p.closedOnCall}</td>
    </tr>`).join("");

  return `<div style="margin:0;padding:0;background:#FAF7F0">
<div style="max-width:640px;margin:0 auto;padding:32px 20px 48px;background:#FAF7F0;font-family:Georgia,'Times New Roman',serif;color:#1B1916">
  <div style="border-bottom:2px solid #1B1916;padding-bottom:14px;">
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#716B5C;font-weight:600">Weekly call report</div>
    <div style="font-size:26px;font-weight:600;margin-top:8px;">${esc(r.from)} to ${esc(r.to)}</div>
  </div>

  ${r.empty ? `<p style="font-size:16px;line-height:1.6;margin-top:22px;">No calls were recorded this week.</p>` : `
  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:15px;margin-top:22px;">
    <thead><tr>
      <th style="text-align:left;padding:0 10px 8px;font-family:system-ui,-apple-system,sans-serif;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#716B5C;">Person</th>
      <th style="text-align:right;padding:0 10px 8px;font-family:system-ui,-apple-system,sans-serif;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#716B5C;">Avg</th>
      <th style="text-align:right;padding:0 10px 8px;font-family:system-ui,-apple-system,sans-serif;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#716B5C;">Scored</th>
      <th style="text-align:right;padding:0 10px 8px;font-family:system-ui,-apple-system,sans-serif;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#716B5C;">Calls</th>
      <th style="text-align:right;padding:0 10px 8px;font-family:system-ui,-apple-system,sans-serif;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#716B5C;">Closed on call</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <p style="font-size:14px;line-height:1.6;color:#4A463E;margin-top:18px;">
    ${r.totals.calls} call${r.totals.calls === 1 ? "" : "s"} across ${r.totals.people} ${r.totals.people === 1 ? "person" : "people"},
    ${Math.round(r.totals.minutes / 60)} hours, ${r.totals.scored} scored.
  </p>`}

  <!-- The caveat is not fine print. A manager who checks "closed on call" against his CRM and
       finds it wrong stops believing the scores too, and he should. -->
  <div style="background:#F1ECE1;border-left:3px solid #0000EE;padding:14px 16px;margin-top:24px;font-size:13px;line-height:1.6;color:#3A362F;">
    <strong>What these numbers are.</strong> "Avg" is the mean of every scorecard dimension across
    that person's scored calls this week &mdash; a blend, not a grade. "Closed on call" is what the
    debrief read in the transcript, <strong>not your CRM</strong>: it counts calls where agreement
    was reached on the call, it cannot see anything that closed afterwards, and it has no way to
    record a loss. Treat it as a read of the conversations, not as a close rate. The real figure
    comes from the CRM once it is connected.
  </div>

  ${appUrl ? `<p style="font-size:14px;margin-top:20px;"><a href="${esc(appUrl)}" style="color:#0000EE;">Open the dashboard</a> to see any person's calls and how their dimensions have moved.</p>` : ""}
</div></div>`;
}
