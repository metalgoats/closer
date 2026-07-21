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
const RELEASES = [
  {
    v: "2026.07.22",
    date: "22 July 2026",
    title: "Fixes: hidden sidebar locked you out, Integrations was dead",
    items: [
      "Fixed: hiding the sidebar also hid the only way into Integrations, Prompt Library, Activity, What's new, the theme toggle and Log out — they all lived inside it. There's now an account button in the header whenever the sidebar is hidden.",
      "Fixed: Integrations had been silently broken for weeks — clicking it did nothing at all. Two constants it depended on were deleted by accident in an earlier release.",
      "Your call imports were never affected: Fathom kept importing throughout."
    ]
  },
  {
    v: "2026.07.21",
    date: "21 July 2026",
    title: "Sidebar counts and new-call marks",
    items: [
      "The sidebar now shows live counts for All Calls, Needs Follow-up, Closed and Archived — real totals from the server, not just what's loaded on screen.",
      "Calls that arrived since you last looked are marked with a violet bar and counted in a badge on All Calls. Opening a call clears its mark, like unread mail.",
      "The marks are per-browser, so you and Gabriel each track your own — one of you reading a call doesn't clear it for the other."
    ]
  },
  {
    v: "2026.07.20",
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
    v: "2026.07.19",
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

// Pure so it can be tested without a browser: given the release list (newest first) and the
// version this browser last acknowledged, which notes should pop?
function unseenFrom(list, seen) {
  if (!list.length) return [];
  if (!seen) return list.slice(0, 1);              // new browser: latest only, not the back catalogue
  const i = list.findIndex(r => r.v === seen);
  return i === -1 ? list.slice(0, 1) : list.slice(0, i);   // everything since they last looked
}
function unseenReleases() {
  let seen = null;
  try { seen = localStorage.getItem(RELEASE_KEY); } catch { /* private mode — just show it */ }
  return unseenFrom(RELEASES, seen);
}
function markReleasesSeen() {
  if (!RELEASES.length) return;
  try { localStorage.setItem(RELEASE_KEY, RELEASES[0].v); } catch {}
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

const VIEWS = { insights: renderInsights, suggestions: renderSuggestions, templates: renderTemplates, integrations: renderIntegrations, activity: renderActivity };
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
$("#newCallBtn").addEventListener("click", () => { renderCompose(); showDetailMobile("New Call"); });

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
      if (state.currentCallId && callState(state.calls.find(c => c.id === state.currentCallId) || {}) !== "processing") {
        const still = state.calls.find(c => c.id === state.currentCallId);
        if (still && callState(still) !== "processing") openCall(state.currentCallId);
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
    const pill = st !== "processed" ? `<span class="pill pill-new">${STATE_LABEL[st]}</span>`
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

function fmtTime(iso) {
  const d = new Date(iso + (iso.includes("Z") || iso.includes("+") ? "" : "Z"));
  const now = new Date(); const days = Math.floor((now - d) / 86400000);
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return days === 0 ? `Today, ${t}` : days === 1 ? `Yesterday, ${t}` : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// ---------- call detail ----------
async function openCall(id) {
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
  const tone = toneOf(call);
  const sms = outputs.find(o => o.kind === "sms" && o.tone === tone);
  const email = outputs.find(o => o.kind === "email" && o.tone === tone);
  const ghl = outputs.find(o => o.kind === "ghl_note");
  const pill = call.outcome === "closed" ? `<span class="pill pill-closed">Closed</span>` : `<span class="pill pill-followup">Follow-up</span>`;
  const srcBadge = call.source === "fathom" ? `<span class="fathom-badge">Synced from Fathom</span>` : `<span class="fathom-badge" style="color:var(--ink-600); background:var(--paper-200);">Pasted manually</span>`;

  $("#detailPane").innerHTML = `
    <div class="detail-header">
      <div class="dh-top">
        <div>
          ${callTitle(call, pill)}
          <div class="dh-meta">${esc(offerLabel(call))}<span class="sep">·</span>${call.duration_min ? call.duration_min + " min" : ""} ${fmtTime(call.occurred_at)}<span class="sep">·</span>${srcBadge}</div>
        </div>
        <div class="dh-actions">${callActions(call, `<button class="regen-btn" id="regenBtn">↻ Regenerate</button>`)}</div>
      </div>
      <div class="tone-row">
        <span class="tone-label">Call type</span>
        <div class="ct-picker">${(state.callTypes || []).map(t =>
          `<button class="ct-chip ${t.id === call.call_type_id ? "active" : ""}" data-pick="${t.id}">${esc(t.name)}</button>`).join("")}</div>
        <span class="applies-to" id="ctStale"></span>
      </div>
      <div class="tone-row">
        <span class="tone-label">Text &amp; email tone</span>
        <div class="tone-seg">${["casual", "balanced", "formal"].map(t =>
          `<button class="tone-opt ${t === tone ? "selected" : ""}" data-tone="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>
        ${call.suggested_tone ? `<span class="tone-suggested">✦ Suggested: ${call.suggested_tone}</span>` : ""}
        <span class="applies-to">${esc(call.tone_reason || "")}</span>
      </div>
    </div>
    <!-- Debrief: full-width, paginated by the pills. Only one page is in the DOM's flow at a
         time, so nothing needs scrolling past to reach the next thing (Gabriel's original
         complaint: "it's just so much, and I don't always read all of it"). -->
    <div class="debrief-section">
      <div class="debrief-head"><h3>Debrief</h3>
        <button class="copy-btn" id="copyDebrief">⧉ Copy all</button></div>
      <div class="panel-subnav" role="tablist">${DEBRIEF_PAGES.map((p, i) =>
        `<button class="chip ${i === 0 ? "active" : ""}" data-page="${i}" role="tab"
                 aria-selected="${i === 0}">${p.label}</button>`).join("")}</div>
      <div class="debrief-body" id="debriefBody">
        ${DEBRIEF_PAGES.map((p, i) =>
          `<div class="dpage ${i === 0 ? "active" : ""}" data-page="${i}">${p.render(d) || `<div class="dpage-empty">Nothing recorded for this section.</div>`}</div>`).join("")}
      </div>
    </div>

    <!-- Three columns: Text / Email / GHL Note -->
    <div class="outputs">
      ${outputPanel("Text Message", sms, { sent: true })}
      ${outputPanel("Email", email, { sent: true, subject: true })}
      ${outputPanel("GoHighLevel Note", ghl, {})}
    </div>`;

  wireDetail(call, { sms, email, ghl, debrief: d });
}

// The debrief pills are pagination, not jump links: each shows exactly one page and hides the
// rest. Page 0 pairs the TL;DR with the scorecard because that is the "did I do well?" glance;
// everything else is a section you go looking for deliberately.
const bullets = xs => (xs || []).length
  ? `<ul>${xs.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "";

const DEBRIEF_PAGES = [
  { label: "TL;DR & Scorecard", key: "tldr",
    render: d => (highlights(d) + (d.scorecard?.length ? `<h4>Call Scorecard</h4>${scorecard(d.scorecard)}` : "")) },
  { label: "Did Well", key: "didWell", render: d => bullets(d.didWell) },
  { label: "Hurt Sale", key: "hurtSale", render: d => bullets(d.hurtSale) },
  { label: "Objections", key: "objections", render: d => (d.objections || []).map(o => `
      <div class="objection"><div class="said">"${esc(o.said)}"</div>
      <dl><dt>Meant</dt><dd>${esc(o.meant)}</dd><dt>Felt</dt><dd>${esc(o.felt)}</dd>
      <dt>Say instead</dt><dd>${esc(o.should)}</dd><dt>Follow-up</dt><dd>${esc(o.follow)}</dd>
      <dt>Loop back</dt><dd>${esc(o.loop)}</dd></dl></div>`).join("") },
  { label: "Client Profile", key: "profile", render: d => bullets(d.profile) },
  { label: "Buying Signals", key: "buyingSignals", render: d => bullets(d.buyingSignals) },
  { label: "Lessons", key: "lessons", render: d => bullets(d.lessons) }
];

// Copy = the WHOLE debrief, not just the visible page. Pagination is a reading aid; it must
// not silently narrow what the copy button gives you.
function debriefToText(call, d) {
  const L = [`DEBRIEF — ${call.client_name}`, fmtTime(call.occurred_at), ""];
  const sec = (title, xs) => { if ((xs || []).length) L.push(title.toUpperCase(), ...xs.map(x => `• ${x}`), ""); };
  if (d.scorecard?.length) {
    L.push("CALL SCORECARD", ...d.scorecard.map(([k, v]) => `• ${k}: ${v}/10`), "");
  }
  sec("What you did well", d.didWell);
  sec("What hurt the sale", d.hurtSale);
  if (d.objections?.length) {
    L.push("OBJECTION AUTOPSY");
    d.objections.forEach(o => L.push(
      `• "${o.said}"`, `    Meant: ${o.meant}`, `    Felt: ${o.felt}`,
      `    Say instead: ${o.should}`, `    Follow-up: ${o.follow}`, `    Loop back: ${o.loop}`));
    L.push("");
  }
  sec("Client profile", d.profile);
  sec("Buying signals + red flags", d.buyingSignals);
  sec("Coaching lessons", d.lessons);
  return L.join("\n").trim();
}

function highlights(d) {
  if (!d.scorecard?.length) return "";
  const sorted = [...d.scorecard].sort((a, b) => b[1] - a[1]);
  const best = sorted[0], worst = sorted[sorted.length - 1];
  return `<div class="highlights"><div class="hl-title">TL;DR</div>
    <div class="hl-row"><span class="hl-tag hl-best">Strongest</span><span>${esc(best[0])} — ${best[1]}/10</span></div>
    <div class="hl-row"><span class="hl-tag hl-worst">Work on</span><span>${esc(worst[0])} — ${worst[1]}/10</span></div>
    ${d.lessons?.[0] ? `<div class="hl-row"><span class="hl-tag hl-lesson">#1 Lesson</span><span>${esc(d.lessons[0])}</span></div>` : ""}</div>`;
}

const tierColor = n => n >= 8 ? "var(--blue-500)" : n >= 6 ? "var(--violet-500)" : "var(--pink-500)";
// Each dimension is one self-contained cell so the grid can flow them into as many columns as
// the pane is wide. The old 2-column grid forced all 10 rows into a single tall stack, which is
// what made the scorecard need scrolling.
function scorecard(rows) {
  return `<div class="scorecard">${(rows || []).map(([k, v]) => `
    <div class="sc-item">
      <div class="sc-top"><span class="sc-k">${esc(k)}</span><span class="sc-v" style="color:${tierColor(v)}">${v}/10</span></div>
      <div class="bar"><i style="width:${v * 10}%; background:${tierColor(v)}"></i></div>
    </div>`).join("")}</div>`;
}

function outputPanel(title, out, opts) {
  if (!out) return `<div class="panel"><div class="panel-head"><div class="panel-chrome"><span class="chrome-dot d1"></span><span class="chrome-dot d2"></span><span class="chrome-dot d3"></span></div>
    <div class="panel-head-row"><span class="panel-title">${title}</span></div></div>
    <div class="panel-body"><span class="edit-note">Not generated yet — hit Regenerate.</span></div></div>`;
  return `<div class="panel" data-output="${out.id}">
    <div class="panel-head">
      <div class="panel-chrome"><span class="chrome-dot d1"></span><span class="chrome-dot d2"></span><span class="chrome-dot d3"></span></div>
      <div class="panel-head-row"><span class="panel-title">${title}</span>
        <div class="panel-actions">
          ${opts.sent ? `<button class="sent-btn ${out.sent_at ? "is-sent" : ""}" data-out="${out.id}">${out.sent_at ? "✓ Sent" : "Mark sent"}</button>` : ""}
          <button class="copy-btn" data-out="${out.id}">⧉ Copy</button>
        </div></div>
    </div>
    <div class="panel-body">
      ${opts.subject ? `<input class="subject-input" data-out="${out.id}" data-field="subject" value="${esc(out.subject || "")}" aria-label="Email subject">` : ""}
      <textarea class="msg-edit" data-out="${out.id}" data-field="body" aria-label="${title}">${esc(out.body)}</textarea>
      <span class="edit-note">Click to edit — changes are saved and feed the weekly tone learning.</span>
    </div></div>`;
}

function wireDetail(call, outs) {
  // Debrief pagination: show one page, hide the rest.
  document.querySelectorAll(".chip[data-page]").forEach(chip => chip.addEventListener("click", () => {
    const n = chip.dataset.page;
    document.querySelectorAll(".chip[data-page]").forEach(c => {
      const on = c.dataset.page === n;
      c.classList.toggle("active", on);
      c.setAttribute("aria-selected", on);
    });
    document.querySelectorAll(".dpage").forEach(p => p.classList.toggle("active", p.dataset.page === n));
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
  document.querySelectorAll(".copy-btn[data-out]").forEach(btn => btn.addEventListener("click", async () => {
    const panel = btn.closest(".panel");
    const subject = panel.querySelector('[data-field="subject"]');
    const body = panel.querySelector('[data-field="body"]').value;
    copyText(subject ? `Subject: ${subject.value}\n\n${body}` : body, btn);
    api.post(`/outputs/${btn.dataset.out}/copied`).catch(() => {});
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
function viewShell(title, sub, bodyHtml) {
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
  const [{ call_types }, { templates }] = await Promise.all([
    api.get("/call-types"), api.get("/templates")
  ]);
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
    `<div class="ct-list">${call_types.map(row).join("")}</div>
     <button class="primary-btn" id="ctNew" style="margin:14px 0 22px;">+ New call type</button>
     <div id="ctEditor"></div>
     <details style="margin-top:18px;"><summary style="cursor:pointer; font-size:12px; color:var(--ink-400);">Legacy master prompt (v${templates.filter(t=>!t.tone)[0]?.version ?? "—"}) — kept for reference</summary>
       <p style="font-size:12px; color:var(--ink-400);">The Sales call type was seeded from this. Editing call types above is what affects generation now.</p>
     </details>`);

  document.querySelectorAll("[data-ctedit]").forEach(b => b.addEventListener("click", () =>
    openTypeEditor(call_types.find(t => t.id === +b.dataset.ctedit))));
  $("#ctNew").addEventListener("click", () => openTypeEditor(null));
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
  const { events, totals, today, week, month } = await api.get("/events?limit=200");
  // Rough but honest: Sonnet 5 list pricing, input $3/M and output $15/M. Labelled an estimate
  // because the real invoice is Anthropic's, not ours.
  const cost = (inp, outp) => `$${((inp || 0) / 1e6 * 3 + (outp || 0) / 1e6 * 15).toFixed(2)}`;
  const money = t => t ? `$${(t / 1e6 * 2).toFixed(2)}` : "$0.00";

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

  const runs = n => `${n || 0} generation${n === 1 ? "" : "s"}`;
  const spend = `<div class="spend-row">
      <div class="spend-card"><div class="spend-k">Today</div>
        <div class="spend-v">${cost(today?.input_tokens, today?.output_tokens)}</div>
        <div class="spend-sub">${runs(today?.runs)}</div></div>
      <div class="spend-card"><div class="spend-k">Last 7 days</div>
        <div class="spend-v">${cost(week?.input_tokens, week?.output_tokens)}</div>
        <div class="spend-sub">${runs(week?.runs)}</div></div>
      <div class="spend-card"><div class="spend-k">This month</div>
        <div class="spend-v">${cost(month?.input_tokens, month?.output_tokens)}</div>
        <div class="spend-sub">${runs(month?.runs)}</div></div>
      <div class="spend-card"><div class="spend-k">All time</div>
        <div class="spend-v">${cost(totals?.input_tokens, totals?.output_tokens)}</div>
        <div class="spend-sub">${totals?.runs || 0} runs · ${totals?.failures || 0} errors</div></div>
      <div class="spend-card"><div class="spend-k">Avg / call</div>
        <div class="spend-v">${totals?.runs ? cost((totals.input_tokens || 0) / totals.runs, (totals.output_tokens || 0) / totals.runs) : "$0.00"}</div>
        <div class="spend-sub">${totals?.avg_ms ? Math.round(totals.avg_ms / 1000) + "s avg" : "—"}</div></div>
    </div>
    <div class="insight-note">Estimated from tokens this app logged, at Sonnet 5 list pricing. It counts Closer's spend only — the billed total and your remaining credit balance live in the Anthropic console, which has no API for either.</div>`;
  viewShell("Activity", "Everything the app has done — failures, completions, token spend, and which outputs actually get used",
    spend + `<div class="ev-summary">
       <div><b>${totals.runs || 0}</b><span>generations</span></div>
       <div class="${totals.failures ? "bad" : ""}"><b>${totals.failures || 0}</b><span>failures</span></div>
       <div><b>${(totals.input_tokens || 0).toLocaleString()}</b><span>input tokens</span></div>
       <div><b>${(totals.output_tokens || 0).toLocaleString()}</b><span>output tokens</span></div>
       <div><b>${totals.avg_ms ? (totals.avg_ms / 1000).toFixed(1) + "s" : "—"}</b><span>avg run</span></div>
       <div><b>~${money(totals.input_tokens)}</b><span>input cost (est.)</span></div>
     </div>
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

// Restored: these were deleted by accident in 4f66512 (the same commit that dropped
// renderActivity and took the app down). The renderActivity casualty was spotted and hotfixed;
// these two were not, because they are referenced INSIDE renderIntegrations — so the module
// still loads fine and only throws when you actually click Integrations. Integrations has been
// dead since that commit.
const INTEGRATION_META = {
  ghl:       { label: "GoHighLevel",          method: "login",   how: "Connect with your GoHighLevel login — OAuth, no key to copy." },
  fathom:    { label: "Fathom",               method: "selfkey", how: "Generate a key in Fathom → Settings → Integrations → API Access (2 clicks, no dev account)." },
  anthropic: { label: "Claude (Anthropic)",   method: "key",     how: "API key required — there is no login option for programmatic API access." },
  openai:    { label: "ChatGPT (OpenAI)",     method: "key",     how: "API key required — there is no login option for programmatic API access." }
};
const METHOD_BADGE = {
  login:   `<span class="status-chip" style="background:var(--blue-100); color:var(--blue-600);">Login (OAuth)</span>`,
  selfkey: `<span class="status-chip" style="background:var(--violet-100); color:var(--violet-600);">Self-serve key</span>`,
  key:     `<span class="status-chip status-off">API key</span>`
};

async function renderIntegrations() {
  const { integrations } = await api.get("/integrations");
  const byAccount = {};
  for (const i of integrations) (byAccount[i.account_name] = byAccount[i.account_name] || []).push(i);

  const rows = Object.entries(byAccount).map(([acct, items]) => `
    <h4>${esc(acct)}</h4>
    ${items.map(i => {
      const m = INTEGRATION_META[i.kind] || { label: i.kind, method: "key", how: "" };
      // Two Fathom rows share a kind, so the per-row label is what tells them apart.
      const displayLabel = i.label ? `${m.label} — ${esc(i.label)}` : m.label;

      // GHL is OAuth — a Connect button, not a key field.
      if (m.method === "login") {
        return `<div class="integration-row"><div>
            <div class="integration-name">${displayLabel} ${METHOD_BADGE[m.method]}</div>
            <div class="integration-sub">${esc(m.how)}</div></div>
            <button class="regen-btn" data-connect-ghl="${i.account_id}">Connect</button></div>`;
      }

      const state = i.has_key
        ? `<span class="key-state on">✓ Key saved <code>${esc(i.key_preview)}</code>${i.updated_at ? ` · ${esc(i.updated_at)}` : ""}</span>`
        : i.env_fallback
          ? `<span class="key-state env">Using <code>${esc(i.secret_name)}</code> from Cloudflare secrets</span>`
          : `<span class="key-state off">No key yet</span>`;

      return `<div class="integration-card" data-int="${i.id}">
        <div class="integration-card-head">
          <div>
            <div class="integration-name">${displayLabel} ${METHOD_BADGE[m.method]}</div>
            <div class="integration-sub">${esc(m.how)}</div>
          </div>
          <span class="status-chip ${i.status === "connected" ? "status-on" : "status-off"}">${i.status}</span>
        </div>
        ${i.kind === "fathom" ? `<div class="label-row">
          <span class="label-hint">Inbox label — calls imported by this key show this instead of the account name:</span>
          <input type="text" class="label-input" data-label="${i.id}" value="${esc(i.label || "")}" placeholder="e.g. Hypnosis or OSA" maxlength="40">
          <span class="label-hint" style="margin-top:6px;">${i.owner_email
            ? "Only imports calls recorded by this person."
            : "<b style='color:var(--pink-500)'>Required —</b> Fathom returns the WHOLE org's recordings. Until you set the Fathom account email, this key is skipped so colleagues' calls aren't imported."}</span>
          <input type="email" class="label-input" data-owner="${i.id}" value="${esc(i.owner_email || "")}" placeholder="gabriel@example.com — whose recordings to import">
          <button class="regen-btn" data-labelsave="${i.id}">Save</button>
        </div>` : ""}
        <div class="key-row">
          <input type="password" class="key-input" data-int="${i.id}" autocomplete="off"
                 placeholder="${i.has_key ? "Paste a new key to replace the saved one" : "Paste your key here"}">
          <button class="key-reveal" data-reveal="${i.id}" title="Show what you typed">Show</button>
          <button class="primary-btn key-save" data-save="${i.id}">Save</button>
          <button class="regen-btn" data-test="${i.id}">Test</button>
          ${i.kind === "fathom" && i.has_key ? `<button class="regen-btn" data-pull="${i.id}">Pull latest call</button>
          <button class="regen-btn" data-peek="${i.id}">What's in Fathom?</button>` : ""}
          ${i.has_key ? `<button class="regen-btn key-remove" data-remove="${i.id}">Remove</button>` : ""}
        </div>
        <div class="key-foot">${state}<span class="key-msg" data-msg="${i.id}"></span></div>
        <div class="peek-panel hidden" data-peekpanel="${i.id}"></div>
      </div>`;
    }).join("")}`).join("");

  viewShell("Integrations", "Paste a key, hit Save, hit Test. Keys are stored server-side and never sent back to your browser.",
    rows + `
    <h4>Which of these can skip API keys?</h4>
    <ul style="font-size:12.5px; line-height:1.7;">
      <li><b>GoHighLevel — yes, login.</b> GHL runs on OAuth 2.0; you click Connect, log in, and it stores a
        refreshing token. One-time setup: we register a GHL marketplace app to get a Client ID/Secret, then this
        Connect button works for both sub-accounts.</li>
      <li><b>Fathom — a self-serve key, not a login.</b> No developer dashboard: Gabriel generates a key inside
        his own Fathom settings in a couple clicks.</li>
      <li><b>Claude &amp; ChatGPT — API key, unavoidable.</b> There is no "log in with Claude/ChatGPT" for API
        access, and the $20/mo Pro/Plus subscriptions do <i>not</i> include API usage (it's billed separately per token).
        Paste the key above once and hit Save — no terminal needed.</li>
    </ul>
    <p style="font-size:12px; color:var(--ink-400);">Keys are stored on the server and used only from there — they are
      never sent to your browser, which is why you see a masked preview instead of the full key after saving. Paste a new
      key any time to replace it. Set a spend cap in your provider dashboard as a second line of defense.</p>`);

  document.querySelectorAll("[data-connect-ghl]").forEach(btn => btn.addEventListener("click", () =>
    toast("GHL Connect needs the marketplace app registered first — see next steps.")));

  const msgFor = id => document.querySelector(`[data-msg="${id}"]`);
  const setMsg = (id, text, ok) => {
    const el = msgFor(id);
    if (!el) return;
    el.textContent = text;
    el.className = "key-msg " + (ok === true ? "ok" : ok === false ? "bad" : "");
  };

  // Show/hide what you typed — this only reveals the field you're typing into,
  // never a previously-saved key (the server never sends those back).
  document.querySelectorAll("[data-reveal]").forEach(btn => btn.addEventListener("click", () => {
    const input = document.querySelector(`.key-input[data-int="${btn.dataset.reveal}"]`);
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.textContent = showing ? "Show" : "Hide";
  }));

  document.querySelectorAll("[data-save]").forEach(btn => btn.addEventListener("click", async () => {
    const id = btn.dataset.save;
    const input = document.querySelector(`.key-input[data-int="${id}"]`);
    const val = input.value.trim();
    if (!val) return setMsg(id, "Paste a key first.", false);
    setMsg(id, "Saving…");
    try {
      await api.put(`/integrations/${id}`, { secret_value: val });
      input.value = "";
      setMsg(id, "Saved. Testing…");
      const r = await api.post(`/integrations/${id}/test`);
      setMsg(id, r.message, r.ok);
      renderIntegrations();
      toast(r.ok ? "Key saved and verified" : "Key saved, but the test failed");
    } catch (err) {
      setMsg(id, err.message, false);
    }
  }));

  document.querySelectorAll("[data-test]").forEach(btn => btn.addEventListener("click", async () => {
    const id = btn.dataset.test;
    setMsg(id, "Testing…");
    try {
      const r = await api.post(`/integrations/${id}/test`);
      setMsg(id, r.message, r.ok);
    } catch (err) {
      setMsg(id, err.message, false);
    }
  }));

  document.querySelectorAll("[data-remove]").forEach(btn => btn.addEventListener("click", async () => {
    const id = btn.dataset.remove;
    await api.req("DELETE", `/integrations/${id}`);
    toast("Key removed");
    renderIntegrations();
  }));

  // Save a Fathom token's inbox label. It propagates live: existing calls imported by this
  // token pick up the new label because the call list joins to the token, not a snapshot.
  document.querySelectorAll("[data-labelsave]").forEach(btn => btn.addEventListener("click", async () => {
    const id = btn.dataset.labelsave;
    const label = document.querySelector(`.label-input[data-label="${id}"]`).value.trim();
    const owner_email = document.querySelector(`.label-input[data-owner="${id}"]`).value.trim();
    await api.post(`/integrations/${id}/label`, { label, owner_email });
    toast(label ? `Calls from this key now show "${label}"` : "Label cleared");
    if (state.calls.length) await refreshCalls();   // reflect the relabel in the inbox immediately
    renderIntegrations();
  }));

  // Pull exactly one call — the most recent. Lands unprocessed; you choose when to spend tokens.
  // Import one specific recording the automatic poll skipped. Deliberately per-call: the cron
  // stays scoped to Gabriel's own recordings, so nothing arrives just because it exists in the org.
  function wirePeekActions(panel) {
    panel.querySelectorAll("[data-imp]").forEach(b => b.addEventListener("click", async () => {
      const cell = b.closest("td");
      b.disabled = true; b.textContent = "Importing…";
      try {
        const r = await api.post(`/integrations/${b.dataset.int}/import/${encodeURIComponent(b.dataset.imp)}`);
        if (!r.ok) { b.disabled = false; b.textContent = "Import"; toast(r.message); return; }
        const row = b.closest("tr");
        row.classList.remove("peek-skip");
        row.querySelector("td").innerHTML = `<span class="peek-yes">In app</span>`;
        cell.innerHTML = `<button class="peek-open" data-openid="${r.call_id}">Open</button>`;
        wirePeekActions(panel);                    // the new Open button needs its handler
        toast(r.message);
        await refreshCalls();
      } catch (err) { b.disabled = false; b.textContent = "Import"; toast(err.message); }
    }));
    panel.querySelectorAll("[data-openid]").forEach(b => b.addEventListener("click", () => {
      openCall(+b.dataset.openid);
      showDetailMobile();
    }));
  }

  // "What's in Fathom?" — read-only. Shows everything the key can see, including recordings we
  // deliberately skip, so "are we missing calls?" is answered by looking instead of by widening
  // the import and hoovering up the whole org. Fetches no transcripts and writes nothing.
  document.querySelectorAll("[data-peek]").forEach(btn => btn.addEventListener("click", async () => {
    const id = btn.dataset.peek;
    const panel = document.querySelector(`[data-peekpanel="${id}"]`);
    if (!panel.classList.contains("hidden") && panel.dataset.loaded === "1") {
      panel.classList.add("hidden"); return;                       // second click closes it
    }
    panel.classList.remove("hidden");
    panel.innerHTML = `<div class="peek-loading">Asking Fathom…</div>`;
    btn.disabled = true;
    try {
      const days = 7;
      const r = await api.get(`/integrations/${id}/preview?days=${days}`);
      if (!r.ok) { panel.innerHTML = `<div class="peek-loading">${esc(r.message)}</div>`; return; }
      const rows = r.meetings.map(m => `
        <tr class="${m.imported ? "" : "peek-skip"}" data-row="${esc(m.external_id)}">
          <td>${m.imported ? `<span class="peek-yes">In app</span>` : `<span class="peek-no">Not imported</span>`}</td>
          <td class="peek-when">${esc(String(m.occurred_at || "").slice(0, 16).replace("T", " "))}</td>
          <td>${esc(m.title)}</td>
          <td class="peek-by">${esc(m.recorded_by)}</td>
          <td class="peek-act">${m.imported
            ? `<button class="peek-open" data-openid="${m.call_id}">Open</button>`
            : `<button class="peek-import" data-imp="${esc(m.external_id)}" data-int="${id}">Import</button>`}</td>
        </tr>`).join("");
      panel.innerHTML = `
        <div class="peek-head">Last ${days} days · <b>${r.total}</b> recording${r.total === 1 ? "" : "s"} visible to this key —
          <b>${r.imported}</b> in the app, <b>${r.missing}</b> skipped.
          Importing only <i>${esc(r.owner_email || "—")}</i>'s own recordings.</div>
        <div style="overflow-x:auto;"><table class="peek-table"><tbody>${rows || `<tr><td>Nothing in this window.</td></tr>`}</tbody></table></div>
        <div class="peek-foot">Only ${esc(r.owner_email || "this person")}'s own recordings import automatically.
          Anything else is here to import by hand if you want it — note that a meeting several people recorded
          appears once per recorder, so importing more than one copy will duplicate it.</div>`;
      panel.dataset.loaded = "1";
      wirePeekActions(panel);
    } catch (err) {
      panel.innerHTML = `<div class="peek-loading">${esc(err.message)}</div>`;
    } finally { btn.disabled = false; }
  }));

  document.querySelectorAll("[data-pull]").forEach(btn => btn.addEventListener("click", async () => {
    const id = btn.dataset.pull;
    setMsg(id, "Looking for your most recent call…");
    btn.disabled = true;
    try {
      const r = await api.post(`/integrations/${id}/pull-latest`);
      setMsg(id, r.message, r.ok);
      if (r.imported) {
        await refreshCalls();
        toast(`Imported ${r.client_name}`);
        openCall(r.call_id);
      } else {
        toast(r.message);
      }
    } catch (err) {
      setMsg(id, err.message, false);
    } finally {
      btn.disabled = false;
    }
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
