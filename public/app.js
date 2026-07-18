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
  $("#userAvatar").textContent = state.user.email.slice(0, 2).toUpperCase();
  state.accounts = (await api.get("/accounts")).accounts;
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

// ---------- settings menu ----------
// Activity / Templates / Integrations are setup-and-forget, so they live behind the profile
// rather than taking up permanent nav space in the nightly loop.
const settingsMenu = () => $("#settingsMenu");
function closeSettings() {
  settingsMenu().classList.add("hidden");
  $("#userBtn").setAttribute("aria-expanded", "false");
}
$("#userBtn").addEventListener("click", e => {
  e.stopPropagation();
  const open = settingsMenu().classList.toggle("hidden");
  $("#userBtn").setAttribute("aria-expanded", String(!open));
});
document.addEventListener("click", e => {
  if (!settingsMenu().contains(e.target)) closeSettings();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSettings(); });
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

$("#searchInput").addEventListener("input", e => { state.search = e.target.value.toLowerCase(); renderCallList(); });
$("#newCallBtn").addEventListener("click", () => { renderCompose(); showDetailMobile("New Call"); });

// ---------- call list ----------
async function refreshCalls() {
  // The archive is a separate fetch, not a client-side filter: the server excludes archived
  // calls by default, which is the whole point (the inbox stays small as the DB grows).
  const q = [];
  if (state.accountFilter) q.push(`account=${state.accountFilter}`);
  if (state.filter === "archived") q.push("archived=1");
  state.calls = (await api.get(`/calls${q.length ? "?" + q.join("&") : ""}`)).calls;
  renderCallList();
  syncPolling();
}

function visibleCalls() {
  return state.calls.filter(c => {
    // 'archived' is applied by the server (state.calls already holds only archived rows),
    // so it needs no outcome filter here.
    if (state.filter === "followup" && c.outcome !== "followup") return false;
    if (state.filter === "closed" && c.outcome !== "closed") return false;
    if (state.search && !`${c.client_name} ${offerLabel(c)} ${c.outcome || ""}`.toLowerCase().includes(state.search)) return false;
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
    return `<div class="call-item ${c.id === state.currentCallId ? "active" : ""}" data-id="${c.id}" tabindex="0" role="button">
      <div class="call-row1"><span class="call-name"><span class="dot-${st}" title="${STATE_TITLE[st]}"></span>${esc(c.client_name)}</span><span class="call-time">${fmtTime(c.occurred_at)}</span></div>
      <div class="call-meta">${pill}<span class="offer-tag">${esc(offerLabel(c))}</span>${flags.length ? `<span class="sent-flags">${flags.join(" · ")}</span>` : ""}</div>
    </div>`;
  }).join("") || `<div style="padding:20px 16px; font-size:12px; color:var(--ink-400);">No calls match.</div>`;
  wrap.querySelectorAll(".call-item").forEach(el => {
    const open = () => { const c = state.calls.find(x => x.id === +el.dataset.id); showDetailMobile(c?.client_name); openCall(+el.dataset.id); };
    el.addEventListener("click", open);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
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
  $("#mTitle").textContent = "Closer";
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
$("#navScrim")?.addEventListener("click", closeMobileNav);

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
  renderCallList();
  const { call, outputs } = await api.get(`/calls/${id}`);
  const st = callState(call);
  if (st === "processing") return renderWorking(call);
  if (st === "processed") return renderProcessed(call, outputs);
  return renderUnprocessed(call);   // covers 'new' and 'failed'

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
      <label>Transcript</label>
      <textarea readonly>${esc(call.transcript || "")}</textarea>
      <button class="primary-btn" id="processBtn">✦ ${call.processing_error ? "Try again" : "Generate Debrief, Text, Email &amp; CRM Note"}</button>
    </div>`;
  wireRename(call);
  wireCallActions(call);
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
  const q = state.accountFilter ? `?account=${state.accountFilter}` : "";
  const data = await api.get(`/insights${q}`);
  viewShell("Coaching Insights", `Averages across ${data.calls} processed calls`,
    `<h4>Average Scorecard</h4>
     <div class="insight-note">Blue ≥ 8 · Violet 6–7 · Pink &lt; 6 — pink dimensions are practice targets.</div>
     <div class="insight-grid">${data.averages.map(([k, v]) => `
       <div style="color:var(--ink-600)">${esc(k)}</div>
       <div style="font-family:var(--font-mono); font-weight:700; text-align:right; color:${tierColor(v)}">${v}</div>
       <div class="bar"><i style="width:${v * 10}%; background:${tierColor(v)}"></i></div>`).join("")}</div>
     <h4>Recurring "What Hurt The Sale"</h4><ul>${data.hurt.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
     <h4>Lessons Worth Keeping</h4><ul>${data.lessons.map(x => `<li>${esc(x)}</li>`).join("")}</ul>`);
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
  const { templates } = await api.get("/templates");
  viewShell("Prompt Templates", "The master prompt. Editing saves a new version — the old one is kept.",
    templates.filter(t => !t.tone).map(t =>
      `<h4>Master prompt · v${t.version}<span class="tpl-date"> · updated ${t.created_at ? fmtTime(t.created_at) : "—"}</span></h4>
        <textarea data-tpl="${t.id}">${esc(t.body)}</textarea>
        <button class="primary-btn" data-savetpl="${t.id}" style="margin:10px 0 20px;">Save as v${t.version + 1}</button>`
    ).join(""));
  document.querySelectorAll("[data-savetpl]").forEach(btn => btn.addEventListener("click", async () => {
    const body = document.querySelector(`textarea[data-tpl="${btn.dataset.savetpl}"]`).value;
    await api.put(`/templates/${btn.dataset.savetpl}`, { body });
    toast("Template saved as new version");
    renderTemplates();
  }));
}

// How each provider is actually connected (verified against current provider docs, 2026-07).
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

// Activity log — what ran, what broke, what it cost, and what actually gets used.
async function renderActivity() {
  const { events, totals } = await api.get("/events?limit=200");
  const money = t => t ? `$${(t / 1e6 * 2).toFixed(2)}` : "$0.00";  // Sonnet 5 intro input rate, rough

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

  viewShell("Activity", "Everything the app has done — failures, completions, token spend, and which outputs actually get used",
    `<div class="ev-summary">
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
          <button class="regen-btn" data-labelsave="${i.id}">Save label</button>
        </div>` : ""}
        <div class="key-row">
          <input type="password" class="key-input" data-int="${i.id}" autocomplete="off"
                 placeholder="${i.has_key ? "Paste a new key to replace the saved one" : "Paste your key here"}">
          <button class="key-reveal" data-reveal="${i.id}" title="Show what you typed">Show</button>
          <button class="primary-btn key-save" data-save="${i.id}">Save</button>
          <button class="regen-btn" data-test="${i.id}">Test</button>
          ${i.kind === "fathom" && i.has_key ? `<button class="regen-btn" data-pull="${i.id}">Pull latest call</button>` : ""}
          ${i.has_key ? `<button class="regen-btn key-remove" data-remove="${i.id}">Remove</button>` : ""}
        </div>
        <div class="key-foot">${state}<span class="key-msg" data-msg="${i.id}"></span></div>
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
    await api.post(`/integrations/${id}/label`, { label });
    toast(label ? `Calls from this key now show "${label}"` : "Label cleared");
    if (state.calls.length) await refreshCalls();   // reflect the relabel in the inbox immediately
    renderIntegrations();
  }));

  // Pull exactly one call — the most recent. Lands unprocessed; you choose when to spend tokens.
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
