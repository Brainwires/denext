---
title: Kernel sandbox for desktop and compiled apps
slug: kernel-sandbox-desktop-and-compiled
lead: Compiled binaries and packaged desktop apps carry their grant and their kernel sandbox mode from build time. How the mode is baked in, what a compiled program does with it on each system, which desktop apps are confined, and where browser engines limit the guarantees.
---

> [!IMPORTANT]
> **An opt-in preview ships in denext 4.x; automatic enforcement lands in denext 5.0.** A program
> compiled with `deno compile --kernel-sandbox=enforce` confines itself today on Linux and macOS,
> and gets the small tier on Windows. A packaged desktop app is confined only when its build baked
> `enforce`; `auto` leaves desktop apps alone. Parts still being written say so. The
> [overview](/docs/kernel-sandbox) has the design.

## Compiled binaries

`deno compile` bakes the mode next to the baked `--allow-*` list, from `--kernel-sandbox` or else
`deno.json`'s `permissions.kernelSandbox`. The binary reads only that baked mode: the run-time
flag, `DENO_KERNEL_SANDBOX` and `deno.json` are ignored. With no mode baked, `auto` applies nothing
in denext 4.x, so a program compiled without one runs as before.

**`--kernel-sandbox=enforce`** builds a command-line program that confines itself to its baked
grant at startup, with no flag at run time:

- **Linux and macOS.** The program applies the sandbox in place, before its JavaScript engine and
  any thread start (Landlock and seccomp on Linux, Seatbelt on macOS), so native code, Node-API
  addons and children are held to the grant. Where the grant needs the supervising broker (a host
  name in `--allow-net`, a write deny inside a write allow on Linux), the program forks first: the
  parent is the supervisor and keeps the PID, the child confines itself and runs the program. A
  self-extracting program writes its files before the sandbox applies, and its extraction folder is
  readable, never writable.
- **Windows** gets the [small tier](/docs/kernel-sandbox-windows): a job object (no children
  without `--allow-run`, the tree ends with the program) and, with a scoped `--allow-write`, Low
  integrity with the write folders labelled Low. Reads and the network stay Deno-only.
- **Its own cache folder.** A confined program can't write the temp folder, where its V8 code cache
  and its extracted native addons normally live. Under `enforce` both go to
  `<temp>/deno-compile-<name>.sandboxed/<policy hash>/` (`code.cache` and `addons/`), created
  private (`0700`) before the sandbox applies and used only when it and its parent belong to the
  user alone. No unconfined run reads it, so a confined program can't plant code for a less
  confined one. Where it can't be made, the program runs with no code cache and an embedded native
  addon fails to load.
- **No prompts.** The author fixed the grant, so a permission the program lacks is refused, not
  asked for. The first refusal on a terminal prints one line naming the access and
  `deno compile --kernel-sandbox=off`, which keeps the old prompting behaviour.
- **Inside another sandbox.** Started inside a confined `deno` run, a Linux program adds its own
  layer; on macOS a program with `enforce` baked refuses to start there (Seatbelt can't stack a
  second profile).

`deno compile` compiles the policy for the target OS at build time and prints, as a warning, any
rule that OS could never hold (the program would refuse to start there). **`broker`** is accepted
for Linux and macOS programs; it's refused for Windows and for desktop apps, which run no
supervisor. `--kernel-sandbox-exec=strict` is baked too. `denext build --compile` doesn't bake a
mode of its own.

## Packaged desktop apps

A desktop app's process hosts its web engine. The runtime applies the kernel sandbox to it only
when the package's build baked `--kernel-sandbox=enforce`, the runtime's form of a strict package.
denext's packaging scripts don't pass a kernel sandbox mode yet, so `desktop.permissions: "strict"`
doesn't turn it on by itself today. Under `auto`, at every rollout stage, a desktop app that isn't packaged that way
runs with no kernel layer: such apps start the system's openers (`open`, `osascript`, `xdg-open`)
for `openPath`, `revealInFileManager` and an auth session's browser, which a sandbox would break.
`deno compile` and `deno desktop` say at build time what the package gets for its target and
engine, and refuse `broker` for a desktop app.

A confined app:

- applies the sandbox before its engine starts a thread, where its host calls the runtime first;
- adds what its engine needs to the kernel's grant only, never to Deno's checks: system fonts,
  themes and toolkit data, GPU devices, the session's runtime folder, the temp folder, the app's
  own data and cache folders, and the engine's storage folders named after the app identifier (so a
  scoped grant needs `desktop.app.identifier`);
- isn't narrowed by host on the network: any network grant leaves the kernel's network open and is
  reported. With no network grant, macOS keeps the app to loopback; Linux can't;
- opens `http:`, `https:` and `mailto:` links with `Deno.desktop.openExternal` through a small
  helper that stays outside the sandbox. A child `open` or `osascript` inside the sandbox opens
  nothing.

`Deno.desktop.platformFeatures()` reports `kernelSandbox` (`"kernel"`, `"headless-only"` or
`"none"`) and `kernelSandboxReason`. An engine that can't run inside the sandbox never stops the
app from starting: one line on stderr says its own process isn't confined.

## Browser engines inside the sandbox

A desktop app hosts a browser engine (WKWebView, CEF, WebKitGTK or WebView2), and most engines run
their own sandbox for web content. Each engine was tested inside the app's kernel sandbox, and the
results decide what a packaged app gets. Where an engine can't run inside, the app gets **headless
guarantees only**: Deno's own checks plus what the platform can apply without breaking the engine,
rather than in-process confinement. A confined split-process design, with the engine host outside
and the runtime and native extensions in a confined child, follows later for those cases.

### macOS

- **WKWebView apps are confined in-process.** The web view itself runs in WebKit's own processes,
  which macOS starts as system services outside the app's sandbox. So the app's network rules don't
  reach the web view: native code in the app could drive the web view to fetch anything.
- **CEF apps get headless guarantees only.** Chromium's helper processes apply their own sandbox
  when they start, and they can't start inside an outer sandbox.

### Linux

- **CEF apps are confined in-process, with Chromium's sandbox intact, where Chromium's namespace
  sandbox works.** Chromium builds its sandbox from user namespaces, which the desktop policy keeps
  available; before it commits, the runtime checks in a forked child that Chromium's first steps
  succeed under the same policy, and reports the app headless-only if they don't.
- **Where Chromium needs its setuid helper instead** (for example, distributions that restrict
  unprivileged user namespaces), the sandbox's `no_new_privs` stops the helper, so CEF apps get
  headless guarantees only, unless the package ships an AppArmor profile that allows the app user
  namespaces.
- **WebKitGTK apps are confined in-process.**
- **The host must call the runtime first.** On Linux the sandbox can only apply while the process
  has one thread, so an app whose host started its engine before calling the runtime is reported
  headless-only.
- **The session bus is a documented gap on Linux desktop.** A GTK or CEF app needs the D-Bus session
  bus (portals, notifications, the tray, the Secret Service behind `secure-store`), and the kernel
  can't tell one message on it from another. Native code in the app can use the bus as the user can.

### Windows

Desktop apps on Windows have no kernel layer (`kernelSandbox: "none"`). WebView2 and CEF must start
their own helper processes and can't run from a Low-integrity, child-limited process, so a
packaged app keeps Deno's checks only. See [Windows](/docs/kernel-sandbox-windows).

## Native extensions and sidecars

_Being written as this lands._ What `defineDesktopExtension` modules, Node-API addons and
`desktop.sidecars` see inside the sandbox, which `desktop.extraPermissions` they need, and what a
`run: { exec }` sidecar inherits.

## Capabilities that reach outside the app

`openExternal` goes through a small helper that stays outside the sandbox: it runs the system
opener with one `http:`, `https:` or `mailto:` URL, and only for an app whose run grant names the
opener. The full-app updater's swap is started through the same helper; staging an update next to
the install isn't covered by a scoped write grant. On macOS the profile always refuses
LaunchServices (`lsopen`) and sending AppleEvents. On Linux the session bus, every Unix socket the
user can reach and the network stay open. _Being written as this lands:_ notifications, the tray
and `secure-store` row by row.

## Per platform

| App                       | macOS                                                       | Linux                                                                                            | Windows    |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------- |
| Compiled command-line app | Full headless matrix                                        | Full headless matrix                                                                             | Small tier |
| Desktop app, WKWebView    | Confined in-process; the web view's own fetches aren't held | —                                                                                                | —          |
| Desktop app, CEF          | Headless guarantees only                                    | Confined in-process where Chromium's namespace sandbox works; headless guarantees only otherwise | None       |
| Desktop app, WebKitGTK    | —                                                           | Confined in-process; the session bus is a gap                                                    | —          |
| Desktop app, WebView2     | —                                                           | —                                                                                                | None       |

The desktop rows apply to a package baked with `enforce`; any other desktop app has no kernel
layer. The [guarantee matrix](/docs/kernel-sandbox-guarantees) has the headless cells.
