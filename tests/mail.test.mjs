// Outbound mail (TASK-132): the Resend adapter, the intake notification, and the rule that mail
// can never decide the customer's response.
import { sendEmail, recipients, mailConfig, intakeEmail, RESEND_URL, DEFAULT_FROM } from "../src/mail.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const idx = readFileSync(join(here, "..", "src", "index.js"), "utf8");
const wf  = readFileSync(join(here, "..", ".github", "workflows", "deploy.yml"), "utf8");
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
let pass = 0, fail = 0;
const check = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "  pass" : "  FAIL"}  ${n}${d && !c ? `  <- ${d}` : ""}`); };

console.log("\nMail — recipients and configuration");
check("recipients tolerate commas, spaces, semicolons and junk", JSON.stringify(recipients(" a@x.com, b@y.org;c@z.io  nonsense ")) === '["a@x.com","b@y.org","c@z.io"]');
check("no key means not configured, default from", !mailConfig({}).configured && mailConfig({}).from === DEFAULT_FROM);
check("a key means configured, and EMAIL_FROM wins when set", mailConfig({ EMAIL_API_KEY: "re_x", EMAIL_FROM: "Closer <hi@closer.test>" }).from === "Closer <hi@closer.test>");

console.log("\nMail — the adapter");
{
  let calls = [];
  const fetchOk = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: "em_1" }), text: async () => "" }; };
  const none = await sendEmail({}, { to: "a@x.com", subject: "s", text: "t" }, fetchOk);
  check("without a key it SKIPS and never calls the network", none.skipped === true && none.sent === false && calls.length === 0,
    "an intake must not fail because our mail is unconfigured");
  const noTo = await sendEmail({ EMAIL_API_KEY: "re_x" }, { to: "", subject: "s", text: "t" }, fetchOk);
  check("without a recipient it skips too", noTo.skipped === true && calls.length === 0);
  const ok = await sendEmail({ EMAIL_API_KEY: "re_x" }, { to: "a@x.com, b@y.org", subject: "New form", text: "hello", html: "<p>hello</p>", replyTo: "n@x.com" }, fetchOk);
  const body = JSON.parse(calls[0].init.body);
  check("with a key it POSTs to Resend with a bearer token", calls[0].url === RESEND_URL && calls[0].init.headers.Authorization === "Bearer re_x");
  check("...ONE request per recipient, so a refused address cannot block the others", calls.length === 2 && body.to.length === 1 && JSON.parse(calls[1].init.body).to[0] === "b@y.org",
    "Resend rejects a whole request if any recipient is disallowed; unverified domains allow only the owner");
  check("...with from, subject, text, html and reply_to", body.from === DEFAULT_FROM && body.subject === "New form" && body.text === "hello" && body.html === "<p>hello</p>" && body.reply_to === "n@x.com");
  check("...and reports sent with the provider id and everyone who got it", ok.sent === true && ok.id === "em_1" && ok.to.length === 2 && ok.failed.length === 0);
  // The exact production shape: owner allowed, co-recipient refused by testing mode.
  const fetchMixed = async (url, init) => { const rc = JSON.parse(init.body).to[0]; return rc === "owner@x.com"
    ? { ok: true, status: 200, json: async () => ({ id: "em_ok" }), text: async () => "" }
    : { ok: false, status: 403, json: async () => ({}), text: async () => '{"message":"You can only send testing emails to your own email address"}' }; };
  const mixed = await sendEmail({ EMAIL_API_KEY: "re_x" }, { to: "owner@x.com, other@y.org", subject: "s", text: "t" }, fetchMixed);
  check("a refused co-recipient does NOT take the owner's copy down with it", mixed.sent === true && mixed.to.join() === "owner@x.com" && mixed.failed.length === 1 && /other@y\.org: 403/.test(mixed.error));
  const fetch500 = async () => ({ ok: false, status: 422, text: async () => '{"message":"domain not verified"}', json: async () => ({}) });
  const bad = await sendEmail({ EMAIL_API_KEY: "re_x" }, { to: "a@x.com", subject: "s", text: "t" }, fetch500);
  check("a non-2xx comes back as sent:false with the status and Resend's reason", bad.sent === false && bad.skipped === false && bad.status === 422 && /domain not verified/.test(bad.error));
  check("...and the outcome names the address that failed", /a@x\.com: 422/.test(bad.error));
  const fetchThrow = async () => { throw new Error("ECONNRESET"); };
  const thrown = await sendEmail({ EMAIL_API_KEY: "re_x" }, { to: "a@x.com", subject: "s", text: "t" }, fetchThrow);
  check("a network failure never throws out of the adapter", thrown.sent === false && /ECONNRESET/.test(thrown.error));
}

console.log("\nMail — the intake email");
{
  const m = intakeEmail({ company: "Test Floor LLC", contact_name: "Nate", contact_email: "n@x.com", contact_phone: "555", start_date: "Tuesday",
    closers: "Ana, ana@x.com\nLuis, luis@x.com", recorder: "Fathom on every closer", recording_now: "Yes", crm: "GoHighLevel", crm_location: "loc1",
    crm_admin: "Sam", setter_model: "Setters book for closers", setters: "Jo", tags: "Closed Won", rubric_notes: "Ask before you pitch", api_key: "sk-should-not-appear" }, { appUrl: "https://app.test" });
  check("the subject says who and how many", m.subject === "New onboarding form: Test Floor LLC (2 closers)");
  check("the text carries the fields a person acts on", /Contact: Nate <n@x\.com>, 555/.test(m.text) && /Wants the setup call: Tuesday/.test(m.text) && /- Ana, ana@x\.com/.test(m.text) && /location loc1/.test(m.text) && /Ask before you pitch/.test(m.text));
  check("...and never a key, even if one were smuggled into the data", !/sk-should-not-appear/.test(m.text) && !/sk-should-not-appear/.test(m.html));
  check("the HTML escapes what it prints", /&lt;n@x\.com&gt;/.test(m.html) && !/<n@x\.com>/.test(m.html));
  check("it points at the app", /https:\/\/app\.test/.test(m.text) && /Account &amp; Access/.test(m.html));
}

console.log("\nMail — wired into the routes, without power over the response");
check("the intake route notifies AFTER the row is stored and the event logged",
  idx.indexOf('kind: "intake.received"') < idx.indexOf("const mail = intakeEmail(data") && idx.indexOf("INSERT INTO intake") < idx.indexOf("const mail = intakeEmail(data"));
check("...inside a try/catch that ends in the same 200 either way",
  /try \{\s*const mail = intakeEmail\(data[\s\S]*?\} catch \(err\) \{[\s\S]*?intake\.notify_failed[\s\S]*?\}\s*return json\(\{ ok: true \}\);/.test(idx));
check("...logging notified / notify_skipped / notify_failed as three distinct outcomes", /intake\.notified/.test(idx) && /intake\.notify_skipped/.test(idx) && /intake\.notify_failed/.test(idx));
check("the reply-to is the customer, so answering the email answers them", /replyTo: data\.contact_email/.test(idx));
check("INTAKE_TO falls back to REPORT_TO", /env\.INTAKE_TO \|\| env\.REPORT_TO/.test(idx));
check("the weekly report send is no longer a 501 stub", !/send adapter is not written yet/.test(idx) && /kind: out\.sent \? "report\.sent" : "report\.send_failed"/.test(idx));
check("the deploy pushes the key from a GitHub secret only when set (job-level env; secrets.* is illegal in a step if:)", /env:\s*\n\s*EMAIL_API_KEY: \$\{\{ secrets\.EMAIL_API_KEY \}\}\s*\n\s*steps:/.test(wf) && /if: \$\{\{ env\.EMAIL_API_KEY != '' \}\}/.test(wf) && !/if: \$\{\{ secrets\./.test(wf) && /wrangler secret put EMAIL_API_KEY/.test(wf));
check("...and passes recipients as variables, not secrets", /--var INTAKE_TO:"\$\{\{ vars\.INTAKE_TO \}\}"/.test(wf) && /--var REPORT_TO:"\$\{\{ vars\.REPORT_TO \}\}"/.test(wf));
check("this suite runs in CI", /mail\.test\.mjs/.test(pkg.scripts.test));

console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
