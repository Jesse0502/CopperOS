// What comes with a task besides its words: the tab it starts on, and the
// rules the user set for the supervisor before sending it. Both ride on the
// task's own message in the transcript, after the user's words, so the model
// reads them with the task; replay() takes them back off, so the chat shows
// only what the user typed.

export type TabInfo = { url: string; title: string };
export type TaskExtras = { tab?: TabInfo | null; rules?: string };

const TITLE_CAP = 150;
const URL_CAP = 500;
const RULES_CAP = 2000;

const TAB_OPEN = "\n\n[Current tab";
const RULES_OPEN = "\n\n[Supervisor rules the user set for this task";
const RULES_TAG = /<rules>\n([\s\S]*?)\n<\/rules>/;

/** A task message's extras as sent by the extension, cleaned up; anything malformed is dropped. */
export function taskExtras(msg: { tab?: unknown; rules?: unknown }): TaskExtras {
  const out: TaskExtras = {};
  const tab = msg.tab as Partial<TabInfo> | null | undefined;
  if (tab && typeof tab === "object" && typeof tab.url === "string") {
    out.tab = {
      url: tab.url.slice(0, URL_CAP),
      title: typeof tab.title === "string" ? tab.title.slice(0, TITLE_CAP) : "",
    };
  }
  if (typeof msg.rules === "string" && msg.rules.trim()) {
    out.rules = msg.rules.trim().slice(0, RULES_CAP);
  }
  return out;
}

function tabNote(tab: TabInfo): string {
  let web = false;
  try {
    web = /^https?:$/.test(new URL(tab.url).protocol);
  } catch {
    // No URL yet (a tab still loading): say what is known.
  }
  if (web) {
    const title = tab.title ? `"${tab.title.replace(/"/g, "'")}" — ` : "";
    return `${TAB_OPEN}, where this task starts and what "this page" means: ${title}${tab.url}]`;
  }
  const what = tab.url.startsWith("chrome://newtab") || !tab.url ? "a new tab page" : `a browser page (${tab.url})`;
  return (
    `${TAB_OPEN}, where this task starts: ${what}, which no tool can read or act on. ` +
    `Open or navigate to a website to begin.]`
  );
}

/** The task's message for the transcript: the user's words, then its extras. */
export function taskMessage(text: string, extras: TaskExtras = {}): string {
  let out = text;
  if (extras.rules) {
    out +=
      `${RULES_OPEN}. The supervisor holds you to them at every check-in, ` +
      `as firmly as the task itself:\n<rules>\n${extras.rules}\n</rules>]`;
  }
  if (extras.tab) out += tabNote(extras.tab);
  return out;
}

/** A task message split back into what the user typed and the rules they set, if any. */
export function splitTaskMessage(content: string): { text: string; rules: string | null } {
  const cuts = [content.indexOf(RULES_OPEN), content.indexOf(TAB_OPEN)].filter((i) => i !== -1);
  if (!cuts.length) return { text: content, rules: null };
  const rules = content.match(RULES_TAG)?.[1] ?? null;
  return { text: content.slice(0, Math.min(...cuts)), rules };
}
