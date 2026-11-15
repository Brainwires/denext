---
title: Kernel sandbox for desktop and compiled apps
slug: kernel-sandbox-desktop-and-compiled
lead: Compiled binaries and packaged desktop apps are where the kernel sandbox switches on by default, because their author fixed the grant at build time. How the mode is baked in, what desktop.permissions "strict" turns on, and where browser engines limit the guarantees.
---

> [!IMPORTANT]
> **In development. This lands in denext 4.20.** This page is an outline, filled in as these
> parts land. Desktop guarantees depend on experiments still running (see
> [Browser engines](#browser-engines-inside-the-sandbox)). The [overview](/docs/kernel-sandbox)
> has the design.

## Compiled binaries

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

_Being written as this lands._ A desktop app hosts a browser engine (CEF, WKWebView, WebKitGTK or
WebView2), and each engine runs its own sandbox for web content. Whether those engines can start
inside the app's kernel sandbox is being tested on every platform before any desktop work is
built. If they can, packaged apps get in-process confinement. If they can't, packaged apps in the
first release get the headless guarantees only: the Deno runtime's own checks plus what the
platform can apply without breaking the engine. A confined split-process design, with the engine host outside and the
runtime and native extensions in a confined child, follows later. This section records the result
for each engine.

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

_Being written as this lands._ A short table of what a packaged app gets on macOS, Linux and
Windows in the first release, linked to the [guarantee matrix](/docs/kernel-sandbox-guarantees).
