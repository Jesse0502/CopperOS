<img width="1230" height="454" alt="CopperOS-Banner" src="https://github.com/user-attachments/assets/188a612f-5722-4d58-9184-9ea006a7e903" />


**CopperOS is an open-source AI agent for Chrome.** You type a task in a side
panel, and it reads, clicks and types in your own tabs, signed in as you. Every
step shows in the panel, and it asks before it submits anything.

**[Add to Chrome](https://chromewebstore.google.com/detail/cpiaailfifjppgijgnjdepcpokkmeoje)**
· [Website](https://copper.jassydev.com) · [Setup guide](https://copper.jassydev.com/setup/)
· [Pricing](https://copper.jassydev.com/pricing/)

Run it on CopperOS's hosted model (sign in with Google, free weekly trial, no
key needed), or on your own computer with the model you choose: Ollama,
OpenRouter or OpenAI. See [Known limits](#known-limits) before assuming
something is a bug, and [Contributing](#contributing) if you'd like to help.

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

Step-by-step guide: [copper.jassydev.com/setup](https://copper.jassydev.com/setup).

You need Node.js 20 or newer and a model that supports **tool calling** — an
OpenRouter or OpenAI API key, or a model in Ollama. Vision is optional: it lets
the agent use screenshots when the accessibility tree goes blind.

```bash
git clone https://github.com/Jesse0502/CopperOS.git
cd CopperOS/broker
npm install
npm start
```

Then load the extension: `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → select `extension/`. Keep only one copy of CopperOS enabled —
the broker serves one client at a time (see [Troubleshooting](#troubleshooting)).

Click the CopperOS toolbar icon to open the side panel. It opens on the chat,
whoever you are. On the hosted service (see [The hosted service](#the-hosted-service))
nobody has to sign up before they have seen it: the first message they send
brings up a popup asking them to **Continue with Google**, and the message goes
as soon as they are in. If a broker is running on this computer, the extension
notices (a plain HTTP request to port 7331, every few seconds while the panel is
on the cloud; a WebSocket would knock out the broker's live client) and asks,
signed in or not: a popup says CopperOS is running on this computer and offers
**Switch to this computer** or **Stay in the cloud**. Switching lasts as long as
that broker runs: if it stays gone for 15 seconds, the panel goes back to the
cloud, where a sign-in is kept. Staying, or choosing Cloud in Settings, is not
asked again until the broker stops and starts again. While a broker is running
(or the panel is on it), Settings shows **Cloud** / **This computer** at the
top; a choice made there is remembered. The dot in the panel's header is green
when connected, grey when nobody is signed in, red when the broker or the cloud
cannot be reached; a broker chosen in Settings that is not running shows how to
start it. Choose a provider, key and model under **Settings**, then type a task.

### Using Ollama

Pick a model with **tools** capability (`ollama show <model>` lists them):

```bash
ollama serve                  # or just run the desktop app
ollama list                   # what you already have
cp .env.example .env          # optional: set OLLAMA_MODEL to a model from `ollama list`
```

With Ollama as the provider, the broker checks it at startup and warns if it is
unreachable or if the model is not installed, rather than failing mid-task.

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

A ref names one element for as long as it is on the page, across snapshots,
and refs are kept per tab. A navigation clears the table, but numbering carries
on, so a ref from the page before raises an `unknown ref` error instead of
pointing at some other element. The error goes back to the model as a normal
tool result, and it re-snapshots. That is the intended recovery path, not a
failure.

**Every action reports what it changed.** Since refs are stable, `click`,
`paste`, `press_key` and the rest re-read the page afterwards and return the
difference: `+` for what appeared, `~` for an element whose line changed (a
value, `checked`, `expanded`), `-` for what is gone. After a navigation, or a
change too big to read as a list, the result carries the whole page instead.
The model no longer spends a turn on a snapshot after every action, and it can
fill several fields in one response.

Actions wait for what they set off before reporting: the page going quiet
(300ms with no requests that matter), or a new tab opening. A click that
changes nothing is back in about half a second. Filling a field without
submitting sets nothing off, so it does not wait at all.

**Vision escalates automatically.** `snapshot` scores the tree and attaches a
badged screenshot when it looks unreliable: `>30%` of interactive elements
unlabeled, a `<canvas>` present, or nothing interactive at all. Badge `N` on
the image is ref `eN` — one vocabulary across both channels. Badges are drawn
on the captured bitmap in an `OffscreenCanvas`, never injected into the page,
so nothing shifts under the click you are about to make.

A text-only model gets no screenshots at all: OpenRouter refuses a request
with an image in it for such a model ("No endpoints found that support image
input"). The broker checks OpenRouter's model catalog, or Ollama's
`/api/show`, before each task. Without a screenshot, an unreliable snapshot
comes with a note to wait and snapshot again. When a provider can't say
(OpenAI), the first refusal marks the model as text-only, and the request
is resent without its images.

This is the main cost lever: an accessibility snapshot runs 2–5KB against
100KB+ for a screenshot of the same page.

## Google Sheets

Sheets draws its grid on a canvas, so the accessibility tree has the toolbar,
the menus and the sheet tabs, and not one cell. On a sheet, three tools reach
the cells another way:

- `sheet_read` fetches the sheet's own CSV export with your existing Google
  login and renders it as a table with column letters and row numbers. A
  snapshot of a sheet starts with a preview of `A1:J20` rendered the same way,
  in place of a screenshot.
- `sheet_write` enters a whole block of values in one call. It goes to the
  first cell through the Name box, types each value (the first character as a
  real key press, which opens the cell for editing), and presses Tab and Enter
  between cells. Then it reads the block back and lists any cell that does not
  show what was written, such as a value Sheets autocompleted from the column.
- `sheet_select` selects a cell or range through the Name box, so toolbar
  buttons, menus and `press_key` shortcuts (`Delete`, `Mod+b`, `Mod+z`) apply to it.

`press_key` takes modifiers anywhere: `Shift+Tab`, `Mod+z` (⌘ on a Mac, Ctrl
elsewhere), `Alt+Enter`, with an optional `repeat`. Copy, cut and paste
shortcuts are refused, because they would use your clipboard. `type` and
`paste` can leave out the ref to write into whatever has focus.

## Configuration

`broker/.env`:

| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_MODEL` | `minimax-m3:cloud` | Must support tools; vision too, or escalated screenshots are wasted. |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama server. `/v1` is appended. |
| `OLLAMA_NUM_CTX` | `32768` | Context window. Ollama's own default is far too small here — one snapshot can be several thousand tokens. |
| `OPENROUTER_API_KEY` | — | Enables OpenRouter as a provider. Choose it in the extension's Settings page. |
| `OPENROUTER_MODEL` | `deepseek/deepseek-v4.1-flash` | Any [OpenRouter model id](https://openrouter.ai/models) that supports tools. |
| `APPROVAL_MODE` | `submits` | `all` gates every click, `submits` gates form submissions and clicks the model flags `destructive`, `none` gates nothing. |
| `PORT` | `7331` | Broker WebSocket port. Must match `BROKER_URL` in `extension/background.js`. |
| `JEV_AI_API_KEY` | — | Enables Jev: task rounds, check-ins, memory ranking and the other judgments. Nothing else depends on it; [loops](#loops) run without it. |
| `TASK_MAX_ROUNDS` | `15` | Most fresh-context rounds one message can start while Jev says there is more to do. |
| `SUPERVISOR` | off | `on` starts new chats with the supervisor on. Each chat's own setting is the **Supervisor** button in the panel. |
| `CHECK_IN_EVERY` | `10` | Steps between check-ins on a tracked task. `0` turns them off in every chat, whatever the Supervisor button says. |
| `FRESH_CONTEXT_TOKENS` | `25000` | Context size at which a check-in hands the task over to a fresh round. |

### Answers and tasks

With Jev enabled, each message is sorted first: work to do, a question or
comment the agent can answer from the chat ("how many did you apply to?",
"why did you skip that one?"), or small talk. The last two get a reply in
words with the agent's tools switched off. The task on record is left as it
was, so a follow-up question never starts browsing or replaces the task. A
message that may carry the task on, including a complaint about how it's
going ("I asked you to colour the rows"), counts as work. If an answer really
needs a page, the agent says so, and "go ahead" sends it to look.

### Loops

"Keep applying until I tell you to stop", "do this nonstop" or just "loop"
makes a task a **loop**: it repeats until you press Stop. Rounds end and fresh
ones start from a brief, as with any long task, but nothing judges whether it
is finished. A question for you (or a detail it doesn't know) is skipped and
recorded instead of waited on, so a loop never sits idle on one. An action that
needs your approval is still put to you, and the loop carries on once you answer.
"Continue" picks a stopped loop back up. A message that says when to finish
("50 more, then stop", "for the next 30 minutes") turns it back into a task
that ends. A loop also stops itself after 5 rounds in a row that record
nothing (`LOOP_STALLED_ROUNDS`), because by then it is stuck.

With Jev, `classifyIntent` decides whether a message asks for a loop, sets an
end, or carries on the task on record. Without Jev, or when Jev doesn't
answer, the message's plain words decide (`loopFromWords` in `jev.ts`):
"loop", "don't stop", "nonstop" and "until I tell you to stop" start one;
"stop the loop", "don't continue" and questions like "what does the loop do?"
never do. Loops are the one kind of task tracked without Jev, since only you
end one. A loop started that way carries your last few messages into every
round's brief, so the work it repeats is not lost.

### Check-ins

With Jev enabled and the supervisor on, a long task doesn't run unsupervised.
The **Supervisor** button next to the approval pill turns it on or off for the
chat. It's off in a new chat, unless `SUPERVISOR=on` is set or you left it on
in your last chat; the panel remembers your last choice for new chats. You
can switch it mid-task, and the change takes effect at the next check-in.
Every `CHECK_IN_EVERY` steps the model stops and says, in words, what it is doing,
how, and what's next. Jev compares that, and the last 20 actions it actually
took (each clicked element's label and how the page responded), with the
user's instructions. On course, the model carries on. Off course (working on
something nobody asked for, doing it a different way than asked, going in
circles, or reporting work the page doesn't show), it gets a correction
naming what's wrong. If it's still off course at the next check-in, the task
continues in a fresh round, with the correction in its brief. At four
off-course check-ins in a row, the task stops and waits for the user.

While the supervisor is on, a box under the message takes optional rules for
it: what it should hold the task to ("only jobs posted this week, never
LinkedIn, stop after 10"). The agent reads them with the task, every check-in
restates them, and Jev judges the agent against them as firmly as against the
task. They belong to that task: a follow-up like "continue" keeps them, and
the next new task starts without.

Separately, a check-in hands over to a fresh round whenever the context has
grown past `FRESH_CONTEXT_TOKENS`, including earlier turns of the chat (so
this too happens only with the supervisor on). The
model's check-in answer becomes the handover note, so the next round knows
how the work was being done and keeps doing it that way.

No API key is needed for a local model. `OLLAMA_API_KEY` is sent if set, for
remote or cloud-hosted Ollama endpoints that require one.

The provider, model and API keys can also be changed at any time from the
extension's Settings page (Ollama, OpenAI or OpenRouter); those choices are
saved to `storage/config.json` and take precedence over `.env`. With
OpenRouter, the transcript cap follows the chosen model's context window.

| `RECONNECT_GRACE_MS` | `30000` | How long an op waits for the extension to come back before failing. |
| `TASK_API_TOKEN` | — (off) | Turns on the [task API](#task-api) and is the bearer token callers must send. |
| `TASK_API_PORT` | `7332` | Port for the task API (127.0.0.1 only). |
| `MCP_ALLOW_LOOSENING` | — (off) | `1` lets an AI connected through the task API or MCP lower a chat's approvals, turn its supervisor off, and add memories and molds. Raising approvals and turning the supervisor on always work. |
| `UPLOAD_DIRS` | — (off) | Folders, separated by `:`, that `upload_file` may upload images from. With none set the tool isn't offered. |
| `TASK_BUDGET_MS` | — (no limit) | Optional limit on each task's active time, in ms. Time spent waiting on you does not count. The task stops cleanly before the limit, and "continue" picks it up. |
| `STORAGE_DIR` | `<repo>/storage` | Where chat transcripts are written. |
| `HISTORY_BUDGET_CHARS` | 60% of `OLLAMA_NUM_CTX` | Transcript size cap before old turns are dropped. |

Approval prompts appear in the side panel. The pill next to Send sets when a
chat asks first (every action, submits only, or never); **Ask before** in
Settings sets it for new chats. Declining returns "user declined" to the model
as a tool result, so it adapts instead of dying.

## Task API

Other programs on this computer can run a task and wait for its result,
through the broker that's already running. Set `TASK_API_TOKEN` in
`broker/.env` and restart the broker. It listens on 127.0.0.1 only.

```bash
curl -H "Authorization: Bearer $TASK_API_TOKEN" http://127.0.0.1:7332/api/health
# {"ok":true,"extension":true,"busy":false,"model":"..."}

curl -X POST -H "Authorization: Bearer $TASK_API_TOKEN" http://127.0.0.1:7332/api/task \
  -d '{"text":"open example.com and tell me the heading","rules":"read only","approvalMode":"submits","timeoutMs":300000}'
# {"status":"done","text":"...","steps":4,"chatId":"..."}
```

- Every task gets a fresh chat, never one of yours. It shows up in the chat list like any other.
- `approvalMode` is `all`, `submits` (default) or `none`. Nobody can click Approve for an API task, so a task that stops to ask is ended and answered with `{"status":"blocked","request":"..."}`.
- `rules` are supervisor rules for the task, as in the Supervisor box. Sending rules turns the supervisor on for the task's chat.
- `timeoutMs` (30s to 30min, default 10min) is the task's active-time limit; reaching it answers `{"status":"timeout",...}`.
- Other answers: `{"status":"error","error":"..."}`, `409` while another task runs (one tab at a time), `503` while the extension isn't connected.

### Starting a task without waiting, and everything else

These are what the MCP server uses. Same token and port; bodies and answers are JSON.

| Request | Does |
|---|---|
| `POST /api/tasks` | Starts a task and answers `202 {"chatId":"...","status":"running"}` at once. Body: `text` or `moldId` (or both: `text` then adds details for the run), and optionally `chatId` to carry on in that chat, `rules`, `approvalMode`, `supervisor`, `timeoutMs`. |
| `GET /api/chats?q=&limit=` | Chats, newest first. `q` searches everything said in them. |
| `GET /api/chats/:id?turns=` | One chat: status (`running`, `waiting` or `idle`), settings, the request it waits on, progress, the latest steps of a running task, and the last `turns` messages. |
| `POST /api/chats/:id/cancel` | Stops the chat's task, as Stop does. |
| `PATCH /api/chats/:id/settings` | `{"approvalMode":"all","supervisor":true}`. Takes effect mid-task. |
| `GET /api/memories`, `POST /api/memories`, `DELETE /api/memories/:key` | Saved memories. |
| `GET /api/molds`, `POST /api/molds`, `DELETE /api/molds/:id` | Molds. |

- A task from `POST /api/tasks` that needs approval, or has a question, stays in the side panel until you answer it. The API cannot answer it; the chat shows as `waiting`.
- Lowering a chat's approvals, turning its supervisor off, and adding a memory or mold answer `403` unless `MCP_ALLOW_LOOSENING=1` is set. The same goes for `approvalMode: "none"` on `POST /api/tasks`. `POST /api/task` is unchanged; the MCP tool `browser_task` applies the same rule to `approval_mode: none`.
- `409` while any task is running or waiting on you.

### CLI and MCP

Two thin clients of the task API, in `broker/`. The broker must be running with
`TASK_API_TOKEN` set; both read the token and port from `broker/.env`.

```bash
cd broker
npm run copper -- status
npm run copper -- "open example.com and tell me the heading"
npm run copper -- -a none -r "read only" "how many unread emails do I have?"
echo "find the pricing page" | npm run copper        # task from stdin
```

Exit codes: `0` done, `1` error, `2` blocked or timed out. `--json` prints the full result.

For other agents (Claude Code, Claude Desktop, Cursor), register the MCP server:

```bash
claude mcp add copperos -- npx --prefix /path/to/browsercontrol/broker tsx /path/to/browsercontrol/broker/src/client/mcp.ts
```

For Claude Desktop or Cursor, the same command goes in the client's MCP config:

```json
{ "mcpServers": { "copperos": { "command": "npx", "args": ["--prefix", "/path/to/browsercontrol/broker", "tsx", "/path/to/browsercontrol/broker/src/client/mcp.ts"] } } }
```

Tools:

| Tools | Does |
|---|---|
| `browser_task`, `browser_status` | Run a task and wait for its result; check the broker. |
| `start_task`, `wait_for_task`, `stop_task` | Start a task (or run a mold) and get its chat id at once; wait for it to finish or need you; stop it. |
| `list_chats`, `get_chat` | The chat history, searchable, and one chat in full. |
| `set_chat_settings` | A chat's approval mode and supervisor. |
| `list_memories`, `add_memory`, `delete_memory` | Memories. |
| `list_molds`, `save_mold`, `delete_mold` | Molds. |

The read tools are marked read-only and the delete tools destructive, so clients that ask before running a tool can tell them apart.

A task can run for minutes. If the client gives up first, raise its tool timeout
(Claude Code: `MCP_TOOL_TIMEOUT=600000`).

## Uploading images

`upload_file` attaches an image to a page's upload control. The model passes
the ref of the file input, or of the button that opens the file picker. The
click is made with file-chooser interception on, so no picker window opens,
and the bytes are set on the input from an isolated world, so no file path
reaches the page and no file-URL permission is needed. Files must be under one
of the `UPLOAD_DIRS`, checked in the broker before anything is read.

## The chat is sticky

A task is a turn in an ongoing conversation, not a fresh start, so follow-ups
work: "apply to the first result", then "now do the next one". The transcript
lives on disk under `storage/`, so it survives restarting the broker too.

```
storage/
  sessions/<id>.json   one transcript per chat
  current.json         which one to resume
  memories/<topic>/<slug>.md   durable facts, kept across chats
```

It is written after every step, so an interrupted run still leaves a resumable
chat. **New chat** in the popup abandons the transcript and starts a fresh one.

Facts you add yourself on the **Saved memories** page go under
`memories/user/notes/`, up to 4,000 characters each, with line breaks kept.
The limit is there because every grounding check and memory search sends Jev
all of your memories.

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

Use the eye on a running task's card to watch it live without touching focus.

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

- **Approvals and questions pause the task.** Nothing waits in memory: the
  task is saved with the tool call that asked still open, and where the agent
  loop stood (round, step, check-in history). Your answer resumes it from
  there — an approved action runs for real, a denied one tells the model so,
  and form answers become the call's result. There is no timeout, and a
  waiting task survives the popup closing, the worker being recycled, and the
  broker restarting: the prompt is re-shown whenever the panel reconnects, and
  the toolbar icon shows a badge while one is open. Cancel ends a waiting task
  like a running one.
- **Ops tolerate a dropped socket.** `call` waits `RECONNECT_GRACE_MS` for the
  extension to return rather than failing immediately, so a worker restart
  costs a pause instead of the run.
- **The side panel restores itself.** Run log, in-flight state, open approval, and
  the live-view toggle are kept in `chrome.storage.session` and replayed when
  it reopens. That storage is in-memory and cleared when the browser closes, so
  page text in the log never reaches disk.
- **The controlled tab is remembered.** `currentTabId` is persisted too. A
  revived worker keeps driving the original tab instead of falling back to
  whichever tab you happen to have switched to.
- **The live view stops when nobody is watching** and resumes with the side panel.

A `chrome.alarms` heartbeat wakes the worker and reconnects if the socket died
while the browser was in the background, since `setTimeout` does not survive
worker termination.

## The hosted service

Someone who installs CopperOS from the Chrome Web Store signs in with Google
and can start at once: nothing to install, no key to find. Their tasks run in
AWS (`infra/`) on CopperOS's own model and key, and every call is metered.
Running on a key of their own is a paid plan, **Foundry**, priced for the
hosting, storage and convenience and not for the model.

| | CopperOS's model | Their own API key (Foundry) |
|---|---|---|
| Model | `deepseek/deepseek-v4.1-flash`, fixed (`PLATFORM_MODEL`) | any model on OpenRouter or OpenAI that can use tools, picked from the list in Settings |
| Paid by | the allowance, then credits | them, to their provider |
| Limit | dollars of model use: a week on Ore, the billing month on Ingot and Facet | none from CopperOS |
| Task length | by plan: 15 minutes on Ore, 5 hours on Ingot, 24 hours on Facet | no limit on a task; 14 hours a week of working time (Foundry) |
| Jev (supervisor, safety checks) | CopperOS's | their own Jev key, optional; never CopperOS's |

Own key is gated on the plan, on the server: `usesPlatformKey` in `config.ts`
is true unless the plan allows it (`allowsOwnKey`, registered at startup by
`installBilling()`) **and** a key is saved for the chosen provider; a failed
lookup is a no, which is the metered side. There is no switch: on Foundry,
Settings shows the provider, key and model, a saved key is used at once, and
**Remove my saved API key** goes back to CopperOS's model on credits. Anyone
else sees a line pointing at the Foundry plan, and `set_config` drops their
model settings. Someone
whose Foundry lapses is back on CopperOS's model, metered, with nobody doing
anything. Foundry has no allowance of CopperOS's model: credits can still
pay for it.

**Whose Jev.** Each run picks its Jev client (`jevFor` in `config.ts`, applied
by `withJev` in `jev.ts`, which holds it in an `AsyncLocalStorage` so runs going
at once never borrow each other's). On the hosted service, Ore, Ingot and Facet
use CopperOS's key; Foundry uses a Jev key the person saved in Settings, or
none. With none, a Foundry run has no supervisor, no sorting of messages and
none of Jev's checks, and the panel turns the Supervisor button off and says
why. On a broker of your own, a key saved in Settings wins over
`JEV_AI_API_KEY`. Like the model keys, the saved Jev key is sealed when hosted
and never sent back to the panel.

**One key, many people.** Everyone on Ore, Ingot and Facet runs on CopperOS's
one OpenRouter key, many at once, and shares nothing through it: a model call
is stateless, and each carries only its own chat's messages, built from that
chat's session. Each call also names its account to OpenRouter as `user`, a
hash of the account id (never the email), so OpenRouter can tell them apart.
The broker's own short-lived caches (the last snapshot, the last job-fit
verdict, the labels of page elements) are keyed by account and chat.

**What is metered.** OpenRouter reports what each call cost as `usage.cost`,
so the meter (`broker/src/meter.ts`) charges real dollars, not a price table
that goes stale; a response without it is estimated, never free. Before every
model call the agent asks the meter whether anything is left, and a task that
has run out stops with a message saying when it starts over and pointing at
plans and credits. Jev's calls are not metered (they follow the model's steps,
which are).

**Plans and credits** (`broker/src/cloud/billing.ts`). A plan gives an allowance
in dollars of model use for a period: Ore a week, Monday 00:00 UTC to Monday;
Ingot and Facet their billing month, from the day the subscription renews
(Stripe's `current_period_start`, kept on the account) to the next. What goes
past it comes out of the user's credits, which never expire. People only ever
see credits: every dollar paid buys 100 (`CREDITS_PER_DOLLAR`), and behind
each is $0.0055 of model use (`MODEL_USE_PER_DOLLAR` 0.55 a dollar); the ledger
keeps the balance in micro-dollars of model use and `creditsOf` counts it out. With neither left,
a task stops and says so: buy credits, or wait for the renewal. Settings shows
what is left of the period as a percentage, the tokens used and when it renews. The plans are named for
copper's way from the ground to the mark on the logo: **Ore** is the trial,
**Ingot** is refined, **Facet** is cut and polished, and **Foundry** is where
it is cast, with your own key. A paid plan lapses back to Ore when its end date
passes (three days after the month it paid for, in case a payment is late). Usage is kept one row per user per period in the
`Usage` table (expiring after four months); plan, lapse date and credits are on
the user's `Accounts` item. Amounts are whole micro-dollars so DynamoDB can add
them atomically, and a failed write is carried to the next charge rather than
lost. Payments (below) set a plan and add credits through `setPlan()` and
`grantCredits()` (`broker/src/cloud/ledger.ts`); to give a plan or credits
without a payment, or to correct one, by hand:

```bash
cd broker
AWS_PROFILE=jassydev npm run admin -- show   someone@gmail.com
AWS_PROFILE=jassydev npm run admin -- grant  someone@gmail.com 500     # 500 credits (a $5 pack)
AWS_PROFILE=jassydev npm run admin -- plan   someone@gmail.com ingot 30 # 30 days (ore|ingot|facet|foundry)
AWS_PROFILE=jassydev npm run admin -- report                           # this week's spend, and the free pool
```

**The free pool.** Ore is $2 a week per account, and all of Ore together is
capped at $50 a calendar month. Each Ore call's cost, plus 10% for Jev and AWS
(`POOL_OVERHEAD`), is added to the month's row. When the pool is spent, Ore
stops for everyone until the month turns, with a message that says so; paid
plans, people with credits (who then spend those, never the pool) and people on
their own key carry on. The owner gets an email at 80% and again at 100%
(`ALERTS_TOPIC_ARN`, once a month each). The pool is a hard stop, not a
forecast: at most a few in-flight calls run past it.

**Setting the limits.** The free numbers start from `freeWeeklyUsd` and
`freePoolMonthlyUsd` in `infra/cdk.json`, and every one of them can be changed
live, with no deploy, in a Parameter Store parameter (each Lambda picks it up
within a minute):

```bash
aws ssm put-parameter --name /copperos/prod/limits --type String --overwrite \
  --value '{"ore":1.5,"ingot":8,"facet":20,"foundry":0,"freePool":40}' --profile jassydev
```

`ore` there is dollars a week; `ingot` and `facet` are dollars a billing month.

**Taking payments** (`broker/src/cloud/stripe*.ts`). Stripe is the source of
truth for what is for sale, and does the parts that have to be Stripe's: the
card form (Checkout), receipts and invoices, and changing or cancelling a
subscription (the customer portal). CopperOS never sees a card. In the panel,
each plan's button has its renewal terms right under it (the price, every
month until you cancel, and where to cancel), as California's auto-renewal law
asks, and the sign-up popup has people confirm they are 13 or older, as the
Terms require.

| | Price | What it is |
|---|---|---|
| Ingot | $10 a month | regular use of CopperOS's model: $8.55 of it a month |
| Facet | $25 a month | heavy use of it: $21.79 a month |
| Foundry | $5 a month | your own API key and model, and Jev key if you like: hosting, storage, convenience |
| Credits | $5, $10, $25, $50 | 100 credits a dollar (500 to 5,000); they never expire |

Those numbers live in `stripe-setup.ts` and nowhere else on the server, in US
dollars. The allowance each plan includes follows from its price
(`allowanceForPrice` in `billing.ts`): the price less Stripe's card fee (2.9% +
30¢), divided by `POOL_OVERHEAD` for Jev and AWS, so $10 gives $8.55 of model
use a month and $25 gives $21.79. With Managed Payments on, Stripe takes a
further fee that this does not count, and that comes out of the margin. The
`limits` parameter above overrides it: set the two together, because a plan
whose allowance costs more than it earns loses money on every heavy user. The website's pricing page
is typed by hand: change it with `stripe-setup.ts` (and the task lengths with
`runtime.ts`, whose numbers the plan descriptions in `stripe-setup.ts` repeat).

```bash
cd broker
npm run stripe:setup                               # the sandbox: products, prices, credit packs, the customer portal (STRIPE_SECRET_KEY in .env)
npm run stripe:setup -- --live                     # the same for real customers (LIVE_STRIPE_SECRET_KEY in .env)
npm run stripe:setup -- --stage dev                # and keeps the key in Parameter Store: /copperos/dev/stripe-secret-key
cd ../infra && npx cdk deploy -c stage=dev         # prints StripeWebhookUrl
cd ../broker
npm run stripe:setup -- --stage dev --webhook <StripeWebhookUrl>   # registers the webhook, keeps its signing secret
```

It can be run again at any time: it finds what it made (by metadata and price
lookup keys) and changes only what differs. **To change a price,** edit it in
`stripe-setup.ts` and run it again: a new Stripe price takes the lookup key and
the old one is archived, and people already subscribed keep the price they
signed up at. Without `--live` it works only with a test key (Stripe's sandbox,
where nothing is real), and `--live` works only with a live one, so neither can
be done by mistake; a restricted key (`rk_`) works if it may write products,
prices, the customer portal and webhook endpoints. The live catalog was made on
8 October 2026. Production then needs `--live --stage prod --webhook <url>` once
the stack is deployed, which stores the live key and the webhook's secret in
Parameter Store. Each Stripe account also needs its customer emails turned on,
and decides in the Dashboard whether Managed Payments (Stripe as the seller of
record) is on; the products carry a tax code (`TAX_CODE`, SaaS for personal use)
so it works either way.

How a payment reaches an account: the extension asks the relay for a payment
page (`billing_checkout`, by plan name or by the price id the relay listed,
never an amount), the relay makes a Stripe Checkout session naming the user,
and the service worker opens it in a new tab (only on `checkout.stripe.com` or
`billing.stripe.com`). Stripe then calls the webhook Lambda, which checks the
signature and applies the event (`stripe-events.ts`): a plan is set from the
subscription as it stands, never from "one more month"; credits are granted
once, by a conditional write that claims the purchase and adds the credits in
one transaction, so Stripe sending an event twice, or two at once, changes
nothing the second time; and the end of an old subscription cannot take a new
plan away. Someone who already has a plan is sent to the portal instead of a
second checkout.

A webhook that never arrives (none registered yet, an outage) or is still on
its way is caught up with: the relay notes each payment page it opens on the
account (`pendingCheckouts`), and whenever the Plans page asks for billing
(every few seconds while a payment page is open, at most every 10 seconds per
account) `syncFromStripe` applies what Stripe holds the same way the webhook
would: those pages directly, then the newest live subscription naming the user,
then credit payments of the last 30 days (the purchase claims last 45). It all
goes through the same idempotent handlers, so it is safe beside the webhook. Deleting an account cancels its subscription first. Receipts
and invoices come from Stripe (turn on its customer emails under Settings →
Emails in the Dashboard); the billing page it hosts lists them.

Not handled: refunds and disputes (those events are not subscribed, so
refunding a credit pack in Stripe does not take the credits back: use `admin
grant <user> -1000` for a $10 pack), and currencies other than USD.

**How long a task runs** (`broker/src/cloud/runtime.ts`). Each plan sets two
numbers: how long one task may run, in minutes of working time (waiting on the
person never counts), and how much working time all of an account's tasks share
in a week. Ore is 15 minutes a task, Ingot 5 hours, Facet 24 hours, Foundry has
no limit on a task and 14 hours a week. Plans on CopperOS's model have no weekly
hours: they pay for every step in dollars, so the allowance and credits are
their real ceiling. Foundry runs on its own key, so time is all that bounds what
it costs CopperOS; the arithmetic is at the top of `runtime.ts` (about $0.034 an
hour, so 14 hours a week is at most $2.10 of a $5 plan). Both numbers can be
changed live, with `null` for no limit:

```bash
aws ssm put-parameter --name /copperos/prod/runtime --type String --overwrite \
  --value '{"foundry":{"weeklyHours":10},"ingot":{"taskMinutes":300}}' --profile jassydev
```

A Lambda stops after 15 minutes, so a longer task is handed from one to the
next (`cloud/agent-run.ts`). The agent's clock knows two ends: the task's own
limit, and its Lambda's. At the Lambda's, it stops at a step boundary and saves
where the loop stands (`session.slice`); the run keeps the chat claimed
(`extendRun`, which also renews the lease); and the agent invokes itself with a
`continue` job, which joins the same socket with a new one-time pass and carries
on (`Agent.continueSlice`): a tracked task from its brief, as a later round of a
long task always does, anything else from the chat. The person sees one task and
one timer; nothing is added to the chat. Cancel during the gap marks the run
(`markCancelled`), so the next Lambda finds it and stops. The working time is
counted per week in the `Usage` table (`activeMs`). A task that would outgrow
Lambda would move to Fargate behind the same two numbers.

**Encryption.** What a person writes is encrypted before it is stored
(`broker/src/store/sealing.ts`): transcripts in S3, the titles and pending
questions in the chat list, tracked tasks, memories and molds. AES-256-GCM
with a key per account, derived (HKDF) from the `/copperos/<stage>/user-keys-secret`
SecureString, which is never stored beside the data; each record also binds in
its account and its place, so it opens nowhere else. Ids, dates, a memory's
topic and slug, plans and usage stay readable, because the tables find and order
by them. It is encryption at rest, not end to end: the service holds the key,
because it reads a chat to run a task. Records saved before this existed are
read as they are; to encrypt them:

```bash
cd broker
export TRANSCRIPTS_BUCKET=$(aws cloudformation describe-stacks --stack-name CopperOS-prod \
  --query "Stacks[0].Outputs[?OutputKey=='TranscriptsBucket'].OutputValue" --output text --profile jassydev)
AWS_PROFILE=jassydev STAGE=prod npm run admin -- encrypt all
```

**Setting up a stage.** The model key is a SecureString that only the agent
Lambda can read. Give that OpenRouter key a credit limit on OpenRouter's side
too: it is the one ceiling this stack cannot move.

```bash
aws ssm put-parameter --name /copperos/prod/openrouter-key --type SecureString --value sk-or-… --profile jassydev
cd infra && npx cdk deploy -c stage=prod --profile jassydev
```


### Claude and other AI apps (the MCP connector)

An AI app can use a signed-in person's CopperOS through one address, the stack's
`McpUrl` output (`https://….lambda-url.us-east-1.on.aws/mcp`). In Claude it is
Settings → Connectors → Add custom connector: paste the address, sign in with the
CopperOS account, press **Allow**. Nothing is installed. Any MCP client that
supports remote servers with OAuth connects the same way. Tasks still run in the
person's own Chrome, so it has to be open with CopperOS signed in.

The address is one Lambda behind a Function URL (`broker/src/cloud/mcp.ts`). It
is its own OAuth 2.1 server (`mcp-oauth.ts`: registration, PKCE, a consent page,
tokens kept as hashes in the `McpAuth` table, 1-hour access tokens and 30-day
refresh tokens replaced each time they are used). The person is identified by
CopperOS's own sign-in page through a second Cognito app client named `mcp`
(`mcp-cognito.ts`). The tools are the ones in `client/tools.ts`, the same code the
local stdio server uses, against `mcp-backend.ts`.

| Tools | |
|---|---|
| `start_task`, `wait_for_task` (up to 20 s a call), `stop_task` | Start a task or a mold, follow it, stop it. |
| `list_chats` (searches the 30 newest), `get_chat` | History. A hosted task's individual steps are not kept, so a running chat shows its status and any tracked progress, not a step list. |
| `set_chat_settings` | Raise approvals, turn the supervisor on. Lower them or turn it off only with the switch (below). |
| `list_memories`, `delete_memory`, `list_molds`, `delete_mold` | Read, and delete. |
| `add_memory`, `save_mold` | Only with the switch. |
| `get_usage` | Plan, share of the period left, credits, task length, running time. |

Never offered: answering an approval or a question (a chat shows as `waiting` and
the panel answers it) and `browser_task`.

**The switch.** Lowering approvals, turning the supervisor off, adding a memory and
saving a mold are off. Memories and molds are read by the agent as the person's own
words. Settings → MCP has one checkbox that turns all four on for the account
(`aiLoosening` on the `Accounts` item, `ai-apps.ts`). It is read on every request, so
turning it off takes effect on the app's next call, and the two tools that write
disappear from its list. Settings → MCP also shows the address to paste, the
connected apps (name and when each was last active) with a **Disconnect** for each, which
removes every token the app holds. The relay answers `get_ai_access`, `set_ai_access` and
`revoke_ai_app` for it.

What stands between an AI and the meter, in the order a start meets it
(`mcp-backend.ts`; the numbers are `LIMITS`, set by `MCP_REQUESTS_PER_MIN` and
`MCP_STARTS_PER_HOUR`):

- 120 requests a minute per account, `429` after that; 20 registrations, 60
  sign-ins and 120 token requests an hour per address.
- A task needs a connected Chrome, or the start is refused.
- 30 started tasks an hour per account.
- One start at a time per account (a conditional write in `McpAuth`), and one
  task running or waiting on the person at a time, read with a strongly consistent
  query.
- The meter and the week's running time are asked before anything is launched
  (`usageProblem`): a person whose usage is spent gets the message the panel
  shows, and no Lambda starts. The meter inside a running task is unchanged.
- Accounts on their own key (Foundry) skip the model meter, not the weekly hours.

Account deletion removes the tokens. To see or cut off what is connected:

```bash
cd broker
AWS_PROFILE=jassydev STAGE=prod npm run admin -- ai        someone@gmail.com
AWS_PROFILE=jassydev STAGE=prod npm run admin -- ai-revoke someone@gmail.com
```

Deploying it is the stack deploy above; it adds the table, the Lambda, its URL and
the `mcp` app client, and needs no Parameter Store values of its own.

**Concurrency.** The function's URL is public, so a flood at it could take Lambda concurrency from the
agent, and every running task holds one for up to 15 minutes. Prod reserves 100 of the account's 1000 for
the connector (`mcpReservedConcurrency` in `infra/bin/copperos.ts`), so it can never use more than that and
the other 900 are the agent's and the relay's. Other stages reserve none. AWS requires 100 to stay
unreserved. The account's limit was 50 until 2026-10-17; it was raised with:

```bash
aws service-quotas request-service-quota-increase --service-code lambda \
  --quota-code L-B99A9384 --desired-value 1000 --profile jassydev --region us-east-1
```

To change the reservation, deploy with `-c mcpReservedConcurrency=<n>` (`0` for none). A deploy without
the flag keeps what `bin/copperos.ts` says.

### The welcome email

A new account gets one email: black and copper, centered, how to start in three steps,
what a mold is, and five molds from the library page (`welcome-email.ts`; its molds are
copied from `website/library/index.html` and change with it). Cognito runs the `Welcome`
Lambda (`welcome.ts`) when a sign-up is confirmed, which includes a first sign-in with
Google. It marks the account (`welcomedAt` on its `Accounts` item) before it sends, so a
trigger that runs twice sends once, and it sends through SES from `no-reply@<emailDomain>`
with replies going to the feedback address. A password reset does not send it, and
accounts that exist already are not sent one. Cognito refuses a sign-up whose trigger
fails, so the handler catches every error and gives up after 3.5 seconds.

```bash
cd broker
npm run admin -- welcome-html > welcome.html        # open it in a browser; sends nothing
AWS_PROFILE=jassydev npm run admin -- welcome you@example.com    # sends it to that address now
```


## Announcements

For a release or a major feature the panel shows one large dialog in the middle: a tag, a title, a lead,
up to five points, a picture from `copper.jassydev.com`, and a button. It comes from one file on the
website, `website/announcements.json`, which the panel reads from
`https://copper.jassydev.com/announcements.json` (`extension/announcements.js`) at most every six hours.
It sends nothing about the person and shows nothing if the file cannot be reached.

- It shows once. Got it, ✕, Escape or its button closes it for good.
- It can be limited to extension versions (`minVersion`, `maxVersion`) and dates (`from`, `until`).
- It is not shown to anyone who installed after it was published (`background.js` notes the install time):
  it is news about a change, and they never saw the old way.
- Only text, https links and pictures from the website are shown.

Because it is a file, a feature that needs no new version of the extension can be announced the day it
ships. `website/announce.py` writes the file. A dialog is drafted first: a draft goes to
`announcements.draft.json`, which `deploy.sh` does not upload, so nothing goes out until it is published.

```bash
cd website
python3 announce.py modal --title "Connect CopperOS to Claude" --lead "Let your own LLM control CopperOS actions via MCP." \
  --point "Open Settings, then MCP, and copy the address." --point "Approvals still wait for you in the panel." \
  --tag "New in 1.1.0" --min-version 1.1.0 --draft
python3 announce.py preview               # the real panel with the drafts and what is live, in your browser
python3 announce.py publish <id>          # moves the draft to the live list
./deploy.sh
python3 announce.py list                  # what is live and what is drafted
python3 announce.py remove <id>
```

Entries run 21 days unless `--days` says otherwise, and expired ones are dropped each time the script
runs. When a major feature ships, the dialog is drafted and shown with `preview`, and published only once
it has been confirmed. `website/` is not in git; `deploy.sh` publishes it from disk.

### The what's-new email

The same entry can be emailed to everyone with an account (`updates-email.ts`: black and copper like the
welcome email, with the entry's tag, title, lead, points, picture and button), so what people read in the
panel and in their inbox is one piece of writing. It is sent by command, after the entry is published:

```bash
cd broker
npm run admin -- whats-new-html <id> > whats-new.html                  # look at it; sends nothing
AWS_PROFILE=jassydev npm run admin -- whats-new <id> --test you@example.com   # one copy, to you
AWS_PROFILE=jassydev npm run admin -- whats-new <id> --all             # counts who it would go to; sends nothing
AWS_PROFILE=jassydev npm run admin -- whats-new <id> --all --yes       # sends it
```

`--all` is refused for a draft, and without `--yes` it only counts. It goes to the people in the sign-in pool
who signed in with Google (Google vouches for the address; Cognito stores `email_verified` as false for all of them) or are confirmed with a verified address, minus anyone who unsubscribed
and anyone who has had that announcement. Each person's account item keeps the ids they have been sent
(`newsEmailed`), marked before the email goes, so running it again, or two runs at once, sends it once; a
send that fails gives the mark back and the next run retries it. Every email has a signed one-click
Unsubscribe link and the `List-Unsubscribe` headers mail apps show as their own button. The link goes to
the `Unsubscribe` function (`unsubscribe.ts`): opening it asks first, and only the button (or the mail app's
one-click POST) sets `emailOptOut`, since mail scanners open every link. The signature is an HMAC of the
person's id under the secret the stored data is sealed with. `UNSUBSCRIBE_URL` is the stack's
`UnsubscribeUrl` output:

```bash
export UNSUBSCRIBE_URL=$(aws cloudformation describe-stacks --stack-name CopperOS-prod --profile jassydev \
  --query "Stacks[0].Outputs[?OutputKey=='UnsubscribeUrl'].OutputValue" --output text)
```


## Molds

A task you have done once, saved as steps, so you never explain it twice or dig
the old chat out of the history. CopperOS calls them **molds** (cast once, run
again: the foundry once more), partly because "workflow" turns up in people's
own tasks and must not be mistaken for one. In the code they are still
workflows (`workflows.ts`, the `Workflows` table, `list_workflows`). The
**Molds** tab, beside Chats in one window, lists them; the first few also sit
on the empty chat as one-click chips, and **Run** sends the steps to the agent
in a fresh chat as a task (`fromMold`), so approvals, the supervisor and
everything else apply as to any task. A chat started from a mold is never
offered to be saved as one again, and saving the same steps or name twice is
refused.

They are made two ways:

- **Asking for one.** **New mold** opens a fresh chat and asks the person to
  describe it in their own words first (a strip above the composer; nothing is
  sent until they do). That message goes as the idea (`makeMold`); saying "help
  me make a workflow" anywhere does the same, because Jev's `classifyIntent` has
  a `mold` verdict (taken above 0.6), and with no idea in it the model first
  asks for one. The model is told it is making a mold, not doing the task
  (`MOLD_NOTICE`), and is offered only `ask_user`, `search_memory` and
  `propose_mold` (`MOLD_TOOL_DEFS`; anything else is refused with a reason),
  with the open tab left out of its message: a mold comes from what the person
  says, not from whatever page is open. From the idea it asks, in one
  `ask_user`, only about what the idea leaves unclear or missing, plus one
  multiple choice of 2 to 4 additions that would make it hold up better;
  `search_memory` only for something the person mentions that it does not know
  ("my resume"). Then it writes the mold (specific steps, what to do when
  something goes wrong, a clear stop, rules) and calls `propose_mold`, which
  shows a card with the name and steps: **Save mold**, **Edit first** or **Not
  now**. The chat stays in mold-making (`session.molding`) across messages and
  across answered questions until a proposal is made.
- **A task that repeats.** The first task in a chat that repeats until you stop
  it (a [loop](#loops)) opens a popup asking whether to keep it; **Save as
  mold** has the model write it up from what you asked (`Agent.draftWorkflow`)
  and saves it at once, with a toast and an **Edit** link (`offer_workflow`,
  once per chat, remembered with the chat).

Any mold can be edited by hand. `<angle brackets>` in a step mark what changes
from run to run. A mold is a name and plain text; up to 50 a user. Saved under
`storage/workflows/` locally, in the `Workflows` table when hosted (sealed, like
chats). Drafting is one model call, metered like any other, and on the hosted
service it runs in the agent Lambda, which alone has the model's key.

## What is a task and what is a chat

A message that only asks for an answer in words (a question about what it just
did, small talk) is not a task: it gets no run card, with no step counter and no
timer, just the reply. The broker already knows which
it is, because Jev classifies every message (`classifyIntent`), so it says so
(`intent: reply | task`) and the panel waits on that: the message shows three
dots, and a task's card (steps, timer, Stop) appears the moment the verdict is
"task", counting from when the message was sent. Without Jev there is no
verdict, and the first step brings the card.

## Layout

| File | Role |
|---|---|
| `extension/cdp.js` | `chrome.debugger` attach/send. Enables Page, DOM, Accessibility — **not** Runtime. |
| `extension/snapshot.js` | AX tree → ref-tagged text; stable per-tab refs; change lists between snapshots; the weak-snapshot heuristic. |
| `extension/input.js` | Bezier pointer paths, the `PACE` timing table, key combos, ref→box resolution. |
| `extension/sheets.js` | Google Sheets: CSV read, Name box navigation, block writes with read-back. |
| `extension/som.js` | Badge compositing onto captured frames. |
| `extension/nav.js` | Navigation, `networkAlmostIdle` waiting, AX-based text extraction. |
| `extension/screencast.js` | Live view frames for the side panel only. |
| `extension/background.js` | WebSocket bridge, op router, and the after-action settle-and-report step. Splits big results into pieces for the hosted broker, and tells the panel whether a broker is running on this computer. |
| `extension/backend.js` | Which broker the extension talks to — this computer's or the hosted one — and the hosted one's addresses. |
| `extension/assets/fonts/` | Geist and Martian Mono, bundled so the panel fetches nothing (both SIL OFL; licenses alongside). |
| `extension/auth.js` | Signing in to the hosted broker: Cognito's page, OAuth code flow with PKCE, token refresh. |
| `extension/workspace.js` | The one CopperOS tab group; which tabs are the agent's; closing them. |
| `extension/presence.js` | Which tab carries the overlay; hiding it for screenshots. |
| `extension/overlay.js` | The in-page frame, status pill, and agent cursor. |
| `broker/src/tools.ts` | The tool definitions, and how action results are shown to the model. |
| `broker/src/agent.ts` | The loop, system prompt, history pruning. |
| `broker/src/task-extras.ts` | What rides along with a task's words: the tab it starts on, and the user's rules for the supervisor. |
| `broker/src/bridge.ts` | The agent core's link to the extension: ops, progress lines, approvals and questions, over whichever `Transport` is set. |
| `broker/src/transport/local.ts` | The local broker's `Transport`: a WebSocket server on 127.0.0.1 that the extension connects to. |
| `broker/src/transport/cloud.ts` | The hosted agent's `Transport`: ops straight to the browser through API Gateway, results back over the task's own worker connection, big results reassembled from chunks. |
| `broker/src/session.ts` | Chat transcripts: load, sanitize, save. |
| `broker/src/memory.ts` | Durable cross-chat facts: save, search. |
| `broker/src/store/store.ts` | The `Store` interface: where chats, memories, task progress and settings are kept, per user. |
| `broker/src/store/fs.ts` | The local broker's store: files under `storage/`, one user. |
| `broker/src/store/cloud.ts` | The hosted store: DynamoDB and S3 transcripts, with everything a person writes, and their API keys, sealed (`sealing.ts`: AES-256-GCM, a key per account) under a secret kept in Parameter Store. |
| `broker/src/meter.ts` | What a run on CopperOS's own model costs and when it must stop: the `Meter` the agent checks before each model call and charges after. |
| `broker/src/workflows.ts` | Saved molds (workflows, in the code): what may be saved, duplicates refused, and the prompt that turns a request into steps and the parser for the model's answer. |
| `broker/src/cloud/runtime.ts` | How long a task may run on each plan, and the week's working time on Foundry, with the cost arithmetic behind them. |
| `broker/src/cloud/stripe.ts`, `stripe-events.ts`, `stripe-webhook.ts`, `stripe-setup.ts` | Taking money: what is for sale (read from Stripe), the checkout and billing-portal sessions, what each Stripe event does to an account, the webhook Lambda, and the script that makes Stripe match what CopperOS sells. |
| `broker/src/cloud/billing.ts`, `ledger.ts`, `admin.ts` | Plans, their allowances, credits, the free pool and the usage ledger (rules in `billing.ts`, DynamoDB, the live limits and the pool alerts in `ledger.ts`), and the command line for looking at and changing a user's plan and credits. |
| `broker/src/cloud/` | The hosted version's Lambda handlers: the sign-in check on connect (users and task workers), the relay (the hosted `index.ts`), the agent, and `feedback.ts`, which emails "Send a suggestion" from Settings to the team. `testing/` holds a scripted model deployed to dev stacks only. |
| `broker/src/task-api.ts`, `ai-access.ts` | The local task API's routes for chats, memories, molds and per-chat settings, and the rules a connected AI is held to (what counts as lowering approvals, how a mold is sent, how a chat is shown), shared with the hosted endpoint. |
| `broker/src/client/` | `api.ts`, `cli.ts` and `mcp.ts` (the local stdio server); `backend.ts` is what the MCP tools need from CopperOS, and `tools.ts` is the tool set written over it, shared with the hosted connector. |
| `broker/src/cloud/mcp*.ts`, `ai-apps.ts` | The hosted MCP connector: the Lambda (`mcp.ts`), its OAuth server (`mcp-oauth.ts`), sign-in through Cognito (`mcp-cognito.ts`), its table (`mcp-store.ts`), the tools' backend with the start guards (`mcp-backend.ts`), and what the person controls from Settings (`ai-apps.ts`). `agent-start.ts` and `chat-control.ts` start and stop tasks for both the relay and the connector. |
| `broker/src/cloud/welcome.ts`, `welcome-email.ts` | The welcome email sent once to each new account, and its template. |
| `broker/src/cloud/updates.ts`, `updates-email.ts`, `unsubscribe.ts` | The what's-new email: who it may go to, the signed Unsubscribe links, the careful send (once per person, opt-outs, retry), its template, and the public Unsubscribe function. `email-kit.ts` and `mail.ts` are what both emails share: the look, and sending through SES. |
| `extension/announcements.js` | The what's-new dialog's list: fetching it, and choosing what to show. |
| `broker/src/stub-extension.ts` | Fake extension for testing without Chrome. |
| `infra/` | AWS CDK app for the hosted backend: Cognito sign-in, the WebSocket API, the Lambdas, DynamoDB (including the usage ledger), S3, alarms. Secrets live in Parameter Store (free). `-c stage=guard` deploys the account's spending guard: a budget that brakes every CopperOS Lambda when the month's bill passes `spendCap` in cdk.json, plus cost anomaly emails (see `infra/lib/guard-stack.ts`, which also has the release command). |

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
  vision works, but is blind wherever the accessibility tree is (canvas, icon-only UIs).
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
