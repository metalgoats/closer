// The onboarding page (TASK-131): what a new customer does between "yes" and their first scored
// call, and the intake form that captures the non-secret half of it. Same hidden-link mechanism
// as the proposal. Read by the customer, so nothing internal appears here either.
//
// WHAT THE FORM DELIBERATELY DOES NOT COLLECT: API keys. Fathom, GoHighLevel and AI keys are pasted by the
// customer into Integrations on the setup call, screen-shared, with the Test button pressed while
// somebody who can fix a bad key is still on the line. A key typed into a web form and stored in
// a table is a secret in a place secrets should not be. The form collects the roster, the CRM
// admin, who books calls, and the tags -- the things that take a day to chase by text.
import { shell, pageResponse, tokenMatches } from "./pagekit.js";

export const ONBOARD_TOKEN = "40d5c3ae0881bde825c74f33dd1793c0";
export const INTAKE_MAX_BYTES = 20_000;

export function onboardResponse(pathname, { payUrl = null, bookUrl = null } = {}) {
  const token = pathname.replace(/^\/r\//, "").replace(/\/$/, "");
  if (!tokenMatches(token, ONBOARD_TOKEN)) return null;
  return pageResponse(onboardHtml({ payUrl, bookUrl }));
}

// The fields the intake accepts, and the only ones stored. Anything else in the body is dropped.
export const INTAKE_FIELDS = [
  "company", "contact_name", "contact_email", "contact_phone",
  "admin_name", "admin_email",
  "closers", "recorder", "recording_now",
  "crm", "crm_admin", "crm_location", "setter_model", "setters", "tags", "pipeline",
  "call_types", "tone", "rubric_notes", "start_date", "notes",
];

export function sanitizeIntake(body) {
  const out = {};
  for (const k of INTAKE_FIELDS) {
    const v = body?.[k];
    if (v === undefined || v === null) continue;
    out[k] = String(v).slice(0, 4000);
  }
  return out;
}

export function onboardHtml({ payUrl = null, bookUrl = null } = {}) {
  const nav = [["plan","The steps"],["need","What we need"],["form","Your details"],["call","Setup call"],["after","After"],["faq","Questions"]];
  const payBtn = payUrl ? `<a class="btn primary" href="${payUrl}" target="_blank" rel="noopener">Pay the activation</a>`
                        : `<span class="btn primary" aria-disabled="true">Pay the activation</span><span class="cta-note">Your payment link arrives with your proposal.</span>`;
  const bookBtn = bookUrl ? `<a class="btn ghost" href="${bookUrl}" rel="noopener">Book the setup call</a>`
                          : `<span class="cta-note">We send a booking link for the 30-minute setup call as soon as payment clears.</span>`;
  const body = `
  <header class="hero">
    <p class="eyebrow">Onboarding</p>
    <h1>Three steps from yes to your first scored call.</h1>
    <p class="standfirst">Your part is a short form, one screen-share call, and having the right people on it. Here is the whole thing, in order, with nothing hidden.</p>
    <div class="meta"><span class="tag">A short form</span><span class="tag">30 min setup call</span><span class="tag">No keys sent by email</span></div>
  </header>

  <section id="plan" class="reveal">
    <p class="kicker">The steps</p>
    <h2>What happens, in order</h2>
    <ol class="steps">
      <li><h4>Yes, and the form below</h4><p>Pay the activation, then give us a few minutes on the form: who is on the floor, who runs your CRM, who books your calls. Everything downstream waits on this, which is why it is first.</p></li>
      <li><h4>Your homework, before the call</h4><p>Make sure every closer has Fathom recording their calls, that whoever administers your GoHighLevel can join the setup call, and that the person who can authorize access is in the room. We will text once if the form has not come back.</p></li>
      <li><h4>The setup call, 30 minutes</h4><p>Screen-shared. Your recorder, your CRM and your AI account are connected and tested live. Your rubric is written with you. Your team is invited.</p></li>
    </ol>
    <p>After the call, your recent calls come in and we read the first outputs with our own eyes, confirming every call is on the right closer before anyone else sees a number. A recorded walkthrough is sent to you rather than booked, so the people who were never going to attend can still watch it, twice. Then your closers are getting a scorecard and a written follow-up after every call, and you have the team page.</p>
  </section>

  <section id="need" class="reveal">
    <p class="kicker">What we need from you</p>
    <h2>Six things, and where each one comes from</h2>
    <ul class="checks">
      <li><strong>Your roster.</strong> Name, email and role (closer or manager) for every seat. Each becomes a login; closers see only their own calls.</li>
      <li><strong>Fathom on every closer's account</strong>, recording their calls. <em>Where:</em> fathom.video, free tier is fine. If someone does not have it yet, we set it up on the call.</li>
      <li><strong>An administrator login to your GoHighLevel</strong> for us, plus your Location ID. <em>Where:</em> Settings &rarr; My Staff (add us as an admin user); the Location ID is in your sub-account URL. This is how the CRM connects and how setters get credited.</li>
      <li><strong>Who books your calls.</strong> If setters book for closers, we add a fifteen-minute workflow in your GoHighLevel on the setup call so every call knows who set it.</li>
      <li><strong>Your tags and pipeline names</strong>, as they are today, so CRM notes land where your team already looks.</li>
      <li><strong>An AI account</strong> with a card on it: Claude at console.anthropic.com, or OpenAI at platform.openai.com. Ten minutes. <em>The key itself is pasted on the setup call, never sent to us.</em></li>
    </ul>
    <div class="note warn"><div class="note-h">&#9679; Please do not email API keys</div><p>Not your Fathom key, not your AI key, not a GoHighLevel token. On the setup call you paste each one into CloserAI yourself and press Test. We never need to see them.</p></div>
  </section>

  <section id="form" class="reveal">
    <p class="kicker">Your details</p>
    <h2>The form</h2>
    <p>Nothing here is secret; it is the list we would otherwise chase by text over three days. Submit once; you can send corrections by reply to any of our messages.</p>
    <form class="form" id="intake" novalidate>
      <div class="f-grid">
        <div class="f wide"><label for="company">Business</label><input id="company" name="company" required placeholder="The business this account is for"></div>
        <div class="f"><label for="contact_name">Your name</label><input id="contact_name" name="contact_name" required></div>
        <div class="f"><label for="contact_email">Your email</label><input id="contact_email" name="contact_email" type="email" required></div>
        <div class="f"><label for="contact_phone">Best number to text</label><input id="contact_phone" name="contact_phone" type="tel" placeholder="For the nudge and the setup call"></div>
        <div class="f"><label for="start_date">When would you like the setup call?</label><input id="start_date" name="start_date" placeholder="e.g. Tuesday or Wednesday morning"></div>
        <div class="f"><label for="admin_name">Who administers CloserAI for you?</label><input id="admin_name" name="admin_name" placeholder="Usually you or your sales manager"></div>
        <div class="f"><label for="admin_email">Their email</label><input id="admin_email" name="admin_email" type="email"></div>
        <div class="f wide"><label for="closers">Your closers</label><textarea id="closers" name="closers" required placeholder="One per line: Name, email"></textarea><span class="hint">Each becomes a login that sees only their own calls.</span></div>
        <div class="f"><label for="recorder">How are calls recorded today?</label><select id="recorder" name="recorder"><option>Fathom on every closer</option><option>Fathom on some closers</option><option>Zoom cloud recording</option><option>Not recorded yet</option><option>Other</option></select></div>
        <div class="f"><label for="recording_now">Are closers recording every call now?</label><select id="recording_now" name="recording_now"><option>Yes</option><option>Most</option><option>No</option></select></div>
        <div class="f"><label for="crm">CRM</label><select id="crm" name="crm"><option>GoHighLevel</option><option>Other</option><option>None yet</option></select></div>
        <div class="f"><label for="crm_location">GoHighLevel Location ID</label><input id="crm_location" name="crm_location" placeholder="From your sub-account URL"></div>
        <div class="f wide"><label for="crm_admin">Who administers your GoHighLevel? (name, email)</label><input id="crm_admin" name="crm_admin" placeholder="They should join the setup call, or add us as an admin beforehand"></div>
        <div class="f"><label for="setter_model">Who books the calls?</label><select id="setter_model" name="setter_model"><option>Setters book for closers</option><option>Closers book their own</option><option>Mixed</option><option>Inbound / automated</option></select></div>
        <div class="f"><label for="setters">Your setters (if any)</label><input id="setters" name="setters" placeholder="Names, so credit lands on the right person"></div>
        <div class="f wide"><label for="tags">Tags and pipeline stages you use today</label><textarea id="tags" name="tags" placeholder="e.g. Closed Won, Follow-up 48h, No-show, VIP"></textarea></div>
        <div class="f"><label for="call_types">Kinds of calls your closers take</label><input id="call_types" name="call_types" placeholder="e.g. discovery, close, renewal"></div>
        <div class="f"><label for="tone">Tone for follow-up texts and emails</label><select id="tone" name="tone"><option>Warm and direct</option><option>Formal</option><option>Casual</option><option>Match each prospect</option></select></div>
        <div class="f wide"><label for="rubric_notes">What does a great call look like on your floor?</label><textarea id="rubric_notes" name="rubric_notes" placeholder="The three or four things you already coach on. This becomes the first draft of your rubric."></textarea></div>
        <div class="f wide"><label for="notes">Anything else</label><textarea id="notes" name="notes"></textarea></div>
      </div>
      <div class="f-foot">
        <button class="btn primary" type="submit" id="submitBtn">Send</button>
        <span class="f-msg" id="msg">Takes a few minutes. Nothing here is a password or a key.</span>
      </div>
    </form>
  </section>

  <section id="call" class="reveal">
    <p class="kicker">The setup call</p>
    <h2>The setup call, minute by minute</h2>
    <ol class="steps">
      <li><span class="when">5 min</span><h4>Connect and test the three credentials</h4><p>You paste your Fathom key, your AI key and your GoHighLevel token into CloserAI yourself. Each has a Test button; we press all three while everyone is still on the line.</p></li>
      <li><span class="when">15 min</span><h4>Setter attribution and your rubric</h4><p>If setters book your calls, a small workflow in your CRM so every call knows who set it. Then your rubric: the dimensions each call is scored on, in your words.</p></li>
      <li><span class="when">5 min</span><h4>Invite the team</h4><p>Every seat gets a login with the right role. Closers see their own calls; managers see the floor.</p></li>
    </ol>
    <div class="cta-row">${bookBtn}</div>
  </section>

  <section id="after" class="reveal">
    <p class="kicker">After</p>
    <h2>What ongoing looks like</h2>
    <ul class="checks">
      <li><strong>Every call, automatically.</strong> New recordings arrive on their own and are scored within minutes.</li>
      <li><strong>You edit the rubric and the tone yourself</strong>, any time, and every call after that follows.</li>
      <li><strong>Adding a closer</strong> is one login and a Fathom account; adding a business is a new account with its own CRM connection.</li>
      <li><strong>Support</strong> by text or email, and a person, not a bot, on the other end.</li>
    </ul>
    <div class="cta-row">${payBtn}</div>
  </section>

  <section id="faq" class="reveal">
    <p class="kicker">Questions</p>
    <h2>Before you ask</h2>
    <details><summary>Do my closers have to do anything differently?</summary><p>Record their calls, which most already do. Everything else happens to them, not by them: the scorecard and the drafts arrive after the call.</p></details>
    <details><summary>What if a closer does not have Fathom?</summary><p>We set it up together on the setup call. Ten minutes per person, free tier.</p></details>
    <details><summary>What happens to a call with no real conversation, like a no-show?</summary><p>It is imported and summarised but not scored. A no-show is not a sales call and it does not sit in anyone's average.</p></details>
    <details><summary>Can we start with some of the team?</summary><p>Yes. Many floors start with two or three closers and add the rest once the first scorecards have landed.</p></details>
  </section>

  <footer>CloserAI &middot; Onboarding &middot; This page is private to its link.</footer>`;

  const extraJs = `
  (function(){
    var f = document.getElementById("intake"), msg = document.getElementById("msg"), btn = document.getElementById("submitBtn");
    var TOKEN = ${JSON.stringify(ONBOARD_TOKEN)};
    f.addEventListener("submit", function(e){
      e.preventDefault();
      var data = {}; new FormData(f).forEach(function(v, k){ data[k] = v; });
      if (!data.company || !data.contact_name || !data.contact_email || !data.closers) {
        msg.className = "f-msg err"; msg.textContent = "Business, your name, your email and your closers are the four we cannot start without."; return;
      }
      btn.disabled = true; msg.className = "f-msg"; msg.textContent = "Sending\\u2026";
      fetch("/api/intake", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ token: TOKEN, data: data }) })
        .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
        .then(function(x){
          if (x.ok) { msg.className = "f-msg ok"; msg.textContent = "Received. We will text you to confirm the setup call."; f.querySelectorAll("input,textarea,select").forEach(function(el){ el.disabled = true; }); }
          else { btn.disabled = false; msg.className = "f-msg err"; msg.textContent = (x.j && x.j.error) || "That did not go through. Try once more, or reply to our last message with the details."; }
        })
        .catch(function(){ btn.disabled = false; msg.className = "f-msg err"; msg.textContent = "No connection. Try again in a moment."; });
    });
  })();`;
  return shell({ title: "CloserAI onboarding", crumb: "onboarding", nav, body, extraJs });
}
