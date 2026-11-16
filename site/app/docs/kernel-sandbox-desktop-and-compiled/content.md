---
title: Kernel sandbox for desktop and compiled apps
slug: kernel-sandbox-desktop-and-compiled
lead: Compiled binaries and packaged desktop apps are where the kernel sandbox switches on by default, because their author fixed the grant at build time. How the mode is baked in, what desktop.permissions "strict" turns on, and where browser engines limit the guarantees.
---

> [!IMPORTANT]
> **An opt-in preview ships in denext 4.20; the full sandbox, with automatic enforcement, lands
> in denext 5.0.** This page is an outline, filled in as these parts land. The
> desktop results below are a draft from the first experiments, being validated (see
> [Browser engines](#browser-engines-inside-the-sandbox)). The [overview](/docs/kernel-sandbox)
> has the design.

## Compiled binaries

**Compiled command-line apps get the full headless
[guarantee matrix](/docs/kernel-sandbox-guarantees) on every platform**: the same cells as any
fixed-permission run on that platform and kernel. A compiled app has no window and no browser
engine, so nothing limits what the sandbox can apply.

_Being written as this lands._ `deno compile` and `denext build --compile` bake the mode (default
`auto`) next to the baked `--allow-*` list, and `compile.permissions` feeds the policy. The binary
ignores the run-time flag and environment, confines itself before any thread starts (no extra
exec), keeps its code cache in its own folder, and refuses a missing permission on a terminal
instead of prompting. How to turn that off at build time.

## Packaged desktop apps

_Being written as this lands._ How the packaging scripts carry the mode into the app,
`desktop.permissions: "strict"` mapping to `enforce`, how `desktop.capabilities` and
`desktop.extraPermissions` become the kernel policy, and the app data and cache folders it always
includes.

## Browser engines inside the sandbox

A desktop app hosts a browser engine (WKWebView, CEF, WebKitGTK or WebView2), and most engines run
their own sandbox for web content. Each engine was tested inside the app's kernel sandbox, and the
results decide what a packaged app gets. Where an engine can't run inside, the app gets **headless
guarantees only**: Deno's own checks plus what the platform can apply without breaking the engine,
rather than in-process confinement. A confined split-process design, with the engine host outside
and the runtime and native extensions in a confined child, follows later for those cases.

These results are from the first experiments and are still being validated.

### macOS

- **WKWebView apps are confined in-process.** The web view itself runs in WebKit's own processes,
  which macOS starts as system services outside the app's sandbox. So the app's network rules don't
  reach the web view: native code in the app could drive the web view to fetch anything.
- **CEF apps get headless guarantees only.** Chromium's helper processes apply their own sandbox
  when they start, and they can't start inside an outer sandbox.

### Linux

- **CEF apps are confined in-process, with Chromium's sandbox intact, where unprivileged user
  namespaces are allowed.** Chromium builds its sandbox from user namespaces, which the desktop
  policy keeps available.
- **Where Chromium needs its setuid helper instead** (for example, distributions that restrict
  unprivileged user namespaces), the sandbox's `no_new_privs` stops the helper, so CEF apps get
  headless guarantees only, unless the package ships an AppArmor profile that allows the app user
  namespaces.
- **WebKitGTK apps are confined in-process.**
- **The session bus is a documented gap on Linux desktop.** A GTK or CEF app needs the D-Bus session
  bus (portals, notifications, the tray, the Secret Service behind `secure-store`), and the kernel
  can't tell one message on it from another. Native code in the app can use the bus as the user can.

### Windows

Windows gets the small tier. For a desktop app that is the job object's containment: the app's
processes stay in the job and end with it. WebView2 and CEF must start their own helper processes
and can't run from a Low-integrity process, so a packaged app doesn't get the child limit or the
write limit a headless program gets, and reads, writes and network stay Deno-only. See
[Windows](/docs/kernel-sandbox-windows).

## Native extensions and sidecars

_Being written as this lands._ What `defineDesktopExtension` modules, Node-API addons and
`desktop.sidecars` see inside the sandbox, which `desktop.extraPermissions` they need, and what a
`run: { exec }` sidecar inherits.

## Capabilities that reach outside the app

_Being written as this lands._ `openExternal`, `shell`, notifications, the tray and `secure-store`
talk to system services. Which of those stay available inside the sandbox, which go through a small
helper outside it, and the platform residuals (LaunchServices and AppleEvents on macOS, the session
bus on Linux).

## Per platform

| App                       | macOS                                                       | Linux                                                                                     | Windows              |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------- |
| Compiled command-line app | Full headless matrix                                        | Full headless matrix                                                                      | Full headless matrix |
| Desktop app, WKWebView    | Confined in-process; the web view's own fetches aren't held | —                                                                                         | —                    |
| Desktop app, CEF          | Headless guarantees only                                    | Confined in-process where user namespaces are allowed; headless guarantees only otherwise | Small tier           |
| Desktop app, WebKitGTK    | —                                                           | Confined in-process; the session bus is a gap                                             | —                    |
| Desktop app, WebView2     | —                                                           | —                                                                                         | Small tier           |

Draft, from the first experiments. The [guarantee matrix](/docs/kernel-sandbox-guarantees) has the
headless cells.
