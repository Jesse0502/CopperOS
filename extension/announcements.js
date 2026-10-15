// What is new in CopperOS, shown in the panel as one large dialog from a small file on the website
// (website/announcements.json), so a feature that needs no new version of the extension can be
// announced the day it ships, and a new version can announce itself to the people who have it.
// An entry is a title, a lead, up to five points, a picture from the website, and a button; it shows
// once. Only text, https links and pictures from copper.jassydev.com are ever shown from it. The panel
// asks for the file at most every six hours, sends nothing about the person, and shows nothing if it
// cannot be reached. It is not shown to someone who installed after it was published: it is news
// about a change, and they never saw the old way.

export const NEWS_URL = "https://copper.jassydev.com/announcements.json";
export const REFETCH_MS = 6 * 60 * 60 * 1000;

const ID_MAX = 80;
const TAG_MAX = 24;
const LABEL_MAX = 32;
const TITLE_MAX = 80;
const LEAD_MAX = 300;
const POINT_MAX = 140;
const POINTS_MAX = 5;
// Pictures come from the website only: a list that can name any address could track the person.
const IMAGE_ORIGIN = "https://copper.jassydev.com/";
const VERSION = /^\d+(\.\d+){0,3}$/;

function parts(v) {
  return String(v ?? "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

/** -1, 0 or 1: whether version a is lower than, the same as, or higher than version b. */
export function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const isHttps = (u) => {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * A date as a time. A bare date (2026-11-16) is that day in the reader's own time zone, so an
 * announcement dated for a day starts and ends with that day wherever the reader is; `end` gives
 * the moment the day is over. Anything with a time on it is taken as written.
 */
function time(s, end = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return Date.parse(s);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (end ? 1 : 0)).getTime();
}

const words = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** One entry of the file made safe to show, or null if it cannot be shown. */
export function clean(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = words(raw.id, ID_MAX);
  const title = words(raw.title, TITLE_MAX);
  // A title is what makes an entry a dialog; anything else (an old one-line bar, say) is ignored.
  if (!id || !title || (raw.kind !== undefined && raw.kind !== "modal")) return null;
  const out = {
    id,
    title,
    tag: words(raw.tag, TAG_MAX),
    lead: words(raw.lead, LEAD_MAX),
    points: (Array.isArray(raw.points) ? raw.points : []).map((p) => words(p, POINT_MAX)).filter(Boolean).slice(0, POINTS_MAX),
  };
  if (typeof raw.image === "string" && raw.image.startsWith(IMAGE_ORIGIN) && isHttps(raw.image)) out.image = raw.image;
  if (raw.cta && isHttps(raw.cta.url)) out.cta = { url: raw.cta.url, label: words(raw.cta.label, LABEL_MAX) || "Learn more" };
  if (typeof raw.from === "string" && !Number.isNaN(time(raw.from))) out.from = time(raw.from);
  if (typeof raw.until === "string" && !Number.isNaN(time(raw.until))) out.until = time(raw.until, true);
  if (typeof raw.minVersion === "string" && VERSION.test(raw.minVersion)) out.minVersion = raw.minVersion;
  if (typeof raw.maxVersion === "string" && VERSION.test(raw.maxVersion)) out.maxVersion = raw.maxVersion;
  return out;
}

/**
 * The announcement to show now: the first in the list that is within its dates, fits this version of
 * the extension, and has not been closed. The newest goes first in the file. `baseline` is when this
 * copy was installed, if it was a fresh install and not an update: what was published before then is
 * not for them.
 */
export function pick(list, { version, now, dismissed, baseline }) {
  for (const raw of Array.isArray(list) ? list : []) {
    const a = clean(raw);
    if (!a || dismissed.includes(a.id)) continue;
    if (a.from !== undefined && now < a.from) continue;
    if (a.until !== undefined && now >= a.until) continue;
    if (a.minVersion && compareVersions(version, a.minVersion) < 0) continue;
    if (a.maxVersion && compareVersions(version, a.maxVersion) > 0) continue;
    if (baseline !== undefined && (a.from === undefined || a.from <= baseline)) continue;
    return a;
  }
  return null;
}

/**
 * The list from the website, or the last one fetched if it cannot be reached. `store` reads and
 * writes the extension's local storage: { get(key), set(object) }.
 */
export async function fetchNews({ get, set, fetchFn = fetch, now = Date.now() }) {
  const cached = await get("newsCache");
  if (cached && now - cached.at < REFETCH_MS) return cached.list;
  try {
    const res = await fetchFn(NEWS_URL, { cache: "no-cache", signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    const list = Array.isArray(body?.announcements) ? body.announcements.slice(0, 20) : [];
    await set({ newsCache: { at: now, list } });
    return list;
  } catch {
    return cached?.list ?? [];
  }
}
