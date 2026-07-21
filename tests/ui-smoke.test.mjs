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
  documentElement: { setAttribute(){}, getAttribute: () => "dark", clientHeight: 900, clientWidth: 1400 },
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
  (0, eval)(src + `\n;globalThis.__t = { VIEWS, applySidebar, settingsMenu, openSettingsFrom, state };`);
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

console.log(`\n${fail ? "FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
