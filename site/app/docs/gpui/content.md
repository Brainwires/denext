---
title: Native tree windows (denext/gpui)
slug: gpui
lead: Render React Native primitives straight into a Deno Desktop window's native tree on the gpui backend, with no web view in between. This page covers what version 1 supports, how it plugs into react-reconciler, and what it does not do yet.
---

A [desktop app](/docs/desktop) normally renders into a web view: the system WebView or Chromium
draws the DOM your React tree produces. On the **`gpui` backend** there is no web view. The window
hosts a retained **native tree** of primitives (views, text, images, scroll views, text inputs,
pressables), drawn by [GPUI](https://www.gpui.rs/), and `denext/gpui` renders React into it.

`denext/gpui` is in development (B1). The `gpui` backend has no pinned runtime archive yet, so it
runs only on a local laufey build (see [Running it](#running-it)).

## What it is

- **React Native's primitives**: `View`, `Text`, `Image`, `ScrollView`, `TextInput` and
  `Pressable`, styled with React Native's `StyleSheet`.
- **A react-reconciler renderer**, as React Native Skia, react-three-fiber and react-konva are.
  You pass `react-reconciler` in. It loads against denext's own React core, so the hooks your
  components import from `react` run on this renderer's fibers. denext itself imports no npm
  package for it.
- **One batch per commit.** Each React commit becomes one binary batch (NTB1) for the window's
  `nativeTree.commit`, which the host applies atomically before its next frame. Events come back
  as JSON and reach your handlers in React Native's event shapes.

## Running it

1. Set the backend in `denext.config.ts`. One value, or per OS like the other engines:

   ```ts
   export default { desktop: { backend: "gpui" } };
   ```

   `denext desktop doctor` reports that the pinned runtime has no gpui build yet. Until it does,
   build laufey's gpui host and point `DENEXT_DESKTOP_RUNTIME_DIR` at a runtime directory that
   holds it under `laufey/gpui`. That directory's `laufey/` is passed to `deno desktop` as
   `LAUFEY_DEV_DIR`.

2. Map `react` to denext's React, and add `react-reconciler` (0.31, React 19) to `deno.json`:

   ```json
   {
     "imports": {
       "denext": "jsr:@denext/denext",
       "react": "jsr:@denext/denext/react",
       "react-reconciler": "npm:react-reconciler@0.31.0"
     }
   }
   ```

3. Render into a window from `desktop.ts`:

   ```ts
   import createReconciler from "react-reconciler";
   import { h, useState } from "react";
   import { Pressable, render, StyleSheet, Text, View } from "denext/gpui";

   function Counter() {
     const [n, setN] = useState(0);
     return h(
       View,
       { style: styles.box },
       h(Pressable, { onPress: () => setN(n + 1) }, h(Text, null, `Pressed ${n} times`)),
     );
   }

   const styles = StyleSheet.create({ box: { flex: 1, padding: 16, backgroundColor: "#fafafa" } });

   render(h(Counter, null), {
     window: new Deno.BrowserWindow({ title: "Counter" }),
     reconciler: createReconciler,
   });
   ```

   Import hooks from `react` (denext's React entry), not from `denext`: only `react`'s hooks hand
   the call to a react-reconciler renderer.

`AppRegistry` works too:
`AppRegistry.registerComponent("main", () => App)`, then
`AppRegistry.runApplication("main", { rootTag: window, reconciler })`.

## The API

| Export                                                          | What it does                                                                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `render(element, { window, reconciler })`                       | Mounts `element` in the window's native tree, or updates the root already there. Returns `{ render, unmount, window }`.                                                      |
| `gpuiSupport(window?)`                                          | `{ supported: true, version }`, or `{ supported: false, reason }` saying which part is missing.                                                                              |
| `GpuiUnsupportedError`                                          | What `render` throws without a native tree (`code: "unsupported"`).                                                                                                          |
| `AppRegistry`                                                   | `registerComponent`, `getAppKeys`, `runApplication(appKey, { rootTag, reconciler, initialProps })`, `unmountApplicationComponentAtRootTag`.                                  |
| `View`, `Text`, `Image`, `ScrollView`, `TextInput`, `Pressable` | The primitives.                                                                                                                                                              |
| `StyleSheet`                                                    | `create`, `flatten`, `compose`, `hairlineWidth`, `absoluteFill`, `absoluteFillObject`.                                                                                       |
| `Platform`                                                      | React Native mode's `Platform`. `Platform.constants.denextShell` is `"gpui"` while a root is mounted.                                                                        |
| `parseColor`                                                    | A colour string as the RGBA `u32` the batches carry.                                                                                                                         |
| `NativeTreeCommitError`                                         | Passed to `onError` when `nativeTree.commit` refuses a batch (`code` -1 unsupported, -2 malformed, -3 no such window).                                                       |
| `NativeTreeBatchError`                                          | Passed to `onError` when the host rejects a batch on its UI thread (an unknown node, a cycle, a bad `before`); `seq` names the batch. The tree stays at the last good batch. |

`render` also takes `onError` (default `console.error`: commit errors, handler errors, React's
uncaught and recoverable errors), `fetch` for images, and `assetBase` for relative image URLs.

### Degrading

`render` probes three things, in order, and throws `GpuiUnsupportedError` with the first one
missing:

- `Deno.desktop`: absent on stock Deno and outside a desktop app;
- `Deno.desktop.windowCapabilities().nativeTree`: `{ version: 1 }` on the gpui backend, unset on
  the web view backends and on runtimes that predate it;
- the window's `nativeTree.commit`.

Call `gpuiSupport()` first to choose another path, such as a web view window, instead.

## Primitives and props

| Primitive    | Props                                                                                                                                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All          | `style`, `accessibilityLabel` (or `aria-label`), `accessibilityRole` (or `role`), `testID`, `onLayout`, `onFocus`, `onBlur`, `onKeyPress`                                                                                                             |
| `Text`       | Nested `Text` elements are styled spans. Press props as `Pressable`. A string outside a `Text` throws, as in React Native.                                                                                                                            |
| `Image`      | `source` (a URL string, which is what an imported image is, or `{ uri }`), `resizeMode`, `onLoad`, `onError`, `onLoadEnd`                                                                                                                             |
| `ScrollView` | `horizontal`, `scrollEnabled`, `contentContainerStyle`, `onScroll` (at most once a frame). The host scrolls the direct children: there is no content view, so `contentContainerStyle` is merged over `style`, and a horizontal one lays out in a row. |
| `TextInput`  | `value`, `defaultValue`, `placeholder`, `placeholderTextColor`, `editable`, `secureTextEntry`, `multiline`, `onChangeText`, `onChange`, `onSubmitEditing`, `onSelectionChange`                                                                        |
| `Pressable`  | `onPress`, `onPressIn`, `onPressOut`, `onLongPress`, `delayLongPress`, `delayPressIn`, `delayPressOut`, `minPressDuration`, `disabled`; `style` and `children` may be functions of `{ pressed }`                                                      |

The host sends only the events a node has handlers for.

**Presses** go through the same pressability as React Native mode, with React Native's timings:
`onLongPress` after `delayLongPress` (500 ms), and `onPressOut` held for `minPressDuration`
(130 ms). A press with no press-in, from the keyboard or assistive technology, calls `onPress`.

**TextInput** follows React Native's controlled-input protocol. Each `value` goes to the host
with the latest native event count JavaScript has seen, so the host ignores a value older than
what the user has typed since. When `onChangeText` does not take the new text into `value`, the
input is put back to `value`.

**Images.** JavaScript fetches each unique source once, so the app's own network rules apply. It
sends the bytes to the host, which decodes and caches them. The image is freed when the last
`Image` showing it unmounts or changes source.

## Styles

Version 1 supports React Native's StyleSheet subset that maps onto Taffy and GPUI.

- **Layout:** `display`, `flex*`, `justifyContent`, `align*`, `gap`, `rowGap`, `columnGap`,
  `position`, `top` / `right` / `bottom` / `left`, `width` / `height` and their min / max,
  `aspectRatio`, margins, paddings, border widths, `overflow`.
- **Paint:** `backgroundColor`, border colours, per-corner `borderRadius`, `opacity`.
- **Text:** `color`, `fontFamily`, `fontSize`, `fontWeight`, `fontStyle`, `lineHeight`,
  `letterSpacing`, `textAlign`, `textDecorationLine`.

Lengths are numbers, `"auto"` or `"N%"`. Style arrays and falsy entries are flattened as in React
Native.

The shorthands expand to sides and corners with React Native's precedence: a side beats an axis,
and an axis beats the whole. They are `margin` / `padding` with `Horizontal`, `Vertical`, `Start`
and `End`, plus `borderWidth`, `borderColor` and `borderRadius`.

Colours are the CSS named colours, `transparent`, `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`,
`rgb()` and `rgba()`. Props the table has no slot for, such as `transform` and the shadows, are
ignored.

The style and prop ids are fixed in one table that the host and denext share,
[`src/gpui/props.json`](https://github.com/Brainwires/denext/blob/main/src/gpui/props.json). It
is a pinned copy of the canonical table, and `deno task gen:gpui-props` generates the TypeScript
from it.

## Limitations

Version 1 has none of the following yet:

- `VirtualList`, `FlatList` or navigation;
- animation (`Animated`, Reanimated, `LayoutAnimation`);
- transforms, shadows and `hsl()` colours;
- accessibility beyond labels and roles;
- `onLoadStart` on `Image`, and `contentInset` or `scrollTo` on `ScrollView`;
- children under `Image` or `TextInput` (only `View`, `Text`, `ScrollView` and `Pressable` take
  children; anything else throws before the batch is sent);
- `Platform.OS` other than `"web"`: use `Platform.constants.denextShell` to tell a gpui window
  apart.

The gpui host itself has these gaps in version 1: `multiline` inputs stay single-line, a node has
one border colour, `letterSpacing`, `textAlign: "justify"` and `resizeMode: "repeat"` are not
drawn, a nested `Text` can't change size or family, accessibility props are not passed to the OS,
and on Windows a window can't be moved or hidden.

The gpui backend has no web view at all, so DOM APIs, CSS files and web components do not apply
in it.
