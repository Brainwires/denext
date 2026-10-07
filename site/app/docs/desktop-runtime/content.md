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
| [Chromium's sandbox on Windows (CEF)](#chromiums-sandbox-on-windows-cef)                     | laufey, Deno, denext | planned                                                                      |
| [No network requests from the CEF backend](#no-network-requests-from-the-cef-backend)        | laufey               | planned                                                                      |
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
  hidden XDG `.desktop` entry with `xdg-mime` (then, from runtime 2.9.7-denext.12, KDE's
  `kbuildsycoca6` / `kbuildsycoca5` where installed, so the first link on Plasma reaches the app
  without a re-login). The Windows `.msi` writes the same keys at install.
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
  the browser reports no cancellation. When the page cancels, the timeout passes or the starting
  page goes away, denext closes the sheet with `Deno.desktop.authSession.cancel()`.
  `Deno.desktop.runOnMainThread` calls native code on the
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

### Title bar preferences

- **What:** `Deno.desktop.titleBarPreferences()` and its `titlebarpreferenceschanged` event (runtime
  2.9.7-denext.12): how the user set up title bars — the window buttons on each side and their
  order, the double-click action, the colour scheme, the accent colour, the title bar font. On
  Linux it reads xdg-desktop-portal's Settings first (Plasma's portal reports KWin's button order;
  GNOME's, `button-layout`), then GSettings, then GTK's defaults, and follows `SettingChanged`
  live; macOS reports the traffic lights on the left and `AppleActionOnDoubleClick`; Windows the
  caption buttons on the right.
- **Why:** windows with a frame already look like the rest of the desktop (the compositor draws
  it on KWin, Sway and X11; GTK's own header bar on GNOME), but a page that hides its title bar
  and draws its own had nothing to match. `denext/desktop/window`'s `getTitleBarPreferences()`
  and `makeWindowDraggable` (its double click) use it.
- **Layer:** laufey, Deno runtime, denext.
- **Upstream:** planned.

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
  falls back to shelling out to osascript (macOS) or PowerShell (Windows); on Linux the dialogs are
  only the runtime's (zenity and kdialog are separate installs that differ in what they offer).
- **Linux (runtime 2.9.7-denext.12):** the desktop's own dialog through xdg-desktop-portal's
  FileChooser, called directly (not only inside Flatpak / Snap), wherever the portal offers one; GTK's
  chooser where it doesn't (a wlroots desktop with only `xdg-desktop-portal-wlr`).
  `platformFeatures().fileChooser` says which, `fileChooserReason` why GTK's.
- **Layer:** laufey, Deno runtime, denext.
- **Upstream:** planned.

### The secure store on Linux

- **What:** `Deno.desktop.secureStore` (runtime 2.9.7-denext.12): `get` / `set` / `delete` of a
  small secret per (service, account) in the Secret Service through libsecret (loaded at run time),
  with the state around it read over D-Bus first: no provider ("install gnome-keyring", "enable
  KWallet's Secret Service"), a locked keyring no one here can unlock (refused at once) or an
  unlock prompt nobody answers (refused after the timeout) reject `SecureStoreUnavailable` with
  the reason. Never a plaintext fallback, and a locked item is never `null`.
- **Why:** denext's `secure-store` ran `secret-tool`, which a stock Ubuntu desktop doesn't ship, and
  told a locked keyring from a missing item only by parsing its output.
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
- **Upstream:** planned. macOS shows notifications only from a signed app. On Linux (runtime
  2.9.7-denext.11) the runtime posts through the xdg-desktop-portal, so a click starts an app that
  quit (D-Bus activation of the app id's name, from the `.deb` / `.rpm`'s service file), and a
  systemd transient user timer posts a scheduled notification while the app is closed; without the
  portal (1.19+) it falls back to the freedesktop protocol, which sends a click to the connection
  that posted it, so there is no click after quit.

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

### Chromium's sandbox on Windows (CEF)

- **What:** on the `cef` backend, Windows apps run their web content in Chromium's sandbox:
  renderers at Untrusted integrity, the GPU process at Low. CEF's Windows sandbox exists only
  inside its `bootstrap.exe`, so that is the app's executable and laufey's CEF host is a library it
  loads (see [the Windows CEF layout](#the-windows-cef-layout)).
- **Why:** the Windows CEF backend ran every child process unsandboxed, so a compromised renderer
  had the user's full rights. macOS and Linux already ran sandboxed.
- **Limits:** the bootstrap starts the app in its install folder, so an app started from a shell
  or a shortcut does not keep the directory it was started from (denext's launchers, the forked
  workers and the updater pass theirs in `LAUFEY_CWD`, which the host changes back to); a
  bootstrap signed with a certificate Windows doesn't trust refuses to start (trust a self-signed
  development certificate first); and an app packaged with denext 3.1.x or earlier (runtime
  denext.8) can't update itself to the new layout: reinstall it.
- **Layer:** laufey, Deno runtime, denext.
- **Upstream:** planned.

### No network requests from the CEF backend

- **What:** the CEF host makes no network requests of its own (runtime 2.9.7-denext.11): no
  network time, component updater, account or search-engine traffic, and on Linux no Hunspell
  dictionary downloads. A feature or switch the app's own command line sets still wins.
- **Why:** Chromium contacted Google from a CEF window even with background networking off, so a
  window's traffic was not only the app's.
- **Layer:** laufey.
- **Upstream:** planned.

### Signed full-app self-updates

- **What:** `Deno.desktop.updater` replaces the whole signed app (a macOS `.app`, a Windows or
  Linux app directory, an AppImage). The manifest must be signed (ECDSA P-256, against a key baked
  in at package time); the version must be strictly newer (no downgrades, and rolled-back versions
  are refused); the download is size-capped, hashed and safely extracted; the new app must carry
  the same code-signing identity (Team ID on macOS, signer on Windows). A helper swaps it in
  atomically, and a version that doesn't confirm itself on its next launch is rolled back. denext's
  `denext/desktop/updater` confirms after the first window loads.
- **macOS requirements:** the runtime checks the staged app in this order: `codesign --verify
  --deep --strict`; the same Team ID as the running app; `spctl --assess --type execute`
  (Gatekeeper); the same signing identifier. So "same signer" on macOS means the same Team ID
  _and_ Gatekeeper acceptance: any notarized identity from the same team passes, but a Developer ID
  build that is not notarized is refused (`os_signature: Gatekeeper rejects the staged app`) even
  with the same signer, and so is an Apple Development–signed build from the same team. Notarize
  the build you publish (`DENEXT_NOTARY_PROFILE` at package time); `denext desktop publish-update`
  warns when Gatekeeper does not accept the `.app` as notarized.
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

## Runtime releases

Each release is a tag on the Deno fork; denext pins one (`src/build/desktop-runtime-pin.json`).

| Release           | What it adds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2.9.7-denext.1`  | The stable app origin over the memory transport, per-app storage, the launch file, the app identifier, deep links and single instance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `2.9.7-denext.2`  | Scheme registration with the OS (and the `.msi` registering it), native passkeys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `2.9.7-denext.3`  | The window API: state, size limits, screens, chrome, a cancelable close and quit, the initial window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `2.9.7-denext.4`  | Drag and drop, native file dialogs, the rich clipboard, signed full-app self-updates, Node-API addons on Windows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `2.9.7-denext.5`  | Global shortcuts, launch at login, DevTools control, menu accelerators and close events, scheduled and actionable notifications.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `2.9.7-denext.6`  | OS sign-in sessions (`Deno.desktop.authSession`) and `runOnMainThread` (laufey API 42).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `2.9.7-denext.7`  | The 3.1 security and fork-code audit fixes: the WebSocket relay forwards one marked upgrade (`x-deno-desktop-relay`) and only a `101` back, `node:http` serves under the memory transport, cancelled scheme requests abort the app's `request.signal`, updater hardening. `Deno.desktop.authSession.cancel()`, which closes the macOS sheet from code. laufey `b993068` (crate 0.8.0, API 43). **denext requires it.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `2.9.7-denext.8`  | macOS windows open in front at launch (the first window had opened behind other apps' windows, so WebKit paused `requestAnimationFrame`), WKWebView reports `outerWidth` / `outerHeight`, and a DevTools lock-ordering deadlock fix. laufey `e1bfe17` (API 43).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `2.9.7-denext.9`  | The 3.1.1 audit: the WebSocket relay requires a per-launch token (`DENO_DESKTOP_WS_URL`), the scheme bridge marks requests from other origins' documents (`x-deno-desktop-cross-origin`), bindings answer only the app's own documents (`bindOptions.origins`, the launch file's `bridgeOrigins`), the clipboard reads, global shortcuts, launch at login, notifications and forced scheme registration need an unscoped `--allow-sys`, update manifests must carry `expiresAt` and `sequence`, a staged update must be built as the manifest's version (`version_mismatch`), and single-instance helper and worker launches run headless, so the host and runtime classifiers agree. laufey `1d1ae22` (API 44). **denext requires it.**                                                                                                                                                                                                                                                                                |
| `2.9.7-denext.10` | Linux, probed rather than guessed: `Deno.desktop.platformFeatures()` (async) reports the session type, a tray host (followed live, with a `platformfeatureschanged` event), the Secret Service and its lock state, KWallet, the notification server and the portal versions. CEF's cookie store no longer hangs on a keyring no one can unlock: a profile with no OS-key cookies starts with `--password-store=basic`, one that has them waits for the key and is never switched (Chromium would delete them). The Chromium sandbox for CEF on macOS and Linux (user namespaces, else a setuid-root `chrome-sandbox` from a `.deb` / `.rpm`, else off with a warning). Wayland clipboard, global-shortcut, client-side-decoration sizing and exit fixes. WebKitGTK streamed `fetch` bodies reach the page as each write arrives (WebKit bug 322545). `.deb` / `.rpm` install the icon under the app id, refresh the desktop databases and depend on `secret-tool` only when the app runs it. laufey `611abcd` (API 45). |
| `2.9.7-denext.11` | Chromium's sandbox for CEF on Windows, behind CEF's bootstrap (`<App>.exe` is the bootstrap, `<App>.dll` the laufey host, `<App>.runtime.dll` the runtime; see [the Windows CEF layout](#the-windows-cef-layout)). Linux notifications through the xdg-desktop-portal: D-Bus activation, so a click starts an app that quit, systemd transient user timers that post a scheduled notification while the app is closed, and launcher badges. The runtime never rewrites the process's argv in place (a D-Bus-activated app crashed), and `Deno.args` leaves out the runtime's own switches. The CEF host makes no network requests of its own (no network time, component updater, account or search-engine traffic, and on Linux no Hunspell dictionary downloads). FFI libraries load from paths relative to the app, the X11 clipboard takes large (INCR) transfers, and the webview `.deb`'s dependencies, the AppImage icon and a tray created late are fixed. laufey `00f2128` (API 45). The current pin.          |

denext needs `2.9.7-denext.9`: under an older runtime the page gets no relay URL (its WebSockets
fail), the runtime refuses the update manifests denext publishes (it doesn't know `expiresAt` and
`sequence`), and its laufey ignores the launch file's `bridgeOrigins`. denext detects it at
startup: an app at its custom origin whose runtime publishes no `DENO_DESKTOP_WS_URL` prints one
warning that names the runtime as older than `2.9.7-denext.9`, says the page's WebSockets and
full-app updates won't work, and gives the fix (repackage with the runtime denext pins). The
endpoints stay up there, since a `denext.7` or `denext.8` runtime still marks relayed requests.

A runtime older than `2.9.7-denext.7` is refused outright wherever the app runs at its custom
origin. The relay mark is how the app tells a request any local process sent through the relay
from one its own page made, so a window on such a runtime (supplied through
`DENORT_DESKTOP_BIN` / `LAUFEY_DEV_DIR`, `DENEXT_DESKTOP_RUNTIME_DIR` or an older build) gets no
per-launch token and every `/_denext/desktop/*` endpoint is refused, with a startup message naming
the fix. denext detects that release by `Deno.desktop.authSession.cancel`, which shipped with the
mark. The stock runtime has no relay and is unaffected by either check.

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
same Deno version. Packaging with any other version stops before the build with the fix:
`deno upgrade --version 2.9.7`. `denext desktop run` and `dev` instead warn and build the window
on the stock runtime (point `DENO_BIN` at a 2.9.7 binary to keep the pinned one).

**Cross-OS packaging.** 2.9.7's CLI looks a `LAUFEY_DEV_DIR` backend up under the host's
executable name (`laufey_webview.exe` on Windows, `laufey_webview` elsewhere), then copies the
backend's directory into the app and renames the binary to the app's launcher. For a Windows app
packaged on macOS or Linux, or a Linux app on Windows, denext offers the backend under the host's
name from a sibling of the verified runtime (`<target>-<backend>.cross-host`, hard links into it),
so every Linux and Windows target packages from any host. macOS apps package on a Mac.

**`denext doctor`** reports the pinned runtime version, whether it is cached and verified on this
machine, and whether `deno` is the version it needs.

| Variable                           | Effect                                                             |
| ---------------------------------- | ------------------------------------------------------------------ |
| `DENEXT_DESKTOP_RUNTIME=pinned`    | The default: denext's runtime, downloaded and verified.            |
| `DENEXT_DESKTOP_RUNTIME=stock`     | The stock Deno Desktop runtime (see [Opting out](#opting-out)).    |
| `DENEXT_DESKTOP_RUNTIME_DIR=<dir>` | A local runtime build, checked for its layout only (runtime work). |
| `DENEXT_DESKTOP_RUNTIME_VERIFY=1`  | Re-hash every cached file before use (`--verify-runtime`).         |
| `DENEXT_DESKTOP_RUNTIME_ATTEST=1`  | `gh attestation verify` a fresh download (`--attest-runtime`).     |

The provenance check accepts only an attestation from the runtime repository's release workflow
(`.github/workflows/denext_runtime.yml`) built from the pinned tag, on a GitHub-hosted runner.

A new runtime release is pinned in the denext repository with
`deno task desktop:pin-runtime <tag>` (for example `denext-runtime-v2.9.7-denext.6`). It reads the
release's `manifest.json` and `SHA256SUMS`, requires them to agree on every archive and every URL to
be that tag's download, then downloads (or, with `--archives <dir>`, reads) each archive, hashes it
and runs the same provenance check, and writes `src/build/desktop-runtime-pin.json` only when all of
them pass.

The packaged app's `--allow-*` flags don't change: the download happens in the packaging step, not
in the app.

### The Windows CEF layout

A runtime whose CEF backend runs Chromium's sandbox on Windows (2.9.7-denext.11) lays a Windows
CEF app out as:

```
<App>/
  <App>.exe          CEF's bootstrap, with the app's icon and version resources
  <App>.dll          laufey's CEF host (laufey.dll, renamed): the bootstrap loads it by its name
  <App>.runtime.dll  the runtime: the host loads it by the executable's name
  libcef.dll, ...
```

The stock 2.9.7 CLI names the runtime `<App>.dll` and leaves `laufey.dll` in place, so denext's
package script and `denext desktop run` / `dev` move the two and stamp the executable's resources
(TypeScript, so it works from any host) whenever `laufey.dll` is in the bundle; a bundle that
already has `<App>.runtime.dll` is used as it is. The signing step signs every PE file, both
libraries included: a signed bootstrap loads only a client library signed with the same, trusted,
certificate. The webview backend keeps `<App>.exe` (its host) and `<App>.dll` (the runtime).

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
  through the OS dialog programs on macOS and Windows (osascript, PowerShell); on Linux they answer
  `unavailable` and the page keeps `<input type="file">`.

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
