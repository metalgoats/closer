// The shared kit for hidden, link-only pages: the pricing report set the design language and
// Ivan liked it ("I love the execution... the interactive elements and the page scroll
// indicator"), so the proposal and the onboarding page are built from the same tokens rather
// than each inventing its own. One rule family, one feature.
//
// The rail on the right is borrowed from Jacob Patrick's site at Ivan's request: one mark per
// section and a hairline that fills as you read. It hides on phones, where the top progress
// line does the same job in less room.
import { tokenMatches } from "./pricingreport.js";

export { tokenMatches };

export function pageResponse(html) {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
    },
  });
}

export const PAGE_CSS = `
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
  --maxw:760px; --ease:cubic-bezier(.3,0,.16,1);
}
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
body{ margin:0; background:var(--paper-0); color:var(--ink-950); font-family:var(--font-ui); font-size:17px; line-height:1.62; letter-spacing:-.022em; -webkit-font-smoothing:antialiased; overflow-x:hidden; }
.wrap{ max-width:var(--maxw); margin:0 auto; padding:0 22px; }
a{ color:var(--blue-soft); text-decoration:none; } a:hover{ text-decoration:underline; }
p{ margin:0 0 16px; }
strong{ font-weight:640; color:var(--ink-950); }
em{ font-style:italic; }
hr.rule{ height:1px; border:0; background:var(--line); margin:34px 0; }

/* ---------- top bar ---------- */
.bar{ position:sticky; top:0; z-index:50; background:color-mix(in srgb, var(--paper-0) 86%, transparent); backdrop-filter:saturate(180%) blur(16px); -webkit-backdrop-filter:saturate(180%) blur(16px); border-bottom:1px solid var(--line); }
.bar-in{ max-width:var(--maxw); margin:0 auto; padding:11px 22px; display:flex; align-items:center; gap:14px; }
.mark{ display:flex; align-items:center; gap:9px; font-family:var(--font-display); font-weight:600; font-size:15px; letter-spacing:-.01em; white-space:nowrap; }
.mark .sub{ color:var(--ink-400); font-weight:400; }
.dot{ width:9px; height:9px; border-radius:50%; background:var(--blue); box-shadow:0 0 0 3px var(--blue-wash); flex:none; }
.bar-cta{ margin-left:auto; display:flex; align-items:center; gap:8px; }
.theme{ flex:none; width:32px; height:32px; border-radius:8px; border:1px solid var(--line); background:var(--paper-100); color:var(--ink-600); cursor:pointer; font-size:14px; line-height:1; display:grid; place-items:center; transition:color .15s, border-color .15s; }
.theme:hover{ color:var(--ink-950); border-color:var(--line-strong); }
.progress{ position:absolute; left:0; bottom:-1px; height:2px; background:var(--blue); width:0; transition:width .1s linear; }

/* ---------- the rail (after Jacob Patrick's site) ---------- */
.rail{ position:fixed; right:22px; top:50%; z-index:40; transform:translateY(-50%); display:flex; flex-direction:column; align-items:flex-end; gap:10px; }
.rail .line{ position:relative; width:1px; height:88px; background:var(--line-strong); margin:0 0 6px; }
.rail .fill{ position:absolute; left:0; top:0; width:100%; height:100%; background:var(--blue); transform-origin:top; transform:scaleY(0); }
.rail a{ font-size:12px; letter-spacing:.01em; color:var(--ink-400); text-decoration:none; transition:color .15s var(--ease); white-space:nowrap; }
.rail a:hover{ color:var(--ink-800); text-decoration:none; }
.rail a.on{ color:var(--ink-950); }
@media (max-width:1100px){ .rail{ display:none; } }

/* ---------- type ---------- */
.hero{ padding:66px 0 40px; border-bottom:1px solid var(--line); }
.eyebrow{ font-size:12px; letter-spacing:.09em; text-transform:uppercase; color:var(--blue); font-weight:600; margin:0 0 14px; }
h1{ font-family:var(--font-display); font-size:clamp(32px,6.6vw,50px); line-height:1.06; letter-spacing:-.025em; font-weight:700; margin:0 0 18px; }
.standfirst{ font-size:20px; line-height:1.5; letter-spacing:-.018em; color:var(--ink-800); margin:0 0 26px; }
.meta{ display:flex; flex-wrap:wrap; gap:8px; }
.tag{ font-size:12px; letter-spacing:.01em; color:var(--ink-600); background:var(--paper-100); border:1px solid var(--line); border-radius:100px; padding:5px 11px; }
section{ padding:44px 0 8px; }
.kicker{ font-size:12px; letter-spacing:.09em; text-transform:uppercase; color:var(--ink-400); font-weight:600; margin:0 0 10px; }
h2{ font-family:var(--font-display); font-size:clamp(24px,4.2vw,31px); line-height:1.18; letter-spacing:-.024em; font-weight:650; margin:0 0 16px; }
h3{ font-family:var(--font-display); font-size:19px; letter-spacing:-.018em; font-weight:600; margin:30px 0 10px; }
.lede{ font-size:18px; color:var(--ink-800); }

/* ---------- notes ---------- */
.note{ border:1px solid var(--line); border-radius:14px; padding:18px 20px; margin:26px 0; background:var(--paper-50); }
.note-h{ display:flex; align-items:center; gap:9px; font-size:13px; font-weight:640; letter-spacing:.01em; margin-bottom:8px; color:var(--ink-600); }
.note p:last-child{ margin-bottom:0; }
.note.key{ background:var(--blue-wash); border-color:color-mix(in srgb, var(--blue) 36%, transparent); } .note.key .note-h{ color:var(--blue-soft); }
.note.good{ background:var(--good-wash); border-color:color-mix(in srgb, var(--good) 32%, transparent); } .note.good .note-h{ color:var(--good); }
.note.warn{ background:var(--warn-wash); border-color:color-mix(in srgb, var(--warn) 34%, transparent); } .note.warn .note-h{ color:var(--warn); }

/* ---------- cards / grids ---------- */
.grid2{ display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:22px 0; }
.grid3{ display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin:22px 0; }
@media (max-width:640px){ .grid2, .grid3{ grid-template-columns:1fr; } }
.card{ border:1px solid var(--line); border-radius:14px; padding:18px 18px 16px; background:var(--paper-50); }
.card .ch{ font-size:12px; letter-spacing:.06em; text-transform:uppercase; font-weight:640; color:var(--blue-soft); margin-bottom:8px; }
.card h4{ font-family:var(--font-display); font-size:17px; margin:0 0 6px; letter-spacing:-.016em; font-weight:620; }
.card p{ font-size:15px; line-height:1.5; margin:0; color:var(--ink-800); letter-spacing:-.014em; }
.card .n{ font-family:var(--font-display); font-size:30px; font-weight:700; letter-spacing:-.03em; line-height:1; margin:2px 0 8px; color:var(--ink-950); font-variant-numeric:tabular-nums; }
.stat{ display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--line); border:1px solid var(--line); border-radius:14px; overflow:hidden; margin:22px 0; }
.stat > div{ background:var(--paper-100); padding:16px 18px; }
.stat .k{ font-size:12px; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-400); font-weight:600; }
.stat .v{ font-family:var(--font-display); font-variant-numeric:tabular-nums; font-size:clamp(22px,4.4vw,28px); font-weight:700; letter-spacing:-.03em; line-height:1.15; margin-top:4px; }
.stat .v.hi{ color:var(--blue-soft); }
.stat .s{ font-size:12px; color:var(--ink-400); margin-top:3px; }
@media (max-width:560px){ .stat{ grid-template-columns:1fr 1fr; } .stat > div.span{ grid-column:1/-1; } }

/* ---------- lists ---------- */
ul.checks{ list-style:none; padding:0; margin:14px 0 20px; display:grid; gap:9px; }
ul.checks li{ position:relative; padding-left:30px; font-size:16px; line-height:1.5; letter-spacing:-.016em; color:var(--ink-800); }
ul.checks li::before{ content:""; position:absolute; left:0; top:5px; width:18px; height:18px; border-radius:50%; background:var(--good-wash); border:1px solid color-mix(in srgb, var(--good) 50%, transparent); }
ul.checks li::after{ content:""; position:absolute; left:6px; top:9px; width:5px; height:9px; border:solid var(--good); border-width:0 2px 2px 0; transform:rotate(45deg); }
ul.checks li strong{ color:var(--ink-950); }
ol.steps{ list-style:none; counter-reset:s; padding:0; margin:18px 0; display:grid; gap:12px; }
ol.steps li{ counter-increment:s; position:relative; padding:16px 18px 16px 58px; border:1px solid var(--line); border-radius:14px; background:var(--paper-50); }
ol.steps li::before{ content:counter(s); position:absolute; left:16px; top:15px; width:28px; height:28px; border-radius:50%; background:var(--blue); color:#fff; font-family:var(--font-display); font-weight:700; font-size:14px; display:grid; place-items:center; }
ol.steps li h4{ margin:0 0 4px; font-family:var(--font-display); font-size:17px; letter-spacing:-.016em; font-weight:620; }
ol.steps li p{ margin:0; font-size:15px; color:var(--ink-800); line-height:1.5; letter-spacing:-.014em; }
ol.steps li .when{ position:absolute; right:16px; top:16px; font-size:12px; color:var(--ink-400); letter-spacing:.02em; }

/* ---------- before / after ---------- */
.ba{ display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:22px 0; }
.ba > div{ border:1px solid var(--line); border-radius:14px; padding:18px; background:var(--paper-50); }
.ba .bh{ font-size:12px; letter-spacing:.06em; text-transform:uppercase; font-weight:640; margin-bottom:8px; }
.ba .before .bh{ color:var(--pink); } .ba .after .bh{ color:var(--good); }
.ba p{ font-size:15px; line-height:1.55; margin:0 0 8px; color:var(--ink-800); letter-spacing:-.014em; }
.ba p:last-child{ margin:0; }
@media (max-width:640px){ .ba{ grid-template-columns:1fr; } }

/* ---------- interactive calculator ---------- */
.calc{ border:1px solid var(--line-strong); border-radius:18px; background:var(--paper-50); box-shadow:var(--shadow); margin:26px 0; overflow:hidden; }
.calc-head{ padding:16px 20px 0; }
.calc-title{ font-family:var(--font-display); font-size:15px; font-weight:620; letter-spacing:-.01em; }
.calc-sub{ font-size:13px; color:var(--ink-400); margin-top:3px; letter-spacing:-.01em; }
.calc-body{ padding:18px 20px 20px; display:grid; gap:18px; }
.ctrl-label{ display:flex; justify-content:space-between; align-items:baseline; margin-bottom:9px; }
.ctrl-label span:first-child{ font-size:13px; color:var(--ink-600); letter-spacing:-.01em; }
.ctrl-val{ font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:15px; color:var(--ink-950); }
input[type=range]{ width:100%; accent-color:var(--blue); height:28px; margin:0; }
.readout{ display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--line); border-top:1px solid var(--line); }
.cell{ background:var(--paper-100); padding:16px 18px; }
.cell .k{ font-size:12px; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-400); font-weight:600; }
.cell .v{ font-family:var(--font-display); font-variant-numeric:tabular-nums; font-size:clamp(21px,4.4vw,26px); font-weight:700; letter-spacing:-.03em; line-height:1.15; margin-top:4px; }
.cell .n{ font-size:12px; color:var(--ink-400); margin-top:3px; }
.cell.hi .v{ color:var(--blue-soft); }
@media (max-width:560px){ .readout{ grid-template-columns:1fr 1fr; } .cell.span{ grid-column:1/-1; } }

/* ---------- the offer ---------- */
.offer{ border:1px solid color-mix(in srgb, var(--blue) 40%, var(--line)); border-radius:20px; background:linear-gradient(180deg, var(--blue-wash), var(--paper-50) 60%); box-shadow:var(--shadow); padding:26px 24px 22px; margin:26px 0; }
.offer .oh{ font-size:12px; letter-spacing:.09em; text-transform:uppercase; color:var(--blue-soft); font-weight:640; margin-bottom:10px; }
.price{ display:flex; flex-wrap:wrap; gap:22px 34px; align-items:flex-end; margin:6px 0 18px; }
.price .p{ font-family:var(--font-display); font-size:clamp(34px,7vw,48px); font-weight:750; letter-spacing:-.035em; line-height:1; font-variant-numeric:tabular-nums; }
.price .p small{ font-size:15px; font-weight:500; letter-spacing:-.01em; color:var(--ink-600); margin-left:6px; }
.price .l{ font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-400); font-weight:600; margin-bottom:6px; }
.offer .fine{ font-size:13px; color:var(--ink-400); margin:12px 0 0; }

/* ---------- CTA ---------- */
.btn{ display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:13px 20px; border-radius:11px; font-family:var(--font-display); font-weight:620; font-size:16px; letter-spacing:-.012em; border:1px solid transparent; cursor:pointer; text-decoration:none!important; transition:transform .16s var(--ease), background .16s var(--ease); }
.btn.primary{ background:var(--blue); color:#fff; } .btn.primary:hover{ background:var(--blue-soft); transform:translateY(-1px); }
.btn.ghost{ background:var(--paper-100); color:var(--ink-950); border-color:var(--line-strong); } .btn.ghost:hover{ background:var(--paper-200); }
.btn.small{ padding:9px 14px; font-size:14px; }
.btn[aria-disabled="true"]{ opacity:.55; pointer-events:none; }
.cta-row{ display:flex; flex-wrap:wrap; gap:10px; margin:18px 0 6px; align-items:center; }
.cta-note{ font-size:13px; color:var(--ink-400); }

/* ---------- forms ---------- */
.form{ border:1px solid var(--line-strong); border-radius:18px; background:var(--paper-50); padding:20px; margin:22px 0; box-shadow:var(--shadow); }
.f-grid{ display:grid; grid-template-columns:1fr 1fr; gap:14px; }
@media (max-width:640px){ .f-grid{ grid-template-columns:1fr; } }
.f{ display:flex; flex-direction:column; gap:6px; }
.f.wide{ grid-column:1/-1; }
.f label{ font-size:12px; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-400); font-weight:600; }
.f input, .f textarea, .f select{ font:inherit; font-size:16px; letter-spacing:-.014em; color:var(--ink-950); background:var(--paper-0); border:1px solid var(--line-strong); border-radius:10px; padding:11px 12px; width:100%; }
.f textarea{ min-height:96px; resize:vertical; }
.f input:focus, .f textarea:focus, .f select:focus{ outline:2px solid var(--blue-soft); outline-offset:1px; border-color:var(--blue); }
.f .hint{ font-size:13px; color:var(--ink-400); letter-spacing:-.01em; }
.f-foot{ display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin-top:16px; }
.f-msg{ font-size:14px; color:var(--ink-600); }
.f-msg.ok{ color:var(--good); } .f-msg.err{ color:var(--pink); }

/* ---------- faq ---------- */
details{ border-top:1px solid var(--line); padding:14px 0; }
details:last-of-type{ border-bottom:1px solid var(--line); }
summary{ cursor:pointer; font-family:var(--font-display); font-size:17px; font-weight:600; letter-spacing:-.016em; list-style:none; display:flex; justify-content:space-between; gap:12px; }
summary::-webkit-details-marker{ display:none; }
summary::after{ content:"+"; color:var(--ink-400); font-weight:400; }
details[open] summary::after{ content:"\\2013"; }
details p{ margin:10px 0 0; color:var(--ink-800); font-size:15px; line-height:1.55; }

footer{ padding:40px 0 56px; color:var(--ink-400); font-size:13px; border-top:1px solid var(--line); margin-top:40px; }
.reveal{ opacity:0; transform:translateY(8px); transition:opacity .5s var(--ease), transform .5s var(--ease); }
.reveal.in{ opacity:1; transform:none; }
@media (prefers-reduced-motion: reduce){ .reveal{ opacity:1; transform:none; } }
`;

// Theme, progress line, the rail, and reveal-on-scroll. Shared by every page built on the kit.
export const PAGE_JS = `
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var root = document.documentElement, tbtn = $("theme"), KEY = "closer-page-theme";
  try { var saved = localStorage.getItem(KEY); if (saved) root.setAttribute("data-theme", saved); } catch(e){}
  function isLight(){ var t = root.getAttribute("data-theme"); if (t) return t === "light"; return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches; }
  function paint(){ if (tbtn) tbtn.innerHTML = isLight() ? "&#9789;" : "&#9788;"; }
  paint();
  if (tbtn) tbtn.addEventListener("click", function(){ var n = isLight() ? "dark" : "light"; root.setAttribute("data-theme", n); try { localStorage.setItem(KEY, n); } catch(e){} paint(); });

  var html = document.documentElement, prog = $("prog");
  var rail = document.querySelector(".rail");
  var marks = rail ? Array.prototype.slice.call(rail.querySelectorAll("a")) : [];
  var secs = marks.map(function(m){ return document.querySelector(m.getAttribute("href")); });
  var fill = rail ? rail.querySelector(".fill") : null;
  var ticking = false;
  function update(){
    var max = html.scrollHeight - window.innerHeight;
    var f = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    if (prog) prog.style.width = (f * 100) + "%";
    if (fill) fill.style.transform = "scaleY(" + f + ")";
    var cur = 0;
    secs.forEach(function(s, k){ if (s && s.getBoundingClientRect().top <= window.innerHeight * 0.45) cur = k; });
    if (window.scrollY + window.innerHeight >= html.scrollHeight - 2) { cur = marks.length - 1; if (fill) fill.style.transform = "scaleY(1)"; }
    marks.forEach(function(m, k){ m.classList.toggle("on", k === cur); });
    ticking = false;
  }
  window.addEventListener("scroll", function(){ if (!ticking) { ticking = true; window.requestAnimationFrame(update); } }, { passive:true });
  window.addEventListener("resize", update);
  update();

  var rev = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
  if ("IntersectionObserver" in window && rev.length) {
    var io = new IntersectionObserver(function(es){ es.forEach(function(e){ if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }); }, { threshold:0.12 });
    rev.forEach(function(r){ io.observe(r); });
  } else { rev.forEach(function(r){ r.classList.add("in"); }); }
})();
`;

export function shell({ title, crumb, nav, body, extraJs = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="bar"><div class="bar-in">
  <div class="mark"><span class="dot"></span> Closer<span class="sub">&nbsp;/&nbsp;${crumb}</span></div>
  <div class="bar-cta"><button class="theme" id="theme" type="button" aria-label="Switch between light and dark">&#9788;</button></div>
  <div class="progress" id="prog"></div>
</div></div>
<aside class="rail" aria-label="Where you are"><span class="line"><span class="fill"></span></span>${nav.map(([id, label]) => `<a href="#${id}">${label}</a>`).join("")}</aside>
<div class="wrap">
${body}
</div>
<script>${PAGE_JS}${extraJs}</script>
</body>
</html>`;
}
