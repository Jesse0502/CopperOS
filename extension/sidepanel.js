// The panel's line to the service worker. Chrome can recycle the worker (or
// update the extension) under an open panel, which disconnects a port for
// good — and a dead port silently swallowed Stop. So every message goes
// through `port`, which opens a fresh connection when the last one is gone,
// and the worker answers each new connection with the whole state ("restore").
const portListeners = [];
let livePort = null;

function openPort() {
  const p = chrome.runtime.connect({ name: "sidepanel" });
  p.onMessage.addListener((msg) => {
    for (const fn of portListeners) fn(msg);
  });
  p.onDisconnect.addListener(() => {
    if (livePort !== p) return;
    livePort = null;
    // Mid-run, reconnect at once so the log and Stop keep working. Idle, the
    // next message reconnects; reconnecting now would keep waking a worker
    // Chrome is trying to put to sleep.
    if (running) setTimeout(() => livePort ?? openPort(), 250);
  });
  livePort = p;
  return p;
}

const port = {
  postMessage(msg) {
    try {
      (livePort ?? openPort()).postMessage(msg);
    } catch {
      // Disconnected between the check and the send: once more on a new one.
      livePort = null;
      openPort().postMessage(msg);
    }
  },
  onMessage: { addListener: (fn) => portListeners.push(fn) },
};
openPort();
// The worker came back on its own (an alarm, the broker): rejoin it.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "worker_started" && !livePort) openPort();
});

const $ = (id) => document.getElementById(id);

// The panel opens on the mark and a moving line, and stays there until the
// service worker has said where things stand — for at least a moment, so it
// reads as a start and not a flash.
const bootedAt = Date.now();
function endBoot() {
  const boot = $("boot");
  if (!boot || boot.classList.contains("done")) return;
  setTimeout(() => boot.classList.add("done"), Math.max(0, 500 - (Date.now() - bootedAt)));
}
setTimeout(endBoot, 6000);
try {
  $("version").textContent = `CopperOS v${chrome.runtime.getManifest().version}`;
} catch {
  // No manifest to read (a page opened outside the extension): no version line.
}
const log = $("log");
const task = $("task");

const TERMINAL = ["done", "error", "cancelled"];
const EMPTY_HTML = log.innerHTML; // restored by "new chat" and on reset

let connected = false;
// Which broker, and who is signed in to it when it is the hosted one.
let backend = "local";
let account = null; // { email } or null
let running = false;
let watching = false;
let historyOpen = false;
let settingsOpen = false;
let memoriesOpen = false;
let lastMemories = null; // the last "memories" list from the broker, shown at once on reopening
let memoriesTimer = null; // a request the broker has not answered yet
let currentConfig = null; // last "config" message from the broker
let workflows = null; // the saved workflows, from the last "workflows" message, or null until asked
let libraryTab = "chats"; // which half of the Chats and workflows window is showing
let offer = null; // the popup asking whether to keep a repeating task as a workflow: { chatId, text }
let autoSave = null; // the popup's workflow, written up and saved without the editor: null, "drafting" or "saving"
let toastTimer = null;
let localBrokerUp = false; // a broker is answering on this computer (the sign-in screen offers it)
let editing = null; // the workflow editor, when open: { id (null for a new one), drafting }
let workflowsTimer = null; // a request the broker has not answered yet
let draftTimer = null;
let afterReset = null; // what to do once a fresh chat is ready: { then, from (the chat left), timer }
let moldDraft = false; // New mold was pressed: the next message is the person's idea for the mold
let usage = null; // last "usage" message from the hosted service: { usage, ownKey }
let platformModel = ""; // the model the hosted service runs on, from the last "config"
let ownKeyAllowed = false; // the plan allows it (Foundry): the service says, the switch obeys
let jevAvailable = true; // this user's runs have Jev, which the supervisor needs (a Foundry account only with its own key)
let localOffer = false; // a broker is running on this computer and the panel may offer to switch to it
let billing = null; // last "billing" message: the plan, what is for sale, and whether payments are on
let plansOpen = false;
let buying = null; // a payment page has been asked for and not yet opened: "portal", a plan id, or a price id
let buyingTimer = null;
let awaiting = null; // a payment page is open: what to watch for, { plan, credits, until }
let awaitingTimer = null;
let awaitingSave = false; // true between clicking Save and its "config" echo
let viewedChatId = null;
let pendingApprovalId = null;
// The open ask_user form: { id, intro, questions, index, picks: Set[], other: string[] }
let ask = null;
// Which chats (other than possibly this one) have an open approval gate —
// lights up the history icon and that chat's row, wherever it is.
let pendingApprovalChatIds = [];
let lastChats = []; // most recent "chats" response, re-rendered when the flags change
// The approval mode new chats start with ("Ask before" in Settings), or null
// to leave it to the broker.
let approvalDefault = null;
// Whether the viewed chat's tasks get supervisor check-ins.
let supervisor = false;
// The viewed chat's agent switch. Off, the extension refuses every browser
// action the chat's agent asks for, and no task can be sent to it.
// Stop was clicked and the broker has not said the run ended yet.
let stopTimer = null;
// Set right before an optimistic bubble is added for a task this panel just
// sent, so the broker's echoed "start" event for the same text isn't drawn
// twice.
let pendingEcho = null;

// ── icons ────────────────────────────────────────────────────────────────
//
// The design's icons are image masks (.i, in assets/icons/); the rest are
// small glyphs from the sprite at the top of sidepanel.html (.g).

const MASKS = new Set(["approval", "click", "look", "new", "hist", "send", "gear", "nav", "stop", "try", "type"]);

function icon(name) {
  return MASKS.has(name)
    ? `<i class="i i-${name}"></i>`
    : `<svg class="g"><use href="#g-${name}"/></svg>`;
}

/** A button or link that is waiting on something: a spinner in place of its icon, and no clicks. */
function setBusy(el, on) {
  if (on === el.classList.contains("busy")) return;
  el.classList.toggle("busy", on);
  el.setAttribute("aria-busy", String(on));
  if (on) {
    el.insertAdjacentHTML("afterbegin", '<span class="spinner" aria-hidden="true"></span>');
    el.dataset.wasDisabled = String(el.disabled);
    el.disabled = true;
  } else {
    el.querySelector(":scope > .spinner")?.remove();
    el.disabled = el.dataset.wasDisabled === "true";
  }
}

// ── steps ────────────────────────────────────────────────────────────────
//
// Each step the agent takes: its icon, its label, and a short description in
// place of the broker's own (which is written for the model's log). The
// original text stays in the row's tooltip.

const same = (t) => t;
const afterDash = (t) => (t.includes(" — ") ? t.slice(t.indexOf(" — ") + 3) : t);
const afterArrow = (t) => t.split(" ← ").slice(1).join(" ← ") || t;
const typed = (t) => {
  const m = t.match(/← ("[\s\S]*")( ⏎)?$/);
  return m ? `${m[1]}${m[2] ? " and Enter" : ""}` : t;
};
const pasted = (t) => {
  const text = t.split(" ⇐ ").slice(1).join(" ⇐ ") || t;
  return text.endsWith(" ⏎") ? `${text.slice(0, -2)} and Enter` : text;
};
const nothing = () => "";
const site = (t) => {
  try {
    const u = new URL(t);
    const path = u.pathname === "/" ? "" : u.pathname;
    return u.hostname.replace(/^www\./, "") + (path.length > 32 ? `${path.slice(0, 31)}…` : path);
  } catch {
    return t;
  }
};
const approvalLine = (t) => {
  const { verb, obj } = approvalParts(t.split(" · Jev")[0]);
  return verb ? `${verb.toLowerCase()} ${obj}` : obj;
};

const STEPS = {
  click: ["click", "Click", afterDash],
  hover: ["click", "Hover", nothing],
  select: ["click", "Select", afterArrow],
  type: ["type", "Type", typed],
  paste: ["type", "Paste", pasted],
  key: ["type", "Key", same],
  sheet: ["type", "Sheet", same],
  snapshot: ["look", "Look", () => "at the page"],
  screenshot: ["look", "Look", () => "at a screenshot"],
  vision: ["look", "Look", () => "closer"],
  read: ["look", "Read", (t) => (/^\d+ chars$/.test(t) ? "the page" : t)],
  recall: ["look", "Recall", same],
  lookup: ["look", "Lookup", same],
  navigate: ["nav", "Go to", site],
  back: ["nav", "Back", nothing],
  "open-tab": ["nav", "Open tab", site],
  "activate-tab": ["nav", "Switch tab", nothing],
  "follow-tab": ["nav", "Follow tab", site],
  "close-tab": ["nav", "Close tab", nothing],
  scroll: ["scroll", "Scroll", (t) => t.split(" ")[0]],
  wait: ["clock", "Wait", nothing],
  "awaiting-approval": ["approval", "Asked to", approvalLine],
  "auto-approved": ["approval", "Allowed", approvalLine],
  blocked: ["approval", "Blocked", same],
  supervisor: ["approval", "Supervisor", same],
  "tool-error": ["alert", "Error", same],
  remember: ["check", "Remember", same],
  progress: ["check", "Progress", same],
  "task-check": ["check", "Task check", same],
  loop: ["repeat", "Loop", same],
  skipped: ["slash", "Skipped", same],
  "job-fit": ["check", "Job check", same],
  answered: ["check", "Answers", same],
  ask: ["q", "Questions", same],
  "check-in": ["bolt", "Check-in", same],
};

// While a run is going, its card shows only the latest few steps.
const RECENT_STEPS = 5;

// ── markdown (subset) ────────────────────────────────────────────────────
//
// "say" text comes straight from the model, and often from page content it
// read — so it is HTML-escaped first and only well-known safe tags are ever
// produced from it. No raw HTML from the model is ever passed through.

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

// ── transcript ───────────────────────────────────────────────────────────
//
// A chat is the person's messages, the agent's replies, and one card per
// task run holding its steps. While a run is going its card stays last, with
// replies landing above it; when it ends it folds into a single line under
// the answer.

// The run on screen that has not ended, or null:
// { el, steps, startedAt (ms, or null when unknown), showAll }
let run = null;
let runTimer = null;
// A message just sent, before anyone knows what kind it is: three dots under
// it. Jev's "intent" settles it. Work gets a run card (steps, timer, Stop); a
// question or small talk gets words back and never a card. { el, startedAt }
let pending = null;

function hideEmpty() {
  $("empty")?.remove();
}

function scrollToBottom() {
  log.scrollTop = log.scrollHeight;
}

function resetLog() {
  log.innerHTML = EMPTY_HTML;
  run = null;
  pending = null;
  renderWorkflowChips();
}

/** Puts a message above the running card (or the dots), if there is one, so that stays last. */
function place(el) {
  hideEmpty();
  const last = run?.el ?? pending?.el;
  if (last) log.insertBefore(el, last);
  else log.appendChild(el);
  scrollToBottom();
}

/** A message was sent: show that it is being looked at, until its kind is known. */
function beginPending(startedAt) {
  if (run) finishRun(null, "");
  clearPending();
  hideEmpty();
  const el = document.createElement("div");
  el.className = "typing";
  el.setAttribute("aria-label", "Working on it");
  el.innerHTML = "<i></i><i></i><i></i>";
  log.appendChild(el);
  pending = { el, startedAt };
  scrollToBottom();
}

function clearPending() {
  pending?.el.remove();
  pending = null;
}

/** It is work: the dots become the run card, counting from when the message was sent. */
function showRun() {
  const startedAt = pending?.startedAt ?? null;
  clearPending();
  return startRun(startedAt);
}

function addMine(text) {
  const el = document.createElement("div");
  el.className = "mine";
  el.textContent = text;
  place(el);
}

function addTheirs(text) {
  const el = document.createElement("div");
  el.className = "theirs";
  el.innerHTML = renderMarkdown(text);
  place(el);
}

/** The rules a task was sent with for its supervisor, under the task. */
function addRules(text) {
  const el = document.createElement("div");
  el.className = "rules-line";
  el.title = `Supervisor rules: ${text}`;
  el.innerHTML = icon("look");
  const span = document.createElement("span");
  span.textContent = text;
  el.appendChild(span);
  place(el);
}

/** A line for something that happened outside any run (a broker-wide error). */
function addNote(tone, text) {
  const el = document.createElement("div");
  el.className = `note${tone === "err" ? " err" : ""}`;
  el.innerHTML = icon(tone === "err" ? "alert" : "slash");
  el.append(text);
  place(el);
}

function startRun(startedAt) {
  if (run) finishRun(null, "");
  hideEmpty();
  const el = document.createElement("div");
  el.className = "run";
  el.innerHTML =
    '<div class="run-h"><span class="t"></span><span class="meta"></span>' +
    `<button class="ib sm watch" type="button" title="Watch live" aria-label="Watch live">${icon("look")}</button>` +
    `<button class="btn sm stop" type="button">${icon("stop")}Stop</button></div>` +
    '<button class="sum" type="button" hidden></button>' +
    '<div class="run-b" hidden>' +
    '<div class="live" hidden><span class="badge">LIVE</span><img alt="Live view of the tab it is working in" /></div>' +
    '<div class="think" hidden></div>' +
    '<button class="more" type="button" hidden></button>' +
    '<div class="steps"></div></div>';
  el.querySelector(".stop").addEventListener("click", cancelRun);
  el.querySelector(".watch").addEventListener("click", toggleWatch);
  log.appendChild(el);
  const r = { el, steps: 0, startedAt, showAll: false };
  el.querySelector(".more").addEventListener("click", () => {
    r.showAll = true;
    renderSteps(r);
  });
  el.querySelector(".sum").addEventListener("click", () => el.classList.toggle("open"));
  run = r;
  renderRun();
  scrollToBottom();
  return r;
}

function addStep(kind, text) {
  if (!run) showRun();
  const [name, label, describe] = STEPS[kind] ?? ["dot", kind.charAt(0).toUpperCase() + kind.slice(1), same];
  const warn =
    kind === "awaiting-approval" || kind === "blocked" || kind === "skipped" ||
    (kind === "supervisor" && text.startsWith("off course"));
  const row = document.createElement("div");
  row.className = `s${kind === "tool-error" ? " err" : warn ? " warn" : ""}`;
  row.title = text;
  row.innerHTML = `<span class="ic">${icon(name)}</span>`;
  const x = document.createElement("div");
  x.className = "x";
  const l = document.createElement("span");
  l.className = "l";
  l.textContent = label;
  x.append(l, describe(text));
  row.appendChild(x);
  run.el.querySelector(".steps").appendChild(row);
  run.steps++;
  renderSteps(run);
  renderRun();
  scrollToBottom();
}

/** The model's latest reasoning, one faint line in the card. */
function setThink(text) {
  if (!run) return;
  const el = run.el.querySelector(".think");
  el.textContent = text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  el.hidden = !el.textContent;
  run.el.querySelector(".run-b").hidden = false;
}

function renderSteps(r) {
  const rows = [...r.el.querySelectorAll(".s")];
  const cut = r.showAll ? 0 : Math.max(0, rows.length - RECENT_STEPS);
  rows.forEach((row, i) => (row.hidden = i < cut));
  const more = r.el.querySelector(".more");
  more.hidden = cut === 0;
  more.textContent = `${cut} earlier step${cut === 1 ? "" : "s"}`;
  if (rows.length) r.el.querySelector(".run-b").hidden = false;
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The running card's header: its step, and how long it has been going. */
function renderRun() {
  if (!run) return;
  const waiting = Boolean(pendingApprovalId || ask);
  const n = run.steps;
  const t = run.el.querySelector(".t");
  const meta = run.el.querySelector(".meta");
  t.textContent = waiting ? "Paused" : n ? `Step ${n}` : "Starting";
  if (waiting) {
    meta.textContent = n ? `Step ${n}` : "";
    meta.title = "";
  } else {
    meta.textContent = run.startedAt !== null ? formatDuration(Date.now() - run.startedAt) : "";
    meta.title = run.startedAt !== null ? "Time since it started" : "";
  }
  run.el.classList.toggle("active", running && !waiting);
  // Waiting on the person, the card is just its header: the gate says the rest.
  run.el.classList.toggle("paused", waiting);
  const liveOn = watching && running;
  run.el.querySelector(".live").hidden = !liveOn;
  if (liveOn) run.el.querySelector(".run-b").hidden = false;
  const watch = run.el.querySelector(".watch");
  watch.classList.toggle("on", watching);
  watch.title = watching ? "Stop watching" : "Watch live";
  watch.setAttribute("aria-label", watch.title);
}

/**
 * Folds the running card into its one-line summary. `kind` is how it ended
 * ("done", "error", "cancelled"), or null when it just stopped being a run
 * (a transcript replayed without its steps, or a run that ended while the
 * panel was not looking).
 */
function finishRun(kind, text, at = null) {
  const r = run;
  if (!r) return;
  run = null;
  if (kind === null && r.steps === 0) {
    r.el.remove();
    return;
  }
  const took = r.startedAt !== null ? formatDuration((at ?? Date.now()) - r.startedAt) : null;
  const counted = Number(text.match(/^(\d+) steps?\b/)?.[1] ?? r.steps);
  const stepsText = counted ? `${counted} step${counted === 1 ? "" : "s"}` : null;
  let tone = "";
  let glyph = "check";
  let words;
  if (kind === "done") {
    tone = "ok";
    words = [stepsText ?? "Done", took];
  } else if (kind === "error") {
    tone = "err";
    glyph = "alert";
    words = [text || "Something went wrong"];
  } else if (kind === "cancelled") {
    glyph = "slash";
    // A cancel says nothing; a run that hit its time limit says what to do next.
    words = text ? [text] : ["Stopped", stepsText, took];
  } else {
    words = [stepsText];
  }
  const sum = r.el.querySelector(".sum");
  sum.className = `sum${tone ? ` ${tone}` : ""}`;
  sum.innerHTML = icon(glyph);
  sum.append(words.filter(Boolean).join(" · "));
  if (kind === "done" && text) sum.title = text;
  sum.disabled = r.steps === 0;
  if (r.steps) {
    sum.insertAdjacentHTML("beforeend", icon("chev").replace('class="g"', 'class="g chev"'));
    sum.setAttribute("aria-label", `${sum.textContent} — show steps`);
  }
  sum.hidden = false;
  r.showAll = true;
  renderSteps(r);
  r.el.querySelector(".think").hidden = true;
  r.el.querySelector(".live").hidden = true;
  r.el.classList.remove("active");
  r.el.classList.add("ended");
  // The card sat last while running; the folded line belongs there too.
  log.appendChild(r.el);
  scrollToBottom();
}

/** `live` is false for events replayed from the saved session, which carry their own times. */
function renderEvent(ev, live = false) {
  const kind = ev.event;
  const text = ev.text ?? "";
  const at = ev.at ?? (live ? Date.now() : null);
  if (kind === "task" || kind === "start") {
    addMine(text);
    beginPending(at);
    return;
  }
  // A mold the model wrote while helping the person make one.
  if (kind === "mold_proposal") {
    clearPending();
    showMoldProposal(text);
    return;
  }
  // The first task in a chat that repeats until stopped: ask whether to keep it.
  if (kind === "offer_workflow") {
    if (live) showWorkflowOffer(text, ev.chatId);
    return;
  }
  // Jev's verdict on the message. Work gets its card at once; an answer in
  // words never does. (Without Jev there is no verdict, and the first step
  // brings the card.)
  if (kind === "intent") {
    if (text === "task" && !run) showRun();
    return;
  }
  if (kind === "say") {
    clearPending();
    return addTheirs(text);
  }
  if (kind === "rules") return addRules(text);
  if (kind === "think") return setThink(text);
  if (TERMINAL.includes(kind)) {
    clearPending();
    if (run) finishRun(kind, text, at);
    else if (kind !== "done") addNote(kind === "error" ? "err" : "muted", text || (kind === "error" ? "Error" : "Stopped"));
    return;
  }
  addStep(kind, text);
}

// ── header / status ──────────────────────────────────────────────────────

function renderDot() {
  const dot = $("dot");
  const gated = Boolean(pendingApprovalId || ask);
  const state = signedOut() ? "idle" : !connected ? "off" : gated ? "wait" : running ? "busy" : "ok";
  dot.className = `dot${state === "off" ? "" : ` ${state}`}`;
  const says = {
    idle: "Not signed in",
    off: backend === "local" ? "Broker offline" : "Reconnecting…",
    wait: "Waiting for you",
    busy: "Running",
    ok: "Connected",
  }[state];
  dot.title = says;
  dot.setAttribute("aria-label", says);
}

/** The tab the viewed chat acts on, from the service worker. */
function setTab(tab) {
  const siteEl = $("site");
  const fav = $("fav");
  let label = "No tab";
  if (tab) {
    label = tab.title || "This tab";
    try {
      const u = new URL(tab.url);
      if (u.protocol === "http:" || u.protocol === "https:") label = u.hostname.replace(/^www\./, "");
      else if (u.href.startsWith("chrome://newtab")) label = "New tab";
    } catch {
      // No URL yet: keep the title.
    }
  }
  siteEl.textContent = label;
  siteEl.title = tab ? tab.title || tab.url : "";
  const src = tab?.favIconUrl ?? "";
  const usable = /^(https?:|data:image\/)/.test(src);
  if (usable && fav.getAttribute("src") !== src) fav.src = src;
  fav.hidden = !usable;
  $("fav-none").hidden = usable;
}
$("fav").addEventListener("error", () => {
  $("fav").hidden = true;
  $("fav-none").hidden = false;
});

/** Signed out of the cloud: the panel opens on the chat anyway, and asks for an account at the first message. */
const signedOut = () => backend === "cloud" && !account;

function renderStatus() {
  renderDot();
  $("offline-local").hidden = backend !== "local";
  $("offline-cloud").hidden = !(backend === "cloud" && account);
  // "Your chats are encrypted" is a thing about the cloud; chats on this computer are plain files.
  document.body.classList.toggle("cloud", backend === "cloud");
  renderOffline();
}

// The not-connected screen is held back briefly: every panel opens
// disconnected until the service worker reports in, and a broker restarting
// under `npm run dev` drops for a moment too. Neither should flash it.
const OFFLINE_DELAY_MS = 1500;
let offlineTimer = null;

function renderOffline() {
  // Signed out is not offline: there is nothing to connect to yet, and the chat is there to use.
  if (signedOut()) {
    clearTimeout(offlineTimer);
    offlineTimer = null;
    document.body.classList.remove("offline");
    return;
  }
  if (connected) {
    clearTimeout(offlineTimer);
    offlineTimer = null;
    document.body.classList.remove("offline");
  } else if (!offlineTimer && !document.body.classList.contains("offline")) {
    offlineTimer = setTimeout(() => {
      offlineTimer = null;
      if (!connected) document.body.classList.add("offline");
    }, OFFLINE_DELAY_MS);
  }
}

// ── composer ─────────────────────────────────────────────────────────────

function renderComposer() {
  const send = $("send");
  send.classList.toggle("running", running);
  send.title = running ? (stopTimer !== null ? "Stopping…" : "Stop") : "Send";
  send.setAttribute("aria-label", send.title);
  // While running, #send is the Stop button, so it stays clickable
  // regardless of what's in the textarea — unless a Stop is on its way.
  send.disabled = running ? stopTimer !== null : !task.value.trim();
  // The broker takes the next message once this task is over.
  task.disabled = running;
  renderRulesBox();
  task.placeholder = running
    ? "Working… you can stop it anytime"
    : moldDraft
      ? "e.g. Apply to remote design jobs on LinkedIn"
      : $("empty") ? "e.g. Find the cheapest paid tier" : "Ask a follow-up…";
}

/** New mold: the composer takes the person's own description of it, and the model asks about what is missing. */
function setMoldDraft(on) {
  moldDraft = on;
  $("mold-draft").hidden = !on;
  document.body.classList.toggle("mold-draft", on);
  renderComposer();
  if (on) task.focus();
}

function setRunning(on) {
  running = on;
  if (!on) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  // A panel opened mid-run has no message to tell what kind of run it is: a
  // card, unless it is one the dots already stand for.
  if (on && !run && !pending) startRun(null);
  if (!on) clearPending();
  if (!on && run) finishRun(null, "");
  clearInterval(runTimer);
  runTimer = on ? setInterval(renderRun, 1000) : null;
  renderRun();
  renderComposer();
  renderDot();
}

// The supervisor: on or off for the chat, a setting like the approval mode,
// and while it is on, rules for it that go with the next task only. It can be
// switched mid-task: the broker reads it at each check-in.
function setSupervisor(on) {
  supervisor = on;
  const btn = $("rules-btn");
  btn.classList.toggle("set", on && jevAvailable);
  btn.setAttribute("aria-pressed", String(on && jevAvailable));
  // The supervisor is Jev: without it (Foundry with no Jev key) there is nothing to switch on.
  btn.disabled = !jevAvailable;
  $("rules-btn-text").textContent = on && jevAvailable ? "Supervisor on" : "Supervisor";
  btn.title = !jevAvailable
    ? "The supervisor needs Jev. On Foundry, add your own Jev API key in Settings to turn it on."
    : on
      ? "The supervisor checks the agent's work every few steps and keeps it on track. Click to turn it off."
      : "Add a supervisor that checks the agent's work every few steps and keeps it on track";
  renderRulesBox();
}

function renderRulesBox() {
  $("rules-box").hidden = !supervisor || running || !jevAvailable;
}

function rulesText() {
  return supervisor && jevAvailable ? $("rules").value.trim() : "";
}

function resizeRules() {
  $("rules").style.height = "auto";
  $("rules").style.height = Math.min($("rules").scrollHeight, 120) + "px";
}

$("rules-btn").addEventListener("click", () => {
  setSupervisor(!supervisor);
  port.postMessage({ type: "set_supervisor", on: supervisor });
});
$("rules").addEventListener("input", resizeRules);
$("rules").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    task.focus();
  }
});

function autoResize() {
  task.style.height = "auto";
  task.style.height = Math.min(task.scrollHeight, 160) + "px";
}

const MODE_TEXT = { all: "Ask before every action", submits: "Ask before submits", none: "Never ask" };

function setApprovalMode(mode) {
  const known = mode in MODE_TEXT ? mode : "submits";
  $("approval-mode").value = known;
  $("perm-text").textContent = MODE_TEXT[known];
}

// ── approval ─────────────────────────────────────────────────────────────

/** The action waiting for approval, as a verb and what it acts on. */
function approvalParts(text) {
  let m = text.match(/^Click \S+ — ([\s\S]*)$/);
  if (m) return { verb: "Click", obj: m[1], sub: "" };
  m = text.match(/^Type into .+?( and submit)?: ("[\s\S]*")$/);
  if (m) return { verb: "Type", obj: m[2], sub: m[1] ? "Then submits it." : "" };
  return { verb: "", obj: text, sub: "" };
}

function renderGated() {
  document.body.classList.toggle("gated", Boolean(pendingApprovalId || ask));
  renderDot();
  renderRun();
}

function showApproval(pending) {
  pendingApprovalId = pending?.id ?? null;
  $("approval").hidden = !pending;
  if (pending) {
    const { verb, obj, sub } = approvalParts(pending.text ?? "");
    $("approval-verb").textContent = verb;
    $("approval-obj").textContent = obj;
    $("approval-sub").textContent = sub;
    $("approval-sub").hidden = !sub;
  }
  renderGated();
}

// ── questions (ask_user) ─────────────────────────────────────────────────
//
// One question at a time: the agent's suggested options, then always a box
// for the user's own answer. Nothing goes back until the last question is
// done, so Back works right up to then.
function showAsk(pending) {
  const questions = pending?.ask?.questions ?? [];
  if (!pending || questions.length === 0) {
    $("ask").hidden = true;
    ask = null;
    renderGated();
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
  $("ask").hidden = false;
  renderAsk();
  renderGated();
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
  $("ask-count").textContent = ask.questions.length > 1 ? `${ask.index + 1} of ${ask.questions.length}` : "";
  $("ask-intro").textContent = ask.index === 0 ? ask.intro : "";
  $("ask-question").textContent = q.question;

  const box = $("ask-options");
  box.replaceChildren();
  box.setAttribute("role", q.multiple ? "group" : "radiogroup");
  box.hidden = options.length === 0;
  for (const opt of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt";
    b.setAttribute("role", q.multiple ? "checkbox" : "radio");
    b.setAttribute("aria-checked", String(ask.picks[ask.index].has(opt)));
    const mark = document.createElement("span");
    mark.className = "rd";
    const txt = document.createElement("span");
    txt.className = "lbl";
    txt.textContent = opt;
    b.append(mark, txt);
    b.addEventListener("click", () => pickOption(opt));
    box.appendChild(b);
  }

  const other = $("ask-other");
  other.value = ask.other[ask.index];
  other.placeholder = options.length ? "Something else…" : "Type your answer…";
  other.classList.toggle("filled", Boolean(other.value.trim()));
  $("ask-back").hidden = ask.index === 0;
  $("ask-next").textContent = last ? (ask.questions.length > 1 ? "Send answers" : "Send") : "Next";
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

// ── live view ────────────────────────────────────────────────────────────

function setWatching(on) {
  watching = on;
  renderRun();
}

function toggleWatch() {
  const next = !watching;
  setWatching(next);
  port.postMessage({ type: "control", action: next ? "watch" : "unwatch" });
}

// ── past chats ───────────────────────────────────────────────────────────

function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const min = Math.floor(Math.max(0, Date.now() - t) / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const date = new Date(t);
  if (hr < 24 * 6) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function setPendingApprovalChatIds(ids) {
  pendingApprovalChatIds = ids ?? [];
  // Only chats other than this one: this one's gate is already on screen.
  $("history").classList.toggle("alert", pendingApprovalChatIds.some((id) => id !== viewedChatId));
  if (historyOpen) renderChats(lastChats);
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
    const waiting = pendingApprovalChatIds.includes(chat.id);
    const item = document.createElement("button");
    item.type = "button";
    item.className = `hitem${viewing ? " on" : ""}${chat.running && !waiting ? " running" : ""}`;

    const title = document.createElement("div");
    title.className = "t";
    if (waiting) {
      const dot = document.createElement("span");
      dot.className = "dot wait";
      title.appendChild(dot);
    }
    const name = document.createElement("span");
    name.textContent = chat.title || "(untitled)";
    title.appendChild(name);

    // A chat can be running whether or not it is the one on screen — that is
    // the whole point of each chat having its own autonomous agent.
    const meta = document.createElement("div");
    meta.className = "mt";
    const status = waiting
      ? "Waiting for you"
      : chat.running
        ? "Running"
        : viewing
          ? `${chat.taskCount} turn${chat.taskCount === 1 ? "" : "s"}`
          : "";
    meta.textContent = [status, timeAgo(chat.updatedAt)].filter(Boolean).join(" · ");

    item.append(title, meta);
    if (viewing) item.setAttribute("aria-current", "true");
    item.addEventListener("click", () => {
      if (!viewing) port.postMessage({ type: "switch_chat", id: chat.id });
      closeHistory();
    });
    list.appendChild(item);
  }
}

function openHistory(tab = "chats") {
  historyOpen = true;
  closeSettings();
  closeMemories();
  $("history-page").classList.add("on");
  showLibraryTab(tab);
}

function closeHistory() {
  historyOpen = false;
  $("history-page").classList.remove("on");
  $("history-refresh").hidden = true;
}

/** Past chats and saved workflows share one window; this is which of them shows. */
function showLibraryTab(tab) {
  libraryTab = tab;
  for (const b of document.querySelectorAll("#library-tabs [role=tab]")) {
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  }
  $("history-list").hidden = tab !== "chats";
  $("workflows-pane").hidden = tab !== "workflows";
  $("history-refresh").hidden = true;
  if (tab === "chats") loadChatsTab();
  else loadWorkflowsTab();
}

const workflowsShown = () => historyOpen && libraryTab === "workflows";

function loadChatsTab() {
  const list = $("history-list");
  const cached = lastChats.filter((c) => c.taskCount > 0).length > 0;
  // The last list shows at once; a fresh one replaces it when it comes.
  if (cached) renderChats(lastChats);
  if (!connected) {
    if (!cached) list.innerHTML = `<div id="history-loading">${signedOut() ? "Sign up and your chats are kept here, encrypted." : "Not connected — can’t load chats."}</div>`;
    return;
  }
  if (!cached) list.innerHTML = '<div id="history-loading"><span class="spinner"></span>Loading…</div>';
  $("history-refresh").hidden = !cached;
  port.postMessage({ type: "chats" });
}

for (const b of document.querySelectorAll("#library-tabs [role=tab]")) {
  b.addEventListener("click", () => showLibraryTab(b.dataset.tab));
}

// ── settings ─────────────────────────────────────────────────────────────

const PROVIDERS = ["ollama", "openai", "openrouter"];
// Someone setting up OpenRouter for the first time starts on this model.
const OPENROUTER_FIRST_MODEL = "deepseek/deepseek-v4.1-flash";
let askBeforeShown = null; // what "Ask before" said when Settings opened

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
  // didn't include it (e.g. a typed key that hasn't been saved yet).
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

/** Where CopperOS runs, and the account under it. */
function renderAccount() {
  for (const b of document.querySelectorAll(".seg [data-backend]")) {
    b.setAttribute("aria-checked", String(b.dataset.backend === backend));
  }
  // Cloud or this computer is a choice only for someone with a broker running on this computer (or
  // already on it): everyone else is in the cloud, and has nothing to choose.
  $("backend-seg").hidden = !(localBrokerUp || backend === "local");
  $("account-row").hidden = backend !== "cloud";
  $("local-row").hidden = backend !== "local";
  $("account-who").textContent = account ? account.email ?? "Signed in" : "Not signed in";
  $("account-btn").textContent = account ? "Sign out" : "Sign in";
  $("delete-account").hidden = !(backend === "cloud" && account);
  setBusy($("delete-account"), false);
  // Nobody's Ollama is reachable from the cloud.
  $("cfg-provider").querySelector('option[value="ollama"]').hidden = backend === "cloud";
}

/** Model settings come from the broker, so they are only there while connected. */
function renderSettingsAvailability() {
  const note = $("model-offline");
  note.hidden = connected;
  note.textContent =
    backend === "local"
      ? "Start the broker on this computer to choose a model."
      : account
        ? "Connecting to CopperOS…"
        : "Sign in to choose your model and API key.";
  renderOwnKey();
  renderPlan();
}

// Named for copper on its way from the ground to the mark on the logo.
const PLAN_NAMES = { ore: "Ore", ingot: "Ingot", facet: "Facet", foundry: "Foundry" };

/**
 * On the hosted service, a signed-in user runs on CopperOS's own model. On
 * Foundry the provider, key and model are theirs to set, and a saved key is
 * used as soon as it is there: there is no switch. On a broker of your own
 * they always are.
 */
function renderOwnKey() {
  const hosted = backend === "cloud" && Boolean(account) && connected;
  const model = platformModel ? platformModel.split("/").pop() : "its own model";
  const saved = Boolean(currentConfig?.[$("cfg-provider").value]?.hasKey);
  $("own-key-row").hidden = !hosted;
  $("own-key-plans").hidden = ownKeyAllowed;
  $("own-key-clear").hidden = !(ownKeyAllowed && saved);
  $("own-key-help").textContent = !ownKeyAllowed
    ? `CopperOS runs on ${model}. Your own model and API key come with the Foundry plan: you pay your provider for the model, and CopperOS only for hosting and storage.`
    : saved
      ? "Foundry: your tasks run on your own key and the model you choose. CopperOS puts no limit on your usage: your provider bills you for it."
      : `Foundry: add your OpenRouter or OpenAI key and choose any model. Until you do, CopperOS runs on ${model}, paid from your credits.`;
  $("model-settings").hidden = !connected || (backend === "cloud" && !ownKeyAllowed);
}

/** The service says whether this plan may use its own key; a plan that may not has the switch off. */
function setOwnKeyAllowed(allowed) {
  if (typeof allowed !== "boolean" || allowed === ownKeyAllowed) return;
  ownKeyAllowed = allowed;
  renderOwnKey();
  renderPlan();
}

/** Credits left. A service from before credits sent only dollars of model use: 100 credits a dollar paid, 55 cents of model use. */
function creditsLeft(u) {
  if (typeof u?.credits === "number") return u.credits;
  return Math.floor((u?.creditsUsd ?? 0) / 0.0055 + 1e-9);
}

/** 1500 → "1,500 credits". */
const creditText = (n) => `${n.toLocaleString()} credit${n === 1 ? "" : "s"}`;

/** 1234567 → "1.2M", 45600 → "46k": tokens, for the plan card. */
function tokenText(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

// How long a plan lets one task run, in words.
function spanText(minutes) {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** What the plan says about how long a task may run, and the week's running time where that is limited. */
function runtimeLine(u) {
  const r = u.runtime;
  if (!r) return "";
  const task = r.taskMinutes === null ? "No limit on how long one task runs." : `A task can run for up to ${spanText(r.taskMinutes)}.`;
  if (r.weeklyHours === null) return task;
  const left = Math.max(0, Math.round((r.weeklyHours - r.usedHours) * 10) / 10);
  return `${task} ${left} of ${r.weeklyHours} running hours left this week.`;
}

// A plan that has not arrived in a few seconds is not coming: say so, rather than loading for ever.
const PLAN_WAIT_MS = 8000;
let planFailed = false;
let planTimer = null;

/**
 * The Settings plan card. It is always there, and says what is true: what
 * this week looks like on the cloud, that there is nothing to pay on this
 * computer, that there is no account yet, or that the plan is on its way (or
 * is not coming, with a way to ask again).
 */
function renderPlan() {
  const card = $("plan-card");
  const set = (name, line, { meter = false, resets = false, plans = false, signin = false, retry = false, runtime = "" } = {}) => {
    $("plan-name").textContent = name;
    $("plan-line").textContent = line;
    $("plan-meter").hidden = !meter;
    $("plan-resets").hidden = !resets;
    $("plans-open").hidden = !plans;
    $("plan-signin").hidden = !signin;
    $("plan-retry").hidden = !retry;
    $("plan-runtime").hidden = !runtime;
    $("plan-runtime").textContent = runtime;
  };
  card.classList.remove("low", "out");
  if (backend === "local") {
    set("This computer", "Set your own APIs and run it locally.");
    return;
  }
  if (!account) {
    set("Not signed in", "Sign up to start. A free trial comes with it, and your plan shows here.", { signin: true });
    return;
  }
  if (!usage) {
    set(
      "Your plan",
      planFailed
        ? "Couldn't load your plan. Check your connection and try again."
        : connected
          ? "Loading your plan…"
          : "Connecting to CopperOS…",
      { retry: planFailed },
    );
    return;
  }
  const { usage: u, ownKey } = usage;
  const runtime = runtimeLine(u);
  const credits = creditsLeft(u);
  const foundry = u.plan === "foundry";
  if (ownKey) {
    set(foundry ? "Foundry · your own API key" : "Your own API key", "Your usage is billed by your provider, with no limit from CopperOS.", { plans: true, runtime });
    return;
  }
  // Foundry has no allowance of CopperOS's model: only credits pay for it.
  if (foundry) {
    set(
      "Foundry",
      credits > 0
        ? `Using CopperOS's model on your credits: ${creditText(credits)} left. Add your own API key below to use your own model.`
        : "Foundry runs on your own API key. Add yours below, or buy credits to use CopperOS's model.",
      { plans: true, runtime },
    );
    return;
  }
  // The trial's allowance is a week; a paid plan's is its billing month.
  const period = u.period === "month" ? "month" : "week";
  const used = u.allowanceUsd > 0 ? Math.min(100, Math.round((u.spentUsd / u.allowanceUsd) * 100)) : 100;
  const left = typeof u.leftPct === "number" ? u.leftPct : 100 - used;
  const pct = 100 - left; // how full the bar is
  const out = u.leftUsd <= 0 && credits <= 0;
  const t = u.tokens ? u.tokens.input + u.tokens.output : 0;
  const tokens = t ? ` · ${tokenText(t)} tokens used` : "";
  const when = (ms) =>
    new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  set(
    // Ore is the trial, and says so: nobody should have to know what ore is.
    u.plan === "ore" ? "Ore · trial" : (PLAN_NAMES[u.plan] ?? "Plan"),
    u.poolFull
      ? out
        ? "The trial usage is used up this month, for everyone. Choose a plan or buy credits to keep going now, or wait for it to return."
        : `The trial usage is used up this month, for everyone. Using your credits: ${creditText(credits)} left.`
      : out
        ? period === "month"
          ? `You've used this month's usage${tokens}. Buy credits to keep going, or wait for your plan to renew.`
          : `You've used this week's usage${tokens}. Choose a plan or buy credits to keep going, or wait for the reset.`
        : u.leftUsd <= 0
          ? `This ${period}'s usage is spent${tokens}. Using your credits: ${creditText(credits)} left.`
          : `${left}% of this ${period}'s usage left${tokens}.` + (credits > 0 ? ` ${creditText(credits)}.` : ""),
    { meter: true, resets: true, plans: true, runtime },
  );
  // With the free pool spent, the wait is for the month to turn, not the week.
  $("plan-resets").textContent = `${period === "month" && !u.poolFull ? "Renews" : "Resets"} ${when(u.poolFull ? u.poolResetsAt : u.resetsAt)}`;
  $("plan-fill").style.width = `${u.poolFull ? 100 : pct}%`;
  $("plan-meter").setAttribute("aria-valuenow", String(u.poolFull ? 100 : pct));
  $("plan-meter").setAttribute("aria-label", `This ${period}'s usage`);
  card.classList.toggle("out", out);
  card.classList.toggle("low", !out && !u.poolFull && pct >= 80);
}

/** Ask the hosted service where this week's usage stands. */
function requestUsage() {
  if (!(backend === "cloud" && account && connected)) return;
  port.postMessage({ type: "get_usage" });
  if (!usage && !planTimer) {
    planTimer = setTimeout(() => {
      planTimer = null;
      if (usage) return;
      planFailed = true;
      renderPlan();
    }, PLAN_WAIT_MS);
  }
}

function plansArrived() {
  clearTimeout(planTimer);
  planTimer = null;
  planFailed = false;
}

$("plan-retry").addEventListener("click", () => {
  planFailed = false;
  renderPlan();
  requestUsage();
});

// ── plans and credits ────────────────────────────────────────────────────────

// The plans are asked for, and if they do not come in a few seconds the page says so and offers to ask
// again, rather than saying "Loading" for ever (a service that has not been updated never answers).
let billingTimer = null;

function requestBilling() {
  if (!(backend === "cloud" && account && connected)) return;
  port.postMessage({ type: "get_billing" });
  if (!billing && !billingTimer) {
    billingTimer = setTimeout(() => {
      billingTimer = null;
      if (billing) return;
      billing = { enabled: false, failed: true, error: "Plans and credits couldn't be loaded. Check your connection and try again." };
      renderPlans();
    }, PLAN_WAIT_MS);
  }
}

function billingArrived() {
  clearTimeout(billingTimer);
  billingTimer = null;
}

$("plans-retry").addEventListener("click", () => {
  billing = null;
  renderPlans();
  requestBilling();
});

/** An amount in a currency's smallest unit, as that currency: 1000 → $10. */
function money(amount, currency) {
  const cents = amount % 100 !== 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: String(currency || "usd").toUpperCase(),
      minimumFractionDigits: cents ? 2 : 0,
      maximumFractionDigits: 2,
    }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(cents ? 2 : 0)} ${currency}`;
  }
}

function plansStatus(text, tone) {
  const el = $("plans-status");
  el.textContent = text || "";
  el.classList.toggle("err", tone === "err");
  el.classList.toggle("ok", tone === "ok");
}

function openPlans() {
  plansOpen = true;
  $("plans-page").classList.add("on");
  plansStatus("");
  renderPlans();
  requestBilling();
  requestUsage();
}

function closePlans() {
  plansOpen = false;
  $("plans-page").classList.remove("on");
}

function renderPlans() {
  const b = billing;
  const on = Boolean(b && b.enabled);
  $("plans-loading").hidden = Boolean(b);
  $("plans-loading").textContent = connected ? "Loading plans…" : "Connecting to CopperOS…";
  $("plans-off").hidden = !(b && !b.enabled);
  if (b && !b.enabled) $("plans-off").textContent = b.error || "Plans and credits are not available yet.";
  // A load that failed can be tried again; a service with nothing for sale cannot do better.
  $("plans-retry").hidden = !(b && b.failed);
  $("plans-now").hidden = !on;
  $("plans-credits").hidden = !(on && b.packs.length);
  const list = $("plans-list");
  const packs = $("packs");
  list.textContent = "";
  packs.textContent = "";
  if (!on) return;

  const ends = b.endsAt ? new Date(b.endsAt).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : null;
  $("plans-now-name").textContent = b.plan === "ore" ? "Ore · trial" : b.planName;
  $("plans-now-tag").textContent = "Your plan";
  $("plans-now-line").textContent =
    b.plan === "ore"
      ? "Free trial. Choose a plan for more, or buy credits."
      : ends
        ? `Ends on ${ends}, and you'll be back on Ore after that.`
        : "Renews every month. Change or cancel any time from Manage billing.";
  // Anyone who has bought anything has a billing page: invoices, card, cancel.
  $("plans-manage").hidden = !b.hasCustomer;
  $("plans-manage").disabled = buying !== null;

  for (const p of b.plans) {
    const here = p.id === b.plan;
    const card = document.createElement("div");
    card.className = "plan-opt" + (here ? " current" : "");
    const top = document.createElement("div");
    top.className = "plan-opt-top";
    const name = document.createElement("span");
    name.className = "plan-opt-name";
    name.textContent = p.name;
    const price = document.createElement("span");
    price.className = "plan-opt-price";
    price.textContent = money(p.amount, p.currency);
    const per = document.createElement("small");
    per.textContent = " /month";
    price.appendChild(per);
    top.append(name, price);
    const blurb = document.createElement("div");
    blurb.className = "plan-opt-blurb";
    blurb.textContent = p.blurb;
    card.append(top, blurb);
    if (here) {
      const tag = document.createElement("span");
      tag.className = "plan-opt-here";
      tag.textContent = "Your plan";
      card.appendChild(tag);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn sm pr";
      btn.textContent = b.plan === "ore" ? "Choose" : "Switch to " + p.name;
      btn.disabled = buying !== null;
      btn.addEventListener("click", () => buy({ type: "billing_checkout", plan: p.id }, p.id));
      card.appendChild(btn);
    }
    list.appendChild(card);
  }

  for (const k of b.packs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pack";
    btn.disabled = buying !== null;
    const price = document.createElement("span");
    price.className = "pack-price";
    price.textContent = money(k.amount, k.currency);
    const gets = document.createElement("span");
    gets.className = "pack-gets";
    // What it buys, in credits: never the dollars of model use behind them.
    gets.textContent = creditText(typeof k.credits === "number" ? k.credits : creditsLeft({ creditsUsd: k.creditsUsd }));
    btn.append(price, gets);
    btn.addEventListener("click", () => buy({ type: "billing_checkout", priceId: k.priceId }, k.priceId));
    packs.appendChild(btn);
  }
}

/** Ask for a payment page. The service opens it in a new tab, if it is Stripe's. */
function buy(message, what) {
  if (buying !== null || !connected) return;
  buying = what;
  plansStatus("Opening Stripe…");
  renderPlans();
  port.postMessage(message);
  // A service that never answers must not leave the buttons dead.
  buyingTimer = setTimeout(() => {
    if (buying === null) return;
    stopBuying();
    renderPlans();
    plansStatus("No answer. Try again in a moment.", "err");
  }, 20_000);
}

function stopBuying() {
  buying = null;
  clearTimeout(buyingTimer);
}

/** A payment page is open: look for the plan or the credits to change, for a few minutes. */
function watchPurchase() {
  awaiting = { plan: billing?.plan ?? "ore", credits: creditsLeft(usage?.usage), until: Date.now() + 5 * 60_000 };
  clearInterval(awaitingTimer);
  awaitingTimer = setInterval(() => {
    if (!awaiting || Date.now() > awaiting.until) return stopWatching();
    requestBilling();
    requestUsage();
  }, 3000);
}

function stopWatching() {
  awaiting = null;
  clearInterval(awaitingTimer);
}

function checkPurchase() {
  if (!awaiting) return;
  if (billing?.enabled && billing.plan !== awaiting.plan) {
    plansStatus(`You're on ${billing.planName}.`, "ok");
    stopWatching();
  } else if (usage && creditsLeft(usage.usage) > awaiting.credits) {
    plansStatus(`Credits added. You have ${creditText(creditsLeft(usage.usage))}.`, "ok");
    stopWatching();
  }
}

$("plans-open").addEventListener("click", openPlans);
$("own-key-plans").addEventListener("click", openPlans);
$("plans-close").addEventListener("click", closePlans);
$("plans-manage").addEventListener("click", () => buy({ type: "billing_portal" }, "portal"));
// Coming back from the payment page: look again straight away.
window.addEventListener("focus", () => {
  if (!(plansOpen || settingsOpen)) return;
  requestBilling();
  requestUsage();
});

/** Jev's key: the user's own, optional. What it is for depends on where CopperOS runs. */
function renderJev(cfg) {
  const jev = cfg?.jev ?? { apiKey: "" };
  $("cfg-jev-key").value = jev.apiKey || "";
  $("cfg-jev-key").placeholder = jev.hasKey ? "Saved — leave blank to keep it" : "From typesafe.ai";
  $("jev-clear").hidden = !jev.hasKey;
  $("jev-help").textContent =
    backend === "cloud"
      ? "Optional. Turns on the supervisor and Jev's safety checks for your tasks. On Foundry, CopperOS's own Jev is not used, so without a key your tasks run without them."
      : "Optional. Turns on the supervisor and Jev's safety checks. Without one, the broker's own key (JEV_AI_API_KEY in its .env) is used, if it has one.";
}

$("jev-clear").addEventListener("click", () => {
  if (!connected) return;
  $("cfg-jev-key").value = "";
  setSettingsStatus("");
  setBusy($("settings-save"), true);
  awaitingSave = true;
  port.postMessage({ type: "set_config", patch: { jev: { apiKey: "", clear: true } } });
});

function applyConfig(cfg, model, allowed) {
  currentConfig = cfg;
  if (model) platformModel = model;
  if (typeof allowed === "boolean") ownKeyAllowed = allowed;
  $("cfg-provider").value = cfg.provider;
  renderOwnKey();
  providerBlocks(cfg.provider);
  $("cfg-ollama-host").value = cfg.ollama.host;
  fillModelSelect($("cfg-ollama-model"), [], cfg.ollama.model);
  $("cfg-openai-key").value = cfg.openai.apiKey || "";
  // The hosted broker never sends a key back, only whether one is saved.
  $("cfg-openai-key").placeholder = cfg.openai.hasKey ? "Saved — leave blank to keep it" : "sk-…";
  fillModelSelect($("cfg-openai-model"), [], cfg.openai.model);
  // Absent from a broker older than the extension.
  const openrouter = cfg.openrouter ?? { model: "", apiKey: "" };
  $("cfg-openrouter-key").value = openrouter.apiKey || "";
  $("cfg-openrouter-key").placeholder = openrouter.hasKey ? "Saved — leave blank to keep it" : "sk-or-…";
  renderJev(cfg);
  const openrouterSetUp = Boolean(openrouter.hasKey || openrouter.apiKey);
  fillModelSelect($("cfg-openrouter-model"), [], openrouterSetUp ? openrouter.model : OPENROUTER_FIRST_MODEL);
  requestModels(cfg.provider);
}

function requestModels(provider) {
  // The select is filled when the "models" response arrives.
  $(`cfg-${provider}-loading`).hidden = false;
  port.postMessage({ type: "list_models", provider });
}

function openSettings() {
  settingsOpen = true;
  awaitingSave = false;
  setBusy($("settings-save"), false);
  closeHistory();
  closeMemories();
  $("settings-page").classList.add("on");
  setSettingsStatus("");
  askBeforeShown = approvalDefault ?? "submits";
  $("cfg-ask-before").value = askBeforeShown;
  renderAccount();
  renderSettingsAvailability();
  if (connected) port.postMessage({ type: "get_config" });
  requestUsage();
  // Also catches up with a payment whose webhook was missed: the service checks Stripe when billing is asked for.
  requestBilling();
}

function closeSettings() {
  settingsOpen = false;
  closePlans();
  $("settings-page").classList.remove("on");
}

$("settings").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", closeSettings);

for (const b of document.querySelectorAll(".seg [data-backend]")) {
  b.addEventListener("click", () => {
    if (b.dataset.backend !== backend) port.postMessage({ type: "set_backend", backend: b.dataset.backend });
  });
}
$("account-btn").addEventListener("click", () => {
  if (!account) {
    signIn();
    return;
  }
  setBusy($("account-btn"), true);
  port.postMessage({ type: "sign_out" });
});
$("delete-account").addEventListener("click", () => {
  const sure = confirm(
    "Delete your CopperOS account?\n\nThis permanently deletes your chats, memories, settings " +
    "(including your saved API keys), plan and any credits, and signs you out. It cannot be undone.",
  );
  if (!sure) return;
  if (!connected) {
    setSettingsStatus("Connect to CopperOS first, then try again.", "err");
    return;
  }
  setBusy($("delete-account"), true);
  setSettingsStatus("Deleting your account…");
  port.postMessage({ type: "delete_account" });
});

// Foundry: back to CopperOS's model (on credits) by taking the key away.
$("own-key-clear").addEventListener("click", () => {
  const provider = $("cfg-provider").value;
  if (!connected || (provider !== "openai" && provider !== "openrouter")) return;
  $(`cfg-${provider}-key`).value = "";
  setSettingsStatus("");
  setBusy($("settings-save"), true);
  awaitingSave = true;
  port.postMessage({ type: "set_config", patch: { [provider]: { apiKey: "", clear: true } } });
});

$("cfg-provider").addEventListener("change", () => {
  const provider = $("cfg-provider").value;
  providerBlocks(provider);
  requestModels(provider);
  renderOwnKey();
});

// A list that failed to load (no key yet, Ollama not running) tries again
// when it is opened.
for (const p of PROVIDERS) {
  $(`cfg-${p}-model`).addEventListener("focus", () => {
    if ($(`cfg-${p}-model`).options.length <= 1) requestModels(p);
  });
}

for (const p of ["openai", "openrouter", "jev"]) {
  $(`cfg-${p}-key-toggle`).addEventListener("click", () => {
    const input = $(`cfg-${p}-key`);
    const toggle = $(`cfg-${p}-key-toggle`);
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    toggle.title = showing ? "Show key" : "Hide key";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.classList.toggle("on", !showing);
  });
}

$("settings-save").addEventListener("click", () => {
  const askBefore = $("cfg-ask-before").value;
  if (askBefore !== askBeforeShown) {
    approvalDefault = askBefore;
    askBeforeShown = askBefore;
    port.postMessage({ type: "set_approval_default", mode: askBefore });
  }
  if (!connected) {
    setSettingsStatus("Saved", "ok");
    return;
  }
  // Off Foundry, the cloud runs on CopperOS's own model: no provider, key or model to save.
  if (backend === "cloud" && !ownKeyAllowed) {
    setSettingsStatus("Saved", "ok");
    return;
  }
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
    // Blank keeps the one saved; Remove clears it.
    jev: { apiKey: $("cfg-jev-key").value.trim() },
  };
  setSettingsStatus("");
  setBusy($("settings-save"), true);
  awaitingSave = true;
  port.postMessage({ type: "set_config", patch });
  // A broker that errors instead of answering must not leave it spinning.
  setTimeout(() => {
    if (!awaitingSave) return;
    awaitingSave = false;
    setBusy($("settings-save"), false);
    setSettingsStatus("No answer from the broker — try again.", "err");
  }, 15_000);
});

// ── signing up ───────────────────────────────────────────────────────────

// Signing in opens Chrome's sign-in window and waits for it; every Sign in
// button spins until it is done one way or the other.
let signingIn = false;
// What was being sent when the popup came up: the words, or undefined for "what is in the box".
// Sent on its own once there is an account to run it on (or a broker on this computer).
let signupDraft = null;

function signIn() {
  $("signup-note").textContent = "";
  setSigningIn(true);
  port.postMessage({ type: "sign_in" });
}

function setSigningIn(on) {
  signingIn = on;
  setBusy($("signup-btn"), on);
  setBusy($("account-btn"), on);
  setBusy($("plan-signin"), on);
}

function openSignup(text) {
  signupDraft = { text };
  $("signup-note").textContent = "";
  $("signup").hidden = false;
  $("signup-btn").focus();
}

function closeSignup() {
  $("signup").hidden = true;
}

/** An account (or a broker on this computer) has turned up: send what was waiting. */
function sendWhatWaited() {
  if (!signupDraft || signedOut()) return;
  if (!connected) return; // once the connection is up, this is asked again
  const { text } = signupDraft;
  signupDraft = null;
  closeSignup();
  sendTask(text);
}

$("signup-btn").addEventListener("click", signIn);
$("signup-cancel").addEventListener("click", () => {
  // The words stay in the box: nothing was lost by asking.
  signupDraft = null;
  closeSignup();
  renderLocalOffer();
});
$("signup").addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("signup-cancel").click();
});
$("plan-signin").addEventListener("click", signIn);
// Looking again for a broker on this computer every few seconds while on the cloud, signed in or
// not: one that starts is offered at once (the popup below), and Settings shows This computer.
setInterval(() => {
  if (backend === "cloud") port.postMessage({ type: "probe_local" });
}, 5000);

/** The offer to switch to a broker running on this computer: up while the service worker says so, and nothing else is in the way. */
function renderLocalOffer() {
  const show = localOffer && backend === "cloud" && $("signup").hidden;
  $("local-pop").hidden = !show;
}

$("local-pop-yes").addEventListener("click", () => {
  localOffer = false;
  renderLocalOffer();
  port.postMessage({ type: "use_local" });
});
$("local-pop-no").addEventListener("click", () => {
  localOffer = false;
  renderLocalOffer();
  port.postMessage({ type: "dismiss_local" });
});
$("offline-use-cloud").addEventListener("click", () => {
  port.postMessage({ type: "set_backend", backend: "cloud" });
});
$("copy-cmd").addEventListener("click", async () => {
  const btn = $("copy-cmd");
  try {
    await navigator.clipboard.writeText($("broker-cmd").textContent);
  } catch {
    return;
  }
  btn.innerHTML = icon("check");
  btn.title = "Copied";
  setTimeout(() => {
    btn.innerHTML = icon("copy");
    btn.title = "Copy";
  }, 1500);
});

// ── saved memories ───────────────────────────────────────────────────────

// Topic paths the model picks ("user/job-search") as headings people read.
const TOPIC_NAMES = { notes: "Added by you", answers: "Your answers to questions" };

function topicName(topic) {
  const rest = topic.replace(/^user\//, "").split("/").map((p) => p.replace(/-/g, " ")).join(" · ");
  return TOPIC_NAMES[rest] ?? rest.charAt(0).toUpperCase() + rest.slice(1);
}

// A broker from before the Memories page never answers: say so rather than spin.
const MEMORIES_TIMEOUT_MS = 10_000;

function askMemories(msg) {
  port.postMessage(msg);
  clearTimeout(memoriesTimer);
  memoriesTimer = setTimeout(() => {
    memoriesResult({
      error:
        backend === "local"
          ? "No answer from the broker on this computer. It may need updating: git pull in browsercontrol, then restart it."
          : "No answer from CopperOS. Try again in a moment.",
    });
  }, MEMORIES_TIMEOUT_MS);
}

function setMemoryStatus(text, tone = "") {
  const el = $("memory-status");
  el.textContent = text;
  el.className = `help${tone ? ` ${tone}` : ""}`;
}

function openMemories() {
  memoriesOpen = true;
  closeSettings();
  closeHistory();
  $("memories-page").classList.add("on");
  setMemoryStatus("");
  const list = $("memory-list");
  if (lastMemories) renderMemories(lastMemories);
  if (!connected) {
    if (!lastMemories) list.innerHTML = `<div id="memory-loading">${signedOut() ? "Sign up and CopperOS keeps what it learns about you here." : "Not connected — can’t load memories."}</div>`;
    return;
  }
  if (!lastMemories) list.innerHTML = '<div id="memory-loading"><span class="spinner"></span>Loading…</div>';
  $("memories-refresh").hidden = !lastMemories;
  askMemories({ type: "list_memories" });
}

function closeMemories() {
  memoriesOpen = false;
  $("memories-page").classList.remove("on");
  $("memories-refresh").hidden = true;
}

/** Grouped by topic, the user's own first, then the most recently changed. */
function renderMemories(memories) {
  const list = $("memory-list");
  list.innerHTML = "";
  if (memories.length === 0) {
    const empty = document.createElement("div");
    empty.id = "memory-empty";
    empty.textContent = "Nothing saved yet. CopperOS saves facts it learns as it works, like your answers to form questions, and you can add your own above.";
    list.appendChild(empty);
    return;
  }
  const groups = new Map();
  for (const m of memories) {
    if (!groups.has(m.topic)) groups.set(m.topic, []);
    groups.get(m.topic).push(m);
  }
  const order = [...groups.keys()].sort((a, b) =>
    (b === "user/notes") - (a === "user/notes") || groups.get(b)[0].updated.localeCompare(groups.get(a)[0].updated));
  for (const topic of order) {
    const head = document.createElement("div");
    head.className = "mgroup";
    head.textContent = topicName(topic);
    list.appendChild(head);
    for (const m of groups.get(topic)) list.appendChild(memoryItem(m));
  }
}

function memoryItem(m) {
  const item = document.createElement("div");
  item.className = "mitem";
  const title = document.createElement("div");
  title.className = "t";
  title.textContent = m.title;
  const content = document.createElement("div");
  content.className = "c";
  content.textContent = m.content;
  content.title = "Show all";
  content.addEventListener("click", () => content.classList.toggle("open"));
  const meta = document.createElement("div");
  meta.className = "mt";
  const when = document.createElement("span");
  const date = new Date(m.updated);
  when.textContent = isNaN(date) ? "" : `Saved ${date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
  // Two clicks: "Delete", then "Delete for good?" within a few seconds.
  const del = document.createElement("button");
  del.type = "button";
  del.className = "link danger";
  del.textContent = "Delete";
  let armed = null;
  del.addEventListener("click", () => {
    if (!armed) {
      del.textContent = "Delete for good?";
      armed = setTimeout(() => {
        armed = null;
        del.textContent = "Delete";
      }, 4000);
      return;
    }
    clearTimeout(armed);
    setBusy(del, true);
    askMemories({ type: "delete_memory", key: m.key });
  });
  meta.append(when, del);
  // A one-sentence memory is its own title: no need to say it twice.
  const same = m.content.trim().replace(/[.!?]$/, "") === m.title;
  item.append(title, ...(same ? [] : [content]), meta);
  return item;
}

function memoriesResult(msg) {
  clearTimeout(memoriesTimer);
  $("memories-refresh").hidden = true;
  setBusy($("memory-save"), false);
  if (msg.error) {
    // A list that failed to load still needs something in its place.
    if (!lastMemories) $("memory-list").innerHTML = "";
    setMemoryStatus(msg.error, "err");
    if (lastMemories && memoriesOpen) renderMemories(lastMemories);
    $("memory-save").disabled = !$("memory-text").value.trim();
    return;
  }
  lastMemories = msg.memories ?? [];
  if (msg.done === "add_memory") {
    $("memory-text").value = "";
    setMemoryStatus("Saved.");
  } else if (msg.done === "delete_memory") {
    setMemoryStatus("Deleted.");
  }
  $("memory-save").disabled = !$("memory-text").value.trim();
  if (memoriesOpen) renderMemories(lastMemories);
}

$("memories").addEventListener("click", openMemories);
$("memories-close").addEventListener("click", closeMemories);
$("memory-text").addEventListener("input", () => {
  $("memory-save").disabled = !$("memory-text").value.trim();
  if ($("memory-status").textContent) setMemoryStatus("");
});
$("memory-save").addEventListener("click", () => {
  const text = $("memory-text").value.trim();
  if (!text || !connected) return;
  setMemoryStatus("");
  setBusy($("memory-save"), true);
  askMemories({ type: "add_memory", text });
});

// ── workflows ────────────────────────────────────────────────────────────
//
// A task done once, kept as steps: click it and the agent follows them in a
// fresh chat. They come from this page (typed), or from a chat that went well,
// which the broker writes up as steps for the person to read and fix.

// A run needs at least this many steps before it is worth offering to keep.
const WORKFLOWS_TIMEOUT_MS = 10_000;
const DRAFT_TIMEOUT_MS = 60_000;

function askWorkflows(msg) {
  port.postMessage(msg);
  clearTimeout(workflowsTimer);
  workflowsTimer = setTimeout(() => {
    workflowsResult({
      error:
        backend === "local"
          ? "No answer from the broker on this computer. It may need updating: git pull in browsercontrol, then restart it."
          : "No answer from CopperOS. Try again in a moment.",
    });
  }, WORKFLOWS_TIMEOUT_MS);
}

function requestWorkflows() {
  if (connected && workflows === null) port.postMessage({ type: "list_workflows" });
}

function setWfStatus(text, tone = "") {
  const el = $("wf-status");
  el.textContent = text;
  el.className = `help${tone ? ` ${tone}` : ""}`;
}

/** What the agent is told when a mold runs: its steps, to be followed in order. */
function workflowPrompt(w) {
  return (
    `Mold: ${w.name}\n\n` +
    `Follow these steps, in order. Tell me when it is done, or which step you could not do and why.\n\n${w.steps}`
  );
}

function stepCount(steps) {
  const numbered = steps.split("\n").filter((l) => /^\s*\d+[.)]\s/.test(l)).length;
  return numbered || steps.split("\n").filter((l) => l.trim()).length;
}

/** Runs a mold in a fresh chat — this one, if nothing has been said in it yet. It is already saved, so it is never offered to be saved again. */
function runWorkflow(w) {
  if (running) {
    setWfStatus("A task is still running in this chat. Stop it, or wait, then run the mold.", "err");
    return;
  }
  closeHistory();
  const text = workflowPrompt(w);
  const go = () => sendTask(text, false, { fromMold: w.id });
  if ($("empty")) go();
  else startFreshChat(go);
}

/** New mold: a fresh chat where CopperOS asks what the mold should do and writes it up, rather than a blank form. */
function startNewMold() {
  if (running) {
    setWfStatus("A task is still running in this chat. Stop it, or wait, then make a mold.", "err");
    return;
  }
  closeHistory();
  // Nothing is sent yet: the person describes the mold first, in their own words.
  if ($("empty")) setMoldDraft(true);
  else startFreshChat(() => setMoldDraft(true));
}

$("mold-draft-cancel").addEventListener("click", () => setMoldDraft(false));

/** Opens a new chat as the New chat button does, and carries on once the broker has made it. */
function startFreshChat(then) {
  clearTimeout(afterReset?.timer);
  afterReset = { then, from: viewedChatId, timer: setTimeout(() => (afterReset = null), 5000) };
  $("new-chat").click();
}

/** The first few workflows on the empty chat, one click from running. */
function renderWorkflowChips() {
  const box = $("wf-chips");
  if (!box) return;
  box.innerHTML = "";
  const some = (workflows ?? []).slice(0, 3);
  box.hidden = some.length === 0;
  // Someone with workflows of their own does not need the examples.
  if ($("chips")) $("chips").hidden = some.length > 0;
  for (const w of some) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip wf";
    chip.dataset.wf = w.id;
    chip.title = `Run "${w.name}"`;
    chip.innerHTML = '<i class="i i-flow"></i>';
    const label = document.createElement("span");
    label.textContent = w.name;
    chip.appendChild(label);
    box.appendChild(chip);
  }
}

function openWorkflows() {
  openHistory("workflows");
}

/** The Workflows half of the window, as it opens. */
function loadWorkflowsTab() {
  setWfStatus("");
  $("wf-new").disabled = !connected && !signedOut();
  if (workflows) renderWorkflows();
  if (!connected) {
    if (!workflows) $("wf-list").innerHTML = `<div id="wf-loading">${signedOut() ? "Sign up and your molds are kept here." : "Not connected — can’t load molds."}</div>`;
    return;
  }
  if (!workflows) $("wf-list").innerHTML = '<div id="wf-loading"><span class="spinner"></span>Loading…</div>';
  $("history-refresh").hidden = !workflows;
  askWorkflows({ type: "list_workflows" });
}

function renderWorkflows() {
  const list = $("wf-list");
  list.innerHTML = "";
  if (!workflows || workflows.length === 0) {
    const empty = document.createElement("div");
    empty.id = "wf-empty";
    empty.textContent =
      "No molds yet. Press New mold and describe it in your own words: CopperOS asks about anything missing and writes it up. When a task repeats, it offers to save it as one too.";
    list.appendChild(empty);
    return;
  }
  for (const w of workflows) list.appendChild(workflowItem(w));
}

function workflowItem(w) {
  const item = document.createElement("div");
  item.className = "mitem wfitem";
  const title = document.createElement("div");
  title.className = "t";
  title.textContent = w.name;
  const steps = document.createElement("div");
  steps.className = "steps";
  steps.textContent = w.steps;
  steps.title = "Show all";
  steps.addEventListener("click", () => steps.classList.toggle("open"));
  const meta = document.createElement("div");
  meta.className = "mt";
  const n = stepCount(w.steps);
  const date = new Date(w.updated);
  meta.textContent =
    `${n} step${n === 1 ? "" : "s"}` +
    (isNaN(date) ? "" : ` · Saved ${date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`);

  const acts = document.createElement("div");
  acts.className = "acts2";
  const run = document.createElement("button");
  run.type = "button";
  run.className = "btn pr sm";
  run.textContent = "Run";
  run.addEventListener("click", () => runWorkflow(w));
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "link";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => openEditor({ id: w.id, name: w.name, steps: w.steps }));
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  // Two clicks: "Delete", then "Delete for good?" within a few seconds.
  const del = document.createElement("button");
  del.type = "button";
  del.className = "link danger";
  del.textContent = "Delete";
  let armed = null;
  del.addEventListener("click", () => {
    if (!armed) {
      del.textContent = "Delete for good?";
      armed = setTimeout(() => {
        armed = null;
        del.textContent = "Delete";
      }, 4000);
      return;
    }
    clearTimeout(armed);
    setBusy(del, true);
    askWorkflows({ type: "delete_workflow", id: w.id });
  });
  acts.append(run, edit, spacer, del);
  item.append(title, steps, meta, acts);
  return item;
}

function workflowsResult(msg) {
  clearTimeout(workflowsTimer);
  if (libraryTab === "workflows") $("history-refresh").hidden = true;
  if (msg.error && moldSaved(msg.error)) return;
  if (msg.error) {
    // Written up for the popup and refused (say, 50 saved already): tell them there.
    if (autoSave === "saving") {
      autoSave = null;
      hideWorkflowOffer();
      showToast(msg.error);
      return;
    }
    // The editor is on top while it is open: the message belongs there.
    if (editing) editorNote(msg.error, "err");
    else {
      if (!workflows) $("wf-list").innerHTML = "";
      setWfStatus(msg.error, "err");
      if (workflows && workflowsShown()) renderWorkflows();
    }
    setBusy($("wf-save"), false);
    updateEditorSave();
    return;
  }
  workflows = msg.workflows ?? [];
  renderWorkflowChips();
  if (msg.done === "save_workflow" && moldSaving) {
    moldSaved(null);
  } else if (msg.done === "save_workflow" && autoSave === "saving") {
    // The popup's: kept without the editor, with a way to read and change it.
    autoSave = null;
    hideWorkflowOffer();
    const saved = workflows[0];
    if (saved) showToast(`Saved “${saved.name}” to your molds`, "Edit", () => {
      openHistory("workflows");
      openEditor({ id: saved.id, name: saved.name, steps: saved.steps });
    });
  } else if (msg.done === "save_workflow") {
    closeEditor();
    setWfStatus("Saved.");
  } else if (msg.done === "delete_workflow") {
    setWfStatus("Deleted.");
  }
  if (workflowsShown()) renderWorkflows();
}

// ── a mold the model wrote ──

// The card whose Save is waiting on the broker, if any.
let moldSaving = null;

function showMoldProposal(text) {
  let mold;
  try {
    mold = JSON.parse(text);
  } catch {
    return;
  }
  if (!mold?.name || !mold?.steps) return;
  const card = document.createElement("div");
  card.className = "mold-card";
  const head = document.createElement("div");
  head.className = "mold-h";
  head.innerHTML = '<i class="i i-flow"></i>';
  head.append("Your mold");
  const name = document.createElement("div");
  name.className = "mold-name";
  name.textContent = mold.name;
  const steps = document.createElement("pre");
  steps.className = "mold-steps";
  steps.textContent = mold.steps;
  const note = document.createElement("div");
  note.className = "mold-note";
  note.setAttribute("role", "status");
  const acts = document.createElement("div");
  acts.className = "mold-acts";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn pr sm";
  save.textContent = "Save mold";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "btn sm";
  edit.textContent = "Edit first";
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const no = document.createElement("button");
  no.type = "button";
  no.className = "link quiet";
  no.textContent = "Not now";
  save.addEventListener("click", () => {
    if (moldSaving || !connected) return;
    moldSaving = { card, note, acts, name: mold.name };
    note.className = "mold-note";
    note.textContent = "";
    setBusy(save, true);
    askWorkflows({ type: "save_workflow", name: mold.name, steps: mold.steps });
  });
  edit.addEventListener("click", () => openEditor({ name: mold.name, steps: mold.steps }));
  no.addEventListener("click", () => card.remove());
  acts.append(save, edit, spacer, no);
  card.append(head, name, steps, acts, note);
  place(card);
  scrollToBottom();
}

/** What became of a mold card's Save. */
function moldSaved(error) {
  const m = moldSaving;
  moldSaving = null;
  if (!m) return false;
  setBusy(m.acts.querySelector(".btn.pr"), false);
  if (error) {
    m.note.className = "mold-note err";
    m.note.textContent = error;
    return true;
  }
  m.acts.remove();
  m.note.className = "mold-note ok";
  m.note.textContent = `Saved to your molds. Run it from the Molds tab, or from the start of a new chat.`;
  return true;
}

// ── the popup for a task that repeats, and the toast after ──

/** The first task in this chat that repeats until stopped: ask whether to keep it as a mold. */
function showWorkflowOffer(text, chatId) {
  if (!connected || editing) return;
  offer = { chatId: chatId ?? viewedChatId, text };
  setBusy($("wf-pop-yes"), false);
  $("wf-pop").hidden = false;
  scrollToBottom();
}

function hideWorkflowOffer() {
  offer = null;
  $("wf-pop").hidden = true;
  setBusy($("wf-pop-yes"), false);
}

$("wf-pop-no").addEventListener("click", hideWorkflowOffer);
$("wf-pop-yes").addEventListener("click", () => {
  if (!offer || autoSave) return;
  autoSave = "drafting";
  setBusy($("wf-pop-yes"), true);
  // From what was asked: the saved chat may not hold this task yet.
  port.postMessage({ type: "workflow_draft", text: offer.text });
  clearTimeout(draftTimer);
  draftTimer = setTimeout(
    () => workflowDraftResult({ error: "It took too long. Try again in a moment." }),
    DRAFT_TIMEOUT_MS,
  );
});

/** A line at the bottom of the chat that goes by itself, with an action if there is one to take. */
function showToast(text, actionLabel = null, onAction = null) {
  clearTimeout(toastTimer);
  $("toast-text").textContent = text;
  const act = $("toast-act");
  act.hidden = !actionLabel;
  act.textContent = actionLabel ?? "";
  act.onclick = onAction ? () => (hideToast(), onAction()) : null;
  $("toast").hidden = false;
  toastTimer = setTimeout(hideToast, 7000);
}

function hideToast() {
  clearTimeout(toastTimer);
  $("toast").hidden = true;
}

// ── the editor, and drafting from a chat ──

function editorNote(text, tone = "", spinning = false) {
  const el = $("wf-editor-note");
  el.className = `help${tone ? ` ${tone}` : ""}`;
  el.innerHTML = spinning ? '<span class="spinner"></span>' : "";
  el.append(text);
}

function updateEditorSave() {
  $("wf-save").disabled = !editing || editing.drafting || !$("wf-name").value.trim() || !$("wf-steps").value.trim();
}

function openEditor({ id = null, name = "", steps = "", drafting = false } = {}) {
  editing = { id, drafting };
  $("wf-editor-title").textContent = drafting ? "Writing up the mold" : id ? "Edit mold" : "New mold";
  $("wf-name").value = name;
  $("wf-steps").value = steps;
  $("wf-steps").disabled = drafting;
  $("wf-name").disabled = drafting;
  editorNote(drafting ? "Writing the steps from this chat…" : "", "", drafting);
  setBusy($("wf-save"), false);
  updateEditorSave();
  $("wf-editor").hidden = false;
  if (!drafting) $("wf-name").focus();
}

function closeEditor() {
  editing = null;
  clearTimeout(draftTimer);
  $("wf-editor").hidden = true;
  setBusy($("wf-save"), false);
}

function workflowDraftResult(msg) {
  // The popup's: written up, and saved as written.
  if (autoSave === "drafting") {
    clearTimeout(draftTimer);
    if (msg.error || !msg.steps) {
      autoSave = null;
      hideWorkflowOffer();
      showToast(msg.error || "Could not write it up. Try again in a moment.");
      return;
    }
    autoSave = "saving";
    askWorkflows({ type: "save_workflow", name: msg.name, steps: msg.steps });
    return;
  }
  // Cancelled while it was being written: nothing is waiting for it.
  if (!editing?.drafting) return;
  clearTimeout(draftTimer);
  editing.drafting = false;
  $("wf-steps").disabled = false;
  $("wf-name").disabled = false;
  if (msg.error) {
    editorNote(msg.error, "err");
  } else {
    $("wf-name").value = msg.name ?? "";
    $("wf-steps").value = msg.steps ?? "";
    editorNote("Read it through and fix anything before you save.");
  }
  updateEditorSave();
  $("wf-steps").focus();
}

$("wf-new").addEventListener("click", startNewMold);
$("wf-cancel").addEventListener("click", closeEditor);
$("wf-editor").addEventListener("click", (e) => {
  if (e.target === $("wf-editor") && !$("wf-save").classList.contains("busy")) closeEditor();
});
$("wf-name").addEventListener("input", updateEditorSave);
$("wf-steps").addEventListener("input", updateEditorSave);
$("wf-save").addEventListener("click", () => {
  if (!editing || editing.drafting) return;
  const name = $("wf-name").value.trim();
  const steps = $("wf-steps").value.trim();
  if (!name || !steps) return;
  editorNote("");
  setBusy($("wf-save"), true);
  askWorkflows({ type: "save_workflow", id: editing.id, name, steps });
});

// ── suggestions ──────────────────────────────────────────────────────────

function openSuggest() {
  $("suggest").hidden = false;
  $("suggest-note").textContent = account?.email ? `Sent with your email, ${account.email}, so we can reply.` : "";
  $("suggest-note").className = "help";
  $("suggest-send").disabled = !$("suggest-text").value.trim();
  $("suggest-text").focus();
}

function closeSuggest() {
  $("suggest").hidden = true;
  setBusy($("suggest-send"), false);
}

$("suggest-open").addEventListener("click", openSuggest);
$("suggest-cancel").addEventListener("click", closeSuggest);
$("suggest").addEventListener("click", (e) => {
  if (e.target === $("suggest") && !$("suggest-send").classList.contains("busy")) closeSuggest();
});
$("suggest-text").addEventListener("input", () => {
  $("suggest-send").disabled = !$("suggest-text").value.trim();
});
$("suggest-send").addEventListener("click", () => {
  const text = $("suggest-text").value.trim();
  if (!text) return;
  $("suggest-note").textContent = "";
  setBusy($("suggest-send"), true);
  port.postMessage({ type: "suggest", text });
});

function suggestResult(msg) {
  setBusy($("suggest-send"), false);
  const note = $("suggest-note");
  if (!msg.ok) {
    note.className = "help err";
    note.textContent = msg.error || "It didn't go through. Try again.";
    return;
  }
  note.className = "help ok";
  note.textContent = "Thanks — it's on its way.";
  $("suggest-text").value = "";
  $("suggest-send").disabled = true;
  setTimeout(() => {
    if (!$("suggest").hidden) closeSuggest();
  }, 1400);
}

// ── broker messages ──────────────────────────────────────────────────────

port.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "connection":
      endBoot();
      connected = msg.connected;
      if ("backend" in msg) backend = msg.backend;
      if ("account" in msg) {
        account = msg.account;
        if (!account) {
          // Signed out: nothing of the last person's plan or billing stays on screen.
          usage = null;
          billing = null;
          ownKeyAllowed = false;
          plansArrived();
          billingArrived();
          stopWatching();
          closePlans();
        }
      }
      if (signingIn && account) setSigningIn(false);
      renderStatus();
      renderAccount();
      if (settingsOpen) renderPlan();
      if (settingsOpen) {
        renderSettingsAvailability();
        if (connected && !currentConfig) port.postMessage({ type: "get_config" });
        requestUsage();
      }
      requestWorkflows();
      sendWhatWaited();
      break;

    case "tab":
      setTab(msg.tab);
      break;

    case "suggest_result":
      suggestResult(msg);
      break;

    case "approval_mode":
      setApprovalMode(msg.mode);
      break;

    case "account_deleted":
      setSettingsStatus("Your account and everything in it were deleted.", "ok");
      break;

    case "auth_error":
      setSigningIn(false);
      $("signup-note").textContent = msg.text ?? "";
      if (settingsOpen) setSettingsStatus(msg.text ?? "Sign-in failed.", "err");
      break;

    // Sent on connect and whenever the viewed chat changes. Unlike a popup, a
    // side panel usually stays open across tab switches — this still covers
    // the service worker being recycled out from under it.
    case "restore":
      endBoot();
      connected = msg.connected;
      if ("backend" in msg) {
        // Another broker's chats: its settings are not this one's.
        if (msg.backend !== backend) {
          currentConfig = null;
          lastMemories = null;
          workflows = null;
        }
        backend = msg.backend;
      }
      if ("account" in msg) {
        account = msg.account;
        if (!account) {
          // Signed out: nothing of the last person's plan or billing stays on screen.
          usage = null;
          billing = null;
          ownKeyAllowed = false;
          plansArrived();
          billingArrived();
          stopWatching();
          closePlans();
        }
      }
      if (signingIn && account) setSigningIn(false);
      setBusy($("account-btn"), signingIn);
      if (Array.isArray(msg.chats)) lastChats = msg.chats;
      approvalDefault = msg.approvalDefault ?? null;
      localBrokerUp = msg.localBroker === true;
      localOffer = msg.localOffer === true;
      renderLocalOffer();
      if (offer && msg.chatId !== offer.chatId) hideWorkflowOffer();
      // Another chat on screen: a mold being described was for the one left.
      if (moldDraft && (msg.chatId ?? null) !== viewedChatId) setMoldDraft(false);
      viewedChatId = msg.chatId ?? null;
      resetLog();
      for (const ev of msg.events ?? []) renderEvent(ev);
      showApproval(msg.approval);
      showAsk(msg.ask);
      watching = Boolean(msg.watching);
      setRunning(Boolean(msg.running));
      setApprovalMode(msg.approvalMode ?? "submits");
      setSupervisor(msg.supervisor === true);
      setPendingApprovalChatIds(msg.pendingApprovalChatIds ?? []);
      renderStatus();
      renderAccount();
      if (settingsOpen) renderSettingsAvailability();
      requestWorkflows();
      renderWorkflowChips();
      sendWhatWaited();
      // A workflow waited for a fresh chat to run in: it is here.
      if (afterReset && msg.chatId && msg.chatId !== afterReset.from && !msg.running) {
        const { then, timer } = afterReset;
        clearTimeout(timer);
        afterReset = null;
        then();
      }
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

    case "frame": {
      const img = run?.el.querySelector(".live img");
      if (img) img.src = `data:image/jpeg;base64,${msg.data}`;
      break;
    }

    case "chats":
      lastChats = msg.chats ?? [];
      $("history-refresh").hidden = true;
      if (historyOpen) renderChats(lastChats);
      break;

    case "memories":
      memoriesResult(msg);
      break;

    case "workflows":
      workflowsResult(msg);
      break;

    case "local_broker":
      localBrokerUp = msg.running === true;
      localOffer = msg.offer === true;
      renderStatus();
      renderAccount();
      renderLocalOffer();
      break;

    case "workflow_draft":
      workflowDraftResult(msg);
      break;

    case "config":
      currentConfig = msg.config;
      if (settingsOpen) applyConfig(msg.config, msg.platformModel, msg.ownKeyAllowed);
      else {
        if (msg.platformModel) platformModel = msg.platformModel;
        if (typeof msg.ownKeyAllowed === "boolean") ownKeyAllowed = msg.ownKeyAllowed;
      }
      // A broker on this computer does not say: it has Jev if its .env does, and the supervisor is offered.
      jevAvailable = msg.jevOn !== false;
      setSupervisor(supervisor);
      if (awaitingSave) {
        awaitingSave = false;
        setBusy($("settings-save"), false);
        setSettingsStatus("Saved", "ok");
        requestUsage();
        setTimeout(() => { if ($("settings-status").textContent === "Saved") setSettingsStatus(""); }, 1500);
      }
      break;

    case "usage":
      plansArrived();
      usage = { usage: msg.usage, ownKey: msg.ownKey === true };
      setOwnKeyAllowed(msg.usage?.ownKeyAllowed);
      renderPlan();
      checkPurchase();
      break;

    case "billing":
      billingArrived();
      billing = msg;
      if (msg.enabled) setOwnKeyAllowed(msg.ownKeyAllowed);
      renderPlans();
      checkPurchase();
      break;

    case "billing_url":
      stopBuying();
      renderPlans();
      if (msg.error) {
        plansStatus(msg.error, "err");
      } else {
        plansStatus(
          msg.kind === "portal"
            ? "Your billing page is open in a new tab."
            : "Finish paying in the new tab. This page updates when it's done.",
        );
        watchPurchase();
      }
      break;

    case "models": {
      if (!PROVIDERS.includes(msg.provider)) break;
      const select = $(`cfg-${msg.provider}-model`);
      $(`cfg-${msg.provider}-loading`).hidden = true;
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
        // Already shown optimistically when this panel sent the task.
        if (pendingEcho !== null && pendingEcho === (msg.text ?? "")) {
          pendingEcho = null;
          beginPending(Date.now());
        } else {
          renderEvent({ event: "start", text: msg.text ?? "" }, true);
        }
        setRunning(true);
        break;
      }
      renderEvent({ event: msg.event, text: msg.text ?? "", chatId: msg.chatId }, true);
      if (TERMINAL.includes(msg.event)) {
        showApproval(null);
        showAsk(null);
        setRunning(false);
      }
      break;
  }
});

// ── composer ─────────────────────────────────────────────────────────────

/** Sends `text` as a task; with none given, what is in the box (which it then empties). */
function sendTask(text, fromBox = text === undefined, extras = {}) {
  text ??= task.value.trim();
  if (!text || running) return;
  // Nothing to run it on yet: ask for an account, and keep what was typed until there is one.
  if (signedOut()) {
    openSignup(fromBox ? undefined : text);
    return;
  }
  // The idea for a new mold, in the person's words: the model asks about what it leaves out.
  if (moldDraft && !extras.fromMold) {
    extras = { ...extras, makeMold: true };
    setMoldDraft(false);
  }
  // The log is not cleared: each task is a turn in one ongoing chat, and the
  // broker keeps the transcript. "New chat" is how you start over.
  pendingEcho = text;
  addMine(text);
  const rules = rulesText();
  port.postMessage({ type: "task", text, ...(rules ? { rules } : {}), ...extras });
  // Rules are for one task: the next one starts without them.
  $("rules").value = "";
  resizeRules();
  if (fromBox) {
    task.value = "";
    autoResize();
  }
  renderComposer();
}

task.addEventListener("input", () => {
  autoResize();
  renderComposer();
});

task.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendTask();
  }
});

log.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  // A saved workflow runs at once; the examples only fill in the box.
  if (chip.dataset.wf) {
    const w = (workflows ?? []).find((x) => x.id === chip.dataset.wf);
    if (w) runWorkflow(w);
    return;
  }
  task.value = chip.textContent.trim();
  autoResize();
  renderComposer();
  task.focus();
});

function cancelRun() {
  // The chat on screen, by name: the service worker's own idea of it may not
  // be read back yet if it was just woken.
  port.postMessage({ type: "cancel", chatId: viewedChatId });
  // Not setRunning(false) here: that flips this panel's own composer state
  // without touching the service worker's session.running, which would
  // still say the chat is running the next time this panel opens. The
  // broker answers a cancel with a "cancelled" event almost immediately
  // (see agent.ts's abort-aware tool/approval waits), so waiting for the
  // real event keeps both in sync instead of just looking done. Meanwhile
  // the service worker refuses the chat's browser actions, so nothing more
  // happens on the page either way. Stop comes back after a few seconds
  // without an answer, so it can be clicked again.
  clearTimeout(stopTimer);
  stopTimer = setTimeout(stopAnswered, 6000);
  const btn = $("send");
  btn.disabled = true;
  btn.title = "Stopping…";
  const stop = run?.el.querySelector(".stop");
  if (stop) stop.disabled = true;
}

function stopAnswered() {
  clearTimeout(stopTimer);
  stopTimer = null;
  const stop = run?.el.querySelector(".stop");
  if (stop) stop.disabled = false;
  renderComposer();
}

// #send doubles as Stop while a run is in progress — same slot, same
// gesture, just a different icon and action underneath.
$("send").addEventListener("click", () => (running ? cancelRun() : sendTask()));

$("new-chat").addEventListener("click", () => {
  setMoldDraft(false);
  port.postMessage({ type: "reset" });
  resetLog();
  hideWorkflowOffer();
  setRunning(false);
  showApproval(null);
  showAsk(null);
  closeHistory();
  closeSettings();
});

$("history").addEventListener("click", () => openHistory());
$("history-close").addEventListener("click", closeHistory);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("suggest").hidden) closeSuggest();
  else if (memoriesOpen) closeMemories();
  else if (settingsOpen) closeSettings();
  else if (historyOpen) closeHistory();
});

$("approval-mode").addEventListener("change", () => {
  const mode = $("approval-mode").value;
  setApprovalMode(mode);
  port.postMessage({ type: "set_approval_mode", mode });
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

renderStatus();
renderComposer();
