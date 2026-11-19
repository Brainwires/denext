---
title: Kernel sandbox for desktop and compiled apps
slug: kernel-sandbox-desktop-and-compiled
lead: Compiled binaries and packaged desktop apps are where the kernel sandbox switches on by default, because their author fixed the grant at build time. How the mode is baked in, what desktop.permissions "strict" turns on, and where browser engines limit the guarantees.
---

> [!IMPORTANT]
> **An opt-in preview ships in denext 4.20; the full sandbox, with automatic enforcement, lands
> in denext 5.0.** Compiled programs can bake `enforce` and confine themselves at startup. The
> desktop sections are an outline, filled in as those parts land: a desktop app can't bake
> `enforce` yet (`deno compile` refuses it). The
> desktop results below are a draft from the first experiments, being validated (see
> [Browser engines](#browser-engines-inside-the-sandbox)). The [overview](/docs/kernel-sandbox)
> has the design.

## Compiled binaries

A program built with `deno compile --kernel-sandbox=enforce` (or `denext build --compile` with the
mode in `compile`'s flags or deno.json's `permissions.kernelSandbox`) holds its baked `--allow-*`
list with the OS from the moment it starts. No flag is needed when it runs, and none can turn it
off: the mode is the author's, baked next to the permissions. A compiled command-line program has
no window and no browser engine, so it gets the headless
[guarantee matrix](/docs/kernel-sandbox-guarantees) of its platform.

```sh
deno compile --kernel-sandbox=enforce --allow-read=./data --allow-net=127.0.0.1:8080 -o app main.ts
./app   # native code, addons and children are held to ./data and port 8080
```

What the program does at startup, on Linux and macOS:

- **It confines itself in place, before anything else runs.** The sandbox is applied first thing,
  while the process has one thread and has opened nothing: there is no second exec, so the PID,
  the start-up time and `$!` are what they were. (`deno run` re-executes itself; a compiled program
  has its modules embedded and fetches nothing, so it doesn't need to.)
- **Its own files stay readable** (the executable, with the modules and assets embedded in it; a
  self-extracting program's extraction folder, read-only).
- **It keeps its code cache and extracted native addons in its own folder**,
  `<temp>/deno-compile-<name>.sandboxed/<policy>`, created for your user alone. A confined program
  writes nothing else for itself, and never the shared `<temp>/deno-compile-<name>.cache` that an
  unconfined program of the same name reads. Where that folder can't be made (a read-only temp
  folder) the program runs without a code cache, and loading an embedded native addon fails.
- **Its environment is scrubbed** to the `--allow-env` names and the runtime's own short list, as
  under `deno run --kernel-sandbox=enforce`; the variables of a baked `--env-file` follow the same
  rule. Children inherit that environment and the sandbox.
- **A missing permission is refused, never asked for.** The set is fixed, so a program compiled
  without `--no-prompt` doesn't prompt on a terminal either.
- **A rule the OS can't hold makes it refuse to start**, naming the rule, exactly as `deno run`
  does. `deno compile` warns about such rules for the target OS when it builds (for example a
  host-scoped `--allow-net` for a Linux target), so you find out before you ship.

The other modes:

| Baked mode      | The compiled program                                                                       |
| --------------- | ------------------------------------------------------------------------------------------ |
| none, or `auto` | Runs as before: `auto` applies nothing in 4.x. In denext 5.0 `auto` enforces.              |
| `enforce`       | Confines itself at startup, or refuses to start where the OS can't hold a rule.            |
| `warn`          | Prints one line saying how many rules only Deno's checks would hold, and confines nothing. |
| `off`           | Never confines itself, whatever `auto` comes to mean.                                      |
| `broker`        | Refused by `deno compile` (the supervising broker isn't built in yet).                     |
| any, with `-A`  | The sandbox is off: there is nothing to narrow. `-A` with a `--deny-*` holds the denies.   |

`--kernel-sandbox-exec=strict` is baked too: the whole process tree may then execute only the
`--allow-run` programs.

Inside another sandbox: a compiled program started by a confined `deno run` first intersects its
baked permissions with the grant it was started under. With `enforce` baked, Linux then adds the
program's own, narrower layer on top (Landlock domains and seccomp filters nest). macOS can't
stack a second Seatbelt profile, so there the program refuses to start, saying so, rather than run
under the wider outer profile.

On Windows a compiled program gets the [small tier](/docs/kernel-sandbox-windows).

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
