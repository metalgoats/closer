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
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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
  try { state.user = (await api.get("/me")).user; await boot(); }
  catch { /* showAuth already called on 401 */ }
})();

// ---------- sidebar ----------
function renderAccountNav() {
  const nav = $("#accountNav");
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
    state.filter = el.dataset.filter;
    $("#listTitle").textContent = el.textContent.replace(/\d+$/, "").trim();
    renderCallList();
    openRelevantCall(); // also refresh the detail pane so we leave any workspace view
  });
});

const VIEWS = { insights: renderInsights, suggestions: renderSuggestions, templates: renderTemplates, integrations: renderIntegrations };
document.querySelectorAll(".nav-item[data-view]").forEach(el => {
  el.addEventListener("click", () => {
    document.querySelectorAll(".nav-item[data-filter], .nav-item[data-view]").forEach(n => n.classList.remove("active"));
    el.classList.add("active");
    VIEWS[el.dataset.view]();
  });
});

$("#searchInput").addEventListener("input", e => { state.search = e.target.value.toLowerCase(); renderCallList(); });
$("#newCallBtn").addEventListener("click", renderCompose);

// ---------- call list ----------
async function refreshCalls() {
  const q = state.accountFilter ? `?account=${state.accountFilter}` : "";
  state.calls = (await api.get(`/calls${q}`)).calls;
  updateCounts();
  renderCallList();
}

function updateCounts() {
  $("#countAll").textContent = state.calls.length;
  $("#countFollowup").textContent = state.calls.filter(c => c.outcome === "followup").length;
  $("#countClosed").textContent = state.calls.filter(c => c.outcome === "closed").length;
}

function visibleCalls() {
  return state.calls.filter(c => {
    if (state.filter === "followup" && c.outcome !== "followup") return false;
    if (state.filter === "closed" && c.outcome !== "closed") return false;
    if (state.search && !`${c.client_name} ${c.account_name} ${c.outcome || ""}`.toLowerCase().includes(state.search)) return false;
    return true;
  });
}

function renderCallList() {
  const wrap = $("#callScroll");
  wrap.innerHTML = visibleCalls().map(c => {
    const pill = !c.processed_at ? `<span class="pill pill-new">New</span>`
      : c.outcome === "closed" ? `<span class="pill pill-closed">Closed</span>`
      : `<span class="pill pill-followup">Follow-up</span>`;
    const flags = [];
    if (c.sms_sent) flags.push("✓ text");
    if (c.email_sent) flags.push("✓ email");
    return `<div class="call-item ${c.id === state.currentCallId ? "active" : ""}" data-id="${c.id}" tabindex="0" role="button">
      <div class="call-row1"><span class="call-name">${esc(c.client_name)}</span><span class="call-time">${fmtTime(c.occurred_at)}</span></div>
      <div class="call-meta">${pill}<span class="offer-tag">${esc(c.account_name)}</span>${flags.length ? `<span class="sent-flags">${flags.join(" · ")}</span>` : ""}</div>
    </div>`;
  }).join("") || `<div style="padding:20px 16px; font-size:12px; color:var(--ink-400);">No calls match.</div>`;
  wrap.querySelectorAll(".call-item").forEach(el => {
    const open = () => openCall(+el.dataset.id);
    el.addEventListener("click", open);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

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
  if (!call.processed_at) return renderUnprocessed(call);
  renderProcessed(call, outputs);
}

function toneOf(call) { return call.selected_tone || call.suggested_tone || "balanced"; }

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
          <div class="dh-name">${esc(call.client_name)} ${pill}</div>
          <div class="dh-meta">${esc(call.account_name)}<span class="sep">·</span>${call.duration_min ? call.duration_min + " min" : ""} ${fmtTime(call.occurred_at)}<span class="sep">·</span>${srcBadge}</div>
        </div>
        <div class="dh-actions"><button class="regen-btn" id="regenBtn">↻ Regenerate</button></div>
      </div>
      <div class="tone-row">
        <span class="tone-label">Text &amp; email tone</span>
        <div class="tone-seg">${["casual", "balanced", "formal"].map(t =>
          `<button class="tone-opt ${t === tone ? "selected" : ""}" data-tone="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>
        ${call.suggested_tone ? `<span class="tone-suggested">✦ Suggested: ${call.suggested_tone}</span>` : ""}
        <span class="applies-to">${esc(call.tone_reason || "")}</span>
      </div>
    </div>
    ${call.outcome === "followup" ? `
      <div class="followup-banner">
        <div class="followup-banner-row"><b>Follow-up needed</b><span>${esc(call.callback_note || "")}</span>
          ${call.precall_brief ? `<button class="brief-toggle" id="briefToggle">Pre-call brief</button>` : ""}</div>
        ${call.precall_brief ? `<div class="brief-body hidden" id="briefBody">${esc(call.precall_brief)}</div>` : ""}
      </div>` : ""}

    <!-- Debrief: full-width section (per Gabriel's feedback) -->
    <div class="debrief-section">
      <div class="debrief-head"><h3>Debrief</h3>
        <button class="copy-btn" id="copyDebrief">⧉ Copy</button></div>
      <div class="panel-subnav">${["Scorecard", "Did Well", "Hurt Sale", "Objections", "Client Profile", "Buying Signals", "Lessons"].map((t, i) =>
        `<button class="chip" data-jump="dsec${i}">${t}</button>`).join("")}</div>
      <div class="debrief-body" id="debriefBody">
        ${highlights(d)}
        <div class="debrief-cols">
          <h4 id="dsec0">Call Scorecard</h4>${scorecard(d.scorecard)}
          <h4 id="dsec1">What You Did Well</h4><ul>${(d.didWell || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul>
          <h4 id="dsec2">What Hurt The Sale</h4><ul>${(d.hurtSale || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul>
          <h4 id="dsec3">Objection Autopsy</h4>${(d.objections || []).map(o => `
            <div class="objection"><div class="said">"${esc(o.said)}"</div>
            <dl><dt>Meant</dt><dd>${esc(o.meant)}</dd><dt>Felt</dt><dd>${esc(o.felt)}</dd>
            <dt>Say instead</dt><dd>${esc(o.should)}</dd><dt>Follow-up</dt><dd>${esc(o.follow)}</dd>
            <dt>Loop back</dt><dd>${esc(o.loop)}</dd></dl></div>`).join("")}
          <h4 id="dsec4">Client Profile</h4><ul>${(d.profile || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul>
          <h4 id="dsec5">Buying Signals + Red Flags</h4><ul>${(d.buyingSignals || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul>
          <h4 id="dsec6">Coaching Lessons</h4><ul>${(d.lessons || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul>
        </div>
      </div>
    </div>

    <!-- Three columns: Text / Email / GHL Note -->
    <div class="outputs">
      ${outputPanel("Text Message", sms, { sent: true })}
      ${outputPanel("Email", email, { sent: true, subject: true })}
      ${outputPanel("GoHighLevel Note", ghl, {})}
    </div>`;

  wireDetail(call, { sms, email, ghl });
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
function scorecard(rows) {
  return `<div class="scorecard">${(rows || []).map(([k, v]) => `
    <div class="k">${esc(k)}</div><div class="v" style="color:${tierColor(v)}">${v}/10</div>
    <div class="bar"><i style="width:${v * 10}%; background:${tierColor(v)}"></i></div>`).join("")}</div>`;
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
  // jump chips
  document.querySelectorAll(".chip[data-jump]").forEach(chip => chip.addEventListener("click", () => {
    const el = document.getElementById(chip.dataset.jump);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }));

  // tone switch
  document.querySelectorAll(".tone-opt").forEach(btn => btn.addEventListener("click", async () => {
    await api.patch(`/calls/${call.id}`, { selected_tone: btn.dataset.tone });
    openCall(call.id);
  }));

  // pre-call brief
  const bt = $("#briefToggle");
  if (bt) bt.addEventListener("click", () => $("#briefBody").classList.toggle("hidden"));

  // regenerate
  $("#regenBtn").addEventListener("click", async () => {
    renderLoading(call.client_name);
    await api.post(`/calls/${call.id}/process`);
    await refreshCalls();
    openCall(call.id);
  });

  // copy debrief
  $("#copyDebrief").addEventListener("click", e => copyText($("#debriefBody").innerText, e.currentTarget));

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
      <div class="dh-name">${esc(call.client_name)} <span class="pill pill-new">New</span></div>
      <div class="dh-meta">${esc(call.account_name)}<span class="sep">·</span>transcript ready, not yet processed</div>
    </div></div></div>
    <div class="compose-body">
      <label>Transcript</label>
      <textarea readonly>${esc(call.transcript || "")}</textarea>
      <button class="primary-btn" id="processBtn">✦ Generate Debrief, Text, Email &amp; CRM Note</button>
    </div>`;
  $("#processBtn").addEventListener("click", async () => {
    renderLoading(call.client_name);
    await api.post(`/calls/${call.id}/process`);
    await refreshCalls();
    openCall(call.id);
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
    renderLoading(client_name);
    const { call } = await api.post("/calls", { account_id: +$("#composeAccount").value, client_name, transcript });
    await refreshCalls();
    openCall(call.id);
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
  viewShell("Prompt Templates", "One master prompt per account — versioned; editing creates a new version",
    templates.filter(t => !t.tone).map(t => {
      const acct = state.accounts.find(a => a.id === t.account_id);
      return `<h4>${esc(acct?.name || "Account " + t.account_id)} · v${t.version}</h4>
        <textarea data-tpl="${t.id}">${esc(t.body)}</textarea>
        <button class="primary-btn" data-savetpl="${t.id}" style="margin:10px 0 20px;">Save as v${t.version + 1}</button>`;
    }).join(""));
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

async function renderIntegrations() {
  const { integrations } = await api.get("/integrations");
  const byAccount = {};
  for (const i of integrations) (byAccount[i.account_name] = byAccount[i.account_name] || []).push(i);

  const rows = Object.entries(byAccount).map(([acct, items]) => `
    <h4>${esc(acct)}</h4>
    ${items.map(i => {
      const m = INTEGRATION_META[i.kind] || { label: i.kind, method: "key", how: "" };

      // GHL is OAuth — a Connect button, not a key field.
      if (m.method === "login") {
        return `<div class="integration-row"><div>
            <div class="integration-name">${m.label} ${METHOD_BADGE[m.method]}</div>
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
            <div class="integration-name">${m.label} ${METHOD_BADGE[m.method]}</div>
            <div class="integration-sub">${esc(m.how)}</div>
          </div>
          <span class="status-chip ${i.status === "connected" ? "status-on" : "status-off"}">${i.status}</span>
        </div>
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
