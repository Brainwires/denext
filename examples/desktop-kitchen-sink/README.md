# Desktop kitchen sink (every Deno Desktop capability, window-tested)

A denext desktop app that turns on every shipped Deno Desktop capability and calls each one from the
page, plus an automated window test that packages the app, launches it and asserts every result: the
keychain, files, SQLite, device facts, keep-awake, the clipboard (text, HTML, PNG), the shell,
native dialogs, the window API, drag and drop, the OS's notifications and context menu, the
application menu, a tray icon, the Dock / taskbar badge, global shortcuts, launch at login, the
DevTools switch, deep links and opened files, a second instance, the preload, the stable app origin,
a Node-API addon, the bridge's gate, custom-scheme auth sessions, passkeys, the Clerk bridge, links
between the export's pages (soft navigations, back, and a full-page load that keeps the bridge), a
platform-specific file (`components/PlatformBadge.desktop.tsx`, imported through the `@/` alias,
rendered and hydrated instead of the plain web file) and the full-app updater (a real update
installed, left unconfirmed and rolled back).

CI runs it on Linux, macOS (Apple silicon and Intel) and Windows
(`.github/workflows/desktop-window.yml`): nightly, and on pushes that touch the desktop code.

## Run it

```
deno task desktop            # export + open the window (denext's pinned runtime, Deno 2.9.7)
deno task desktop:package    # write scripts/package-*.ts from the scaffold, then package
deno task test:window        # package, launch and assert every check (exits 1 on a failure)
deno task drive start        # launch the last build in drive mode (the manual checks, scripted)
```

### `test:window` flags

| Flag                  | What it does                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--no-package`        | Reuse the last builds in `dist/` and their update key (the update build is kept per backend, `dist/update-<backend>/`)                                                               |
| `--no-update`         | Skip the full-app update install / trial / rollback launches                                                                                                                         |
| `--no-signing`        | Windows: skip the signing and trusted-update phases                                                                                                                                  |
| `--backend <b>`       | Package for `webview` or `cef` instead of `deno.json`'s `desktop.backend` (written for the packaging, then restored); with `--no-package`, the build in `dist/` must be that backend |
| `--runtime-dir <dir>` | Package with a local runtime build (`DENEXT_DESKTOP_RUNTIME_DIR`: `libdenort` plus `laufey/`, unverified)                                                                            |
| `--stock-runtime`     | Package with the stock Deno Desktop runtime (`DENEXT_DESKTOP_RUNTIME=stock`)                                                                                                         |
| `--results <file>`    | Also write the results document to `<file>`                                                                                                                                          |
| `--json`              | Print only the results document on stdout (the progress goes to stderr)                                                                                                              |

Without `--runtime-dir` or `--stock-runtime` the runtime is denext's pinned one
(`src/build/desktop-runtime-pin.json`), and the output's first lines name its version and the
backend. An unknown flag is an error. `KITCHEN_SINK_TIMEOUT_MS` (default 240000) bounds each launch.

The results document (`e2e/.run/results.json`, `--results`, `--json`) is the machine-readable run:

```jsonc
{
  "schema": 1,
  "os": "linux", "arch": "x86_64", "target": "x86_64-unknown-linux-gnu",
  "backend": "cef",
  "runtime": { "mode": "pinned", "version": "2.9.7-denext.13", "dir": null },
  "flags": { "noPackage": false, "backend": "cef", … },
  "ok": false,
  "summary": { "pass": 70, "skip": 3, "fail": 1, "problems": 1 },
  // what the runtime's session probe and the page's APIs report
  "facts": { "platformFeatures": { "available": true, "features": { … } },
             "appCapabilities": { … }, "windowCapabilities": { … }, "userAgent": "…" },
  "results": [{ "phase": "main", "name": "…", "status": "pass" | "skip" | "fail", "detail": "…", "ms": 12 }],
  "problems": ["…"]
}
```

A skip's `detail` is its reason; the output prints the same facts after the main phase.

Opened by hand, the window lists the checks and runs them on **Run checks**; the launch checks (a
cold-start deep link, a file the OS opens with the app, a link a second launch forwards) and the
updater checks are skipped there, because only the test runner sets them up.

### Manual release checks

Opened by hand (never under the window test), the window also shows **Manual release checks**:
buttons for the rows of CONTRIBUTING.md › _Manual desktop checks before a final release_ that need a
person at the screen. Nothing in the panel runs until you click.

- **Passkey**: _Create passkey_, then _Sign in with passkey_, through the `passkeys` capability, for
  the relying party in the panel's field (it defaults to the first RP pinned in
  `desktop.capabilities.passkeys.rpIds`, `denext.dev`; an RP not pinned answers `invalid_rp`). It
  shows whether the platform authenticator is ready (`passkeys.capabilities()`), then the credential
  id or the error code. Windows Hello needs no association between the app and the RP (set up a PIN
  in Settings › Accounts › Sign-in options first); macOS also needs the associated-domains
  entitlement, so an unentitled build answers `invalid_rp`. A macOS build for it sets
  `desktop.app.identifier` to an App ID with Associated Domains, and `desktop.macos` to that App
  ID's Developer ID provisioning profile plus
  `entitlements: { "com.apple.developer.associated-domains": ["webcredentials:<rp>"] }`; the RP
  serves `/.well-known/apple-app-site-association` listing `<TeamID>.<identifier>` under
  `webcredentials`. The passkey lands in the OS's passkey list (Windows: Settings › Accounts ›
  Passkeys); delete it there afterwards.
- **Backdrop**: none / mica / acrylic / tabbed (and vibrancy on macOS), with what
  `windowCapabilities()` reports; the page turns transparent while one is applied, so the whole
  window background should change.
- **HiDPI**: `devicePixelRatio`, the window bounds and every screen's scale factor (live), a test
  pattern drawn in device pixels (sharp only when the scale is right) and text, and _Save_ /
  _Restore placement_ for the size-and-position restore check across monitors and scales.

### Drive mode (the manual checks, with no one at the screen)

The checks a person answers (a file dialog, a notification click, the secure store's keyring, the
tray, the title bar, the window states, deep links) can also be driven from a command queue, so a
session reached over SSH, a nested X server or CI runs them without a screen or input injection (no
xdotool). `deno task drive start` launches the build `test:window` left in `dist/` (or
`--exe <app>`) in drive mode; every other verb queues one command, waits for the page's answer and
prints it as JSON:

```
deno task drive start                         # {"started": true, "pid": …}
deno task drive probe                         # platformFeatures(), appCapabilities(), windowCapabilities()
deno task drive maximize                      # each window command answers with the new state
deno task drive size '{"width":800,"height":600}'
deno task drive secure                        # secureStore set / get / delete, step by step
deno task drive native-dialog '{"kind":"open","cancelAfterMs":2000}'
deno task drive notify && deno task drive click-notification   # clicks it, prints its TAPPED event
deno task drive events --wait TRAY --since 2026-10-07T12:00:00Z  # the first one since then
deno task drive tray-on                       # tray clicks and menu items are TRAY events
deno task drive titlebar-watch                # each preference change is a TITLEBAR event
deno task drive commands                      # every command, with its arguments
deno task drive stop                          # quit the app and leave drive mode
```

A command exits 0 with its result, 1 when the page answered an error, and 2 on a timeout
(`--timeout <ms>`, 30 s by default; `open-dialog` / `save-dialog` / `folder-dialog` wait for a
person through the app's public API). `native-dialog` opens the runtime's own file dialog and closes
it through its `AbortSignal`, so a dialog (portal or GTK) is exercised with no one to cancel it;
`click-notification` clicks the newest notification through dunst's `dunstctl` or mako's `makoctl`
and waits for the page's `TAPPED` event (other servers: click it on the screen, then
`events --wait TAPPED`).

It is a folder protocol (`app/drive/protocol.ts`), so anything can drive it, not just the CLI: the
app enters drive mode when `kitchen-sink-drive.json` (`{ "dir": "<folder>" }`) is in its data folder
at launch (the window test's runner file wins over it), takes the oldest `<folder>/queue/*.json`
command (`{ "id", "cmd", "args"? }`; write it as `.tmp`, then rename), writes its answer to
`<folder>/results/<id>.json` and appends events (`TAPPED`, `TRAY`, `DEEPLINK`, `TITLEBAR`, `WINDOW`)
to `<folder>/events.jsonl`. The CLI's folder is `e2e/.drive` (`--dir`).

`deno task test:window` needs a display and a desktop session:

- **macOS**: a logged-in session. The clipboard checks put your clipboard text back afterwards.
- **Linux**: a window manager (maximize is a window-manager request on X11), an unlocked Secret
  Service for `secureStore` (the pinned runtime reaches it through libsecret, `libsecret-1-0` on
  Debian / Ubuntu; there is no `secret-tool` path) and a notification server.
  `e2e/linux-session.sh deno task test:window` runs it headless (Xvfb, xfwm4, a private D-Bus
  session, gnome-keyring, dunst), with `XDG_DATA_HOME` / `XDG_CONFIG_HOME` pointed at a scratch
  folder so a fresh login keyring is created there and yours is never touched.
- **Windows**: the interactive desktop session (from SSH, start it from an `/it` scheduled task).

### Window managers (nested sessions)

`e2e/wm-session.sh` runs a command in a nested session with the window manager or compositor you
pick, so tiling and stacking window managers are covered without switching your login session or
starting a VM:

```
e2e/wm-session.sh --wm i3 -- deno task test:window              # tiling, i3bar's XEmbed tray
e2e/wm-session.sh --wm openbox -- deno task test:window --backend cef
e2e/wm-session.sh --wm xfwm4 --display xephyr -- deno task test:window   # watch it in a window
e2e/wm-session.sh --wayland weston -- sh -c \
  'deno task drive start && deno task drive probe && deno task drive secure; deno task drive stop'
```

X11 sessions run on a private Xvfb (`--display xvfb`, the default, headless) or a Xephyr window on
your `$DISPLAY` (`--display xephyr`), with `i3`, `openbox`, `xfwm4` or any window manager that sets
`_NET_SUPPORTING_WM_CHECK`; Wayland sessions run weston or sway on their headless backends. Each
gets a private D-Bus session, gnome-keyring unlocked with a known password and dunst, with
`XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `XDG_RUNTIME_DIR` in a scratch folder, as `linux-session.sh`
does for CI. The session ends when the command does, so drive mode runs as one command (`sh -c` with
`drive start`, the commands, `drive stop`). Headless Wayland compositors give no client the keyboard
focus a clipboard needs, so `test:window`'s clipboard checks don't pass there (CEF stalls on them);
use Wayland sessions for drive mode, and X11 sessions for the window test. On a tiling window
manager the geometry checks (size round trip, min / max clamp, maximize / unmaximize) skip with the
reason: i3 reports its tiled windows as maximized and ignores an unmaximize, Sway leaves them
unmaximized, and either way the window fills its slot.

Its dependencies, as Debian / Ubuntu packages: `dbus x11-utils gnome-keyring libsecret-1-0 dunst`,
`xvfb` or `xserver-xephyr` and the window manager (`i3-wm`, `openbox`, `xfwm4`, …) for X11, `weston`
or `sway` for Wayland, and the app's libraries
(`libwebkit2gtk-4.1-0 libgtk-3-0
libsoup-3.0-0 libayatana-appindicator3-1`, and `libglib2.0-bin` for
`gio`, which `moveToTrash` runs; CEF also
`libnss3 libatk-bridge2.0-0 libcups2
libxkbcommon0 libgbm1 libasound2t64`). On a host you'd rather
not install them on, a container works (no VM; `seccomp=unconfined` lets CEF's sandbox create its
user namespaces):

```Dockerfile
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xvfb xserver-xephyr x11-utils dbus dbus-x11 gnome-keyring libsecret-1-0 dunst xdg-utils \
    desktop-file-utils i3-wm openbox xfwm4 weston sway libwebkit2gtk-4.1-0 libgtk-3-0 \
    libsoup-3.0-0 libayatana-appindicator3-1 libnss3 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
    libgbm1 libasound2t64 libglib2.0-bin ca-certificates curl unzip git fonts-dejavu-core
# Deno 2.9.7 exactly (the pinned runtime's): copy the binary in, or install it with deno's script.
COPY deno /usr/local/bin/deno
RUN useradd -m u
USER u
```

```
docker run --rm --security-opt seccomp=unconfined --shm-size=1g -v "$PWD:/src" \
  -w /src/examples/desktop-kitchen-sink <image> e2e/wm-session.sh --wm i3 -- deno task test:window
```

## What each check proves

| Area             | Through                                                 | Asserted                                                                                                                                                             |
| ---------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime          | `runtimePlatform()`, `Deno.desktop`                     | a desktop window on denext's pinned runtime                                                                                                                          |
| App origin       | `desktop.app.origin`                                    | `location.origin` is `kitchensink://app`                                                                                                                             |
| Bridge events    | the `echo` diagnostic capability                        | an event the runtime pushes reaches the page                                                                                                                         |
| Preload          | `desktop.preload`                                       | ran before the page's scripts, after the `__denext` global                                                                                                           |
| `secureStore`    | `secureStore` (`denext/mobile`)                         | the entry is in the OS keychain, then gone                                                                                                                           |
| `fs`             | `writeFile` / `readFile` / `listDir` / `deleteFile`     | the file is on disk in the data folder                                                                                                                               |
| `sqlite`         | `openSqlite`                                            | a native `node:sqlite` database, not OPFS                                                                                                                            |
| `device`         | `deviceInfo`                                            | the runtime's OS and model                                                                                                                                           |
| `keepAwake`      | the capability's `acquire` / `release`                  | the OS assertion is held and released                                                                                                                                |
| `clipboard`      | `writeClipboard` / `readClipboard` / `clipboardFormats` | text, HTML and a PNG round trip                                                                                                                                      |
| `shell`          | `moveToTrash`, `openExternal`                           | an app file goes to the trash; what the config forbids is refused                                                                                                    |
| `dialogs`        | `windowCapabilities().fileDialogs`                      | native dialogs exist; bad arguments are refused before a panel opens                                                                                                 |
| Window           | `denext/desktop/window`                                 | state, screens, size, min/max clamp, maximize, backdrop, a guarded close                                                                                             |
| Title bar        | `getTitleBarPreferences` (`denext/desktop/window`)      | the user's button side and order and double-click action (macOS left, Windows right, Linux the desktop's own)                                                        |
| Drag and drop    | `onFileDrop`, `startFileDrag`                           | the plumbing: no drag without a held button, no path escapes                                                                                                         |
| DevTools         | `desktop.inspectable` (unset)                           | off in the packaged app                                                                                                                                              |
| App menu         | `setAppMenu`, `onAppMenuItem` (`denext/desktop/app`)    | accelerators + roles accepted; a (synthetic) OS menu click reaches the page                                                                                          |
| Tray, Dock       | `createTray`, `setBadge`, `bounce`, `setQuickActions`   | a tray icon with bounds and a menu; the badge; the macOS Dock menu                                                                                                   |
| Notifications    | `scheduleNotification`, `pendingNotifications`, …       | scheduled and cancelled in the OS; a daily one 16 ahead; a (synthetic) click                                                                                         |
| Context menu     | the `contextMenu` capability                            | native with dismissal; bad items refused before it opens                                                                                                             |
| Shortcuts        | `registerShortcut` (`denext/desktop/app`)               | registered, listed, a (synthetic) press reaches the handler, released                                                                                                |
| Launch at login  | `getLaunchAtLogin` / `setLaunchAtLogin`                 | the state; toggled on and off on Windows and Linux                                                                                                                   |
| Deep links       | `onDeepLink`, `desktop.app.deepLinks`                   | a cold-start link, and one a second launch forwards (`singleInstance`)                                                                                               |
| Opened files     | `onOpenFile`                                            | a read-only handle that reads the file and refuses writes                                                                                                            |
| Node-API         | `@node-rs/crc32` in the `kitchen` extension             | a prebuilt `.node` loads in the packaged app                                                                                                                         |
| Main thread      | `ctx.runOnMainThread` in the `kitchen` extension        | a native thread-identity call runs on the UI thread, not the JavaScript thread                                                                                       |
| Full-app updater | `checkForAppUpdate` (`denext/desktop/updater`)          | a signed newer manifest is offered; another key, an older version and another app are refused                                                                        |
| Bridge gate      | the token-gated `/_denext/desktop/*` bridge             | a wrong token, a foreign-origin frame holding the token, and the token over plain TCP (the runtime's loopback relay) are all refused, and none reached the extension |
| OS auth session  | `Deno.desktop.authSession`, the `authSession` cap       | macOS: an unattended ephemeral round trip; Windows and Linux: `not_supported`, so `openAuthSession` uses the system browser                                          |
| Auth session     | `openAuthSession` (custom-scheme callback)              | Windows and Linux: the Cancel overlay shows; a forged-`state` callback leaves it pending; the real one completes it, and neither reaches `onDeepLink`                |
| Passkeys         | the `passkeys` capability (`rpIds` pinned)              | an unpinned RP is `invalid_rp` before the OS; the native path answers without a ceremony                                                                             |
| Clerk bridge     | `installClerkDesktopBridge` in the preload              | the token cache is in the keychain, the redirect URL, http: refused, `invalid_rp` turns native passkeys off                                                          |
| Update install   | `downloadAppUpdate`, `installAppUpdateAndRelaunch`      | a copy of the app installs a second signed build (99.0.0); its trial launch is left unconfirmed; the next launch rolls it back and refuses it from then on           |

Not automated: anything that needs a person at the screen (a real drop from the file manager,
dragging a file out, choosing in a native dialog or a context menu, pressing a shortcut, clicking a
notification, a tray icon or a menu, the macOS Automation prompt the first trash asks for, the macOS
login-item approval), a real passkey ceremony (the manual checks above), and an OS code-signature
check of an update between two Developer ID / Authenticode signed builds (the test's builds are
unsigned, so the updater runs with its dev-only `allowUnsignedDev`). The "synthetic" checks dispatch
the OS event on the runtime object that would fire it (through the `kitchen` extension), so
everything from the runtime's event to the page's handler runs. On macOS the first run asks for the
notification permission (answer it once); while it is refused, the scheduling checks are skipped.

## How it's wired

- `denext.config.ts` enables every capability and the pinned-runtime features (`app.origin`,
  `deepLinks`, `singleInstance`, `preload`, window size limits).
- `desktop/kitchen.ts` is the app's own desktop extension (`defineDesktopExtension`). It is the test
  harness: it tells the page whether the runner started it, writes the report, reads files from disk
  so the page can prove the native path ran, loads the Node-API addon and runs the updater checks.
- `app/drive/` is the drive mode: the driven page (`drive-panel.tsx`) and the folder protocol it
  shares with the `kitchen` extension and `e2e/drive.ts` (`protocol.ts`). `app/geometry.ts` is the
  tiling decision the geometry checks skip on, unit-tested in `tests/desktop-kitchen-sink.test.ts`
  with the protocol and the window test's flags.
- `e2e/window-test.ts` writes the packaging scripts from the current scaffold template, packages the
  app twice with this OS's script (least-privilege flags; the second build as version 99.0.0 into
  `dist/update/`), serves signed update manifests and the update archive on loopback (a throwaway
  key pair per run, baked into both builds), puts a stand-in system browser first on the app's
  `PATH` (it records the URL and opens nothing), launches the app with a link and a file, starts the
  second instances the page asks for, and checks the report. Then it runs a copy of the app through
  the full-app update (install, an unconfirmed trial launch, the rollback), each launch reporting
  its own checks, and writes `e2e/.run/results.json` (and, in GitHub Actions, the job summary, every
  skip with its reason).
- The runner tells the app it is under test with `kitchen-sink-runner.json` in the app's data folder
  (not the environment), so a process the updater relaunches finds it too.
