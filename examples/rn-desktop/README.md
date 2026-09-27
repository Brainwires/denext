# React Native on the desktop (`reactNative` + Deno Desktop)

A React Native component tree (react-native-web) running in a Deno Desktop
window, with native desktop capabilities: the counter persists in the OS
keychain, right-click opens the native context menu, and links open in the
system browser. The same source runs on the web and, in a Capacitor shell, on
iOS and Android.

## Run it

```
npm install          # react-native-web (the app's own dependency; denext ships none)
deno task dev        # in the browser
deno task desktop    # export + open in a native window (Deno 2.9+)
deno task desktop:dev    # live reload inside the window
```

## How it's wired

- `denext.config.ts` sets `mode: "spa"` and `reactNative: true`, so
  `react-native` resolves to react-native-web and the app's RN source builds for
  the DOM.
- `desktop.capabilities` lists what the page may ask the desktop runtime for
  (`secureStore`, `contextMenu`, `clipboard`, `shell`).
  `denext desktop add <capability>` writes these entries, and a call to a
  capability that is not listed is refused, so the page falls back to its web
  path.
- `src/App.tsx` imports `secureStore`, `showContextMenu`, `readClipboard` and
  `openExternal` from `denext/mobile`. In a desktop window
  (`runtimePlatform() === "desktop"`) they go through the runtime's token-gated
  bridge; `Platform.OS` stays `"web"` on purpose (react-native-web and RN
  libraries choose their DOM code paths from it).

`react-native-windows` / `react-native-macos` native modules (C++, C#,
Objective-C) do not run here: write the native part as a denext desktop
extension (TypeScript in the Deno process, with FFI or a sidecar when needed).
See https://denext.dev/docs/desktop#desktop-react-native.
