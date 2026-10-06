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

| Target    | Built by                                                           | Probe order                              |
| --------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `web`     | `denext build`, `start`, `dev`, `export`                           | `.web` → plain                           |
| `ios`     | `denext mobile build ios`, `denext export --platform ios`          | `.ios` → `.mobile` → `.web` → plain      |
| `android` | `denext mobile build android`, `denext export --platform android`  | `.android` → `.mobile` → `.web` → plain  |
| `macos`   | `denext desktop package` / `run` on macOS, `--platform macos`      | `.macos` → `.desktop` → `.web` → plain   |
| `windows` | `denext desktop package --target-os windows`, `--platform windows` | `.windows` → `.desktop` → `.web` → plain |
| `linux`   | `denext desktop package --target-os linux`, `--platform linux`     | `.linux` → `.desktop` → `.web` → plain   |

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
- `denext desktop run` exports for the OS it runs on; `denext desktop package` exports for the
  package's target OS, so a Windows package built on a Mac gets the `.windows` files.
- Everything else is the `web` target: `denext build`, `denext start`, `denext dev` and a plain
  `denext export`.

The server render of a platform export (prerendering, a Server Component, the first paint of a
client component) resolves the same files as its client bundle, so hydration sees the markup it
expects. `denext start` and the production server build stay `web`.

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

The page's modules and, on the native App Router, its server render follow the target; each
target's transforms are cached apart. A next-compat app's server render, a bundled route (MDX)
and the bundled dev path (`DENEXT_DEV_UNBUNDLED=0`) stay `web` in dev, as does the Flight
boundary: give a module's variants the same `"use client"` directive as its plain file.

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
  // platformExtensions: false,         // turn platform files off
};
```

- `.native` is **not** probed by default. In React Native it marks native code, which does not
  run in a WebView; a migrated Expo app's `.native.tsx` files are usually that. Opt in with
  `platformExtensions: { native: true }` when yours are web-safe: iOS then probes `.ios` →
  `.native` → `.mobile` → `.web`.
- `platformExtensions: false` turns platform files off: every import resolves to the plain
  file (React Native mode still probes `.web` for its own needs).

## What takes a variant

Only the app's own modules. Packages in `node_modules` keep their own resolution (React Native
mode probes their `.web` files): a React Native library's `.ios.js` file calls native modules,
and the WebView shells run the library's web build.

Route files (`page.tsx`, `layout.tsx`, …) do not take a variant; put the platform-specific part
in a component the route imports. A variant importing its own plain module
(`BigButton.ios.tsx` importing `./BigButton.tsx`) resolves to itself, as in React Native; share
code through a third module instead.

On the native App Router path the server render follows relative imports (`./`, `../`) to a
variant; an import-map alias (`@/components/BigButton`) reaches it in the client bundle but
renders the plain file on the server, so prefer relative imports to platform modules there.
