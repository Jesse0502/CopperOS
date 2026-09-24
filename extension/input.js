// Trusted input dispatch with human-like timing.
//
// Everything goes through CDP Input.* so events arrive with isTrusted: true.
// Dispatched MouseEvent / element.click() cannot produce that, and many form
// and analytics handlers check it.
//
// The timing model lives here in deterministic code rather than being
// something the model decides per call, so behaviour stays consistent.

import { send, stateFor } from "./cdp.js";
import { resolveRef } from "./snapshot.js";

const rand = (a, b) => a + Math.random() * (b - a);
const between = ([a, b]) => rand(a, b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every delay in one place. Paths stay curved and every gap stays jittered,
// but brisk: a click takes ~0.15s rather than the ~0.5s of a leisurely hand.
// The earlier, slower pace was roughly: 10–55 path steps at 4–13ms, dwell
// 40–160, press 45–125, keys 55–185ms apart, hover 120–350.
const PACE = {
  movePxPerStep: 25,
  moveSteps: [4, 15],
  moveStepMs: [2, 6],
  dwellMs: [20, 60], // over the target, before pressing
  pressMs: [30, 70], // button held down
  hoverMs: [80, 150],
  keyHoldMs: [20, 50],
  keyGapMs: [25, 70], // between typed characters, lognormal-ish
  wordGapFactor: [1.2, 1.8], // longer after a space or punctuation
  focusToTypeMs: [60, 150],
  beforePasteMs: [40, 100],
  afterPasteMs: [60, 120], // lets the page reformat before the read-back
  beforeSubmitMs: [100, 250],
  clearGapMs: [30, 60],
  selectGapMs: [80, 150],
  repeatGapMs: [20, 50],
  scrollStepPx: [150, 250],
  scrollStepMs: [15, 40],
  scrollSettleMs: [100, 250],
};

// Lets the presence overlay draw the agent's pointer without input.js knowing
// anything about it. Observers are told, never awaited, and cannot throw into
// the input path.
let pointerObserver = null;
export function observePointer(fn) {
  pointerObserver = fn;
}
function notify(evt) {
  try {
    pointerObserver?.(evt);
  } catch {
    // Drawing is best-effort; input is not.
  }
}

// ── geometry ────────────────────────────────────────────────────────────────

export async function boxForNode(tabId, backendNodeId, what = "that element") {
  try {
    await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    // Non-fatal: element may already be in view or be a zero-box container.
  }
  let model;
  try {
    ({ model } = await send(tabId, "DOM.getBoxModel", { backendNodeId }));
  } catch (err) {
    if (/no node|box model|not found/i.test(String(err?.message ?? err))) {
      throw new Error(
        `${what} is no longer on the page, or is not rendered — take a snapshot ` +
        `to see the page as it is now`,
      );
    }
    throw err;
  }
  const [x1, y1, x2, , , y3] = model.content;
  if (x2 - x1 <= 0 || y3 - y1 <= 0) {
    throw new Error(`${what} has no visible box — it may be hidden or collapsed`);
  }
  return { x1, y1, x2, y2: y3, cx: (x1 + x2) / 2, cy: (y1 + y3) / 2 };
}

export function boxForRef(tabId, ref) {
  return boxForNode(tabId, resolveRef(tabId, ref), `ref "${ref}"`);
}

// ── mouse ───────────────────────────────────────────────────────────────────

// Cubic Bezier with randomized control points, reparameterized by an
// ease-in-out curve so pointer speed ramps up and back down across the move
// rather than being uniform.
function humanPath(x0, y0, x1, y1, steps) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const j = Math.min(dist * 0.25, 120);
  const cx1 = x0 + (x1 - x0) * 0.3 + rand(-j, j);
  const cy1 = y0 + (y1 - y0) * 0.3 + rand(-j, j);
  const cx2 = x0 + (x1 - x0) * 0.7 + rand(-j, j);
  const cy2 = y0 + (y1 - y0) * 0.7 + rand(-j, j);

  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const u = 1 - e;
    pts.push({
      x: u ** 3 * x0 + 3 * u * u * e * cx1 + 3 * u * e * e * cx2 + e ** 3 * x1,
      y: u ** 3 * y0 + 3 * u * u * e * cy1 + 3 * u * e * e * cy2 + e ** 3 * y1,
    });
  }
  return pts;
}

export async function moveTo(tabId, x, y) {
  const st = stateFor(tabId);
  const { cursor } = st;
  const dist = Math.hypot(x - cursor.x, y - cursor.y);
  const [min, max] = PACE.moveSteps;
  const steps = Math.max(min, Math.min(max, Math.round(dist / PACE.movePxPerStep)));

  const path = humanPath(cursor.x, cursor.y, x, y, steps);
  // Delays are drawn up front so the overlay can replay the same path on the
  // same timing from a single message, instead of one message per step.
  const delays = path.map(() => between(PACE.moveStepMs));
  notify({
    type: "move",
    tabId,
    points: path.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
    delays,
  });

  for (let i = 0; i < path.length; i++) {
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: path[i].x, y: path[i].y, button: "none", buttons: 0,
    });
    await sleep(delays[i]);
  }
  st.cursor = { x, y };
}

/** Click a DOM node by backend id — for elements the extension finds itself (e.g. Sheets' name box). */
export async function clickNode(tabId, backendNodeId, { button = "left", clickCount = 1, what } = {}) {
  const box = await boxForNode(tabId, backendNodeId, what);
  // Aim near-center but not dead-center.
  const jx = Math.min((box.x2 - box.x1) / 4, 6);
  const jy = Math.min((box.y2 - box.y1) / 4, 6);
  const x = box.cx + rand(-jx, jx);
  const y = box.cy + rand(-jy, jy);

  await moveTo(tabId, x, y);
  await sleep(between(PACE.dwellMs));

  const base = { x, y, button, clickCount, buttons: button === "left" ? 1 : 2 };
  notify({ type: "press", tabId, x: Math.round(x), y: Math.round(y) });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await sleep(between(PACE.pressMs));
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  return { clickedAt: { x: Math.round(x), y: Math.round(y) } };
}

export function click(tabId, ref, opts = {}) {
  return clickNode(tabId, resolveRef(tabId, ref), { ...opts, what: `ref "${ref}"` });
}

export async function hover(tabId, ref) {
  const box = await boxForRef(tabId, ref);
  await moveTo(tabId, box.cx, box.cy);
  await sleep(between(PACE.hoverMs));
  return { hoveredAt: { x: Math.round(box.cx), y: Math.round(box.cy) } };
}

export async function scroll(tabId, { direction = "down", amount = 600 } = {}) {
  const st = stateFor(tabId);
  const sign = direction === "up" ? -1 : 1;
  const remaining = Math.abs(amount);
  let done = 0;

  while (done < remaining) {
    const step = Math.min(between(PACE.scrollStepPx), remaining - done);
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: st.cursor.x || 400,
      y: st.cursor.y || 400,
      deltaX: 0,
      deltaY: sign * step,
    });
    done += step;
    await sleep(between(PACE.scrollStepMs));
  }
  await sleep(between(PACE.scrollSettleMs));
  return { scrolled: sign * Math.round(done) };
}

// ── keyboard ────────────────────────────────────────────────────────────────

const KEYS = {
  Enter:      { keyCode: 13, code: "Enter",      text: "\r" },
  Tab:        { keyCode: 9,  code: "Tab",        text: "\t" },
  Space:      { keyCode: 32, code: "Space",      text: " ", key: " " },
  Backspace:  { keyCode: 8,  code: "Backspace" },
  Delete:     { keyCode: 46, code: "Delete" },
  Escape:     { keyCode: 27, code: "Escape" },
  ArrowUp:    { keyCode: 38, code: "ArrowUp" },
  ArrowDown:  { keyCode: 40, code: "ArrowDown" },
  ArrowLeft:  { keyCode: 37, code: "ArrowLeft" },
  ArrowRight: { keyCode: 39, code: "ArrowRight" },
  Home:       { keyCode: 36, code: "Home" },
  End:        { keyCode: 35, code: "End" },
  PageDown:   { keyCode: 34, code: "PageDown" },
  PageUp:     { keyCode: 33, code: "PageUp" },
};
for (let i = 1; i <= 12; i++) KEYS[`F${i}`] = { keyCode: 111 + i, code: `F${i}` };

// Windows virtual key codes for the keys that type punctuation (US layout).
// These are not the characters' codes, and must not be: "." is 46, which is
// VK_DELETE — sent as the key code, a typed "." deleted instead of typing,
// "(" pressed ArrowDown, "$" pressed Home.
const PUNCT_VK = {
  ";": 186, ":": 186, "=": 187, "+": 187, ",": 188, "<": 188, "-": 189, "_": 189,
  ".": 190, ">": 190, "/": 191, "?": 191, "`": 192, "~": 192,
  "[": 219, "{": 219, "\\": 220, "|": 220, "]": 221, "}": 221, "'": 222, '"': 222,
  "!": 49, "@": 50, "#": 51, "$": 52, "%": 53, "^": 54, "&": 55, "*": 56, "(": 57, ")": 48,
  " ": 32,
};

/** The virtual key code of the key that types `ch`; 0 when there is no such key (é, 字), which Chrome accepts with the text alone. */
function vkFor(ch) {
  if (/^[a-z]$/i.test(ch)) return ch.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(ch)) return ch.charCodeAt(0);
  return PUNCT_VK[ch] ?? 0;
}

// CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8.
const IS_MAC = /Mac/i.test(navigator.userAgent);
const SHORTCUT_MOD = IS_MAC ? 4 : 2;
const MODIFIERS = {
  alt: 1, option: 1,
  control: 2, ctrl: 2,
  meta: 4, cmd: 4, command: 4,
  shift: 8,
  mod: SHORTCUT_MOD,
};

// Chrome on macOS does not map a synthetic ⌘-key event onto the editing
// command by itself, so the modifier alone silently does nothing there.
// `commands` is what performs it. A page that handles the shortcut itself
// (Sheets' undo) prevents the default, and the command does not run twice.
const MAC_COMMANDS = { a: "selectAll", z: "undo", "shift+z": "redo" };

// These would put the user's own clipboard in play — overwriting what they
// last copied, or pasting it somewhere it was never meant to go.
const CLIPBOARD_KEYS = new Set(["c", "x", "v"]);

function describeKeys() {
  return (
    `a named key (${Object.keys(KEYS).join(", ")}) or a single character, ` +
    `optionally with modifiers: Mod (⌘ on Mac, Ctrl elsewhere), Control, ` +
    `Alt, Shift, Meta — e.g. "Shift+Tab", "Mod+z", "Alt+Enter"`
  );
}

/** "Mod+Shift+z" → the CDP fields for that key press. Throws a readable error for anything else. */
function parseCombo(combo) {
  const raw = String(combo ?? "").trim();
  // A trailing "+" is the plus key itself: "Mod++".
  const parts = raw.endsWith("++") ? [...raw.slice(0, -2).split("+"), "+"] : raw.split("+");
  const keyName = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODIFIERS[m.trim().toLowerCase()];
    if (!bit) throw new Error(`unknown modifier "${m}" in "${raw}". Use ${describeKeys()}.`);
    modifiers |= bit;
  }

  const named = KEYS[keyName] ??
    Object.entries(KEYS).find(([k]) => k.toLowerCase() === keyName?.toLowerCase())?.[1];
  const chording = (modifiers & (1 | 2 | 4)) !== 0; // Alt, Ctrl or Meta
  if (named) {
    const key = named.key ?? Object.keys(KEYS).find((k) => KEYS[k] === named);
    return {
      key,
      code: named.code,
      keyCode: named.keyCode,
      modifiers,
      // Ctrl/Alt/⌘ with Enter or Tab is a shortcut, not a typed newline or tab.
      text: chording ? undefined : named.text,
    };
  }

  if (typeof keyName !== "string" || [...keyName].length !== 1) {
    throw new Error(`unsupported key "${raw}". Use ${describeKeys()}.`);
  }
  const lower = keyName.toLowerCase();
  const isLetter = /^[a-z]$/.test(lower);
  const isDigit = /^[0-9]$/.test(keyName);
  if (chording && CLIPBOARD_KEYS.has(lower) && (modifiers & SHORTCUT_MOD)) {
    throw new Error(
      `"${raw}" would use the user's own clipboard, which is off limits. ` +
      `Put text in with paste (or sheet_write in Google Sheets) instead.`,
    );
  }
  const shifted = (modifiers & 8) !== 0;
  return {
    key: isLetter && shifted ? keyName.toUpperCase() : keyName,
    code: isLetter ? `Key${lower.toUpperCase()}` : isDigit ? `Digit${keyName}` : "",
    keyCode: vkFor(keyName),
    modifiers,
    text: chording ? undefined : (isLetter && shifted ? keyName.toUpperCase() : keyName),
    command: IS_MAC && (modifiers & 4)
      ? MAC_COMMANDS[`${shifted ? "shift+" : ""}${lower}`]
      : undefined,
  };
}

async function dispatchCombo(tabId, k) {
  const common = {
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode,
    modifiers: k.modifiers,
  };
  await send(tabId, "Input.dispatchKeyEvent", {
    type: k.text ? "keyDown" : "rawKeyDown",
    ...common,
    ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
    ...(k.command ? { commands: [k.command] } : {}),
  });
  await sleep(between(PACE.keyHoldMs));
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

/**
 * Press a key or a shortcut on whatever has focus: "Enter", "Shift+Tab",
 * "Mod+z" (⌘ on Mac, Ctrl elsewhere), "Alt+Enter", "Mod+b". `repeat` presses
 * it that many times, e.g. ArrowDown ×5.
 */
export async function pressKey(tabId, combo, { repeat = 1 } = {}) {
  const k = parseCombo(combo);
  const times = Math.max(1, Math.min(50, Math.floor(Number(repeat) || 1)));
  for (let i = 0; i < times; i++) {
    if (i > 0) await sleep(between(PACE.repeatGapMs));
    await dispatchCombo(tabId, k);
  }
  return times > 1 ? { pressed: combo, times } : { pressed: combo };
}

/** One typed character: keyDown carrying `text`, the keydown + char pair a real key emits. */
export async function typeChar(tabId, ch) {
  const code = vkFor(ch);
  const common = { key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: code };
  // Input.insertText would be faster but fires no key events at all, which
  // breaks framework onKeyDown handlers and field validation.
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...common });
  await send(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", key: ch, windowsVirtualKeyCode: code,
  });
}

/** Text in one go through the browser's editing pipeline (see pasteText). */
export function insertText(tabId, text) {
  return send(tabId, "Input.insertText", { text });
}

export async function clearField(tabId, key = "Backspace") {
  // `commands` is what actually performs the select-all. Chrome on macOS does
  // not map a synthetic Cmd+A key event onto the editing command by itself,
  // so the modifier alone silently selects nothing there.
  const selectAll = {
    key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: SHORTCUT_MOD,
  };
  await send(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown", ...selectAll, commands: ["selectAll"],
  });
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...selectAll });
  await sleep(between(PACE.clearGapMs));
  await pressKey(tabId, key);
}

/**
 * A node's current value, read from the accessibility tree the same way a
 * snapshot reads it. Null when it does not expose one — rich-text editors,
 * and password inputs, whose value the tree deliberately withholds.
 */
export async function readNodeValue(tabId, backendNodeId) {
  try {
    const { nodes } = await send(tabId, "Accessibility.getPartialAXTree", {
      backendNodeId,
      fetchRelatives: false,
    });
    const v = nodes?.[0]?.value?.value;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Focus the field by clicking it and delete what it already holds, so the
 * new text replaces it rather than landing wherever the click left the
 * caret. Returns what could not be deleted — "" for nothing, which is also
 * what a field that does not expose its value gets.
 *
 * With no ref, focus stays where it is and nothing is deleted: a select-all
 * there could take in a whole document (a canvas editor's hidden input, say).
 *
 * The selection goes with Delete, not Backspace. An empty field often reads
 * as no value at all rather than "", so it gets cleared too — and Backspace
 * in an empty tag or recipient field deletes the chip before it.
 */
async function focusAndEmpty(tabId, ref) {
  if (!ref) return "";
  await click(tabId, ref);
  const node = resolveRef(tabId, ref);
  if ((await readNodeValue(tabId, node)) === "") return "";

  await clearField(tabId, "Delete");
  await sleep(between(PACE.clearGapMs));
  let left = await readNodeValue(tabId, node);
  if (left?.trim()) {
    // The select-all went somewhere else — the click focused a wrapper or an
    // overlay rather than the input itself. Focus the input directly, with
    // no page script, and delete again.
    try {
      await send(tabId, "DOM.focus", { backendNodeId: node });
      await clearField(tabId, "Delete");
      await sleep(between(PACE.clearGapMs));
      left = await readNodeValue(tabId, node);
    } catch {
      // Not focusable. `left` still says what is there.
    }
  }
  // An emptied rich-text editor still reads as a bare line break.
  return left?.trim() ? left : "";
}

export async function typeText(tabId, ref, text, { submit = false } = {}) {
  const leftover = await focusAndEmpty(tabId, ref);

  await sleep(between(PACE.focusToTypeMs));

  for (const ch of text) {
    await typeChar(tabId, ch);
    // Lognormal-ish inter-key gap, longer at word and sentence boundaries.
    const [lo, hi] = PACE.keyGapMs;
    let d = Math.exp(rand(Math.log(lo), Math.log(hi)));
    if (/[ .,;:!?\n]/.test(ch)) d *= between(PACE.wordGapFactor);
    await sleep(d);
  }

  if (submit) {
    await sleep(between(PACE.beforeSubmitMs));
    await pressKey(tabId, "Enter");
  }
  return { typed: text.length, submitted: submit, ...(leftover && { leftover }) };
}

/**
 * Put text into a field in one go, the way pasting does.
 *
 * Input.insertText goes through the browser's real editing pipeline, so the
 * page gets trusted beforeinput and input events and framework-controlled
 * inputs (React, Vue) register the change. It fires no per-character key
 * events — which is also true of a real paste, and is exactly why sites that
 * validate on keystrokes need `typeText` instead.
 *
 * It deliberately does not use the system clipboard. A real Cmd+V would mean
 * overwriting whatever the user last copied, in the middle of their own work
 * in another app, on every field the agent fills.
 */
export async function pasteText(tabId, ref, text, { submit = false } = {}) {
  const leftover = await focusAndEmpty(tabId, ref);

  await sleep(between(PACE.beforePasteMs)); // a hand reaching for the paste shortcut
  await insertText(tabId, text);
  // Let the page's input handlers run and any reformatting settle before
  // reading the value back. With no ref there is nothing to read it from.
  let value = null;
  if (ref) {
    await sleep(between(PACE.afterPasteMs));
    value = await readNodeValue(tabId, resolveRef(tabId, ref));
  }

  if (submit) {
    await sleep(between(PACE.beforeSubmitMs));
    await pressKey(tabId, "Enter");
  }
  return { pasted: text.length, submitted: submit, value, ...(leftover && { leftover }) };
}

export async function selectOption(tabId, ref, value) {
  // Native <select> popups do not respond to synthetic mouse input
  // consistently across platforms, so drive by keyboard after focusing.
  await click(tabId, ref);
  await sleep(between(PACE.selectGapMs));
  for (const ch of value.slice(0, 1)) await typeChar(tabId, ch);
  await sleep(between(PACE.selectGapMs));
  await pressKey(tabId, "Enter");
  return { selected: value };
}
