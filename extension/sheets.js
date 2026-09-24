// Google Sheets.
//
// Sheets draws its grid on a canvas. The accessibility tree has the toolbar,
// the menus and the sheet tabs — and not one cell — so a snapshot shows the
// model everything except the thing it came to work on, and no ref can
// point at a cell. This module gives it the grid another way:
//
// - Reading: the sheet's own CSV export, fetched with the user's existing
//   Google login. Exact displayed values, no pixels involved.
// - Moving: the Name box, the field left of the formula bar that takes a
//   cell or range ("B7", "A1:C5", "Sheet2!B2") and selects it.
// - Writing: from a selected cell, keystrokes — the first character as a
//   real key press, which opens the cell for editing, the rest inserted in
//   one go, Tab to the next cell. Then the block is read back and compared,
//   so the model learns about anything Sheets changed (autocomplete, a
//   value it reformatted) instead of assuming.

import { send } from "./cdp.js";
import * as input from "./input.js";
import { waitForIdle } from "./nav.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Accounts after the first are /u/1/, /u/2/…; the export has to go through
// the same one or it is asked of an account that may not have access.
const SHEET_URL = /^https:\/\/docs\.google\.com\/spreadsheets(\/u\/\d+)?\/d\/([a-zA-Z0-9_-]+)/;

/** The spreadsheet a URL is on — { base, id, gid } — or null when it is not a Google Sheet. */
export function sheetOf(url) {
  const m = SHEET_URL.exec(url ?? "");
  if (!m) return null;
  return {
    base: `https://docs.google.com/spreadsheets${m[1] ?? ""}/d/${m[2]}`,
    id: m[2],
    gid: /[#&?]gid=(\d+)/.exec(url)?.[1] ?? null,
  };
}

// ── A1 notation ─────────────────────────────────────────────────────────────

export function colIndex(letters) {
  let n = 0;
  for (const c of letters.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

export function colName(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

const CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;
const EXAMPLES = 'e.g. "B2", "A1:D20", or "Sheet2!A1:D20"';

/** "'My sheet'!B3" → { sheet, rest }. */
function splitSheet(ref) {
  const s = String(ref ?? "").trim();
  const bang = s.lastIndexOf("!");
  if (bang === -1) return { sheet: null, rest: s };
  let sheet = s.slice(0, bang).trim();
  if (sheet.startsWith("'") && sheet.endsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
  return { sheet: sheet || null, rest: s.slice(bang + 1).trim() };
}

function parseA1(text, whole) {
  const m = CELL.exec(text);
  if (!m || Number(m[2]) < 1) throw new Error(`"${whole}" is not a cell reference — ${EXAMPLES}`);
  return { col: colIndex(m[1]), row: Number(m[2]) - 1 };
}

/** "Sheet2!B3" → { sheet: "Sheet2", col: 1, row: 2 }. */
export function parseCell(ref) {
  const { sheet, rest } = splitSheet(ref);
  return { sheet, ...parseA1(rest, ref) };
}

/** "A1:C5", "Sheet2!B2", "B2:B" is not accepted — both corners are needed. */
export function parseRange(ref) {
  const { sheet, rest } = splitSheet(ref);
  const [a, b = a] = rest.split(":");
  const p = parseA1(a, ref);
  const q = parseA1(b, ref);
  return {
    sheet,
    start: { col: Math.min(p.col, q.col), row: Math.min(p.row, q.row) },
    end: { col: Math.max(p.col, q.col), row: Math.max(p.row, q.row) },
  };
}

function quoteSheet(name) {
  return /^[A-Za-z0-9_]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

export function cellName({ col, row }, sheet = null) {
  return `${sheet ? `${quoteSheet(sheet)}!` : ""}${colName(col)}${row + 1}`;
}

function rangeName(start, end) {
  return `${cellName(start)}:${cellName(end)}`;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** RFC 4180: quoted fields may hold commas, quotes ("") and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Drop empty rows and columns off the bottom and right; the origin stays put. */
function trimGrid(rows) {
  const out = rows.map((r) => [...r]);
  while (out.length && out[out.length - 1].every((v) => v === "")) out.pop();
  const width = Math.max(0, ...out.map((r) => {
    let w = r.length;
    while (w > 0 && r[w - 1] === "") w--;
    return w;
  }));
  return out.map((r) => r.slice(0, width));
}

const CELL_CHARS = 40;

function clipCell(v) {
  const flat = v.replace(/\r?\n/g, "⏎").replace(/\|/g, "\\|");
  return flat.length > CELL_CHARS ? `${flat.slice(0, CELL_CHARS)}…` : flat;
}

/**
 * The grid as a compact table with its real column letters and row
 * numbers, so the model can name any cell it sees:
 *
 *      | A     | B
 *    1 | Name  | Price
 */
export function renderGrid(rows, origin = { col: 0, row: 0 }) {
  if (rows.length === 0) return "(empty)";
  const width = Math.max(...rows.map((r) => r.length));
  const numWidth = String(origin.row + rows.length).length;
  const cols = Array.from({ length: width }, (_, i) => colName(origin.col + i));
  const lines = [`${" ".repeat(numWidth)} | ${cols.join(" | ")}`];
  rows.forEach((r, i) => {
    const cells = Array.from({ length: width }, (_, j) => clipCell(r[j] ?? ""));
    lines.push(`${String(origin.row + i + 1).padStart(numWidth)} | ${cells.join(" | ")}`.trimEnd());
  });
  return lines.join("\n");
}

// ── reading ─────────────────────────────────────────────────────────────────

const isCsv = (type) => /text\/(csv|plain)/i.test(type ?? "");

/**
 * GET a CSV with the user's Google login. The service worker's own fetch
 * carries the cookies for a site the extension has host access to; failing
 * that, the page fetches it itself, same-origin. A login page or an error
 * comes back as HTML, which is not taken for data.
 */
async function fetchCsv(tabId, url) {
  const why = [];
  try {
    const res = await fetch(url, { credentials: "include" });
    const type = res.headers.get("content-type");
    if (res.ok && isCsv(type)) return await res.text();
    why.push(`extension fetch: ${res.status} ${type?.split(";")[0] ?? ""}`.trim());
  } catch (err) {
    why.push(`extension fetch: ${err?.message ?? err}`);
  }
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (u) => {
        try {
          const r = await fetch(u, { credentials: "include" });
          return { ok: r.ok, status: r.status, type: r.headers.get("content-type"), text: await r.text() };
        } catch (e) {
          return { error: String(e) };
        }
      },
      args: [url],
    });
    if (result?.ok && isCsv(result.type)) return result.text;
    why.push(`page fetch: ${result?.error ?? `${result?.status} ${result?.type?.split(";")[0] ?? ""}`.trim()}`);
  } catch (err) {
    why.push(`page fetch: ${err?.message ?? err}`);
  }
  throw new Error(why.join("; "));
}

const READ_ROWS = 100;
const READ_COLS = 26;

/**
 * Cells of the sheet open in the tab: `range` in A1 notation, or from A1 to
 * the last filled cell. Returns the trimmed grid, where it starts, and the
 * rendered table.
 */
export async function readRange(tabId, { range, maxRows = READ_ROWS, maxCols = READ_COLS } = {}) {
  const tab = await chrome.tabs.get(tabId);
  const sheet = sheetOf(tab.url);
  if (!sheet) throw new Error("this tab is not a Google Sheet");
  const r = range ? parseRange(range) : null;
  const a1 = r ? rangeName(r.start, r.end) : null;

  // The export is exact; the gviz endpoint is the fallback (it guesses a
  // type per column and can blank out values that do not fit it). Only
  // gviz takes a sheet by name — the export wants the gid.
  const urls = [];
  const q = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
  if (r?.sheet) {
    urls.push(`${sheet.base}/gviz/tq?${q({ tqx: "out:csv", headers: "0", sheet: r.sheet, range: a1 })}`);
  } else {
    urls.push(`${sheet.base}/export?${q({ format: "csv", gid: sheet.gid, range: a1 })}`);
    urls.push(`${sheet.base}/gviz/tq?${q({ tqx: "out:csv", headers: "0", gid: sheet.gid, range: a1 })}`);
  }

  let csv = null;
  const why = [];
  for (const url of urls) {
    try {
      csv = await fetchCsv(tabId, url);
      break;
    } catch (err) {
      why.push(String(err?.message ?? err));
    }
  }
  if (csv === null) {
    throw new Error(
      `could not read the sheet's cells (${why.join(" | ")}). The account ` +
      `may not have access to export it; check the sheet in the side panel's live view.`,
    );
  }

  const all = trimGrid(parseCsv(csv));
  const rows = all.slice(0, maxRows).map((row) => row.slice(0, maxCols));
  const origin = r ? r.start : { col: 0, row: 0 };
  const notes = [];
  if (all.length > maxRows) {
    notes.push(`… ${all.length - maxRows} more rows, down to row ${origin.row + all.length}`);
  }
  const widest = Math.max(0, ...all.map((row) => row.length));
  if (widest > maxCols) {
    notes.push(`… more columns, out to ${colName(origin.col + widest - 1)}`);
  }
  if (notes.length) notes.push("Pass a range to read those.");
  return {
    origin,
    rows,
    text: renderGrid(rows, origin) + (notes.length ? `\n${notes.join("\n")}` : ""),
  };
}

// ── the Name box ────────────────────────────────────────────────────────────

/** The Name box's backend node id. Its element id has held for years; its label is localized. */
async function findNameBox(tabId) {
  try {
    const { root } = await send(tabId, "DOM.getDocument", { depth: 0 });
    const { nodeId } = await send(tabId, "DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "#t-name-box",
    });
    if (nodeId) {
      const { node } = await send(tabId, "DOM.describeNode", { nodeId });
      return node.backendNodeId;
    }
  } catch {
    // Fall through to looking it up by name.
  }
  const { nodes } = await send(tabId, "Accessibility.getFullAXTree");
  const hit = nodes.find(
    (n) =>
      !n.ignored &&
      ["textbox", "combobox"].includes(n.role?.value) &&
      /^name box/i.test(String(n.name?.value ?? "")),
  );
  if (hit?.backendDOMNodeId !== undefined) return hit.backendDOMNodeId;
  throw new Error(
    "could not find the sheet's Name box (the field left of the formula bar). " +
    "The sheet may still be loading — wait_for_idle, then try again.",
  );
}

/** What the Name box shows: the selected cell or range, e.g. "B3" or "A1:C5". */
export async function selection(tabId) {
  try {
    return await input.readNodeValue(tabId, await findNameBox(tabId));
  } catch {
    return null;
  }
}

// "Sheet2!$b$2:b2" → "B2": how the Name box shows a selection.
const bare = (ref) => {
  const [a, b] = splitSheet(ref).rest.replace(/\$/g, "").toUpperCase().split(":");
  return b && b !== a ? `${a}:${b}` : a;
};

/**
 * Select a cell or range through the Name box. Keyboard focus lands on the
 * grid, so a key press or a typed value goes to the selection.
 */
export async function gotoCell(tabId, target, box = null) {
  box ??= await findNameBox(tabId);
  await input.clickNode(tabId, box, { what: "the Name box" });
  await input.clearField(tabId);
  await input.insertText(tabId, target);
  await input.pressKey(tabId, "Enter");
  await sleep(80);
  const shown = await input.readNodeValue(tabId, box);
  // A range the sheet has a name for shows as that name; anything else
  // unexpected means the jump did not happen.
  if (shown && CELL.test(bare(target).split(":")[0]) && bare(shown) !== bare(target)) {
    throw new Error(
      `the Name box did not go to "${target}" — it shows "${shown}". Check the ` +
      `reference (${EXAMPLES}); a sheet name with spaces needs quotes, 'Q1 data'!A1.`,
    );
  }
  return { selected: shown ?? bare(target) };
}

// ── writing ─────────────────────────────────────────────────────────────────

const isSkip = (v) => v === null || v === undefined || v === "";

/** Type one value into the selected cell. The first key opens the cell for editing, replacing what was there. */
async function enterValue(tabId, value) {
  const lines = String(value).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // A line break inside a cell; a bare Enter would commit it instead.
    if (i > 0) await input.pressKey(tabId, "Alt+Enter");
    const line = lines[i];
    if (!line) continue;
    if (i === 0) {
      const [first, ...rest] = [...line];
      await input.typeChar(tabId, first);
      if (rest.length) {
        // Sheets opens its cell editor on that key; give focus a beat to land there.
        await sleep(30);
        await input.insertText(tabId, rest.join(""));
      }
    } else {
      await input.insertText(tabId, line);
    }
  }
}

/** Numbers compare as numbers, so "1.50" = "1.5" and "1,000" = "1000". */
function sameValue(wrote, shows) {
  const a = wrote.trim();
  const b = shows.trim();
  if (a === b) return true;
  const num = (s) => (/^[-+]?[$€£]?[\d,]*\.?\d+%?$/.test(s) ? Number(s.replace(/[$€£,%]/g, "")) : NaN);
  return !Number.isNaN(num(a)) && num(a) === num(b);
}

const MAX_MISMATCHES = 20;

/**
 * Write a block of values starting at `start` (e.g. "B2" or "Sheet2!B2").
 * `rows` is a list of rows, each a list of values; "" or null leaves that
 * cell as it is. Values starting with "=" go in as formulas.
 */
export async function writeCells(tabId, { start, rows }) {
  const origin = parseCell(start);
  const grid = (Array.isArray(rows) ? rows : []).map((r) => (Array.isArray(r) ? r : [r]));
  const box = await findNameBox(tabId);
  let written = 0;
  let sheetPending = origin.sheet;
  // Where the cursor is, as the Name box last showed it.
  let at = null;

  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    let last = row.length - 1;
    while (last >= 0 && isSkip(row[last])) last--;
    if (last < 0) continue;
    // Enter after a run of Tabs brings Sheets back to the column the run
    // started in, so the cursor is usually already at this row's start. The
    // Name box says whether it is; when it is not, jump there through it.
    const rowStart = cellName({ col: origin.col, row: origin.row + i });
    if (sheetPending || at !== rowStart) {
      await gotoCell(tabId, cellName({ col: origin.col, row: origin.row + i }, sheetPending), box);
      sheetPending = null;
    }
    for (let j = 0; j <= last; j++) {
      if (!isSkip(row[j])) {
        await enterValue(tabId, row[j]);
        written++;
      }
      await input.pressKey(tabId, j < last ? "Tab" : "Enter");
    }
    const shown = await input.readNodeValue(tabId, box);
    at = shown ? bare(shown) : null;
  }

  const width = Math.max(1, ...grid.map((r) => r.length));
  const end = { col: origin.col + width - 1, row: origin.row + Math.max(grid.length, 1) - 1 };
  const range = rangeName(origin, end);
  const result = { written, range: origin.sheet ? `${quoteSheet(origin.sheet)}!${range}` : range };
  if (written === 0) return result;

  // Sheets saves over XHR; reading back before it has would compare against
  // the old values.
  await waitForIdle(tabId, { timeoutMs: 6000, quietMs: 500 });
  try {
    let mismatches = await compare(tabId, origin, end, grid);
    if (mismatches.length) {
      // One more look before reporting: the save may simply not have landed.
      await sleep(1500);
      mismatches = await compare(tabId, origin, end, grid);
    }
    return { ...result, verified: mismatches.length === 0, mismatches };
  } catch (err) {
    return { ...result, verified: false, verifyError: String(err?.message ?? err) };
  }
}

async function compare(tabId, origin, end, grid) {
  // The tab's own URL carries the gid once a sheet-qualified jump switched
  // to that sheet, so the read-back needs no sheet name.
  const { rows } = await readRange(tabId, {
    range: rangeName(origin, end),
    maxRows: grid.length,
    maxCols: end.col - origin.col + 1,
  });
  const out = [];
  grid.forEach((row, i) => {
    row.forEach((v, j) => {
      if (isSkip(v)) return;
      const wrote = String(v);
      // A formula reads back as its result, which is not comparable.
      if (wrote.trimStart().startsWith("=")) return;
      const shows = rows[i]?.[j] ?? "";
      if (!sameValue(wrote, shows)) {
        out.push({ cell: cellName({ col: origin.col + j, row: origin.row + i }), wrote, shows });
      }
    });
  });
  return out.slice(0, MAX_MISMATCHES);
}

// ── snapshot header ─────────────────────────────────────────────────────────

const PREVIEW = "A1:J20";

/**
 * Lines that go at the top of a snapshot of a Sheet: that the cells are not
 * in the tree, which tools reach them, what is selected, and the top-left
 * of the grid itself — the view of the cells a snapshot cannot give.
 */
export async function sheetHeader(tabId) {
  const lines = [
    "# Google Sheets: the grid is drawn on a canvas, so no cell appears in the list below —",
    "# only the toolbar, menus and sheet tabs. Read cells with sheet_read, enter them with",
    "# sheet_write, select a cell or range with sheet_select. Never click on the grid.",
  ];
  const selected = await selection(tabId);
  if (selected) lines.push(`# Selected: ${selected}`);
  try {
    const { rows, text } = await readRange(tabId, { range: PREVIEW });
    lines.push(
      rows.length
        ? `# Cells ${PREVIEW} (sheet_read for more):\n${text}`
        : `# ${PREVIEW} is empty. Use sheet_read with a range to look elsewhere.`,
    );
  } catch (err) {
    lines.push(`# Could not read the cells: ${err?.message ?? err}`);
  }
  return lines.join("\n");
}
