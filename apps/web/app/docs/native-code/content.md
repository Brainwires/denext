---
title: Your own native code
slug: native-code
lead: Keep your own Swift, Kotlin and desktop code when the app runs on denext. A Capacitor plugin (or a Deno Desktop extension) is the native side, `nativeModule` is the typed client, and in React Native mode TurboModules, NativeModules and Expo Modules resolve to the same plugin. Every call is asynchronous.
---

A denext mobile app runs in a WebView inside a Capacitor shell, so your native code lives in a
**Capacitor plugin**: a Swift class on iOS and a Kotlin (or Java) class on Android, each with
methods the page calls over Capacitor's bridge. On Deno Desktop the same role is played by a
[desktop extension](/docs/desktop#desktop-extensions). One client reaches both:

```ts
import { nativeModule } from "denext/mobile";

interface Scanner {
  scan(options: { timeoutMs: number }): { codes: string[] };
}
type ScannerEvents = { progress: { percent: number } };

const scanner = nativeModule<Scanner, ScannerEvents>("Scanner");
if (scanner) {
  const sub = scanner.addListener("progress", ({ percent }) => setProgress(percent));
  const { codes } = await scanner.scan({ timeoutMs: 5000 });
  sub.remove();
}
```

`nativeModule(name)` returns:

- inside the iOS/Android shell, a client for the Capacitor plugin registered as `name`
  (`window.Capacitor.Plugins[name]`, which the shell seeds for every plugin it registered: no
  `registerPlugin` call and no `@capacitor/core` import);
- in a Deno Desktop window, a client for the desktop extension named `name` (the desktop client
  is loaded on first use, so web and mobile bundles never carry it);
- `null` on the web, during SSR, and in a shell that has no such plugin.

Each method of the type you pass becomes an async function. `addListener(event, handler)`
subscribes to what the plugin sends with `notifyListeners(event, data)` (or a desktop
extension's `emit`), and returns `{ remove() }`. `onNativeEvent(name, event, handler)` is the
same subscription without a client, returning an unsubscribe function, for use in an effect.
Nothing runs when `denext/mobile` is imported, and an app that never calls `nativeModule` ships
none of it.

## Generate a module

`denext mobile add native-module --name <Name>` scaffolds a module into an existing Capacitor
project (run it where `capacitor.config.*` is; `--dry-run` prints the plan and changes nothing):

```sh
denext mobile add native-module --name Scanner
```

| File                                                                  | What it is                                                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ios/App/App/ScannerPlugin.swift`                                     | A `CAPBridgedPlugin` with `jsName = "Scanner"`, one async method (`echo`) and one event (`echoed`), in the App target. |
| `ios/App/App/DenextNativeModules.swift`                               | Registers every generated module; `DenextBridgeViewController` calls it in `capacitorDidLoad()`.                       |
| `android/app/src/main/java/dev/denext/nativemodules/ScannerPlugin.kt` | The Kotlin plugin (`@CapacitorPlugin(name = "Scanner")`), same method and event.                                       |
| `android/…/dev/denext/nativemodules/DenextNativeModules.java`         | Registers every generated module; `MainActivity.onCreate` calls it before `super.onCreate`.                            |
| `native/NativeScanner.ts`                                             | The typed client: `nativeModule<Spec, Events>("Scanner", { calls: "positional" })`.                                    |

It also switches the app to `DenextBridgeViewController` while the storyboard and
`SceneDelegate` still name `CAPBridgeViewController` (the same bridge the other denext plugins
use), and adds the Kotlin Gradle plugin to the Android app module (Capacitor 8's app template is
Java only), compiling Kotlin to the app's Java target. Run it again with another `--name` and the
new module joins the registrars; a second run with the same name changes nothing. The plugin and
client files are yours to edit: an edited file is never replaced (`--force` does). The native
files change the app binary, so ship a new build; an over-the-air UI update cannot deliver them.

A module name is PascalCase, and names starting with `Denext` are refused (they are denext's
own plugins). Pick a name no installed plugin uses as its `jsName`: the generator does not check
this, and a module named `Camera` would shadow `@capacitor/camera`.

Use it from app code:

```tsx
"use client";
import NativeScanner from "../native/NativeScanner.ts";
import { useEffect, useState } from "denext";

export function Echo() {
  const [last, setLast] = useState("");
  useEffect(() => {
    const sub = NativeScanner?.addListener("echoed", ({ message }) => setLast(message));
    return () => sub?.remove();
  }, []);
  return (
    <button type="button" onClick={async () => setLast(await NativeScanner?.echo("hi") ?? "")}>
      {last || "Say hi"}
    </button>
  );
}
```

To write a plugin by hand, follow Capacitor's
[iOS](https://capacitorjs.com/docs/plugins/ios) and
[Android](https://capacitorjs.com/docs/plugins/android) guides and register it in
`DenextNativeModules` the way the generated ones are. A plugin published as an npm package needs
no registration at all: `npx cap sync` registers it, and `nativeModule("<its jsName>")` reaches it.

## Two call conventions

A Capacitor method receives one options object and resolves one object. React Native methods
take positional arguments and resolve any value. `nativeModule(name, { calls })` picks one:

| `calls`               | A call `m(a, b)` sends                                                                | The result                                                                 |
| --------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `"options"` (default) | `a` as is (Capacitor's `call.getString("key")`)                                       | The resolved object as is.                                                 |
| `"positional"`        | `{ args: [a, b] }`; a lone plain-object argument's keys are also spread beside `args` | `{ value: x }` (and nothing else) resolves to `x`; any other object as is. |

The generated modules use `"positional"`, so the same plugin serves `NativeScanner.echo("hi")` and
React Native code written against a TurboModule spec: the Swift reads
`call.getArray("args")?.first` and resolves `["value": message]`.

## React Native and Expo code

In [React Native mode](/docs/react-native) the app's own native-module code keeps working, with
positional calls:

| Your code                                                                 | On denext                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TurboModuleRegistry.getEnforcing<Spec>("Scanner")`                       | The Capacitor plugin `Scanner` (desktop extension `Scanner` on Deno Desktop); the web stand-in elsewhere.                                                                                                                                                                                                                                                                                  |
| `TurboModuleRegistry.get<Spec>("Scanner")`                                | The same, or `null` where there is none.                                                                                                                                                                                                                                                                                                                                                   |
| `NativeModules.Scanner`                                                   | The same (`undefined` where there is none); `NativeModules.UIManager` stays react-native-web's.                                                                                                                                                                                                                                                                                            |
| `new NativeEventEmitter(NativeModules.Scanner).addListener(e, f)`         | Subscribes to the plugin's `notifyListeners(e, …)`; `emit()` still reaches the listeners.                                                                                                                                                                                                                                                                                                  |
| Expo `requireNativeModule("Scanner")`                                     | The same client; where there is none, a stand-in whose functions throw `Cannot find native module` when called (importing works).                                                                                                                                                                                                                                                          |
| Expo `requireOptionalNativeModule("Scanner")`                             | The same, or `null`.                                                                                                                                                                                                                                                                                                                                                                       |
| Expo `module.addListener(e, f)`, `new EventEmitter(module)`               | The plugin's events.                                                                                                                                                                                                                                                                                                                                                                       |
| `requireNativeComponent` / `codegenNativeComponent` / `requireNativeView` | A [native view slot](/docs/mobile#native-views) of that view type (`denext mobile add native-views`): JSON props go to the native factory, a native event `name` calls `on<Name>` with `{ nativeEvent }`, children are drawn over the view. Where the type is not registered natively, the children render. Expo's view type is the module name, or `<Module>_<View>` for its other views. |

So a codegen spec such as `NativeScanner.ts` (`export default
TurboModuleRegistry.getEnforcing<Spec>("Scanner")`) needs no change: implement `Scanner` as a
Capacitor plugin (the generator's Swift and Kotlin are the starting point) and its callers reach
it. The Expo Modules DSL (`Name`, `AsyncFunction`, `Events`) maps onto a Capacitor plugin the same
way: one `CAPPluginMethod` per `AsyncFunction`, `notifyListeners` per event.

## Everything is async

The bridge between the WebView and native code is asynchronous, and there is no JSI, so a native
method cannot answer synchronously. Every method returns a Promise, including ones a TurboModule
spec declares synchronous (`getConstants()`, a `number`-returning method) and Expo's `Function`
(sync) and `Constants`. Await every call.

denext tells you where code assumes otherwise:

- **At build time** (React Native mode), a native-module method whose result is used as a value
  (arithmetic, a property read, a condition, JSX, an argument) in the app's own source is a build
  warning naming the file and line:
  `NativeCalc.add() calls into native code, which is asynchronous on denext … Await it`. Awaited,
  returned, `.then`-chained, fire-and-forget and `Promise.all` uses are fine. A reference is a
  binding from `TurboModuleRegistry.get` / `getEnforcing`, `NativeModules.X`,
  `requireNativeModule` / `requireOptionalNativeModule`, or the default import of a
  `Native<Name>` module (the codegen convention). node_modules is not scanned.
- **At run time** (a dev build), reading anything but `then` / `catch` / `finally` off a call's
  result logs a warning once per method: `Scanner.getCount() returns a Promise …`.

A value you need synchronously at startup (a constant, a flag) is best read once before the app
renders and kept in JS state.

## Deno Desktop

In a Deno Desktop window `nativeModule(name)` calls the desktop extension `name`
(`desktopExtension(name)` from `denext/desktop/client`): TypeScript in the app's Deno process,
with FFI or a sidecar for native code, enabled in `desktop.capabilities.extensions`. With
`calls: "positional"` the extension's method receives `{ args: [...] }`, so its input schema
takes that shape; with the default it receives the one options argument. Its `emit`ted events
reach `addListener`. A call to an extension that is not enabled rejects with the desktop bridge's
`unavailable` error. See [Deno Desktop](/docs/desktop#desktop-extensions).

## What is not covered

- **Synchronous native calls** (JSI, Nitro modules, sync TurboModule methods, Expo's sync
  `Function`): not possible over the bridge. Methods return Promises.
- **Native views as Fabric components**: `requireNativeComponent` and Expo's `requireNativeView`
  become [native view slots](/docs/mobile#native-views), a native view kept on the element's
  box (embedded in the page's layers on iOS, under or over the WebView elsewhere), not a view
  laid out by Fabric. Register the view type natively; its view commands are not wired.
- **Codegen**: denext does not run React Native codegen or Expo's module autolinking. The
  generated TypeScript client is typed by hand-kept `Spec` / `Events` types.
- **Android on a device**: the Kotlin module is compile-checked; like every Android claim in
  these docs it is not yet measured on a device.
