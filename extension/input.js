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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export async function boxForRef(tabId, ref) {
  const backendNodeId = resolveRef(ref);
  try {
    await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    // Non-fatal: element may already be in view or be a zero-box container.
  }
  const { model } = await send(tabId, "DOM.getBoxModel", { backendNodeId });
  const [x1, y1, x2, , , y3] = model.content;
  if (x2 - x1 <= 0 || y3 - y1 <= 0) {
    throw new Error(`ref "${ref}" has no visible box — it may be hidden or collapsed`);
  }
  return { x1, y1, x2, y2: y3, cx: (x1 + x2) / 2, cy: (y1 + y3) / 2 };
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
  const steps = Math.max(10, Math.min(55, Math.round(dist / 9)));

  const path = humanPath(cursor.x, cursor.y, x, y, steps);
  // Delays are drawn up front so the overlay can replay the same path on the
  // same timing from a single message, instead of one message per step.
  const delays = path.map(() => rand(4, 13));
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

export async function click(tabId, ref, { button = "left", clickCount = 1 } = {}) {
  const box = await boxForRef(tabId, ref);
  // Aim near-center but not dead-center.
  const jx = Math.min((box.x2 - box.x1) / 4, 6);
  const jy = Math.min((box.y2 - box.y1) / 4, 6);
  const x = box.cx + rand(-jx, jx);
  const y = box.cy + rand(-jy, jy);

  await moveTo(tabId, x, y);
  await sleep(rand(40, 160)); // dwell before committing

  const base = { x, y, button, clickCount, buttons: button === "left" ? 1 : 2 };
  notify({ type: "press", tabId, x: Math.round(x), y: Math.round(y) });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await sleep(rand(45, 125)); // press duration
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  return { clickedAt: { x: Math.round(x), y: Math.round(y) } };
}

export async function hover(tabId, ref) {
  const box = await boxForRef(tabId, ref);
  await moveTo(tabId, box.cx, box.cy);
  await sleep(rand(120, 350));
  return { hoveredAt: { x: Math.round(box.cx), y: Math.round(box.cy) } };
}

export async function scroll(tabId, { direction = "down", amount = 600 } = {}) {
  const st = stateFor(tabId);
  const sign = direction === "up" ? -1 : 1;
  const remaining = Math.abs(amount);
  let done = 0;

  while (done < remaining) {
    const step = Math.min(rand(90, 150), remaining - done);
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: st.cursor.x || 400,
      y: st.cursor.y || 400,
      deltaX: 0,
      deltaY: sign * step,
    });
    done += step;
    await sleep(rand(28, 105));
  }
  await sleep(rand(200, 650)); // settle time after a scroll
  return { scrolled: sign * Math.round(done) };
}

// ── keyboard ────────────────────────────────────────────────────────────────

const KEYS = {
  Enter:      { keyCode: 13, code: "Enter",      text: "\r" },
  Tab:        { keyCode: 9,  code: "Tab",        text: "\t" },
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

export async function pressKey(tabId, key) {
  const def = KEYS[key];
  if (!def) {
    throw new Error(`unsupported key "${key}" (have: ${Object.keys(KEYS).join(", ")})`);
  }
  const common = {
    key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
  };
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...common, text: def.text });
  await sleep(rand(35, 95));
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...common });
  return { pressed: key };
}

async function typeChar(tabId, ch) {
  const code = ch.toUpperCase().charCodeAt(0);
  const common = { key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: code };
  // keyDown carrying `text` produces the keydown + char pair a real key emits.
  // Input.insertText would be faster but fires no key events at all, which
  // breaks framework onKeyDown handlers and field validation.
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...common });
  await send(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", key: ch, windowsVirtualKeyCode: code,
  });
}

// CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8.
const SHORTCUT_MOD = /Mac/i.test(navigator.userAgent) ? 4 : 2;

async function clearField(tabId) {
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
  await sleep(rand(50, 120));
  await pressKey(tabId, "Backspace");
}

/**
 * The field's current value, read from the accessibility tree the same way a
 * snapshot reads it. Null when the field does not expose one — rich-text
 * editors, and password inputs, whose value the tree deliberately withholds.
 */
async function readFieldValue(tabId, ref) {
  try {
    const { nodes } = await send(tabId, "Accessibility.getPartialAXTree", {
      backendNodeId: resolveRef(ref),
      fetchRelatives: false,
    });
    const v = nodes?.[0]?.value?.value;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function typeText(tabId, ref, text, { submit = false, clear = false } = {}) {
  await click(tabId, ref); // focus the field by clicking it

  if (clear) await clearField(tabId);

  await sleep(rand(120, 300)); // gap between focus and first keystroke

  for (const ch of text) {
    await typeChar(tabId, ch);
    // Lognormal-ish inter-key gap, longer at word and sentence boundaries.
    let d = Math.exp(rand(Math.log(55), Math.log(185)));
    if (/[ .,;:!?\n]/.test(ch)) d *= rand(1.4, 2.8);
    await sleep(d);
  }

  if (submit) {
    await sleep(rand(200, 500));
    await pressKey(tabId, "Enter");
  }
  return { typed: text.length, submitted: submit };
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
export async function pasteText(tabId, ref, text, { submit = false, clear = false } = {}) {
  await click(tabId, ref); // focus, exactly as typing does

  if (clear) await clearField(tabId);

  await sleep(rand(150, 400)); // a hand reaching for the paste shortcut
  await send(tabId, "Input.insertText", { text });
  // Let the page's input handlers run and any reformatting settle before
  // reading the value back.
  await sleep(rand(80, 160));
  const value = await readFieldValue(tabId, ref);

  if (submit) {
    await sleep(rand(200, 500));
    await pressKey(tabId, "Enter");
  }
  return { pasted: text.length, submitted: submit, value };
}

export async function selectOption(tabId, ref, value) {
  // Native <select> popups do not respond to synthetic mouse input
  // consistently across platforms, so drive by keyboard after focusing.
  await click(tabId, ref);
  await sleep(rand(150, 350));
  for (const ch of value.slice(0, 1)) await typeChar(tabId, ch);
  await sleep(rand(150, 300));
  await pressKey(tabId, "Enter");
  return { selected: value };
}
