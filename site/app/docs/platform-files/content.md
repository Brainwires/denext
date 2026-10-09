---
title: Platform-specific files
slug: platform-files
lead: Give a module a file per platform where it needs one — BigButton.ios.tsx, BigButton.desktop.tsx, BigButton.web.tsx — and each target's build picks its own, as React Native's platform extensions do.
---

Most of an app is the same everywhere, and code that differs a little branches at runtime with
[`runtimePlatform()`](/docs/mobile#the-denextmobile-runtime). When a component differs a lot,
give it a file per platform instead:

```
components/
  BigButton.tsx           the default
  BigButton.ios.tsx       iOS
  BigButton.desktop.tsx   macOS, Windows and Linux
```

```tsx
import { BigButton } from "./components/BigButton.tsx"; // or "./components/BigButton"
```

The import names the plain module. Each target's build resolves it to that target's file and
leaves the other variants out of its bundle, so an iOS-only dependency never reaches the web
build. This is React Native's
[platform-specific extensions](https://reactnative.dev/docs/platform-specific-code), on every
denext app: the App Router (native and next-compat), SPA mode and
[React Native mode](/docs/react-native).

## Targets and resolution order

Each target probes its suffixes, most specific first, and then the plain file:

| Target    | Built by                                                                                       | Probe order                              |
| --------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `web`     | `denext build`, `start`, a plain `export`; `denext dev` unless a shell names its target        | `.web` → plain                           |
| `ios`     | `denext mobile build ios`, `denext export --platform ios`                                      | `.ios` → `.mobile` → `.web` → plain      |
| `android` | `denext mobile build android`, `denext export --platform android`                              | `.android` → `.mobile` → `.web` → plain  |
| `macos`   | `denext desktop build` / `run` / `package` on macOS, `--platform macos`                        | `.macos` → `.desktop` → `.web` → plain   |
| `windows` | `denext desktop build` / `run` on Windows, `package --target-os windows`, `--platform windows` | `.windows` → `.desktop` → `.web` → plain |
| `linux`   | `denext desktop build` / `run` on Linux, `package --target-os linux`, `--platform linux`       | `.linux` → `.desktop` → `.web` → plain   |

For each suffix the extensions are tried in the order `.tsx`, `.ts`, `.jsx`, `.js`, `.mjs`, and
a folder import finds `index.ios.tsx` the same way. `.mobile` means any phone and `.desktop` any
desktop OS, the same split as [`runtimePlatform()`](/docs/mobile#the-denextmobile-runtime).
Because every list ends with `.web`, a `.web` file is the fallback for the native targets too:
use the plain file for code every target shares, and `.web` for code only browsers and the
WebView shells share.

Both spellings of an import resolve: the extensionless one (`./BigButton`) and the Deno one with
the plain file's extension (`./BigButton.tsx`).

## One export per target

denext builds one export per target, and only where a target is chosen:

- `denext export --platform <target>` writes that target's export to `out/`
  (`DENEXT_PLATFORM=<target>` does the same, and the flag wins).
- `denext mobile build ios|android` exports with its platform before `cap sync`, so the
  Capacitor shell's `webDir` holds that platform's export. The scaffolded `deno task mobile:sync`
  copies one web export into both shells; with `.ios` / `.android` / `.mobile` files, sync each
  shell from its own export instead: `DENEXT_PLATFORM=ios deno task export && npx cap sync ios`.
- `denext desktop build` and `denext desktop run` export for the OS they run on; `denext desktop
  package` exports for the package's target OS, so a Windows package built on a Mac gets the
  `.windows` files.
- `denext build`, `denext start` and a plain `denext export` are the `web` target. `denext dev`
  serves `web` unless a shell names its target (`mobile dev`, `desktop dev`; see below).

The server render of a platform export (prerendering, a Server Component, the first paint of a
client component) resolves the same files as its client bundle, so hydration sees the markup it
expects. `denext start` and the production server build stay `web`. `denext build` compiles the
server render's module copies (the importers rewritten to reach each `.web` file) into
`.denext/server-copies/` and records them in the build manifest, so `denext start` reads them as
they are: it scans nothing and writes nothing, and a read-only `.denext` serves the same files
as the client bundles.

A copy stands in for its module completely: its `import.meta` names the original, its dynamic
imports resolve like its static ones (`import("./Panel.tsx")` and `import("@/lib/x.ts")` reach the
target's files; a computed `import(name)` resolves a relative name against the original module on
the server), a `"use server"` module's actions run the copy the page renders (so they call the
target's files), and a platform export applies the same client transforms (`reactCompiler`,
`features`, …) as `denext build`.

An app with no platform files builds exactly as before, and one export serves every shell.

## In `denext dev`

The dev server serves `web` by default. A shell that names its target gets that target's files:

- `denext mobile dev --lan` writes each native config's `server.url` with
  `?__denext_platform=ios` (or `android`), so the phone renders and hot-reloads its own files.
- `denext desktop dev` opens the window with its OS (`macos`, `windows` or `linux`), and the
  window's proxy names it on every request.
- Any other client can do the same: open `http://localhost:3000/?__denext_platform=ios`. The dev
  server pins the target in a cookie, so the page's later requests (its modules, navigations,
  hot updates) keep it. A browser with no hint gets `web`.
- The pin is a session cookie: it ends when the browser closes. To go back to `web` before that,
  open `?__denext_platform=web` once (it pins `web`).

The page's server render, its modules, its bundled routes (an MDX route, or every route under
`DENEXT_DEV_UNBUNDLED=0`) and its Flight boundary follow the target, so a variant may be an
island where the plain file is a Server Component; each target's transforms and bundles are
cached apart. A next-compat app is the exception: its dev server render is one esbuild bundle
per edit, built for `web`, so in `denext dev` every shell gets the `web` files, islands
included. Its platform exports take each target's files.

The dev server scans the project for platform files once and keeps the result: editing a file
never rescans, but an edit to any source file the app imports (in `components/` or `lib/` as much
as in `app/`) hot-updates or reloads the page. Creating, removing or renaming a platform file anywhere in the project (not only
under `app/`), or the plain file of a module that has them, rescans and reloads the page. The
scan skips `node_modules`, every dot-folder (`.git`, `.next`, `.turbo`, …) and build or native
output at any depth (`out/`, `dist/`, `www/`, `coverage/`, `ios/`, `android/`).

## Over-the-air updates

A platform export carries `_denext/platform.txt` (its target's name), so its OTA manifest names
the target (`"platform": "ios"`). The manifest's version, and so its signature, covers that file;
the `platform` field itself is not signed, so a shell checks the stamp against its own target too:
dropping or changing the field never moves an export to another target. `checkForUiUpdate` and the
desktop updater refuse a manifest built for another target (code `platform_mismatch`), and send
their own target (`x-denext-ota-platform`) with the manifest request and every download, so one
server can keep an export per target. The mobile shell sends it when its running UI is a platform
export (or `checkForUiUpdate` is given `platform`); being a custom header, it makes a cross-origin
manifest request preflighted, so the server must answer `OPTIONS` (`createOtaHandler`'s `cors`
does). A shell running a `web` export sends a simple `GET`.

```ts
import { createOtaHandler } from "denext/server";

const ota = createOtaHandler({
  platforms: { ios: "releases/ios", android: "releases/android", web: "releases/web" },
  basePath: "/mobile-ui",
});
```

A request without the header gets the `web` export. A manifest that names no target and carries no
stamp (a `web` export; `--platform web` stamps nothing, as `denext export` does) is taken by every
shell, which is right for an app with no platform files; for one with
them, `denext ota manifest` warns and each shell should get its own export
(`denext export --platform ios`, then `denext ota manifest out`; `--platform` names the target of
an export that does not carry the file yet).

## When a target has no file

A module that exists only as some targets' variants fails the build of a target with no match:

```
`./components/BigButton` has `.android` and `.ios` variants but none for web:
add `BigButton.tsx` or `BigButton.web.tsx`
```

`denext doctor` lists these gaps for every target, without building:

```
⚠ platform files  components/BigButton (.android, .ios) has no file for web, macos, windows, linux: …
```

## Type checking

As in React Native, type checking resolves the plain path: TypeScript and `deno check` see
`BigButton.tsx`, not `BigButton.ios.tsx`. Keep a plain file (usually the web or default
implementation) beside the variants, with the same exports, and every import type-checks
against it. A module with variants only has nothing to check against; `denext doctor` points
those out. With extensionless imports, a `BigButton.d.ts` declaring the shared exports also
works.

## Options

```ts
// denext.config.ts
export default {
  platformExtensions: { native: true }, // also probe .native after .ios / .android
  // platformExtensions: { osFiles: true }, // React Native mode: probe the app's .ios / .android
  // platformExtensions: false,         // turn platform files off
};
```

- `.native` is **not** probed by default. In React Native it marks native code, which does not
  run in a WebView; a migrated Expo app's `.native.tsx` files are usually that. Opt in with
  `platformExtensions: { native: true }` when yours are web-safe: iOS then probes `.ios` →
  `.native` → `.mobile` → `.web`.
- In [React Native mode](/docs/react-native), the app's own `.ios` / `.android` files are not
  probed either: there they are native code too (a React Native app keeps its iOS and Android
  implementations in them). The iOS export probes `.mobile` → `.web` → plain. Opt in with
  `platformExtensions: { osFiles: true }` when yours are web-safe. `.mobile`, `.desktop`, the
  desktop OS suffixes and `.web` apply as in any app.
- `platformExtensions: false` turns platform files off: every import resolves to the plain
  file (React Native mode still probes `.web` for its own needs).

## What takes a variant

Only the app's own modules. Packages in `node_modules` keep their own resolution (React Native
mode probes their `.web` files): a React Native library's `.ios.js` file calls native modules,
and the WebView shells run the library's web build.

A [Pages Router](/docs/pages-router) app (`@denext/pages-router`) takes the `web` target's files
in its server render and its client bundles alike, in `denext dev`, `build` and `start`; its
pages do not take another target's files in a platform export or a shell's dev session.

A variant's stylesheets are its targets' own: `BigButton.mobile.tsx`'s `import "./phone.css"`
lands in the iOS and Android stylesheet only, and the plain file's sheet in the others', on every
build path (SPA and App Router, `export`, `build` and both `denext dev` loops, where each shell's
session gets its own). Fonts and `?url` assets a variant imports are likewise emitted for the
targets that load it.

Route files (`page.tsx`, `layout.tsx`, …) do not take a variant; put the platform-specific part
in a component the route imports. A variant importing its own plain module
(`BigButton.ios.tsx` importing `./BigButton.tsx`) resolves to itself, as in React Native; share
code through a third module instead.

An import through the app's import map takes a variant like a relative one: the alias resolves
first (`@/components/BigButton`, or an exact key like `#button`, from `deno.json` or the import
map file it names), then the target's file for the module it names. The server render and the
client bundle apply the same rule. A tsconfig `paths` alias is not followed: `denext migrate` converts `paths` to the import map.
