/**
 * FixPath — mobile-style console for the Smart Guided Troubleshooting Engine.
 *
 * Screens are grouped in two families:
 *   tabs  — Home / History / Explore / Profile, switched by the bottom nav
 *   flow  — the diagnose stack (voice → understand → steps → guided →
 *           result) plus Device Information and Engine Metrics, both
 *           reached from Profile. Flow screens have no bottom nav.
 *
 * Everything still runs against the real engine: /api/health,
 * /api/reference, /api/troubleshoot, /api/metrics. Nothing here invents
 * steps or deeplinks — same rule as the original console.
 */

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const HISTORY_KEY = "fixpath-history-v1";
const THEME_KEY = "sgte-theme";

const state = {
  health: null,
  reference: [],
  plan: null,      // last /api/troubleshoot payload
  actions: [],      // ctx.actions for the current plan
  at: 0,            // current action index in the guided walkthrough
  lastQuery: "",
  lastRefId: null,
  historySeg: "recent",
  historySort: "new",
  exploreSeg: "guides",
  exploreQuery: ""
};

/* The demo reference corpus is all display/touch related, so the home
   categories are built from clusters that are guaranteed to resolve to a
   real reference article rather than generic phone categories that this
   dataset has no answer for. */
const CATEGORIES = [
  { key: "blank", label: "Blank & Black Screen", query: "my screen went completely black and I can't see anything", ref: "row_2", bg: "rgba(59,130,246,.16)", fg: "#7fabff", icon: "monitor" },
  { key: "flicker", label: "Camera & Flicker", query: "the screen flickers when I record video", ref: "row_10", bg: "rgba(168,85,247,.16)", fg: "#c9a2fb", icon: "camera" },
  { key: "cracked", label: "Cracked Screen", query: "my smartphone's screen is completely cracked, it's a total crack and I can't use the device", ref: "row_14", bg: "rgba(242,99,91,.16)", fg: "#f78d86", icon: "crack" },
  { key: "touch", label: "Touch & Response", query: "the navigation bar gets in the way and touch feels unresponsive", ref: "row_21", bg: "rgba(20,184,166,.16)", fg: "#5eead4", icon: "activity" },
  { key: "rotate", label: "Screen Rotation", query: "the screen won't rotate when I turn the phone", ref: "row_20", bg: "rgba(240,169,58,.16)", fg: "#f6c064", icon: "rotate" },
  { key: "sync", label: "Apps & Sync", query: "my email stopped syncing on my phone", ref: "row_1", bg: "rgba(148,163,184,.18)", fg: "#c3cadd", icon: "grid" }
];

const VOICE_SAMPLES = [
  "the navigation bar gets in the way and touch feels unresponsive",
  "the screen flickers when I record video",
  "my screen went completely black and I can't see anything"
];

const TIPS = [
  { title: "Restart weekly", desc: "A weekly restart clears memory and can fix small glitches before they build up.", icon: "power" },
  { title: "Keep software current", desc: "Software updates carry the fixes referenced in these guides — check for updates regularly.", icon: "refresh" },
  { title: "Watch storage headroom", desc: "Devices slow down and apps misbehave when storage runs close to full.", icon: "disc" },
  { title: "Review app permissions", desc: "Apps with unnecessary background or location permissions drain battery and can cause odd behaviour.", icon: "shield" }
];

const CATEGORY_NOTE = {
  auto: "This opens directly in your device settings — use the button below to jump straight there.",
  manual: "This step happens away from the screen, so there's nothing for the device to open — follow the wording exactly.",
  critical: "This action is more disruptive, so it's deliberately saved for last. Only do this if the steps above didn't help."
};

/* =============================================================== icons */

const ICON = {
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  camera: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7l1.5-3h5L16 7"/><circle cx="12" cy="13.5" r="3.2"/>',
  crack: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="m9 6 2 3-2 3 3 3-2 4"/>',
  activity: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
  rotate: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M20 19H6.5A2.5 2.5 0 0 0 4 21.5"/>',
  bulb: '<path d="M9 18h6M10 22h4"/><path d="M12 2a6 6 0 0 0-3.5 10.9c.6.5.9 1 .9 1.6V16h5.2v-1.5c0-.6.3-1.1.9-1.6A6 6 0 0 0 12 2z"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
  power: '<path d="M12 2v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  shield: '<path d="M12 2 4 5v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V5z"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  star: '<path d="m12 3 2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L12 16.9 6.4 20l1.4-6.2-4.8-4.3 6.4-.6z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>'
};
const svg = (name, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24">${ICON[name] || ICON.alert}</svg>`;

/* ================================================================= nav */

function stopVoiceIfNeeded() {
  if (Recognizer.listening) {
    try { Recognizer.rec?.abort(); } catch {}
  }
  Recognizer.listening = false;
  Recognizer.rec = null;
  try { window.speechSynthesis?.cancel(); } catch {}
  const btn = $("#voiceMainMic");
  if (btn) btn.classList.remove("is-listening", "rec");
}

function showTab(name) {
  stopVoiceIfNeeded();
  $$(".tab").forEach(s => s.classList.toggle("is-active", s.dataset.tab === name));
  $$(".flow").forEach(s => s.classList.remove("is-active"));
  $$(".navbtn[data-tab]").forEach(b => b.classList.toggle("is-current", b.dataset.tab === name));
  window.scrollTo({ top: 0 });
  if (name === "history") renderHistory();
  if (name === "explore") renderExplore();
}

function showFlow(name) {
  if (name !== "voice") stopVoiceIfNeeded();
  $$(".tab").forEach(s => s.classList.remove("is-active"));
  $$(".flow").forEach(s => s.classList.toggle("is-active", s.id === `flow-${name}`));
  $("#phone").scrollTop = 0;
}

$$(".navbtn[data-tab]").forEach(b => b.addEventListener("click", ev => {
  ev.preventDefault();
  ev.stopPropagation();
  showTab(b.dataset.tab);
}));
$$("[data-back]").forEach(b => b.addEventListener("click", () => {
  const t = b.dataset.back;
  ["home", "history", "explore", "profile"].includes(t) ? showTab(t) : showFlow(t);
}));

/* =============================================================== theme */

try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) document.documentElement.dataset.theme = saved;
} catch { /* storage can be blocked; default theme still applies */ }

function applyThemeUI() {
  const light = document.documentElement.dataset.theme === "light";
  const sw = $("#themeSwitch");
  sw.setAttribute("aria-checked", String(!light));
  $("#themeSub").textContent = light ? "Light" : "Dark";
}

$("#themeSwitch").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* not fatal */ }
  applyThemeUI();
});

/* ============================================================== toast */

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ============================================================= history */

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch { return []; }
}
function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 30))); } catch { /* storage can be blocked */ }
}
function pushHistory(entry) {
  const list = loadHistory();
  list.unshift(entry);
  saveHistory(list);
}
function updateHistoryEntry(id, patch) {
  const list = loadHistory();
  const i = list.findIndex(e => e.id === id);
  if (i >= 0) { list[i] = { ...list[i], ...patch }; saveHistory(list); }
}

function renderHistory() {
  const list = loadHistory();
  let rows = state.historySeg === "favourites" ? list.filter(e => e.favourite) : list;
  rows = [...rows].sort((a, b) => state.historySort === "new" ? b.ts - a.ts : a.ts - b.ts);

  const el = $("#historyList");
  if (!rows.length) {
    el.innerHTML = `<p class="empty">${state.historySeg === "favourites"
      ? "No favourites yet — star a diagnosis to keep it here."
      : "No diagnoses yet. Describe a problem on Home to get started."}</p>`;
    return;
  }

  el.innerHTML = rows.map(e => `
    <button class="row" data-hid="${e.id}">
      <span class="ri" style="background:${e.bg};color:${e.fg}">${svg(e.icon)}</span>
      <span class="rt"><b>${esc(e.title)}</b><small>${e.actionsCount} step${e.actionsCount === 1 ? "" : "s"} · ${fmtDate(e.ts)}${e.completed ? " · resolved" : ""}</small></span>
      <button class="rstar${e.favourite ? " on" : ""}" data-fav="${e.id}" aria-label="Toggle favourite">${svg("star")}</button>
    </button>`).join("");

  $$("[data-fav]").forEach(b => b.addEventListener("click", ev => {
    ev.stopPropagation();
    const list2 = loadHistory();
    const item = list2.find(e => e.id === b.dataset.fav);
    if (item) { updateHistoryEntry(item.id, { favourite: !item.favourite }); renderHistory(); }
  }));
  $$("[data-hid]").forEach(b => b.addEventListener("click", () => resumeHistory(b.dataset.hid)));
}

function resumeHistory(id) {
  const item = loadHistory().find(e => e.id === id);
  if (!item) return;
  state.plan = item.plan;
  state.actions = item.plan.response.contexts[0].actions;
  state.at = 0;
  state.lastQuery = item.query;
  state.lastRefId = item.refId;
  state._historyId = item.id;
  renderStepsOverview(item.plan);
  showFlow("steps");
}

function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

$$("[data-seg]").forEach(b => b.addEventListener("click", () => {
  const group = b.parentElement;
  $$(".seg", group).forEach(s => s.classList.toggle("is-current", s === b));
  if (group.closest("#tab-history")) { state.historySeg = b.dataset.seg; renderHistory(); }
  if (group.closest("#tab-explore")) { state.exploreSeg = b.dataset.seg; renderExplore(); }
}));

$("#historyFilterBtn").addEventListener("click", () => {
  state.historySort = state.historySort === "new" ? "old" : "new";
  renderHistory();
  toast(state.historySort === "new" ? "Sorted by most recent" : "Sorted by oldest first");
});

$("#clearHistoryRow").addEventListener("click", () => {
  if (!loadHistory().length) { toast("History is already empty"); return; }
  if (confirm("Clear all saved diagnoses? Favourites will be removed too.")) {
    saveHistory([]);
    renderHistory();
    renderHomeRecent();
    toast("History cleared");
  }
});

/* ================================================================= boot */

async function boot() {
  const serverUrl = document.getElementById("serverUrl");
  if (serverUrl && location.protocol !== "file:") serverUrl.textContent = location.origin;
  applyThemeUI();
  renderCategories();
  renderHomeRecent();

  try {
    const [health, ref] = await Promise.all([
      fetch("/api/health").then(r => r.json()),
      fetch("/api/reference").then(r => r.json())
    ]);
    state.health = health;
    state.reference = ref.rows || [];
    $("#aboutSub").textContent = `Version 1.0.0 · ${health.catalog.entries} deeplinks`;
  } catch {
    $("#offlineBanner").hidden = false;
    toast("Could not reach the server — is it still running?");
  }
}

function renderCategories() {
  $("#catGrid").innerHTML = CATEGORIES.map(c => `
    <button class="cattile" data-cat="${c.key}">
      <span class="ci" style="background:${c.bg};color:${c.fg}">${svg(c.icon)}</span>
      <span>${esc(c.label)}</span>
    </button>`).join("");
  $$("[data-cat]").forEach(b => b.addEventListener("click", () => {
    const c = CATEGORIES.find(x => x.key === b.dataset.cat);
    startDiagnose(c.query, c.ref);
  }));
}

function renderHomeRecent() {
  const list = loadHistory().slice(0, 2);
  $("#recentLabel").hidden = list.length === 0;
  $("#homeRecent").innerHTML = list.length ? `<div class="rowlist">${list.map(e => `
    <button class="row" data-resume="${e.id}">
      <span class="ri" style="background:${e.bg};color:${e.fg}">${svg(e.icon)}</span>
      <span class="rt"><b>${esc(e.title)}</b><small>${e.actionsCount} steps · ${fmtDate(e.ts)}</small></span>
      <svg class="chev">${ICON.chevron}</svg>
    </button>`).join("")}</div>` : "";
  $$("[data-resume]").forEach(b => b.addEventListener("click", () => resumeHistory(b.dataset.resume)));
}

/* ============================================================ diagnose */

$("#homeGo").addEventListener("click", () => runFromHomeInput());
$("#homeSearch").addEventListener("keydown", e => { if (e.key === "Enter") runFromHomeInput(); });
function runFromHomeInput() {
  const q = $("#homeSearch").value.trim();
  if (!q) { toast("Describe the problem first."); return; }
  startDiagnose(q, null);
}

$("#continueBtn").addEventListener("click", () => { renderStepsOverview(state.plan); showFlow("steps"); });

async function startDiagnose(query, refId) {
  toast("Diagnosing…");
  try {
    const res = await fetch("/api/troubleshoot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, refId: refId || null })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "request failed");

    if (!data.response.contexts.length) {
      toast(explainEmpty(data));
      return;
    }

    state.plan = data;
    state.lastQuery = query;
    state.lastRefId = refId || null;
    state.actions = data.response.contexts[0].actions;
    state.at = 0;

    const cat = CATEGORIES.find(c => c.ref === refId) || { icon: "alert", bg: "var(--surface-2)", fg: "var(--ink-2)" };
    const id = `h_${Date.now()}`;
    state._historyId = id;
    pushHistory({
      id, ts: Date.now(), query, refId: refId || null,
      title: data.response.contexts[0].title,
      actionsCount: state.actions.length,
      favourite: false, completed: false, plan: data,
      icon: cat.icon, bg: cat.bg, fg: cat.fg
    });

    renderUnderstand(data);
    showFlow("understand");
  } catch (err) {
    toast(`Something went wrong: ${err.message}`);
  }
}

function explainEmpty(data) {
  if (data.fallback === "no_siis_context") {
    return "No reference article matches that yet — try one of the categories on Home.";
  }
  return "The matched article had no instructions the engine could turn into steps.";
}

/* --------------------------------------------------------- understand -- */

function renderUnderstand(data) {
  const ctx = data.response.contexts[0];
  $("#detectedCard").innerHTML = `
    <span class="di">${svg("alert")}</span>
    <span class="dt"><b>${esc(ctx.title)}</b><small>${esc(ctx.goal)}</small></span>
    <button id="editIssueBtn" type="button">Edit</button>`;
  $("#editIssueBtn").addEventListener("click", () => {
    showTab("home");
    $("#homeSearch").value = state.lastQuery;
    $("#homeSearch").focus();
  });

  $("#causeList").innerHTML = ctx.actions.slice(0, 4).map(a => `
    <div class="causeitem">
      <span class="ci2">${svg(a.category === "manual" ? "activity" : a.category === "critical" ? "alert" : "grid")}</span>
      <span class="txt">${esc(a.description || a.actionName)}</span>
    </div>`).join("");

  $("#understandHint").hidden = true;
}

/* -------------------------------------------------------------- steps -- */

function renderStepsOverview(data) {
  const ctx = data.response.contexts[0];
  $("#stepOverviewList").innerHTML = ctx.actions.map((a, i) => `
    <button class="stepover" data-step="${i}">
      <span class="sn">${i + 1}</span>
      <span class="sb"><b>${esc(a.actionName)}</b><small>${esc(a.description)}</small></span>
      <svg class="chev">${ICON.chevron}</svg>
    </button>`).join("");

  $$("[data-step]").forEach(b => b.addEventListener("click", () => {
    state.at = Number(b.dataset.step);
    renderGuidedStep();
    showFlow("guided");
  }));

  renderTech(data);
}

/* ------------------------------------------------------------- guided -- */

function actionSteps(a) {
  const out = [];
  a.stepGroups.forEach(g => g.steps.forEach(text => out.push({ text, group: g })));
  return out;
}

function deeplinkBtn(dl) {
  const generic = /dummy_positive/.test(dl.deeplink);
  return `<button class="deeplink${generic ? " placeholder" : ""}" data-uri="${esc(dl.deeplink)}">
    ${svg("external")}${esc(dl.message || "Open screen")}
  </button>`;
}
function bindDeeplinks(root) {
  root.querySelectorAll(".deeplink").forEach(b => b.addEventListener("click", () => {
    navigator.clipboard?.writeText(b.dataset.uri).catch(() => {});
    toast(`Deeplink copied — ${b.dataset.uri}`);
  }));
}

function renderGuidedStep() {
  const total = state.actions.length;
  const a = state.actions[state.at];
  $("#assistPanel").hidden = true;

  $("#guidedHeaderTitle").textContent = `Step ${state.at + 1} of ${total}`;
  $("#guidedEyebrow").textContent = `Step ${state.at + 1} of ${total}`;
  $("#guidedTitle").textContent = a.actionName;
  $("#guidedSub").textContent = a.description;

  $("#guidedDots").innerHTML = Array.from({ length: total }, (_, i) =>
    `<span class="${i < state.at ? "done" : ""}"></span>`).join("");

  const steps = actionSteps(a);
  $("#guidedChecklist").innerHTML = steps.map((s, i) => `<div class="checkitem"><span class="cn">${i + 1}</span><span class="ct">${esc(s.text)}</span></div>`).join("");

  const linkBlocks = a.stepGroups.map(g => {
    if (g.actionableDeeplink || g.validationDeeplink) {
      return `<div class="links">
        ${g.actionableDeeplink ? deeplinkBtn(g.actionableDeeplink) : ""}
        ${g.validationDeeplink ? `<span class="validation">Verifies: ${esc(g.validationDeeplink.key)}</span>` : ""}
      </div>`;
    }
    return a.category === "manual"
      ? `<p class="nolink">No deeplink — this happens away from the screen.</p>`
      : `<p class="nolink">No deeplink — the catalog has no entry for this screen.</p>`;
  }).join("");
  $("#guidedChecklist").innerHTML += linkBlocks;
  bindDeeplinks($("#guidedChecklist"));

  const tip = $("#guidedTip");
  tip.hidden = false;
  tip.innerHTML = `${svg("bulb")}<p><b>Samsung tip:</b> ${esc(CATEGORY_NOTE[a.category] || "")}</p>`;

  $("#nextBtn").textContent = state.at === total - 1 ? "Finish" : "Mark as done";
}

$("#nextBtn").addEventListener("click", () => {
  if (state.at >= state.actions.length - 1) {
    if (state._historyId) updateHistoryEntry(state._historyId, { completed: true });
    showFlow("result");
    return;
  }
  state.at++;
  renderGuidedStep();
});
$("#prevBtn").addEventListener("click", () => {
  if (state.at === 0) { showFlow("steps"); return; }
  state.at--;
  renderGuidedStep();
});
$("#stuckBtn").addEventListener("click", showAssist);

function showAssist() {
  const a = state.actions[state.at];
  const ctx = state.plan.response.contexts[0];
  const nextAction = ctx.actions[state.at + 1];
  const dl = a.stepGroups.find(g => g.actionableDeeplink)?.actionableDeeplink;
  const validation = a.stepGroups.find(g => g.validationDeeplink)?.validationDeeplink;

  const items = [];
  items.push(["What this step is for", `${esc(a.description)}. ${CATEGORY_NOTE[a.category] || ""}`]);
  items.push(dl
    ? ["Where to find it", `The catalog entry behind this step is <b>${esc(dl.message || "—")}</b>. Use the button on the step to copy its deeplink.`]
    : ["Where to find it", `The catalog has no deeplink for this screen — follow the wording of the steps exactly as written.`]);
  if (validation) items.push(["How the engine checks it", `This step carries a validation deeplink on <b>${esc(validation.key)}</b>, which confirms the change took effect.`]);
  items.push(["If it still doesn't work", nextAction
    ? `Move on to <b>${esc(nextAction.actionName)}</b> — actions are ordered from least to most disruptive.`
    : `This is the last action in the plan — nothing further is covered by the reference article.`]);

  const panel = $("#assistPanel");
  panel.innerHTML = `<h4>Help with this step</h4><dl>${items.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join("")}</dl>
    <p class="source">Assembled from the reference article and the deeplink catalog — nothing here is generated.</p>`;
  panel.hidden = false;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* -------------------------------------------------------------- result- */

$("#retryBtn").addEventListener("click", () => { showTab("home"); $("#homeSearch").value = ""; $("#homeSearch").focus(); });
$("#relatedBtn").addEventListener("click", () => { showTab("explore"); });

/* =============================================================== tech */

function renderTech(data) {
  const d = data.diagnostics || {};
  const v = data.validation || {};
  const decisions = d.mapping?.decisions || [];
  const rows = decisions.map(x => `
    <tr><td>${esc(x.action)}</td><td>${esc(x.target || "—")}</td>
      <td class="${x.decision === "matched" ? "ok" : "no"}">${esc(x.decision)}</td>
      <td class="no">${esc(x.message || x.reason || "")}</td></tr>`).join("");

  $("#techBody").innerHTML = `
    <div class="techblock">
      <h4>Phase 0 — query enrichment</h4>
      <dl class="kv"><dt>Canonical key</dt><dd><code>${esc(d.key || "—")}</code></dd>
        <dt>Path</dt><dd>${esc(d.path || "—")}${d.match ? ` (${esc(d.match)} hit)` : ""}</dd></dl>
      <div class="vlist" style="margin-top:10px">${(data.query_variations || []).map(x => `<span>${esc(x)}</span>`).join("")}</div>
    </div>
    <div class="techblock">
      <h4>Phase 2 — deeplink mapping</h4>
      ${decisions.length ? `<table class="tech"><thead><tr><th>Action</th><th>Target</th><th>Decision</th><th>Catalog entry / reason</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<p class="hint" style="color:var(--muted)">Served from cache — mapping ran when the plan was first built.</p>`}
    </div>
    <div class="techblock">
      <h4>Phase 4 — validation</h4>
      <dl class="kv"><dt>Schema &amp; rules</dt><dd>${v.ok ? "passed" : `failed: ${esc(JSON.stringify(v.errors || []))}`}</dd>
        <dt>Catalog URIs</dt><dd>checked against ${state.health?.catalog.uris ?? "—"} in the catalog</dd></dl>
    </div>
    <div class="techblock">
      <h4>Response payload</h4>
      <pre class="json">${esc(JSON.stringify({ query: data.query, query_variations: data.query_variations, response: data.response, meta: data.meta }, null, 2))}</pre>
    </div>`;
}

/* ============================================================ explore */

function renderExplore() {
  const q = state.exploreQuery.toLowerCase();
  let rows = [];
  if (state.exploreSeg === "tips") {
    $("#exploreList").innerHTML = TIPS
      .filter(t => !q || t.title.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q))
      .map(t => `<div class="row" style="cursor:default"><span class="ri" style="background:var(--accent-soft);color:var(--accent-ink)">${svg(t.icon)}</span><span class="rt"><b>${esc(t.title)}</b><p>${esc(t.desc)}</p></span></div>`)
      .join("") || `<p class="empty">No tips match “${esc(state.exploreQuery)}”.</p>`;
    return;
  }

  rows = state.reference;
  if (state.exploreSeg === "issues") {
    rows = rows.filter(r => /blank|black/i.test(r.title));
  }
  if (q) rows = rows.filter(r => r.title.toLowerCase().includes(q) || r.query.toLowerCase().includes(q));

  $("#exploreList").innerHTML = rows.length ? rows.map(r => `
    <button class="row" data-guide="${esc(r.id)}">
      <span class="ri" style="background:var(--surface-2);color:var(--ink-2)">${svg("book")}</span>
      <span class="rt"><b>${esc(r.title)}</b><small>${esc(r.query.slice(0, 70))}${r.query.length > 70 ? "…" : ""}</small></span>
      <svg class="chev">${ICON.chevron}</svg>
    </button>`).join("") : `<p class="empty">No guides match “${esc(state.exploreQuery)}”.</p>`;

  $$("[data-guide]").forEach(b => b.addEventListener("click", () => {
    const row = state.reference.find(r => r.id === b.dataset.guide);
    if (row) startDiagnose(row.query, row.id);
  }));
}

$("#exploreSearchBtn").addEventListener("click", () => {
  const bar = $("#exploreSearchBar");
  bar.hidden = !bar.hidden;
  if (!bar.hidden) $("#exploreSearch").focus();
});
$("#exploreSearch").addEventListener("input", e => { state.exploreQuery = e.target.value.trim(); renderExplore(); });

/* ============================================================== profile */

$("#deviceInfoRow").addEventListener("click", () => { renderDeviceInfo(); showFlow("device"); });
$("#profileBtn").addEventListener("click", () => { renderDeviceInfo(); showFlow("device"); });
$("#menuBtn").addEventListener("click", () => showTab("profile"));
$("#metricsRow").addEventListener("click", () => { showFlow("metrics"); loadMetrics(); });
$("#languageRow").addEventListener("click", () => toast("English is the only language available in this demo."));
$("#aboutRow").addEventListener("click", () => {
  const h = state.health;
  toast(h ? `FixPath demo UI v1.0.0 · ${h.catalog.entries} deeplinks · ${h.cache.entries} cached plans` : "FixPath demo UI v1.0.0");
});

function renderDeviceInfo() {
  const rows = [
    { label: "Model", value: "Galaxy S23" },
    { label: "Android version", value: "Android 14" },
    { label: "One UI version", value: "6.1" },
    { label: "Serial number", value: "RZC*********" },
    { label: "Warranty status", value: `<span class="dot-active">Active</span>` }
  ];
  const links = [
    { label: "User manual", href: "https://www.samsung.com/us/support/owners/product/galaxy-s23", icon: "book" },
    { label: "Samsung support", href: "https://www.samsung.com/us/support/", icon: "external" }
  ];
  $("#deviceInfoList").innerHTML = `
    <div class="infolist">
      ${rows.map(r => `<div class="inforow"><span class="il">${esc(r.label)}</span><span class="iv">${r.value}</span></div>`).join("")}
    </div>
    <div class="infolist" style="margin-top:14px">
      ${links.map(l => `<div class="inforow"><span class="il">${svg(l.icon)}${esc(l.label)}</span><a class="iv" href="${l.href}" target="_blank" rel="noopener">Open ${svg("external")}</a></div>`).join("")}
      <button class="inforow" id="swUpdateRow" style="width:100%;background:none;border:none;color:inherit;font:inherit;cursor:pointer;text-align:left">
        <span class="il">${svg("refresh")}Software update</span><span class="iv">Check now</span>
      </button>
    </div>`;
  $("#swUpdateRow").addEventListener("click", () => {
    toast("Checking for updates…");
    setTimeout(() => toast("Your software is up to date."), 900);
  });
}

/* ============================================================ metrics */

async function loadMetrics() {
  const el = $("#metricsBody");
  el.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const m = await fetch("/api/metrics").then(r => r.json());
    const c = m.counters || {}, lat = m.latency || {};
    el.innerHTML = `
      <div class="mgrid">
        ${stat("Requests", c.requests ?? 0)}
        ${stat("Cache hit rate", `${Math.round((m.cacheHitRate || 0) * 100)}<small>%</small>`)}
        ${stat("Fast path P50", `${(lat.fastPath?.p50 ?? 0).toFixed(2)}<small>ms</small>`)}
        ${stat("Cold path P95", `${(lat.coldPath?.p95 ?? 0).toFixed(2)}<small>ms</small>`)}
        ${stat("Within 300 ms", `${Math.round((m.withinBudget || 0) * 100)}<small>%</small>`)}
        ${stat("Cached plans", m.cache?.entries?.length ?? 0)}
      </div>
      <div class="card techblock" style="padding:16px">
        <h4>Cache hits by how they were found</h4>
        <dl class="kv"><dt>Exact canonical key</dt><dd>${c.exact ?? 0}</dd>
          <dt>Known paraphrase</dt><dd>${c.variation ?? 0}</dd>
          <dt>Fuzzy content overlap</dt><dd>${c.fuzzy ?? 0}</dd>
          <dt>Misses (cold path)</dt><dd>${c.coldPath ?? 0}</dd></dl>
      </div>`;
  } catch {
    el.innerHTML = `<p class="muted">Couldn't load metrics.</p>`;
  }
}
const stat = (label, value) => `<div class="card mstat"><p class="label">${label}</p><p class="value">${value}</p></div>`;

/* ============================================================== voice */

const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
const SpeechOutput = "speechSynthesis" in window;
const Recognizer = { listening: false, rec: null, stop() { try { this.rec?.stop(); } catch {} } };

function voiceText(text) {
  const el = $("#voiceTranscript");
  if (!el) return;
  const value = String(text || "").trim();
  el.innerHTML = value ? `<span>${esc(value)}</span>` : `<span class="muted">Your words will appear here…</span>`;
}

function speakAssistant(text) {
  if (!SpeechOutput || !text) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = navigator.language || "en-US";
    u.rate = 0.95;
    u.pitch = 1;
    window.speechSynthesis.speak(u);
  } catch {}
}

function setVoiceState(listening, status, hint) {
  const btn = $("#voiceMainMic");
  const label = $("#voiceMainLabel");
  const orb = $("#voiceOrb");
  if (btn) btn.classList.toggle("is-listening", listening);
  if (orb) orb.classList.toggle("is-listening", listening);
  if (label) label.textContent = listening ? "Stop listening" : "Start speaking";
  if ($("#voiceStatus")) $("#voiceStatus").textContent = status;
  if ($("#voiceHint") && hint) $("#voiceHint").textContent = hint;
}

function voiceSupportMessage() {
  if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    return "This phone/browser connection is not secure. Use HTTPS for microphone access over Wi‑Fi.";
  }
  if (!Speech) {
    return "Speech recognition is unavailable in this browser. Use Chrome/Edge or type your issue instead.";
  }
  return "Microphone ready. Your browser may ask for permission the first time.";
}

function startVoiceRecognition(sourceButton = null) {
  if (!Speech) {
    showFlow("voice");
    setVoiceState(false, "Voice input unavailable", voiceSupportMessage());
    toast("Voice recognition is not supported here. Use Chrome/Edge or type your issue.");
    return;
  }

  if (Recognizer.listening) {
    Recognizer.stop();
    return;
  }

  showFlow("voice");
  voiceText("");
  setVoiceState(true, "Listening…", "Tell me what is wrong. You can speak naturally.");

  const rec = new Speech();
  Recognizer.rec = rec;
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  let finalText = "";
  let finished = false;

  const finish = (text) => {
    if (finished) return;
    finished = true;
    Recognizer.listening = false;
    Recognizer.rec = null;
    if (sourceButton) sourceButton.classList.remove("rec");

    const clean = String(text || "").trim();
    setVoiceState(false, clean ? "I heard you" : "Ready to listen",
      clean ? "Checking your issue now…" : "Tap the microphone and try again.");

    if (clean) {
      voiceText(clean);
      speakAssistant(`I heard: ${clean}. I'll check that now.`);
      setTimeout(() => startDiagnose(clean, null), 350);
    }
  };

  rec.onstart = () => {
    Recognizer.listening = true;
    if (sourceButton) sourceButton.classList.add("rec");
    setVoiceState(true, "Listening…", "Speak now. I'm listening.");
  };

  rec.onresult = e => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript || "";
      if (e.results[i].isFinal) finalText += `${t} `;
      else interim += t;
    }
    voiceText((finalText + interim).trim());
    if ($("#voiceStatus")) $("#voiceStatus").textContent = interim ? "Listening…" : "Got it…";
  };

  rec.onerror = e => {
    const messages = {
      "not-allowed": "Microphone permission was denied. Allow microphone access for this site and try again.",
      "service-not-allowed": "Speech recognition is blocked by the browser. Allow microphone/speech access or use typing.",
      "audio-capture": "No microphone was found. Check the phone microphone and try again.",
      "network": "This browser's speech service needs a network connection. You can type instead.",
      "no-speech": "I didn't hear anything. Tap the microphone and speak again.",
      "aborted": "Voice input stopped."
    };
    setVoiceState(false, "Ready to listen", messages[e.error] || "Voice input stopped. Try again or type your issue.");
    toast(messages[e.error] || `Voice input stopped: ${e.error || "unknown error"}`);
  };

  rec.onend = () => finish(finalText);

  try {
    window.speechSynthesis?.cancel();
    rec.start();
  } catch {
    Recognizer.listening = false;
    Recognizer.rec = null;
    setVoiceState(false, "Ready to listen", "The microphone could not be started. Check permission and try again.");
    toast("Couldn't start the microphone. Check browser microphone permission.");
  }
}

function wireMic(btn) {
  if (!btn) return;
  btn.disabled = false;
  btn.title = Speech ? "Speak your issue" : voiceSupportMessage();
  btn.addEventListener("click", ev => {
    ev.preventDefault();
    ev.stopPropagation();
    startVoiceRecognition(btn);
  });
}

wireMic($("#homeMic"));
wireMic($("#voiceMainMic"));

$("#voiceTypeBtn")?.addEventListener("click", () => {
  stopVoiceIfNeeded();
  showTab("home");
  setTimeout(() => $("#homeSearch")?.focus(), 80);
});

$("#voiceSpeakBtn")?.addEventListener("click", () => {
  speakAssistant("Tap Start speaking and describe your problem in your own words. For example: my screen keeps flickering when I record a video.");
});

$$("[data-sample]").forEach(b => b.addEventListener("click", ev => {
  ev.preventDefault();
  ev.stopPropagation();
  const sample = b.dataset.sample || "";
  $("#homeSearch").value = sample;
  voiceText(sample);
  speakAssistant(`I heard: ${sample}. I'll check that now.`);
  setTimeout(() => startDiagnose(sample, null), 250);
}));

if ($("#voiceSupport")) $("#voiceSupport").textContent = voiceSupportMessage();

boot();
