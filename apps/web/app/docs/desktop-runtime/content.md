---
title: The Deno Desktop runtime
slug: desktop-runtime
lead: How denext ships Deno Desktop at Electron parity today: a prebuilt runtime from public forks, pinned by SHA-256, verified before use, and retired feature by feature as the work lands upstream.
---

A denext desktop app is a [Deno Desktop](https://deno.com) app. Stock Deno Desktop already gives
you a native window around your app with no bundled Chromium. denext goes further, to Electron
parity, by shipping a prebuilt **Deno Desktop runtime** built from two public forks:
[Brainwires/deno](https://github.com/Brainwires/deno) (Deno 2.9.7 plus the desktop patches) and
[Brainwires/laufey](https://github.com/Brainwires/laufey) (the native window hosts Deno Desktop
uses). You don't install anything for it: `denext desktop` and the packaging scripts fetch it,
verify it and use it.

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

## What it adds over stock Deno Desktop

| Capability                        | What the denext runtime does                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stable app origin               | `desktop.app.origin` (`myapp://app`) serves the app at a custom-scheme origin over an in-process transport, so sign-in providers and web storage see one site. |
| Persistent per-app storage        | Each app's localStorage, IndexedDB and cookies live in their own directory and survive a relaunch.                                                             |
| Deep links and opened files       | `onDeepLink` and `onOpenFile` receive links and files, at launch and while running.                                                                            |
| Single instance                   | `desktop.app.singleInstance` hands a second launch to the running app.                                                                                         |
| Scheme registration               | Registers deep-link schemes with the OS (and the Windows `.msi` at install), and never takes a scheme another app owns.                                        |
| Sign-in                           | `openAuthSession` with a custom-scheme callback, `ASWebAuthenticationSession` on macOS; native passkeys (macOS AuthenticationServices, Windows Hello).         |
| Window API                        | Maximize, minimize, fullscreen, size limits, screens, title-bar styles, Mica / Acrylic / vibrancy, a cancelable close and quit, device-independent sizing.     |
| Drag and drop                     | Files dragged in arrive with native paths; `startDrag` drags files out.                                                                                        |
| Native dialogs and clipboard      | The OS's own open and save panels; the OS clipboard with text, HTML and images.                                                                                |
| Menus, tray and notifications     | Native context menus and menu accelerators; scheduled, actionable notifications.                                                                               |
| Global shortcuts, launch at login | System-wide accelerators; start with the user's session.                                                                                                       |
| DevTools control                  | On in development, off by default in packaged builds (`desktop.inspectable`), toggled from code.                                                               |
| Full-app self-updates             | Signed updates that swap the whole app, with downgrade protection and automatic rollback.                                                                      |
| Node-API addons on Windows        | Native addons load on Windows as they already do on macOS and Linux.                                                                                           |
| WebView2 on Windows               | Streamed custom-scheme responses and a correctly sized page area.                                                                                              |
| Main-thread extensions            | `defineDesktopExtension` can run native code on the UI thread (`ctx.runOnMainThread`).                                                                         |

The [Desktop apps](/docs/desktop) guide covers each of these from the page's side.

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
all**: when it does, denext uses the stock runtime and the fork is archived.

Open pull requests to [laufey](https://github.com/littledivy/laufey):

- [#84](https://github.com/littledivy/laufey/pull/84): serve embedder-registered custom schemes as
  secure origins on every backend
- [#85](https://github.com/littledivy/laufey/pull/85): stop predefining `_WCHAR_T_DEFINED` for
  bindgen on Windows
- [#86](https://github.com/littledivy/laufey/pull/86): forward custom-scheme request bodies on
  WebKitGTK
- [#87](https://github.com/littledivy/laufey/pull/87): read launch configuration from
  `laufey-launch.json` next to the executable
- [#88](https://github.com/littledivy/laufey/pull/88): per-app persistent web data directories on
  every backend

The Deno pull requests for the runtime patches follow. The fork also carries upstream Deno work by
other contributors, cherry-picked with their authorship, ahead of a Deno release that includes it.

## Supply chain and trust

- **Public source.** Both forks are public, and each runtime release names the exact Deno and
  laufey commits it was built from.
- **Reproducible CI.** The release workflow
  ([`.github/workflows/denext_runtime.yml`](https://github.com/Brainwires/deno/blob/denext/v2.9.7/.github/workflows/denext_runtime.yml)
  in the Deno fork) builds every target on its own runner, checks architectures and dynamic
  dependencies, and packages and launches a small app with the stock `deno desktop` on both
  backends before anything is published. The fork's `DENEXT.md` describes how to reproduce a
  build locally.
- **Verified before use.** denext checks the size and SHA-256 of every archive against its own pin
  before extracting it, and the cached files against the marker before reusing them.
- **Attested.** Every archive has a build provenance attestation, and `--attest-runtime` checks it
  on every fresh download.

```sh
gh attestation verify deno-desktop-runtime-<version>-<target>-<backend>.tar.gz -R Brainwires/deno
```

The runtime binaries are not code-signed: your app is signed with your own identity when you
package it (see [Desktop apps](/docs/desktop)).
