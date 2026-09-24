// Accessibility-tree perception.
//
// This is the primary channel the model sees. It is ~20-50x cheaper than a
// screenshot of the same page and gives exact element identity, so vision is
// only an escalation path (see som.js), never the default.

import { send } from "./cdp.js";

const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
  "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "switch", "slider", "spinbutton", "textarea", "disclosuretriangle",
]);

// Named dialogs are listed so that a modal opening shows up as one — in an
// action's change report as much as in a snapshot.
const CONTEXT = new Set([
  "heading", "StaticText", "image", "img", "alert", "status", "dialog", "alertdialog",
]);

const SHOWN_PROPS = new Set([
  "checked", "expanded", "disabled", "required", "selected", "level", "pressed",
]);

const MAX_NODES = 400;
// Past MAX_NODES, page text is left out but fields and buttons keep coming,
// up to this hard cap. A long job ad above an application form used to push
// the form itself out of the snapshot behind a "scroll to reveal more" — and
// scrolling changes nothing about what a snapshot lists, so the model
// scrolled up and down looking for fields it could never see.
const HARD_MAX_LINES = 900;

// ── refs ────────────────────────────────────────────────────────────────────
//
// A ref names one DOM node for as long as that node lives, across snapshots,
// so the model can act on several refs from one snapshot and an action's
// result can say what changed by ref. Refs are per tab — two chats driving
// two tabs never share them. A new document clears the table, but numbering
// carries on, so a ref from the page before is unknown rather than quietly
// pointing at some other element on the new one.

// tabId -> { loaderId, byRef: Map<ref, backendId>, byNode: Map<backendId, ref>, seq, last }
const tabs = new Map();

function stateOf(tabId) {
  let s = tabs.get(tabId);
  if (!s) {
    s = { loaderId: null, byRef: new Map(), byNode: new Map(), seq: 0, last: null };
    tabs.set(tabId, s);
  }
  return s;
}

chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));

export function resolveRef(tabId, ref) {
  const id = tabs.get(tabId)?.byRef.get(ref);
  if (id === undefined) {
    throw new Error(
      `unknown ref "${ref}" — it is not from this page (the page navigated, or ` +
      `the ref came from another tab). Take a snapshot and use a ref from it.`,
    );
  }
  return id;
}

/** The last snapshot taken of a tab, or null. What the next one is compared against. */
export function lastSnapshot(tabId) {
  return tabs.get(tabId)?.last ?? null;
}

function textOf(axValue) {
  const v = axValue?.value;
  return typeof v === "string" ? v.trim() : "";
}

export async function snapshot(tabId, { maxNodes = MAX_NODES } = {}) {
  // Ensures the DOM agent has a document so backendNodeId lookups resolve later.
  await send(tabId, "DOM.getDocument", { depth: 1 });
  const [{ nodes }, { frameTree }] = await Promise.all([
    send(tabId, "Accessibility.getFullAXTree"),
    send(tabId, "Page.getFrameTree"),
  ]);

  const st = stateOf(tabId);
  const loaderId = frameTree.frame.loaderId;
  if (st.loaderId !== loaderId) {
    st.loaderId = loaderId;
    st.byRef = new Map();
    st.byNode = new Map();
    st.last = null;
  }

  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const depthOf = (n) => {
    let d = 0, cur = n;
    while (cur?.parentId && d < 40) { cur = byId.get(cur.parentId); d++; }
    return d;
  };

  // One per listed element: its ref (null for text) and its line without the
  // indent. What diffSnapshots compares — indentation shifts whenever the
  // page restructures around an element, and that is not a change to it.
  const entries = [];
  const lines = [];
  const interactiveRefs = [];
  let truncated = false;
  let lastText = "";
  let droppedText = 0;
  // The last text line left out past the budget: a field's label or question
  // usually sits right above it, and goes back in with the field.
  let heldLabel = null;

  const format = (n, role, name, value, ref) => {
    const props = (n.properties ?? [])
      .filter((p) => SHOWN_PROPS.has(p.name) && p.value?.value !== undefined)
      .map((p) => `${p.name}=${p.value.value}`);
    if (value) props.push(`value=${JSON.stringify(value)}`);
    const label = name ? ` ${JSON.stringify(name)}` : "";
    const tail = props.length ? ` ${props.join(" ")}` : "";
    return {
      ref,
      indent: "  ".repeat(Math.min(depthOf(n), 6)),
      body: `${ref ? `[${ref}] ` : ""}${role}${label}${tail}`,
    };
  };
  const push = (e) => {
    entries.push(e);
    lines.push(e.indent + e.body);
  };

  for (const n of nodes) {
    if (n.ignored) continue;
    const role = n.role?.value;
    if (!role) continue;

    const isInteractive = INTERACTIVE.has(role);
    if (!isInteractive && !CONTEXT.has(role)) continue;

    const name = textOf(n.name);
    const value = textOf(n.value);

    // Unnamed, valueless decoration carries no signal for the model.
    if (!isInteractive && !name) continue;
    // Collapse repeated identical text runs.
    if (role === "StaticText") {
      if (name === lastText) continue;
      lastText = name;
    }

    const overBudget = lines.length >= maxNodes;
    if (overBudget && !isInteractive) {
      droppedText++;
      heldLabel = format(n, role, name, value, null);
      continue;
    }
    if (lines.length >= HARD_MAX_LINES) { truncated = true; break; }
    if (overBudget && heldLabel) {
      push(heldLabel);
      droppedText--;
    }
    heldLabel = null;

    let ref = null;
    if (isInteractive && n.backendDOMNodeId !== undefined) {
      ref = st.byNode.get(n.backendDOMNodeId);
      if (!ref) {
        ref = `e${++st.seq}`;
        st.byNode.set(n.backendDOMNodeId, ref);
        st.byRef.set(ref, n.backendDOMNodeId);
      }
      interactiveRefs.push({ ref, backendNodeId: n.backendDOMNodeId });
    }
    push(format(n, role, name, value, ref));
  }

  if (droppedText > 0) {
    lines.push(
      `… ${droppedText} lines of page text were left out to keep this short. ` +
      `Every field and button is still listed; read_page returns the full text.`,
    );
  }
  if (truncated) {
    lines.push(
      `… stopped at ${HARD_MAX_LINES} lines: the page is very long, and ` +
      `nothing below this point is listed. read_page returns its full text.`,
    );
  }

  const { url, title } = await tabInfo(tabId);
  const header = `# ${title}\n# ${url}`;

  const snap = {
    text: `${header}\n${lines.join("\n")}`,
    entries,
    interactiveRefs,
    weak: assessWeakness(nodes),
    url,
    title,
    loaderId,
  };
  st.last = snap;
  return snap;
}

// ── changes ─────────────────────────────────────────────────────────────────

/**
 * What changed between two snapshots of the same document, in page order:
 * "+" for what appeared, "~" for an element whose line changed (its value,
 * checked, expanded…), "-" for what is gone. Elements are matched by ref,
 * text by content.
 */
export function diffSnapshots(prev, next) {
  const before = new Map(); // ref -> body
  const beforeText = new Map(); // body -> count
  for (const e of prev.entries) {
    if (e.ref) before.set(e.ref, e.body);
    else beforeText.set(e.body, (beforeText.get(e.body) ?? 0) + 1);
  }

  const out = [];
  const seen = new Set();
  for (const e of next.entries) {
    if (e.ref) {
      seen.add(e.ref);
      const was = before.get(e.ref);
      if (was === undefined) out.push(`+ ${e.body}`);
      else if (was !== e.body) out.push(`~ ${e.body}`);
    } else {
      const left = beforeText.get(e.body) ?? 0;
      if (left > 0) beforeText.set(e.body, left - 1);
      else out.push(`+ ${e.body}`);
    }
  }
  for (const [ref, body] of before) {
    if (!seen.has(ref)) out.push(`- ${body}`);
  }
  for (const [body, left] of beforeText) {
    for (let i = 0; i < left; i++) out.push(`- ${body}`);
  }
  return out;
}

// Heuristic escalation trigger. The model systematically under-requests vision,
// so we decide for it: icon-only UIs and canvas content are exactly the cases
// where an accessibility tree goes blind.
function assessWeakness(nodes) {
  const live = nodes.filter((n) => !n.ignored);
  const interactive = live.filter((n) => INTERACTIVE.has(n.role?.value));

  if (live.some((n) => n.role?.value === "canvas")) return "canvas content on page";
  if (interactive.length === 0) return "no interactive elements exposed";

  const unlabeled = interactive.filter((n) => !textOf(n.name)).length;
  const ratio = unlabeled / interactive.length;
  if (ratio > 0.3) {
    return `${unlabeled}/${interactive.length} interactive elements are unlabeled`;
  }
  return null;
}

async function tabInfo(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return { url: tab.url ?? "", title: tab.title ?? "" };
}
