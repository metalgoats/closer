// Outbound email (TASK-132), through Resend. One adapter for the two things that send: the
// onboarding-intake notification and the weekly report.
//
// WHAT HAPPENS WITHOUT A KEY: nothing sends, nothing throws, and the caller gets
// { sent:false, skipped:true, reason } so it can log a warning and carry on. An intake must
// never fail for the customer because our mail is unconfigured -- the row is already stored.
//
// RESEND'S ONE RULE WORTH KNOWING: until a sending domain is verified in the Resend dashboard,
// the only address it will deliver to is the account owner's own, and only from
// onboarding@resend.dev. So the first real test is "send to yourself"; anything wider needs the
// domain (DNS records Resend shows you, ~10 minutes, then EMAIL_FROM can be @closer's domain).
export const RESEND_URL = "https://api.resend.com/emails";
export const DEFAULT_FROM = "Closer <onboarding@resend.dev>";

// "a@x.com, b@y.com" -> ["a@x.com","b@y.com"]; tolerant of spaces and blanks.
export function recipients(v) {
  return String(v || "").split(/[,\s;]+/).map(s => s.trim()).filter(s => /.+@.+\..+/.test(s));
}

export function mailConfig(env) {
  const key = env?.EMAIL_API_KEY || "";
  const from = env?.EMAIL_FROM || DEFAULT_FROM;
  return { configured: Boolean(key), key, from };
}

// ONE REQUEST PER RECIPIENT, on purpose. Resend rejects a whole request if any recipient is not
// allowed -- and until a domain is verified, only the account owner's address is allowed. Sent
// as one request, "Ivan and Gabriel" would fail for both because of Gabriel. Sent one at a time,
// Ivan gets his copy and Gabriel's refusal is reported by name. The result is aggregated: sent
// if anyone got it, with per-recipient outcomes for the event log.
export async function sendEmail(env, { to, subject, text, html, replyTo = null }, fetchImpl = fetch) {
  const cfg = mailConfig(env);
  const list = recipients(to);
  if (!cfg.configured) return { sent: false, skipped: true, reason: "EMAIL_API_KEY is not set" };
  if (!list.length)    return { sent: false, skipped: true, reason: "no recipient" };
  const post = fetchImpl;
  const results = [];
  for (const rcpt of list) {
    const body = { from: cfg.from, to: [rcpt], subject: String(subject || "").slice(0, 200), text: String(text || "") };
    if (html) body.html = html;
    if (replyTo) body.reply_to = replyTo;
    let res;
    try {
      res = await post(RESEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      results.push({ to: rcpt, sent: false, error: String(err?.message || err) });
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      results.push({ to: rcpt, sent: false, status: res.status, error: detail.slice(0, 300) });
      continue;
    }
    const j = await res.json().catch(() => ({}));
    results.push({ to: rcpt, sent: true, id: j.id || null });
  }
  const ok = results.filter(r => r.sent), bad = results.filter(r => !r.sent);
  return {
    sent: ok.length > 0,
    skipped: false,
    to: ok.map(r => r.to),
    id: ok[0]?.id || null,
    failed: bad,
    status: bad[0]?.status,
    error: bad.length ? bad.map(r => `${r.to}: ${r.status || ""} ${r.error || ""}`.trim()).join(" | ") : undefined,
    results,
  };
}

// The onboarding form, as an email a person can act on from their phone: who, how many
// closers, when they want the call, and every answer underneath. Plain text first because it
// is what every client renders identically; the HTML is the same content with headings.
export function intakeEmail(data, { appUrl = "" } = {}) {
  const d = data || {};
  const closers = String(d.closers || "").split(/\n+/).map(s => s.trim()).filter(Boolean);
  const subject = `New onboarding form: ${d.company || "unnamed business"} (${closers.length} closer${closers.length === 1 ? "" : "s"})`;
  const lines = [
    `${d.company || "Unnamed business"} has filled in the onboarding form.`,
    ``,
    `Contact: ${d.contact_name || "?"} <${d.contact_email || "?"}>${d.contact_phone ? `, ${d.contact_phone}` : ""}`,
    `Wants the setup call: ${d.start_date || "not said"}`,
    `Closers (${closers.length}):`,
    ...closers.map(c => `  - ${c}`),
    ``,
    `Recording: ${d.recorder || "?"} / recording every call now: ${d.recording_now || "?"}`,
    `CRM: ${d.crm || "?"}${d.crm_location ? `, location ${d.crm_location}` : ""}; admin: ${d.crm_admin || "not given"}`,
    `Who books: ${d.setter_model || "?"}${d.setters ? `; setters: ${d.setters}` : ""}`,
    d.tags ? `Tags / pipeline: ${d.tags}` : null,
    d.call_types ? `Call types: ${d.call_types}` : null,
    d.tone ? `Tone: ${d.tone}` : null,
    d.rubric_notes ? `` : null,
    d.rubric_notes ? `What a great call looks like to them:\n${d.rubric_notes}` : null,
    d.notes ? `` : null,
    d.notes ? `Notes:\n${d.notes}` : null,
    ``,
    `Next: add their closers as logins on Account & Access, and book the setup call.`,
    appUrl ? `${appUrl}` : null,
  ].filter(l => l !== null);
  const text = lines.join("\n");
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1B1916;max-width:640px">
<h2 style="margin:0 0 12px;font-size:20px">${esc(d.company || "Unnamed business")} filled in the onboarding form</h2>
<p style="margin:0 0 14px;color:#555">${esc(d.contact_name || "?")} &lt;${esc(d.contact_email || "?")}&gt;${d.contact_phone ? ` &middot; ${esc(d.contact_phone)}` : ""}<br>Wants the setup call: <strong>${esc(d.start_date || "not said")}</strong></p>
<pre style="white-space:pre-wrap;font:inherit;background:#F5F4F0;border-radius:10px;padding:14px;margin:0 0 14px">${esc(text)}</pre>
${appUrl ? `<p><a href="${esc(appUrl)}" style="color:#0000EE">Open Closer &rarr; Account &amp; Access</a></p>` : ""}
</div>`;
  return { subject, text, html };
}
