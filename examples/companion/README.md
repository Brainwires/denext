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

Loopy is a Gem-style double-oval clip in teal vinyl-coated wire, with two dot eyes and a small mouth
inside its top loop. Its moves (`data-state` on the SVG, drawn by `public/styles.css`):

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

The window is 260 × 300 with the title bar hidden and no backdrop: the speech bubble on top, Loopy
below it on the left, and **Fold up** / **Quit** in the bottom-right corner (faint until the pointer
is over the window). Drag Loopy to move the window. In a browser the same page shows five demo
buttons under Loopy instead.

## How it works

- `lib/loopy-machine.ts` — the state machine: a pure reducer over `show` / `say(mood)` / `blink` /
  `settle` / `dismiss`. The timed moves end after `stateDurationMs`, which matches their CSS.
- `components/Loopy.tsx`, `components/SpeechBubble.tsx` — the character (pure SVG) and the bubble
  (text, up to three buttons, a close button, auto-dismiss).
- `lib/companion-state.ts` — the machine plus the message queue: a message springs Loopy up in its
  mood, the next one takes over when a bubble closes, and folding up drops them all.
- `app/companion.tsx` — the client component: runs the reducer and the timers, listens for the
  inbox's messages (`onDesktopEvent("loopy", "say", …)`) and sets up the window.
- `lib/window-setup.ts` — `denext/desktop/window`: `windowCapabilities()` first, then
  `setAlwaysOnTop(true)` and, where windows can be placed (not Wayland), the bottom-right corner of
  the primary display's work area (`getScreens()`); `makeWindowDraggable` on Loopy. Each step is
  skipped where it's unsupported, and off desktop all of them are.
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

| Field       | Type                                                | Default                                |
| ----------- | --------------------------------------------------- | -------------------------------------- |
| `text`      | 1–500 characters                                    | required                               |
| `mood`      | `neutral` \| `thinking` \| `attention` \| `success` | `neutral`                              |
| `actions`   | up to 3 `{ id, label }`                             | none                                   |
| `timeoutMs` | `0` (until closed) or 1000–120000                   | by length; until closed with actions   |
| `wait`      | hold the response until a button or the close       | `false` (answers `202 { id }` at once) |

The token is generated on the first run and kept, with the port, in `loopy-inbox.json` in the app's
data folder (`~/Library/Application Support/dev.denext.loopy/` on macOS,
`%APPDATA%\dev.denext.loopy\` on Windows, `~/.local/share/dev.denext.loopy/` on Linux; `LOOPY_INBOX`
names another file). The file is owner-only (mode 0600) on macOS and Linux, and the app prints its
path at launch. The inbox refuses a request that names a non-loopback host (403), carries an
`Origin` header — every browser cross-origin POST does, so no web page can reach it (403) — or lacks
the token (401); a body over 16 KiB is a 413.

## Today vs. later

Works today, on denext's pinned Deno Desktop runtime: the small hidden-title-bar window, always on
top, placed bottom-right, dragged by Loopy; every animation; the inbox and `--wait` replies; the
Claude Code hooks. On the stock runtime the window works without the corner placement.

Needs window support denext doesn't have yet, so Loopy is an opaque card rather than a character
standing on the desktop: a transparent, frameless window; clicks passing through everywhere but
Loopy and its bubble; a window that never takes focus from the app you're typing in; no Dock or
taskbar entry; staying visible on every Space and over full-screen apps; and reading text aloud.

## Tests

```sh
deno test -A tests/examples-companion.test.ts               # from the repo root
deno test -A tests/integration/example-companion.test.ts    # exports a copy of the app
```

The unit tests cover the state machine and the message queue, the message validation, the bubble and
the character (rendered with `denext/testing`), the corner placement, the inbox handler (token,
browser and host rejections, size and type limits, waits), the inbox file and the CLI's argument and
hook parsing.
