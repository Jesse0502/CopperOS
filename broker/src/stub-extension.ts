// Dev harness: pretends to be the extension so the broker and agent loop can
// be exercised without Chrome. Serves canned pages.
//
//   npx tsx src/stub-extension.ts
//
// Run it alongside the broker, then send a task from the CLI or popup.

import { readFileSync } from "node:fs";
import { WebSocket } from "ws";

// Vision escalation is the one path that differs most between providers, so it
// needs to be exercisable without Chrome:
//   STUB_WEAK=1 STUB_SHOT=/path/to.jpg npx tsx src/stub-extension.ts "..."
const WEAK = process.env.STUB_WEAK ? "82% of interactive elements unlabeled" : null;
const SHOT = process.env.STUB_SHOT
  ? readFileSync(process.env.STUB_SHOT).toString("base64")
  : "";

const PAGE = `# Example Domain
# https://example.com/
  heading "Example Domain" level=1
  StaticText "This domain is for use in illustrative examples in documents."
  [e1] link "More information..."
  [e2] textbox "Search" value=""
  [e3] button "Go"`;

// The page the agent lands on when a click opens a new tab. Set
// STUB_NEW_TAB=<ref> to make that ref behave like Indeed's "Apply now".
const NEW_TAB_PAGE = `# Application form
# https://example.com/apply
  heading "Application form" level=1
  StaticText "Step 1 of 2 — upload your resume."
  [e1] button "Upload resume"
  [e2] button "Submit application"`;

// STUB_FORM=1 serves a job application form instead, for exercising paste.
// STUB_PASTE_REJECT=<ref> makes that one field ignore pasted text, the way
// keystroke-only inputs do, so the fall-back to `type` can be tested.
const FORM = Boolean(process.env.STUB_FORM);
const FORM_FIELDS: Array<[string, string]> = [
  ["e1", "Full name"], ["e2", "Email"], ["e3", "Phone"], ["e4", "Cover letter"],
];
// Snapshots must show what was entered, or every check the model makes finds
// the fields still empty and it fills them again forever.
const formValues: Record<string, string> = {};
const renderForm = () =>
  "# Job application\n# https://example.com/apply\n" +
  '  heading "Apply: Senior Designer" level=1\n' +
  FORM_FIELDS.map(
    ([ref, label]) => `  [${ref}] textbox "${label}" value=${JSON.stringify(formValues[ref] ?? "")}`,
  ).join("\n") +
  '\n  [e5] button "Submit application"';
const enter = (ref: string, text: string, clear?: boolean) => {
  formValues[ref] = clear ? text : (formValues[ref] ?? "") + text;
};
const PASTE_REJECT = process.env.STUB_PASTE_REJECT ?? null;

const NEW_TAB_REF = process.env.STUB_NEW_TAB ?? null;
let page = PAGE;
let refs = FORM ? ["e1", "e2", "e3", "e4", "e5"] : ["e1", "e2", "e3"];

const OPS: Record<string, (p: any) => unknown> = {
  list_tabs: () => [
    { tabId: 1, title: "Example Domain", url: "https://example.com/", active: true, openedByYou: false, controlling: true },
  ],
  close_tab: ({ tabId }: any) => {
    if (tabId === 1 || tabId === undefined) {
      throw new Error("tab 1 was not opened by you — it is the user's, so it stays open");
    }
    return { closed: tabId };
  },
  snapshot: () => ({
    text: FORM ? renderForm() : page, weak: WEAK, interactiveCount: refs.length, generation: 1,
  }),
  read_page: () => ({ text: "Example Domain\n\nThis domain is for use in illustrative examples." }),
  click: ({ ref }: any) => {
    if (!refs.includes(ref)) {
      throw new Error(`stale or unknown ref "${ref}" — call snapshot again`);
    }
    if (NEW_TAB_REF && ref === NEW_TAB_REF && page === PAGE) {
      page = NEW_TAB_PAGE;
      refs = ["e1", "e2"];
      return {
        clickedAt: { x: 120, y: 240 },
        followedNewTab: {
          tabId: 2, url: "https://example.com/apply", title: "Application form",
        },
      };
    }
    return { clickedAt: { x: 120, y: 240 } };
  },
  type: ({ ref, text, clear }: any) => {
    if (FORM) enter(ref, text, clear);
    return { typed: text.length, submitted: false };
  },
  paste: ({ ref, text, clear }: any) => {
    if (!refs.includes(ref)) {
      throw new Error(`stale or unknown ref "${ref}" — call snapshot again`);
    }
    const rejected = ref === PASTE_REJECT;
    if (clear) formValues[ref] = "";
    if (!rejected) enter(ref, text, clear);
    return {
      pasted: text.length,
      submitted: false,
      value: formValues[ref] ?? "",
    };
  },
  scroll: () => ({ scrolled: 600 }),
  navigate: ({ url }: any) => ({ url, title: "Example Domain", idle: true }),
  wait_for_idle: () => ({ idle: true, timedOut: false }),
  press_key: ({ key }: any) => ({ pressed: key }),
  hover: () => ({ hoveredAt: { x: 100, y: 100 } }),
  badged_screenshot: () => ({ data: SHOT, badged: SHOT ? 3 : 0 }),
};

const PORT = Number(process.env.PORT ?? 7331);
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

// The broker accepts one client at a time, so the stub sends its own task
// rather than you opening a second socket (which would supersede it).
const task = process.argv.slice(2).join(" ").trim();

ws.on("open", () => {
  console.log("[stub] connected to broker");
  ws.send(JSON.stringify({ type: "hello", client: "stub" }));
  if (task) {
    console.log(`[stub] sending task: ${task}`);
    ws.send(JSON.stringify({ type: "task", text: task }));
  }
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === "agent_event") {
    console.log(`[stub] event ${msg.event}: ${(msg.text ?? "").slice(0, 120)}`);
    // Auto-approve so unattended runs do not hang on the gate. STUB_NO_APPROVE
    // simulates the popup being closed: the prompt is never answered, which is
    // exactly the case that used to be misreported to the model as a refusal.
    if (msg.event === "approval_request" && !process.env.STUB_NO_APPROVE) {
      ws.send(JSON.stringify({ type: "approval", id: msg.id, approved: true }));
    }
    return;
  }
  if (msg.type === "pong") return;
  if (!msg.op) return;

  console.log(`[stub] op ${msg.op} ${JSON.stringify(msg.params ?? {})}`);
  try {
    const data = OPS[msg.op]?.(msg.params ?? {});
    if (data === undefined) throw new Error(`stub has no op "${msg.op}"`);
    ws.send(JSON.stringify({ id: msg.id, ok: true, data }));
  } catch (err) {
    ws.send(JSON.stringify({ id: msg.id, ok: false, error: String((err as Error).message) }));
  }
});

ws.on("close", () => {
  console.log("[stub] disconnected");
  process.exit(0);
});
