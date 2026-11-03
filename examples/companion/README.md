# Loopy (a desktop companion)

Loopy is a small animated paper clip that sits on top of your desktop, talks in speech bubbles and
reacts to what other programs tell it. It is a denext desktop app: one App Router page drawn in
hand-written SVG and CSS, a state machine for its moves, and a token-protected loopback inbox that
scripts — a build, a test run, a [Claude Code hook](./claude-code/) — post messages to.

## Run it

```sh
denext task desktop    # export + open Loopy's window (denext's pinned Deno Desktop runtime)
denext task dev        # the same page in a browser, with demo buttons for every move
```

Then, from another terminal:

```sh
denext task say "Tests passed" --mood success
denext task say "Deploy to staging?" --action yes:Deploy --action no:Later --wait
```

`--wait` prints the id of the button pressed (nothing when the bubble was closed).

## What you see

Loopy is two triangular clips in teal vinyl-coated wire, crossed into a little figure with a steel
bead head: big eyes under expressive brows and a small mouth. Its moves (`data-state` on the SVG,
drawn by `public/styles.css`):

| Move        | When                                   | What it looks like                                        |
| ----------- | -------------------------------------- | --------------------------------------------------------- |
| `appear`    | launch, or a message while folded away | springs up out of the desk, overshoots, settles           |
| `idle`      | nothing to say                         | sways gently about its bottom bend                        |
| `blink`     | every few seconds while idle           | the eyes close for 160 ms                                 |
| `think`     | a `thinking` message                   | tilts back, eyes up, a trail of pulsing dots              |
| `point`     | an `attention` message                 | its outer leg unbends and points up at the bubble         |
| `celebrate` | a `success` message                    | two hops, a wiggle and a few sparkles                     |
| `dismiss`   | **Fold up**                            | folds flat into the desk                                  |
| (squash)    | clicking its face                      | squash-and-stretch (Web Animations) and a line of its own |

The window is a 325 × 375 (Loopy's default size, 125 % of a 260 × 300 base) transparent, frameless
overlay in the bottom-right corner: the speech bubble on top, Loopy below it on the left, and **Fold
up** / **Quit** in the bottom-right corner (faint until the pointer is over them). It never takes
the focus from the app you are typing in, floats above other windows on every Space, and has no Dock
or taskbar entry: the tray icon shows and hides Loopy and quits. Drag Loopy to move it. In a browser
the same page shows five demo buttons under Loopy instead.

## How it works

- `lib/loopy-machine.ts` — the state machine: a pure reducer over `show` / `say(mood)` / `blink` /
  `settle` / `dismiss`. The timed moves end after `stateDurationMs`, which matches their CSS.
- `components/Loopy.tsx`, `components/SpeechBubble.tsx` — the character (pure SVG) and the bubble
  (text, up to three buttons, a close button, auto-dismiss).
- `lib/companion-state.ts` — the machine plus the message queue: a message springs Loopy up in its
  mood, the next one takes over when a bubble closes, and folding up drops them all.
- `app/companion.tsx` — the client component: runs the reducer and the timers, listens for the
  inbox's messages (`onDesktopEvent("loopy", "say", …)`) and sets up the window.
- `denext.config.ts` — the overlay window (`desktop.window`: `frameless`, `transparent`,
  `focusable: false`, `alwaysOnTop: "status"`, `visibleOnAllWorkspaces`, `skipTaskbar`, and
  `overlay` for a layer-shell surface on Linux Wayland), no Dock icon from the first frame
  (`desktop.app.activationPolicy: "accessory"`) and the tray (`desktop.tray`, handled in
  `desktop.ts`).
- `lib/speech.ts` — **Read aloud on** reads each bubble aloud (its text, then its buttons as the
  choices) with `speak()` from `denext/mobile`: the window's Web Speech where it has one, else the
  OS engine through the desktop runtime (`Deno.desktop.speech`; speech-dispatcher on Linux). Off
  until turned on; the toggle is kept in `localStorage`.
- `lib/window-setup.ts` + `lib/click-through.ts` — `denext/desktop/window`: `windowCapabilities()`
  first; a transparent background where the window is transparent; clicks through everywhere but
  Loopy, its bubble and its buttons (`setHitRegion` over their rectangles, else
  `setIgnoreMouseEvents(true, { forward: true })` toggled over them, else nothing); where the window
  can be placed (`setPosition`: not on Wayland, except as a layer-shell overlay), the bottom-right
  corner of the primary display's work area (`getScreens()`, `lib/placement.ts`);
  `makeWindowDraggable` on Loopy. Each step is skipped where it's unsupported, and off desktop all
  of them are.
- `desktop.ts` + `inbox/` — after `runDesktop`, a second `Deno.serve` on `127.0.0.1` (port 47833,
  `LOOPY_PORT`, or a free one when it's taken) serves `POST /api/loopy/say` and pushes each message
  to the page with the runtime's `emit`. A button press comes back on the window's own origin
  (`POST /_loopy/reply`) and answers a sender that asked to `wait`.

### The inbox

```http
POST /api/loopy/say
Authorization: Bearer <token>
Content-Type: application/json

{ "text": "Build failed", "mood": "attention", "actions": [{ "id": "open", "label": "Show me" }], "wait": true }
```

| Field       | Type                                          | Default                                |
| ----------- | --------------------------------------------- | -------------------------------------- |
| `text`      | 1–500 characters                              | required                               |
| `mood`      | one of the moods below                        | `neutral`                              |
| `actions`   | up to 3 `{ id, label }`                       | none                                   |
| `timeoutMs` | `0` (until closed) or 1000–120000             | by length; until closed with actions   |
| `wait`      | hold the response until a button or the close | `false` (answers `202 { id }` at once) |

Moods. Each one tints Loopy's wire and changes its face; some add an extra and a move.

| Mood        | Wire       | Face and extras                                                           |
| ----------- | ---------- | ------------------------------------------------------------------------- |
| `neutral`   | bare steel | big eyes, a small smile                                                   |
| `thinking`  | violet     | eyes up, a flat mouth, a trail of thought dots                            |
| `attention` | amber      | brows up, a little "o", points at the bubble                              |
| `success`   | green      | a big grin, two hops and sparkles                                         |
| `confused`  | purple     | one brow up, eyes looking two ways, a wavy mouth, a wobbling `?`          |
| `mad`       | red        | brows down, a frown, steam, a shake                                       |
| `sad`       | blue       | brows up in the middle, a frown, a falling tear, a droop                  |
| `excited`   | orange     | a wide open grin, hops                                                    |
| `sleepy`    | slate      | eyes nearly shut, floating z's, a slow nod                                |
| `love`      | pink       | heart eyes, blush, floating hearts                                        |
| `surprised` | yellow     | wide eyes, a small "o", a popping `!`                                     |
| `shocked`   | cyan       | brows sky-high, tiny pupils, a tall open mouth, zap lines, a jitter       |
| `wow`       | gold       | dark oval eyes; after a beat the mouth says "wow" once: small, big, small |

The token is generated on the first run and kept, with the port, in `loopy-inbox.json` in the app's
data folder (`~/Library/Application Support/dev.denext.loopy/` on macOS,
`%APPDATA%\dev.denext.loopy\` on Windows, `~/.local/share/dev.denext.loopy/` on Linux; `LOOPY_INBOX`
names another file). The file is owner-only (mode 0600) on macOS and Linux, and the app prints its
path at launch. The inbox refuses a request that names a non-loopback host (403), carries an
`Origin` header — every browser cross-origin POST does, so no web page can reach it (403) — or lacks
the token (401); a body over 16 KiB is a 413.

## Voice

Loopy is also a voice assistant: you talk, it answers out loud, on OpenAI's
[Realtime API](https://developers.openai.com/api/docs/guides/realtime) (`gpt-realtime-2.1`, voice
`marin`) over WebRTC. It needs your own OpenAI API key.

**The key.** Open **⚙ Settings** and paste it into the key field. In the desktop app it goes into
the OS keychain (`denext desktop add secure-store`: the macOS Keychain, the Secret Service on Linux,
PasswordVault on Windows) under the app's identifier. The field is write-only: you can save, replace
or clear the key, but nothing ever shows it or sends it back to the page. In a browser
(`denext task dev`) the key comes from the dev server's environment instead:

```sh
OPENAI_API_KEY=… denext task dev
```

**Talking.** Each way can be turned on or off in Settings:

| How                              | Default | Notes                                                                              |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| Hold **Space**                   | on      | while Loopy's page has the focus; release to send                                  |
| Click Loopy                      | on      | click again to send (while it is on, a click talks instead of poking)              |
| **CommandOrControl+Shift+Space** | off     | from any app (desktop app, `global-shortcuts`): press to talk, press again to send |
| "Hey Loopy"                      | —       | coming soon                                                                        |

The microphone is on only during a turn: the session has no voice-activity detection, the track is
disabled between turns, and a turn shorter than 250 ms is dropped.

**What you see.** While you talk Loopy listens (its head swells and glows with the microphone's
level) and your words appear in the bubble as they are transcribed. Then it thinks, then speaks: its
mouth opens and closes with the level of its own voice (lip-sync), and the reply's transcript
follows in the bubble. The model sets Loopy's mood as it talks through a `set_mood` tool whose
values are the 13 moods above, so a happy answer hops and a puzzled one wobbles a `?`. The
transcript fades a few seconds after the reply.

**Size.** Settings has a size slider (75–250 %, 125 % by default; `?scale=150` or `?scale=1.5` in
the URL overrides it in dev). Loopy and its bubble scale together, and the desktop window grows or
shrinks to fit about its bottom-right corner, the click-through region following.

### How the voice works

- `voice/` runs in Deno only: in the desktop app as the `loopyVoice` capability
  (`voice/extension.ts`, called through the runtime's bridge), in the browser as `POST /api/voice`
  (`app/api/voice/route.ts`; loopback host, same origin and JSON only). `voice/service.ts` answers
  `status` (is a key set; never the key), `setKey`, `clearKey`, `session` (with the tools switched
  on), `configure` (a switch changed mid-session), `tool`, `confirm` (your Yes or No), `remember`,
  `memories`, `forget` and `forgetAll`, each rate-limited.
- `session` mints an ephemeral client secret (`POST /v1/realtime/client_secrets`, valid for 60 s,
  `voice/realtime.ts`) with Loopy's session: its persona, push-to-talk turns
  (`turn_detection: null`), input transcription (`gpt-4o-mini-transcribe`) and the tools. The page
  gets the secret and its expiry only; OpenAI's error bodies are never passed on.
- `desktop.ts` takes the `secureStore` capability out of the page's bridge and gives it to the voice
  backend alone (`voiceCapabilities`), so the page can't read the key through it.
- `lib/realtime-client.ts` opens the microphone, posts the SDP offer to `/v1/realtime/calls` with
  the secret, plays the model's track and exchanges events on the `oai-events` data channel.
  `lib/voice-machine.ts` turns them into Loopy's state; `lib/lip-sync.ts` turns audio levels into
  mouth and pulse steps; `lib/use-voice.ts` runs the turns.
- Tools: the model's function calls arrive in `response.done`; `lib/tool-relay.ts` relays each to
  the backend's registry (`voice/tools.ts`), sends the output back as a `function_call_output` and
  asks for the rest of the reply. Every tool runs in Deno, never in the page (see Tools below).

### Tools

Besides `set_mood`, Loopy has three tools, each switched on or off under **⚙ Settings → Tools** (at
any time: a switched-off tool leaves the open session and refuses calls):

| Tool                                                                | Default | What it does                                         |
| ------------------------------------------------------------------- | ------- | ---------------------------------------------------- |
| `web_search`                                                        | on      | answers current questions; the sources show as links |
| `browser_open` / `_read` / `_click` / `_type` / `_scroll` / `_back` | off     | drives a Chrome window you can watch                 |
| `recall`                                                            | off     | searches past conversations (Memory)                 |

**Web search** (`voice/web-search.ts`): the backend calls OpenAI's
[Responses API](https://developers.openai.com/api/docs/guides/tools-web-search) with its built-in
`web_search` tool (`gpt-6-luna`, `search_context_size: "low"`, `store: false`) on the same key. The
voice model gets a short answer, wrapped as untrusted web data, and the source titles; the bubble
shows the sources (citations first, then the consulted pages, http(s) only, at most five) as links
that open in your own browser (`openExternal`; on desktop the `shell` capability, limited to
`https:` and `http:`).

**The browser** (`voice/browser-tools.ts`, `voice/chrome.ts`, `@astral/astral`): your installed
Google Chrome or Chromium, started visible on first use with a fresh profile in Loopy's data folder
(`.loopy/browser-profile` in dev), and closed when Loopy quits or the switch goes off. The model
opens a page, reads it (its text and a numbered list of links, buttons and inputs), then clicks,
types, scrolls or goes back by number. The rules are enforced in code (`voice/browser-safety.ts`,
`voice/post-gate.ts`, `voice/confirm.ts`):

- only `http:` and `https:` addresses open;
- page content goes back to the model wrapped in `<untrusted_page_data>` and labelled as data, not
  instructions (a page can't close the block early);
- it never types into password, payment-card or one-time-code fields (by `type`, `autocomplete`,
  name, id, label and placeholder), and typing sets the field's value without key presses (no Enter,
  no implicit submit); field values are never read back;
- a click on anything submit-like (a submit button, a button in a form that posts, anything labelled
  like Pay, Send, Delete or Place order) asks first: Loopy's bubble shows the question with **Yes**
  / **No**, and only Yes clicks. A navigation that posts data while Loopy acts is held in the
  browser (DevTools `Fetch` interception of documents) and asked about the same way; what you do in
  the window yourself is never held;
- no downloads (`Browser.setDownloadBehavior: deny`), no file uploads (file inputs are refused and
  file choosers never answered), no pop-ups (`--block-new-web-contents`), and JavaScript dialogs are
  dismissed.

**Memory** (`voice/memory.ts`, `voice/memory-store.ts`, `lib/turn-memory.ts`): while it is on, each
finished turn (what you said and Loopy's whole reply) is kept in SQLite (`node:sqlite`) in
`loopy-memory.db` in the app's data folder (`.loopy/` in dev), owner-only, with an OpenAI embedding
(`text-embedding-3-small`, 512 dimensions), and searched by cosine similarity in plain JS. A new
session's instructions carry the memories closest to your latest conversations, and the model can
`recall(query)` the rest. Off means nothing is written: the page sends no turns and the backend
refuses them, and the file isn't created until the first memory. **Settings → Memories** lists them
newest first with their dates; forget one, or all (deleted rows are overwritten and the file
vacuumed).

**Permissions** (`denext.config.ts`): `net` is `api.openai.com` only (sessions, web search and
embeddings; the browser's DevTools socket is loopback, in the baseline), `run` is Chrome's or
Chromium's install path on each OS and nothing else, and `write` is the app's data folder (the inbox
file, the memory database, the browser profile).

**Not yet in the desktop app.** The desktop window can't capture audio yet (the Deno Desktop runtime
has no microphone permission handling), so in the app Loopy says it can't hear you and points at the
browser; everything else (the key, the settings, the size) works there. The window also never takes
the keyboard focus, so in the app use the click or the global shortcut rather than Space.

## Where it works

On denext's pinned Deno Desktop runtime (3.0.0-denext.7): the transparent, frameless overlay on
macOS, Linux and Windows' WebView2 (the CEF backend paints it opaque); clicks passing through
everywhere but Loopy, its bubble and its buttons (`setHitRegion`); no Dock icon on macOS from the
first frame; the tray; every animation; reading aloud; the inbox and `--wait` replies; the Claude
Code hooks. On macOS, Windows and Linux X11 it also never takes the focus, stays on top (at the
`"status"` level and on every Space, over full-screen apps too, on macOS; Windows and Linux have one
floating level), stays off the taskbar (Windows, Linux) and sits in the bottom-right corner.

Linux on Wayland is narrower, because a Wayland window can't ask to be placed, kept on top, shown on
every workspace, left off the taskbar or kept from taking the focus:

- **KDE Plasma and wlroots compositors** (Sway, Hyprland, …), with `libgtk-layer-shell0` installed
  (Kubuntu does not install it by default) and runtime 3.0.0-denext.7 or later: `overlay: true`
  makes Loopy a layer-shell surface, so it is on top, on every workspace, off the task manager and
  never focused. A layer surface can be placed (`windowCapabilities().setPosition` says so for it),
  so Loopy goes to the bottom-right corner. GDK reports the whole display as the work area on
  Wayland, so Loopy keeps 64 px clear of every edge (`WAYLAND_PANEL_INSET` in `lib/placement.ts`),
  room for a taskbar it can't see, and counts its position from the display's top-left (a layer
  surface's margins). Before 3.0.0-denext.7 Loopy is an ordinary window there, opens where KWin puts
  it with a title bar around it, and at 800 × 600 on every Linux desktop.
- **GNOME** (Mutter has no layer-shell): an ordinary window, where Mutter puts it, focused when it
  opens, under the windows you raise, on one workspace and in the dock.

Each window feature is checked with `windowCapabilities()` first, so on an older runtime Loopy still
runs, catching every click in its window and showing a Dock icon for a moment at launch.

## Tests

```sh
deno test -A tests/examples-companion.test.ts               # from the repo root
deno test -A tests/examples-companion-tools.test.ts         # the tools
deno test -A tests/integration/example-companion.test.ts    # exports a copy of the app
```

The unit tests cover the state machine and the message queue, the message validation, the bubble and
the character (rendered with `denext/testing`), the corner placement, the inbox handler (token,
browser and host rejections, size and type limits, waits), the inbox file and the CLI's argument and
hook parsing; and the voice: the client-secret request (against a fake fetch) and its refusals, the
key store and that no call returns the key, the dev route's checks, the tool registry and relay, the
voice state machine, the WebRTC exchange (with fake peers), the microphone messages, lip-sync levels
and mouth shapes, the settings and the size math and anchoring.
`tests/examples-companion-tools.test.ts` covers the tools without OpenAI, a key or a browser window:
web search against a fake fetch, the browser's rules and tools against a fake browser (the URL
check, the untrusted wrapping, the field refusals, submit detection, the post gate and the
confirmations), the memory store on an in-memory database with fake embeddings, cosine ranking, the
toolset's feature switches, the backend's new operations, and the page's relay, turn recording,
bubble and settings.
