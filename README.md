<iframe src="https://s3.ap-southeast-2.amazonaws.com/copper.jassydev.com/CopperOS+Product+Demo.mp4" />

**Beta.** Interfaces, config format, and stored-session layout may still
change between versions. See [Known limits](#known-limits) before assuming
something is a bug, and [Contributing](#contributing) if you'd like to help.

Prompt-driven browser agent. You type a task, a local Ollama model drives a real
Chrome tab — in your own profile, with your existing logins.

Perception is accessibility-tree first (cheap, exact), with badged screenshots
escalated automatically only when the tree goes blind. Input goes through CDP
so events are genuinely trusted rather than synthesized in page JS.

```
┌─────────────────────┐   WebSocket    ┌──────────────────────┐
│  broker/  (Node/TS) │◄──────────────►│  extension/  (MV3)   │
│  • Ollama /v1 API   │  {id,op,params}│  • chrome.debugger   │
│  • tool definitions │                │  • ref → coordinates │
│  • agent loop       │  {id,ok,data}  │  • humanized input   │
│  • holds API key    │                │  • AX snapshots      │
└─────────────────────┘                └──────────────────────┘
```

The extension is hands only — it holds no config and makes no decisions. The
broker is brains only — it never sees a pixel coordinate.

The model is reached through Ollama's OpenAI-compatible endpoint (`/v1`) rather
than the native `/api/chat`. The compat layer gives real `tool_call` ids, so
parallel tool calls pair up unambiguously, and it accepts image blocks *inside*
tool-result messages — which the vision escalation depends on.

## Setup

You need Ollama running with a model that has both **tools** and **vision**
capability (`ollama show <model>` lists them):

```bash
ollama serve                  # or just run the desktop app
ollama list                   # what you already have

cd broker
npm install
cp .env.example .env          # set OLLAMA_MODEL to a model from `ollama list`
npm start
```

The broker checks Ollama at startup and warns if it is unreachable or if
`OLLAMA_MODEL` is not installed, rather than failing mid-task.

Then load the extension: `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → select `extension/`.

Open the extension popup. The dot turns green when it finds the broker. Type a
task and hit Run.

CLI alternative:

```bash
npm run task -- "find the pricing page and tell me the cheapest paid tier"
```

## How perception works

`snapshot` returns the accessibility tree as ref-tagged lines:

```
[e11] link "Products"
[e12] textbox "Search" value=""
[e28] button "Sign in"
```

The model acts with `click(ref: "e28")`. The extension resolves the ref to a
`backendNodeId`, gets a live box model, and drives the pointer there. The model
never handles coordinates, so it cannot invent one.

Every snapshot regenerates the ref table. A ref from an older snapshot raises a
`stale ref` error, which is returned to the model as a normal tool result — it
reads it and re-snapshots. That is the intended recovery path, not a failure.

**Vision escalates automatically.** `snapshot` scores the tree and attaches a
badged screenshot when it looks unreliable: `>30%` of interactive elements
unlabeled, a `<canvas>` present, or nothing interactive at all. Badge `N` on
the image is ref `eN` — one vocabulary across both channels. Badges are drawn
on the captured bitmap in an `OffscreenCanvas`, never injected into the page,
so nothing shifts under the click you are about to make.

This is the main cost lever: an accessibility snapshot runs 2–5KB against
100KB+ for a screenshot of the same page.

## Configuration

`broker/.env`:

| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_MODEL` | `minimax-m3:cloud` | Must support tools; vision too, or escalated screenshots are wasted. |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama server. `/v1` is appended. |
| `OLLAMA_NUM_CTX` | `32768` | Context window. Ollama's own default is far too small here — one snapshot can be several thousand tokens. |
| `APPROVAL_MODE` | `submits` | `all` gates every click, `submits` gates form submissions and clicks the model flags `destructive`, `none` gates nothing. |
| `PORT` | `7331` | Broker WebSocket port. Must match `BROKER_URL` in `extension/background.js`. |

No API key is needed for a local model. `OLLAMA_API_KEY` is sent if set, for
remote or cloud-hosted Ollama endpoints that require one.

| `APPROVAL_TIMEOUT_MS` | `900000` | How long a gate waits for a human before giving up. |
| `RECONNECT_GRACE_MS` | `30000` | How long an op waits for the extension to come back before failing. |
| `STORAGE_DIR` | `<repo>/storage` | Where chat transcripts are written. |
| `HISTORY_BUDGET_CHARS` | 60% of `OLLAMA_NUM_CTX` | Transcript size cap before old turns are dropped. |

Approval prompts appear in the popup. Declining returns "user declined" to the
model as a tool result, so it adapts instead of dying.

## The chat is sticky

A task is a turn in an ongoing conversation, not a fresh start, so follow-ups
work: "apply to the first result", then "now do the next one". The transcript
lives on disk under `storage/`, so it survives restarting the broker too.

```
storage/
  sessions/<id>.json   one transcript per chat
  current.json         which one to resume
```

It is written after every step, so an interrupted run still leaves a resumable
chat. **New chat** in the popup abandons the transcript and starts a fresh one.

Three things keep a sticky chat from breaking:

- **Old turns are dropped whole.** `trimTurns` cuts only at user messages.
  Any other boundary can separate an assistant message from the tool results
  its `tool_calls` require, which the API rejects outright.
- **Resumed transcripts are repaired.** A run killed mid-tool-call leaves
  `tool_calls` with no results — invalid on the next request. `sanitize` drops
  orphaned results and rewinds to the last complete turn.
- **Screenshots are not stored.** They are megabytes of base64 whose badge
  numbers refer to refs that died with the page.

On the first task after a resume the model is told the browser may have moved
on, so it re-snapshots instead of trusting refs from a previous session.

## Paste versus type

Forms are filled with `paste`, which puts a value in all at once. `type` keeps
the humanized keystrokes for the fields that need them: search boxes that
suggest as you type, one-box-per-character codes, and masked inputs like phone
numbers and dates.

`paste` uses CDP `Input.insertText`, not the clipboard. It goes through
Chrome's real editing pipeline, so the page gets trusted `beforeinput` and
`input` events and React or Vue controlled inputs see the change. A real Cmd+V
would overwrite whatever you last copied, on every field, while you are working
in another app.

Pasting fails silently on some fields, so after each paste the value is read
back from the accessibility tree. If the field is still empty, or does not
contain the text, the tool result says so and tells the model to use `type`.
The check compares letters and digits only, so a masked input that turns
`5551234567` into `(555) 123-4567` still counts as accepted. Rich-text editors
and password fields expose no value, so for those no check is possible.

Screenshots are checked the same way before they are attached. Every capture is
JPEG, and anything that is not — usually a background tab that was not painting
— becomes a tool error. Sent as-is, Ollama rejects it with a 400 that ends the
run, and a sticky chat would resend it on every retry.

## Clicks that open a new tab

Job boards are the worst case: "Apply now" opens the real form in a new tab,
nothing about the original tab changes, and the button is still sitting in the
next snapshot — so the model clicks it again, and again.

The extension watches `chrome.tabs.onCreated` for tabs whose opener is the
controlled tab, and takes over any that a `click`, `type` or `press_key`
opened. The tool result then says so explicitly: that the action succeeded,
that it must not be repeated, and that earlier refs belong to the old tab.
Following the tab alone is not enough — without being told, the model has no
evidence its click did anything.

Tabs you open by hand are left alone, since their opener is not the agent's
tab. `list_tabs` and `activate_tab` go back.

## Seeing where the agent is

While a run is in progress, the tab CopperOS is driving is marked two ways, both in
the brand purple.

- **A tab group titled "CopperOS"** in Chrome's own tab strip, holding the tab being
  driven and the tabs the agent opened along the way. It lives outside the page,
  which cannot see it. A tab already in one of your own groups is left there.
- **An overlay inside the page** (`extension/overlay.js`): a glowing frame with
  a highlight that travels round the edge, a "CopperOS is working" pill, and a
  cursor labelled CopperOS that follows the agent's real pointer path and marks each
  click with a ring.

Both move with the agent when it switches tabs, redraw after navigations, and
disappear when the run ends.

The overlay is built not to interfere with the page or the agent:

- It is `pointer-events: none`, so it can never take a click.
- It is `aria-hidden`, so it never appears in the accessibility snapshot.
- It is hidden for the moment a screenshot is taken, so the model never tries to
  read or click the frame or the cursor.
- It sits in the extension's isolated world inside a closed shadow root, so page
  scripts and CSS cannot reach into it.
- It renders as a manual popover in the top layer, which is the only way to draw
  above a modal `<dialog>`, and application forms use those a lot.
- The cursor path is sent once per move and replayed in the page on the same
  delays, not once per pointer step.

**The cost.** The overlay's host element is visible in the page's DOM, which a
site checking for automation could notice. The tab group has no such footprint.
Set `PAGE_OVERLAY = false` in `extension/presence.js` to keep the tab group and
drop the overlay.

## The agent's tabs

**There is only ever one CopperOS group.** An existing group is always reused, never
recreated. Duplicates came from Chrome itself: a tab opened from a grouped tab
joins that group automatically, the old code did not notice, lost track of the
group, and started another. Any stray CopperOS group is now merged into the one in
use, or dissolved if it is in a different window. If the agent moves to
another window, the group moves with it rather than dragging your tabs across.

**The agent closes the tabs it opened, and only those.** Ownership is the
safety line:

- A tab the agent opened, with `open_tab` or a click that opened one, is the
  agent's to close.
- A tab you opened is never closed, even while the agent drives it. When the
  agent moves on, the tab leaves the group the way it came in.
- A tab of the agent's that you switch to becomes yours. The agent never
  activates tabs, so any activation is you, and you may be reading that tab or
  finishing a form in it. Switching to the tab it is currently driving counts as
  watching and changes nothing.

Tabs are closed in three ways:

- **`close_tab`**, when the model decides it has finished with a page. If that
  was the tab it was driving, control returns to the tab it used before.
  `list_tabs` marks tabs `openedByYou` so the model knows what it may close.
- **When a run ends**, every tab the agent opened is closed except the one it
  finished on, which is usually where the result is. That tab is handed over to
  you, and the group comes down.
- **A cap of 5 idle tabs** during a run. Past that, the least recently used are
  closed. The agent often goes back to a tab it left, like a results list
  between applications, so this is a backstop rather than the main mechanism.

Ownership is kept in `chrome.storage.session`, so a recycled worker can still
tell the agent's tabs from yours.

This logic has no automated test yet — a harness that runs `workspace.js`
against a model of Chrome's grouping rules, including a tab joining its
opener's group, would be a good first contribution.

## Staying out of your way

The agent works in background tabs. Perception is the accessibility tree and
CDP input events, neither of which needs a tab to be visible, so raising one
only interrupts you.

- `open_tab` creates background tabs, and `activate_tab` changes which tab the
  agent drives without raising it or its window.
- A tab opened by a click is folded back into the window it came from, the tab
  you were on is re-activated, and focus is returned to the window that had it.
  `tabs.update` ignores `active: false`, so backgrounding a tab means
  re-activating the previous one.
- Focus is only restored if Chrome already had it. If you were in another app,
  re-focusing a Chrome window would itself drag Chrome over your work.

Use **Live view** in the popup to watch a run without touching focus.

**What this cannot fix.** When a page calls `window.open` from a real click,
Chrome creates and raises the window before any extension code runs, and there
is no API to veto it. The popup window is removed immediately afterwards, so
what is left is a flicker rather than a window parked on top of your work — but
if Chrome was in the background, that flicker can still pull it forward once.
Launching the agent against a separate Chrome profile or window you keep off
your active desktop is the only complete fix.

## Walking away mid-run

The extension popup is a transient window: Chrome destroys it the moment focus
leaves, including when you click another tab. MV3 also recycles idle service
workers. Neither may end a run, so nothing that matters lives only in memory.

- **Gates outlive the popup.** An unanswered approval is `"unanswered"`, not
  `"denied"` — a distinct tool result that tells the model to stop and say which
  action is waiting, instead of reporting a refusal the user never made. The
  toolbar icon shows a badge while one is open, and the prompt is re-shown when
  the popup reopens or the worker reconnects.
- **Ops tolerate a dropped socket.** `call` waits `RECONNECT_GRACE_MS` for the
  extension to return rather than failing immediately, so a worker restart
  costs a pause instead of the run.
- **The popup restores itself.** Run log, in-flight state, open approval, and
  the live-view toggle are kept in `chrome.storage.session` and replayed when
  it reopens. That storage is in-memory and cleared when the browser closes, so
  page text in the log never reaches disk.
- **The controlled tab is remembered.** `currentTabId` is persisted too. A
  revived worker keeps driving the original tab instead of falling back to
  whichever tab you happen to have switched to.
- **The live view stops when nobody is watching** and resumes with the popup.

A `chrome.alarms` heartbeat wakes the worker and reconnects if the socket died
while the browser was in the background, since `setTimeout` does not survive
worker termination.

## Layout

| File | Role |
|---|---|
| `extension/cdp.js` | `chrome.debugger` attach/send. Enables Page, DOM, Accessibility — **not** Runtime. |
| `extension/snapshot.js` | AX tree → ref-tagged text; the weak-snapshot heuristic. |
| `extension/input.js` | Bezier pointer paths, keystroke timing, ref→box resolution. |
| `extension/som.js` | Badge compositing onto captured frames. |
| `extension/nav.js` | Navigation, `networkAlmostIdle` waiting, AX-based text extraction. |
| `extension/screencast.js` | Live view frames for the popup only. |
| `extension/background.js` | WebSocket bridge and op router. |
| `extension/workspace.js` | The one CopperOS tab group; which tabs are the agent's; closing them. |
| `extension/presence.js` | Which tab carries the overlay; hiding it for screenshots. |
| `extension/overlay.js` | The in-page frame, status pill, and agent cursor. |
| `broker/src/tools.ts` | The 17 tool definitions. |
| `broker/src/agent.ts` | The loop, system prompt, history pruning. |
| `broker/src/bridge.ts` | WebSocket RPC server. |
| `broker/src/session.ts` | Chat transcripts on disk: load, sanitize, save. |
| `broker/src/stub-extension.ts` | Fake extension for testing without Chrome. |

## Testing without Chrome

`stub-extension.ts` serves a canned page so you can exercise the loop directly:

```bash
npm start                                    # terminal 1
npx tsx src/stub-extension.ts "what is the heading on this page?"   # terminal 2
```

It auto-approves gates and raises a realistic stale-ref error for unknown refs.
Both it and the broker honour `PORT`, so you can test on a spare port without
disturbing a running instance.

To exercise the vision escalation path — the part most sensitive to which model
you point at — force a weak snapshot and hand it a real image:

```bash
STUB_WEAK=1 STUB_SHOT=/path/to/any.jpg npx tsx src/stub-extension.ts "describe what you see"
```

Two more flags cover the cases that used to break runs:

```bash
STUB_NO_APPROVE=1 ...   # never answer the gate, as if the popup were closed
STUB_NEW_TAB=e1 ...     # make clicking that ref open a new tab, like "Apply now"
STUB_FORM=1 ...         # serve a job application form instead of example.com
STUB_PASTE_REJECT=e1 ...  # with STUB_FORM, that field ignores pasted text
```

## Cost and context

The compat endpoint has no equivalent of Anthropic's
`clear_tool_uses_20250919`, so `pruneHistory` in `agent.ts` does it by hand:
tool results older than the last three keep their message (the `tool_call_id`
pairing must survive or the request is invalid) but lose their images and get
their text truncated. Without this, every superseded snapshot and screenshot is
resent on every turn — dead page state that also tempts the model into reusing
refs that no longer exist.

The system prompt must stay byte-identical between requests or Ollama's prefix
KV cache misses every turn. Nothing dynamic belongs in it. Watch the `cached`
figure in the per-run line the broker prints; if it stays near zero, something
in the prefix is varying.

A local model costs nothing per token, so the per-run line reports tokens only.
The real budget is latency and context: vision escalation is still the
expensive path, since a screenshot runs 100KB+ against 2–5KB for the
accessibility tree of the same page.

## Troubleshooting

**`extension connected` / `extension disconnected` repeating.** The broker keeps
exactly one client and closes any previous socket, so anything that produces two
sockets self-sustains: the displaced one reconnects, displacing the other, whose
close handler reconnects. Two causes, and the broker tells them apart — if it
prints a flapping warning, two separate CopperOS instances are fighting over the slot
(a second unpacked copy at `chrome://extensions`, or another Chrome profile with
it installed); if it does not, a single client is reconnecting, which is normal
after a service-worker recycle and settles on its own.

## Known limits

- **Cross-origin iframes.** Box models resolve against the main frame. OOPIF
  content needs per-target sessions via `Target.attachToTarget` with
  `flatten: true`. Not implemented.
- **Snapshots cap at 400 nodes.** Content-heavy pages truncate; the model is
  told to scroll. Viewport-biased filtering would be the better fix.
- **Screenshots of a background tab.** Once the agent's tab is not the visible
  one, `Page.captureScreenshot` may return a stale frame or stall until the op
  times out; the model gets a tool error and falls back to the accessibility
  snapshot, which still works. Fixing it properly needs `Page.bringToFront`,
  which would yank your focus back — the opposite of what you want when you
  deliberately walked away. Snapshot-driven tasks are unaffected.
- **The debugger banner.** Chrome shows "CopperOS is debugging this
  browser" while attached. It is visible to you, not to the page. Suppressing
  it requires launching Chrome with `--silent-debugger-extension-api`.
- **`select_option` is keyboard-driven** and matches on first letter. Fine for
  short lists, wrong for long ones with shared prefixes.
- **Model quality is the ceiling.** Ref discipline, `destructive` flagging, and
  not chaining blind actions are all instruction-following behaviours. Small
  local models drop them well before they run out of context. A model without
  vision capability will silently waste every escalated screenshot.
- **No streaming.** The loop waits for each complete response, so the popup
  shows nothing between a tool call and the next event.
- **One tab at a time.** The broker tracks a single current tab; `list_tabs`
  and `activate_tab` switch it, but there is no parallel multi-tab work.

## Scope

Note that a `:cloud` model runs on Ollama's servers, not your machine — pages
the agent reads are sent off-box. Pull a local model if that matters to you.

This drives your own browser, signed into your own accounts, at your direction.
It is not built for volume — no proxy rotation, no CAPTCHA handling, no
concurrency. Check the terms of any site you point it at.

## Contributing

Bug reports, PRs, and questions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md)
for how to get set up and what to include.

## License

[MIT](LICENSE)
