const port = chrome.runtime.connect({ name: "sidepanel" });

const $ = (id) => document.getElementById(id);
const dot = $("dot");
const status = $("status");
const live = $("live");
const log = $("log");
const task = $("task");
const approval = $("approval");

const TERMINAL = ["done", "error", "cancelled"];
const EMPTY_HTML = log.innerHTML; // restored by "new chat" and on reset

let connected = false;
let running = false;
let watching = false;
let historyOpen = false;
let settingsOpen = false;
let menuOpen = false;
let currentConfig = null; // last "config" message from the broker
let awaitingSave = false; // true between clicking Save and its "config" echo
let viewedChatId = null;
let pendingApprovalId = null;
// Which chats (other than possibly this one) have an open approval gate —
// lights up the history icon and that chat's row, wherever it is.
let pendingApprovalChatIds = [];
let lastChats = []; // most recent "chats" response, re-rendered when the flags change
// Set right before an optimistic bubble is added for a task this panel just
// sent, so the broker's echoed "start" event for the same text isn't drawn
// twice.
let pendingEcho = null;

// ── icons ────────────────────────────────────────────────────────────────

const ICONS = {
  cursor: '<path d="M3 2l10 5.2-4.2 1-1 4.2L3 2z" fill="currentColor"/>',
  keyboard:
    '<rect x="2" y="4.5" width="12" height="7" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M4.3 7h.01M6.6 7h.01M8.9 7h.01M11.2 7h.01M4.3 9.3h6.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  list: '<path d="M3 4.5h10M3 8h10M3 11.5h6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>',
  scroll:
    '<path d="M8 2v12M5 4.5L8 2l3 2.5M5 11.5L8 14l3-2.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  link:
    '<path d="M6.5 3H13v6.5M13 3L7 9M4.5 5v7H11" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  arrowLeft:
    '<path d="M13 8H3M3 8l4.2-4.2M3 8l4.2 4.2" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  tabs:
    '<rect x="2" y="4.5" width="9.5" height="8" rx="1.4" stroke="currentColor" stroke-width="1.2" fill="none"/>' +
    '<path d="M4.8 4.5V3.2a1.2 1.2 0 011.2-1.2h6.3a1.2 1.2 0 011.2 1.2V10a1.2 1.2 0 01-1.2 1.2h-1.2" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  close:
    '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  eye:
    '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/>' +
    '<circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3" fill="none"/>',
  clock:
    '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3" fill="none"/>' +
    '<path d="M8 4.8V8l2.6 1.6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>',
  shield:
    '<path d="M8 1.8l5 2v3.7c0 3.6-2.3 5.9-5 6.7-2.7-.8-5-3.1-5-6.7V3.8l5-2z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/>',
  alert:
    '<path d="M8 2.3l6.3 11H1.7L8 2.3z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/>' +
    '<path d="M8 6.7v3M8 11.8h.01" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  check:
    '<circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-width="1.3" fill="none"/>' +
    '<path d="M5.2 8.2l1.9 1.9 3.7-4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  slash:
    '<circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-width="1.3" fill="none"/>' +
    '<path d="M4.5 4.5l7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  bot:
    '<rect x="2.5" y="4" width="11" height="7.5" rx="2" stroke="currentColor" stroke-width="1.3" fill="none"/>' +
    '<circle cx="6" cy="7.7" r=".9" fill="currentColor"/><circle cx="10" cy="7.7" r=".9" fill="currentColor"/>' +
    '<path d="M8 4V2.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  dot: '<circle cx="8" cy="8" r="2.2" fill="currentColor"/>',
};

// ICONS entries are bare <path>/<rect>/... markup, not full documents — an
// <svg> wrapper is required so the HTML parser builds real SVG-namespaced
// elements (innerHTML on a plain element without one silently produces inert
// HTMLUnknownElements instead, and nothing is drawn).
function iconSvg(name) {
  return `<svg viewBox="0 0 16 16">${ICONS[name] || ICONS.dot}</svg>`;
}

const STEP_ICON = {
  click: "cursor", hover: "cursor", key: "keyboard", select: "list", scroll: "scroll",
  type: "keyboard", paste: "keyboard",
  navigate: "link", back: "arrowLeft", "open-tab": "plus", "activate-tab": "tabs",
  "close-tab": "close", "follow-tab": "tabs",
  snapshot: "eye", screenshot: "eye", read: "eye", vision: "eye",
  wait: "clock",
  "awaiting-approval": "shield",
  "tool-error": "alert",
  remember: "list", recall: "eye",
  progress: "check", "task-check": "list", blocked: "shield",
  lookup: "eye", ask: "list", answered: "check",
  "auto-approved": "shield", "job-fit": "check",
  "check-in": "bot", supervisor: "shield",
};

const STEP_LABEL = {
  click: "Click", hover: "Hover", key: "Key", select: "Select", scroll: "Scroll",
  type: "Type", paste: "Paste",
  navigate: "Navigate", back: "Back", "open-tab": "Open tab", "activate-tab": "Switch tab",
  "close-tab": "Close tab", "follow-tab": "Follow tab",
  snapshot: "Look", screenshot: "Screenshot", read: "Read", vision: "Vision",
  wait: "Wait",
  "awaiting-approval": "Approval",
  "tool-error": "Tool error",
  remember: "Remember", recall: "Recall",
  progress: "Progress", "task-check": "Task check", blocked: "Blocked",
  lookup: "Lookup", ask: "Questions", answered: "Answers",
  "auto-approved": "Auto-approved", "job-fit": "Job check",
  "check-in": "Check-in", supervisor: "Supervisor",
};

// ── markdown (subset) ────────────────────────────────────────────────────
//
// "say"/"think" text comes straight from the model, and often from page
// content it read — so it is HTML-escaped first and only well-known safe
// tags are ever produced from it. No raw HTML from the model is ever passed
// through.

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function mdInline(escaped) {
  let s = escaped;
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  return s;
}

function renderMarkdown(raw) {
  const lines = raw.split(/\r?\n/);
  const out = [];
  let listType = null;
  let inCode = false;
  let codeLines = [];

  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (!inCode) { inCode = true; codeLines = []; closeList(); }
      else { out.push(`<pre><code>${codeLines.join("\n")}</code></pre>`); inCode = false; }
      continue;
    }
    if (inCode) { codeLines.push(escapeHtml(line)); continue; }

    if (line.trim() === "") { closeList(); continue; }

    const esc = escapeHtml(line);
    const heading = esc.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      out.push(`<div class="md-h md-h${heading[1].length}">${mdInline(heading[2])}</div>`);
      continue;
    }

    const ordered = esc.match(/^\d+\.\s+(.*)$/);
    const unordered = esc.match(/^[-*]\s+(.*)$/);
    if (ordered) {
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${mdInline(ordered[1])}</li>`);
      continue;
    }
    if (unordered) {
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${mdInline(unordered[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${mdInline(esc)}</p>`);
  }
  closeList();
  if (inCode) out.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
  return out.join("");
}

// ── transcript rendering ─────────────────────────────────────────────────

function hideEmpty() {
  const e = $("empty");
  if (e) e.remove();
}

function scrollToBottom() {
  log.scrollTop = log.scrollHeight;
}

function resetLog() {
  log.innerHTML = EMPTY_HTML;
}

function addBubble(side, text, { markdown = false } = {}) {
  hideEmpty();
  const row = document.createElement("div");
  row.className = `row ${side === "mine" ? "mine" : "theirs"}`;
  if (side !== "mine") {
    const av = document.createElement("div");
    av.className = "avatar";
    av.innerHTML = iconSvg("bot");
    row.appendChild(av);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (markdown) bubble.innerHTML = renderMarkdown(text);
  else bubble.textContent = text;
  row.appendChild(bubble);
  log.appendChild(row);
  scrollToBottom();
}

function addThink(text) {
  hideEmpty();
  const row = document.createElement("div");
  row.className = "row theirs think";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = renderMarkdown(text);
  row.appendChild(bubble);
  log.appendChild(row);
  scrollToBottom();
}

function addStep(kind, text) {
  hideEmpty();
  const row = document.createElement("div");
  const warn =
    kind === "awaiting-approval" || kind === "blocked" ||
    (kind === "supervisor" && (text || "").startsWith("off course"));
  const tone = kind === "tool-error" ? " err" : warn ? " warn" : "";
  row.className = `step${tone}`;
  const ic = document.createElement("span");
  ic.className = "ic";
  ic.innerHTML = iconSvg(STEP_ICON[kind] || "dot");
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = STEP_LABEL[kind] || kind.charAt(0).toUpperCase() + kind.slice(1);
  const txt = document.createElement("span");
  txt.className = "text";
  txt.textContent = text;
  row.append(ic, label, txt);
  log.appendChild(row);
  scrollToBottom();
}

function addStatusChip(tone, text) {
  hideEmpty();
  const chip = document.createElement("div");
  chip.className = `status-chip${tone === "ok" ? " ok" : tone === "err" ? " err" : ""}`;
  const ic = document.createElement("span");
  ic.style.display = "flex";
  ic.innerHTML = iconSvg(tone === "ok" ? "check" : tone === "err" ? "alert" : "slash");
  chip.appendChild(ic);
  chip.appendChild(document.createTextNode(text));
  log.appendChild(chip);
  scrollToBottom();
}

function renderEvent(kind, text) {
  if (kind === "task" || kind === "start") return addBubble("mine", text);
  if (kind === "say") return addBubble("theirs", text, { markdown: true });
  if (kind === "think") return addThink(text);
  if (kind === "done") return addStatusChip("ok", text || "Done");
  if (kind === "error") return addStatusChip("err", text || "Error");
  if (kind === "cancelled") return addStatusChip("muted", text || "Cancelled");
  addStep(kind, text);
}

// ── header / composer state ──────────────────────────────────────────────

function renderStatus() {
  dot.classList.toggle("busy", running);
  dot.classList.toggle("on", connected);
  status.textContent = running ? "running…" : connected ? "connected" : "broker offline";
}

function updateSendDisabled() {
  // While running, #send doubles as the cancel button, so it stays clickable
  // regardless of what's in the textarea.
  $("send").disabled = running ? false : !task.value.trim();
}

function setRunning(on) {
  running = on;
  const send = $("send");
  send.classList.toggle("running", on);
  send.title = on ? "Cancel run" : "Send";
  updateSendDisabled();
  renderStatus();
}

function autoResize() {
  task.style.height = "auto";
  task.style.height = Math.min(task.scrollHeight, 160) + "px";
}

function showApproval(pending) {
  if (!pending) {
    approval.style.display = "none";
    pendingApprovalId = null;
    return;
  }
  pendingApprovalId = pending.id;
  $("approval-text").textContent = pending.text;
  approval.style.display = "block";
}

// ── questions (ask_user) ─────────────────────────────────────────────────
//
// One question at a time: the agent's suggested options, then always a box
// for the user's own answer. Nothing goes back until the last question is
// done, so Back works right up to then.
let ask = null; // { id, intro, questions, index, picks: Set[], other: string[] }

function showAsk(pending) {
  const questions = pending?.ask?.questions ?? [];
  if (!pending || questions.length === 0) {
    $("ask").classList.remove("open");
    ask = null;
    return;
  }
  if (ask && ask.id === pending.id) return; // already on screen; keep the progress
  ask = {
    id: pending.id,
    intro: pending.ask.intro ?? "",
    questions,
    index: 0,
    picks: questions.map(() => new Set()),
    other: questions.map(() => ""),
  };
  $("ask").classList.add("open");
  renderAsk();
}

/** A question's answer as sent back: picked options, then anything typed; null when skipped. */
function answerFor(i) {
  const other = ask.other[i].trim();
  const parts = [...ask.picks[i], ...(other ? [other] : [])];
  return parts.length ? parts.join(", ") : null;
}

function renderAsk() {
  const q = ask.questions[ask.index];
  const options = q.options ?? [];
  const last = ask.index === ask.questions.length - 1;
  $("ask-count").textContent = `${ask.index + 1} of ${ask.questions.length}`;
  $("ask-intro").textContent = ask.intro;
  $("ask-progress-bar").style.width = `${(ask.index / ask.questions.length) * 100}%`;
  $("ask-question").textContent = q.question;
  $("ask-hint").textContent = options.length
    ? q.multiple ? "Pick any that apply, or add your own." : "Pick one, or type your own."
    : "";

  const box = $("ask-options");
  box.replaceChildren();
  box.setAttribute("role", q.multiple ? "group" : "radiogroup");
  for (const opt of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ask-opt";
    b.setAttribute("role", q.multiple ? "checkbox" : "radio");
    b.setAttribute("aria-checked", String(ask.picks[ask.index].has(opt)));
    const mark = document.createElement("span");
    mark.className = "ask-mark";
    const txt = document.createElement("span");
    txt.className = "ask-txt";
    txt.textContent = opt;
    b.append(mark, txt);
    b.addEventListener("click", () => pickOption(opt));
    box.appendChild(b);
  }

  const other = $("ask-other");
  other.value = ask.other[ask.index];
  other.placeholder = options.length ? "Something else…" : "Type your answer…";
  other.classList.toggle("filled", Boolean(other.value.trim()));
  $("ask-back").disabled = ask.index === 0;
  $("ask-next").textContent = last ? "Send answers" : "Next";
  $("ask-next").disabled = answerFor(ask.index) === null;
  if (!options.length) other.focus();
}

function pickOption(opt) {
  const q = ask.questions[ask.index];
  const picks = ask.picks[ask.index];
  if (q.multiple) {
    if (picks.has(opt)) picks.delete(opt);
    else picks.add(opt);
    renderAsk();
    return;
  }
  picks.clear();
  picks.add(opt);
  ask.other[ask.index] = ""; // a picked option replaces a typed answer
  renderAsk();
  // One tap answers a single-choice question. The last one waits for Send.
  const at = ask.index;
  if (at < ask.questions.length - 1) {
    setTimeout(() => {
      if (ask && ask.index === at) askAdvance();
    }, 180);
  }
}

function askAdvance() {
  if (!ask) return;
  if (ask.index < ask.questions.length - 1) {
    ask.index++;
    renderAsk();
    return;
  }
  port.postMessage({
    type: "answers",
    id: ask.id,
    answers: ask.questions.map((_, i) => answerFor(i)),
  });
  showAsk(null);
}

function setWatching(on) {
  watching = on;
  $("live-wrap").classList.toggle("on", on);
  $("watch").classList.toggle("active", on);
  $("watch").title = on ? "Stop live view" : "Live view";
}

// ── history panel ──────────────────────────────────────────────────────────

function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const min = Math.floor(Math.max(0, Date.now() - t) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function setPendingApprovalChatIds(ids) {
  pendingApprovalChatIds = ids ?? [];
  const alert = pendingApprovalChatIds.length > 0;
  $("history").classList.toggle("alert", alert);
  // The history entry lives inside a closed dropdown most of the time — echo
  // the alert onto the menu button itself so it stays visible either way.
  $("menu-btn").classList.toggle("alert", alert);
  if (historyOpen) renderChats(lastChats);
}

function setApprovalMode(mode) {
  $("approval-mode").value = mode;
}

function renderChats(chats) {
  const list = $("history-list");
  list.innerHTML = "";
  // A chat nobody has said anything in yet is not worth showing, even if it
  // happens to be the active one.
  const visible = (chats ?? []).filter((c) => c.taskCount > 0);
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.id = "history-empty";
    empty.textContent = "No saved chats yet.";
    list.appendChild(empty);
    return;
  }
  for (const chat of visible) {
    const viewing = chat.id === viewedChatId;
    const item = document.createElement("button");
    item.type = "button";
    item.className = `chat-item${viewing ? " active" : ""}`;

    const titleRow = document.createElement("div");
    titleRow.className = "chat-title-row";
    const title = document.createElement("div");
    title.className = "chat-title";
    title.textContent = chat.title || "(untitled)";
    titleRow.appendChild(title);
    if (pendingApprovalChatIds.includes(chat.id)) {
      const alertDot = document.createElement("span");
      alertDot.className = "chat-alert";
      titleRow.appendChild(alertDot);
    }

    const meta = document.createElement("div");
    meta.className = "chat-meta";
    meta.appendChild(document.createTextNode(timeAgo(chat.updatedAt)));
    meta.appendChild(
      document.createTextNode(` · ${chat.taskCount} turn${chat.taskCount === 1 ? "" : "s"}`),
    );
    // A chat can be running whether or not it is the one on screen — that is
    // the whole point of each chat having its own autonomous agent.
    if (chat.running) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "RUNNING";
      meta.appendChild(badge);
    }
    if (viewing) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.style.background = "var(--text-faint)";
      badge.textContent = "VIEWING";
      meta.appendChild(badge);
    }

    item.append(titleRow, meta);
    if (!viewing) {
      item.addEventListener("click", () => {
        port.postMessage({ type: "switch_chat", id: chat.id });
        closeHistory();
      });
    }
    list.appendChild(item);
  }
}

function openHistory() {
  historyOpen = true;
  closeSettings();
  $("history-page").classList.add("on");
  $("history").classList.add("active");
  const list = $("history-list");
  list.innerHTML = "";
  if (!connected) {
    list.innerHTML = '<div id="history-loading">Broker offline — can’t load chats.</div>';
    return;
  }
  list.innerHTML = '<div id="history-loading">Loading…</div>';
  port.postMessage({ type: "chats" });
}

function closeHistory() {
  historyOpen = false;
  $("history-page").classList.remove("on");
  $("history").classList.remove("active");
}

// ── settings panel ───────────────────────────────────────────────────────

const PROVIDERS = ["ollama", "openai", "openrouter"];

function providerBlocks(provider) {
  for (const p of PROVIDERS) $(`block-${p}`).classList.toggle("on", provider === p);
}

function setSettingsStatus(text, tone) {
  const el = $("settings-status");
  el.textContent = text || "";
  el.classList.toggle("err", tone === "err");
  el.classList.toggle("ok", tone === "ok");
}

function fillModelSelect(select, models, selected) {
  const have = new Set(models);
  // Keep whatever is currently configured selectable even if the live list
  // didn't include it (e.g. a typed key that hasn't been saved/refreshed yet).
  if (selected && !have.has(selected)) models = [selected, ...models];
  select.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    select.appendChild(opt);
  }
  if (selected) select.value = selected;
}

function applyConfig(cfg) {
  currentConfig = cfg;
  $("cfg-provider").value = cfg.provider;
  providerBlocks(cfg.provider);
  $("cfg-ollama-host").value = cfg.ollama.host;
  fillModelSelect($("cfg-ollama-model"), [], cfg.ollama.model);
  $("cfg-openai-key").value = cfg.openai.apiKey || "";
  fillModelSelect($("cfg-openai-model"), [], cfg.openai.model);
  // Absent from a broker older than the extension.
  const openrouter = cfg.openrouter ?? { model: "", apiKey: "" };
  $("cfg-openrouter-key").value = openrouter.apiKey || "";
  fillModelSelect($("cfg-openrouter-model"), [], openrouter.model);
  requestModels(cfg.provider);
}

function requestModels(provider) {
  // The select is populated when the "models" response arrives.
  $(`cfg-${provider}-refresh`).disabled = true;
  port.postMessage({ type: "list_models", provider });
}

function openSettings() {
  settingsOpen = true;
  closeHistory();
  $("settings-page").classList.add("on");
  $("settings").classList.add("active");
  setSettingsStatus("");
  if (!connected) {
    setSettingsStatus("Broker offline — can’t load settings.", "err");
    return;
  }
  port.postMessage({ type: "get_config" });
}

function closeSettings() {
  settingsOpen = false;
  $("settings-page").classList.remove("on");
  $("settings").classList.remove("active");
}

$("settings").addEventListener("click", () => {
  openSettings();
  closeMenu();
});
$("settings-close").addEventListener("click", closeSettings);

$("cfg-provider").addEventListener("change", () => {
  const provider = $("cfg-provider").value;
  providerBlocks(provider);
  requestModels(provider);
});

for (const p of PROVIDERS) {
  $(`cfg-${p}-refresh`).addEventListener("click", () => requestModels(p));
}

for (const p of ["openai", "openrouter"]) {
  $(`cfg-${p}-key-toggle`).addEventListener("click", () => {
    const input = $(`cfg-${p}-key`);
    const toggle = $(`cfg-${p}-key-toggle`);
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    toggle.title = showing ? "Show key" : "Hide key";
  });
}

$("settings-save").addEventListener("click", () => {
  const provider = $("cfg-provider").value;
  const patch = {
    provider,
    ollama: {
      host: $("cfg-ollama-host").value.trim() || "http://127.0.0.1:11434",
      model: $("cfg-ollama-model").value,
    },
    openai: {
      model: $("cfg-openai-model").value,
      apiKey: $("cfg-openai-key").value.trim(),
    },
    openrouter: {
      model: $("cfg-openrouter-model").value,
      apiKey: $("cfg-openrouter-key").value.trim(),
    },
  };
  setSettingsStatus("Saving…");
  awaitingSave = true;
  port.postMessage({ type: "set_config", patch });
});

// ── broker messages ──────────────────────────────────────────────────────

port.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "connection":
      connected = msg.connected;
      renderStatus();
      break;

    // Sent on connect and whenever the viewed chat changes. Unlike a popup, a
    // side panel usually stays open across tab switches — this still covers
    // the service worker being recycled out from under it.
    case "restore":
      connected = msg.connected;
      viewedChatId = msg.chatId ?? null;
      resetLog();
      for (const ev of msg.events ?? []) renderEvent(ev.event, ev.text ?? "");
      setRunning(Boolean(msg.running));
      showApproval(msg.approval);
      showAsk(msg.ask);
      setWatching(Boolean(msg.watching));
      setApprovalMode(msg.approvalMode ?? "submits");
      setPendingApprovalChatIds(msg.pendingApprovalChatIds ?? []);
      break;

    case "run_state":
      setRunning(Boolean(msg.running));
      if (!msg.running) {
        showApproval(null);
        showAsk(null);
      }
      break;

    case "approval_flags":
      setPendingApprovalChatIds(msg.chatIds ?? []);
      break;

    case "frame":
      live.src = `data:image/jpeg;base64,${msg.data}`;
      break;

    case "chats":
      lastChats = msg.chats ?? [];
      if (historyOpen) renderChats(lastChats);
      break;

    case "config":
      currentConfig = msg.config;
      if (settingsOpen) applyConfig(msg.config);
      if (awaitingSave) {
        awaitingSave = false;
        setSettingsStatus("Saved", "ok");
        setTimeout(() => { if ($("settings-status").textContent === "Saved") setSettingsStatus(""); }, 1500);
      }
      break;

    case "models": {
      if (!PROVIDERS.includes(msg.provider)) break;
      const select = $(`cfg-${msg.provider}-model`);
      $(`cfg-${msg.provider}-refresh`).disabled = false;
      if (msg.error) {
        setSettingsStatus(msg.error, "err");
        break;
      }
      fillModelSelect(select, msg.models ?? [], select.value);
      break;
    }

    case "agent_event":
      if (msg.event === "approval_request") {
        showApproval({ id: msg.id, text: msg.text });
        break;
      }
      if (msg.event === "ask_request") {
        showAsk({ id: msg.id, ask: msg.ask });
        break;
      }
      if (msg.event === "start") {
        setRunning(true);
        // Already shown optimistically when this panel sent the task.
        if (pendingEcho !== null && pendingEcho === (msg.text ?? "")) {
          pendingEcho = null;
          break;
        }
        renderEvent("start", msg.text ?? "");
        break;
      }
      renderEvent(msg.event, msg.text ?? "");
      if (TERMINAL.includes(msg.event)) {
        setRunning(false);
        showApproval(null);
        showAsk(null);
      }
      break;
  }
});

// ── composer ─────────────────────────────────────────────────────────────

function sendTask() {
  const text = task.value.trim();
  if (!text || running) return;
  // The log is not cleared: each task is a turn in one ongoing chat, and the
  // broker keeps the transcript. "New chat" is how you start over.
  pendingEcho = text;
  addBubble("mine", text);
  port.postMessage({ type: "task", text });
  task.value = "";
  autoResize();
  updateSendDisabled();
}

task.addEventListener("input", () => {
  autoResize();
  updateSendDisabled();
});

task.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendTask();
  }
});

log.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  task.value = chip.textContent;
  autoResize();
  updateSendDisabled();
  task.focus();
});

function cancelRun() {
  port.postMessage({ type: "cancel" });
  // Not setRunning(false) here: that flips this panel's own composer state
  // without touching the service worker's session.running, which would
  // still say the chat is running the next time this panel opens. The
  // broker now answers a cancel with a "cancelled" event almost immediately
  // (see agent.ts's abort-aware tool/approval waits), so waiting for the
  // real event keeps both in sync instead of just looking done.
  const btn = $("send");
  btn.disabled = true;
  btn.title = "Cancelling…";
}

// #send doubles as cancel while a run is in progress — same slot, same
// gesture, just a different icon and action underneath.
$("send").addEventListener("click", () => (running ? cancelRun() : sendTask()));

$("new-chat").addEventListener("click", () => {
  port.postMessage({ type: "reset" });
  resetLog();
  setRunning(false);
  showApproval(null);
  showAsk(null);
  closeHistory();
  closeSettings();
  closeMenu();
});

$("watch").addEventListener("click", () => {
  const next = !watching;
  setWatching(next);
  port.postMessage({ type: "control", action: next ? "watch" : "unwatch" });
});

$("history").addEventListener("click", () => {
  openHistory();
  closeMenu();
});
$("history-close").addEventListener("click", closeHistory);

// ── three-dot menu ───────────────────────────────────────────────────────

function openMenu() {
  menuOpen = true;
  $("menu-dropdown").classList.add("on");
  $("menu-btn").setAttribute("aria-expanded", "true");
}

function closeMenu() {
  menuOpen = false;
  $("menu-dropdown").classList.remove("on");
  $("menu-btn").setAttribute("aria-expanded", "false");
}

$("menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (menuOpen) closeMenu();
  else openMenu();
});

document.addEventListener("click", (e) => {
  if (menuOpen && !e.target.closest(".menu-wrap")) closeMenu();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menuOpen) closeMenu();
});

$("approval-mode").addEventListener("change", () => {
  port.postMessage({ type: "set_approval_mode", mode: $("approval-mode").value });
});

$("approve").addEventListener("click", () => {
  port.postMessage({ type: "approval", id: pendingApprovalId, approved: true });
  showApproval(null);
});

$("deny").addEventListener("click", () => {
  port.postMessage({ type: "approval", id: pendingApprovalId, approved: false });
  showApproval(null);
});

$("ask-other").addEventListener("input", (e) => {
  if (!ask) return;
  const value = e.target.value;
  ask.other[ask.index] = value;
  // On a single-choice question, typing your own answer replaces a pick.
  if (!ask.questions[ask.index].multiple && value.trim() && ask.picks[ask.index].size) {
    ask.picks[ask.index].clear();
    for (const b of $("ask-options").children) b.setAttribute("aria-checked", "false");
  }
  e.target.classList.toggle("filled", Boolean(value.trim()));
  $("ask-next").disabled = answerFor(ask.index) === null;
});

$("ask-other").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  e.preventDefault();
  if (ask && answerFor(ask.index) !== null) askAdvance();
});

$("ask-next").addEventListener("click", () => askAdvance());

$("ask-skip").addEventListener("click", () => {
  if (!ask) return;
  ask.picks[ask.index].clear();
  ask.other[ask.index] = "";
  askAdvance();
});

$("ask-back").addEventListener("click", () => {
  if (!ask || ask.index === 0) return;
  ask.index--;
  renderAsk();
});

$("ask-close").addEventListener("click", () => {
  if (!ask) return;
  port.postMessage({ type: "answers", id: ask.id, dismissed: true });
  showAsk(null);
});

renderStatus();
updateSendDisabled();
