// UI smoke tests. These live in the REPO and run in CI on purpose — earlier versions lived in a
// scratchpad, got wiped, and the bugs below shipped.
//
// Three production faults of the same shape have now happened:
//   1. renderActivity deleted   -> whole app blank (module threw at load)
//   2. #navScrim had class="hidden" (display:none !important) while JS toggled .show
//                               -> mobile menu was a trap only a page reload escaped
//   3. INTEGRATION_META deleted -> Integrations silently dead for weeks
//
// #3 is the important lesson: `node --check` passed, the module loaded fine, and a test that
// only asserted "renderIntegrations is defined" passed too — because the missing constant is
// referenced INSIDE the function. Nothing catches that except actually CALLING it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PUB = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const src = readFileSync(join(PUB, "app.js"), "utf8");
const html = readFileSync(join(PUB, "index.html"), "utf8");
const css = readFileSync(join(PUB, "styles.css"), "utf8");

let pass = 0, fail = 0;
const check = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "  pass" : "  FAIL"}  ${n}${d && !c ? `  <- ${d}` : ""}`); };

// ---- minimal DOM ----
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const RECT = { top: 10, bottom: 34, left: 10, right: 40, width: 30, height: 24, x: 10, y: 10 };
const reg = new Map();
function mk(key = "") {
  const cls = new Set();
  return { key, _l: {}, dataset: {}, style: {}, value: "", _text: "", _html: "", _classes: cls,
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c),
      toggle: (c, f) => { const on = f === undefined ? !cls.has(c) : !!f; on ? cls.add(c) : cls.delete(c); return on; } },
    addEventListener(k, f) { (this._l[k] ||= []).push(f); },
    fire(k, ev = {}) { (this._l[k] || []).forEach(f => f({ stopPropagation(){}, preventDefault(){}, target: { closest: () => null }, ...ev })); },
    click() { this.fire("click"); },
    setAttribute(k, v) { this[`attr_${k}`] = v; }, removeAttribute(){},
    getAttribute(k) { return this[`attr_${k}`] ?? null; },
    querySelector: () => null, querySelectorAll: () => [],
    appendChild(){}, remove(){}, contains(){ return false; }, focus(){}, scrollIntoView(){},
    showModal(){}, close(){}, getBoundingClientRect: () => ({ ...RECT }),
    offsetHeight: 200, offsetWidth: 190,
    get textContent(){ return this._text; }, set textContent(v){ this._text = v; },
    get innerHTML(){ return this._html; },
    // Assigning innerHTML really does create those elements, so register their ids. Without
    // this, any view that renders markup and then wires handlers onto it fails in the harness
    // for a reason that has nothing to do with the app.
    set innerHTML(v){ this._html = v; for (const m of String(v).matchAll(/id="([^"]+)"/g)) ids.add(m[1]); } };
}
const get = k => { if (!reg.has(k)) reg.set(k, mk(k)); return reg.get(k); };

const navFilters = [...html.matchAll(/data-filter="([^"]+)"/g)].map(m => {
  const e = get(`f:${m[1]}`); e.dataset.filter = m[1]; e._text = m[1]; return e; });
const settingsItems = [...html.matchAll(/class="settings-item" data-view="([^"]+)"/g)].map(m => {
  const e = get(`s:${m[1]}`); e.dataset.view = m[1]; e._text = m[1]; return e; });
const navViews = [...html.matchAll(/class="nav-item" data-view="([^"]+)"/g)].map(m => {
  const e = get(`v:${m[1]}`); e.dataset.view = m[1]; e._text = m[1]; return e; });

globalThis.document = {
  querySelector: s => {
    if (s.startsWith("#")) return ids.has(s.slice(1)) ? get(s) : null;
    if (s === '.nav-item[data-filter="all"]') return get("f:all");
    if (s === ".nav-item[data-filter].active") return navFilters.find(n => n._classes.has("active")) || null;
    return get(s);
  },
  querySelectorAll: s => {
    if (s === ".settings-item[data-view]") return settingsItems;
    if (s.includes("data-filter") && s.includes("data-view")) return [...navFilters, ...navViews];
    if (s.includes("data-filter")) return navFilters;
    if (s.includes("data-view")) return navViews;
    return [];
  },
  addEventListener(){}, createElement: () => mk("new"),
  documentElement: { setAttribute(){}, getAttribute: () => "dark", clientHeight: 900, clientWidth: 1400,
    // Real CSS-variable plumbing: the pane resizer (TASK-091) writes sizes here, so a no-op
    // stub would make those assertions vacuous.
    style: { _p: {}, setProperty(k, v){ this._p[k] = String(v); }, getPropertyValue(k){ return this._p[k] || ""; },
             removeProperty(k){ delete this._p[k]; } } },
  body: get("body"), head: mk("head")
};
globalThis.window = { addEventListener(){}, location: { reload(){} }, innerHeight: 900, innerWidth: 1400 };
globalThis.innerHeight = 900; globalThis.innerWidth = 1400;
let store = {};
globalThis.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
globalThis.confirm = () => false; globalThis.alert = () => {};

// Per-endpoint payloads shaped like the real API. Returning ONE shared object for every
// endpoint looks simpler but is a trap: /calls wants `calls` to be an array while /insights
// wants `calls` to be a count, so a single literal silently loses one of them to the other.
const ROUTES = [
  [/^\/me/,          () => ({ user: { email: "a@b.c" }, build: "test" })],
  [/^\/accounts/,    () => ({ accounts: [{ id: 1, name: "OSA" }] })],
  [/^\/call-types/,  () => ({ call_types: [{ id: 1, name: "Sales call", is_default: 1, dimensions_json: '["rapport"]',
                                             prompt_body: "p", produces_messages: 1, produces_crm_note: 1 }] })],
  [/^\/calls\/\d+/,  () => ({ call: { id: 1, client_name: "Marcus", processed_at: null, processing_status: null,
                                      transcript: "t", occurred_at: "2026-07-19T10:00:00Z" }, outputs: [] })],
  [/^\/calls/,       () => ({ calls: [{ id: 1, client_name: "Marcus", account_name: "OSA",
                                        occurred_at: "2026-07-19T10:00:00Z", outcome: "followup",
                                        processed_at: "2026-07-19T10:05:00Z", processing_status: null, archived_at: null }],
                              hasMore: false, counts: { all_n: 1, followup_n: 1, closed_n: 0, archived_n: 0 } })],
  [/^\/integrations/,() => ({ integrations: [
                              { id: 1, account_name: "OSA", kind: "fathom", label: "Primary", has_secret: 1, owner_email: "g@x.com" },
                              { id: 2, account_name: "OSA", kind: "ghl", has_secret: 0 },
                              { id: 3, account_name: "OSA", kind: "anthropic", has_secret: 1 },
                              { id: 4, account_name: "OSA", kind: "openai", has_secret: 0 }] })],
  [/^\/templates/,   () => ({ templates: [] })],
  [/^\/model/,       () => ({ current: "claude-opus-5", default: "claude-opus-5",
                              models: { "claude-opus-5": { label: "Opus 5", tier: "Flagship", inPerM: 5, outPerM: 25, note: "n" },
                                        "claude-fable-5": { label: "Fable 5", tier: "Most capable", inPerM: 10, outPerM: 50, note: "n" } } })],
  [/^\/suggestions/, () => ({ suggestions: [] })],
  [/^\/insights/,    () => ({ scored: 1, calls: 1, averages: [["rapport", 8, 3]], hurt: ["x"], lessons: ["y"], types: [] })],
  [/^\/events/,      () => ({ events: [], totals: { runs: 2, failures: 0, input_tokens: 100, output_tokens: 50, avg_ms: 1000 },
                              today: { runs: 1, input_tokens: 10, output_tokens: 5 },
                              week:  { runs: 2, input_tokens: 100, output_tokens: 50 },
                              month: { runs: 2, input_tokens: 100, output_tokens: 50 } })]
];
globalThis.fetch = async (url) => {
  const path = String(url).replace(/^.*\/api/, "");
  const hit = ROUTES.find(([re]) => re.test(path));
  return { ok: true, status: 200, json: async () => (hit ? hit[1]() : {}) };
};

let bootErr = null;
try {
  (0, eval)(src + `\n;globalThis.__t = { VIEWS, applySidebar, settingsMenu, openSettingsFrom, state, renderProcessed, defaultOutputTab, OUTPUT_TABS, setPane, PANES, loadPanes, savePanes, RELEASES, releaseSig, unseenFrom };`);
} catch (e) { bootErr = e; }

console.log("\n== app.js loads ==");
check("executes to the end without throwing", !bootErr,
  bootErr ? `${bootErr.message}${(bootErr.stack || "").match(/<anonymous>:(\d+):/)?.[1] ? " (line " + bootErr.stack.match(/<anonymous>:(\d+):/)[1] + ")" : ""}` : "");
if (bootErr) { console.log(`\nFAILED — ${pass} passed, ${fail} failed\n`); process.exit(1); }
const T = globalThis.__t;

console.log("\n== every view actually RUNS (not merely 'is defined') ==");
// This is the assertion that would have caught INTEGRATION_META. A missing constant referenced
// inside a view is invisible to node --check, to module execution, and to a defined-ness check.
for (const [name, fn] of Object.entries(T.VIEWS)) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  check(`${name}() runs`, !err, err ? `${err.name}: ${err.message}` : "");
}

console.log("\n== every settings menu item maps to a real view ==");
for (const el of settingsItems) {
  check(`"${el.dataset.view}" has a VIEWS entry`, typeof T.VIEWS[el.dataset.view] === "function");
}

console.log("\n== settings stay reachable when the sidebar is hidden ==");
// The collapse used to hide the sidebar with opacity:0 + pointer-events:none while the settings
// menu was a CHILD of it — taking Integrations, Prompt Library, Activity, What's new, the theme
// toggle and Log out with it, with no other route in.
check("#settingsMenu is NOT nested inside .sidebar", (() => {
  // Walk div open/close tags from the sidebar's opening tag and track depth. If depth hits 0
  // (the sidebar closed) before we reach #settingsMenu, the menu is outside it. A naive
  // "slice between sidebar and call-list" check is wrong — it spans the gap between them,
  // which is exactly where the menu now lives.
  // Strip comments first (a commented-out <div> would throw the depth count off), then walk.
  // The id must be tested on the OPENING TAG itself: a separate `id="..."` alternative in the
  // regex never fires, because `<div\b[^>]*>` matches the whole tag and swallows the id with it.
  const clean = html.replace(/<!--[\s\S]*?-->/g, "");
  const start = clean.indexOf('<div class="sidebar">');
  if (start === -1) return false;
  let depth = 0;
  for (const m of clean.slice(start).matchAll(/<div\b[^>]*>|<\/div>/g)) {
    if (m[0] === "</div>") { if (--depth === 0) return true; }        // sidebar closed first => outside
    else { if (/id="settingsMenu"/.test(m[0])) return false; depth++; }
  }
  return true;
})(), "collapsing the sidebar would bury the whole settings menu again");
check("a compact account button exists in the list header", /id="userBtnMini"/.test(html));
check("it is shown only while collapsed", /body\.sb-collapsed \.user-btn-mini\{[^}]*display:inline-flex/.test(css));
check("...and hidden otherwise", /\.user-btn-mini\{[^}]*display:none/.test(css));
check("the menu is position:fixed so it escapes the collapsed column",
  /\.settings-menu\{[^}]*position:fixed/.test(css));

console.log("\n== the menu is always positioned on-screen ==");
// innerHeight can report 0 in embedded contexts; without a floor this flung the menu off-screen.
const menu = T.settingsMenu();
for (const [label, vh, vw] of [["normal viewport", 900, 1400], ["zero metrics", 0, 0], ["tiny viewport", 120, 200]]) {
  document.documentElement.clientHeight = vh; document.documentElement.clientWidth = vw;
  globalThis.innerHeight = vh; globalThis.innerWidth = vw;
  T.openSettingsFrom(get("#userBtnMini"));
  const top = parseInt(menu.style.top, 10), left = parseInt(menu.style.left, 10);
  check(`${label}: menu stays on-screen`, top >= 8 && left >= 8, `top=${top} left=${left}`);
}
document.documentElement.clientHeight = 900; document.documentElement.clientWidth = 1400;
globalThis.innerHeight = 900; globalThis.innerWidth = 1400;

console.log("\n== the mobile scrim can actually render ==");
const scrimTag = (html.match(/<div id="navScrim"[^>]*>/) || [""])[0];
check("#navScrim does not ship with the `hidden` class", !/\bhidden\b/.test(scrimTag), scrimTag);
check(".hidden really is display:none !important (so the above matters)",
  /\.hidden\{[^}]*display:none\s*!important/.test(css));

console.log("\n== mobile: nav items keep display:flex so counts don't collide with labels ==");
const mobileBlock = (css.match(/@media \(max-width:640px\)\{[\s\S]*?\n\}/) || [""])[0];
check("nav-item restored to flex, not `revert`", /\.sidebar \.nav-item\{\s*display:flex/.test(mobileBlock));
check("a desktop collapse cannot hide the mobile slide-over",
  /body\.sb-collapsed \.sidebar\{[^}]*opacity:1/.test(mobileBlock));

console.log("\n== outputs collapse to one pane at a time (TASK-088) ==");
// defaultOutputTab: opens on what Gabriel said he'd send.
check("email stated -> opens on Email",
  T.defaultOutputTab({ statedFollowUps: [{ channel: "email" }] }) === "email");
check("only text stated -> opens on Text",
  T.defaultOutputTab({ statedFollowUps: [{ channel: "text" }] }) === "text");
check("nothing stated -> defaults to Email", T.defaultOutputTab({}) === "email");
check("malformed statedFollowUps does not throw", T.defaultOutputTab({ statedFollowUps: "oops" }) === "email");
check("three output tabs: Text / Email / CRM Note",
  T.OUTPUT_TABS.map(t => t.key).join(",") === "text,email,ghl");

// Actually RENDER the processed detail and read the markup — the "render it and look" lesson,
// mechanised. FIRST with a LEGACY-shape debrief (flat string[], [label,score]): production has
// processed calls stored this way and the enriched renderers (TASK-089) must not crash on them.
const processedCall = {
  id: 1, client_name: "Marcus Webb", occurred_at: "2026-07-19T10:00:00Z", source: "fathom",
  duration_min: 30, outcome: "followup", call_type_id: 1, selected_tone: "balanced", suggested_tone: "balanced",
  debrief_json: JSON.stringify({ outcome: "followup", scorecard: [["rapport", 8]],
    statedFollowUps: [{ channel: "email", said: "I'll email you", contains: ["steps"] }],
    followUp: { nextStep: "call Thu" }, profile: ["p"] })
};
const processedOutputs = [
  { id: 11, kind: "sms", tone: "balanced", body: "hi" },
  { id: 12, kind: "email", tone: "balanced", subject: "s", body: "b" },
  { id: 13, kind: "ghl_note", body: "CLIENT\n- x" }
];
T.state.callTypes = [{ id: 1, name: "Sales call" }];
let renderErr = null;
try { T.renderProcessed(processedCall, processedOutputs); } catch (e) { renderErr = e; }
check("renderProcessed runs without throwing", !renderErr, renderErr ? `${renderErr.name}: ${renderErr.message}` : "");
const dpHtml = (document.querySelector("#detailPane") || {}).innerHTML || "";
check("all three output tabs are rendered", (dpHtml.match(/data-otab="(text|email|ghl)"/g) || []).length >= 6); // 3 chips + 3 panes
check("exactly one output pane is active at a time",
  (dpHtml.match(/class="opane active"/g) || []).length === 1,
  `${(dpHtml.match(/class="opane [^"]*active[^"]*"/g) || []).length} active panes`);
check("the active pane matches the stated channel (email)", /class="opane active" data-otab="email"/.test(dpHtml));
check("CSS hides inactive panes and shows the active one",
  /\.opane\{[^}]*display:none/.test(css) && /\.opane\.active\{[^}]*display:flex/.test(css));

console.log("\n== the ENRICHED debrief (TASK-089) renders its new structure ==");
const enrichedCall = {
  id: 2, client_name: "Brandon", occurred_at: "2026-07-19T10:00:00Z", source: "fathom",
  duration_min: 40, outcome: "followup", call_type_id: 1, selected_tone: "balanced", suggested_tone: "balanced",
  debrief_json: JSON.stringify({
    outcome: "followup",
    diagnosis: "A strong technical sale stalled at diligence.",
    outcomeSummary: "Verbal yes, payment pending contract.",
    scorecard: [["rapport", 8, "strong flow"], ["authority", 7, "some absolutes"]],
    overallScore: 7.7,
    didWell: [{ move: "opened with authority", why: "set the frame" }],
    hurtSale: [{ issue: "talked over the client", why: "cost trust", sayInstead: "ask, then stop" }],
    objections: [{ said: "I need to think", meant: "not sold", felt: "cornered", rootFear: "been burned", should: "ask x", follow: "ask y", loop: "z" }],
    profile: { dominantFears: ["abandonment"], valuesHierarchy: ["reliability", "price"], disc: "High D / High C",
      emotionalWound: "burned by vendors", trustTriggers: ["specificity"] },
    buyingSignals: { genuine: ["asked for ACH"], false: ["a polite yep"] },
    missedOpenings: [{ moment: "after he praised switching", askInstead: "would three environments cover it?" }],
    lessons: ["Precision is persuasion."],
    statedFollowUps: [{ channel: "text", said: "I'll text you", contains: [] }],
    followUp: { nextStep: "call Thu" }
  })
};
let richErr = null;
try { T.renderProcessed(enrichedCall, processedOutputs); } catch (e) { richErr = e; }
check("renderProcessed runs on the enriched shape without throwing", !richErr, richErr ? `${richErr.name}: ${richErr.message}` : "");
const richHtml = (document.querySelector("#detailPane") || {}).innerHTML || "";
check("executive diagnosis renders", /class="diag-eyebrow">Diagnosis/.test(richHtml) && richHtml.includes("stalled at diligence"));
check("overall score renders", /class="hl-tag hl-overall"/.test(richHtml) && richHtml.includes("7.7/10"));
check("per-dimension scorecard note renders", /class="sc-note">strong flow/.test(richHtml));
check("hurt-sale 'say instead' rewrite renders (the coaching, not just the critique)",
  /class="ri-fix-tag">Say instead<\/span>ask, then stop/.test(richHtml));
check("structured profile renders (values ranked + DISC)", /class="ranked"/.test(richHtml) && richHtml.includes("High D / High C"));
check("objection root fear renders", /Root fear<\/dt><dd>been burned/.test(richHtml));
check("missed-openings 'ask instead' renders", /class="ri-fix-tag">Ask instead/.test(richHtml));
check("adaptive default: only-text stated -> opens on Text", /class="opane active" data-otab="text"/.test(richHtml));
check("still exactly one output pane active on the enriched shape",
  (richHtml.match(/class="opane active"/g) || []).length === 1);

console.log("\n== draggable pane dividers (TASK-091) ==");
const css1 = css.replace(/\s+/g, " ");
const block = re => (css.match(re) || [""])[0].replace(/\s+/g, " ");
const rail900 = block(/@media \(max-width:900px\)\{[\s\S]*?\n\}/);
const mobile640 = block(/@media \(max-width:640px\)\{[\s\S]*?\n\}/);

// THE layout-breaking mistake this design exists to avoid: driving the drag by writing
// grid-template-columns inline from JS would outrank every media query and wreck both the
// ≤900px icon rail and the ≤640px single-column mobile layout.
check("column widths are variable-driven, not inline",
  /\.app\{ display:grid; grid-template-columns:var\(--w-sidebar, ?208px\) var\(--w-list, ?280px\)/.test(css1));
check("JS never writes grid-template-columns directly",
  !/style\.(gridTemplateColumns|setProperty\(\s*["']grid-template-columns)/.test(src),
  "an inline grid override would break the rail and mobile layouts");
check("the ≤900px icon rail ignores the drag variables", !/--w-sidebar/.test(rail900), rail900.slice(0, 90));
check("the ≤640px mobile layout ignores them too", !/--w-sidebar|--w-list/.test(mobile640));
check("handles are hidden below 900px where the columns are fixed", /\.resizer, \.resizer-h\{ display:none/.test(rail900));
check("collapsed sidebar keeps the dragged list width",
  /body\.sb-collapsed \.app\{ grid-template-columns:0 var\(--w-list/.test(css1));
check("debrief height is variable-driven", /\.debrief-body\{[^}]*height:var\(--h-debrief/.test(css1));
check("dragging suppresses the collapse transition (it would rubber-band the drag)",
  /body\.resizing \.app[^{]*\{ transition:none/.test(css1));
check("a keyboard nudge suppresses it too (a held arrow key would trail by .18s)",
  /body\.pane-nudge \.app\{ transition:none/.test(css1) && /pane-nudge/.test(src));
check("collapsed sidebar hides its own handle", /body\.sb-collapsed \.resizer\[data-resize="sidebar"\]\{ display:none/.test(css1));

check("two vertical handles exist in the shell", (html.match(/class="resizer" data-resize="(sidebar|list)"/g) || []).length === 2);
check("they use the ARIA splitter pattern (role=separator + tabindex)",
  (html.match(/role="separator"[^>]*tabindex="0"|tabindex="0"[^>]*role="separator"/g) || []).length >= 2);
check("the debrief/outputs handle is emitted by renderProcessed", /class="resizer-h" data-resize="debrief"/.test(richHtml));
check("handles declare touch-action:none so a touch drag doesn't scroll the page",
  /\.resizer\{[^}]*touch-action:none/.test(css1) && /\.resizer-h\{[^}]*touch-action:none/.test(css1));
check("drag uses pointer capture so a fast drag doesn't detach", /setPointerCapture/.test(src));

// Behaviour: clamping, persistence, reset.
const root = document.documentElement.style;
T.setPane("sidebar", 9999);
check("oversized drag clamps to the max", root.getPropertyValue("--w-sidebar") === `${T.PANES.sidebar.max}px`,
  root.getPropertyValue("--w-sidebar"));
T.setPane("sidebar", 10);
check("undersized drag clamps to the min", root.getPropertyValue("--w-sidebar") === `${T.PANES.sidebar.min}px`);
T.setPane("list", 380);
T.savePanes();
check("sizes persist to localStorage", JSON.parse(store["closer-panes"] || "{}").list === 380,
  store["closer-panes"]);
root.removeProperty("--w-list");
T.loadPanes();
check("...and are restored on the next load", root.getPropertyValue("--w-list") === "380px");
check("the debrief max is computed from the pane, not hardcoded", typeof T.PANES.debrief.max === "function");
check("every pane has a sane min", Object.values(T.PANES).every(p => (typeof p.min === "function" ? p.min() : p.min) >= 100));

console.log("\n== output panels don't repeat the tab label (TASK-092) ==");
// The tab chip immediately above the panel already says "Text Message"; the panel printed it
// again two lines below. Assert the label appears exactly once per output — as the chip.
// Labels come from OUTPUT_TABS rather than being retyped here, so the chip stays the single
// source of the visible label and this test can't drift from it.
for (const { key, label } of T.OUTPUT_TABS) {
  check(`the ${key} tab chip still carries its label ("${label}")`,
    new RegExp(`data-otab="${key}"[^>]*>\\s*${label}`, "i").test(richHtml));
}
check("no output panel prints a visible title of its own",
  !/class="panel-title"/.test(richHtml), "panel-title is back — that's the duplicate heading");
check("the textarea keeps its aria-label (a chip is not announced as the field's label)",
  (richHtml.match(/<textarea[^>]*aria-label="(Text Message|Email|GoHighLevel Note)"/g) || []).length === 3);
check("all three copy buttons survive the title removal",
  (richHtml.match(/class="copy-btn" data-out=/g) || []).length === 3);
check("both Mark-sent buttons survive it too",
  (richHtml.match(/class="sent-btn [^"]*" data-out=/g) || []).length === 2);

console.log("\n== the outputs row is ONE line, not two (TASK-093) ==");
// The header strip below the chips held nothing but two buttons. It looked like a bug and
// cost a full row of height on every call.
check("no panel-head strip is rendered at all",
  !/class="panel-head/.test(richHtml), "the second row is back");
check("actions live inside the tab strip",
  /class="panel-subnav"[\s\S]{0,900}?class="oacts/.test(richHtml));
check("one action set per tab", (richHtml.match(/class="oacts[^"]*" data-otab=/g) || []).length === 3);
check("exactly one action set is active", (richHtml.match(/class="oacts active"/g) || []).length === 1);
check("the active action set matches the active tab",
  (richHtml.match(/class="oacts active" data-otab="(\w+)"/) || [])[1] ===
  (richHtml.match(/class="chip active" data-otab="(\w+)"/) || [])[1]);
check("switching tabs also switches the action set",
  /querySelectorAll\("\.oacts"\)[\s\S]{0,120}dataset\.otab === k/.test(src),
  "tab switch would leave the wrong Copy button wired");
check("the CSS hides inactive action sets",
  /\.oacts\{[^}]*display:none/.test(css) && /\.oacts\.active\{[^}]*display:flex/.test(css));
check("the actions are pushed right by margin, not by space-between",
  /\.panel-actions\{[^}]*margin-left:auto/.test(css),
  "without margin-left:auto the buttons sit on the left of an otherwise empty row");

console.log("\n== release notes aggregate per day (TASK-092) ==");
const R = T.RELEASES;
check("every release is keyed by an ISO date", R.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.v)),
  R.map(r => r.v).join(", "));
const days = R.map(r => r.v);
check("no date has two entries — a day accumulates into one", new Set(days).size === days.length,
  days.join(", "));
check("releases are newest-first", days.every((d, i) => i === 0 || days[i - 1] > d), days.join(", "));
check("today's work is actually announced", R[0].v === "2026-07-29" && R[0].items.length >= 6,
  `${R[0].v}, ${R[0].items.length} items`);

// The core of the aggregation: an entry Gabriel has already read must re-open when that same day
// gains an item from a later push. Keying on `v` alone silently swallowed it.
const day = { v: "2026-07-30", date: "30 July 2026", title: "Two pushes", items: ["first push"] };
const older = { v: "2026-07-29", date: "29 July 2026", title: "Yesterday", items: ["old"] };
const seenAfterFirstPush = T.releaseSig(day);
check("a read entry stays quiet on the next visit",
  T.unseenFrom([day, older], seenAfterFirstPush).length === 0);
const grown = { ...day, items: ["first push", "second push"] };
const reopened = T.unseenFrom([grown, older], seenAfterFirstPush);
check("the same day re-opens once a later push appends to it", reopened.length === 1,
  `${reopened.length} notes`);
check("...and it carries the day's FULL list, not just the new item",
  reopened[0].items.length === 2 && reopened[0].items[0] === "first push",
  JSON.stringify(reopened[0]?.items));
// The direct proof that keying on `v` swallows an append: a browser that acknowledged the bare
// date would match the grown entry and be shown nothing. This is the assertion that fails if
// anyone "simplifies" unseenFrom back to `r.v === seen`.
check("...and re-opens even for a browser holding the bare date",
  T.unseenFrom([grown, older], "2026-07-30").length === 1,
  "a v-keyed match would swallow the second push's items");
check("the signature changes when items change", T.releaseSig(grown) !== seenAfterFirstPush);
check("the signature is stable for identical content", T.releaseSig({ ...grown }) === T.releaseSig(grown));
check("a browser holding a pre-signature value gets the latest, not the back catalogue",
  T.unseenFrom([grown, older], "2026.07.22").length === 1);
check("a brand-new browser sees only the latest day",
  T.unseenFrom([grown, older], null).length === 1);
const twoDays = T.unseenFrom([grown, older, { v: "2026-07-28", date: "d", title: "t", items: ["x"] }],
  T.releaseSig({ v: "2026-07-28", date: "d", title: "t", items: ["x"] }));
check("missing two days of notes shows both, newest first",
  twoDays.length === 2 && twoDays[0].v === "2026-07-30", twoDays.map(r => r.v).join(","));

console.log("\n== the model picker degrades instead of dying (TASK-098) ==");
check("the picker CSS exists", /\.mp-card\.on\{/.test(css));
check("a failed /model call is caught, not thrown",
  /api\.get\("\/model"\)\.catch/.test(src),
  "one endpoint hiccup would take down the whole Prompt Library");
check("the picker is skipped when models are unavailable", /\$\{!models \? "" :/.test(src));

console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
