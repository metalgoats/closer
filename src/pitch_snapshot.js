// FROZEN SNAPSHOT of the proposal as it stood on 13 September before the call edits (commit
// 3dd1355) -- the version Gabriel asked to see again ("is there a way to get the previous version
// of the one sheet for Nathan?"). Kept at its own hidden URL for reference only. Do not edit; it
// exists so the two versions can be compared side by side. It renders through the CURRENT page
// kit, so the shell (bar, rail, scrollbar) is today's; the content is the 13 September content.
// The proposal for Nathan (TASK-131). A hidden page, same mechanism as the pricing report: the
// URL is the credential, served noindex, never in public/.
//
// THIS PAGE IS READ BY A CUSTOMER. Nothing on it may be internal: no infrastructure cost, no
// margin, no mention of what keys we hold, no quotes from calls, no partner names beyond the
// people he will actually meet. tests/pages.test.mjs greps for the things that must not leak.
//
// Shape, deliberately: Donald Miller's StoryBrand for the spine (the customer is the hero, we
// are the guide, three-step plan, stakes, success), and Alex Hormozi's offer construction for
// the close (dream outcome, likelihood, speed, effort; the value stack; risk reversal; a price
// anchored against the cost of the problem rather than against our cost). Every number the page
// asserts about the customer's time is an ESTIMATE, labelled as one, and adjustable.
import { shell, pageResponse, tokenMatches } from "./pagekit.js";

export const SNAPSHOT_TOKEN = "e1b606395f6da2fb17b745eb84c9fdb1";

// The commercial terms live HERE and nowhere else on the page. Gabriel's proposal of 12 Sep:
// $1,997 to start, $197 a month including three closers and one administrator. He named no
// price for a fourth seat; until one is decided the page says "ask us" rather than inventing
// one. PAY_URL and BOOK_URL are null until Gabriel sends the payment link and a booking link
// exists; the page degrades to honest copy for each. CLIENT is a first name on purpose.
export const SNAPSHOT_OFFER = Object.freeze({
  client: "Nathan",
  activation: 1997,
  monthly: 197,
  includedSeats: 3,
  includedAdmins: 1,
  extraSeat: 47,           // per additional closer, per month (Ivan, 2026-09-13; was 150 the day before)
  trialDays: 7,            // on the client's own key (Ivan, 2026-09-12)
  payUrl: null,   // reference copy: no live buttons
  bookUrl: null,
  onboardingPath: null,    // filled by index.js from the onboarding page's token
});

const money = n => "$" + Number(n).toLocaleString("en-US");

export function snapshotResponse(pathname) {
  const token = pathname.replace(/^\/r\//, "").replace(/\/$/, "");
  if (!tokenMatches(token, SNAPSHOT_TOKEN)) return null;
  return pageResponse(snapshotHtml(SNAPSHOT_OFFER));
}

export function snapshotHtml(o = SNAPSHOT_OFFER) {
  const nav = [
    ["why", "Why"], ["closers", "Your closers"], ["you", "You"], ["training", "Training"],
    ["time", "The hours"], ["connects", "Connects"], ["offer", "The offer"], ["next", "Next"], ["faq", "Questions"],
  ];
  const payBtn = o.payUrl
    ? `<a class="btn primary" href="${o.payUrl}" rel="noopener">Start Closer</a>`
    : `<span class="btn primary" aria-disabled="true">Start Closer</span><span class="cta-note">Your payment link arrives with this proposal.</span>`;
  const bookBtn = o.bookUrl
    ? `<a class="btn ghost" href="${o.bookUrl}" rel="noopener">Book the 30-minute setup call</a>`
    : `<span class="cta-note">We send you a link to book your 30-minute setup call the moment payment clears.</span>`;
  const extraSeat = o.extraSeat ? `${money(o.extraSeat)} per additional closer, per month.` : `Additional closers: ask us, and we will quote your exact floor.`;
  const trial = o.trialDays ? `<li><strong>${o.trialDays}-day trial</strong> on your own calls before the monthly starts.</li>` : ``;
  const onboardLink = o.onboardingPath ? `<a href="${o.onboardingPath}">the onboarding page</a>` : `the onboarding page we send with this proposal`;

  const body = `
  <header class="hero">
    <p class="eyebrow">Reference copy &middot; the 13 September version &middot; prepared for ${o.client}</p>
    <h1>Coach every closer like you sat in on every call.</h1>
    <p class="standfirst">Closer reads and scores every recorded call, writes the follow-up and the CRM note, and shows you who is winning and who is stuck, on one page. Say yes today; your first scored week starts in seven days.</p>
    <div class="meta"><span class="tag">Runs on your recordings</span><span class="tag">Your CRM, connected</span><span class="tag">Live in seven days</span><span class="tag">Monthly, no contract</span></div>
  </header>

  <section id="why" class="reveal">
    <p class="kicker">The problem</p>
    <h2>A sales floor makes more calls than anyone can review.</h2>
    <p class="lede">So the reviewing does not happen, the follow-up goes out that evening if it goes out at all, and training runs on whichever call somebody remembers.</p>
    <div class="grid3">
      <div class="card"><div class="ch">Your reps</div><div class="n">15&ndash;20 min</div><p>of admin after every call, if they do it properly: notes, the text, the email, the CRM.</p></div>
      <div class="card"><div class="ch">You</div><div class="n">0 of 200</div><p>calls a month actually reviewed, because there is no hour in the week where that fits.</p></div>
      <div class="card"><div class="ch">Training</div><div class="n">15&ndash;20 min</div><p>lost per session finding the right moment in the right recording, then asking who wants to volunteer.</p></div>
    </div>
    <p>None of that is a discipline problem. It is a volume problem, and volume is exactly what software is for.</p>
  </section>

  <section id="closers" class="reveal">
    <p class="kicker">At the rep level</p>
    <h2>What each closer gets, after every call</h2>
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
    <h2>What you see, from one page</h2>
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
    <h2>The session starts with the moment, not the search for it</h2>
    <div class="ba">
      <div class="before"><div class="bh">Before</div><p>Pull up a recording. Scrub. Wrong one. Try another. Ask who wants to go first. Twenty minutes gone, and the example is whatever someone remembered.</p></div>
      <div class="after"><div class="bh">With Closer</div><p>Open Vera. "Which three moments should I bring to training this week?" Each one links to its timestamp. The group watches the exact second, then the scorecard for it, then what the rep did next.</p></div>
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
    <p class="cta-note">Estimates, from your inputs. Returned time does not convert one-for-one into revenue; that is why it is shown as hours and not as dollars.</p>
  </section>

  <section id="connects" class="reveal">
    <p class="kicker">How it fits</p>
    <h2>It connects to what you already run</h2>
    <div class="grid3">
      <div class="card"><div class="ch">Recordings</div><h4>Fathom</h4><p>Your Zoom, Meet and Teams calls arrive on their own, with the transcript. Nothing to upload.</p></div>
      <div class="card"><div class="ch">CRM</div><h4>GoHighLevel</h4><p>Connected with a private integration token from your own account. No marketplace app, no approval wait. Closer and setter attribution flow from it.</p></div>
      <div class="card"><div class="ch">Intelligence</div><h4>Your own Claude account</h4><p>The analysis runs on an API key you own. Your calls, your account, your control; you can revoke it any day.</p></div>
    </div>
    <div class="note good"><div class="note-h">&#9679; What that means for your data</div><p>Your recordings stay with your recorder. The analysis runs on an account you own. Card details go to Stripe's own pages and never touch Closer. And there is no annual contract holding any of it in place.</p></div>
  </section>

  <section id="offer" class="reveal">
    <p class="kicker">The offer</p>
    <h2>Everything above, for your floor</h2>
    <div class="offer">
      <div class="oh">Closer for ${o.client}</div>
      <div class="price">
        <div><div class="l">To start</div><div class="p">${money(o.activation)}<small>one time</small></div></div>
        <div><div class="l">Then</div><div class="p">${money(o.monthly)}<small>per month</small></div></div>
      </div>
      <ul class="checks">
        <li><strong>${o.includedSeats} closers and ${o.includedAdmins} administrator</strong> included in the monthly.</li>
        <li><strong>Setup done for you</strong>: Fathom and GoHighLevel connected, your rubric written with you, your team invited, your first calls scored on the setup call.</li>
        <li><strong>Everything on this page</strong>: scorecards, follow-ups, CRM notes, the team page, timestamps into the recording, Vera, the weekly picture.</li>
        <li><strong>Your rubric, your tone, your prompts</strong>, editable by you at any time.</li>
        ${trial}
        <li><strong>Monthly. No annual contract.</strong> Cancel any month and keep your data.</li>
      </ul>
      <p class="fine">${extraSeat} Each additional business you run gets its own account, its own CRM connection and its own invoice.</p>
    </div>
    <div class="note"><div class="note-h">&#9679; For scale</div><p>Enterprise conversation-intelligence platforms charge five figures to switch on, bill annually, and take a month or more to implement. Closer is live in a week, billed monthly, and built for a floor of three to twenty closers rather than a call centre of three hundred.</p></div>
  </section>

  <section id="next" class="reveal">
    <p class="kicker">Next</p>
    <h2>Three steps, seven days</h2>
    <ol class="steps">
      <li><span class="when">Day 0</span><h4>Say yes</h4><p>Pay the activation through the link, and fill in a short form so we know your team, your CRM and who books your calls. Twenty minutes.</p></li>
      <li><span class="when">Day 3</span><h4>The setup call</h4><p>Thirty minutes on screen with us. Your recordings and your CRM get connected and tested live, your rubric is written with you, your team is invited.</p></li>
      <li><span class="when">Day 7</span><h4>Your first scored week</h4><p>Your closers are getting their scorecards and follow-ups after every call, and you are reading the team page.</p></li>
    </ol>
    <div class="cta-row">${payBtn}</div>
    <div class="cta-row">${bookBtn}</div>
    <p>Everything we will need from you, and exactly when, is on ${onboardLink}.</p>
  </section>

  <section id="faq" class="reveal">
    <p class="kicker">Questions</p>
    <h2>The ones people ask</h2>
    <details><summary>Where do the recordings come from?</summary><p>From Fathom, on your team's Zoom, Google Meet or Teams calls. If your closers already record, nothing changes for them. If they do not, Fathom takes ten minutes to set up per person and we do it on the setup call.</p></details>
    <details><summary>Who can see what?</summary><p>You see the whole floor. Each closer sees only their own calls, scorecards and drafts. That boundary is enforced by the system, not by asking anyone to be discreet.</p></details>
    <details><summary>Will my reps feel watched?</summary><p>Some will, at first. What changes it is the scorecard being theirs: they see their number after every call, before you do, and the follow-up is written for them. We give you the two sentences to say on day one, and the framing that works is coaching, not surveillance.</p></details>
    <details><summary>Can I change how calls are scored?</summary><p>Yes. The rubric and the prompt behind it are yours to edit, per call type. Change them and every call from then on is scored the new way.</p></details>
    <details><summary>What does it cost to run?</summary><p>The subscription, plus the usage on your own Claude account, which for a floor of this size is tens of dollars a month. You see that bill directly; nothing is marked up or pooled.</p></details>
    <details><summary>What if I stop?</summary><p>Cancel any month. Your recordings were always in your recorder and your CRM notes were always in your CRM; nothing is held hostage.</p></details>
  </section>

  <footer>Closer &middot; Prepared for ${o.client} &middot; This page is private to its link.</footer>`;

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

  return shell({ title: `Closer, for ${o.client}`, crumb: `proposal for ${o.client} (13 Sep reference)`, nav, body, extraJs });
}
