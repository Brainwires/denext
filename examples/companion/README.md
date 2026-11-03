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

The window is a 260 × 300 transparent, frameless overlay in the bottom-right corner: the speech
bubble on top, Loopy below it on the left, and **Fold up** / **Quit** in the bottom-right corner
(faint until the pointer is over them). It never takes the focus from the app you are typing in,
floats above other windows on every Space, and has no Dock or taskbar entry: the tray icon shows and
hides Loopy and quits. Drag Loopy to move it. In a browser the same page shows five demo buttons
under Loopy instead.

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
- `lib/speech.ts` — **Voice on** reads each bubble aloud (its text, then its buttons as the choices)
  with `speak()` from `denext/mobile`: the window's Web Speech where it has one, else the OS engine
  through the desktop runtime (`Deno.desktop.speech`; speech-dispatcher on Linux). Off until turned
  on; the toggle is kept in `localStorage`.
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
deno test -A tests/integration/example-companion.test.ts    # exports a copy of the app
```

The unit tests cover the state machine and the message queue, the message validation, the bubble and
the character (rendered with `denext/testing`), the corner placement, the inbox handler (token,
browser and host rejections, size and type limits, waits), the inbox file and the CLI's argument and
hook parsing.
