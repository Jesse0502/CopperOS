const port = chrome.runtime.connect({ name: "sidepanel" });

const $ = (id) => document.getElementById(id);
const log = $("log");
const task = $("task");

const TERMINAL = ["done", "error", "cancelled"];
const EMPTY_HTML = log.innerHTML; // restored by "new chat" and on reset

let connected = false;
// Which broker, and who is signed in to it when it is the hosted one.
let backend = "local";
let account = null; // { email } or null
// A new install has not said where CopperOS should run yet.
let welcome = false;
let welcomeChoice = null;
let running = false;
let watching = false;
let historyOpen = false;
let settingsOpen = false;
let currentConfig = null; // last "config" message from the broker
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

function hideEmpty() {
  $("empty")?.remove();
}

function scrollToBottom() {
  log.scrollTop = log.scrollHeight;
}

function resetLog() {
  log.innerHTML = EMPTY_HTML;
  run = null;
}

/** Puts a message above the running card, if there is one, so the card stays last. */
function place(el) {
  hideEmpty();
  if (run) log.insertBefore(el, run.el);
  else log.appendChild(el);
  scrollToBottom();
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
  if (!run) startRun(null);
  const [name, label, describe] = STEPS[kind] ?? ["dot", kind.charAt(0).toUpperCase() + kind.slice(1), same];
  const warn =
    kind === "awaiting-approval" || kind === "blocked" ||
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
    startRun(at);
    return;
  }
  if (kind === "say") return addTheirs(text);
  if (kind === "rules") return addRules(text);
  if (kind === "think") return setThink(text);
  if (TERMINAL.includes(kind)) {
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
  const state = !connected ? "off" : gated ? "wait" : running ? "busy" : "ok";
  dot.className = `dot${state === "off" ? "" : ` ${state}`}`;
  const says = {
    off: backend === "local" ? "Broker offline" : account ? "Reconnecting…" : "Signed out",
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

function renderStatus() {
  renderDot();
  $("offline-local").hidden = backend !== "local";
  $("offline-signin").hidden = !(backend === "cloud" && !account);
  $("offline-cloud").hidden = !(backend === "cloud" && account);
  renderOffline();
}

// The not-connected screen is held back briefly: every panel opens
// disconnected until the service worker reports in, and a broker restarting
// under `npm run dev` drops for a moment too. Neither should flash it.
const OFFLINE_DELAY_MS = 1500;
let offlineTimer = null;

function renderOffline() {
  // Signed out is a steady state, not a blip: no reason to hold it back.
  if (!connected && backend === "cloud" && !account) {
    clearTimeout(offlineTimer);
    offlineTimer = null;
    document.body.classList.add("offline");
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

function renderWelcome() {
  document.body.classList.toggle("welcome", welcome);
  const choice = welcomeChoice ?? backend;
  for (const b of document.querySelectorAll("#welcome [data-choice]")) {
    b.setAttribute("aria-checked", String(b.dataset.choice === choice));
  }
}

// ── composer ─────────────────────────────────────────────────────────────

function renderComposer() {
  const send = $("send");
  send.classList.toggle("running", running);
  send.title = running ? "Stop" : "Send";
  send.setAttribute("aria-label", send.title);
  // While running, #send is the Stop button, so it stays clickable
  // regardless of what's in the textarea.
  send.disabled = running ? false : !task.value.trim();
  // The broker takes the next message once this task is over.
  task.disabled = running;
  $("rules-btn").disabled = running;
  if (running) setRulesOpen(false);
  task.placeholder = running
    ? "Working… you can stop it anytime"
    : $("empty") ? "e.g. Find the cheapest paid tier" : "Ask a follow-up…";
}

function setRunning(on) {
  running = on;
  if (on && !run) startRun(null);
  if (!on && run) finishRun(null, "");
  clearInterval(runTimer);
  runTimer = on ? setInterval(renderRun, 1000) : null;
  renderRun();
  renderComposer();
  renderDot();
}

// Rules for the supervisor: set before sending, and sent with the next task only.
function rulesText() {
  return $("rules").value.trim();
}

function setRulesOpen(open) {
  $("rules-box").hidden = !open;
  $("rules-btn").setAttribute("aria-expanded", String(open));
  renderRulesButton();
}

function renderRulesButton() {
  const set = Boolean(rulesText());
  const btn = $("rules-btn");
  btn.classList.toggle("set", set);
  btn.title = set ? "Supervisor rules set for this task" : "Rules the supervisor holds this task to";
  btn.setAttribute("aria-label", btn.title);
}

$("rules-btn").addEventListener("click", () => {
  const open = $("rules-box").hidden;
  setRulesOpen(open);
  if (open) $("rules").focus();
});
$("rules").addEventListener("input", () => {
  renderRulesButton();
  $("rules").style.height = "auto";
  $("rules").style.height = Math.min($("rules").scrollHeight, 120) + "px";
});
$("rules").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    setRulesOpen(false);
    task.focus();
  }
});
$("rules-clear").addEventListener("click", () => {
  $("rules").value = "";
  setRulesOpen(false);
  task.focus();
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
    item.className = `hitem${viewing ? " on" : ""}`;

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

function openHistory() {
  historyOpen = true;
  closeSettings();
  $("history-page").classList.add("on");
  const list = $("history-list");
  const cached = lastChats.filter((c) => c.taskCount > 0).length > 0;
  // The last list shows at once; a fresh one replaces it when it comes.
  if (cached) renderChats(lastChats);
  if (!connected) {
    if (!cached) list.innerHTML = '<div id="history-loading">Not connected — can’t load chats.</div>';
    return;
  }
  if (!cached) list.innerHTML = '<div id="history-loading"><span class="spinner"></span>Loading…</div>';
  $("history-refresh").hidden = !cached;
  port.postMessage({ type: "chats" });
}

function closeHistory() {
  historyOpen = false;
  $("history-page").classList.remove("on");
  $("history-refresh").hidden = true;
}

// ── settings ─────────────────────────────────────────────────────────────

const PROVIDERS = ["ollama", "openai", "openrouter"];
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
  $("account-row").hidden = backend !== "cloud";
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
  $("model-settings").hidden = !connected;
  note.hidden = connected;
  note.textContent =
    backend === "local"
      ? "Start the broker on this computer to choose a model."
      : account
        ? "Connecting to CopperOS…"
        : "Sign in to choose your model and API key.";
}

function applyConfig(cfg) {
  currentConfig = cfg;
  $("cfg-provider").value = cfg.provider;
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
  fillModelSelect($("cfg-openrouter-model"), [], openrouter.model);
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
  $("settings-page").classList.add("on");
  setSettingsStatus("");
  askBeforeShown = approvalDefault ?? "submits";
  $("cfg-ask-before").value = askBeforeShown;
  renderAccount();
  renderSettingsAvailability();
  if (connected) port.postMessage({ type: "get_config" });
}

function closeSettings() {
  settingsOpen = false;
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
    "Delete your CopperOS account?\n\nThis permanently deletes your chats, memories and settings " +
      "(including your saved API keys) and signs you out. It cannot be undone.",
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

$("cfg-provider").addEventListener("change", () => {
  const provider = $("cfg-provider").value;
  providerBlocks(provider);
  requestModels(provider);
});

// A list that failed to load (no key yet, Ollama not running) tries again
// when it is opened.
for (const p of PROVIDERS) {
  $(`cfg-${p}-model`).addEventListener("focus", () => {
    if ($(`cfg-${p}-model`).options.length <= 1) requestModels(p);
  });
}

for (const p of ["openai", "openrouter"]) {
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

// ── first run, not connected ─────────────────────────────────────────────

for (const b of document.querySelectorAll("#welcome [data-choice]")) {
  b.addEventListener("click", () => {
    welcomeChoice = b.dataset.choice;
    renderWelcome();
  });
}
$("welcome-continue").addEventListener("click", () => {
  const choice = welcomeChoice ?? backend;
  port.postMessage({ type: "choose_backend", backend: choice });
  welcome = false;
  renderWelcome();
});

// Signing in opens Chrome's sign-in window and waits for it; both Sign in
// buttons spin until it is done one way or the other.
let signingIn = false;

function signIn() {
  $("offline-signin-note").textContent = "";
  setSigningIn(true);
  port.postMessage({ type: "sign_in" });
}

function setSigningIn(on) {
  signingIn = on;
  setBusy($("offline-signin-btn"), on);
  setBusy($("account-btn"), on);
}

$("offline-signin-btn").addEventListener("click", signIn);
$("offline-use-local").addEventListener("click", () => {
  port.postMessage({ type: "set_backend", backend: "local" });
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
      connected = msg.connected;
      if ("backend" in msg) backend = msg.backend;
      if ("account" in msg) account = msg.account;
      if (signingIn && account) setSigningIn(false);
      renderStatus();
      renderAccount();
      if (settingsOpen) {
        renderSettingsAvailability();
        if (connected && !currentConfig) port.postMessage({ type: "get_config" });
      }
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
      $("offline-signin-note").textContent = "Your account and everything in it were deleted.";
      break;

    case "auth_error":
      setSigningIn(false);
      $("offline-signin-note").textContent = msg.text ?? "";
      if (settingsOpen) setSettingsStatus(msg.text ?? "Sign-in failed.", "err");
      break;

    // Sent on connect and whenever the viewed chat changes. Unlike a popup, a
    // side panel usually stays open across tab switches — this still covers
    // the service worker being recycled out from under it.
    case "restore":
      connected = msg.connected;
      if ("backend" in msg) {
        // Another broker's chats: its settings are not this one's.
        if (msg.backend !== backend) currentConfig = null;
        backend = msg.backend;
      }
      if ("account" in msg) account = msg.account;
      if (signingIn && account) setSigningIn(false);
      setBusy($("account-btn"), signingIn);
      if (Array.isArray(msg.chats)) lastChats = msg.chats;
      welcome = Boolean(msg.welcome);
      approvalDefault = msg.approvalDefault ?? null;
      viewedChatId = msg.chatId ?? null;
      resetLog();
      for (const ev of msg.events ?? []) renderEvent(ev);
      showApproval(msg.approval);
      showAsk(msg.ask);
      watching = Boolean(msg.watching);
      setRunning(Boolean(msg.running));
      setApprovalMode(msg.approvalMode ?? "submits");
      setPendingApprovalChatIds(msg.pendingApprovalChatIds ?? []);
      renderStatus();
      renderAccount();
      renderWelcome();
      if (settingsOpen) renderSettingsAvailability();
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

    case "config":
      currentConfig = msg.config;
      if (settingsOpen) applyConfig(msg.config);
      if (awaitingSave) {
        awaitingSave = false;
        setBusy($("settings-save"), false);
        setSettingsStatus("Saved", "ok");
        setTimeout(() => { if ($("settings-status").textContent === "Saved") setSettingsStatus(""); }, 1500);
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
          startRun(Date.now());
        } else {
          renderEvent({ event: "start", text: msg.text ?? "" }, true);
        }
        setRunning(true);
        break;
      }
      renderEvent({ event: msg.event, text: msg.text ?? "" }, true);
      if (TERMINAL.includes(msg.event)) {
        showApproval(null);
        showAsk(null);
        setRunning(false);
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
  addMine(text);
  const rules = rulesText();
  port.postMessage({ type: "task", text, ...(rules ? { rules } : {}) });
  // Rules are for one task: the next one starts without them.
  $("rules").value = "";
  setRulesOpen(false);
  task.value = "";
  autoResize();
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
  task.value = chip.textContent.trim();
  autoResize();
  renderComposer();
  task.focus();
});

function cancelRun() {
  port.postMessage({ type: "cancel" });
  // Not setRunning(false) here: that flips this panel's own composer state
  // without touching the service worker's session.running, which would
  // still say the chat is running the next time this panel opens. The
  // broker answers a cancel with a "cancelled" event almost immediately
  // (see agent.ts's abort-aware tool/approval waits), so waiting for the
  // real event keeps both in sync instead of just looking done.
  const btn = $("send");
  btn.disabled = true;
  btn.title = "Stopping…";
  const stop = run?.el.querySelector(".stop");
  if (stop) stop.disabled = true;
}

// #send doubles as Stop while a run is in progress — same slot, same
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
});

$("history").addEventListener("click", openHistory);
$("history-close").addEventListener("click", closeHistory);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("suggest").hidden) closeSuggest();
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
