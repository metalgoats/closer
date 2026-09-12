"use strict";

// ---------- tiny API client ----------
const api = {
  async req(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) { showAuth(); throw new Error("unauthorized"); }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  },
  get: p => api.req("GET", p),
  post: (p, b) => api.req("POST", p, b || {}),
  put: (p, b) => api.req("PUT", p, b || {}),
  del: p => api.req("DELETE", p),
  // Raw text body — for the usage-export CSV, which is text and would otherwise be
  // JSON-encoded into a single string the server then has to unwrap.
  async postText(path, text) {
    const res = await fetch(`/api${path}`, { method: "POST", headers: { "Content-Type": "text/csv" }, body: text });
    if (res.status === 401) { showAuth(); throw new Error("unauthorized"); }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  },
  patch: (p, b) => api.req("PATCH", p, b),
  put: (p, b) => api.req("PUT", p, b)
};

const $ = sel => document.querySelector(sel);
// The label to show for a call: its Fathom token's custom label (live), else the account name.
const offerLabel = c => c.source_label || c.account_name;
// One word, upper-case, so the kind of call reads at a glance from the right edge of the row.
const typeTag = c => (c.call_type_name || "").trim().split(/[\s/]+/)[0].toUpperCase();
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Traffic-light rules. Four states, three brand colours: grey stays neutral for
// "nothing has happened yet" so pink keeps meaning "something is wrong".
const STATE_LABEL = { new: "New", processing: "Working", processed: "Ready", failed: "Failed" };
const STATE_TITLE = {
  new: "Not generated yet — open it and hit Generate",
  processing: "Generating now — safe to navigate away",
  processed: "Ready — debrief, text, email and CRM note are done",
  failed: "Generation failed — open it to see why and retry"
};
function callState(c) {
  if (c.processing_status) return c.processing_status;
  return c.processed_at ? "processed" : "new";   // pre-migration rows
}

const state = {
  user: null, accounts: [], calls: [],
  filter: "all", accountFilter: null, search: "",
  currentCallId: null
};

// ---------- auth ----------
function showAuth() { $("#authView").classList.remove("hidden"); $("#mainView").classList.add("hidden"); }
function showMain() { $("#authView").classList.add("hidden"); $("#mainView").classList.remove("hidden"); }

$("#authForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;
  const msg = $("#authMsg");
  msg.textContent = "";
  try {
    try {
      state.user = (await api.post("/login", { email, password })).user;
    } catch {
      state.user = (await api.post("/setup", { email, password })).user; // first run
    }
    await boot();
  } catch (err) {
    msg.textContent = err.message === "unauthorized" ? "Invalid credentials." : err.message;
  }
});

$("#logoutBtn").addEventListener("click", async () => { await api.post("/logout"); location.reload(); });

// ---------- boot ----------
async function boot() {
  showMain();
  $("#userEmail").textContent = state.user.email;
  const initials = state.user.email.slice(0, 2).toUpperCase();
  $("#userAvatar").textContent = initials;
  if ($("#userAvatarMini")) $("#userAvatarMini").textContent = initials;
  // Hide what this role cannot reach (TASK-112). This is COSMETIC ONLY — the boundary is the
  // ADMIN_ONLY check in index.js. Hiding a menu item stops a member clicking into a 403; it is
  // not what stops them reading the data, and must never be mistaken for it.
  applyRoleVisibility();
  state.accounts = (await api.get("/accounts")).accounts;
  try { state.callTypes = (await api.get("/call-types")).call_types; } catch { state.callTypes = []; }
  renderAccountNav();
  await refreshCalls();
  if (state.calls.length) openCall(state.calls[0].id);
  else renderEmpty();
}

(async function init() {
  try {
    const me = await api.get("/me");
    state.user = me.user;
    state.buildId = me.build;   // remember the version this tab loaded (TASK-046)
    await boot();
    startVersionWatch();
    // After boot, never before — the notes must not appear over the sign-in screen.
    maybeShowReleaseNotes();
  }
  catch { /* showAuth already called on 401 */ }
})();

// A single-page app keeps running whatever JS it first loaded; after a deploy the open tab is
// silently stale (this cost real debugging time). Poll the build id and, when it changes, offer
// a reload rather than letting the user act on old code. 'dev' = local/manual deploy: no id to
// compare, so stay quiet.
function startVersionWatch() {
  if (!state.buildId || state.buildId === "dev") return;
  let notified = false;
  setInterval(async () => {
    if (notified) return;
    try {
      const { build } = await api.get("/me");
      if (build && build !== "dev" && build !== state.buildId) { notified = true; showUpdateBanner(); }
    } catch { /* transient — try again next tick */ }
  }, 60000);
}
function showUpdateBanner() {
  if ($("#updateBanner")) return;
  const bar = document.createElement("div");
  bar.id = "updateBanner";
  bar.className = "update-banner";
  bar.innerHTML = `A new version of Closer is available. <button id="updateReload">Reload</button>`;
  document.body.appendChild(bar);
  $("#updateReload").addEventListener("click", () => location.reload());
}

// ---------- release notes (TASK-077) ----------
// Ivan and Gabriel share one login, so "has this person read the notes" cannot live on the
// account row — one of them reading it would silence it for the other. It lives in localStorage,
// which is per-browser, so each of them gets it once on their own machine.
//
// Keyed on a hand-written version, NOT on BUILD_ID. BUILD_ID is the git SHA and changes on every
// deploy including typo fixes; a popup that fires for a one-line CSS change gets dismissed
// unread, and then the one that matters gets dismissed unread too. A release earns an entry here
// only when there is something worth a interruption.
//
// ONE ENTRY PER DAY, AND IT ACCUMULATES (TASK-092). `v` is the ISO date. Shipping again on a day
// that already has an entry means APPENDING to it — never add a second entry for the same date.
// Ivan pushes three or four times on a working day, and a note per push fails both ways: it either
// interrupts Gabriel three times for one day of work, or — what actually happened on 2026-07-29,
// where seven tasks shipped across four pushes and not one of them got a note — the later pushes
// skip it and the whole day goes unannounced. One dated entry that grows is the only shape where
// Gabriel reliably sees a day's full scope.
//
// Because a day's entry gets edited after Gabriel may already have read it, "seen" is tracked by a
// CONTENT SIGNATURE rather than by `v` (see `releaseSig`): appending an item changes the signature,
// so the note re-opens carrying the day's full list. That re-shows lines he has already read, on
// purpose — seeing the complete day beats seeing only its tail.
const RELEASES = [
  {
    v: "2026-08-05",
    date: "4–5 August 2026",
    title: "One follow-up written for the buyer, a chat that edits in place, and you can finally see what you select",
    items: [
      "The casual / balanced / formal switcher is gone. There is now ONE follow-up, written to how this specific buyer decides — what moved them, what stalled them, how they talked about the money, and whether someone else has a say. A short note above the debrief tells you why it reads the way it does.",
      "Chat with any processed call, right under the outputs. Ask what actually happened ('what did he really object to?') or ask for a change ('rewrite the email without the price') — it updates the draft in place, and the new text appears above the box.",
      "Selecting text inside the Text / Email / CRM fields is finally visible. You can highlight a phrase and replace just that, instead of Command-A and paste-over.",
      "While a call generates you now watch the analysis being written, live, instead of staring at a progress bar. Same three minutes, no more wondering whether it died.",
      "Generation is faster and cheaper: two model calls per run instead of four.",
      "Call type and tone controls are tucked behind a one-line summary in the header — click it to change them. The debrief and your outputs get the screen back.",
      "The Activity page now leads with health: how many runs succeeded, failed, or vanished in the last 30 days, and what generation actually costs — cached tokens included, priced at the model you actually run.",
      "The debrief and your three outputs now live in ONE row of tabs sharing the full height of the screen — no more split panes. The app opens straight on the output you said you'd send; the analysis is one click away. Copy / Mark sent appear only for the panel you're looking at."
    ]
  },
  {
    v: "2026-07-29",
    date: "29 July 2026",
    title: "The outputs, rebuilt",
    items: [
      "The debrief is much deeper. It now opens with an executive read of where the deal actually stands and the one issue that decided it, every scorecard line carries a note explaining the number, and every criticism ships the exact better wording to have used — not just what went wrong.",
      "Objections now show the root fear underneath what was said, the client profile is a real behavioural read (ranked values, trust triggers, decision speed, communication style), and a new Missed Openings page names the moments a question would have moved the call, with the question.",
      "The follow-up drafts are built from what you told the client on the call you would send. If you promised a breakdown and two links, that's what gets drafted.",
      "The text message is never skipped any more — even on an email-only call you get a warm, send-worthy text sitting there ready.",
      "Drafts are now shaped to the person receiving them: analytical buyers get the structured, itemised version, relational buyers get a short warm note.",
      "The CRM note was rebuilt into eleven scannable sections — goals, pain points, objections, selling points, what to watch for, follow-up tasks, retention risk, upsell, personal rapport — so anyone on the team can act on it cold.",
      "Text / Email / CRM Note now share one switcher and show one at a time, instead of three panes fighting for the screen. The app opens on whichever one you said you'd send.",
      "You can drag the dividers between the sidebar, the call list, the detail pane and the debrief to resize them, like Apple Mail. Double-click a divider to put it back, and your sizes are remembered."
    ]
  },
  {
    v: "2026-07-22",
    date: "22 July 2026",
    title: "Fixes: hidden sidebar locked you out, Integrations was dead",
    items: [
      "Fixed: hiding the sidebar also hid the only way into Integrations, Prompt Library, Activity, What's new, the theme toggle and Log out — they all lived inside it. There's now an account button in the header whenever the sidebar is hidden.",
      "Fixed: Integrations had been silently broken for weeks — clicking it did nothing at all. Two constants it depended on were deleted by accident in an earlier release.",
      "Your call imports were never affected: Fathom kept importing throughout."
    ]
  },
  {
    v: "2026-07-21",
    date: "21 July 2026",
    title: "Sidebar counts and new-call marks",
    items: [
      "The sidebar now shows live counts for All Calls, Needs Follow-up, Closed and Archived — real totals from the server, not just what's loaded on screen.",
      "Calls that arrived since you last looked are marked with a violet bar and counted in a badge on All Calls. Opening a call clears its mark, like unread mail.",
      "The marks are per-browser, so you and Gabriel each track your own — one of you reading a call doesn't clear it for the other."
    ]
  },
  {
    v: "2026-07-20",
    date: "20 July 2026",
    title: "CloserAI, a collapsible sidebar, and the mobile menu escape",
    items: [
      "The app is now CloserAI. Clicking the name or the gradient mark takes you back to All Calls from anywhere.",
      "Fixed: on a phone, opening the menu used to trap you — the dimmed area behind it was never actually clickable, so a page reload was the only way out. It now closes by tapping outside it, the new X, the app name, the main content, or Escape.",
      "The sidebar hides and shows from the button next to the list title, and remembers your choice per browser.",
      "The sidebar is now an inset rounded panel in the macOS style."
    ]
  },
  {
    v: "2026-07-19",
    date: "19 July 2026",
    title: "Spend windows and release notes",
    items: [
      "Activity now shows spend for Today, Last 7 days, This month and All time — not just this month.",
      "Anthropic has no API for your credit balance, so that number still only exists in the Anthropic console. The Activity footnote now says so plainly instead of implying our estimate is the real bill.",
      "This box. It appears once per browser after an update, so you and Gabriel each see it on your own machine. Re-open it any time from the profile menu → What's new."
    ]
  }
];
const RELEASE_KEY = "closer-seen-release";

// The identity of a release as its reader experiences it: the date PLUS its current items. Keying
// "seen" on `v` alone would mean a day's entry could never re-open after Gabriel read it, so any
// item appended by a later push that same day would be silently swallowed — the exact failure this
// aggregation exists to fix.
function releaseSig(r) {
  const s = `${r.v}|${(r.items || []).join("|")}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${r.v}#${(h >>> 0).toString(36)}`;
}

// Pure so it can be tested without a browser: given the release list (newest first) and the
// signature this browser last acknowledged, which notes should pop?
function unseenFrom(list, seen) {
  if (!list.length) return [];
  if (!seen) return list.slice(0, 1);              // new browser: latest only, not the back catalogue
  const i = list.findIndex(r => releaseSig(r) === seen);
  // No match means one of two things: a browser holding a pre-signature value, or — the case that
  // matters — today's entry grew since it was read, so nothing in the list carries that signature
  // any more. Both want the newest entry, which is the day's complete list.
  return i === -1 ? list.slice(0, 1) : list.slice(0, i);   // everything since they last looked
}
function unseenReleases() {
  let seen = null;
  try { seen = localStorage.getItem(RELEASE_KEY); } catch { /* private mode — just show it */ }
  return unseenFrom(RELEASES, seen);
}
function markReleasesSeen() {
  if (!RELEASES.length) return;
  try { localStorage.setItem(RELEASE_KEY, releaseSig(RELEASES[0])); } catch {}
}

function showReleaseNotes(list) {
  if (!list.length || $("#releaseDlg")) return;
  const dlg = document.createElement("dialog");
  dlg.id = "releaseDlg";
  dlg.className = "release-dlg";
  dlg.innerHTML = `
    <div class="release-head">
      <div>
        <div class="release-eyebrow">What's new</div>
        <div class="release-title">${esc(list[0].title)}</div>
      </div>
      <button class="release-x" id="releaseX" aria-label="Close">&times;</button>
    </div>
    <div class="release-body">
      ${list.map(r => `<div class="release-block">
          <div class="release-v">${esc(r.date)}${list.length > 1 ? ` · ${esc(r.title)}` : ""}</div>
          <ul>${r.items.map(i => `<li>${esc(i)}</li>`).join("")}</ul>
        </div>`).join("")}
    </div>
    <div class="release-foot"><button class="primary-btn" id="releaseOk">Got it</button></div>`;
  document.body.appendChild(dlg);

  // Mark seen on close however it closes — button, X, or Escape. Doing it only on the button
  // would mean an Escape press re-pops the same notes on the next refresh, forever.
  dlg.addEventListener("close", () => { markReleasesSeen(); dlg.remove(); });
  $("#releaseOk").addEventListener("click", () => dlg.close());
  $("#releaseX").addEventListener("click", () => dlg.close());
  dlg.showModal();
}

function maybeShowReleaseNotes() { showReleaseNotes(unseenReleases()); }

// ---------- sidebar ----------
function renderAccountNav() {
  const nav = $("#accountNav");

  // With a single account, "All Accounts" vs "OSA" is a distinction without a difference, so
  // the whole group is hidden. Nothing else changes: accountFilter stays null (= all), and the
  // filtering below still works — add a second account and this reappears on its own.
  const multi = state.accounts.length > 1;
  $("#accountGroup").classList.toggle("hidden", !multi);
  if (!multi) { state.accountFilter = null; nav.innerHTML = ""; return; }

  nav.innerHTML = [
    `<div class="nav-item ${state.accountFilter === null ? "active" : ""}" data-account="">All Accounts</div>`,
    ...state.accounts.map(a =>
      `<div class="nav-item ${state.accountFilter === a.id ? "active" : ""}" data-account="${a.id}">${esc(a.name)}</div>`)
  ].join("");
  nav.querySelectorAll(".nav-item").forEach(el => el.addEventListener("click", async () => {
    state.accountFilter = el.dataset.account ? +el.dataset.account : null;
    renderAccountNav();
    await refreshCalls();
    showCallsView(); // picking an account returns you to the calls view, not a stale workspace page
    showListMobile();
  }));
}

// Open the current call if it's still visible, else the first visible call, else the empty state.
function openRelevantCall() {
  const vis = visibleCalls();
  if (vis.some(c => c.id === state.currentCallId)) openCall(state.currentCallId);
  else if (vis.length) openCall(vis[0].id);
  else renderEmpty();
}

// Return the detail pane to the calls context: drop any workspace-view highlight,
// make sure a call filter is active, and open a relevant call (or the empty state).
function showCallsView() {
  document.body.classList.remove("workspace");
  document.querySelectorAll(".nav-item[data-view]").forEach(n => n.classList.remove("active"));
  if (!document.querySelector(".nav-item[data-filter].active")) {
    const allFilter = document.querySelector('.nav-item[data-filter="all"]');
    if (allFilter) allFilter.classList.add("active");
    state.filter = "all";
    $("#listTitle").textContent = "All Calls";
  }
  openRelevantCall();
}

document.querySelectorAll(".nav-item[data-filter]").forEach(el => {
  el.addEventListener("click", () => {
    document.querySelectorAll(".nav-item[data-filter], .nav-item[data-view]").forEach(n => n.classList.remove("active"));
    el.classList.add("active");
    showListMobile();
    const prev = state.filter;
    state.filter = el.dataset.filter;
    $("#listTitle").textContent = el.textContent.replace(/\d+$/, "").trim();
    // Crossing the archived boundary changes WHICH rows the server returns, so refetch.
    if ((prev === "archived") !== (state.filter === "archived")) {
      refreshCalls().then(openRelevantCall);
    } else {
      renderCallList();
      openRelevantCall(); // also refresh the detail pane so we leave any workspace view
    }
  });
});

const VIEWS = { insights: renderInsights, suggestions: renderSuggestions, templates: renderTemplates, integrations: renderIntegrations, activity: renderActivity, spend: renderSpend, access: renderAccess, people: renderPeople, billing: renderBilling };

// Mirrors ADMIN_ONLY in src/index.js. Kept as a named constant next to the thing it hides so a
// future page added to one list is visibly missing from the other.
const ADMIN_VIEWS = ["spend", "integrations", "people", "billing"];
function isAdmin() { return state.user?.role === "admin"; }
function applyRoleVisibility() {
  document.querySelectorAll(".settings-item[data-view]").forEach(el => {
    if (ADMIN_VIEWS.includes(el.dataset.view)) el.classList.toggle("hidden", !isAdmin());
  });
}
document.querySelectorAll(".nav-item[data-view]").forEach(el => {
  el.addEventListener("click", () => {
    document.querySelectorAll(".nav-item[data-filter], .nav-item[data-view]").forEach(n => n.classList.remove("active"));
    el.classList.add("active");
    VIEWS[el.dataset.view]();
    showDetailMobile(el.textContent.trim());
  });
});

// ---------- theme (TASK-066) ----------
// Dark stays the default — Gabriel works in dark and finds it easier on the eyes. Light exists
// because customers will expect it. Stored per browser.
function applyTheme(mode) {
  document.documentElement.setAttribute("data-theme", mode);
  try { localStorage.setItem("closer-theme", mode); } catch {}
  const btn = $("#themeToggle");
  if (btn) btn.textContent = mode === "light" ? "Dark mode" : "Light mode";
}
(function initTheme() {
  let saved = "dark";
  try { saved = localStorage.getItem("closer-theme") || "dark"; } catch {}
  applyTheme(saved);
})();

// ---------- settings menu ----------
// Activity / Templates / Integrations are setup-and-forget, so they live behind the profile
// rather than taking up permanent nav space in the nightly loop.
const settingsMenu = () => $("#settingsMenu");
const settingsTriggers = () => [$("#userBtn"), $("#userBtnMini")].filter(Boolean);
function closeSettings() {
  settingsMenu().classList.add("hidden");
  settingsTriggers().forEach(b => b.setAttribute("aria-expanded", "false"));
}
// The menu is a sibling of the sidebar, so it must be positioned against whichever button
// opened it. Anchored above the trigger when there is room, below it otherwise, and always
// clamped into the viewport so it cannot end up off-screen.
function openSettingsFrom(trigger) {
  const menu = settingsMenu();
  menu.classList.remove("hidden");
  // clientHeight/Width first: innerHeight can report 0 in embedded/automated contexts, and a
  // bad viewport number must not be able to fling the menu off-screen. Every branch below is
  // floored at 8px so the menu is always reachable no matter what the metrics say.
  const vh = document.documentElement.clientHeight || window.innerHeight || 0;
  const vw = document.documentElement.clientWidth || window.innerWidth || 0;
  const t = trigger.getBoundingClientRect();
  const h = menu.offsetHeight, w = menu.offsetWidth;
  const above = t.top - h - 6;
  let top = above >= 8 ? above : t.bottom + 6;
  if (vh) top = Math.min(top, vh - h - 8);
  top = Math.max(8, top);
  let left = t.left;
  if (vw) left = Math.min(left, vw - w - 8);
  left = Math.max(8, left);
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  trigger.setAttribute("aria-expanded", "true");
}
for (const sel of ["#userBtn", "#userBtnMini"]) {
  $(sel)?.addEventListener("click", e => {
    e.stopPropagation();   // stops the document handler below from closing it immediately
    if (settingsMenu().classList.contains("hidden")) openSettingsFrom($(sel));
    else closeSettings();
  });
}
document.addEventListener("click", e => {
  if (!settingsMenu().contains(e.target)) closeSettings();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSettings(); });
$("#whatsNewBtn")?.addEventListener("click", e => {
  e.stopPropagation();
  closeSettings();
  showReleaseNotes(RELEASES.slice(0, 5));   // on demand: recent history, not just the unseen ones
});
$("#themeToggle")?.addEventListener("click", e => {
  e.stopPropagation();
  applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
});
document.querySelectorAll(".settings-item[data-view]").forEach(el => {
  el.addEventListener("click", () => {
    closeSettings();
    // These are not call filters, so clear the call-nav highlight rather than leaving a
    // filter looking active while a workspace view is open.
    document.querySelectorAll(".nav-item[data-filter], .nav-item[data-view]").forEach(n => n.classList.remove("active"));
    VIEWS[el.dataset.view]();
    showDetailMobile(el.textContent.trim());
  });
});

let searchTimer;
$("#searchInput").addEventListener("input", e => {
  state.search = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refreshCalls().then(() => { if (!state.search) openRelevantCall(); }), 250);
});
// Lives inside the profile menu now, so it must stop the click bubbling (the document handler
// closes the menu) and close the menu itself once it has opened the composer.
$("#newCallBtn").addEventListener("click", e => {
  e.stopPropagation();
  closeSettings();
  renderCompose();
  showDetailMobile("New Call");
});

// ---------- call list ----------
async function refreshCalls({ append = false } = {}) {
  const q = [];
  if (state.accountFilter) q.push(`account=${state.accountFilter}`);
  if (state.filter === "archived") q.push("archived=1");
  // Search runs SERVER-side so it reaches transcripts and isn't limited to the loaded page.
  if (state.search) q.push(`q=${encodeURIComponent(state.search)}`);
  q.push(`offset=${append ? (state.calls?.length || 0) : 0}`);
  const r = await api.get(`/calls${q.length ? "?" + q.join("&") : ""}`);
  state.calls = append ? [...state.calls, ...r.calls] : r.calls;
  state.hasMore = r.hasMore;
  if (r.counts) state.counts = r.counts;
  seedSeenCalls();          // no-op after the first run on this browser
  renderCallList();
  renderNavCounts();
  syncPolling();
}

// ---------- "arrived since I last looked" (TASK-079) ----------
// Same constraint as the release notes: you and Gabriel share one login, so read-state cannot
// live on the account row — you opening a call would clear Gabriel's badge. It is per-browser.
// Semantics are unread-email: a call stays new until it is opened on THIS machine.
const SEEN_CALLS_KEY = "closer-seen-calls";
const SEEN_CAP = 500;
let seenCalls;   // undefined = not read from storage yet; null = storage has no record

function loadSeenCalls() {
  if (seenCalls !== undefined) return seenCalls;
  let raw = null;
  try { raw = localStorage.getItem(SEEN_CALLS_KEY); } catch { /* private mode */ }
  if (!raw) return (seenCalls = null);
  try {
    const ids = JSON.parse(raw).filter(n => Number.isInteger(n));
    seenCalls = { ids: new Set(ids), floor: ids.length ? Math.min(...ids) : 0 };
  } catch { seenCalls = { ids: new Set(), floor: 0 }; }
  return seenCalls;
}
function persistSeenCalls(ids) {
  // Keep only the newest SEEN_CAP ids so this can't grow without bound. `floor` then lets
  // isNewCall treat anything older than what we still remember as already read — without it,
  // pruning would make ancient calls light up as new again.
  const kept = [...new Set(ids)].sort((a, b) => b - a).slice(0, SEEN_CAP);
  seenCalls = { ids: new Set(kept), floor: kept.length ? Math.min(...kept) : 0 };
  try { localStorage.setItem(SEEN_CALLS_KEY, JSON.stringify(kept)); } catch {}
}
// First run on a browser: adopt everything already on screen as read. Otherwise the entire
// back catalogue lights up as "new", which is noise, not signal.
function seedSeenCalls() {
  if (loadSeenCalls()) return;
  persistSeenCalls((state.calls || []).map(c => c.id));
}
function markCallSeen(id) {
  const s = loadSeenCalls();
  if (!s) return;                    // pre-seed; seedSeenCalls will adopt it
  if (s.ids.has(id)) return;
  persistSeenCalls([...s.ids, id]);
}
function isNewCall(c) {
  const s = loadSeenCalls();
  if (!s) return false;              // nothing is "new" until we have a baseline
  if (s.ids.has(c.id)) return false;
  return c.id > s.floor;             // older than what we remember => treat as already read
}
function newCallCount() {
  return (state.calls || []).filter(c => !c.archived_at && isNewCall(c)).length;
}

// ---------- sidebar counts ----------
// Totals come from the server (see /api/calls), because the loaded page is capped and excludes
// archived rows — counting what the browser holds would quietly undercount.
function renderNavCounts() {
  const c = state.counts || {};
  const set = (sel, n) => { const el = $(sel); if (el) el.textContent = Number.isFinite(n) ? String(n) : ""; };
  set("#countAll", c.all_n);
  set("#countFollowup", c.followup_n);
  set("#countClosed", c.closed_n);
  set("#countArchived", c.archived_n);
  const n = newCallCount();
  const badge = $("#newBadge");
  if (badge) badge.textContent = n ? String(n) : "";   // :empty hides it — no class to desync
}

function visibleCalls() {
  return state.calls.filter(c => {
    // 'archived' is applied by the server (state.calls already holds only archived rows),
    // so it needs no outcome filter here.
    if (state.filter === "followup" && c.outcome !== "followup") return false;
    if (state.filter === "closed" && c.outcome !== "closed") return false;
    return true;
  });
}

// While anything is generating, refresh so the dot flips without a manual reload.
let pollTimer = null;
let elapsedTimer = null;
function syncPolling() {
  const anyWorking = state.calls.some(c => callState(c) === "processing");
  if (anyWorking && !pollTimer) {
    pollTimer = setInterval(async () => {
      await refreshCalls();
      const cur = state.currentCallId && state.calls.find(c => c.id === state.currentCallId);
      if (cur && callState(cur) === "processing") {
        // Fetch the single open call for its progress and streaming preview. The list endpoint
        // deliberately does not carry the preview — 900 characters per row across a full page
        // would bloat every poll to show text for one call nobody is looking at.
        try { patchWorking((await api.get(`/calls/${cur.id}`)).call); } catch { /* next tick */ }
      } else if (state.currentCallId && cur && callState(cur) !== "processing") {
        openCall(state.currentCallId);
      }
    }, 2500);
  } else if (!anyWorking && pollTimer) {
    clearInterval(pollTimer); pollTimer = null;
  }
}

function renderCallList() {
  const wrap = $("#callScroll");
  wrap.innerHTML = visibleCalls().map(c => {
    const st = callState(c);
    // No pill for "new". The hollow dot beside the name already says "not run yet", and a pill
    // reading NEW collided with the violet "arrived since you last looked" marker — two
    // different meanings of new on the same row. Working/Failed keep theirs: those are events,
    // not a resting state, and you want them to shout.
    const pill = st === "new" ? ""
      : st !== "processed" ? `<span class="pill pill-${st === "failed" ? "failed" : "new"}">${STATE_LABEL[st]}</span>`
      : c.outcome === "closed" ? `<span class="pill pill-closed">Closed</span>`
      : `<span class="pill pill-followup">Follow-up</span>`;
    const flags = [];
    if (c.sms_sent) flags.push("✓ text");
    if (c.email_sent) flags.push("✓ email");
    return `<div class="call-item ${c.id === state.currentCallId ? "active" : ""} ${state.selected?.has(c.id) ? "picked" : ""} ${isNewCall(c) ? "is-new" : ""}" data-id="${c.id}" tabindex="0" role="button">
      <input type="checkbox" class="call-pick" data-pickid="${c.id}" ${state.selected?.has(c.id) ? "checked" : ""} aria-label="Select ${esc(c.client_name)}">
      <div class="call-row1"><span class="call-name"><span class="dot-${st}" title="${STATE_TITLE[st]}"></span>${esc(c.client_name)}</span><span class="call-time">${fmtTime(c.occurred_at)}</span></div>
      <div class="call-meta">${pill}${c.attendee_name && c.attendee_name !== c.client_name ? `<span class="attendee-tag" title="External attendee">${esc(c.attendee_name)}</span>` : ""}<span class="offer-tag">${esc(offerLabel(c))}</span>${flags.length ? `<span class="sent-flags">${flags.join(" · ")}</span>` : ""}${c.duplicate_of ? `<span class="dup-tag" title="Possible duplicate of call #${c.duplicate_of}">dup?</span>` : ""}${c.call_type_name ? `<span class="type-tag">${esc(typeTag(c))}</span>` : ""}</div>
    </div>`;
  }).join("") || `<div style="padding:20px 16px; font-size:12px; color:var(--ink-400);">No calls match.</div>`;
  if (state.hasMore) {
    const more = document.createElement("button");
    more.className = "load-more"; more.textContent = "Load more";
    more.addEventListener("click", () => refreshCalls({ append: true }));
    wrap.appendChild(more);
  }

  wrap.querySelectorAll(".call-pick").forEach(cb => cb.addEventListener("click", e => {
    e.stopPropagation();                       // selecting must not open the call
    const id = +cb.dataset.pickid;
    state.selected = state.selected || new Set();
    cb.checked ? state.selected.add(id) : state.selected.delete(id);
    cb.closest(".call-item").classList.toggle("picked", cb.checked);
    renderBulkBar();
  }));

  wrap.querySelectorAll(".call-item").forEach(el => {
    const open = () => { const c = state.calls.find(x => x.id === +el.dataset.id); showDetailMobile(c?.client_name); openCall(+el.dataset.id); };
    el.addEventListener("click", open);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

// ---------- bulk actions ----------
// Colleague calls and duplicates arrive in batches; clearing them one at a time is the kind of
// chore that stops getting done.
function renderBulkBar() {
  const n = state.selected?.size || 0;
  let bar = $("#bulkBar");
  if (!n) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "bulkBar"; bar.className = "bulk-bar";
    document.body.appendChild(bar);
  }
  bar.innerHTML = `<span class="bulk-count">${n} selected</span>
    <select id="bulkType"><option value="">Set type…</option>${(state.callTypes || [])
      .map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select>
    <button class="regen-btn" id="bulkArchive">Archive</button>
    <button class="regen-btn danger-btn" id="bulkDelete">Delete</button>
    <button class="regen-btn" id="bulkClear">Cancel</button>`;

  $("#bulkClear").addEventListener("click", () => { state.selected.clear(); renderCallList(); renderBulkBar(); });
  $("#bulkType").addEventListener("change", async e => {
    const id = e.target.value; if (!id) return;
    const ids = [...state.selected];
    for (const cid of ids) await api.patch(`/calls/${cid}`, { call_type_id: +id });
    toast(`Re-labelled ${ids.length} call${ids.length > 1 ? "s" : ""}`);
    state.selected.clear(); await refreshCalls(); renderBulkBar();
  });
  $("#bulkArchive").addEventListener("click", async () => {
    const ids = [...state.selected];
    for (const cid of ids) await api.post(`/calls/${cid}/archive`, { archived: true });
    toast(`Archived ${ids.length}`);
    state.selected.clear(); await refreshCalls(); renderBulkBar(); openRelevantCall();
  });
  $("#bulkDelete").addEventListener("click", async () => {
    const ids = [...state.selected];
    if (!confirm(`Permanently delete ${ids.length} call${ids.length > 1 ? "s" : ""}?\n\nThis erases their transcripts and outputs and cannot be undone.`)) return;
    let failed = 0;
    for (const cid of ids) { try { await api.req("DELETE", `/calls/${cid}`); } catch { failed++; } }
    toast(failed ? `Deleted ${ids.length - failed}, ${failed} refused (still generating)` : `Deleted ${ids.length}`);
    state.selected.clear(); await refreshCalls(); renderBulkBar(); openRelevantCall();
  });
}

// ---------- mobile navigation ----------
// On phones the shell shows the list OR the detail, not both. `body.m-detail` is the switch;
// CSS keys off it. On desktop these calls are harmless no-ops (the class controls nothing).
function showDetailMobile(title) {
  document.body.classList.add("m-detail");
  if (title) $("#mTitle").textContent = title;
  closeMobileNav();
}
function showListMobile() {
  document.body.classList.remove("m-detail");
  $("#mTitle").textContent = "CloserAI";
  closeMobileNav();   // picking a filter from the slide-over should also close it
}
function closeMobileNav() {
  document.querySelector(".sidebar")?.classList.remove("open");
  $("#navScrim")?.classList.remove("show");
}
$("#listNavBtn")?.addEventListener("click", () => {
  // Same slide-over as the phone's ☰ — one nav idiom below 900px.
  const open = !$(".sidebar").classList.contains("open");
  $(".sidebar").classList.toggle("open", open);
  $("#navScrim").classList.toggle("show", open);
});
$("#mNavBtn")?.addEventListener("click", () => {
  const sb = document.querySelector(".sidebar");
  const open = sb.classList.toggle("open");
  $("#navScrim").classList.toggle("show", open);
});
$("#mBackBtn")?.addEventListener("click", showListMobile);

// Getting OUT of the slide-over needs more than one route. The scrim was the only way out and
// it is a bare <div>: iOS Safari does not reliably fire `click` on non-interactive elements
// (the fix is cursor:pointer, applied in the CSS), so on an iPhone the menu became a trap that
// only a page refresh escaped. Belt and braces now — scrim tap, an explicit X, the app name,
// Escape, and any tap on the main content all close it.
$("#navScrim")?.addEventListener("click", closeMobileNav);
$("#navScrim")?.addEventListener("touchstart", closeMobileNav, { passive: true });
$("#sbCloseBtn")?.addEventListener("click", closeMobileNav);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeMobileNav(); });
// A tap anywhere in the list or detail pane dismisses the slide-over instead of acting on
// whatever was underneath it. Capture phase so it wins before row/button handlers run.
for (const sel of [".call-list", ".detail", ".mobile-bar"]) {
  document.querySelector(sel)?.addEventListener("click", e => {
    if (!document.querySelector(".sidebar")?.classList.contains("open")) return;
    if (e.target.closest("#mNavBtn")) return;   // the toggle must still be able to open it
    e.stopPropagation(); e.preventDefault();
    closeMobileNav();
  }, true);
}

// The app name / gradient mark is Home: back to All Calls, and on a phone it also puts the
// slide-over away — which is what you reach for when you want out.
$("#brandBtn")?.addEventListener("click", () => {
  closeMobileNav();
  // Drive the real All Calls nav item rather than reimplementing "go home": that path already
  // handles the archived-boundary refetch, the list title, and the active highlight. Calling
  // showCallsView() directly would leave you on Closed, because it only picks a filter when
  // none is active.
  const all = document.querySelector('.nav-item[data-filter="all"]');
  if (all) all.click();
  else { showListMobile(); showCallsView(); }
});

// ---------- sidebar collapse (desktop) ----------
// Persisted per browser, like the theme. Mobile has its own slide-over and ignores this.
const SIDEBAR_KEY = "closer-sidebar-collapsed";
function applySidebar(collapsed) {
  document.body.classList.toggle("sb-collapsed", collapsed);
  const b = $("#sbToggle");
  if (b) {
    b.setAttribute("aria-label", collapsed ? "Show sidebar" : "Hide sidebar");
    b.setAttribute("title", collapsed ? "Show sidebar" : "Hide sidebar");
  }
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0"); } catch {}
}
(function initSidebar() {
  let saved = "0";
  try { saved = localStorage.getItem(SIDEBAR_KEY) || "0"; } catch {}
  applySidebar(saved === "1");
})();
$("#sbToggle")?.addEventListener("click", () => {
  applySidebar(!document.body.classList.contains("sb-collapsed"));
});

// ---------- draggable panes (TASK-091) ----------
// Apple Mail behaviour: drag a boundary to resize, double-click it to reset, arrow keys to nudge.
// Sizes are written to CSS VARIABLES on :root, never as inline grid-template-columns — inline
// styles would outrank the ≤900px icon-rail and ≤640px mobile rules and wreck both layouts.
// Persisted per browser, like the theme and the collapse state, because Ivan and Gabriel share
// one login and one person's preferred widths are not the other's.
const PANES_KEY = "closer-panes";
// Each pane MEASURES the quantity its variable actually controls — the grid COLUMN, which is
// not the same as the pane element's width: .sidebar carries an 8px left margin, so measuring
// the element made the boundary lag the cursor by 8px on every sidebar drag. Measuring the
// boundary positions keeps the divider exactly under the pointer.
const rectOf = sel => document.querySelector(sel)?.getBoundingClientRect() || null;
const PANES = {
  sidebar: { prop: "--w-sidebar", axis: "x", min: 150, max: 460,
             measure: () => { const a = rectOf(".app"), s = rectOf(".sidebar"); return a && s ? s.right - a.left : null; } },
  list:    { prop: "--w-list",    axis: "x", min: 200, max: 640,
             measure: () => { const s = rectOf(".sidebar"), l = rectOf(".call-list"); return s && l ? l.right - s.right : null; } },
};
// The `debrief` pane entry was removed 2026-08-05: the unified section made the
// debrief|outputs divider meaningless — one panel shows at a time, at full height.
const paneBound = v => (typeof v === "function" ? v() : v);
const paneSize = spec => spec.measure();

function loadPanes() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PANES_KEY) || "{}") || {}; } catch { /* private mode */ }
  for (const [key, spec] of Object.entries(PANES)) {
    const v = saved[key];
    if (Number.isFinite(v)) document.documentElement.style.setProperty(spec.prop, `${v}px`);
  }
}
function savePanes() {
  const out = {};
  for (const [key, spec] of Object.entries(PANES)) {
    const v = parseFloat(document.documentElement.style.getPropertyValue(spec.prop));
    if (Number.isFinite(v)) out[key] = Math.round(v);
  }
  try { localStorage.setItem(PANES_KEY, JSON.stringify(out)); } catch {}
}
function setPane(key, px) {
  const spec = PANES[key];
  const v = Math.round(Math.max(paneBound(spec.min), Math.min(paneBound(spec.max), px)));
  document.documentElement.style.setProperty(spec.prop, `${v}px`);
  document.querySelectorAll(`[data-resize="${key}"]`).forEach(h => h.setAttribute("aria-valuenow", String(v)));
  placeResizers();
}

// Handles are placed by MEASURING the rendered pane edges rather than recomputing the CSS
// widths in JS. That keeps them correct through every breakpoint, the collapse animation, and
// any future column change, with no second source of truth to drift.
function placeResizers() {
  const app = document.querySelector(".app");
  if (!app || !app.getBoundingClientRect) return;
  const base = app.getBoundingClientRect();
  for (const [key, sel] of [["sidebar", ".sidebar"], ["list", ".call-list"]]) {
    const el = document.querySelector(sel);
    const handle = document.querySelector(`.resizer[data-resize="${key}"]`);
    if (el && handle && el.getBoundingClientRect) handle.style.left = `${el.getBoundingClientRect().right - base.left}px`;
  }
}

function wireResizer(handle) {
  const key = handle.dataset.resize;
  const spec = PANES[key];
  if (!spec || handle.dataset.wired) return;
  handle.dataset.wired = "1";

  handle.addEventListener("pointerdown", ev => {
    const start = paneSize(spec);
    if (start == null) return;
    const origin = spec.axis === "x" ? ev.clientX : ev.clientY;
    handle.classList.add("dragging");
    document.body.classList.add("resizing", spec.axis === "x" ? "resizing-x" : "resizing-y");
    // Pointer capture keeps the drag alive when the cursor outruns the 9px handle — without it
    // a fast drag detaches the moment the pointer leaves the strip.
    try { handle.setPointerCapture(ev.pointerId); } catch {}
    const move = e => setPane(key, start + ((spec.axis === "x" ? e.clientX : e.clientY) - origin));
    const end = () => {
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing", "resizing-x", "resizing-y");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      savePanes();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    ev.preventDefault();
  });

  // Double-click resets to the CSS default (removing the variable, not writing a hardcoded
  // number — so the responsive defaults per breakpoint come back too).
  handle.addEventListener("dblclick", () => {
    document.documentElement.style.removeProperty(spec.prop);
    document.querySelectorAll(`[data-resize="${key}"]`).forEach(h => h.removeAttribute("aria-valuenow"));
    savePanes();
    placeResizers();
  });

  handle.addEventListener("keydown", e => {
    const horiz = spec.axis === "x";
    const dec = horiz ? "ArrowLeft" : "ArrowUp";
    const inc = horiz ? "ArrowRight" : "ArrowDown";
    if (e.key !== dec && e.key !== inc) return;
    const cur = paneSize(spec);
    if (cur == null) return;
    // Suppress the collapse transition for the nudge, or a held-down arrow key leaves the pane
    // trailing the input by .18s. Cleared next frame so the collapse animation still works.
    document.body.classList.add("pane-nudge");
    setPane(key, cur + (e.key === inc ? 16 : -16));
    savePanes();
    requestAnimationFrame(() => document.body.classList.remove("pane-nudge"));
    e.preventDefault();
  });
}

function initPanes() {
  loadPanes();
  document.querySelectorAll(".resizer").forEach(wireResizer);
  placeResizers();
  // A ResizeObserver means the handles follow the panes through the collapse transition and any
  // breakpoint change without wiring a listener per cause.
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => placeResizers());
    [".sidebar", ".call-list"].forEach(sel => { const el = document.querySelector(sel); if (el && el.nodeType) ro.observe(el); });
  }
  window.addEventListener("resize", placeResizers);
}
initPanes();

function fmtTime(iso) {
  const d = new Date(iso + (iso.includes("Z") || iso.includes("+") ? "" : "Z"));
  const now = new Date(); const days = Math.floor((now - d) / 86400000);
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return days === 0 ? `Today, ${t}` : days === 1 ? `Yesterday, ${t}` : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// ---------- call detail ----------
async function openCall(id) {
  // Opening a call always leaves workspace mode. The People page links straight into a call, so
  // without this the list pane would stay hidden while a call is on screen and there would be no
  // visible way back to the inbox.
  document.body.classList.remove("workspace");
  state.currentCallId = id;
  document.querySelectorAll(".nav-item[data-view]").forEach(n => n.classList.remove("active"));
  markCallSeen(id);          // opening it is what clears the "new" mark, like unread mail
  renderCallList();
  renderNavCounts();
  const { call, outputs } = await api.get(`/calls/${id}`);
  const st = callState(call);
  if (st === "processing") return renderWorking(call);
  if (st === "processed") return renderProcessed(call, outputs);
  return renderUnprocessed(call);   // covers 'new' and 'failed'

}

// What the chosen type will actually produce — so the button doesn't promise a CRM note for an
// internal call that isn't getting one.
function typeOf(call) { return (state.callTypes || []).find(t => t.id === call.call_type_id); }
function processBtnLabel(call) {
  const t = typeOf(call);
  if (!t) return "Generate Debrief, Text, Email & CRM Note";
  const parts = ["Debrief"];
  if (t.produces_messages) parts.push("Text", "Email");
  if (t.produces_crm_note) parts.push("CRM Note");
  return "Generate " + parts.join(", ").replace(/,([^,]*)$/, " &$1");
}
function ctPickHint(call) {
  const t = typeOf(call);
  return t ? `${t.description || ""} ${ctSummary(t)}`.trim() : "Pick a type — it decides which prompt runs.";
}

// Shared by the processed and unprocessed views. On a call that already has outputs, changing
// the type makes those outputs stale — they were written by the PREVIOUS type's prompt — so say
// so rather than letting a client-call debrief keep sales scoring on screen.
function wireTypePicker(call) {
  document.querySelectorAll("[data-pick]").forEach(b => b.addEventListener("click", async () => {
    const id = +b.dataset.pick;
    const changed = call.call_type_id !== id;
    await api.patch(`/calls/${call.id}`, { call_type_id: id });
    call.call_type_id = id;
    document.querySelectorAll("[data-pick]").forEach(x => x.classList.toggle("active", +x.dataset.pick === id));
    const hint = $("#ctPickHint"); if (hint) hint.textContent = ctPickHint(call);
    const bt = $("#processBtn"); if (bt) bt.innerHTML = `✦ ${processBtnLabel(call)}`;
    const stale = $("#ctStale");
    if (stale && changed && callState(call) === "processed") {
      stale.innerHTML = `These outputs came from the old type — <button class="linklike" id="ctRegen">regenerate</button> to use this prompt.`;
      $("#ctRegen").addEventListener("click", async () => {
        await api.post(`/calls/${call.id}/process`);
        toast("Regenerating with the new call type");
        await refreshCalls(); openCall(call.id);
      });
    }
    const row = state.calls.find(c => c.id === call.id);
    if (row) { row.call_type_id = id; row.call_type_name = (state.callTypes.find(t => t.id === id) || {}).name; renderCallList(); }
  }));
}

function toneOf(call) { return call.selected_tone || call.suggested_tone || "balanced"; }

// TASK-104. Which tones this call ACTUALLY has outputs for. New calls have exactly one, written
// for the buyer; calls processed before 2026-08-05 have three (casual/balanced/formal) and must
// keep working — the shape-tolerance rule from TASK-089, applied to data instead of JSON.
// Derived from the outputs themselves rather than from a version flag, because the outputs are
// the thing that has to be selectable.
function availableTones(outputs) {
  return [...new Set((outputs || []).filter(o => o.tone).map(o => o.tone))];
}

// The title must be its OWN element, separate from the status pill: making the whole
// .dh-name contentEditable would let you edit the pill text too.
// (The previous rename attempt targeted #callName, which no element ever had — so `if (nameEl)`
// silently swallowed it and the feature looked implemented while doing nothing.)
const callTitle = (call, pill = "") =>
  `<div class="dh-name"><span id="callName" class="call-title" title="Double-click to rename">${esc(call.client_name)}</span>${pill ? " " + pill : ""}</div>`;

// Archive lives in the inbox; DELETE lives only in the archive. Two steps means a mis-click
// costs nothing, and the irreversible action is never next to the everyday one.
function callActions(call, extra = "") {
  if (call.archived_at) {
    return `${extra}<button class="regen-btn" id="unarchiveBtn">↩ Unarchive</button>
            <button class="regen-btn danger-btn" id="deleteBtn">Delete permanently</button>`;
  }
  return `${extra}<button class="regen-btn" id="archiveBtn">Archive</button>`;
}

function wireCallActions(call) {
  const ar = $("#archiveBtn");
  if (ar) ar.addEventListener("click", async () => {
    await api.post(`/calls/${call.id}/archive`, { archived: true });
    toast(`Archived "${call.client_name}" — find it under Archived.`);
    await refreshCalls();
    openRelevantCall();
  });

  const un = $("#unarchiveBtn");
  if (un) un.addEventListener("click", async () => {
    await api.post(`/calls/${call.id}/archive`, { archived: false });
    toast("Back in your inbox.");
    await refreshCalls();
    openRelevantCall();
  });

  const del = $("#deleteBtn");
  if (del) del.addEventListener("click", async () => {
    // Name the call and say plainly that it is permanent. Archive is the undo; this is not.
    if (!confirm(`Permanently delete "${call.client_name}"?\n\nThis erases the transcript, the debrief, and all four outputs. It cannot be undone.\n\nIf you just want it out of the way, Unarchive and leave it archived instead.`)) return;
    try {
      await api.req("DELETE", `/calls/${call.id}`);
      toast(`Deleted "${call.client_name}".`);
      await refreshCalls();
      openRelevantCall();
    } catch (err) {
      toast(`Could not delete: ${err.message}`);
    }
  });
}

function wireRename(call) {
  const nameEl = $("#callName");
  if (!nameEl) { console.warn("rename: #callName missing — title not renameable"); return; }
  nameEl.addEventListener("dblclick", () => {
    const original = call.client_name;
    nameEl.contentEditable = "true";
    nameEl.classList.add("editing");
    nameEl.focus();
    document.getSelection().selectAllChildren(nameEl);

    let done = false;
    const finish = async (save) => {
      if (done) return;            // blur fires after Enter too — don't save twice
      done = true;
      nameEl.contentEditable = "false";
      nameEl.classList.remove("editing");
      const next = nameEl.textContent.trim();
      if (!save || !next || next === original) { nameEl.textContent = original; return; }
      try {
        await api.patch(`/calls/${call.id}`, { client_name: next });
        call.client_name = next;
        const row = state.calls.find(c => c.id === call.id);
        if (row) row.client_name = next;   // keep the list in sync without a full refetch
        renderCallList();
        toast("Renamed");
      } catch (err) {
        nameEl.textContent = original;     // never leave a name on screen that was not saved
        toast(`Rename failed: ${err.message}`);
      }
    };
    nameEl.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); nameEl.blur(); }
      if (e.key === "Escape") { e.preventDefault(); nameEl.textContent = original; finish(false); nameEl.blur(); }
    });
    nameEl.addEventListener("blur", () => finish(true), { once: true });
  });
}

function renderProcessed(call, outputs) {
  const d = JSON.parse(call.debrief_json || "{}");
  const tones = availableTones(outputs);
  // A legacy call selected 'balanced'; a new one has only 'tuned'. Falling back to the first
  // available tone stops toneOf() pointing at a tone this call has no output for.
  const tone = tones.includes(toneOf(call)) ? toneOf(call) : (tones[0] || toneOf(call));
  const sms = outputs.find(o => o.kind === "sms" && o.tone === tone);
  const email = outputs.find(o => o.kind === "email" && o.tone === tone);
  const ghl = outputs.find(o => o.kind === "ghl_note");
  const defTab = defaultOutputTab(d);   // adaptive: open on what Gabriel said he'd send (TASK-085/088)
  const pill = call.outcome === "closed" ? `<span class="pill pill-closed">Closed</span>` : `<span class="pill pill-followup">Follow-up</span>`;
  // Fathom is the norm, so saying so on every call is noise. A hand-pasted transcript is the
  // exception and still says so.
  const srcBadge = call.source === "fathom" ? "" : `<span class="fathom-badge" style="color:var(--ink-600); background:var(--paper-200);">Pasted manually</span>`;

  $("#detailPane").innerHTML = `
    <div class="detail-header">
      <div class="dh-top">
        <div>
          ${callTitle(call, pill)}
          <div class="dh-meta">${esc(offerLabel(call))}<span class="sep">·</span>${call.duration_min ? call.duration_min + " min" : ""} ${fmtTime(call.occurred_at)}${srcBadge ? `<span class="sep">·</span>${srcBadge}` : ""}</div>
        </div>
        <div class="dh-actions">${callActions(call, `<button class="regen-btn" id="regenBtn">↻ Regenerate</button>`)}</div>
      </div>
      <!-- UI CLEANUP 2026-08-05. The header had grown to four permanent control rows (~430px
           before any content): call-type chips, tone segment, and two explainer lines — all
           editable, on every call, forever. But relabelling a call or switching a legacy tone is
           an EXCEPTION, not a per-visit action; every comparable surface (Grain, Apollo, Amie)
           shows the current value and hides the editor behind it. One summary line now; clicking
           it reveals the exact controls that were always here, so every existing handler,
           test hook and class name still works. -->
      <div class="dh-settings ${state.settingsOpen === call.id ? "open" : ""}" id="dhSettings">
        <button class="dh-summary" id="dhSummaryBtn" aria-expanded="${state.settingsOpen === call.id}">
          <span class="dh-sum-type">${esc((state.callTypes || []).find(t => t.id === call.call_type_id)?.name || "Untyped")}</span>
          ${tones.length > 1 ? `<span class="sep">·</span><span>${tone[0].toUpperCase() + tone.slice(1)} tone</span>` : ""}
          ${call.tone_reason ? `<span class="sep">·</span><span class="dh-sum-note">${esc(call.tone_reason)}</span>` : ""}
          <span class="dh-sum-chev">${state.settingsOpen === call.id ? "▴" : "▾"}</span>
        </button>
        <div class="dh-controls">
          <div class="tone-row">
            <span class="tone-label">Call type</span>
            <div class="ct-picker">${(state.callTypes || []).map(t =>
              `<button class="ct-chip ${t.id === call.call_type_id ? "active" : ""}" data-pick="${t.id}">${esc(t.name)}</button>`).join("")}</div>
            <span class="applies-to" id="ctStale"></span>
          </div>
          ${tones.length > 1 ? `
          <div class="tone-row">
            <span class="tone-label">Text &amp; email tone</span>
            <div class="tone-seg">${tones.map(t =>
              `<button class="tone-opt ${t === tone ? "selected" : ""}" data-tone="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>
            ${call.suggested_tone && call.suggested_tone !== tone ? `<span class="tone-suggested">✦ Suggested: ${call.suggested_tone}</span>` : ""}
          </div>` : ""}
        </div>
      </div>
    </div>
    <!-- ONE unified section (Ivan, 2026-08-05, annotated screenshot: "unify all the output so
         that we maximize the screen real estate at all times" — the full version of what
         Gabriel asked for on the 08-04 call, TASK-106). The debrief pages and the three
         outputs share ONE chip row and ONE full-height body; exactly one panel shows at a
         time, and it gets every vertical pixel. The separate "Debrief" heading, the second
         tab strip, and the debrief|outputs divider are gone — there is nothing left to divide.
         Opens on the output Gabriel said on the call he would send (TASK-085); the debrief is
         one click away. Actions live at the right end of the chip row and belong to the ACTIVE
         panel only: Copy all with a debrief page, Mark sent / Copy with an output. -->
    <div class="unified-section">
      <div class="panel-subnav" role="tablist">
        ${DEBRIEF_PAGES.map((p, i) =>
          `<button class="chip" data-page="${i}" role="tab" aria-selected="false">${p.label}</button>`).join("")}
        <span class="subnav-split" aria-hidden="true"></span>
        ${OUTPUT_TABS.map(t =>
          `<button class="chip ${t.key === defTab ? "active" : ""}" data-otab="${t.key}"
                   role="tab" aria-selected="${t.key === defTab}">${t.label}</button>`).join("")}
        <span class="subnav-actions">
          <button class="copy-btn hidden" id="copyDebrief">⧉ Copy all</button>
          ${[["text", sms, true], ["email", email, true], ["ghl", ghl, false]].map(([k, o, sent]) =>
            `<div class="oacts ${k === defTab ? "active" : ""}" data-otab="${k}">${o ? `
              ${sent ? `<button class="sent-btn ${o.sent_at ? "is-sent" : ""}" data-out="${o.id}">${o.sent_at ? "✓ Sent" : "Mark sent"}</button>` : ""}
              <button class="copy-btn" data-out="${o.id}">⧉ Copy</button>` : ""}</div>`).join("")}
        </span>
      </div>
      <div class="unified-body" id="debriefBody">
        ${DEBRIEF_PAGES.map((p, i) =>
          `<div class="dpage${p.key === "transcript" ? " dpage-transcript" : ""}" data-page="${i}">${p.render(d, call) || `<div class="dpage-empty">Nothing recorded for this section.</div>`}</div>`).join("")}
        <div class="opane ${defTab === "text"  ? "active" : ""}" data-otab="text">${outputPanel("Text Message", sms, { sent: true })}</div>
        <div class="opane ${defTab === "email" ? "active" : ""}" data-otab="email">${outputPanel("Email", email, { sent: true, subject: true })}</div>
        <div class="opane ${defTab === "ghl"   ? "active" : ""}" data-otab="ghl">${outputPanel("GoHighLevel Note", ghl, {})}</div>
      </div>
    </div>
    <!-- TASK-105. Sits BELOW the outputs, the way ChatGPT and Claude put the box under the
         answer — Ivan's shape from the call. Whatever it rewrites appears above it. -->
    <!-- UI CLEANUP 2026-08-05. This shipped as a permanently open panel — empty-state paragraph
         plus composer, ~160px subtracted from the outputs pane even with zero messages. That is
         the exact pane Gabriel said was too small (TASK-088/106), which made the chat a
         regression wearing a feature. Apollo and Lightfield both do this right: a slim ask-bar,
         and the thread only takes space once a thread exists. The hint lives in the placeholder. -->
    <div class="chat-section" id="chatSection">
      <div class="chat-log hidden" id="chatLog"></div>
      <form class="chat-input" id="chatForm">
        <textarea id="chatBox" rows="1" placeholder="Ask about the call, or ask for a change — 'rewrite the email without the price'"></textarea>
        <button class="primary-btn" id="chatSend" type="submit">Send</button>
      </form>
    </div>`;

  wireDetail(call, { sms, email, ghl, debrief: d });
  loadChat(call);
}

// ---------- per-call chat (TASK-105) ----------
// The whole point is revising IN PLACE. When a turn rewrites an output we reopen the call so the
// pane above shows the new text — otherwise Gabriel is told it changed and has to go looking.
function chatBubble(m) {
  const who = m.role === "assistant" ? "a" : "u";
  return `<div class="chat-msg chat-${who}">${esc(m.body)}${
    m.updated_kind ? `<div class="chat-updated">✦ rewrote the ${esc(m.updated_kind === "ghl_note" ? "CRM note" : m.updated_kind)} above</div>` : ""}</div>`;
}

async function loadChat(call) {
  const log = $("#chatLog");
  if (!log) return;
  try {
    const { messages } = await api.get(`/calls/${call.id}/chat`);
    // The log holds ZERO height until a conversation exists — the outputs pane pays for every
    // pixel this panel takes, and an empty chat is not worth any of them.
    if (messages.length) {
      log.innerHTML = messages.map(chatBubble).join("");
      log.classList.remove("hidden");
      log.scrollTop = log.scrollHeight;
    }
  } catch { /* a chat that fails to load must not take the call view down */ }

  const form = $("#chatForm"), box = $("#chatBox"), send = $("#chatSend");
  if (!form) return;
  // Grow with the text, up to a point. A fixed one-line box makes people write one-line asks.
  box.addEventListener("input", () => { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight, 140) + "px"; });
  box.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const text = box.value.trim();
    if (!text || send.disabled) return;
    send.disabled = true; box.value = ""; box.style.height = "auto";
    log.classList.remove("hidden");
    log.insertAdjacentHTML("beforeend", chatBubble({ role: "user", body: text }));
    log.insertAdjacentHTML("beforeend", `<div class="chat-msg chat-a chat-pending" id="chatPending">Thinking…</div>`);
    log.scrollTop = log.scrollHeight;
    try {
      const r = await api.post(`/calls/${call.id}/chat`, { message: text });
      $("#chatPending")?.remove();
      log.insertAdjacentHTML("beforeend", chatBubble({ role: "assistant", body: r.reply, updated_kind: r.updatedKind }));
      log.scrollTop = log.scrollHeight;
      if (r.updatedKind) await openCall(call.id);   // re-render so the new text is actually visible
    } catch (err) {
      $("#chatPending")?.remove();
      log.insertAdjacentHTML("beforeend",
        `<div class="chat-msg chat-a chat-err">${esc(err?.message || "That did not go through. Try again.")}</div>`);
    } finally {
      send.disabled = false;
    }
  });
}

// The debrief pills are pagination, not jump links: each shows exactly one page and hides the
// rest. Page 0 pairs the TL;DR with the scorecard because that is the "did I do well?" glance;
// everything else is a section you go looking for deliberately.
const bullets = xs => (xs || []).length
  ? `<ul>${xs.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "";

// The three outputs, shown one at a time under a segmented control (TASK-088).
const OUTPUT_TABS = [
  { key: "text",  label: "Text Message" },
  { key: "email", label: "Email" },
  { key: "ghl",   label: "CRM Note" }
];

// Which output to open on. Follows what Gabriel told the client he would send on the call
// (statedFollowUps, TASK-085). Email is the default client-facing surface; only fall to Text
// when he named a text and no email. The CRM note is internal, so it is never auto-opened.
function defaultOutputTab(d) {
  const stated = Array.isArray(d && d.statedFollowUps) ? d.statedFollowUps : [];
  const channels = new Set(stated.map(s => String(s && s.channel || "").toLowerCase()));
  if (channels.has("email")) return "email";
  if (channels.has("text")) return "text";
  return "email";
}

// TASK-089 enriched the debrief from flat lists to structured objects. Every renderer below is
// SHAPE-TOLERANT: production has processed calls stored in the OLD shape (string[], [label,score]),
// and they must keep rendering. Each helper branches on typeof and never assumes the new shape.
// Key moments with a link into the recording (TASK-123).
//
// Gabriel: "in the moments where there is a critical moment in the call... for that to be easy to
// do and easy to access." A sales trainer reads the moment and clicks straight to the second it
// happened, instead of scrubbing a 48-minute recording.
//
// Two states, and the second is the point:
//   * `seconds` is a number -> the timestamp was VERIFIED against the transcript. Render a link.
//   * `seconds` is null     -> the model produced a timestamp that is not in the transcript, or
//                              the call has no recording URL. Render the time as PLAIN TEXT.
//
// A wrong link is worse than no link here: it is something a trainer clicks in front of their
// team and it opens the wrong moment, with nothing on screen to say it is wrong. Verification
// happens server-side at generation time (verifyMoments in llm.js); this just honours it.
function keyMoments(d, call) {
  const list = Array.isArray(d?.keyMoments) ? d.keyMoments : [];
  if (!list.length) return "";
  const base = call?.recording_url || "";
  return `<h4>Key Moments</h4><div class="km-list">${list.map(m => {
    const linkable = base && Number.isFinite(m.seconds);
    const at = esc(m.at || "");
    const stamp = linkable
      ? `<a class="km-at" href="${esc(base)}${base.includes("?") ? "&" : "?"}timestamp=${m.seconds}"
            target="_blank" rel="noopener" title="Open the recording at ${at}">${at}</a>`
      : `<span class="km-at km-plain" title="${base ? "This timestamp was not found in the transcript, so it is not linked" : "No recording link stored for this call"}">${at}</span>`;
    return `<div class="km">
      ${stamp}
      <div class="km-body">
        <div class="km-label">${esc(m.label || "")}</div>
        ${m.what ? `<div class="km-what">${esc(m.what)}</div>` : ""}
        ${m.why ? `<div class="km-why">${esc(m.why)}</div>` : ""}
      </div></div>`;
  }).join("")}</div>`;
}

const DEBRIEF_PAGES = [
  { label: "TL;DR & Scorecard", key: "tldr",
    render: (d, call) => (diagnosisBlock(d) + highlights(d) + keyMoments(d, call)
      + (d.scorecard?.length ? `<h4>Call Scorecard</h4>${scorecard(d.scorecard)}` : "")) },
  { label: "Did Well", key: "didWell", render: d => richList(d.didWell, "did") },
  { label: "Hurt Sale", key: "hurtSale", render: d => richList(d.hurtSale, "hurt") },
  { label: "Objections", key: "objections", render: d => (d.objections || []).map(o => `
      <div class="objection"><div class="said">"${esc(o.said)}"</div>
      <dl><dt>Meant</dt><dd>${esc(o.meant)}</dd><dt>Felt</dt><dd>${esc(o.felt)}</dd>
      ${o.rootFear ? `<dt>Root fear</dt><dd>${esc(o.rootFear)}</dd>` : ""}
      <dt>Say instead</dt><dd>${esc(o.should)}</dd><dt>Follow-up</dt><dd>${esc(o.follow)}</dd>
      <dt>Loop back</dt><dd>${esc(o.loop)}</dd></dl></div>`).join("") },
  { label: "Client Profile", key: "profile", render: d => profileBlock(d.profile) },
  { label: "Buying Signals", key: "buyingSignals", render: d => signalsBlock(d.buyingSignals) },
  { label: "Missed Openings", key: "missedOpenings", render: d => openingsBlock(d.missedOpenings) },
  { label: "Lessons", key: "lessons", render: d => bullets(d.lessons) },
  // The transcript, on a PROCESSED call (Gabriel, 2026-08-10: "If possible could we ad a tab
  // with the actual transcript?"). It was already rendered in the unprocessed view and simply
  // vanished the moment a call was processed — which is the moment he wants to check the
  // debrief against what was actually said.
  //
  // It sits on the DEBRIEF side of subnav-split, and `noCopy` keeps Copy-all and Mark-sent off
  // the row: this is source material, not an output he sends anyone. Renders from `call`, which
  // is why every page's render() takes it as a second argument — the other eight ignore it.
  { label: "Transcript", key: "transcript", noCopy: true,
    render: (d, call) => call?.transcript
      ? `<textarea class="transcript-view" readonly aria-label="Call transcript">${esc(call.transcript)}</textarea>`
      : "" }
];

// A "did well" / "hurt sale" item is a string (legacy) or an object (TASK-089). The rewrite
// ("say instead") is the valuable part of a hurt-sale item, so it is surfaced, not buried.
function richList(items, kind) {
  if (!(items || []).length) return "";
  return `<ul class="rich-list">${items.map(x => {
    if (typeof x === "string") return `<li>${esc(x)}</li>`;
    if (kind === "hurt") return `<li><div class="ri-main">${esc(x.issue || "")}</div>
      ${x.why ? `<div class="ri-why">${esc(x.why)}</div>` : ""}
      ${x.sayInstead ? `<div class="ri-fix"><span class="ri-fix-tag">Say instead</span>${esc(x.sayInstead)}</div>` : ""}</li>`;
    return `<li><div class="ri-main">${esc(x.move || "")}</div>${x.why ? `<div class="ri-why">${esc(x.why)}</div>` : ""}</li>`;
  }).join("")}</ul>`;
}

// Executive diagnosis + one-line outcome, at the top of the TL;DR page. Enriched debriefs only —
// legacy calls have neither and this returns "".
function diagnosisBlock(d) {
  if (!d.diagnosis && !d.outcomeSummary) return "";
  return `<div class="diagnosis">
    ${d.diagnosis ? `<div class="diag-eyebrow">Diagnosis</div><p class="diag-text">${esc(d.diagnosis)}</p>` : ""}
    ${d.outcomeSummary ? `<p class="diag-outcome">${esc(d.outcomeSummary)}</p>` : ""}</div>`;
}

// Client profile — string[] (legacy) or the structured behavioural object (TASK-089).
function profileBlock(p) {
  if (!p) return "";
  if (Array.isArray(p)) return bullets(p);
  if (typeof p !== "object") return bullets([String(p)]);
  const sub = (label, xs) => (xs || []).length ? `<h4>${label}</h4>${bullets(xs)}` : "";
  const line = (label, v) => v ? `<div class="prof-line"><span class="prof-k">${esc(label)}</span><span>${esc(v)}</span></div>` : "";
  return `${p.disc || p.decisionSpeed || p.certaintyNeed || p.identityStyle ? `<div class="prof-lines">
      ${line("DISC", p.disc)}${line("Decision speed", p.decisionSpeed)}${line("Certainty need", p.certaintyNeed)}${line("Identity", p.identityStyle)}</div>` : ""}
    ${(p.valuesHierarchy || []).length ? `<h4>Values (ranked)</h4><ol class="ranked">${p.valuesHierarchy.map(v => `<li>${esc(v)}</li>`).join("")}</ol>` : ""}
    ${sub("Dominant fears", p.dominantFears)}
    ${p.emotionalWound ? `<h4>Emotional wound</h4><p class="prof-wound">${esc(p.emotionalWound)}</p>` : ""}
    ${sub("Trust triggers", p.trustTriggers)}
    ${sub("Resistance patterns", p.resistancePatterns)}`;
}

// Buying signals — string[] (legacy) or {genuine, false} (TASK-089).
function signalsBlock(b) {
  if (!b) return "";
  if (Array.isArray(b)) return bullets(b);
  if (typeof b !== "object") return bullets([String(b)]);
  return `${(b.genuine || []).length ? `<h4>Genuine signals</h4>${bullets(b.genuine)}` : ""}
    ${(b.false || []).length ? `<h4>False signals</h4>${bullets(b.false)}` : ""}`;
}

// Missed micro-commitments — enriched debriefs only.
function openingsBlock(list) {
  if (!(list || []).length) return "";
  return `<ul class="rich-list">${list.map(o => `<li><div class="ri-main">${esc(o.moment || "")}</div>
    <div class="ri-fix"><span class="ri-fix-tag">Ask instead</span>${esc(o.askInstead || "")}</div></li>`).join("")}</ul>`;
}

// Copy = the WHOLE debrief, not just the visible page. Pagination is a reading aid; it must
// not silently narrow what the copy button gives you. Shape-tolerant like the renderers.
function debriefToText(call, d) {
  const L = [`DEBRIEF — ${call.client_name}`, fmtTime(call.occurred_at), ""];
  const asLine = x => typeof x === "string" ? x
    : x.move ? (x.why ? `${x.move} — ${x.why}` : x.move)
    : x.issue ? `${x.issue}${x.why ? ` — ${x.why}` : ""}${x.sayInstead ? `\n    Say instead: ${x.sayInstead}` : ""}`
    : JSON.stringify(x);
  const sec = (title, xs) => { if ((xs || []).length) L.push(title.toUpperCase(), ...xs.map(x => `• ${asLine(x)}`), ""); };
  if (d.diagnosis) L.push("DIAGNOSIS", d.diagnosis, "");
  if (d.outcomeSummary) L.push(d.outcomeSummary, "");
  if (d.scorecard?.length) {
    L.push(`CALL SCORECARD${Number.isFinite(d.overallScore) ? ` (overall ${d.overallScore}/10)` : ""}`,
      ...d.scorecard.map(([k, v, note]) => `• ${k}: ${v}/10${note ? ` — ${note}` : ""}`), "");
  }
  sec("What you did well", d.didWell);
  sec("What hurt the sale", d.hurtSale);
  if (d.objections?.length) {
    L.push("OBJECTION AUTOPSY");
    d.objections.forEach(o => L.push(
      `• "${o.said}"`, `    Meant: ${o.meant}`, `    Felt: ${o.felt}`,
      ...(o.rootFear ? [`    Root fear: ${o.rootFear}`] : []),
      `    Say instead: ${o.should}`, `    Follow-up: ${o.follow}`, `    Loop back: ${o.loop}`));
    L.push("");
  }
  // Client profile: object (new) or string[] (legacy).
  if (Array.isArray(d.profile)) sec("Client profile", d.profile);
  else if (d.profile && typeof d.profile === "object") {
    const p = d.profile; L.push("CLIENT PROFILE");
    if (p.disc) L.push(`• DISC: ${p.disc}`);
    (p.valuesHierarchy || []).forEach((v, i) => L.push(`• Value ${i + 1}: ${v}`));
    (p.dominantFears || []).forEach(v => L.push(`• Fear: ${v}`));
    if (p.emotionalWound) L.push(`• Wound: ${p.emotionalWound}`);
    (p.trustTriggers || []).forEach(v => L.push(`• Trusts: ${v}`));
    L.push("");
  }
  if (Array.isArray(d.buyingSignals)) sec("Buying signals + red flags", d.buyingSignals);
  else if (d.buyingSignals && typeof d.buyingSignals === "object") {
    sec("Genuine buying signals", d.buyingSignals.genuine);
    sec("False signals", d.buyingSignals.false);
  }
  if ((d.missedOpenings || []).length) {
    L.push("MISSED OPENINGS");
    d.missedOpenings.forEach(o => L.push(`• ${o.moment}`, `    Ask instead: ${o.askInstead}`));
    L.push("");
  }
  sec("Coaching lessons", d.lessons);
  return L.join("\n").trim();
}

function highlights(d) {
  const hasScore = d.scorecard?.length;
  const overall = Number.isFinite(d.overallScore) ? d.overallScore : null;
  if (!hasScore && overall == null) return "";
  let best, worst;
  if (hasScore) { const s = [...d.scorecard].sort((a, b) => b[1] - a[1]); best = s[0]; worst = s[s.length - 1]; }
  return `<div class="highlights"><div class="hl-title">TL;DR</div>
    ${overall != null ? `<div class="hl-row"><span class="hl-tag hl-overall">Overall</span><span>${overall}/10</span></div>` : ""}
    ${best ? `<div class="hl-row"><span class="hl-tag hl-best">Strongest</span><span>${esc(best[0])} — ${best[1]}/10</span></div>` : ""}
    ${worst ? `<div class="hl-row"><span class="hl-tag hl-worst">Work on</span><span>${esc(worst[0])} — ${worst[1]}/10</span></div>` : ""}
    ${d.lessons?.[0] ? `<div class="hl-row"><span class="hl-tag hl-lesson">#1 Lesson</span><span>${esc(d.lessons[0])}</span></div>` : ""}</div>`;
}

const tierColor = n => n >= 8 ? "var(--blue-500)" : n >= 6 ? "var(--violet-500)" : "var(--pink-500)";
// Each dimension is one self-contained cell so the grid can flow them into as many columns as
// the pane is wide. The old 2-column grid forced all 10 rows into a single tall stack, which is
// what made the scorecard need scrolling.
function scorecard(rows) {
  return `<div class="scorecard">${(rows || []).map(([k, v, note]) => `
    <div class="sc-item">
      <div class="sc-top"><span class="sc-k">${esc(k)}</span><span class="sc-v" style="color:${tierColor(v)}">${v}/10</span></div>
      <div class="bar"><i style="width:${v * 10}%; background:${tierColor(v)}"></i></div>
      ${note ? `<div class="sc-note">${esc(note)}</div>` : ""}
    </div>`).join("")}</div>`;
}

// No title and no head row (TASK-092, TASK-093). The tab chip above already names the panel,
// and Copy / Mark sent now sit in that same tab row — a header strip holding only two buttons
// cost a whole second line of vertical space and read as a rendering mistake. `title` is still
// taken: it labels the textarea for screen readers, which have no chip to read from.
function outputPanel(title, out, opts) {
  if (!out) return `<div class="panel">
    <div class="panel-body"><span class="edit-note">Not generated yet — hit Regenerate.</span></div></div>`;
  return `<div class="panel" data-output="${out.id}">
    <div class="panel-body">
      ${opts.subject ? `<input class="subject-input" data-out="${out.id}" data-field="subject" value="${esc(out.subject || "")}" aria-label="Email subject">` : ""}
      <textarea class="msg-edit" data-out="${out.id}" data-field="body" aria-label="${title}">${esc(out.body)}</textarea>
      <span class="edit-note">Click to edit — changes are saved and feed the weekly tone learning.</span>
    </div></div>`;
}

function wireDetail(call, outs) {
  // The settings summary toggles the header controls. Open state is remembered per call so a
  // re-render mid-edit (e.g. after picking a type) does not slam the drawer shut underneath.
  $("#dhSummaryBtn")?.addEventListener("click", () => {
    state.settingsOpen = state.settingsOpen === call.id ? null : call.id;
    $("#dhSettings").classList.toggle("open", state.settingsOpen === call.id);
    $("#dhSummaryBtn").setAttribute("aria-expanded", state.settingsOpen === call.id);
  });

  // ONE selection across debrief pages AND outputs (2026-08-05). Eleven chips, one active
  // panel, full height. Selecting from one family deactivates the other, and the actions at
  // the row's end follow the active panel: Copy-all belongs to the debrief, Mark-sent/Copy to
  // the output they act on — a button for a panel that is not on screen is clutter at best
  // and a mis-click at worst.
  // `allowCopy` exists for the transcript page: it is a debrief-side page, so it must still
  // clear the output actions, but Copy-all belongs to the debrief and not to a raw transcript.
  const showDebriefActions = (on, allowCopy = true) => {
    $("#copyDebrief")?.classList.toggle("hidden", !(on && allowCopy));
    if (!on) return;
    document.querySelectorAll(".oacts").forEach(a => a.classList.remove("active"));
  };
  document.querySelectorAll(".chip[data-page]").forEach(chip => chip.addEventListener("click", () => {
    const n = chip.dataset.page;
    document.querySelectorAll(".chip[data-page]").forEach(c => {
      const on = c.dataset.page === n;
      c.classList.toggle("active", on);
      c.setAttribute("aria-selected", on);
    });
    document.querySelectorAll(".chip[data-otab]").forEach(c => {
      c.classList.remove("active"); c.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".dpage").forEach(p => p.classList.toggle("active", p.dataset.page === n));
    document.querySelectorAll(".opane").forEach(p => p.classList.remove("active"));
    showDebriefActions(true, !DEBRIEF_PAGES[+n]?.noCopy);
    $("#debriefBody").scrollTop = 0;
  }));

  document.querySelectorAll(".chip[data-otab]").forEach(chip => chip.addEventListener("click", () => {
    const k = chip.dataset.otab;
    document.querySelectorAll(".chip[data-otab]").forEach(c => {
      const on = c.dataset.otab === k;
      c.classList.toggle("active", on);
      c.setAttribute("aria-selected", on);
    });
    document.querySelectorAll(".chip[data-page]").forEach(c => {
      c.classList.remove("active"); c.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".dpage").forEach(p => p.classList.remove("active"));
    document.querySelectorAll(".opane").forEach(p => p.classList.toggle("active", p.dataset.otab === k));
    document.querySelectorAll(".oacts").forEach(a => a.classList.toggle("active", a.dataset.otab === k));
    showDebriefActions(false);
    $("#debriefBody").scrollTop = 0;
  }));

  // tone switch
  document.querySelectorAll(".tone-opt").forEach(btn => btn.addEventListener("click", async () => {
    await api.patch(`/calls/${call.id}`, { selected_tone: btn.dataset.tone });
    openCall(call.id);
  }));

  wireRename(call);
  wireCallActions(call);
  wireTypePicker(call);   // processed calls can be re-typed too, not just new ones
  // The debrief/outputs divider is re-created with the detail markup, so it needs re-wiring
  // on every render (TASK-091). wireResizer is idempotent via its data-wired flag.

  // regenerate
  $("#regenBtn").addEventListener("click", async () => {
    await api.post(`/calls/${call.id}/process`);
    await refreshCalls();
    openCall(call.id);
  });

  // copy debrief
  // Build the text from the DATA, not from the DOM. innerText skips display:none nodes, so
  // reading the pane would copy only whichever page happens to be open.
  $("#copyDebrief").addEventListener("click", e => copyText(debriefToText(call, outs.debrief || {}), e.currentTarget));

  // copy outputs
  //
  // FIND THE FIELD BY IDENTITY, NEVER BY TREE POSITION. This handler used to walk
  // `btn.closest(".panel")`. TASK-106 moved these buttons OUT of each output's panel and into
  // the shared chip row, so from 2026-08-05 `closest` returned null and every click threw a
  // TypeError before anything reached the clipboard — all three buttons, not just the CRM one
  // Gabriel reported. Silent to him, loud in the console, dead for a week.
  //
  // It stayed invisible because the test asserted the three buttons were PRESENT IN THE MARKUP,
  // which they always were. The markup was never the problem. `data-out` ties the button to its
  // field by id, which survives either of them moving anywhere in the tree — the same reasoning
  // as #copyDebrief above, which is why that one never broke.
  //
  // Reads the LIVE textarea rather than `outs` on purpose: an edit typed but not yet blurred is
  // what is on screen, so it is what Copy must put on the clipboard.
  document.querySelectorAll(".copy-btn[data-out]").forEach(btn => btn.addEventListener("click", () => {
    const id = btn.dataset.out;
    const body = document.querySelector(`[data-field="body"][data-out="${id}"]`);
    // Fail LOUDLY. The whole cost of this bug was that a broken copy looked exactly like a
    // working one; if the field ever goes missing again the user finds out, not the console.
    if (!body) { toast("Couldn't find that output to copy"); return; }
    const subject = document.querySelector(`[data-field="subject"][data-out="${id}"]`);
    copyText(subject ? `Subject: ${subject.value}\n\n${body.value}` : body.value, btn);
    api.post(`/outputs/${id}/copied`).catch(() => {});
  }));

  // sent toggles
  document.querySelectorAll(".sent-btn[data-out]").forEach(btn => btn.addEventListener("click", async () => {
    const sent = !btn.classList.contains("is-sent");
    await api.post(`/outputs/${btn.dataset.out}/sent`, { sent });
    btn.classList.toggle("is-sent", sent);
    btn.textContent = sent ? "✓ Sent" : "Mark sent";
    refreshCalls();
  }));

  // in-place editing with save-on-blur (captures edits for weekly learning)
  document.querySelectorAll("[data-field]").forEach(el => {
    const initial = el.value;
    el.addEventListener("input", () => el.classList.toggle("dirty", el.value !== initial));
    el.addEventListener("blur", async () => {
      if (el.value === initial) return;
      const payload = el.dataset.field === "subject" ? { subject: el.value } : { body: el.value };
      await api.patch(`/outputs/${el.dataset.out}`, payload);
      el.classList.remove("dirty");
      toast("Edit saved — it'll feed Sunday's tone analysis");
    });
  });
}

function renderUnprocessed(call) {
  $("#detailPane").innerHTML = `
    <div class="detail-header"><div class="dh-top"><div>
      ${callTitle(call, '<span class="pill pill-new">New</span>')}
      <div class="dh-meta">${esc(offerLabel(call))}<span class="sep">·</span>transcript ready, not yet processed</div>
    </div><div class="dh-actions">${callActions(call)}</div></div></div>
    <div class="compose-body">
      ${call.processing_error ? `<div class="fail-banner"><b>Last attempt failed.</b> ${esc(call.processing_error)}</div>` : ""}
      ${call.duplicate_of ? `<div class="dup-banner">This looks like a <b>duplicate</b> of call #${call.duplicate_of} — the same meeting recorded by someone else. Check before spending a generation on it.</div>` : ""}
      <label>What kind of call is this?</label>
      <div class="ct-picker" id="ctPicker">${(state.callTypes || []).map(t =>
        `<button class="ct-chip ${t.id === call.call_type_id ? "active" : ""}" data-pick="${t.id}" title="${esc(t.description || "")}">${esc(t.name)}</button>`).join("")}</div>
      <div class="ct-hint" id="ctPickHint">${ctPickHint(call)}</div>
      <label>Transcript</label>
      <textarea readonly>${esc(call.transcript || "")}</textarea>
      <button class="primary-btn" id="processBtn">✦ ${call.processing_error ? "Try again" : processBtnLabel(call)}</button>
    </div>`;
  wireRename(call);
  wireCallActions(call);
  wireTypePicker(call);
  $("#processBtn").addEventListener("click", async () => {
    renderLoading(call.client_name);
    await api.post(`/calls/${call.id}/process`);
    await refreshCalls();
    openCall(call.id);
  });
}

// Shown while generation runs. The work continues server-side via waitUntil, so
// leaving this screen (or closing the tab) no longer kills it.
// Tracks when the percentage last actually moved, so a stalled run is visibly distinct from
// a working one. A bar that keeps climbing while the connection is dead would be worse than
// the spinner it replaces — it would manufacture confidence. This one can only move when the
// server reports real streamed bytes, and says so out loud when it stops moving.
let progressSeen = { callId: null, percent: -1, atMs: 0 };
const STALL_MS = 90 * 1000;

// TASK-101 — update the working pane IN PLACE from the poll.
//
// Two things were wrong and they compounded. `refreshCalls()` re-renders the call list and the
// nav counts and never touches #detailPane, so the progress bar built in TASK-044 was painted
// once when the pane opened and then FROZE for the whole three minutes; only the elapsed clock
// moved. And nothing ever showed the text. Between them, a run that was working perfectly
// looked identical to one that had died — which is exactly what Gabriel reported.
//
// Patching rather than re-rendering is deliberate: a full innerHTML rebuild every 2.5s would
// restart the elapsed timer and throw away the stall detection that tells a slow run from a
// dead one.
function patchWorking(call) {
  const fill = $("#progFill");
  if (!fill) return false;                 // pane is showing something else now
  const pct = Number.isFinite(call.processing_progress) ? call.processing_progress : null;
  if (progressSeen.callId !== call.id || progressSeen.percent !== pct) {
    progressSeen = { callId: call.id, percent: pct, atMs: Date.now() };
  }
  fill.classList.toggle("indeterminate", pct === null);
  fill.style.width = `${pct === null ? 100 : Math.max(pct, 2)}%`;
  const stepEl = $("#progStep"), pctEl = $("#progPct");
  if (stepEl) stepEl.textContent = call.processing_step || "Starting";
  if (pctEl) pctEl.textContent = pct === null ? "" : pct + "%";
  const prev = $("#workPreview");
  if (prev) {
    const t = call.processing_preview || "";
    prev.textContent = t;
    prev.classList.toggle("hidden", !t);
    // Follow the text as it arrives, the way a terminal does. Without this the newest words
    // are written off the bottom edge and the panel looks stuck again.
    prev.scrollTop = prev.scrollHeight;
  }
  return true;
}

function renderWorking(call) {
  renderSeq++;
  const pct = Number.isFinite(call.processing_progress) ? call.processing_progress : null;
  const step = call.processing_step || "Starting";

  if (progressSeen.callId !== call.id || progressSeen.percent !== pct) {
    progressSeen = { callId: call.id, percent: pct, atMs: Date.now() };
  }

  $("#detailPane").innerHTML = `
    <div class="detail-header"><div class="dh-top"><div>
      ${callTitle(call, '<span class="pill pill-followup">Working</span>')}
      <div class="dh-meta">${esc(offerLabel(call))}<span class="sep">·</span>generating debrief, text, email &amp; CRM note</div>
    </div></div></div>
    <div class="loading-state">
      <div class="progress-wrap">
        <div class="progress-track">
          <div class="progress-fill ${pct === null ? "indeterminate" : ""}" id="progFill"
               style="width:${pct === null ? 100 : Math.max(pct, 2)}%"></div>
        </div>
        <div class="progress-row">
          <span class="progress-step" id="progStep">${esc(step)}</span>
          <span class="progress-pct" id="progPct">${pct === null ? "" : pct + "%"}</span>
        </div>
      </div>
      <div id="workPreview" class="work-preview ${call.processing_preview ? "" : "hidden"}">${esc(call.processing_preview || "")}</div>
      <div id="workElapsed" class="work-elapsed">Generating…</div>
      <div style="font-size:12px; color:var(--ink-400);">Safe to close this tab — it keeps running.</div>
      <div id="workStale" class="hidden" style="font-size:12px; color:var(--pink-500);"></div>
      <button class="regen-btn" id="retryBtn" style="margin-top:6px;">Restart generation</button>
    </div>`;

  // Elapsed counter — an unbounded spinner gives no signal about whether anything is happening.
  const startedMs = call.processing_started_at ? Date.parse(call.processing_started_at.replace(" ", "T") + "Z") : Date.now();
  const tick = () => {
    const el = $("#workElapsed");
    if (!el) return clearInterval(elapsedTimer);
    const secs = Math.max(0, Math.round((Date.now() - startedMs) / 1000));
    el.textContent = `Generating… ${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s elapsed`;
    // Report the stall, not the clock: a long run that is still streaming is fine; a short
    // run that stopped streaming is not.
    const stalledFor = Date.now() - progressSeen.atMs;
    const warn = $("#workStale");
    if (warn && stalledFor > STALL_MS) {
      warn.textContent = `No progress for ${Math.round(stalledFor / 1000)}s — the run may have died. Restarting is safe.`;
      warn.classList.remove("hidden");
    } else if (warn) warn.classList.add("hidden");
  };
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(tick, 1000);
  tick();
  // The server refuses a retry while a run is genuinely in flight (no double spend),
  // so this is only ever destructive to a run that has actually died.
  wireRename(call);
  $("#retryBtn").addEventListener("click", async () => {
    const r = await api.post(`/calls/${call.id}/process`);
    toast(r.already ? "Still generating — give it a moment." : "Restarted generation.");
    await refreshCalls();
  });
}

function renderCompose() {
  state.currentCallId = null;
  renderCallList();
  $("#detailPane").innerHTML = `
    <div class="detail-header"><div class="dh-top"><div>
      <div class="dh-name">New Call</div>
      <div class="dh-meta">Fathom auto-import lands after account setup — paste a transcript for now</div>
    </div></div></div>
    <div class="compose-body">
      <div style="display:flex; gap:10px;">
        <input type="text" id="composeName" placeholder="Client name" style="flex:1;">
        <input type="date" id="composeDate" title="Call date" style="width:150px;">
        <select id="composeAccount">${state.accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select>
      </div>
      <label>Call transcript</label>
      <textarea id="composeTranscript" placeholder="Paste the transcript here…"></textarea>
      <button class="primary-btn" id="generateBtn">✦ Generate Debrief, Text, Email &amp; CRM Note</button>
    </div>`;
  $("#generateBtn").addEventListener("click", async () => {
    const client_name = $("#composeName").value.trim();
    const transcript = $("#composeTranscript").value.trim();
    if (!client_name || !transcript) return toast("Client name and transcript required");
    const occurred_at = $("#composeDate").value || undefined;   // real call date (TASK-034), else now
    const r = await api.post("/calls", { account_id: +$("#composeAccount").value, client_name, transcript, occurred_at });
    await refreshCalls();
    if (r.call?.id) openCall(r.call.id);
    else { const newest = state.calls[0]; if (newest) openCall(newest.id); }
  });
}

function renderLoading(name) {
  $("#detailPane").innerHTML = `
    <div class="detail-header"><div class="dh-top"><div><div class="dh-name">${esc(name)}</div></div></div></div>
    <div class="loading-state"><div class="spinner"></div><div id="loadingLine">Running the prompt…</div></div>`;
  const lines = ["Running the prompt…", "Drafting the coaching debrief…", "Drafting text, email & CRM note…"];
  let i = 0;
  const el = $("#loadingLine");
  const t = setInterval(() => { if (!document.body.contains(el)) return clearInterval(t); el.textContent = lines[++i % lines.length]; }, 900);
}

function renderEmpty() {
  $("#detailPane").innerHTML = `<div class="loading-state"><div>No calls yet — hit <b>+ New</b> to paste your first transcript.</div></div>`;
}

// ---------- workspace views ----------
// WORKSPACE MODE (2026-09-11). A settings page shares the window with the call list only if
// the call list is useful there, and on Integrations, Spend, People, Billing and Access it never
// is: it is 280px of unrelated conversation while you are pasting an API key.
//
// So a workspace view takes the whole width. `body.workspace` collapses the grid to two columns
// and hides the list pane, matching how Devin, Pipedrive and Google Drive treat settings.
//
// Full width is NOT full bleed: the content inside is capped and centred (see .view-body in the
// stylesheet). A form stretched across 1900px is worse to read than one at 280px, and the point
// of the change is readability rather than square footage.
function viewShell(title, sub, bodyHtml) {
  document.body.classList.add("workspace");
  state.currentCallId = null; renderCallList();
  $("#detailPane").innerHTML = `
    <div class="detail-header"><div class="dh-top"><div>
      <div class="dh-name">${title}</div><div class="dh-meta">${sub}</div>
    </div></div></div><div class="view-body">${bodyHtml}</div>`;
}

async function renderInsights() {
  const parts = [];
  if (state.accountFilter) parts.push(`account=${state.accountFilter}`);
  if (state.insightType) parts.push(`type=${state.insightType}`);
  const data = await api.get(`/insights${parts.length ? "?" + parts.join("&") : ""}`);
  const scoredTypes = (data.types || []).filter(t => t.n > 0);

  viewShell("Coaching Insights",
    `Averaged across ${data.scored} scored call${data.scored === 1 ? "" : "s"}${data.calls !== data.scored ? ` (${data.calls - data.scored} processed without a scorecard)` : ""}`,
    `<div class="ct-picker" style="margin-bottom:14px;">
       <button class="ct-chip ${!state.insightType ? "active" : ""}" data-insight="">All types</button>
       ${scoredTypes.map(t => `<button class="ct-chip ${String(state.insightType) === String(t.id) ? "active" : ""}" data-insight="${t.id}">${esc(t.name)} (${t.n})</button>`).join("")}
     </div>
     ${data.averages.length ? `
       <h4>Average Scorecard</h4>
       <div class="insight-note">Blue ≥ 8 · Violet 6–7 · Pink &lt; 6 — pink dimensions are practice targets.
         Each type defines its own dimensions, so compare within a type, not across.</div>
       <div class="insight-grid">${data.averages.map(([k, v, n]) => `
         <div class="insight-row"><span class="k">${esc(k)}</span>
           <span class="v" style="color:${tierColor(Math.round(v))}">${v}<span class="insight-n"> · ${n}</span></span>
           <div class="bar"><i style="width:${v * 10}%; background:${tierColor(Math.round(v))}"></i></div></div>`).join("")}</div>`
      : `<p style="color:var(--ink-400); font-size:12.5px;">No scored calls for this type yet. Types without scorecard dimensions (client, internal, vendor) never produce one — that's deliberate.</p>`}
     ${data.hurt.length ? `<h4>Recurring themes — what hurt</h4><ul>${data.hurt.slice(0, 8).map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
     ${data.lessons.length ? `<h4>Recurring lessons</h4><ul>${data.lessons.slice(0, 8).map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}`);

  document.querySelectorAll("[data-insight]").forEach(b => b.addEventListener("click", () => {
    state.insightType = b.dataset.insight || null;
    renderInsights();
  }));
}

async function renderSuggestions() {
  const { suggestions } = await api.get("/suggestions");
  viewShell("Prompt Suggestions", "Weekly analysis of your edits — nothing changes without your approval",
    suggestions.length ? suggestions.map(s => `
      <div class="integration-row"><div>
        <div class="integration-name">${esc(s.tone || "master")} · week of ${esc(s.week_of)}</div>
        <div class="integration-sub">${esc(s.analysis)}</div></div>
        ${s.status === "pending"
          ? `<div style="display:flex; gap:6px;">
              <button class="copy-btn" data-sug="${s.id}" data-status="accepted">Accept</button>
              <button class="sent-btn" data-sug="${s.id}" data-status="rejected">Reject</button></div>`
          : `<span class="status-chip ${s.status === "accepted" ? "status-on" : "status-off"}">${s.status}</span>`}
      </div>`).join("")
    : `<p>No suggestions yet. Once ~10 edits accumulate for a tone, the Sunday analysis proposes a prompt update here.</p>`);
  document.querySelectorAll("[data-sug]").forEach(btn => btn.addEventListener("click", async () => {
    await api.patch(`/suggestions/${btn.dataset.sug}`, { status: btn.dataset.status });
    renderSuggestions();
  }));
}

async function renderTemplates() {
  const [{ call_types }, { templates }, mdl] = await Promise.all([
    api.get("/call-types"), api.get("/templates"),
    // The picker is a convenience; the prompts are the point. If /model fails, degrade to
    // hiding the picker rather than taking the whole Prompt Library down with it.
    api.get("/model").catch(() => null)
  ]);
  const models = mdl && mdl.models ? mdl.models : null;
  state.callTypes = call_types;

  // Pattern borrowed from Grain's Templates settings: a list of types, each a row with name,
  // description, what it produces, and an Edit action that opens the prompt editor.
  const row = t => `<div class="ct-row" data-ct="${t.id}">
      <div class="ct-main">
        <div class="ct-name">${esc(t.name)}${t.is_default ? '<span class="ct-badge">Default</span>' : ""}</div>
        <div class="ct-desc">${esc(t.description || "No description")}</div>
      </div>
      <div class="ct-meta">${ctSummary(t)}</div>
      <button class="regen-btn" data-ctedit="${t.id}">Edit</button>
    </div>`;

  viewShell("Prompt Library",
    "One prompt per kind of call. Label a call, and Generate uses that prompt — so a team call isn't graded like a sales call.",
    `${!models ? "" : `<div class="model-pick">
       <div class="mp-head">
         <span class="mp-title">Model</span>
         <span class="mp-note">Applies to every generation. Switch back any time \u2014 nothing else changes.</span>
       </div>
       <div class="mp-grid">${Object.entries(models).map(([id, m]) => `
         <button class="mp-card ${id === mdl.current ? "on" : ""}" data-model="${id}">
           <span class="mp-name">${esc(m.label)}${id === mdl.default ? '<span class="ct-badge">Default</span>' : ""}</span>
           <span class="mp-tier">${esc(m.tier)}</span>
           <span class="mp-price">$${m.inPerM} in / $${m.outPerM} out <span class="mp-per">per 1M tokens</span></span>
           <span class="mp-desc">${esc(m.note)}</span>
         </button>`).join("")}</div>
       <div class="mp-effort">
         <span class="mp-elabel">Reasoning</span>
         <div class="mp-eseg">${Object.entries(mdl.efforts).map(([k, e]) => `
           <button class="mp-eopt ${k === mdl.effort ? "on" : ""}" data-effort="${k}"
                   title="${esc(e.note)}">${esc(e.label)}</button>`).join("")}</div>
         <span class="mp-enote" id="mpENote"></span>
       </div>
       <div class="mp-cmp" id="mpCmp"></div>
     </div>`}
     <div class="ct-list">${call_types.map(row).join("")}</div>
     <button class="primary-btn" id="ctNew" style="margin:14px 0 22px;">+ New call type</button>
     <div id="ctEditor"></div>
     <details style="margin-top:18px;"><summary style="cursor:pointer; font-size:12px; color:var(--ink-400);">Legacy master prompt (v${templates.filter(t=>!t.tone)[0]?.version ?? "—"}) — kept for reference</summary>
       <p style="font-size:12px; color:var(--ink-400);">The Sales call type was seeded from this. Editing call types above is what affects generation now.</p>
     </details>`);

  document.querySelectorAll("[data-ctedit]").forEach(b => b.addEventListener("click", () =>
    openTypeEditor(call_types.find(t => t.id === +b.dataset.ctedit))));
  $("#ctNew").addEventListener("click", () => openTypeEditor(null));

  // Show the cost delta against the CURRENT choice, not against the cheapest — the question
  // Ivan is actually asking is "what does switching cost me", not "which is cheapest".
  if (!models) return;
  const cur = models[mdl.current] || Object.values(models)[0];
  const u = mdl.usage || { runs: 0 };

  // Real cost, from this account's own generations. Cached input bills at ~10% of the input
  // rate, so a run with a big cached prefix is genuinely cheaper — folding that in matters
  // now that the worked example (TASK-096) is a cached prefix on every debrief.
  const per = m => {
    const fresh = Math.max(0, u.inAvg - u.cacheAvg);
    return (fresh / 1e6) * m.inPerM + (u.cacheAvg / 1e6) * m.inPerM * 0.1
         + (u.outAvg / 1e6) * m.outPerM;
  };
  const money = n => n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;

  $("#mpCmp").textContent = u.runs === 0
    ? "No generations logged yet, so there is no average to price against. Run one and this fills in with your real numbers."
    : `Your last ${u.runs} generation${u.runs === 1 ? "" : "s"} averaged `
      + `${u.inAvg.toLocaleString()} in / ${u.outAvg.toLocaleString()} out`
      + (u.cacheAvg ? ` (${u.cacheAvg.toLocaleString()} cached)` : "")
      + `. That is ${money(per(cur))} per call on ${cur.label} \u2014 `
      + Object.entries(models).filter(([id]) => id !== mdl.current)
          .map(([, m]) => `${m.label} ${money(per(m))}`).join(", ") + ".";

  const eNote = () => {
    const e = mdl.efforts[mdl.effort];
    const forced = cur.thinking === "always-on"
      || (cur.thinking === "optional-capped" && (mdl.effort === "xhigh" || mdl.effort === "max"));
    $("#mpENote").textContent = e.note + (forced && cur.thinking === "optional-capped"
      ? " Thinking is on at this level, so expect more output tokens than the average above."
      : "");
  };
  eNote();

  document.querySelectorAll("[data-effort]").forEach(b => b.addEventListener("click", async () => {
    if (b.classList.contains("on")) return;
    try {
      await api.req("PUT", "/effort", { effort: b.dataset.effort });
      toast(`Reasoning set to ${mdl.efforts[b.dataset.effort].label}`);
      renderTemplates();
    } catch (e) { toast("Could not change the reasoning level"); }
  }));

  document.querySelectorAll("[data-model]").forEach(b => b.addEventListener("click", async () => {
    if (b.classList.contains("on")) return;
    b.disabled = true;
    try {
      await api.req("PUT", "/model", { model: b.dataset.model });
      toast(`Now generating with ${models[b.dataset.model].label}`);
      renderTemplates();
    } catch (e) { toast("Could not switch model"); b.disabled = false; }
  }));
}

function ctSummary(t) {
  const dims = (() => { try { return JSON.parse(t.dimensions_json || "[]"); } catch { return []; } })();
  const bits = [];
  bits.push(dims.length ? `${dims.length}-point scorecard` : "No scorecard");
  if (t.produces_messages) bits.push("text + email");
  if (t.produces_crm_note) bits.push("CRM note");
  return bits.join(" · ");
}

// Editor modelled on Sana AI's template modal: identity on the left, the prompt itself given
// the most room, since that's the thing you actually iterate on.
function openTypeEditor(t) {
  const dims = (() => { try { return JSON.parse(t?.dimensions_json || "[]"); } catch { return []; } })();
  $("#ctEditor").innerHTML = `
    <div class="ct-editor">
      <div class="ct-editor-head">${t ? "Edit" : "New"} call type</div>
      <div class="ct-editor-grid">
        <div class="ct-editor-side">
          <label>Name</label>
          <input type="text" id="ctName" value="${esc(t?.name || "")}" placeholder="e.g. Discovery call">
          <label>Description</label>
          <input type="text" id="ctDesc" value="${esc(t?.description || "")}" placeholder="When to use this">
          <label>Scorecard dimensions</label>
          <textarea id="ctDims" rows="6" placeholder="One per line. Leave empty for no scorecard.">${esc(dims.join("\n"))}</textarea>
          <div class="ct-hint">Leave empty and this type gets no scorecard — right for internal and client calls.</div>
          <label class="ct-check"><input type="checkbox" id="ctMsgs" ${!t || t.produces_messages ? "checked" : ""}> Generate follow-up text + email</label>
          <label class="ct-check"><input type="checkbox" id="ctCrm" ${!t || t.produces_crm_note ? "checked" : ""}> Generate CRM note</label>
        </div>
        <div class="ct-editor-main">
          <label>Prompt</label>
          <textarea id="ctPrompt" placeholder="Write the instructions for this kind of call…">${esc(t?.prompt_body || "")}</textarea>
        </div>
      </div>
      <div class="ct-editor-foot">
        ${t && !t.is_default ? `<button class="regen-btn danger-btn" id="ctDelete">Remove type</button>` : ""}
        <span style="flex:1"></span>
        <button class="regen-btn" id="ctCancel">Cancel</button>
        <button class="primary-btn" id="ctSave">${t ? "Save changes" : "Create type"}</button>
      </div>
    </div>`;
  $("#ctEditor").scrollIntoView({ behavior: "smooth", block: "nearest" });

  $("#ctCancel").addEventListener("click", () => { $("#ctEditor").innerHTML = ""; });
  const del = $("#ctDelete");
  if (del) del.addEventListener("click", async () => {
    if (!confirm(`Remove "${t.name}"? Calls already labelled with it keep their outputs.`)) return;
    try { await api.req("DELETE", `/call-types/${t.id}`); toast("Call type removed"); renderTemplates(); }
    catch (e) { toast(e.message); }
  });
  $("#ctSave").addEventListener("click", async () => {
    const body = {
      name: $("#ctName").value.trim(),
      description: $("#ctDesc").value.trim(),
      prompt_body: $("#ctPrompt").value,
      dimensions: $("#ctDims").value.split("\n").map(x => x.trim()).filter(Boolean),
      produces_messages: $("#ctMsgs").checked,
      produces_crm_note: $("#ctCrm").checked
    };
    if (!body.name) return toast("Give it a name");
    try {
      if (t) await api.put(`/call-types/${t.id}`, body);
      else await api.post("/call-types", body);
      toast(t ? "Call type saved" : "Call type created");
      renderTemplates();
    } catch (e) { toast(e.message); }
  });
}

async function renderActivity() {
  const { events, totals, today, week, month, reliability, model } = await api.get("/events?limit=200");
  // Priced at the model this account ACTUALLY runs, sent by the server. It was hardcoded to
  // Sonnet 5 ($3/$15) and stayed that way after TASK-098 made the model a setting and the
  // default moved to Opus 5 ($5/$25) — so every figure on this page understated real spend by
  // about 65%. Never reintroduce a rate constant here; the server owns the price table.
  const IN_PER_M = model?.inPerM ?? 3, OUT_PER_M = model?.outPerM ?? 15;
  // Cached input is REAL SPEND and was priced at zero here until 2026-08-05. Since TASK-096 every
  // debrief carries a cached specimen prefix, and the TASK-105 chat sends the whole debrief as a
  // cached block — a live chat turn reported 42 fresh input tokens against a ~10k-token prefix,
  // so almost the entire cost of a turn was invisible on this page. Anthropic's multipliers:
  // a cache WRITE bills 1.25x the input rate, a cache READ 0.1x.
  const CACHE_WRITE_MULT = 1.25, CACHE_READ_MULT = 0.1;
  const cost = (inp, outp, cr, cw) => `$${(
    (inp || 0) / 1e6 * IN_PER_M +
    (outp || 0) / 1e6 * OUT_PER_M +
    (cr || 0) / 1e6 * IN_PER_M * CACHE_READ_MULT +
    (cw || 0) / 1e6 * IN_PER_M * CACHE_WRITE_MULT
  ).toFixed(2)}`;

  const rows = events.length ? events.map(e => {
    const cls = e.level === "error" ? "ev-error" : e.level === "warn" ? "ev-warn" : "ev-info";
    const bits = [];
    if (e.duration_ms) bits.push(`${(e.duration_ms / 1000).toFixed(1)}s`);
    if (e.input_tokens) bits.push(`${e.input_tokens.toLocaleString()} in / ${(e.output_tokens || 0).toLocaleString()} out`);
    if (e.cache_read_tokens) bits.push(`${e.cache_read_tokens.toLocaleString()} cached`);
    return `<tr class="${cls}">
      <td class="ev-at">${esc(e.at)}</td>
      <td><span class="ev-kind">${esc(e.kind)}</span></td>
      <td>${esc(e.detail || "")}</td>
      <td class="ev-meta">${bits.join(" · ")}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="4" style="color:var(--ink-400); padding:14px;">Nothing logged yet.</td></tr>`;

  const runsLabel = n => `${n || 0} generation${n === 1 ? "" : "s"}`;
  // UI CLEANUP 2026-08-05. This page had THREE stacked stat strips from three eras — TASK-076
  // spend cards, the TASK-102 reliability row, and the original ev-summary — and they disagreed
  // with each other on the same screen: "5 runs · 3 errors" beside "5 GENERATIONS / 3 ERROR
  // EVENTS", a 55s average beside a 54.7s one, an all-time total beside an input-only estimate.
  // Three sources for one fact is zero sources. ONE strip now: health first (if generation is
  // failing nothing else on the page matters), then volume, then cost — each fact exactly once.
  const rel = reliability?.d30 || reliability?.all;
  const okRate = rel && rel.started ? rel.succeeded / rel.started : null;
  const healthTone = okRate === null ? "" : okRate >= 0.95 ? "" : okRate >= 0.8 ? "warn" : "bad";
  const problems = rel ? rel.failed + rel.vanished : 0;
  const avgSecs = totals?.avg_ms ? (totals.avg_ms / 1000).toFixed(1) + "s" : "—";
  const strip = `<div class="spend-row">
      <div class="spend-card"><div class="spend-k">Health · 30d</div>
        <div class="spend-v ${healthTone}">${okRate === null ? "—" : Math.round(okRate * 100) + "%"}</div>
        <div class="spend-sub">${rel && rel.started ? `${rel.succeeded} of ${rel.started} succeeded` : "no runs in 30 days"}</div></div>
      ${problems ? `<div class="spend-card"><div class="spend-k">Problems · 30d</div>
        <div class="spend-v bad">${problems}</div>
        <div class="spend-sub">${rel.failed} failed${rel.vanished ? ` · ${rel.vanished} vanished` : ""}</div></div>` : ""}
      <div class="spend-card"><div class="spend-k">Runs</div>
        <div class="spend-v">${totals?.runs || 0}</div>
        <div class="spend-sub">${avgSecs} avg · ${totals?.failures || 0} error events</div></div>
      <div class="spend-card"><div class="spend-k">Tokens</div>
        <div class="spend-v">${((totals?.input_tokens || 0) / 1000).toFixed(0)}k</div>
        <div class="spend-sub">in · ${((totals?.output_tokens || 0) / 1000).toFixed(0)}k out</div></div>
      <div class="spend-card"><div class="spend-k">Cost · 7d</div>
        <div class="spend-v">${cost(week?.input_tokens, week?.output_tokens, week?.cache_read_tokens, week?.cache_write_tokens)}</div>
        <div class="spend-sub">${runsLabel(week?.runs)}</div></div>
      <div class="spend-card"><div class="spend-k">Cost · all time</div>
        <div class="spend-v">${cost(totals?.input_tokens, totals?.output_tokens, totals?.cache_read_tokens, totals?.cache_write_tokens)}</div>
        <div class="spend-sub">${totals?.runs ? cost((totals.input_tokens || 0) / totals.runs, (totals.output_tokens || 0) / totals.runs,
              (totals.cache_read_tokens || 0) / totals.runs, (totals.cache_write_tokens || 0) / totals.runs) + " / call" : "—"}</div></div>
    </div>
    <div class="insight-note">Estimated from tokens this app logged, at ${esc(model?.label || "current model")} list pricing, cached input included at Anthropic's reduced rates. It counts Closer's spend only — the billed total lives in the Anthropic console, which has no API for it.${
      rel && rel.attempts > rel.started ? ` ${rel.attempts} attempts for ${rel.started} runs — every attempt bills for whatever it produced before it stopped.` : ""}</div>`;

  viewShell("Activity", "Everything the app has done — failures, completions, token spend, and which outputs actually get used",
    strip + `
     <div class="ev-filters">
       <button class="chip" data-evfilter="">All</button>
       <button class="chip" data-evfilter="level=error">Failures only</button>
       <button class="chip" data-evfilter="kind=generation">Generation</button>
       <button class="chip" data-evfilter="kind=fathom">Fathom</button>
       <button class="chip" data-evfilter="kind=output">Copies &amp; sends</button>
     </div>
     <div style="overflow-x:auto;"><table class="ev-table"><tbody>${rows}</tbody></table></div>`);

  document.querySelectorAll("[data-evfilter]").forEach(b => b.addEventListener("click", async () => {
    const q = b.dataset.evfilter;
    const { events } = await api.get(`/events?limit=200${q ? "&" + q : ""}`);
    const tb = document.querySelector(".ev-table tbody");
    tb.innerHTML = events.length ? events.map(e => `<tr class="${e.level === "error" ? "ev-error" : e.level === "warn" ? "ev-warn" : "ev-info"}">
        <td class="ev-at">${esc(e.at)}</td><td><span class="ev-kind">${esc(e.kind)}</span></td>
        <td>${esc(e.detail || "")}</td>
        <td class="ev-meta">${e.duration_ms ? (e.duration_ms/1000).toFixed(1)+"s " : ""}${e.input_tokens ? e.input_tokens.toLocaleString()+" in" : ""}</td></tr>`).join("")
      : `<tr><td colspan="4" style="color:var(--ink-400); padding:14px;">Nothing matches.</td></tr>`;
  }));
}

// ---------------------------------------------------------------- Spend (TASK-110)
//
// Activity says whether it worked. Spend says what it cost. They are separate pages because
// the last time this app put two questions on one surface it grew three stat strips that
// contradicted each other on screen.
//
// THE ONE RULE ON THIS PAGE: never blend a measured number with an inferred one.
// Imported figures are Anthropic's own billing export and are spend. Logged figures are our
// estimate for the days no export covers yet. They are added up separately and labelled
// differently, because the reconciliation behind them is not uniformly good — before
// 2026-07-30 our log captured as little as 24% of what was actually billed.

// No chart library: a strict CSP blocks external scripts, and a stacked bar chart is a few
// divs. Colours are fixed per model so a model keeps its colour between views.
const MODEL_COLOR = {
  "claude-opus-5":   "var(--blue-500)",
  "claude-fable-5":  "var(--violet-500)",
  // Literal rather than a var: there is no green in the palette, and the two brand colours
  // are already spoken for. Chosen to read on both the dark and light themes.
  "claude-sonnet-5": "#2FB39A",
};
const FALLBACK_COLORS = ["#D08A32", "#B4436C", "#3F8FA8", "#8A8F98", "#7A6BD8"];
function modelColor(id, i) { return MODEL_COLOR[id] || FALLBACK_COLORS[i % FALLBACK_COLORS.length]; }

// Sub-cent spend is real and common here — a chat turn costs fractions of a penny — so
// rounding everything to 2dp would render most of this page as "$0.00" and look broken.
const money = n => {
  const v = +n || 0;
  if (v === 0) return "$0";
  if (v < 0.01) return "<$0.01";
  if (v < 10) return "$" + v.toFixed(2);
  return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const tok = n => {
  const v = +n || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return Math.round(v / 1e3) + "k";
  return String(v);
};

const SPEND_VIEWS = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"]];

async function renderSpend() {
  const view = state.spendView || "day";
  const d = await api.get(`/spend?view=${view}`);
  const models = d.models || [];
  const buckets = d.buckets || [];
  const peak = Math.max(...buckets.map(b => b.total.usd), 0.0001);

  const legend = models.map((m, i) =>
    `<span class="sp-leg"><i style="background:${modelColor(m.id, i)}"></i>${esc(m.label)}
       <b>${money(m.usd)}</b>${m.priced ? "" : ` <em class="sp-unpriced">unpriced</em>`}</span>`).join("");

  // Stacked bars. Height is share-of-peak so the tallest bucket fills the plot — an absolute
  // scale would flatten every day to nothing the first time one big month lands in the window.
  const chart = buckets.length ? buckets.map(b => {
    const segs = models.map((m, i) => {
      const v = b.byModel[m.id]?.usd || 0;
      if (!v) return "";
      return `<div class="sp-seg" style="height:${(v / b.total.usd) * 100}%; background:${modelColor(m.id, i)}"
                   title="${esc(m.label)} · ${money(v)}"></div>`;
    }).join("");
    return `<div class="sp-col" title="${esc(b.label)} · ${money(b.total.usd)}">
        <div class="sp-bar-wrap"><div class="sp-bar" style="height:${Math.max(2, (b.total.usd / peak) * 100)}%">${segs}</div></div>
        <div class="sp-x">${esc(b.label)}</div>
      </div>`;
  }).join("") : `<div class="sp-empty">No imported usage yet. Import an export below to see spend.</div>`;

  const t = d.total || {};
  // A cache read bills 0.1x, so the 0.9x it did not cost is the saving. Writes bill 1.25x —
  // a 0.25x premium paid UP FRONT on the bet that the prefix gets read back before its TTL.
  const cacheSaved = (t.cacheRead || 0) * 9;
  const cachePremium = (t.cacheWrite || 0) * 0.2;   // the 0.25x premium is 20% of the 1.25x paid
  // The first run of this page found the bet has never paid off once: 23,553 tokens written,
  // zero read, across the entire billing history. Caching that is never hit is not free — it
  // is a 25% surcharge on those tokens. A card that showed "$0 saved" and stopped there would
  // have hidden that, so when there are no reads the card reports the premium instead.
  const cacheNeverRead = (t.cacheWrite || 0) > 0 && (t.cacheRead || 0) === 0;
  const rec = d.reconciliation || {};
  const live = d.live || {};

  const cards = `<div class="spend-row">
      <div class="spend-card"><div class="spend-k">Spend · window</div>
        <div class="spend-v">${money(t.usd)}</div>
        <div class="spend-sub">${buckets.length} ${view}${buckets.length === 1 ? "" : "s"}${d.imported?.from ? ` · ${esc(d.imported.from)}–${esc(d.imported.to)}` : ""}</div></div>
      <div class="spend-card"><div class="spend-k">Output</div>
        <div class="spend-v">${money(t.output)}</div>
        <div class="spend-sub">${tok(t.tokensOut)} tokens · ${t.usd ? Math.round((t.output / t.usd) * 100) : 0}% of spend</div></div>
      <div class="spend-card"><div class="spend-k">Input</div>
        <div class="spend-v">${money((t.input || 0) + (t.cacheWrite || 0) + (t.cacheRead || 0))}</div>
        <div class="spend-sub">${tok(t.tokensIn)} tokens · ${money(t.cacheWrite)} cache writes</div></div>
      ${cacheNeverRead
        ? `<div class="spend-card"><div class="spend-k">Cache · never read</div>
             <div class="spend-v warn">${money(cachePremium)}</div>
             <div class="spend-sub">written every run, read back zero times</div></div>`
        : `<div class="spend-card"><div class="spend-k">Saved by caching</div>
             <div class="spend-v">${money(cacheSaved)}</div>
             <div class="spend-sub">${money(t.cacheRead)} of reads at 0.1×</div></div>`}
      ${live.days?.length ? `<div class="spend-card"><div class="spend-k">Since last export</div>
        <div class="spend-v est">${money(live.usd)}</div>
        <div class="spend-sub">estimate · ${live.days.length} day${live.days.length === 1 ? "" : "s"} not yet billed</div></div>` : ""}
    </div>`;

  // The per-model table is the answer to "broken down by model" in a form you can read a
  // number off, which a chart is not.
  const rows = models.length ? models.map((m, i) => `<tr>
      <td><i class="sp-dot" style="background:${modelColor(m.id, i)}"></i>${esc(m.label)}
          <span class="sp-id">${esc(m.id)}</span></td>
      <td class="sp-num">${money(m.usd)}</td>
      <td class="sp-num">${t.usd ? ((m.usd / t.usd) * 100).toFixed(1) + "%" : "—"}</td>
      <td class="sp-num">${tok(m.tokensIn)}</td>
      <td class="sp-num">${tok(m.tokensOut)}</td>
      <td class="sp-num">${money(m.output)}</td>
    </tr>`).join("") : `<tr><td colspan="6" style="color:var(--ink-400); padding:14px;">Nothing imported yet.</td></tr>`;

  // Reconciliation is on the page rather than in a doc because it is the reason to believe
  // any of the rest of it, and because it is the first thing to check if the two ever part.
  const recNote = !rec.daysCompared ? ""
    : rec.exactDays === 0
      ? `Closer's own log does not currently match this export on any day, so the figures above come from the export alone.`
      : `Checked against Anthropic's export on ${rec.daysCompared} day${rec.daysCompared === 1 ? "" : "s"}; ${rec.exactDays} match to the token.${
          rec.trustedFrom ? ` Closer's log has been accurate since ${esc(rec.trustedFrom)}, which is what makes the estimate above worth showing.` : ""}`;

  viewShell("Spend",
    "What Closer actually costs to run — billed dollars by day, week, month and year, split by model",
    `<div class="ct-picker" style="margin-bottom:12px;">
       ${SPEND_VIEWS.map(([v, label]) => `<button class="ct-chip ${view === v ? "active" : ""}" data-spendview="${v}">${label}</button>`).join("")}
       <span class="subnav-actions"><button class="chip" id="spImportBtn">Import usage export</button></span>
     </div>
     ${cards}
     ${models.length ? `<div class="sp-legend">${legend}</div>` : ""}
     <div class="sp-chart">${chart}</div>
     <div style="overflow-x:auto;"><table class="ev-table sp-table"><thead><tr>
        <th>Model</th><th class="sp-num">Spend</th><th class="sp-num">Share</th>
        <th class="sp-num">In</th><th class="sp-num">Out</th><th class="sp-num">Output cost</th>
     </tr></thead><tbody>${rows}</tbody></table></div>
     <div class="insight-note">Priced at Anthropic list rates checked ${esc(d.rates?.checked || "")} — cache writes at 1.25× input (2× for 1-hour TTL), cache reads at 0.1×. Sonnet 5 bills at its introductory $2/$10 through 2026-08-31, so July is priced at the rate it was actually charged, not today's. ${recNote}</div>
     <div id="spImport" class="sp-import" hidden>
       <h4>Import usage export</h4>
       <div class="insight-note">platform.claude.com › Usage › Export. Re-importing an overlapping month is safe — rows are replaced, not added.</div>
       <input type="file" id="spFile" accept=".csv,text/csv">
       <textarea id="spPaste" placeholder="…or paste the CSV here"></textarea>
       <div><button class="chip" id="spDoImport">Import</button> <span id="spMsg" class="sp-msg"></span></div>
     </div>`);

  document.querySelectorAll("[data-spendview]").forEach(b => b.addEventListener("click", () => {
    state.spendView = b.dataset.spendview;
    renderSpend();
  }));
  $("#spImportBtn").addEventListener("click", () => {
    const p = $("#spImport"); p.hidden = !p.hidden;
    if (!p.hidden) p.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  $("#spFile").addEventListener("change", async e => {
    const f = e.target.files?.[0]; if (!f) return;
    $("#spPaste").value = await f.text();
    $("#spMsg").textContent = `${f.name} loaded — press Import.`;
  });
  $("#spDoImport").addEventListener("click", async () => {
    const text = $("#spPaste").value.trim();
    const msg = $("#spMsg");
    if (!text) { msg.textContent = "Choose a file or paste the CSV first."; return; }
    msg.textContent = "Importing…";
    try {
      const r = await api.postText("/spend/import", text);
      msg.textContent = `Imported ${r.rows} rows, ${r.from} to ${r.to}.`;
      state.spendView = view;
      setTimeout(renderSpend, 600);
    } catch (err) {
      msg.textContent = String(err?.message || err);
    }
  });
}

// ---------------------------------------------------------------- Billing (TASK-122)
//
// What this page is for: generating a checkout link to send a buyer, and opening Stripe's own
// portal to manage an existing subscription. That is deliberately ALL it does.
//
// > There is no card field on this page and there must never be one. Every card detail is
// > entered on Stripe's domain, on a page Stripe hosts. Nothing sensitive touches this app, this
// > database, or a support conversation — which is also why nobody here has to think about PCI.
//
// It is not a self-serve signup flow. At this price the product is sold on a call; the link is
// generated for a named buyer after they say yes.
async function renderBilling() {
  const d = await api.get("/billing");
  const b = d.billing;
  const c = d.configured || {};

  // Name what is missing. A billing page that just looks empty is indistinguishable from a
  // broken one, and this is the page somebody opens when a payment did not arrive.
  const missing = [
    !c.secretKey && ["STRIPE_SECRET_KEY", "the API key, from Stripe → Developers → API keys"],
    !c.webhookSecret && ["STRIPE_WEBHOOK_SECRET", "the signing secret for the webhook endpoint"],
    !c.seatPrice && ["STRIPE_PRICE_SEAT", "the Price ID of the per-seat monthly price"],
  ].filter(Boolean);

  const setupNote = missing.length
    ? `<div class="insight-note" style="border-left:3px solid var(--pink-500);padding-left:10px;">
         <strong>Not connected yet.</strong> ${missing.length} secret${missing.length === 1 ? "" : "s"} still to set with
         <code>npx wrangler secret put NAME</code>:
         <ul style="margin:6px 0 0 16px;">${missing.map(([k, why]) => `<li><code>${k}</code> — ${esc(why)}</li>`).join("")}</ul>
         ${c.activationPrice ? "" : `<div style="margin-top:6px;">Optional: <code>STRIPE_PRICE_ACTIVATION</code> — the one-time activation fee. Without it, checkout charges the subscription only.</div>`}
       </div>`
    : `<div class="insight-note">Connected to Stripe. ${c.activationPrice ? "Checkout charges the activation fee and starts the subscription in one payment." : "No activation price is set, so checkout charges the subscription only."}</div>`;

  const statusChip = b?.status
    ? `<span class="status-chip ${b.status === "active" ? "" : "status-off"}">${esc(b.status)}</span>`
    : `<span class="status-chip status-off">no subscription</span>`;

  viewShell("Billing",
    "Send a buyer a payment link, and let them manage their own card afterwards. No card details ever reach this app.",
    `${setupNote}
     <div class="spend-row">
       <div class="spend-card"><div class="spend-k">Status</div>
         <div class="spend-v" style="font-size:18px;">${statusChip}</div>
         <div class="spend-sub">${b?.billing_email ? esc(b.billing_email) : "nobody has been through checkout yet"}</div></div>
       <div class="spend-card"><div class="spend-k">Seats</div>
         <div class="spend-v">${b?.seats ?? "—"}</div>
         <div class="spend-sub">billed monthly, per seat</div></div>
       <div class="spend-card"><div class="spend-k">Paid through</div>
         <div class="spend-v" style="font-size:18px;">${b?.current_period_end ? esc(b.current_period_end.slice(0, 10)) : "—"}</div>
         <div class="spend-sub">${b?.status === "past_due" ? "payment failed — Stripe is retrying the card" : "renews automatically"}</div></div>
     </div>

     <h4 class="pp-h">Send a payment link</h4>
     <div class="sp-import" style="display:block;">
       <div class="insight-note">Creates a Checkout link on Stripe's own domain. Send it to the buyer; they pay there. You never see or type a card.</div>
       <div class="bl-fields">
         <label class="bl-f"><span>Buyer's email</span>
           <input type="email" id="blEmail" placeholder="buyer@company.com"></label>
         <label class="bl-f bl-narrow"><span>Seats</span>
           <input type="number" id="blSeats" min="1" step="1" value="1"></label>
         <label class="bl-f bl-narrow"><span>Delay licence (days)</span>
           <input type="number" id="blTrial" min="0" step="1" placeholder="0"></label>
       </div>
       <div class="insight-note">The activation fee bills today either way. Use the delay when onboarding takes a week or two, so they are not paying for software a technician has not finished connecting.</div>
       <div><button class="chip" id="blCreate" ${missing.length ? "disabled" : ""}>Create link</button>
            <span id="blMsg" class="sp-msg"></span></div>
       <div id="blOut" hidden><textarea id="blUrl" readonly rows="2"></textarea>
         <div class="insight-note">Copy this into your email or text to them. It expires after 24 hours.</div></div>
     </div>

     <h4 class="pp-h">Manage an existing subscription</h4>
     <div class="insight-note">Opens Stripe's billing portal, where the customer updates their card, downloads invoices, changes seats and cancels — without going through us.</div>
     <button class="chip" id="blPortal" ${b?.stripe_customer_id ? "" : "disabled"}>Open billing portal</button>`);

  $("#blCreate")?.addEventListener("click", async () => {
    const msg = $("#blMsg");
    const email = $("#blEmail").value.trim();
    const seats = +$("#blSeats").value || 1;
    const trial = +$("#blTrial").value || 0;
    if (!email) { msg.textContent = "Enter the buyer's email."; return; }
    msg.textContent = "Creating…";
    try {
      const r = await api.post("/billing/checkout", { email, seats, trial_days: trial || undefined });
      $("#blUrl").value = r.url; $("#blOut").hidden = false;
      msg.textContent = `Link ready for ${seats} seat${seats === 1 ? "" : "s"}.`;
      $("#blUrl").select();
    } catch (e) { msg.textContent = e.message || "Could not create the link."; }
  });

  $("#blPortal")?.addEventListener("click", async () => {
    try { const r = await api.post("/billing/portal"); window.open(r.url, "_blank", "noopener"); }
    catch (e) { toast(e.message || "Could not open the portal."); }
  });
}

// ---------------------------------------------------------------- People (TASK-118)
//
// The manager tier. Nathan's third and fourth conditions: scores across the team in one place,
// and the ability to click into any individual.
//
// > RAW NUMBERS ONLY. There are no targets, no benchmarks and no red/green here, and that is a
// > product decision, not an oversight. Gabriel stopped Ivan mid-sentence on the 09-09 call:
// > "What a healthy number is, is something that Nathan's going to be able to figure out. That's
// > on him. I'm just presenting him the raw data." If you are about to colour a score, don't.
//
// Every average is rendered WITH the number of calls under it. The first run of this page found
// a dimension called "objection buildup" averaging 1.0 — invented by the model on a single call.
// Sorted by score with no sample size it reads as a catastrophic weakness. It is a typo with an
// n of 1. That is why the count is not optional decoration.
const PEOPLE_WINDOWS = [["week", "Week"], ["month", "Month"], ["half", "6 months"], ["year", "Year"], ["all", "All time"]];

const scoreBar = (avg, max = 10) =>
  `<span class="pp-bar"><span class="pp-bar-fill" style="width:${Math.max(0, Math.min(100, (avg / max) * 100))}%"></span></span>`;

const nCalls = n => `${n} call${n === 1 ? "" : "s"}`;

async function renderPeople() {
  const view = state.peopleView || "month";
  if (state.peopleRep !== undefined) return renderPerson();

  const d = await api.get(`/people?view=${encodeURIComponent(view)}`);
  const t = d.totals || {};

  const rows = d.people.length ? d.people.map(p => {
    const mix = (p.byType || []).map(x => `${esc(x.type)} ${x.n}`).join(" · ");
    return `<tr class="pp-row" data-rep="${esc(p.email || "")}">
      <td title="${esc(p.email || "no owner recorded on these calls")}"><span class="pp-name">${esc(p.name)}</span>${p.email ? "" : `<span class="pp-noowner">no owner recorded</span>`}</td>
      <td class="sp-num">${p.calls}</td>
      <td class="sp-num">${p.scored}</td>
      <td class="sp-num">${p.avgScore === null ? "—" : p.avgScore.toFixed(1)}</td>
      <td class="sp-num">${Math.round(p.minutes / 60)}h</td>
      <td class="sp-num">${esc(p.lastCall || "—")}</td>
      <td class="pp-mix">${mix || "—"}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="7" class="sp-empty">No calls in this window.</td></tr>`;

  viewShell("People",
    "Every person who ran a call, and what their calls scored. Raw numbers — what a good number is, is your call.",
    `<div class="ct-picker" style="margin-bottom:12px;">
       ${PEOPLE_WINDOWS.map(([v, label]) => `<button class="ct-chip ${view === v ? "active" : ""}" data-peopleview="${v}">${label}</button>`).join("")}
     </div>
     <div class="spend-row">
       <div class="spend-card"><div class="spend-k">People</div>
         <div class="spend-v">${t.people || 0}</div>
         <div class="spend-sub">ran a call in the ${esc((d.window || "").toLowerCase())}</div></div>
       <div class="spend-card"><div class="spend-k">Calls</div>
         <div class="spend-v">${t.calls || 0}</div>
         <div class="spend-sub">${Math.round((t.minutes || 0) / 60)} hours on the phone</div></div>
       <div class="spend-card"><div class="spend-k">Scored</div>
         <div class="spend-v">${t.scored || 0}</div>
         <div class="spend-sub">${t.calls ? Math.round((t.scored / t.calls) * 100) : 0}% of calls have a scorecard</div></div>
     </div>
     <div style="overflow-x:auto;"><table class="ev-table sp-table pp-table"><thead><tr>
        <th>Person</th><th class="sp-num">Calls</th><th class="sp-num">Scored</th>
        <th class="sp-num">Avg</th><th class="sp-num">Hours</th><th class="sp-num">Last call</th><th>Call types</th>
     </tr></thead><tbody>${rows}</tbody></table></div>
     <div class="insight-note">Click a person to see their dimensions and how they have moved. "Avg" is the mean of every scorecard dimension across their scored calls in this window — a blend, not a grade. Calls without a scorecard (internal, vendor, or not yet generated) are counted in Calls and excluded from Avg.</div>`);

  document.querySelectorAll("[data-peopleview]").forEach(b => b.addEventListener("click", () => {
    state.peopleView = b.dataset.peopleview;
    renderPeople();
  }));
  // dataset.rep is "" for the unattributed group, which is a real group. Storing "" rather than
  // undefined is what lets renderPerson tell "the no-owner bucket" from "no person selected".
  document.querySelectorAll(".pp-row").forEach(r => r.addEventListener("click", () => {
    state.peopleRep = r.dataset.rep;
    renderPeople();
  }));
}

async function renderPerson() {
  const view = state.peopleView || "month";
  const rep = state.peopleRep;
  const d = await api.get(`/people?view=${encodeURIComponent(view)}&rep=${encodeURIComponent(rep)}`);

  const dims = d.dimensions.length ? d.dimensions.map(x => `<tr>
      <td>${esc(x.dim)}</td>
      <td class="pp-barcell">${scoreBar(x.avg)}</td>
      <td class="sp-num">${x.avg === null ? "—" : x.avg.toFixed(1)}</td>
      <td class="sp-num">${x.low}–${x.high}</td>
      <td class="sp-num">${x.n}</td>
    </tr>`).join("") : `<tr><td colspan="5" class="sp-empty">No scored calls in this window.</td></tr>`;

  // The trend is Ivan's "health bar": one column per bucket, so a dimension moving is visible as
  // movement rather than as a single blended number that hides which part changed.
  const maxN = Math.max(1, ...d.trend.map(t => t.n));
  const trend = d.trend.length ? d.trend.map(t => `<div class="sp-col" title="${esc(t.label)} · ${t.avg} avg over ${nCalls(Math.round(t.n / Math.max(1, d.dimensions.length)))}">
      <div class="sp-bar-wrap"><div class="pp-tbar" style="height:${(t.avg / 10) * 100}%"></div></div>
      <div class="pp-tlabel">${esc(t.label)}</div>
    </div>`).join("") : `<div class="sp-empty">Nothing to plot yet.</div>`;

  const calls = d.calls.length ? d.calls.map(c => `<tr class="pp-callrow" data-call="${c.id}">
      <td>${esc(c.client_name || "—")}</td>
      <td>${esc(c.call_type)}</td>
      <td class="sp-num">${esc(c.occurred_at || "")}</td>
      <td class="sp-num">${c.duration_min ? c.duration_min + "m" : "—"}</td>
      <td class="sp-num">${c.avg_score === null ? "—" : c.avg_score.toFixed(1)}</td>
    </tr>`).join("") : `<tr><td colspan="5" class="sp-empty">No calls in this window.</td></tr>`;

  viewShell(esc(d.name),
    `${esc(d.window)} · ${d.calls.length} call${d.calls.length === 1 ? "" : "s"} · scored on ${d.dimensions.length} dimension${d.dimensions.length === 1 ? "" : "s"}`,
    `<div class="ct-picker" style="margin-bottom:12px;">
       <button class="chip" id="ppBack">← All people</button>
       ${PEOPLE_WINDOWS.map(([v, label]) => `<button class="ct-chip ${view === v ? "active" : ""}" data-peopleview="${v}">${label}</button>`).join("")}
     </div>
     <h4 class="pp-h">Dimensions</h4>
     <div style="overflow-x:auto;"><table class="ev-table sp-table pp-dims"><thead><tr>
        <th>Dimension</th><th></th><th class="sp-num">Avg</th><th class="sp-num">Range</th><th class="sp-num">Calls</th>
     </tr></thead><tbody>${dims}</tbody></table></div>
     <div class="insight-note">Ordered by how many calls each rests on, not by score. A dimension with a handful of calls behind it is a handful of calls, not a trend — and the model occasionally invents one, so a row with an n of 1 is usually an artifact rather than a finding.</div>
     <h4 class="pp-h">Over time</h4>
     <div class="sp-chart pp-chart">${trend}</div>
     <div class="insight-note">Mean of every dimension, per ${esc(d.bucket)}. <strong>Periods with no calls are not drawn</strong>, so two adjacent bars are not necessarily consecutive ${esc(d.bucket)}s — read the labels, not the spacing.</div>
     <h4 class="pp-h">Calls</h4>
     <div style="overflow-x:auto;"><table class="ev-table sp-table pp-calls"><thead><tr>
        <th>Client</th><th>Type</th><th class="sp-num">Date</th><th class="sp-num">Length</th><th class="sp-num">Avg</th>
     </tr></thead><tbody>${calls}</tbody></table></div>`);

  $("#ppBack").addEventListener("click", () => { state.peopleRep = undefined; renderPeople(); });
  document.querySelectorAll("[data-peopleview]").forEach(b => b.addEventListener("click", () => {
    state.peopleView = b.dataset.peopleview;
    renderPeople();
  }));
  // Straight into the call the manager is asking about. This is the "click into Bob and see what
  // he sees" half of what Ivan described, reusing the detail pane rather than rebuilding it.
  document.querySelectorAll(".pp-callrow").forEach(r => r.addEventListener("click", () => {
    state.peopleRep = undefined;
    openCall(+r.dataset.call);
  }));
}

// ---------------------------------------------------------------- Account & Access (TASK-112)
//
// Until today there was no route that could create a second login and no route that could
// change a password — so "Ivan and Gabriel share an account" was not a habit, it was the only
// thing the API permitted. This page is what makes two named people possible.
//
// Everything admin-only here is ALSO enforced in src/index.js. If you are reading this because
// you are adding a page, add it to ADMIN_ONLY there first and to ADMIN_VIEWS here second — in
// that order, because only the first one is a boundary.
async function renderAccess() {
  const admin = isAdmin();
  let users = [];
  if (admin) { try { users = (await api.get("/users")).users; } catch { users = []; } }

  const rows = users.map(u => `<tr>
      <td>${esc(u.email)}${u.id === state.user.id ? ` <span class="sp-id">you</span>` : ""}</td>
      <td><span class="status-chip ${u.role === "admin" ? "" : "status-off"}">${esc(u.role)}</span></td>
      <td class="sp-num">${esc((u.created_at || "").slice(0, 10))}</td>
    </tr>`).join("");

  viewShell("Account &amp; Access",
    `Signed in as ${esc(state.user.email)} — ${esc(state.user.role || "member")}`,
    `<h4>Change your password</h4>
     <div class="insight-note">Changing it signs out every other device you are signed in on.</div>
     <div class="acc-form">
       <input type="password" id="pwCur"  placeholder="Current password" autocomplete="current-password">
       <input type="password" id="pwNew"  placeholder="New password (8+ characters)" autocomplete="new-password">
       <button class="chip" id="pwSave">Change password</button>
       <span class="sp-msg" id="pwMsg"></span>
     </div>

     ${admin ? `<h4>People with a login</h4>
     <div style="overflow-x:auto;"><table class="ev-table sp-table"><thead><tr>
        <th>Email</th><th>Role</th><th class="sp-num">Added</th>
     </tr></thead><tbody>${rows || `<tr><td colspan="3" style="color:var(--ink-400); padding:14px;">Just you.</td></tr>`}</tbody></table></div>

     <h4>Add a login</h4>
     <div class="insight-note">A <b>member</b> can read calls, debriefs, outputs and Activity. They cannot open Spend or Integrations, and cannot download a backup — that last one matters most, because a backup is every transcript of every call.</div>
     <div class="acc-form">
       <input type="email" id="nuEmail" placeholder="Email" autocomplete="off">
       <input type="password" id="nuPass" placeholder="Password (8+ characters)" autocomplete="new-password">
       <select id="nuRole" class="acc-select"><option value="member">Member</option><option value="admin">Admin</option></select>
       <button class="chip" id="nuSave">Create login</button>
       <span class="sp-msg" id="nuMsg"></span>
     </div>`
     : `<div class="insight-note">Spend, Integrations and backups are admin-only on this account.</div>`}`);

  $("#pwSave").addEventListener("click", async () => {
    const msg = $("#pwMsg"); msg.textContent = "Saving…";
    try {
      await api.post("/password", { current: $("#pwCur").value, next: $("#pwNew").value });
      $("#pwCur").value = ""; $("#pwNew").value = "";
      msg.textContent = "Password changed.";
    } catch (e) { msg.textContent = String(e?.message || e); }
  });

  if (admin) $("#nuSave").addEventListener("click", async () => {
    const msg = $("#nuMsg"); msg.textContent = "Creating…";
    try {
      const r = await api.post("/users", { email: $("#nuEmail").value, password: $("#nuPass").value, role: $("#nuRole").value });
      msg.textContent = `${r.email} can now sign in as ${r.role}.`;
      setTimeout(renderAccess, 700);
    } catch (e) { msg.textContent = String(e?.message || e); }
  });
}

// Restored: these were deleted by accident in 4f66512 (the same commit that dropped
// renderActivity and took the app down). The renderActivity casualty was spotted and hotfixed;
// these two were not, because they are referenced INSIDE renderIntegrations — so the module
// still loads fine and only throws when you actually click Integrations. Integrations has been
// dead since that commit.
// ---------------------------------------------------------------- Integrations (rebuilt 2026-09-11)
//
// The old page put every integration in an always-expanded card with a key field, a Save, a Test,
// a Remove and (for Fathom) two more inputs — four accounts' worth of that is a wall. It also
// ended in a prose section explaining which services "can skip API keys", which had gone stale:
// it still described GoHighLevel as OAuth needing a marketplace app, which turned out never to
// have been true.
//
// Rebuilt on three patterns from real products:
//   * Linear / MagicPath — integrations are a quiet LIST of rows, not a grid of boxes. One line
//     each: what it is, what it does, and what it is connected AS. Configuration is behind the row.
//   * Bolt.new — the paste field carries a "Where do I find this?" block with the literal click
//     path, at the moment you need it, instead of prose at the bottom of the page.
//   * n8n — the test result appears inline in the panel you are working in, with a retry, rather
//     than as a toast that vanishes.
//
// The rule that keeps it clean: a collapsed row shows STATE, an expanded row shows CONTROLS.
// `tint` is each service's own accent so the marks are distinguishable at a glance rather than
// four identical gradient squares.
//
// > `icon` is a deliberate empty slot. Ivan asked for real company logos, and shipping my own
// > approximations of other companies' trademarks — or hot-linking their SVGs from their servers
// > — are both worse than a clean monogram. Drop the real file in as an inline `<svg>` string
// > here and it replaces the monogram everywhere, in the rows and in the picker, with no other
// > change. Until then the monogram is honest about being a placeholder.
const INTEGRATION_META = {
  ghl: { label: "GoHighLevel", blurb: "Push CRM notes and read who set the appointment.",
         method: "token", tint: "#2F6FED", icon: null, multi: true,
         // Updated 2026-09-11: this said "Login (OAuth) — we register a marketplace app first"
         // for eight weeks, and it was wrong. A Private Integration Token needs no registration,
         // no developer account and no product name.
         where: ["In GoHighLevel, open the sub-account you want to connect.",
                 "Settings → Private Integrations → Create new integration.",
                 "Tick the scopes: Contacts, Opportunities, Users.",
                 "Copy the token, then copy the Location ID from Settings → Business Profile."] },
  fathom: { label: "Fathom", blurb: "Imports call recordings and transcripts.", method: "token",
            tint: "#E0533D", icon: null, multi: true,
            where: ["In Fathom, go to Settings → Integrations → API Access.",
                    "Generate a key and copy it. No developer account needed."] },
  anthropic: { label: "Claude", blurb: "Writes the debrief, the drafts and the CRM note.",
               method: "key", tint: "#CC785C", icon: null, multi: false,
               where: ["console.anthropic.com → Settings → API keys → Create key.",
                       "A Claude Pro subscription does NOT include API usage — it is billed per token.",
                       "Set a spend cap on the same page while you are there."] },
  openai: { label: "ChatGPT", blurb: "Alternative model provider. Not in use.", method: "key",
            tint: "#10A37F", icon: null, multi: false,
            where: ["platform.openai.com → API keys → Create new secret key.",
                    "A ChatGPT Plus subscription does NOT include API usage."] }
};

// One mark, used by the rows and the picker, so a real logo dropped into `icon` appears in both.
const igMark = (m, size = 28) => m.icon
  ? `<span class="ig-mark" style="width:${size}px;height:${size}px;background:${m.tint || "var(--paper-200)"}">${m.icon}</span>`
  : `<span class="ig-mark" style="width:${size}px;height:${size}px;background:${m.tint || "var(--paper-200)"}">${esc(m.label.slice(0, 1))}</span>`;

// The picker. Frame's compact tile grid rather than StackAI's searchable catalogue: there are
// four integration types, and a search field over four items is decoration.
function integrationPicker(accountId) {
  const tiles = Object.entries(INTEGRATION_META).map(([kind, m]) => `
    <button class="ig-tile" data-add="${kind}" data-addacct="${accountId}">
      ${igMark(m, 34)}
      <span class="ig-tile-name">${esc(m.label)}</span>
      <span class="ig-tile-blurb">${esc(m.blurb)}</span>
      ${m.multi ? `<span class="ig-tile-note">More than one allowed</span>` : ""}
    </button>`).join("");
  return `<div class="ig-modal" id="igModal" role="dialog" aria-modal="true" aria-label="Add an integration">
    <div class="ig-modal-card">
      <div class="ig-modal-head">
        <div><div class="ig-modal-t">Add an integration</div>
        <div class="ig-modal-s">Pick a service. You will paste its credential next.</div></div>
        <button class="ig-modal-x" id="igModalX" aria-label="Close">&times;</button>
      </div>
      <div class="ig-tiles">${tiles}</div>
    </div></div>`;
}

async function renderIntegrations() {
  const { integrations } = await api.get("/integrations");
  const open = state.openIntegration ?? null;

  const byAccount = {};
  for (const i of integrations) (byAccount[i.account_name] = byAccount[i.account_name] || []).push(i);

  // What a row says when collapsed. This is the whole reason the page is readable: a person
  // scanning it wants "is this on, and as whom", not a form.
  // THREE states, not two. The first version of this showed "Connected" whenever a credential
  // existed, so a GoHighLevel row whose last test came back 401 still read as connected — a page
  // claiming a working connection that does not work is the failure this whole app keeps having
  // to design against. "Saved" and "verified" are different facts and the row says which it has.
  const stateLine = i => {
    let cfg = {}; try { cfg = JSON.parse(i.config_json || "{}"); } catch { /* {} */ }
    if (!i.has_key && !i.env_fallback) return `<span class="ig-state ig-off">Not connected</span>`;
    const verified = i.status === "connected";
    const bits = [];
    if (i.env_fallback) bits.push(`server secret`);
    if (i.kind === "fathom" && i.owner_email) bits.push(esc(i.owner_email));
    if (i.kind === "ghl") bits.push(cfg.location_id ? `location ${esc(cfg.location_id)}` : `<span class="ig-warn">no Location ID yet</span>`);
    if (i.key_preview && !i.env_fallback) bits.push(`<code>${esc(i.key_preview)}</code>`);
    const badge = verified
      ? `<span class="ig-state ig-on">Connected</span>`
      : `<span class="ig-state ig-unver" title="A credential is saved but the last connection test did not pass. Open this row and press Test connection.">Saved, not verified</span>`;
    return `${badge}${bits.length ? `<span class="ig-as">${bits.join(" · ")}</span>` : ""}`;
  };

  const rowsFor = items => items.map(i => {
    const m = INTEGRATION_META[i.kind] || { label: i.kind, blurb: "", where: [] };
    const name = i.label ? `${m.label} <span class="ig-tag">${esc(i.label)}</span>` : m.label;
    const isOpen = open === i.id;
    let cfg = {}; try { cfg = JSON.parse(i.config_json || "{}"); } catch { /* {} */ }

    return `<div class="ig-row ${isOpen ? "is-open" : ""}" data-igrow="${i.id}">
      <button class="ig-head" data-igtoggle="${i.id}" aria-expanded="${isOpen}">
        ${igMark(m)}
        <span class="ig-main">
          <span class="ig-name">${name}</span>
          <span class="ig-blurb">${esc(m.blurb)}</span>
        </span>
        <span class="ig-right">${stateLine(i)}<span class="ig-chev" aria-hidden="true">${isOpen ? "&#9662;" : "&#9656;"}</span></span>
      </button>

      ${isOpen ? `<div class="ig-panel">
        ${m.where?.length ? `<div class="ig-where">
          <div class="ig-where-t">Where do I find this?</div>
          <ol>${m.where.map(w => `<li>${esc(w)}</li>`).join("")}</ol>
        </div>` : ""}

        ${i.kind === "ghl" ? `<label class="ig-field"><span>Location ID</span>
          <input type="text" data-loc="${i.id}" value="${esc(cfg.location_id || "")}" placeholder="the sub-account this token belongs to" autocomplete="off">
        </label>` : ""}

        ${i.kind === "fathom" ? `
        <label class="ig-field"><span>Inbox label</span>
          <input type="text" data-label="${i.id}" value="${esc(i.label || "")}" maxlength="40" placeholder="e.g. OSA">
        </label>
        <label class="ig-field"><span>Whose recordings to import</span>
          <input type="email" data-owner="${i.id}" value="${esc(i.owner_email || "")}" placeholder="gabriel@example.com">
          <span class="ig-help">${i.owner_email
            ? "Only this person's recordings are imported."
            : "<b class='ig-warn'>Required.</b> Fathom returns the whole organisation's recordings. Until this is set the key is skipped, so colleagues' calls are never imported."}</span>
        </label>` : ""}

        <label class="ig-field"><span>${m.method === "token" ? "Token" : "API key"}</span>
          <span class="ig-keyrow">
            <input type="password" data-int="${i.id}" autocomplete="off"
                   placeholder="${i.has_key ? "Paste a new one to replace it" : "Paste it here"}">
            <button class="regen-btn" data-reveal="${i.id}">Show</button>
          </span>
        </label>

        <div class="ig-actions">
          <button class="primary-btn" data-save="${i.id}">Save</button>
          <button class="regen-btn" data-test="${i.id}">Test connection</button>
          ${i.kind === "fathom" && i.has_key ? `<button class="regen-btn" data-peek="${i.id}">What's in Fathom?</button>` : ""}
          ${i.has_key ? `<button class="regen-btn ig-danger" data-remove="${i.id}">Remove</button>` : ""}
        </div>
        <div class="ig-result" data-msg="${i.id}"></div>
        <div class="peek-panel hidden" data-peekpanel="${i.id}"></div>
      </div>` : ""}
    </div>`;
  }).join("");

  const firstAccount = integrations[0]?.account_id ?? "";
  viewShell("Integrations",
    "What Closer is connected to. Credentials are stored on the server and never sent back to your browser.",
    // Secondary, not primary. This page's job is to be a quiet reference you scan; adding an
// integration is the rarest thing done here and it was rendering as the brightest object on
// the screen, pulling the eye away from the rows that are the actual content.
`<div class="ig-top"><button class="regen-btn" id="igAdd">+ Add integration</button></div>` +
    Object.entries(byAccount).map(([acct, items]) =>
      `<div class="ig-group"><div class="ig-group-t">${esc(acct)}</div>${rowsFor(items)}</div>`).join("") +
    integrationPicker(firstAccount));

  const modal = $("#igModal");
  const closeModal = () => modal?.classList.remove("show");
  $("#igAdd")?.addEventListener("click", () => modal?.classList.add("show"));
  $("#igModalX")?.addEventListener("click", closeModal);
  // Click the backdrop, not the card, to dismiss.
  modal?.addEventListener("click", e => { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape" && modal?.classList.contains("show")) { closeModal(); }
  }, { once: true });

  document.querySelectorAll("[data-add]").forEach(b => b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      const r = await api.post("/integrations", { account_id: b.dataset.addacct || undefined, kind: b.dataset.add });
      closeModal();
      // Open the new row straight away — the next thing anyone wants is to paste the credential,
      // and making them find the row they just created is a pointless extra step.
      state.openIntegration = r.id;
      renderIntegrations();
    } catch (e) { toast(e.message || "Could not add that."); b.disabled = false; }
  }));

  // One row open at a time: this page is a list to scan, and two open panels turns it back into
  // the wall it used to be.
  document.querySelectorAll("[data-igtoggle]").forEach(b => b.addEventListener("click", () => {
    const id = +b.dataset.igtoggle;
    state.openIntegration = state.openIntegration === id ? null : id;
    renderIntegrations();
  }));

  document.querySelectorAll("[data-reveal]").forEach(b => b.addEventListener("click", () => {
    const inp = document.querySelector(`input[data-int="${b.dataset.reveal}"]`);
    if (!inp) return;
    inp.type = inp.type === "password" ? "text" : "password";
    b.textContent = inp.type === "password" ? "Show" : "Hide";
  }));

  const say = (id, text, ok) => {
    const el = document.querySelector(`[data-msg="${id}"]`);
    if (el) { el.textContent = text; el.className = `ig-result ${ok === true ? "is-ok" : ok === false ? "is-bad" : ""}`; }
  };

  document.querySelectorAll("[data-save]").forEach(b => b.addEventListener("click", async () => {
    const id = b.dataset.save;
    const inp = document.querySelector(`input[data-int="${id}"]`);
    const loc = document.querySelector(`input[data-loc="${id}"]`);
    const label = document.querySelector(`input[data-label="${id}"]`);
    const owner = document.querySelector(`input[data-owner="${id}"]`);
    say(id, "Saving…");
    try {
      // Config and label first, so that a Test straight after a Save uses the values just typed
      // rather than the ones that were there when the page rendered.
      if (loc) await api.post(`/integrations/${id}/config`, { location_id: loc.value });
      if (label || owner) await api.post(`/integrations/${id}/label`,
        { label: label?.value ?? undefined, owner_email: owner?.value ?? undefined });
      // PUT /integrations/:id with `secret_value` — the route that exists. An earlier draft of
      // this handler invented POST /integrations/:id/key, which would have failed at runtime on
      // the one action the page is for.
      if (inp?.value.trim()) { await api.put(`/integrations/${id}`, { secret_value: inp.value.trim() }); inp.value = ""; }
      say(id, "Saved. Now press Test connection.", true);
    } catch (e) { say(id, e.message || "Could not save.", false); }
  }));

  document.querySelectorAll("[data-test]").forEach(b => b.addEventListener("click", async () => {
    const id = b.dataset.test;
    say(id, "Testing…");
    try {
      const r = await api.post(`/integrations/${id}/test`);
      say(id, r.message || (r.ok ? "Connected." : "Failed."), !!r.ok);
    } catch (e) { say(id, e.message || "Test failed.", false); }
  }));

  document.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", async () => {
    const id = b.dataset.remove;
    if (!confirm("Remove the stored credential for this integration?")) return;
    try { await api.del(`/integrations/${id}`); state.openIntegration = +id; renderIntegrations(); }
    catch (e) { say(id, e.message || "Could not remove.", false); }
  }));

  document.querySelectorAll("[data-peek]").forEach(b => b.addEventListener("click", async () => {
    const id = b.dataset.peek;
    const panel = document.querySelector(`[data-peekpanel="${id}"]`);
    if (!panel) return;
    panel.classList.remove("hidden");
    panel.innerHTML = `<div class="ig-help">Checking Fathom…</div>`;
    try {
      const r = await api.get(`/integrations/${id}/preview?days=3`);
      panel.innerHTML = !r.meetings?.length
        ? `<div class="ig-help">Nothing in Fathom in the last 3 days.</div>`
        : `<div class="ig-help">${r.imported} of ${r.total} imported.</div>
           <table class="ev-table"><tbody>${r.meetings.slice(0, 12).map(x => `<tr>
             <td>${esc(x.title)}</td><td>${esc((x.occurred_at || "").slice(0, 10))}</td>
             <td>${x.imported ? "✓ imported" : esc(x.skipped_reason || "not imported")}</td></tr>`).join("")}</tbody></table>`;
    } catch (e) { panel.innerHTML = `<div class="ig-help ig-warn">${esc(e.message || "Could not reach Fathom.")}</div>`; }
  }));
}

// ---------- utilities ----------
function copyText(text, btn) {
  const done = () => {
    if (btn) { const old = btn.innerHTML; btn.classList.add("copied"); btn.innerHTML = "Copied";
      setTimeout(() => { btn.classList.remove("copied"); btn.innerHTML = old; }, 1400); }
    toast("Copied to clipboard");
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(done);
  else done();
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}
