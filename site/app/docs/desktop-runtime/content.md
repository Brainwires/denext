---
title: "Our Deno Desktop runtime: what we ship and why"
slug: desktop-runtime
lead: denext ships Deno Desktop at Electron parity today on a prebuilt runtime from public forks of Deno and laufey. This page lists every change in it, the problem each one solves, how it is tested and verified, and how it retires as the work lands upstream.
---

A denext desktop app is a [Deno Desktop](https://deno.com) app. Stock Deno Desktop already gives
you a native window around your app with no bundled Chromium. denext goes further, to Electron
parity, by shipping a prebuilt **Deno Desktop runtime** built from two public forks:
[Brainwires/deno](https://github.com/Brainwires/deno) (Deno 2.9.7 plus the desktop patches) and
[Brainwires/laufey](https://github.com/Brainwires/laufey) (the native window hosts Deno Desktop
uses). You don't install anything for it: `denext desktop` and the packaging scripts fetch it,
verify it and use it.

## Why a custom runtime at all

denext's promise is **write it once, ship it everywhere**: one codebase becomes a web app, an iOS
and Android app, and a macOS, Windows and Linux app. On the desktop that promise means Electron
parity. An app that runs on Electron today, with its sign-in provider, its deep links, its menus,
its notifications and its auto-updater, has to run on denext without a rewrite and without
bundling a browser engine.

Stock Deno Desktop 2.9.7 is a good foundation for that, and it couldn't carry a real app the
whole way. The app that forced the issue was [T3 Code](https://github.com/pingdotgg/t3code): its
desktop build signs in to T3 Connect through Clerk, and the sign-in never worked. Clerk checks the
page's `Origin`, Deno Desktop served the page from `http://127.0.0.1:<random port>`, and Clerk's
Frontend API answered `origin_invalid`. With a custom-scheme origin (`t3code://app`) it accepted
the same request, from the server and from the page. Looking further, stock Deno Desktop 2.9.7
also:

- lost `localStorage` and IndexedDB on every launch, because the loopback port, and so the
  origin, changes each time
  ([denoland/deno#35444](https://github.com/denoland/deno/issues/35444)). On the CEF backend
  nothing persisted at all: each process got a fresh profile in `/tmp/laufey_cef_<pid>`;
- declared a deep-link event (`DesktopEvent::OpenUrl`) that nothing ever emitted, and had no
  single-instance lock;
- could not cancel a window close or quit the app from code, and had no maximize, minimize or
  fullscreen state, size limits or screen list;
- had no native file dialogs, drag-and-drop paths, global shortcuts, launch at login, passkeys or
  OS sign-in sessions, and the clipboard was text only;
- folded notification actions into `click`, had no scheduled notifications, and dropped the click
  that launched the app;
- crashed the first time a Node-API addon was called on Windows
  ([denoland/deno#36596](https://github.com/denoland/deno/issues/36596));
- updated itself by patching the runtime library in place with bsdiff, which breaks a signed
  macOS `.app`'s code signature, runs on Unix only, treats the signature as optional and has no
  downgrade guard.

**Why we didn't wait for upstream.** Some of these already had open upstream pull requests, a few
of them for months; others had none. denext 3.1 promised desktop apps that work now, so we did the
work, and we offer every change upstream as it is ready (see [Upstream first](#upstream-first)).

**Why prebuilt, and why public forks.** The runtime is a full-LTO Rust build of `libdenort` plus
laufey's native hosts and CEF, for five targets. Asking every app author to build that is a
non-starter, so denext downloads a prebuilt archive, pinned by SHA-256. Building it in public, in
forks anyone can read, from commits each release names, with build provenance attestations, means
you never have to trust a binary you can't trace back to source (see
[Supply chain and trust](#supply-chain-and-trust)).

**The exit criterion.** The fork is a bridge, not a destination. When stock Deno ships all of it,
denext uses the stock runtime and the forks are archived.

## What it is

The runtime is the part of Deno Desktop an app is embedded into: the `libdenort` library and
laufey's backend hosts (`webview` and `cef`). It is published as GitHub releases tagged
`denext-runtime-v2.9.7-denext.<n>` on the Deno fork, one archive per target and backend:

| Target               | Backends         |
| -------------------- | ---------------- |
| macOS arm64          | `webview`, `cef` |
| macOS x86_64 (Intel) | `webview`, `cef` |
| Linux x86_64         | `webview`, `cef` |
| Linux arm64          | `webview`, `cef` |
| Windows x86_64       | `webview`, `cef` |

Each release carries a `SHA256SUMS` file, a `manifest.json` (URL, SHA-256 and size per target and
backend, plus the Deno and laufey commits it was built from) and a build provenance attestation for
every archive.

The `deno` CLI itself is **not** replaced. Your stock `deno desktop` does the build; denext points
it at the runtime through two environment variables the CLI already reads, `DENORT_DESKTOP_BIN`
(the runtime library) and `LAUFEY_DEV_DIR` (the backend hosts).

Three layers carry the changes below:

- **laufey**: the native hosts (WKWebView, WebView2, WebKitGTK, CEF) and their C ABI. Built from
  `denext/integration` on [Brainwires/laufey](https://github.com/Brainwires/laufey).
- **Deno runtime**: `libdenort` and the `Deno.desktop` APIs on top of laufey. Built from
  `denext/v2.9.7` on [Brainwires/deno](https://github.com/Brainwires/deno).
- **denext**: the pin, the launcher and packager, and the `denext/desktop` and `denext/mobile`
  APIs your app calls.

## What it adds over stock Deno Desktop

Every change the runtime carries, with what it is, why it exists, the layer it lives in and where
it stands upstream. "Planned" means the change is not yet offered upstream; no Deno pull request of
ours is open yet.

| Change                                                                                       | Layer                | Upstream                                                                     |
| -------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------- |
| [A stable app origin](#a-stable-app-origin)                                                  | Deno runtime, denext | builds on deno#35675; ours planned                                           |
| [Custom schemes as secure origins](#custom-schemes-as-secure-origins)                        | laufey               | [laufey#84](https://github.com/littledivy/laufey/pull/84)                    |
| [Request and response bodies on Linux](#request-and-response-bodies-on-linux)                | laufey               | [laufey#86](https://github.com/littledivy/laufey/pull/86); rest planned      |
| [Per-app persistent storage](#per-app-persistent-storage)                                    | laufey, Deno runtime | [laufey#88](https://github.com/littledivy/laufey/pull/88); Deno side planned |
| [The launch configuration file](#the-launch-configuration-file)                              | laufey, Deno, denext | [laufey#87](https://github.com/littledivy/laufey/pull/87)                    |
| [The app identifier](#the-app-identifier)                                                    | Deno runtime         | builds on deno#35662; ours planned                                           |
| [Deep links, opened files and single instance](#deep-links-opened-files-and-single-instance) | laufey, Deno, denext | builds on laufey#77; ours planned                                            |
| [Scheme registration with the OS](#scheme-registration-with-the-os)                          | Deno runtime         | planned                                                                      |
| [Native passkeys](#native-passkeys)                                                          | laufey, Deno, denext | planned                                                                      |
| [OS sign-in sessions and main-thread code](#os-sign-in-sessions-and-main-thread-code)        | laufey, Deno, denext | builds on laufey#79; ours planned                                            |
| [The window API](#the-window-api)                                                            | laufey, Deno, denext | builds on deno#36761, #36789, laufey#80, #81                                 |
| [Device-independent sizing on Windows](#device-independent-sizing-on-windows)                | laufey               | planned                                                                      |
| [Streaming on WebView2](#streaming-on-webview2)                                              | laufey               | planned                                                                      |
| [Drag and drop](#drag-and-drop)                                                              | laufey, Deno, denext | planned                                                                      |
| [Native file dialogs](#native-file-dialogs)                                                  | laufey, Deno, denext | planned                                                                      |
| [The rich clipboard](#the-rich-clipboard)                                                    | laufey, Deno, denext | planned                                                                      |
| [Global shortcuts](#global-shortcuts)                                                        | laufey, Deno, denext | planned                                                                      |
| [Launch at login](#launch-at-login)                                                          | laufey, Deno, denext | planned                                                                      |
| [DevTools control](#devtools-control)                                                        | laufey, Deno, denext | planned                                                                      |
| [Menus, accelerators and close events](#menus-accelerators-and-close-events)                 | laufey, Deno, denext | planned                                                                      |
| [Notifications](#notifications)                                                              | laufey, Deno, denext | planned                                                                      |
| [Node-API addons on Windows](#node-api-addons-on-windows)                                    | Deno runtime         | planned (Linux half upstream in deno#36718)                                  |
| [Signed full-app self-updates](#signed-full-app-self-updates)                                | Deno runtime, denext | builds on deno#36421; ours planned                                           |
| [Reliability fixes](#reliability-fixes)                                                      | laufey               | planned                                                                      |
| [Build fixes](#build-fixes)                                                                  | laufey               | [laufey#85](https://github.com/littledivy/laufey/pull/85)                    |
| [Cargo-style concurrency locks](#cargo-style-concurrency-locks)                              | Deno CLI             | in progress for upstream                                                     |

The [Desktop apps](/docs/desktop) guide covers each of these from the page's side.

### A stable app origin

- **What:** `desktop.app.origin` (`myapp://app`) serves the app from a custom scheme. A scheme
  handler bridges each request into `Deno.serve` over an in-process memory transport
  (`DENO_SERVE_ADDRESS=memory:<name>`), and WebSockets go through a loopback relay that accepts an
  upgrade only when the `Origin` header is byte-exact to the app origin (403 otherwise, 400 for a
  non-upgrade request, 421 for another host on the scheme). The page is a secure context, `fetch`
  streams, and cross-origin requests carry `Origin: myapp://app`.
- **Why:** the loopback origin changes every launch, so web storage was wiped each time
  (deno#35444), and Clerk's Frontend API answers `origin_invalid` for it while it accepts
  `t3code://app`. Two hardening fixes ride along: an absolute-form request target over TCP can't
  claim an `http+memory:` URL (400), and the relay times out a request head that never arrives.
  denext's bridge trusts a request only when `Deno.serve` reports the memory transport, never from
  the URL. The runtime marks what its relay forwards (`x-deno-desktop-relay`, stripped from client
  input); on such a request denext accepts only a WebSocket upgrade with the exact `Origin`, never
  serves `/_denext/desktop/*` and never injects the per-launch token.
- **Layer:** Deno runtime; denext writes the origin into the package (an embedded
  `.deno-desktop/app.json`, so the stock CLI can carry it) and gates its bridge on the transport.
- **Upstream:** the memory transport is ported from
  [denoland/deno#35675](https://github.com/denoland/deno/pull/35675); the configured origin is
  planned.

### Custom schemes as secure origins

- **What:** a scheme the embedder registers (`myapp`, not only the built-in `app`) is a real
  origin on WKWebView, WebKitGTK, WebView2 and CEF: `location.origin` is `myapp://app`, it is a
  secure context, same-origin `fetch` streams, cross-origin requests carry the `Origin` header
  with CORS applied, and `localStorage` and IndexedDB are per origin. The handler is registered
  before the first window, because WebKit reads it when the web view is created.
- **Why:** laufey accepted any scheme name but served only `app` as an origin, so the stable
  origin above had nothing to stand on. The same change fixes two existing bugs: WebKitGTK sent
  responses with no MIME type, and CEF passed the charset as the MIME type.
- **Layer:** laufey.
- **Upstream:** [littledivy/laufey#84](https://github.com/littledivy/laufey/pull/84), "serve
  embedder-registered custom schemes as secure origins on every backend" (open). It includes and
  credits the CEF sub-process fix of [laufey#34](https://github.com/littledivy/laufey/pull/34) by
  @yyq1025.

### Request and response bodies on Linux

- **What:** on WebKitGTK, a custom-scheme request's body reaches the runtime, and a response body
  is a pollable in-memory stream instead of a pipe.
- **Why:** every `POST`, `PUT` or `PATCH` to the app on Linux arrived with an **empty body**, so
  Server Actions and API routes got nothing. On the way back, the pipe's blocking write stalled
  the runtime's event loop as soon as 64 KiB sat unread. Now writes never block, and a response
  past 64 MiB unread fails cleanly.
- **Layer:** laufey.
- **Upstream:** request bodies in
  [littledivy/laufey#86](https://github.com/littledivy/laufey/pull/86), "forward custom-scheme
  request bodies on WebKitGTK" (open); the non-blocking response body is planned.

### Per-app persistent storage

- **What:** each app's web storage (`localStorage`, IndexedDB, cookies, the HTTP and Cache Storage
  caches) lives in its own profile directory, chosen from the app identifier, on every backend,
  and survives a relaunch.
- **Why:** CEF used a fresh temporary profile per process (`/tmp/laufey_cef_<pid>`), so nothing
  persisted. WebView2 used `<exe>.WebView2` next to the host executable, shared by every app on
  that host and possibly read-only in an install directory. WKWebView keyed the store by the host
  bundle, shared by every app on it, and WebKitGTK kept cookies in memory only. A desktop app that
  forgets its sign-in at every launch isn't at Electron parity.
- **Layer:** laufey (`LAUFEY_APP_ID` / `LAUFEY_DATA_DIR`), Deno runtime (hands every backend the
  identifier).
- **Upstream:** [littledivy/laufey#88](https://github.com/littledivy/laufey/pull/88), "per-app
  persistent web data directories on every backend" (open); the Deno side is planned.

### The launch configuration file

- **What:** the backend reads `laufey-launch.json` next to the executable (`Contents/Resources` in
  a macOS bundle) for the app id, custom schemes, data directory and the DevTools setting; an
  environment variable still wins. denext's packager writes it into every package.
- **Why:** these settings are needed before the runtime loads: CEF reads its schemes and profile
  while it initializes, WebKitGTK sets the Wayland `app_id` in `main()`. The only channel was
  `LAUFEY_*` environment variables, and an app started directly (Explorer, the Start menu, the
  Dock, a desktop shortcut, `exec`) has no launcher to set them. The runtime also stopped calling
  `setenv` for its own variables (an environment overlay instead), because `setenv` while the
  host's UI thread runs races `getenv`, which is undefined behavior on glibc.
- **Layer:** laufey (the file), Deno runtime (the overlay), denext (writes the file).
- **Upstream:** [littledivy/laufey#87](https://github.com/littledivy/laufey/pull/87), "read
  launch configuration from laufey-launch.json next to the executable" (open); the overlay is
  planned.

### The app identifier

- **What:** `desktop.app.identifier` (reverse DNS) reaches every launch path as `LAUFEY_APP_ID`,
  and sets the Linux `app_id` / `WM_CLASS`. An app origin requires an identifier.
- **Why:** storage, login items, scheme ownership and notifications all key off a stable app id;
  without one, apps on the same host shared state. On Wayland the window also showed a generic
  icon instead of the app's.
- **Layer:** Deno runtime.
- **Upstream:** the Wayland part is a port of
  [denoland/deno#35662](https://github.com/denoland/deno/pull/35662) by Leo Kettmeir
  (@crowlKats), kept under his authorship; the rest is planned.

### Deep links, opened files and single instance

- **What:** `openurl`, `openfile` and `secondinstance` events plus `Deno.desktop.launchUrls` /
  `launchFiles` for the ones that started the app; `desktop.app.singleInstance` hands a second
  launch to the running app (a `flock` plus a Unix socket that checks the peer's uid; on Windows a
  named pipe with a per-user DACL). denext surfaces them as `onDeepLink` and `onOpenFile`, pulled
  by the page so a reconnect never replays one twice.
- **Why:** stock Deno Desktop declared `DesktopEvent::OpenUrl` and never emitted it, so OAuth
  callbacks, magic links and "open with" did nothing, and a second launch opened a second copy of
  the app.
- **Layer:** laufey, Deno runtime, denext.
- **Upstream:** built on [littledivy/laufey#77](https://github.com/littledivy/laufey/pull/77)
  (`on_open_url`, by @diegoholiveira, open), cherry-picked with his authorship. The Windows and
  Linux routing and the single-instance lock are planned; that pull request waits on #77 and #87.

### Scheme registration with the OS

- **What:** `Deno.desktop.getSchemeOwner` and `registerScheme({ force })`, plus a first-launch
  registration that runs only when the scheme is unowned or already the app's: Windows `HKCU` with
  an owner marker (the user's `UserChoice` is read, never written), macOS LaunchServices, Linux a
  hidden XDG `.desktop` entry with `xdg-mime`. The Windows `.msi` writes the same keys at install.
- **Why:** a deep link only reaches an app the OS knows about, and on Windows a link clicked
  before the app's first launch failed until the installer registered it. Registration must never
  take a scheme another app owns.
- **Layer:** Deno runtime.
- **Upstream:** planned.

### Native passkeys

- **What:** `Deno.desktop.passkeys` (`capabilities`, `create`, `get`) runs WebAuthn through the
  OS platform authenticator: macOS AuthenticationServices (Touch ID, iCloud Keychain, security
  keys) and Windows Hello (`webauthn.dll`); Linux reports `not_supported`. The request and
  response envelope is the one of `@clerk/electron-passkeys`, so with `denext/desktop/clerk`,
  `@clerk/electron/passkeys` runs unchanged.
- **Why:** the web engine's own WebAuthn can't serve a relying party on the web (`example.com`)
  from a page at `myapp://app` or a loopback origin: the RP ID must match the page's origin.
- **Layer:** laufey, Deno runtime, denext.
- **Upstream:** planned.

### OS sign-in sessions and main-thread code

- **What:** `Deno.desktop.authSession` runs a browser sign-in in the OS's own session,
  `ASWebAuthenticationSession` anchored to the app's window on macOS, ending at a custom-scheme
  (or, on macOS 14.4+, https) callback. Windows and Linux have no OS equivalent and answer
  `not_supported`, so denext's `openAuthSession` falls back to the system browser (RFC 8252).
  denext runs `openAuthSession`'s custom-scheme sign-in in it on macOS (`preferEphemeral` makes it
  ephemeral) and, where the system browser has the sign-in, shows the page a Cancel overlay, since
  the browser reports no cancellation. `Deno.desktop.runOnMainThread` calls native code on the
  app's UI thread, which a `defineDesktopExtension` reaches as `ctx.runOnMainThread` (full trust:
  it is FFI and needs `--allow-ffi`; `unsupported` on the stock runtime).
- **Why:** sign-in should look and behave like the platform's, share its cookies and close itself
  when the provider redirects back. AppKit APIs must be called on the main thread, and laufey's
  existing UI-task hook forgot a task posted after the event loop ended, so a caller waiting on
  one during quit hung, and the shutdown with it. The new dispatcher runs each task exactly once,
  or reports that it could not.
- **Layer:** laufey, Deno runtime, denext.
- **Upstream:** the UI-thread hop builds on
  [littledivy/laufey#79](https://github.com/littledivy/laufey/pull/79) (`run_on_ui_thread`, by
  Kenta Moriuchi, @petamoriken, open), cherry-picked with his authorship; the rest is planned.

### The window API

- **What:** maximize, minimize and fullscreen with events, minimum and maximum size,
  `getBounds` / `setBounds` / `getNormalBounds`, `Deno.desktop.screens()` and display changes,
  title-bar styles and the traffic-light position, Mica / Acrylic and vibrancy, a cancelable
  `close` event, `Deno.desktop.quit()` (cancelable, like Electron's `app.quit()`),
  `quitOnLastWindowClosed`, and `windowCapabilities()` to ask what the current backend supports.
- **Why:** stock Deno Desktop had none of the window state, size limits or screens, could not
  cancel a close (an editor couldn't ask "save changes?"), and `quit()` had no op. Along the way:
  a tray-only app is kept alive and revealed correctly, and on WebView2 the tray's message window
  moved to the UI thread: created on the runtime thread, which never pumps messages, tray clicks
  and the tray menu never arrived
  ([denoland/deno#36778](https://github.com/denoland/deno/issues/36778)).
- **Layer:** laufey, Deno runtime, denext (`denext/desktop/window`).
- **Upstream:** built on [denoland/deno#36761](https://github.com/denoland/deno/pull/36761)
  (`devicePixelRatio`, inner and outer size, by Kenta Moriuchi),
  [denoland/deno#36789](https://github.com/denoland/deno/pull/36789) (`desktop.initialWindow`, by
  Sasivarnan R), [littledivy/laufey#80](https://github.com/littledivy/laufey/pull/80) (Kenta
  Moriuchi) and [littledivy/laufey#81](https://github.com/littledivy/laufey/pull/81) (Sasivarnan R),
  all open and cherry-picked with their authorship. Ours is planned.

### Device-independent sizing on Windows

- **What:** window sizes, positions and size limits are the page area in device-independent
  pixels on every backend, as documented.
- **Why:** WebView2 sized the outer window rectangle in physical pixels (asking for 900×700 gave
  an 884×661 page), and CEF on Windows and macOS sized the whole window. WebView2 now converts all
  window geometry with the window's DPI and handles `WM_DPICHANGED`.
- **Layer:** laufey; denext gates its drag-region scaling on the `dipGeometry` capability.
- **Upstream:** planned.

### Streaming on WebView2

- **What:** a custom-scheme response that stays open (Server-Sent Events, a streamed `fetch`, a
  long `XMLHttpRequest`) reaches the page as it is written. A document-start shim tags same-origin
  requests and the runtime posts their bodies to the page under a 4 MiB credit window, capped at
  64 MiB, without ever blocking the runtime's write.
- **Why:** WebView2 reads a custom-scheme response stream to its end before the page sees a byte
  ([MicrosoftEdge/WebView2Feedback#3519](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3519)),
  so an SSE stream never arrived, and with it denext's live bridge events on Windows. WKWebView,
  WebKitGTK and CEF already streamed.
- **Layer:** laufey.
- **Upstream:** planned.

### Drag and drop

- **What:** `dragenter` / `dragover` / `dragleave` / `drop` with the dropped files' native paths,
  and `startDrag({ files, icon })` to drag files out of the app.
- **Why:** a web page sees dropped files only as `File` objects without paths, and can't start a
  drag of real files to the Finder or Explorer; editors and file managers need both.
- **Layer:** laufey, Deno runtime, denext (drops pulled by the page, drag-out confined to what the
  app may read).
- **Upstream:** planned.

### Native file dialogs

- **What:** `Deno.desktop.dialog.showOpenDialog` / `showSaveDialog`: the OS's own panels,
  cancelable with an `AbortSignal`, never blocking the runtime (on Windows they run on laufey's
  own STA thread).
- **Why:** stock Deno Desktop had only `alert` / `confirm` / `prompt`. Without the runtime, denext
  falls back to shelling out to osascript, PowerShell, zenity or kdialog.
- **Layer:** laufey, Deno runtime, denext.
- **Upstream:** planned.

### The rich clipboard

- **What:** `Deno.desktop.clipboard` reads and writes text, HTML and PNG images, lists
  `availableFormats()` and fires a `change` event.
- **Why:** the stock clipboard was text only, so copying a table as HTML or pasting a screenshot
  needed the web clipboard, with its focus and permission rules.
- **Layer:** laufey, Deno runtime, denext.
- **Upstream:** planned.

### Global shortcuts

- **What:** `Deno.desktop.shortcuts.register(accelerator)` binds a system-wide hotkey with the
  OS's own API (Carbon on macOS, `RegisterHotKey` on Windows, X11 key grabs or the XDG
  GlobalShortcuts portal on Wayland), with typed errors for invalid, conflicting or denied keys.
- **Why:** "show the quick-entry window" from any app is a standard Electron feature
  (`globalShortcut`) with no web equivalent.
- **Layer:** laufey, Deno runtime, denext.
- **Upstream:** planned.

### Launch at login

- **What:** `Deno.desktop.launchAtLogin.get()` / `set(enabled)`: `SMAppService` on macOS 13+, the
  `HKCU` `Run` key on Windows, an XDG autostart entry on Linux, named after the app id. It reports
  `requires-approval` when macOS waits for the user.
- **Why:** start-with-the-session is another Electron staple (`app.setLoginItemSettings`).
- **Layer:** laufey, Deno runtime, denext.
- **Upstream:** planned.

### DevTools control

- **What:** `Deno.desktop.devtools` and per-window open / close / toggle / is-open, and an
  app-wide switch: with DevTools off (`"inspectable": false`), `openDevtools()` does nothing. denext
  turns them on in `denext desktop dev` and off in a packaged app unless `desktop.inspectable` is
  `true`.
- **Why:** a shipped app should not hand every user a web inspector, and a developer needs one in
  development.
- **Layer:** laufey, Deno runtime, denext.
- **Upstream:** planned.

### Menus, accelerators and close events

- **What:** menu `accelerator`s work on every backend (`menuCapabilities()` says what each
  supports), `showContextMenu` resolves with the chosen item (`null` when dismissed) and fires
  `contextmenuclose`, and the Dock badge clears with `setBadge(null)`.
- **Why:** accelerators were bound on macOS only, a context menu gave no answer when dismissed,
  and `setBadge(null)` showed the text "null" because the op coerced its argument to a string.
- **Layer:** laufey, Deno runtime, denext (`denext/desktop/app`).
- **Upstream:** planned.

### Notifications

- **What:** `Notification` takes `actions` and `data` and fires a separate `action` event;
  `Deno.desktop.notifications` adds `schedule({ at })`, `getScheduled()`, `cancel(tag)`,
  `capabilities()` and `requestPermission()`. A click on a notification from an earlier run, or
  the one that launched the app, arrives as `notificationresponse`, kept in
  `launchNotificationResponses` until the app listens. Windows toasts carry action buttons and
  reach the app through its COM activator.
- **Why:** actions were folded into `click`, nothing could be scheduled, and the click that
  launched the app was lost, so a reminder couldn't open the item it was about.
- **Layer:** laufey, Deno runtime, denext.
- **Upstream:** planned. macOS shows notifications only from a signed app, and Linux has no
  cold-start click (the freedesktop protocol sends it to the connection that posted it).

### Node-API addons on Windows

- **What:** native addons (`.node` files from node-gyp, napi-rs or neon) load and run on Windows.
  At startup the runtime gives the host executable an in-memory export table whose Node-API
  entries jump to the runtime DLL's functions.
- **Why:** addons look the Node-API functions up in the host executable, which in a desktop app
  is laufey's host and exports nothing, so the first Node-API call killed the process
  (`0xC06D007F`). macOS and Linux already resolved them.
- **Layer:** Deno runtime. The release smoke test loads a probe addon on every target.
- **Upstream:** planned; it fixes the Windows half of deno#36596. The Linux half landed upstream
  in [denoland/deno#36718](https://github.com/denoland/deno/pull/36718) (Leo Kettmeir), which the
  fork includes.

### Signed full-app self-updates

- **What:** `Deno.desktop.updater` replaces the whole signed app (a macOS `.app`, a Windows or
  Linux app directory, an AppImage). The manifest must be signed (ECDSA P-256, against a key baked
  in at package time); the version must be strictly newer (no downgrades, and rolled-back versions
  are refused); the download is size-capped, hashed and safely extracted; the new app must carry
  the same code-signing identity (Team ID on macOS, signer on Windows). A helper swaps it in
  atomically, and a version that doesn't confirm itself on its next launch is rolled back. denext's
  `denext/desktop/updater` confirms after the first window loads.
- **Why:** Deno's `Deno.autoUpdate` patches the runtime library in place with bsdiff. Inside a
  signed `.app` that breaks the code signature; it is Unix only, the signature is optional, and
  nothing stops a downgrade. The updater ops are also gated to a packaged app: they had been
  reachable from a plain `deno run` through internal ops, where they read and could rewrite update
  state next to the `deno` executable without any permission.
- **Layer:** Deno runtime, denext (`denext desktop publish-update`, `denext/desktop/updater`).
- **Upstream:** includes the macOS JIT entitlement fix of
  [denoland/deno#36421](https://github.com/denoland/deno/pull/36421) by Matt Johnston
  (@johnstonmatt), cherry-picked with his authorship; ours is planned.

### Reliability fixes

- **What:** fixes found by making every end-to-end test run reliably in CI, each a bug a user
  could hit:
  - a synchronous cross-thread call notified its condition variable after releasing the lock, so
    the notify could reach a stack frame that was already gone (a use-after-free): the next call
    slept forever or crashed. A stress test of the old pattern hung within a few hundred calls;
    the fixed one completes a million;
  - `quit()` on the macOS WebView backend returned from the run loop without shutting the runtime
    down, so the process could exit under the running app;
  - CEF gave a new window's browser 5 seconds to appear. On a slow machine the window was
    returned without one, and its first page load was silently dropped; it now waits up to 30;
  - macOS fullscreen transitions and a winit frameless-resize loop.
- **Why:** these surfaced as "flaky tests" that turned out to be real hangs and crashes.
- **Layer:** laufey.
- **Upstream:** planned (they touch upstream code, so they are candidates on their own).

### Build fixes

- **What:** laufey's Windows build stops predefining `_WCHAR_T_DEFINED` for bindgen.
- **Why:** with it, bindgen failed on Windows without an extra `-xc++` clang flag, so a stock
  toolchain couldn't build the C API bindings.
- **Layer:** laufey (build only).
- **Upstream:** [littledivy/laufey#85](https://github.com/littledivy/laufey/pull/85), "stop
  predefining `_WCHAR_T_DEFINED` for bindgen" (open).

### Cargo-style concurrency locks

- **What:** cross-process locks for `DENO_DIR` and Deno's build outputs, as Cargo does them: a
  shared lock to read the package cache and an exclusive one to change it, merged `deno.lock`
  writes, and a lock per output directory for `deno compile`, `deno bundle`, `deno doc --html`
  and `deno test --coverage`.
- **Why:** several `deno` processes routinely share one cache and one project (an editor's
  language server, a dev server, a test run, a parallel CI job). `deno clean` can delete entries
  another process is reading, two coverage runs clear each other's directory, and two
  `deno compile`s delete each other's temporary output.
- **Layer:** the Deno CLI. This is not part of the runtime archive; denext's own CLI already has
  the same locks (see [Concurrency and build locks](/docs/cli#build-locks)).
- **Upstream:** in progress for upstream Deno.

## How it's tested

Each layer has its own gate, and a release runs all of them:

- **laufey, on every backend.** laufey's CI runs a `native_e2e` battery, the same
  backend-agnostic checks (state readbacks, event callbacks, the clipboard, menu and tray click
  round trips, custom-scheme pages and streaming) under winit, WebView and CEF on macOS and
  Windows and CEF on Linux, plus storage that must survive a relaunch, the launch file and the
  single-instance lock. On Linux WebKitGTK, which isn't thread-safe under a headless worker-thread
  runtime, it runs the request-body round trip and the storage test.
- **The Deno fork, at upstream's bar.** The fork removes upstream's generated workflows, so it
  runs upstream Deno's own test bar itself on macOS, Windows and Linux: `tools/lint.js` (clippy
  with upstream's deny flags, dlint) and the format checks, `cargo test --lib` over upstream's
  crate list, and the unit and spec test suites, with the same commands and flags as Deno's CI.
- **The runtime, packaged and launched.** The release workflow builds every target on its own
  runner, packages a small app with the stock `deno desktop` on both backends and launches it.
  An end-to-end suite then packages one app per area (the origin and memory transport, per-app
  storage, deep links and scheme ownership, the window API, drag and drop and dialogs, passkeys,
  shortcuts and DevTools, menus and notifications, full-app updates with throwaway keys), launches
  them the ways the OS does, and fails the job on any failure or timeout. On Windows it installs
  the real `.msi`.
- **denext, from the page.** The
  [desktop kitchen sink](https://github.com/Brainwires/denext/tree/main/examples/desktop-kitchen-sink)
  turns on every capability, calls each one from the page and asserts the results, including a
  real update installed, left unconfirmed and rolled back. Its window test
  (`.github/workflows/desktop-window.yml`) runs on Linux, macOS arm64, macOS Intel and Windows,
  nightly and on every push that touches the desktop code; a check that can't run on a hosted
  runner must say why.

## How it works

denext pins the runtime in
[`src/build/desktop-runtime-pin.json`](https://github.com/Brainwires/denext/blob/main/src/build/desktop-runtime-pin.json):
the release tag, the Deno version and commit, the laufey commit and C API version, and for every
target and backend the archive's URL, size and SHA-256. When `denext desktop run`, `dev` or
`package` (or a scaffolded `scripts/package-*.ts`) needs the runtime, it:

1. reuses `<Deno cache>/denext-desktop-runtime/<version>/<target>-<backend>/` when that directory
   carries a marker matching the pin and every recorded file is present at its recorded size. No
   network is needed after the first download. `--verify-runtime` (or
   `DENEXT_DESKTOP_RUNTIME_VERIFY=1`) re-hashes every file instead;
2. otherwise streams the archive into a private temp directory, refusing it the moment it grows
   past its pinned size, and checks the size and SHA-256 before anything touches it. Nothing is
   extracted from an unverified archive;
3. extracts it with a safe extractor (no absolute paths, no `..` entries, no links that leave the
   directory, no special files), writes the marker (each file's size and SHA-256) and moves the
   tree into place in one rename. Two builds racing each other are safe;
4. runs the stock `deno desktop` with `DENORT_DESKTOP_BIN` and `LAUFEY_DEV_DIR` set.

The Deno cache is `DENO_DIR` when it is set, otherwise the default Deno itself uses
(`~/Library/Caches/deno`, `%LOCALAPPDATA%\deno`, `$XDG_CACHE_HOME/deno` or `~/.cache/deno`). The
backend comes from `desktop.backend` in `deno.json` (`webview` by default, or `cef`).

**Deno 2.9.7 exactly.** `deno desktop` embeds the runtime, so the runtime and the CLI must be the
same Deno version. Any other version stops before the build with the fix:
`deno upgrade --version 2.9.7`.

**`denext doctor`** reports the pinned runtime version, whether it is cached and verified on this
machine, and whether `deno` is the version it needs.

| Variable                           | Effect                                                             |
| ---------------------------------- | ------------------------------------------------------------------ |
| `DENEXT_DESKTOP_RUNTIME=pinned`    | The default: denext's runtime, downloaded and verified.            |
| `DENEXT_DESKTOP_RUNTIME=stock`     | The stock Deno Desktop runtime (see [Opting out](#opting-out)).    |
| `DENEXT_DESKTOP_RUNTIME_DIR=<dir>` | A local runtime build, checked for its layout only (runtime work). |
| `DENEXT_DESKTOP_RUNTIME_VERIFY=1`  | Re-hash every cached file before use (`--verify-runtime`).         |
| `DENEXT_DESKTOP_RUNTIME_ATTEST=1`  | `gh attestation verify` a fresh download (`--attest-runtime`).     |

The packaged app's `--allow-*` flags don't change: the download happens in the packaging step, not
in the app.

## Opting out

`DENEXT_DESKTOP_RUNTIME=stock` builds with the stock Deno Desktop runtime. Your app still builds,
packages and runs; what the stock runtime lacks degrades instead of breaking:

- The app is served from a loopback origin that changes each launch, so browser storage starts
  empty every time. Use the `secure-store`, `fs` and `sqlite` capabilities for anything that must
  survive a relaunch. There are no deep links and no single instance.
- Window basics (size, position, title, show and hide) work everywhere. The rest of the window API
  rejects `unsupported`; ask `windowCapabilities()` what the current runtime can do.
- Capabilities that need the runtime answer `unavailable`, and the page keeps its web path: the
  WebView clipboard, the WebView `Notification` API, the in-page context menu. File dialogs run
  through the OS dialog programs (osascript, PowerShell, zenity or kdialog).

Every `denext/mobile` and `denext/desktop` function is feature-detected this way, so one codebase
works on either runtime.

## Upstream first

The fork is a bridge, not a destination. Every change is offered upstream, and the fork retires
feature by feature as Deno and laufey merge them. **The exit criterion is stock Deno shipping it
all**: when it does, denext uses the stock runtime and the forks are archived.

Our open pull requests to [laufey](https://github.com/littledivy/laufey):

- [#84](https://github.com/littledivy/laufey/pull/84): feat(scheme): serve embedder-registered
  custom schemes as secure origins on every backend
- [#85](https://github.com/littledivy/laufey/pull/85): fix(capi/windows): stop predefining
  `_WCHAR_T_DEFINED` for bindgen
- [#86](https://github.com/littledivy/laufey/pull/86): fix(webview/linux): forward custom-scheme
  request bodies on WebKitGTK
- [#87](https://github.com/littledivy/laufey/pull/87): feat: read launch configuration from
  `laufey-launch.json` next to the executable
- [#88](https://github.com/littledivy/laufey/pull/88): feat: per-app persistent web data
  directories on every backend

The rest of the laufey work and the Deno pull requests for the runtime patches follow, one area at
a time. The forks also carry open upstream work by other contributors, cherry-picked with their
authorship, ahead of a release that includes it: Deno
[#35662](https://github.com/denoland/deno/pull/35662),
[#35675](https://github.com/denoland/deno/pull/35675),
[#36421](https://github.com/denoland/deno/pull/36421),
[#36761](https://github.com/denoland/deno/pull/36761) and
[#36789](https://github.com/denoland/deno/pull/36789), and laufey
[#77](https://github.com/littledivy/laufey/pull/77),
[#79](https://github.com/littledivy/laufey/pull/79),
[#80](https://github.com/littledivy/laufey/pull/80) and
[#81](https://github.com/littledivy/laufey/pull/81). When those merge, the fork takes the
upstream version.

## Supply chain and trust

- **Public source.** Both forks are public, and each runtime release names the exact Deno and
  laufey commits it was built from.
- **Reproducible CI.** The release workflow
  ([`.github/workflows/denext_runtime.yml`](https://github.com/Brainwires/deno/blob/denext/v2.9.7/.github/workflows/denext_runtime.yml)
  in the Deno fork) builds every target on its own runner, checks architectures and dynamic
  dependencies, and packages and launches a small app with the stock `deno desktop` on both
  backends before anything is published. The fork's `DENEXT.md` describes how to reproduce a
  build locally.
- **One laufey revision.** laufey's C API is version-exact, so the `laufey` crate `libdenort`
  links and the backend hosts are built from the same commit, and the workflow fails if their API
  versions differ.
- **Verified before use.** denext checks the size and SHA-256 of every archive against its own pin
  before extracting it, and the cached files against the marker before reusing them.
- **Attested.** Every archive has a build provenance attestation, and `--attest-runtime` checks it
  on every fresh download.

```sh
gh attestation verify deno-desktop-runtime-<version>-<target>-<backend>.tar.gz -R Brainwires/deno
```

The runtime binaries are not code-signed: your app is signed with your own identity when you
package it (see [Desktop apps](/docs/desktop)).
