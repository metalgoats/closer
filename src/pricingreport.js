// The pricing report, served as a hidden page so Ivan can send Gabriel a link (TASK-128).
//
// WHY THIS IS A WORKER ROUTE AND NOT A FILE IN public/
// Everything under public/ is served by env.ASSETS at its own path, and the assets root is
// public — that is how therowan.studio once published its .git. A report that quotes what
// Gabriel said on a recorded call, names OSA's monthly revenue and sets out what we intend to
// charge does not belong at a path anyone can walk to. Here the URL IS the credential: an
// unguessable 128-bit token, compared in constant time, with the page served noindex.
//
// It is deliberately NOT behind requireUser. Gabriel has no login, and making him get one to
// read a document he asked for is friction in place of security.
export const REPORT_TOKEN = "fbc0408f814e23f35887951dcd02e992";

// Constant-time compare. A plain === leaks the token a character at a time to anyone patient
// enough to measure, and the whole security model here is that the token stays secret.
export function tokenMatches(given, expected = REPORT_TOKEN) {
  const a = String(given || "");
  if (a.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= a.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function reportResponse(pathname) {
  const token = pathname.replace(/^\/r\//, "").replace(/\/$/, "");
  if (!tokenMatches(token)) return null;
  return new Response(REPORT_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Belt and braces. The meta tag covers crawlers that read the document; the header
      // covers the ones that only read headers, and PDF/image fetchers that read neither.
      "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
    },
  });
}

const REPORT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
<meta name="referrer" content="no-referrer">
<title>The offer, valued rather than costed</title>
<style>
:root{
  --ink-950:#F2F5FC; --ink-800:#CDD5EA; --ink-600:#8D97B8; --ink-400:#5A6488;
  --paper-0:#0A0D13; --paper-50:#0D1119; --paper-100:#121729; --paper-200:#1A2136;
  --line:#232B44; --line-strong:#333D5C;
  --blue:#5B82FF; --blue-soft:#84A2FF; --blue-wash:#16203F;
  --violet:#A66BFF; --violet-wash:#221A42;
  --pink:#FF5FA8; --pink-wash:#3A1830;
  --warn:#FFB454; --warn-wash:#332413;
  --good:#4ED6A1; --good-wash:#0F2C24;
  --font-display:"SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,sans-serif;
  --font-ui:"SF Pro Text",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  --font-mono:ui-monospace,"SF Mono",Menlo,monospace;
  --shadow:0 1px 2px rgba(0,0,0,.5), 0 18px 48px rgba(0,0,0,.55);
  --maxw:720px;
}
/* Adaptive. The app itself is dark only, but this is a long document that gets read on a phone
   in daylight as often as at a desk at night. Light is defined for the token set only, so a
   colour never has its single definition inside a media query. */
:root[data-theme="light"]{
  --ink-950:#0F1524; --ink-800:#2C3550; --ink-600:#5C6684; --ink-400:#8A93AC;
  --paper-0:#FBFCFE; --paper-50:#F4F6FB; --paper-100:#EDF0F7; --paper-200:#E4E9F4;
  --line:#DCE2EF; --line-strong:#C3CBDE;
  --blue:#2C51D8; --blue-soft:#1E3FBF; --blue-wash:#E7EDFF;
  --violet:#7B3FD4; --violet-wash:#F0E9FF; --pink:#C7317A; --pink-wash:#FFE9F3;
  --warn:#8A5A12; --warn-wash:#FFF3DF; --good:#136B4E; --good-wash:#E1F6EE;
  --shadow:0 1px 2px rgba(16,24,48,.06), 0 14px 36px rgba(16,24,48,.09);
}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]){
    --ink-950:#0F1524; --ink-800:#2C3550; --ink-600:#5C6684; --ink-400:#8A93AC;
    --paper-0:#FBFCFE; --paper-50:#F4F6FB; --paper-100:#EDF0F7; --paper-200:#E4E9F4;
    --line:#DCE2EF; --line-strong:#C3CBDE;
    --blue:#2C51D8; --blue-soft:#1E3FBF; --blue-wash:#E7EDFF;
    --violet:#7B3FD4; --violet-wash:#F0E9FF; --pink:#C7317A; --pink-wash:#FFE9F3;
    --warn:#8A5A12; --warn-wash:#FFF3DF; --good:#136B4E; --good-wash:#E1F6EE;
    --shadow:0 1px 2px rgba(16,24,48,.06), 0 14px 36px rgba(16,24,48,.09);
  }
}
*{box-sizing:border-box;}
html{scroll-behavior:smooth; scroll-padding-top:76px;}
@media (prefers-reduced-motion: reduce){ html{scroll-behavior:auto;} *{transition:none!important; animation:none!important;} }
body{
  margin:0; background:var(--paper-0); color:var(--ink-950);
  font-family:var(--font-ui); font-size:17px; line-height:1.62; letter-spacing:-.022em;
  -webkit-font-smoothing:antialiased; overflow-x:hidden;
}
.wrap{ max-width:var(--maxw); margin:0 auto; padding:0 22px; }

/* ---------- top bar ---------- */
.bar{
  position:sticky; top:0; z-index:50; background:color-mix(in srgb, var(--paper-0) 86%, transparent);
  backdrop-filter:saturate(180%) blur(16px); -webkit-backdrop-filter:saturate(180%) blur(16px);
  border-bottom:1px solid var(--line);
}
.bar-in{ max-width:var(--maxw); margin:0 auto; padding:11px 22px; display:flex; align-items:center; gap:14px; }
.mark{ display:flex; align-items:center; gap:9px; font-family:var(--font-display); font-weight:600; font-size:15px; letter-spacing:-.01em; white-space:nowrap; }
.dot{ width:9px; height:9px; border-radius:50%; background:var(--blue); box-shadow:0 0 0 3px var(--blue-wash); flex:none; }
.bar-nav{ margin-left:auto; display:flex; gap:2px; overflow-x:auto; scrollbar-width:none; }
.bar-nav::-webkit-scrollbar{ display:none; }
.bar-nav a{
  font-size:13px; letter-spacing:-.01em; color:var(--ink-400); text-decoration:none;
  padding:5px 9px; border-radius:7px; white-space:nowrap; transition:color .15s, background .15s;
}
.bar-nav a:hover{ color:var(--ink-800); background:var(--paper-100); }
.bar-nav a.on{ color:var(--ink-950); background:var(--paper-200); }
.theme{
  flex:none; width:32px; height:32px; border-radius:8px; border:1px solid var(--line);
  background:var(--paper-100); color:var(--ink-600); cursor:pointer; font-size:14px; line-height:1;
  display:grid; place-items:center; transition:color .15s, border-color .15s;
}
.theme:hover{ color:var(--ink-950); border-color:var(--line-strong); }
.progress{ position:absolute; left:0; bottom:-1px; height:2px; background:var(--blue); width:0; transition:width .1s linear; }
@media (max-width:720px){ .bar-nav{ display:none; } }

/* ---------- hero ---------- */
.hero{ padding:64px 0 42px; border-bottom:1px solid var(--line); }
.eyebrow{ font-size:12px; letter-spacing:.09em; text-transform:uppercase; color:var(--blue); font-weight:600; margin:0 0 16px; }
h1{ font-family:var(--font-display); font-size:clamp(31px,6.4vw,46px); line-height:1.08; letter-spacing:-.028em; font-weight:640; margin:0 0 20px; }
.standfirst{ font-size:20px; line-height:1.5; letter-spacing:-.018em; color:var(--ink-800); margin:0 0 26px; }
.meta{ display:flex; flex-wrap:wrap; gap:8px; }
.tag{ font-size:12px; letter-spacing:.01em; color:var(--ink-600); background:var(--paper-100); border:1px solid var(--line); border-radius:999px; padding:4px 11px; }

/* ---------- structure ---------- */
section{ padding:46px 0; border-bottom:1px solid var(--line); }
section:last-of-type{ border-bottom:0; }
h2{ font-family:var(--font-display); font-size:clamp(23px,4vw,29px); line-height:1.2; letter-spacing:-.024em; font-weight:620; margin:0 0 8px; }
.kicker{ font-size:12px; letter-spacing:.09em; text-transform:uppercase; color:var(--ink-400); font-weight:600; margin:0 0 12px; }
h3{ font-family:var(--font-display); font-size:19px; letter-spacing:-.018em; font-weight:600; margin:30px 0 8px; }
p{ margin:0 0 17px; color:var(--ink-800); }
strong{ color:var(--ink-950); font-weight:600; }
em{ color:var(--ink-800); }
a.ref{ color:var(--blue-soft); text-decoration:none; border-bottom:1px solid color-mix(in srgb, var(--blue-soft) 40%, transparent); }

/* ---------- pull quote ---------- */
blockquote{
  margin:24px 0; padding:2px 0 2px 20px; border-left:2px solid var(--blue);
  font-size:19px; line-height:1.5; letter-spacing:-.018em; color:var(--ink-950);
}
blockquote cite{ display:block; margin-top:9px; font-size:14px; font-style:normal; color:var(--ink-400); letter-spacing:-.01em; }

/* ---------- callouts ---------- */
.note{ border:1px solid var(--line); border-radius:14px; padding:18px 20px; margin:26px 0; background:var(--paper-50); }
.note-h{ display:flex; align-items:center; gap:9px; font-size:13px; font-weight:640; letter-spacing:.01em; margin-bottom:9px; }
.note p:last-child{ margin-bottom:0; }
.note.warn{ background:var(--warn-wash); border-color:color-mix(in srgb, var(--warn) 34%, transparent); }
.note.warn .note-h{ color:var(--warn); }
.note.key{ background:var(--blue-wash); border-color:color-mix(in srgb, var(--blue) 36%, transparent); }
.note.key .note-h{ color:var(--blue-soft); }
.note.good{ background:var(--good-wash); border-color:color-mix(in srgb, var(--good) 32%, transparent); }
.note.good .note-h{ color:var(--good); }

/* ---------- the calculator ---------- */
.calc{ border:1px solid var(--line-strong); border-radius:18px; background:var(--paper-50); box-shadow:var(--shadow); overflow:hidden; margin:28px 0; }
.calc-head{ padding:16px 20px 0; }
.calc-title{ font-family:var(--font-display); font-size:15px; font-weight:620; letter-spacing:-.01em; }
.calc-sub{ font-size:13px; color:var(--ink-400); margin-top:3px; letter-spacing:-.01em; }
.calc-body{ padding:18px 20px 20px; display:grid; gap:20px; }
.ctrl-label{ display:flex; justify-content:space-between; align-items:baseline; margin-bottom:9px; }
.ctrl-label span:first-child{ font-size:13px; color:var(--ink-600); letter-spacing:-.01em; }
.ctrl-val{ font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:15px; color:var(--ink-950); font-weight:600; }
input[type=range]{ -webkit-appearance:none; appearance:none; width:100%; height:26px; background:transparent; cursor:pointer; display:block; }
input[type=range]::-webkit-slider-runnable-track{ height:5px; border-radius:99px; background:var(--paper-200); border:1px solid var(--line); }
input[type=range]::-moz-range-track{ height:5px; border-radius:99px; background:var(--paper-200); border:1px solid var(--line); }
input[type=range]::-webkit-slider-thumb{ -webkit-appearance:none; width:22px; height:22px; border-radius:50%; background:var(--blue); border:3px solid var(--paper-0); box-shadow:0 1px 6px rgba(0,0,0,.35); margin-top:-9.5px; }
input[type=range]::-moz-range-thumb{ width:22px; height:22px; border-radius:50%; background:var(--blue); border:3px solid var(--paper-0); box-shadow:0 1px 6px rgba(0,0,0,.35); }
input[type=range]:focus-visible{ outline:2px solid var(--blue-soft); outline-offset:4px; border-radius:8px; }
.seg{ display:inline-flex; background:var(--paper-200); border:1px solid var(--line); border-radius:10px; padding:3px; gap:3px; }
.seg button{
  font-family:inherit; font-size:13px; letter-spacing:-.01em; border:0; background:transparent; color:var(--ink-600);
  padding:6px 13px; border-radius:7px; cursor:pointer; font-weight:520; transition:background .15s, color .15s;
}
.seg button[aria-pressed="true"]{ background:var(--paper-0); color:var(--ink-950); box-shadow:0 1px 2px rgba(0,0,0,.28); }
.seg button:focus-visible{ outline:2px solid var(--blue-soft); outline-offset:2px; }
.readout{ display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--line); border-top:1px solid var(--line); }
.cell{ background:var(--paper-100); padding:16px 18px; }
.cell .k{ font-size:12px; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-400); font-weight:600; }
.cell .v{ font-family:var(--font-display); font-variant-numeric:tabular-nums; font-size:clamp(21px,4.4vw,26px); font-weight:640; letter-spacing:-.02em; margin-top:5px; }
.cell .n{ font-size:12px; color:var(--ink-400); margin-top:3px; letter-spacing:-.005em; }
.cell.hero-cell .v{ color:var(--blue-soft); }
@media (max-width:560px){ .readout{ grid-template-columns:1fr 1fr; } .cell.span{ grid-column:1/-1; } }

/* ---------- comparison bars ---------- */
.bars{ display:grid; gap:12px; margin:24px 0; }
.brow{ display:grid; grid-template-columns:132px 1fr; gap:12px; align-items:center; }
.bname{ font-size:14px; color:var(--ink-800); letter-spacing:-.012em; }
.bname small{ display:block; font-size:12px; color:var(--ink-400); letter-spacing:0; }
.btrack{ background:var(--paper-100); border:1px solid var(--line); border-radius:8px; height:34px; position:relative; overflow:hidden; }
.bfill{ height:100%; border-radius:7px 0 0 7px; background:linear-gradient(90deg, var(--paper-200), var(--line-strong)); width:0; transition:width .7s cubic-bezier(.3,0,.16,1); }
.bfill.us{ background:linear-gradient(90deg, var(--blue), var(--violet)); }
.bval{ position:absolute; inset:0; display:flex; align-items:center; padding:0 11px; font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:13px; color:var(--ink-950); }
@media (max-width:560px){ .brow{ grid-template-columns:1fr; gap:5px; } }

/* ---------- table ---------- */
.tablewrap{ overflow-x:auto; margin:24px 0; border:1px solid var(--line); border-radius:12px; -webkit-overflow-scrolling:touch; }
table{ border-collapse:collapse; width:100%; min-width:460px; font-size:15px; letter-spacing:-.014em; }
th,td{ text-align:left; padding:11px 15px; border-bottom:1px solid var(--line); }
th{ font-size:12px; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-400); font-weight:640; background:var(--paper-50); }
tr:last-child td{ border-bottom:0; }
td.num{ font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
tr.us td{ background:var(--blue-wash); font-weight:600; color:var(--ink-950); }

/* ---------- quadrants ---------- */
.quads{ display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:24px 0; }
.quad{ border:1px solid var(--line); border-radius:13px; padding:16px 17px; background:var(--paper-50); }
.quad .qh{ font-size:12px; letter-spacing:.05em; text-transform:uppercase; font-weight:640; margin-bottom:7px; }
.quad p{ font-size:15px; line-height:1.5; margin:0; color:var(--ink-800); letter-spacing:-.014em; }
.quad.up .qh{ color:var(--good); } .quad.down .qh{ color:var(--pink); }
@media (max-width:560px){ .quads{ grid-template-columns:1fr; } }

/* ---------- disclosure ---------- */
details{ border:1px solid var(--line); border-radius:12px; margin:11px 0; background:var(--paper-50); overflow:hidden; }
summary{ cursor:pointer; padding:14px 17px; font-size:15px; font-weight:560; letter-spacing:-.014em; list-style:none; display:flex; gap:11px; align-items:flex-start; }
summary::-webkit-details-marker{ display:none; }
summary::after{ content:"+"; margin-left:auto; color:var(--ink-400); font-size:18px; line-height:1; flex:none; }
details[open] summary::after{ content:"\\2212"; }
summary:focus-visible{ outline:2px solid var(--blue-soft); outline-offset:-2px; }
details .inner{ padding:0 17px 15px; }
details .inner p{ font-size:15px; line-height:1.55; margin:0 0 11px; }
details .inner p:last-child{ margin-bottom:0; }
.num-badge{ font-family:var(--font-mono); font-size:12px; color:var(--blue-soft); background:var(--blue-wash); border-radius:5px; padding:2px 7px; flex:none; margin-top:1px; }

footer{ padding:40px 0 72px; color:var(--ink-400); font-size:13px; letter-spacing:-.008em; }
footer p{ color:var(--ink-400); font-size:13px; }
.rule{ height:1px; background:var(--line); margin:30px 0; }
</style>
</head>
<body>

<div class="bar">
  <div class="bar-in">
    <div class="mark"><span class="dot"></span> Closer<span style="color:var(--ink-400);font-weight:400">&nbsp;/&nbsp;pricing</span></div>
    <nav class="bar-nav" id="nav">
      <a href="#cost">Cost</a>
      <a href="#calc">Calculator</a>
      <a href="#value">Value</a>
      <a href="#time">Time</a>
      <a href="#market">Market</a>
      <a href="#rec">The number</a>
      <a href="#open">Open</a>
    </nav>
    <button class="theme" id="theme" type="button" aria-label="Switch between light and dark">&#9788;</button>
    <div class="progress" id="prog"></div>
  </div>
</div>

<div class="wrap">

  <header class="hero">
    <p class="eyebrow">Prepared for Gabriel &middot; 11 September 2026</p>
    <h1>The offer, valued rather than costed</h1>
    <p class="standfirst">You asked for the price to be built the way <em>$100M Offers</em> builds one: from the value delivered, against real comparables, with margin engineered in on purpose. Grounded, not off of feels. This is that.</p>
    <div class="meta">
      <span class="tag">Every input measured or sourced</span>
      <span class="tag">Three methods, 3% apart</span>
      <span class="tag">Supersedes the three-options memo</span>
    </div>
  </header>

  <section id="cost">
    <p class="kicker">Start here</p>
    <h2>Cost cannot set this price</h2>
    <p>Every client brings their own Anthropic key. That single decision means our cost of serving a business does not grow when that business succeeds, and it also means <strong>there is no cost floor to argue a price up from.</strong></p>
    <p>Measured against production, with setter calls removed: a client running three closers spends <strong>$114&ndash;194 a month</strong> on their own key, which is $38&ndash;65 per seat. Our marginal cost for that same business is <strong>roughly $3 to $5 a month</strong>, plus Stripe. Gross margin on the subscription sits above 95% at every number in this document.</p>
    <div class="note key">
      <div class="note-h">&#9679; So what is the price actually for?</div>
      <p>It funds <strong>the hours of the person who builds and onboards</strong>. That is the real constraint on this business, and it is what the activation fee exists to pay for. Not servers. Servers are $8.41 a month at twenty customers.</p>
    </div>
  </section>

  <section id="calc">
    <p class="kicker">Interactive</p>
    <h2>Run the numbers yourself</h2>
    <p>Drag the seats. The base includes three, and the per-seat rate applies from the fourth onward. Everything below updates live.</p>

    <div class="calc">
      <div class="calc-head">
        <div class="calc-title">Seat calculator</div>
        <div class="calc-sub">Activation is one time, per business. The subscription is monthly, no annual lock.</div>
      </div>
      <div class="calc-body">
        <div>
          <div class="ctrl-label"><span>Closers on the floor</span><span class="ctrl-val" id="seatsOut">6 seats</span></div>
          <input type="range" id="seats" min="1" max="25" value="6" step="1" aria-label="Number of closer seats">
        </div>
        <div>
          <div class="ctrl-label"><span>Businesses</span><span class="ctrl-val" id="bizOut">1</span></div>
          <input type="range" id="biz" min="1" max="8" value="1" step="1" aria-label="Number of separate businesses">
        </div>
        <div>
          <div class="ctrl-label"><span>Per-seat rate beyond the first three</span><span class="ctrl-val" id="rateOut">$297</span></div>
          <div class="seg" role="group" aria-label="Per-seat rate">
            <button type="button" data-rate="297" aria-pressed="true">$297 &middot; Nathan</button>
            <button type="button" data-rate="397" aria-pressed="false">$397 &middot; list</button>
          </div>
        </div>
      </div>
      <div class="readout">
        <div class="cell hero-cell"><div class="k">Per month</div><div class="v" id="mo">$2,388</div><div class="n" id="moNote">1 business</div></div>
        <div class="cell"><div class="k">Effective / seat</div><div class="v" id="ps">$398</div><div class="n">falls as the team grows</div></div>
        <div class="cell span"><div class="k">Year one</div><div class="v" id="y1">$32,156</div><div class="n" id="y1Note">incl. $3,500 activation</div></div>
      </div>
    </div>

    <p><strong>The per-seat price falls as the team grows</strong>, which is what makes expansion easy to say yes to and matches how every buyer already expects volume to work. Set it to six seats and you have Nathan. Set businesses to five and you have the number you were reaching for on the call.</p>

    <div class="note">
      <div class="note-h" style="color:var(--ink-600)">&#9679; Why $3,500 activation and not $2,500</div>
      <p>At $2,500 the fee is one person&rsquo;s wage with extra steps, and the growth ceiling becomes his calendar rather than the market. At $3,500 there is roughly <strong>$1,500 per onboarding genuinely available for a second pair of hands.</strong> That difference is the difference between a business and a job.</p>
    </div>
  </section>

  <section id="value">
    <p class="kicker">The equation</p>
    <h2>Value, the Hormozi way</h2>
    <p style="font-family:var(--font-mono);font-size:14px;color:var(--ink-600);background:var(--paper-100);border:1px solid var(--line);border-radius:10px;padding:13px 15px;letter-spacing:0">Value = (Dream Outcome &times; Perceived Likelihood) &divide; (Time Delay &times; Effort &amp; Sacrifice)</p>
    <p>You used this equation on 11 August to argue the pivot from a rep tool to a manager tool, and you were right. <em>Effort and sacrifice</em> was the failing denominator, because a closer taking five calls a day will not do homework. Selling to the manager moves the effort onto someone whose job already is to know.</p>

    <div class="quads">
      <div class="quad up"><div class="qh">&#9650; Dream outcome</div><p>Every call reviewed, every rep coached from evidence, and the manager knows who is doing what &mdash; without hiring a sales ops person.</p></div>
      <div class="quad up"><div class="qh">&#9650; Perceived likelihood</div><p>A time-boxed trial on their own key, against their own calls. A prospect watching their last twenty calls get scored does not need to believe a claim.</p></div>
      <div class="quad down"><div class="qh">&#9660; Time delay</div><p>Minutes after a call. Gong takes four to six weeks to implement. We are live in days.</p></div>
      <div class="quad down"><div class="qh">&#9660; Effort &amp; sacrifice</div><p>Near zero. The rep copies a drafted message. The manager opens a page.</p></div>
    </div>

    <div class="note good">
      <div class="note-h">&#9679; The lever with the most slack is already yours</div>
      <p>Perceived likelihood is where the most value is sitting untapped, and <strong>your trial answer pulls it for free.</strong> A trial on the client&rsquo;s own key costs us nothing to give and is stronger proof than any amount of deck polish.</p>
    </div>

    <blockquote>
      There&rsquo;s not enough time for Nathan in his role to check and verify if everyone is doing their part.
      <cite>Nathan, naming the problem himself &middot; 09 September</cite>
    </blockquote>
  </section>

  <section id="time">
    <p class="kicker">Interactive</p>
    <h2>The two numbers that carry the argument</h2>

    <blockquote>
      Every single call is taking me an extra 15 to 20 minutes of admin work if I want to do it properly, not counting reviewing my calls &mdash; just copying and pasting prompts and transcripts.
      <cite>Gabriel, unprompted &middot; 09 September</cite>
    </blockquote>

    <div class="calc">
      <div class="calc-head">
        <div class="calc-title">Admin time returned</div>
        <div class="calc-sub">76 calls per closer per month, your actual August. 15 to 20 minutes of admin each.</div>
      </div>
      <div class="calc-body">
        <div>
          <div class="ctrl-label"><span>Closers</span><span class="ctrl-val" id="cOut">3</span></div>
          <input type="range" id="closers" min="1" max="20" value="3" step="1" aria-label="Number of closers">
        </div>
        <div>
          <div class="ctrl-label"><span>How much of that time converts to selling</span><span class="ctrl-val" id="convOut">10% &middot; the honest one</span></div>
          <div class="seg" role="group" aria-label="Conversion assumption">
            <button type="button" data-conv="0.10" aria-pressed="true">10%</button>
            <button type="button" data-conv="0.25" aria-pressed="false">25%</button>
            <button type="button" data-conv="1" aria-pressed="false">100%</button>
          </div>
        </div>
      </div>
      <div class="readout">
        <div class="cell"><div class="k">Hours back / month</div><div class="v" id="hrs">57&ndash;76</div><div class="n" id="callsNote">228 calls</div></div>
        <div class="cell hero-cell span"><div class="k">Selling capacity</div><div class="v" id="cap">$3,600&ndash;4,800</div><div class="n" id="capNote">at 10% conversion, $625 per closer-hour</div></div>
      </div>
    </div>

    <div class="note warn">
      <div class="note-h">&#9650; Do not put the 100% number in a deck</div>
      <p>At full conversion three closers show $36,000&ndash;47,500 a month, and it is technically what the arithmetic says. Returned admin time does not convert one for one, and a buyer like Nathan will say so out loud in the room. <strong>Even discounted to a tenth it is several times any price on this page.</strong> The honest version is strong enough to win with.</p>
    </div>

    <h3>The second number is stronger, because it is not time saved at all</h3>
    <p>228 calls a month. Skimming even a fifth of them at ten minutes each is 7.6 hours. Doing what the dashboard does &mdash; all of them, scored, trended per person &mdash; <strong>is not achievable by hand at any hour count.</strong> Nathan currently does none of it. This is not a chore being outsourced. It is a capability he does not have.</p>

    <div class="note warn">
      <div class="note-h">&#9650; Speed to lead: use the principle, not the multiplier</div>
      <p>The famous figure &mdash; a lead contacted within five minutes is <strong>21&times;</strong> more likely to qualify &mdash; is from the <strong>MIT / InsideSales study (Oldroyd, 2007)</strong>, not Harvard Business Review. HBR&rsquo;s separate 2011 audit of 2,241 companies found a 42-hour average response time and a 7&times; lift for responding within the hour.</p>
      <p>And it measures <strong>first contact with an inbound lead, not post-call follow-up.</strong> Our product drafts the follow-up in about three minutes instead of that evening. That is a real, defensible claim &mdash; <em>the follow-up goes out while you are still in their head</em> &mdash; but the 21&times; does not support it, and Nathan is exactly the buyer who will look it up.</p>
    </div>
  </section>

  <section id="market">
    <p class="kicker">The anchor</p>
    <h2>Why the price can go up</h2>
    <p>Gong charges a small team <strong>$15,000 to $25,000 just to turn it on</strong>, and will not bill monthly. That is the wedge, and it is the sentence to say to Nathan.</p>

    <!-- Bar widths are COMPUTED from data-val, never hand-set. A hand-set width once had us
         drawn shorter than Gong while costing more than Gong, which is a chart arguing for us
         against its own numbers. In a document whose case rests on not doing that, it is the
         one thing that cannot ship. The "Us" row is driven by the calculator above, so the
         comparison stays true at whatever seat count the reader leaves it on. -->
    <div class="bars" id="bars">
      <div class="brow"><div class="bname">Gong<small>5 seats, year one</small></div><div class="btrack"><div class="bfill" data-val="28000"></div><div class="bval">$28,000 &middot; annual only, 4&ndash;6 weeks to set up</div></div></div>
      <div class="brow"><div class="bname">Us<small id="usSeats">6 seats, year one</small></div><div class="btrack"><div class="bfill us" id="usFill" data-val="32156"></div><div class="bval" id="usBar">$32,156 &middot; monthly, live in days</div></div></div>
      <div class="brow"><div class="bname">Chorus<small>5 seats, year one</small></div><div class="btrack"><div class="bfill" data-val="7000"></div><div class="bval">~$7,000 &middot; bundled into a ZoomInfo motion</div></div></div>
      <div class="brow"><div class="bname">Fireflies<small>5 seats, year one</small></div><div class="btrack"><div class="bfill" data-val="1100"></div><div class="bval">~$1,100 &middot; a note-taker, not a training layer</div></div></div>
    </div>
    <p style="font-size:13px;color:var(--ink-400);margin-top:-8px">Bars are to scale against each other, and the &ldquo;Us&rdquo; row follows the calculator. We are <em>above</em> Gong on price and the chart says so.</p>

    <div class="tablewrap">
      <table>
        <thead><tr><th>Product</th><th>Year one, ~5 seats</th><th>The friction</th></tr></thead>
        <tbody>
          <tr><td>Gong</td><td class="num">$28,000</td><td>Annual only, 4&ndash;6 week setup, 5&ndash;15% auto-increase at renewal</td></tr>
          <tr><td>Chorus (ZoomInfo)</td><td class="num">$1,200&ndash;1,500/seat/yr</td><td>Seat minimums, bundled into a ZoomInfo motion</td></tr>
          <tr><td>Salesloft Advanced</td><td class="num">$1,500/user/yr</td><td>CI bundled into sales engagement</td></tr>
          <tr><td>Avoma / Sybill / Jiminny</td><td class="num">$30&ndash;80/seat/mo</td><td>Mid-market self-serve, no training layer</td></tr>
          <tr><td>Fireflies and similar</td><td class="num">$10&ndash;19/seat/mo</td><td>Commodity note-taker</td></tr>
          <tr class="us"><td>Us</td><td class="num">$32,156 &middot; 6 seats</td><td>Monthly, no lock-in, seven-day onboarding</td></tr>
        </tbody>
      </table>
    </div>

    <p>The market has a hole exactly where this product sits: <strong>the three to fifteen rep floor</strong> that Gong will not serve well and that a $19 note-taker does not actually help.</p>

    <div class="note key">
      <div class="note-h">&#9679; The frame decides the number</div>
      <p>This is not a $40 note-taker with extra features. It is <strong>a fractional sales-operations hire</strong> &mdash; the person who would otherwise review the calls, write the CRM notes, draft the follow-ups and tell you who needs coaching. That person costs $3,000 to $6,000 a month part-time.</p>
      <p>Price against <em>that</em> and the number is obviously cheap. Price against Fireflies and it is obviously expensive. Same product, same number. <strong>The frame decides, and we choose the frame.</strong></p>
    </div>
  </section>

  <section id="rec">
    <p class="kicker">The recommendation</p>
    <h2>$3,500 &middot; $1,497 &middot; $297</h2>
    <p>Activation $3,500 per business. $1,497 a month including three seats. $297 per seat after that, with <strong>$397 as the list price from customer two onward</strong> &mdash; Nathan is the reference account and the case study, and a first-customer rate is ordinary. It is far easier than lowering a list price later.</p>

    <div class="tablewrap">
      <table>
        <thead><tr><th>Seats</th><th>Monthly</th><th>Per seat</th><th>Year one</th></tr></thead>
        <tbody>
          <tr><td>3</td><td class="num">$1,497</td><td class="num">$499</td><td class="num">$21,464</td></tr>
          <tr class="us"><td>6 &mdash; Nathan</td><td class="num">$2,388</td><td class="num">$398</td><td class="num">$32,156</td></tr>
          <tr><td>10</td><td class="num">$3,576</td><td class="num">$358</td><td class="num">$46,412</td></tr>
          <tr><td>20</td><td class="num">$6,546</td><td class="num">$327</td><td class="num">$82,052</td></tr>
        </tbody>
      </table>
    </div>

    <p><strong>Nathan across five businesses: $11,940 a month recurring, plus $17,500 in activations.</strong></p>

    <div class="note good">
      <div class="note-h">&#9679; Three independent routes, 3% apart</div>
      <p>The 4 August decision reached <strong>$31,084</strong> for Nathan&rsquo;s six seats by arguing from what a buyer could vibecode themselves. Your own instinct on 11 August was <strong>&ldquo;$2 to 3k a month.&rdquo;</strong> This value-built model gives <strong>$32,156</strong>. When three different methods agree that closely, the number is probably right.</p>
    </div>
  </section>

  <section id="open">
    <p class="kicker">Honesty</p>
    <h2>What this does not resolve</h2>
    <p>Four things this document cannot decide on its own. They are open, and the first one is the reason the activation fee is set where it is.</p>

    <details>
      <summary><span class="num-badge">01</span> The activation fee is still funding one person&rsquo;s hours</summary>
      <div class="inner">
        <p>&ldquo;Right now it is a budget being paid to Ivan because Ivan is the only technician.&rdquo; Both halves of that are true and they are in tension. If Ivan is the technician, the fee is a wage and the business funds nothing.</p>
        <p>At five businesses that is five onboardings of one calendar, and <strong>the growth ceiling is that calendar, not the market.</strong> The $3,500 is set so a second technician is affordable. Somebody still has to hire one.</p>
      </div>
    </details>

    <details>
      <summary><span class="num-badge">02</span> Billing each business separately makes multi-tenancy a requirement, not a someday</summary>
      <div class="inner">
        <p>Separate API key, separate CRM, separate invoice per business is multi-tenancy by definition. It is not needed for Nathan&rsquo;s <em>first</em> business. It is needed the moment his second signs.</p>
        <p>It has been parked since July with the acceptance criteria &ldquo;verify no cross-tenant data leakage&rdquo; and &ldquo;security review before any external customer.&rdquo; Both now have a date attached rather than a maybe.</p>
      </div>
    </details>

    <details>
      <summary><span class="num-badge">03</span> The legal entity</summary>
      <div class="inner"><p>Stripe pays out to a business, and the agreement needs a counterparty. Open since 28 July, and it blocks taking money at all.</p></div>
    </details>

    <details>
      <summary><span class="num-badge">04</span> The name</summary>
      <div class="inner"><p>Still blocks the deck, the support address and the login page. You are running a naming exercise this weekend.</p></div>
    </details>

    <div class="rule"></div>

    <div class="note warn">
      <div class="note-h">&#9650; One thing to settle before the copy gets written</div>
      <p>On the 11 September call the activation was described as <em>&ldquo;2K plus&hellip; I only see it going a little bit higher&rdquo;</em> at 15:33, and the funnel as <em>&ldquo;a $2,000 activation fee with, let&rsquo;s call it, $197 per month&rdquo;</em> at 53:55. Those are thirty-eight minutes apart, and the second is roughly a seventh of what all three methods above support.</p>
      <p><strong>Whichever number is in your head this weekend is the one the webinar copy gets written against, and copy is far harder to reprice than a spreadsheet.</strong> It is a five-minute conversation now or an expensive rewrite in three weeks.</p>
    </div>
  </section>

  <footer>
    <p>Every figure here is measured from production or sourced, and the sources are named where they matter. Nothing in it is a feel.</p>
    <p>Prepared 11 September 2026 &middot; supersedes <em>Business model &mdash; three options</em> &middot; unlisted page, please don&rsquo;t forward the link.</p>
  </footer>

</div>

<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var money = function(n){ return "$" + Math.round(n).toLocaleString("en-US"); };

  /* ---- theme: remembers the choice, falls back to the OS ---- */
  var root = document.documentElement, tbtn = $("theme");
  try { var saved = localStorage.getItem("pricing-theme"); if (saved) root.setAttribute("data-theme", saved); } catch(e){}
  function isLight(){
    var t = root.getAttribute("data-theme");
    if (t) return t === "light";
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  }
  function paintToggle(){ tbtn.innerHTML = isLight() ? "&#9789;" : "&#9788;"; }
  paintToggle();
  tbtn.addEventListener("click", function(){
    var next = isLight() ? "dark" : "light";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("pricing-theme", next); } catch(e){}
    paintToggle();
  });

  /* ---- seat calculator ---- */
  var BASE = 1497, INCLUDED = 3, ACTIVATION = 3500, rate = 297;
  function calc(){
    var seats = +$("seats").value, biz = +$("biz").value;
    var monthlyOne = BASE + Math.max(0, seats - INCLUDED) * rate;
    var monthly = monthlyOne * biz;
    var yearOne = (ACTIVATION * biz) + (monthly * 12);
    $("seatsOut").textContent = seats + (seats === 1 ? " seat" : " seats");
    $("bizOut").textContent = biz;
    $("rateOut").textContent = money(rate);
    $("mo").textContent = money(monthly);
    $("moNote").textContent = biz === 1 ? "1 business" : biz + " businesses \\u00b7 " + money(monthlyOne) + " each";
    $("ps").textContent = money(monthlyOne / seats);
    $("y1").textContent = money(yearOne);
    $("y1Note").textContent = "incl. " + money(ACTIVATION * biz) + " activation";
    var us = $("usBar");
    if (us) us.textContent = money(yearOne) + " \\u00b7 monthly, live in days";
    // Keep the comparison honest as the reader drags: the bar carries the figure it is next to.
    var fill = $("usFill");
    if (fill) { fill.setAttribute("data-val", String(yearOne)); $("usSeats").textContent = seats + (seats === 1 ? " seat" : " seats") + ", year one"; drawBars(); }
  }
  $("seats").addEventListener("input", calc);
  $("biz").addEventListener("input", calc);
  Array.prototype.forEach.call(document.querySelectorAll("[data-rate]"), function(b){
    b.addEventListener("click", function(){
      rate = +b.getAttribute("data-rate");
      Array.prototype.forEach.call(document.querySelectorAll("[data-rate]"), function(o){
        o.setAttribute("aria-pressed", String(o === b));
      });
      calc();
    });
  });
  calc();

  /* ---- admin time returned ---- */
  var CALLS = 76, LO = 15, HI = 20, PER_HOUR = 625, conv = 0.10;
  var convLabel = { "0.1": "10% \\u00b7 the honest one", "0.25": "25%", "1": "100% \\u00b7 do not ship this" };
  function admin(){
    var c = +$("closers").value, calls = c * CALLS;
    var lo = calls * LO / 60, hi = calls * HI / 60;
    $("cOut").textContent = c;
    $("hrs").textContent = Math.round(lo) + "\\u2013" + Math.round(hi);
    $("callsNote").textContent = calls.toLocaleString("en-US") + " calls a month";
    $("cap").textContent = money(lo * PER_HOUR * conv) + "\\u2013" + Math.round(hi * PER_HOUR * conv).toLocaleString("en-US");
    $("capNote").textContent = "at " + Math.round(conv * 100) + "% conversion, $625 per closer-hour";
    $("convOut").textContent = convLabel[String(conv)] || (Math.round(conv * 100) + "%");
  }
  $("closers").addEventListener("input", admin);
  Array.prototype.forEach.call(document.querySelectorAll("[data-conv]"), function(b){
    b.addEventListener("click", function(){
      conv = +b.getAttribute("data-conv");
      Array.prototype.forEach.call(document.querySelectorAll("[data-conv]"), function(o){
        o.setAttribute("aria-pressed", String(o === b));
      });
      admin();
    });
  });
  admin();

  /* ---- comparison bars, drawn to scale from the values themselves ---- */
  var bars = document.querySelectorAll(".bfill");
  var barsShown = false;
  function drawBars(){
    if (!barsShown) return;                       // don't skip the reveal animation
    var vals = Array.prototype.map.call(bars, function(b){ return +b.getAttribute("data-val"); });
    var max = Math.max.apply(null, vals);
    Array.prototype.forEach.call(bars, function(b, i){
      // Floor at 2% so the cheapest row is still a visible bar rather than nothing at all.
      b.style.width = Math.max(2, (vals[i] / max) * 100) + "%";
    });
  }
  function revealBars(){ barsShown = true; drawBars(); }
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function(es){
      es.forEach(function(e){ if (e.isIntersecting) { revealBars(); io.disconnect(); } });
    }, { threshold: 0.25 });
    io.observe(document.getElementById("bars"));
  } else { revealBars(); }

  /* ---- reading progress + which section you are in ---- */
  var links = Array.prototype.slice.call(document.querySelectorAll("#nav a"));
  var secs = links.map(function(a){ return document.querySelector(a.getAttribute("href")); });
  var prog = $("prog"), ticking = false;
  function onScroll(){
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    prog.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + "%";
    var best = 0;
    for (var i = 0; i < secs.length; i++) {
      if (secs[i] && secs[i].getBoundingClientRect().top <= 120) best = i;
    }
    links.forEach(function(a, i){ a.classList.toggle("on", i === best); });
    ticking = false;
  }
  window.addEventListener("scroll", function(){
    if (!ticking) { ticking = true; window.requestAnimationFrame(onScroll); }
  }, { passive: true });
  onScroll();
})();
</script>
</body>
</html>`;
