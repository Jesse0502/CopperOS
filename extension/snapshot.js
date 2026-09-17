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

const CONTEXT = new Set(["heading", "StaticText", "image", "img", "alert", "status"]);

const SHOWN_PROPS = new Set([
  "checked", "expanded", "disabled", "required", "selected", "level", "pressed",
]);

const MAX_NODES = 400;

// ref -> backendDOMNodeId, rebuilt on every snapshot so stale refs fail loudly.
let refs = new Map();
let generation = 0;

export function resolveRef(ref) {
  const id = refs.get(ref);
  if (id === undefined) {
    throw new Error(
      `stale or unknown ref "${ref}" — the page changed. Call snapshot again ` +
      `and use a ref from the new output.`,
    );
  }
  return id;
}

export function snapshotGeneration() {
  return generation;
}

function textOf(axValue) {
  const v = axValue?.value;
  return typeof v === "string" ? v.trim() : "";
}

export async function snapshot(tabId, { maxNodes = MAX_NODES } = {}) {
  // Ensures the DOM agent has a document so backendNodeId lookups resolve later.
  await send(tabId, "DOM.getDocument", { depth: 1 });
  const { nodes } = await send(tabId, "Accessibility.getFullAXTree");

  refs = new Map();
  generation++;

  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const depthOf = (n) => {
    let d = 0, cur = n;
    while (cur?.parentId && d < 40) { cur = byId.get(cur.parentId); d++; }
    return d;
  };

  const lines = [];
  const interactiveRefs = [];
  let seq = 0;
  let truncated = false;
  let lastText = "";

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

    if (lines.length >= maxNodes) { truncated = true; break; }

    let ref = "";
    if (isInteractive && n.backendDOMNodeId !== undefined) {
      const key = `e${++seq}`;
      refs.set(key, n.backendDOMNodeId);
      interactiveRefs.push({ ref: key, backendNodeId: n.backendDOMNodeId });
      ref = `[${key}] `;
    }

    const props = (n.properties ?? [])
      .filter((p) => SHOWN_PROPS.has(p.name) && p.value?.value !== undefined)
      .map((p) => `${p.name}=${p.value.value}`);
    if (value) props.push(`value=${JSON.stringify(value)}`);

    const indent = "  ".repeat(Math.min(depthOf(n), 6));
    const label = name ? ` ${JSON.stringify(name)}` : "";
    const tail = props.length ? ` ${props.join(" ")}` : "";
    lines.push(`${indent}${ref}${role}${label}${tail}`);
  }

  if (truncated) {
    lines.push(`… truncated at ${maxNodes} nodes. Scroll to reveal more.`);
  }

  const { url, title } = await tabInfo(tabId);
  const header = `# ${title}\n# ${url}`;

  return {
    text: `${header}\n${lines.join("\n")}`,
    interactiveRefs,
    weak: assessWeakness(nodes),
    generation,
  };
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
