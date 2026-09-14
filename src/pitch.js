// The proposal for Nathan (TASK-131, reshaped 14 Sep). A hidden page, same mechanism as the
// pricing report: the URL is the credential, served noindex, never in public/.
//
// THIS PAGE IS READ BY A CUSTOMER. Nothing on it may be internal: no infrastructure cost, no
// margin, no mention of what keys we hold, no quotes from calls, no partner names beyond the
// people he will actually meet. tests/pages.test.mjs greps for the things that must not leak.
//
// 14 Sep call: Gabriel wanted "the original version" -- the structure and the simple hours
// calculator this page has always had -- with his language on it and the agreement's terms.
// What changed: the problem line ("The sales floor is about to scale faster than manual call
// review can"), "from one dashboard", "Training starts with the moment", Today / With CloserAI;
// no monetary value put on the hours, ever; the offer is the Founding Partner Deployment for
// On Screen Authority with the first 30 days included in activation and the monthly from day 31;
// $47 per additional seat, closer or administrator, same price; the "why the pricing is different
// right now" block and the 30-Day Deployment Guarantee summarised from the agreement; four steps
// from payment to live; the payment button stays; the onboarding link and the booking button are
// OFF this page -- Gabriel sends the onboarding page himself once funds are collected.
// The 13 September version is frozen at its own URL (src/pitch_snapshot.js) for comparison.
import { shell, pageResponse, tokenMatches } from "./pagekit.js";

export const PITCH_TOKEN = "3abd3a2c0ec5861ba624a58f00d10900";

// The commercial terms live HERE and nowhere else on the page. Gabriel's proposal of 12 Sep:
// $1,997 to start, $197 a month including three closers and one administrator. He named no
// price for a fourth seat; until one is decided the page says "ask us" rather than inventing
// one. PAY_URL and BOOK_URL are null until Gabriel sends the payment link and a booking link
// exists; the page degrades to honest copy for each. CLIENT is a first name on purpose.
//
// 13 Sep call (transcript beside the recording on the Desktop): NO day counts anywhere on the
// page, because a stated timeline becomes the client's weapon the day it slips ("but you told me
// seven days"); the product is CloserAI, capital C capital AI, no space, no dash, a placeholder
// until it has a name; the checkout opens in a new tab; "Will my reps feel watched" is gone so we
// do not plant the fear ourselves; "held hostage" is gone; the cost FAQ names any frontier model
// with API access and gives the MEASURED per-call range ($0.50-0.85, Pricing v2), never a monthly
// guess. The 7-day trial stays; Gabriel's script says 30 days and that term is not decided.
// tests/pages.test.mjs pins each of these so none can quietly return.
export const OFFER = Object.freeze({
  client: "Nathan",
  business: "On Screen Authority",
  activation: 1997,        // one time; includes implementation and the first 30 days (agreement s.21)
  includedDays: 30,        // the monthly begins on day 31
  monthly: 197,
  includedSeats: 3,
  includedAdmins: 1,
  extraSeat: 47,           // per additional seat, closer OR administrator, same price (Gabriel, 14 Sep)
  payUrl: "https://collectcheckout.com/r/mf1hanjol0xg7bghwayjn7audrulq0",   // card payment (2026-09-12)
  bookUrl: null,           // booking lives on the onboarding page, which Gabriel sends after payment
  onboardingPath: null,    // deliberately NOT linked from the proposal (Gabriel, 14 Sep)
});

const money = n => "$" + Number(n).toLocaleString("en-US");

export function pitchResponse(pathname, { onboardingPath = null } = {}) {
  const token = pathname.replace(/^\/r\//, "").replace(/\/$/, "");
  if (!tokenMatches(token, PITCH_TOKEN)) return null;
  return pageResponse(pitchHtml({ ...OFFER, onboardingPath }));
}

export function pitchHtml(o = OFFER) {
  const nav = [
    ["why", "Why"], ["closers", "Your closers"], ["you", "You"], ["training", "Training"],
    ["time", "The hours"], ["connects", "Connects"], ["offer", "The offer"], ["next", "Next"], ["faq", "Questions"],
  ];
  const payBtn = o.payUrl
    ? `<a class="btn primary" href="${o.payUrl}" target="_blank" rel="noopener">Start CloserAI</a>`
    : `<span class="btn primary" aria-disabled="true">Start CloserAI</span><span class="cta-note">Your payment link arrives with this proposal.</span>`;


  const body = `
  <header class="hero">
    <p class="eyebrow">Prepared for ${o.client} &middot; ${o.business}</p>
    <h1>Coach every closer like you sat in on every call.</h1>
    <p class="standfirst">CloserAI reads and scores every recorded call, writes the follow-up and the CRM note, and shows you who is winning and who is stuck, on one dashboard.</p>
    <div class="meta"><span class="tag">Runs on your recordings</span><span class="tag">Your CRM, connected</span><span class="tag">Set up on one call</span><span class="tag">Monthly, no contract</span></div>
  </header>

  <section id="why" class="reveal">
    <p class="kicker">The problem</p>
    <h2>The sales floor is about to scale faster than manual call review can.</h2>
    <div class="grid3">
      <div class="card"><div class="ch">Your reps</div><div class="n">15&ndash;20 min</div><p>of admin after every call, if they do it properly: notes, the text, the email, the CRM.</p></div>
      <div class="card"><div class="ch">Your management</div><div class="n">0 of 200</div><p>calls a month actually reviewed, because there is no hour in the week where that fits.</p></div>
      <div class="card"><div class="ch">Your training</div><div class="n">15&ndash;20 min</div><p>lost per session finding the right moment in the right recording, then asking who wants to volunteer.</p></div>
    </div>
    <p>None of that is a discipline problem. It is a volume problem, and volume is exactly what software is for.</p>
  </section>

  <section id="closers" class="reveal">
    <p class="kicker">At the rep level</p>
    <h2>What each closer gets after each call</h2>
    <ul class="checks">
      <li><strong>A scorecard for the call</strong>, on the dimensions you care about: rapport, discovery, pain, objection handling, the close, the follow-up. Out of ten, with the reason.</li>
      <li><strong>The follow-up, written.</strong> A text and an email drafted from what the prospect actually said, in the tone you set, ready to send or edit.</li>
      <li><strong>The CRM note, done.</strong> A detailed note built from the transcript, ready to paste the moment the call ends.</li>
      <li><strong>Their own patterns.</strong> What they do well, what keeps costing them, across every call they have taken, not just the last one.</li>
      <li><strong>The moments that mattered</strong>, timestamped and linked straight into the recording, so a rep can watch the second the call turned.</li>
    </ul>
    <div class="note key"><div class="note-h">&#9679; The scoreboard effect</div><p>A closer who can see their own number after every call starts coaching themselves between the calls you coach them on. New reps in particular get up to speed against a visible standard instead of a feeling.</p></div>
  </section>

  <section id="you" class="reveal">
    <p class="kicker">At your level</p>
    <h2>What you see, from one dashboard</h2>
    <ul class="checks">
      <li><strong>The whole team on one page.</strong> Calls, scored calls, average, hours on the phone, last call, per person.</li>
      <li><strong>Each person, in depth.</strong> Every dimension with its average, the range, and how it has moved week by week.</li>
      <li><strong>Every call summarised</strong>, with the key moments timestamped and one click into the recording.</li>
      <li><strong>Are they following the process?</strong> Every call is scored against a rubric you write. Change the rubric and every call after it is scored the new way.</li>
      <li><strong>Who ran it.</strong> Every call carries the closer who took it; the setter who booked it comes across from your CRM.</li>
      <li><strong>Ask Vera.</strong> An assistant that has read every call you can see. Ask her who needs coaching first, why a dimension is slipping, or which moments to bring to Friday's training.</li>
    </ul>
  </section>

  <section id="training" class="reveal">
    <p class="kicker">Training day</p>
    <h2>Training starts with the moment, not the search for it</h2>
    <div class="ba">
      <div class="before"><div class="bh">Today</div><p>Pull up a recording. Scrub. Wrong one. Try another. Ask who wants to go first. Twenty minutes gone, and the example is whatever someone remembered.</p></div>
      <div class="after"><div class="bh">With CloserAI</div><p>Open Vera. "Which three moments should I bring to training this week?" Each one links to its timestamp. The group watches the exact second, then the scorecard for it, then what the rep did next.</p></div>
    </div>
    <p>The examples come from your floor, this week, with the numbers attached. Coaching stops being an opinion about a call and becomes a conversation about a moment.</p>
  </section>

  <section id="time" class="reveal">
    <p class="kicker">Interactive</p>
    <h2>The hours, for your floor</h2>
    <p>Set your numbers. Everything below is an estimate built from them, and you can make it as conservative as you like.</p>
    <div class="calc">
      <div class="calc-head"><div class="calc-title">Time returned each week</div><div class="calc-sub">Admin after a call is the part that gets written for the rep. Reviewing is the part that gets done for you.</div></div>
      <div class="calc-body">
        <div><div class="ctrl-label"><span>Closers</span><span class="ctrl-val" id="cOut">6</span></div><input type="range" id="inClosers" min="1" max="25" value="6" aria-label="Number of closers"></div>
        <div><div class="ctrl-label"><span>Calls per closer, per day</span><span class="ctrl-val" id="dOut">4</span></div><input type="range" id="inPerday" min="1" max="12" value="4" aria-label="Calls per closer per day"></div>
        <div><div class="ctrl-label"><span>Minutes of admin a call costs today</span><span class="ctrl-val" id="mOut">15 min</span></div><input type="range" id="inMins" min="5" max="30" value="15" step="5" aria-label="Minutes of admin per call"></div>
      </div>
      <div class="readout">
        <div class="cell hi"><div class="k">Returned to reps</div><div class="v" id="repH">&mdash;</div><div class="n">hours per week, across the floor</div></div>
        <div class="cell"><div class="k">Per closer</div><div class="v" id="eachH">&mdash;</div><div class="n">hours a week, back on the phone</div></div>
        <div class="cell span"><div class="k">Calls reviewed for you</div><div class="v" id="calls">&mdash;</div><div class="n">every week, scored and searchable. Today: none.</div></div>
      </div>
    </div>
    <p class="cta-note">Estimates, from your inputs.</p>
  </section>

  <section id="connects" class="reveal">
    <p class="kicker">How it fits</p>
    <h2>It connects to what you already run</h2>
    <div class="grid3">
      <div class="card"><div class="ch">Recordings</div><h4>Fathom</h4><p>Your Zoom, Meet and Teams calls arrive on their own, with the transcript. Nothing to upload.</p></div>
      <div class="card"><div class="ch">CRM</div><h4>GoHighLevel</h4><p>Connected with a private integration token from your own account. No marketplace app, no approval wait. Closer and setter attribution flow from it.</p></div>
      <div class="card"><div class="ch">AI</div><h4>Your own AI account</h4><p>The analysis runs on an AI account you own, from Anthropic (Claude) or OpenAI, connected with an API key you control and can revoke any day.</p></div>
    </div>
    <div class="note good"><div class="note-h">&#9679; Your data stays with you</div><p>Your recordings stay with your recorder. The analysis runs on an account you own. Card details go to the payment processor's own pages and never touch CloserAI. And there is no annual contract holding any of it in place.</p></div>
  </section>

  <section id="offer" class="reveal">
    <p class="kicker">The offer</p>
    <h2>CloserAI &middot; Founding Partner Deployment for ${o.business}</h2>
    <div class="offer">
      <div class="oh">The terms</div>
      <div class="price">
        <div><div class="l">Activation</div><div class="p">${money(o.activation)}<small>one time</small></div></div>
        <div><div class="l">After the first ${o.includedDays} days</div><div class="p">${money(o.monthly)}<small>per month</small></div></div>
      </div>
      <ul class="checks">
        <li><strong>The first ${o.includedDays} days are included</strong> in the activation. The monthly begins on day ${o.includedDays + 1}.</li>
        <li><strong>${o.includedSeats} closers and ${o.includedAdmins} administrator</strong> in the monthly. <strong>${money(o.extraSeat)} per month for each additional seat</strong>, closer or administrator, same price, each with their own login and their own dashboard.</li>
        <li><strong>Deployment done for you</strong>: Fathom and GoHighLevel connected, your rubric written with you, your team invited, your first calls scored on the setup call.</li>
        <li><strong>Everything on this page</strong>: scorecards, follow-ups, CRM notes, the team dashboard, timestamps into the recording, Vera.</li>
        <li><strong>Your rubric, your tone, your prompts</strong>, editable by you at any time.</li>
        <li><strong>Monthly. No annual contract.</strong> Cancel any month; your data is your own.</li>
      </ul>
      <p class="fine">Each additional business you run gets its own account, its own CRM connection and its own invoice.</p>
    </div>

    <h3>Why the pricing is different right now</h3>
    <p>You are getting CloserAI before the broader public rollout. That matters: we are intentionally working with a small number of businesses to refine the product against real sales floors, and the price reflects that. In exchange for early access, ${o.business} receives:</p>
    <ul class="checks">
      <li><strong>Founding-partner pricing</strong>, held for as long as the account stays active.</li>
      <li><strong>Direct access to the people building it</strong>, not a support queue.</li>
      <li><strong>A say in what gets built next.</strong> Your feedback shapes the roadmap while it is still being drawn.</li>
      <li><strong>Hands-on deployment and training</strong> for your reps and your administrators, live, in your first ${o.includedDays} days.</li>
    </ul>

    <h3>The ${o.includedDays}-Day CloserAI Deployment Guarantee</h3>
    <p>From the moment you activate, we have ${o.includedDays} days to get the system live inside your CRM, delivering your data the way you need it, with your reps and administrators seeing what they need to see. Anything that is not working, we troubleshoot with you.</p>
    <ul class="checks">
      <li><strong>If, at day ${o.includedDays}, the core functionality is not delivered</strong> and that is on us, your monthly billing does not start. We work with you for another ${o.includedDays} days at no charge.</li>
      <li><strong>If it is still not delivered at the end of that second period</strong>, and you have held up your side, the activation fee is refunded.</li>
      <li><strong>Your side of it</strong>: book onboarding within 72 hours of activation, give us the access we need, keep at least 80% of eligible sales calls flowing through the system, have your team actually use it, and tell us about problems within two business days of seeing them.</li>
      <li>It is a guarantee of a working deployment. It is not a guarantee of sales, revenue or close rate; those stay yours.</li>
    </ul>
    <p class="cta-note">The full terms are in the CloserAI Software &amp; Implementation Services Agreement, which comes with your activation.</p>
  </section>

  <section id="next" class="reveal">
    <p class="kicker">From payment to live</p>
    <h2>Four steps</h2>
    <ol class="steps">
      <li><h4>Activate</h4><p>Complete the activation payment. Right after, you get the onboarding form: your team, your CRM, who books your calls.</p></li>
      <li><h4>Onboarding</h4><p>Book your onboarding call within 72 hours, with the short homework that comes with it, so the call is spent connecting, not collecting.</p></li>
      <li><h4>Deployment</h4><p>On the call, your recordings and your CRM are connected and tested live, your rubric is written with you, and your team is invited.</p></li>
      <li><h4>Your first ${o.includedDays} days</h4><p>We run it with you. Your reps use it on real calls; we train your reps and your administrators live, and the training is recorded for everyone who joins later.</p></li>
    </ol>
    <div class="cta-row">${payBtn}</div>
  </section>

  <section id="faq" class="reveal">
    <p class="kicker">Questions</p>
    <h2>The ones people ask</h2>
    <details><summary>Where do the recordings come from?</summary><p>From Fathom, on your team's Zoom, Google Meet or Teams calls. If your closers already record, nothing changes for them. If they do not, Fathom takes ten minutes to set up per person and we do it on the setup call.</p></details>
    <details><summary>Who can see what?</summary><p>You see the whole floor. Each closer sees only their own calls, scorecards and drafts. That boundary is enforced by the system, not by asking anyone to be discreet.</p></details>
    <details><summary>Can I change how calls are scored?</summary><p>Yes. The rubric and the prompt behind it are yours to edit, per call type. Change them and every call from then on is scored the new way.</p></details>
    <details><summary>What does it cost to run?</summary><p>The subscription, plus the usage on your own AI account, any frontier model with API access. Measured on real calls, that runs between fifty cents and a dollar a call. You see that bill directly; nothing is marked up or pooled.</p></details>
    <details><summary>What if I stop?</summary><p>Cancel any month. Your recordings are in your recorder and your CRM notes are in your CRM. Your data is your own.</p></details>
  </section>

  <footer>CloserAI &middot; Prepared for ${o.client}, ${o.business} &middot; This page is private to its link.</footer>`;

  const extraJs = `
  (function(){
    var $ = function(id){ return document.getElementById(id); };
    function fmt(n){ return n >= 100 ? Math.round(n).toLocaleString("en-US") : (Math.round(n * 10) / 10).toLocaleString("en-US"); }
    // Input ids are prefixed. A section on this page has the id closers, and a range that shared
    // it made getElementById return the section, so the calculator opened on NaN. Found by looking.
    function calc(){
      var c = +$("inClosers").value, d = +$("inPerday").value, m = +$("inMins").value;
      $("cOut").textContent = c; $("dOut").textContent = d; $("mOut").textContent = m + " min";
      var callsWeek = c * d * 5;
      var hoursWeek = callsWeek * m / 60;
      $("repH").textContent = fmt(hoursWeek) + " h";
      $("eachH").textContent = fmt(hoursWeek / c) + " h";
      $("calls").textContent = callsWeek.toLocaleString("en-US");
    }
    ["inClosers","inPerday","inMins"].forEach(function(id){ $(id).addEventListener("input", calc); });
    calc();
  })();`;

  return shell({ title: `CloserAI, for ${o.client}`, crumb: `proposal for ${o.client}`, nav, body, extraJs });
}
