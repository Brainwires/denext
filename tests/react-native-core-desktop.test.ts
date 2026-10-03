// React Native mode's desktop aliases: `react-native-windows` / `react-native-macos` resolve to
// `react-native` plus what each adds (react-native-desktop.ts), and the additions' behaviour
// (src/react-native/desktop.ts): the desktop View props, Flyout / Popup, Glyph, AppTheme,
// the macOS colors, and Platform's desktop constants / select keys.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "esbuild";
import { flushSync } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { reactNativeBundleOptions } from "../src/build/react-native.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import { desktopEntrySource } from "../src/build/react-native-desktop.ts";
import { DESKTOP_ALIASES } from "../src/react-native/desktop-manifest.ts";
import {
  AppTheme,
  ColorWithSystemEffectMacOS,
  createDesktopView,
  createFlyout,
  createGlyph,
  createPopup,
  DynamicColorMacOS,
  EventPhase,
  HandledEventPhase,
  Platform,
  PlatformColor,
  supportKeyboard,
} from "../src/react-native/mod.ts";
import { type Any, mount, withGlobals } from "./helpers/mobile-fakes.ts";
import { runtimePlatform } from "../src/mobile/bridge.ts";

/** Write `files` (relative path → contents) under `root`. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

// ---- build: the aliases ------------------------------------------------------------

const FIXTURE: Record<string, string> = {
  "node_modules/react-native-web/package.json": JSON.stringify({
    name: "react-native-web",
    module: "dist/index.js",
    sideEffects: false,
  }),
  "node_modules/react-native-web/dist/index.js": ["View", "Text", "Modal", "StyleSheet"]
    .map((n) => `export { default as ${n} } from "./exports/${n}";\n`).join(""),
  ...Object.fromEntries(
    ["View", "Text", "Modal", "StyleSheet"].map((n) => [
      `node_modules/react-native-web/dist/exports/${n}/index.js`,
      `export default "RNW_${n.toUpperCase()}";\n`,
    ]),
  ),
  "node_modules/react-native-web/dist/vendor/react-native/Utilities/Thing.js":
    'export default "DEEP_THING";\n',
  // The real packages are Flow source: reaching either fails the build.
  "node_modules/react-native-windows/package.json": JSON.stringify({
    name: "react-native-windows",
    main: "index.windows.js",
  }),
  "node_modules/react-native-windows/index.windows.js": "import typeof X from './X';\n",
  "node_modules/react-native-macos/package.json": JSON.stringify({
    name: "react-native-macos",
    main: "index.js",
  }),
  "node_modules/react-native-macos/index.js": "import typeof X from './X';\n",
  "win.js": `import * as Win from "react-native-windows";
import Thing from "react-native-windows/Libraries/Utilities/Thing";
export const names = Object.keys(Win).sort();
export const W = Win;
export { Thing };
`,
  "mac.js": 'import * as Mac from "react-native-macos";\nexport const M = Mac;\n',
  "only-text.js": 'import { Text } from "react-native-windows";\nexport const T = Text;\n',
  // An RN desktop app's own source imports `react-native`; a library in node_modules too.
  "app.js": `import { Text, View } from "react-native";
import * as RN from "react-native";
import { LibView } from "some-lib";
export { LibView, Text, View };
export const Flyout = RN.Flyout;
export const names = Object.keys(RN);
`,
  "node_modules/some-lib/package.json": JSON.stringify({ name: "some-lib", module: "index.js" }),
  "node_modules/some-lib/index.js":
    'import { View } from "react-native";\nexport const LibView = View;\n',
};

/** The overlay stand-in: each desktop factory returns a marker naming what it got. */
const STAND_IN = [
  'export function createDesktopView(V, f) { return "DESKTOP_VIEW(" + V + "," + f + ")"; }',
  'export function createFlyout(M, V) { return "FLYOUT(" + M + "," + V + ")"; }',
  'export function createPopup(M, V) { return "POPUP(" + M + "," + V + ")"; }',
  'export function createGlyph(T) { return "GLYPH(" + T + ")"; }',
  ...[
    "AppTheme",
    "supportKeyboard",
    "EventPhase",
    "HandledEventPhase",
    "DynamicColorMacOS",
    "ColorWithSystemEffectMacOS",
  ].map((n) => `export const ${n} = "DENEXT_${n}";`),
  "",
].join("\n");

/** Bundle `entry` of the fixture with React Native mode's plugins and the stand-in overlay. */
async function bundle(
  entry: string,
  reactNative: DenextConfig["reactNative"] = true,
): Promise<{ code: string; mod: Record<string, Any> }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_desktop_" });
  try {
    await writeTree(dir, FIXTURE);
    const options = reactNativeBundleOptions({ reactNative }, dir, false)!;
    const standIn: esbuild.Plugin = {
      name: "stand-in",
      setup(build) {
        build.onResolve({ filter: /^denext\/react-native$/ }, (args) => ({
          path: args.path,
          namespace: "stand-in",
        }));
        build.onLoad({ filter: /.*/, namespace: "stand-in" }, () => ({
          contents: STAND_IN,
          loader: "js",
        }));
      },
    };
    const out = await esbuild.build({
      entryPoints: [join(dir, entry)],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      absWorkingDir: dir,
      plugins: [...options.plugins, standIn],
    });
    const code = new TextDecoder().decode(out.outputFiles![0].contents);
    const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    return { code, mod: await import(url) };
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("react-native-windows: react-native's exports plus its additions; never the real package", async () => {
  const { mod } = await bundle("win.js");
  const W = mod.W;
  assertEquals(W.Text, "RNW_TEXT", "react-native's own export");
  assertEquals(W.View, "DESKTOP_VIEW(RNW_VIEW,windows)", "the desktop View replaces View");
  assertEquals(W.ViewWindows, W.View);
  assertEquals(W.Flyout, "FLYOUT(RNW_MODAL,RNW_VIEW)");
  assertEquals(W.Popup, "POPUP(RNW_MODAL,RNW_VIEW)");
  assertEquals(W.Glyph, "GLYPH(RNW_TEXT)");
  assertEquals(W.AppTheme, "DENEXT_AppTheme");
  assertEquals(mod.Thing, "DEEP_THING", "a deep Libraries/ path resolves as react-native's");
  for (const name of DESKTOP_ALIASES["react-native-windows"].provided) {
    if (name === "unstable_batchedUpdates") continue; // from react-dom, not in this fixture
    assert(mod.names.includes(name), `react-native-windows exports ${name}`);
  }
});

Deno.test("react-native-macos: the macOS additions; unused additions tree-shake away", async () => {
  const { mod } = await bundle("mac.js");
  assertEquals(mod.M.View, "DESKTOP_VIEW(RNW_VIEW,macos)");
  assertEquals(mod.M.DynamicColorMacOS, "DENEXT_DynamicColorMacOS");
  assertEquals(mod.M.Flyout, undefined, "Windows-only additions are not on macOS");
  const { code } = await bundle("only-text.js");
  for (const marker of ["FLYOUT(", "GLYPH(", "DESKTOP_VIEW(", "DENEXT_"]) {
    assert(!code.includes(marker), `${marker} is not in a bundle that never uses it`);
  }
});

Deno.test("reactNative.desktopPackage: the app's own react-native imports resolve as the desktop package", async () => {
  const win = await bundle("app.js", { desktopPackage: "react-native-windows" });
  assertEquals(win.mod.View, "DESKTOP_VIEW(RNW_VIEW,windows)", "the app gets the desktop View");
  assertEquals(win.mod.Flyout, "FLYOUT(RNW_MODAL,RNW_VIEW)");
  assertEquals(win.mod.Text, "RNW_TEXT");
  assert(win.mod.names.includes("Popup"), "a namespace import sees the additions too");
  assertEquals(win.mod.LibView, "RNW_VIEW", "node_modules keep react-native (react-native-web)");
  const mac = await bundle("app.js", { desktopPackage: "react-native-macos" });
  assertEquals(mac.mod.View, "DESKTOP_VIEW(RNW_VIEW,macos)");
  assertEquals(mac.mod.Flyout, undefined, "Flyout is Windows-only");
  // Unset: react-native is react-native-web, with no desktop additions.
  const plain = await bundle("app.js");
  assertEquals(plain.mod.View, "RNW_VIEW");
  assertEquals(plain.mod.Flyout, undefined);
});

Deno.test("reactNative.desktopPackage: validated", () => {
  const spa: DenextConfig = { mode: "spa", spa: { entry: "./src/main.tsx" } };
  validateDenextConfig({ ...spa, reactNative: { desktopPackage: "react-native-macos" } });
  validateDenextConfig({ ...spa, reactNative: { desktopPackage: "react-native-windows" } });
  assertThrows(
    () =>
      validateDenextConfig({
        ...spa,
        reactNative: { desktopPackage: "react-native-tvos" as "react-native-macos" },
      }),
    Error,
    '`reactNative.desktopPackage` must be "react-native-macos" or "react-native-windows"',
  );
});

Deno.test("desktopEntrySource: re-exports react-native and binds the overlay through a namespace", () => {
  const src = desktopEntrySource("windows");
  assertStringIncludes(src, 'export * from "react-native";');
  assertStringIncludes(src, 'import * as __desktop from "denext/react-native";');
  assert(!desktopEntrySource("macos").includes("Flyout"));
});

// ---- behaviour ---------------------------------------------------------------------

/** A fake react-native-web View / Text: a div with its style flattened into `data-style`. */
function fakeView(props: Any) {
  const { style, children, ref, ...rest } = props;
  const flat = Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
  return h("div", {
    ...rest,
    ref,
    "data-style": JSON.stringify(flat),
  }, children);
}

/** A fake react-native-web Modal: its children while `visible`. */
function fakeModal(props: Any) {
  return props.visible ? h("section", { "data-modal": "" }, props.children) : null;
}

Deno.test("desktop View: tooltip → title, onDoubleClick, focus ring, no-op props warn once", () => {
  const View = createDesktopView(fakeView as Any, "macos");
  const clicks: Any[] = [];
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  try {
    const { container, root, rerender } = mount(() =>
      h(View as Any, {
        tooltip: "Hello",
        onDoubleClick: (e: Any) => clicks.push(e),
        enableFocusRing: false,
        acceptsFirstMouse: true,
        mouseDownCanMoveWindow: true,
        allowsVibrancy: false,
      }, "x")
    );
    const el = container.firstChild as Any;
    assertEquals(el.getAttribute("title"), "Hello");
    assertEquals(JSON.parse(el.getAttribute("data-style")).outlineStyle, "none");
    el.dispatch("dblclick", { clientX: 3 });
    assertEquals(clicks.length, 1);
    assertEquals(clicks[0].nativeEvent, clicks[0], "the event carries nativeEvent");
    rerender();
    assertEquals(
      warnings.length,
      2,
      "acceptsFirstMouse and (off desktop) mouseDownCanMoveWindow, once each",
    );
    root.unmount();
  } finally {
    console.warn = warn;
  }
});

Deno.test("desktop View: keyDownEvents — macOS passes only listed keys, Windows every key", () => {
  const events = (key: string, code: string, extra: Record<string, unknown> = {}) => {
    let prevented = false;
    const e: Any = { key, code, preventDefault: () => void (prevented = true), ...extra };
    e.nativeEvent = e;
    return { e, prevented: () => prevented };
  };
  for (const flavor of ["macos", "windows"] as const) {
    const seen: string[] = [];
    let handler: Any;
    const probe = (props: Any) => {
      handler = props.onKeyDown;
      return null;
    };
    const View = createDesktopView(probe as Any, flavor);
    const keys = flavor === "macos"
      ? { validKeysDown: ["Enter", { key: "k", metaKey: true }] }
      : { keyDownEvents: [{ code: "Enter" }] };
    const { root } = mount(() =>
      h(View as Any, { ...keys, onKeyDown: (e: Any) => void seen.push(e.key) })
    );
    const enter = events("Enter", "Enter");
    handler(enter.e);
    assert(enter.prevented(), `${flavor}: a listed key is handled`);
    const a = events("a", "KeyA");
    handler(a.e);
    assert(!a.prevented());
    if (flavor === "macos") {
      handler(events("k", "KeyK", { metaKey: true }).e);
      handler(events("k", "KeyK").e); // no ⌘: not listed
      assertEquals(seen, ["Enter", "k"], "macOS: only listed keys reach onKeyDown");
    } else {
      assertEquals(seen, ["Enter", "a"], "Windows: every key reaches onKeyDown");
    }
    root.unmount();
  }
});

Deno.test("Flyout / Popup: open against the target at the placement; light dismiss; Escape", () => {
  const Flyout = createFlyout(fakeModal as Any, fakeView as Any);
  const Popup = createPopup(fakeModal as Any, fakeView as Any);
  const target = {
    getBoundingClientRect: () => ({
      left: 100,
      top: 200,
      right: 140,
      bottom: 220,
      width: 40,
      height: 20,
    }),
  };
  const dismissed: unknown[] = [];
  let props: Any = {
    isOpen: false,
    target,
    placement: "bottom",
    onDismiss: (v: unknown) => dismissed.push(v),
  };
  const { container, rerender, root } = mount(() => h(Flyout as Any, props, "menu"));
  assertEquals(container.childNodes.length, 0, "closed: nothing");
  props = { ...props, isOpen: true, verticalOffset: 4 };
  rerender();
  const [backdrop, content] = (container.firstChild as Any).childNodes;
  const style = JSON.parse(content.getAttribute("data-style"));
  assertEquals([style.left, style.top], [120, 224], "centred under the target, offset 4");
  assertEquals(style.transform, [{ translateX: "-50%" }, { translateY: "0%" }]);
  backdrop.dispatch("click");
  assertEquals(dismissed, [false], "Flyout: light dismiss calls onDismiss(false)");
  root.unmount();

  const popupDismiss: unknown[] = [];
  const popup = mount(() =>
    h(Popup as Any, {
      isOpen: true,
      target,
      horizontalOffset: 5,
      onDismiss: () => popupDismiss.push(1),
    }, "p")
  );
  const [popBackdrop, popContent] = (popup.container.firstChild as Any).childNodes;
  const pstyle = JSON.parse(popContent.getAttribute("data-style"));
  assertEquals([pstyle.left, pstyle.top], [105, 200], "Popup: the target's top-left + offset");
  popBackdrop.dispatch("click");
  assertEquals(popupDismiss, [], "Popup: no light dismiss by default");
  popup.root.unmount();
});

Deno.test("Flyout: full placement fills the window; no target centres; overlay dims; unknown placement is top", () => {
  const Flyout = createFlyout(fakeModal as Any, fakeView as Any);
  const contentStyle = (props: Any) => {
    const { container, root } = mount(() => h(Flyout as Any, { isOpen: true, ...props }, "x"));
    const [backdrop, content] = (container.firstChild as Any).childNodes;
    const out = {
      backdrop: JSON.parse(backdrop.getAttribute("data-style")),
      content: JSON.parse(content.getAttribute("data-style")),
    };
    root.unmount();
    return out;
  };
  const target = {
    current: {
      getBoundingClientRect: () => ({
        left: 100,
        top: 200,
        right: 140,
        bottom: 220,
        width: 40,
        height: 20,
      }),
    },
  };
  // "full" ignores the target and the offsets.
  assertEquals(contentStyle({ placement: "full", target, horizontalOffset: 9 }).content, {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  });
  // No target (or one that cannot be measured): centred in the window, offsets as margins.
  for (const t of [undefined, { current: null }, {}]) {
    const c = contentStyle({ target: t, horizontalOffset: 3, verticalOffset: -2 }).content;
    assertEquals([c.left, c.top, c.marginLeft, c.marginTop], ["50%", "50%", 3, -2]);
    assertEquals(c.transform, [{ translateX: "-50%" }, { translateY: "-50%" }]);
  }
  // A ref target is measured; an unknown placement falls back to "top" (above, centred).
  const top = contentStyle({ target, placement: "diagonal" }).content;
  assertEquals([top.left, top.top], [120, 200]);
  assertEquals(top.transform, [{ translateX: "-50%" }, { translateY: "-100%" }]);
  // isOverlayEnabled dims the backdrop; without it the backdrop is clear.
  assertEquals(
    contentStyle({ isOverlayEnabled: true }).backdrop.backgroundColor,
    "rgba(0,0,0,0.3)",
  );
  assertEquals(contentStyle({}).backdrop.backgroundColor, undefined);
});

Deno.test("Glyph without a font or size is plain text in the inherited font", () => {
  const Glyph = createGlyph(fakeView as Any);
  for (const fontUri of [undefined, "ms-appx:///Fonts/icons.ttf"]) {
    const { container, root } = mount(() => h(Glyph as Any, { glyph: "A", fontUri }));
    const el = container.firstChild as Any;
    assertEquals(el.textContent, "A");
    assertEquals(JSON.parse(el.getAttribute("data-style")), {});
    root.unmount();
  }
});

Deno.test("Glyph, AppTheme, supportKeyboard, EventPhase", async () => {
  const Glyph = createGlyph(fakeView as Any);
  const { container, root } = mount(() =>
    h(Glyph as Any, {
      glyph: "",
      fontUri: "ms-appx:///Fonts/icons.ttf#Segoe Fluent Icons",
      emSize: 20,
    })
  );
  const el = container.firstChild as Any;
  assertEquals(el.textContent, "");
  assertEquals(JSON.parse(el.getAttribute("data-style")), {
    fontSize: 20,
    fontFamily: "Segoe Fluent Icons",
  });
  root.unmount();
  const Comp = () => null;
  assertEquals(supportKeyboard(Comp), Comp);
  assertEquals(EventPhase.Bubbling, 3);
  assertEquals(HandledEventPhase, { Capturing: 1, Bubbling: 3 });
  let listener: ((e: { matches: boolean }) => void) | undefined;
  await withGlobals({
    matchMedia: () => ({
      matches: true,
      addEventListener: (_: string, fn: Any) => void (listener = fn),
      removeEventListener: () => void (listener = undefined),
    }),
  }, () => {
    assertEquals(AppTheme.isHighContrast, true);
    assertEquals(AppTheme.currentHighContrastColors.WindowColor, "Canvas");
    const seen: boolean[] = [];
    const fn = (e: Any) => void seen.push(e.isHighContrast);
    AppTheme.addListener("highContrastChanged", fn);
    listener!({ matches: false });
    AppTheme.removeListener("highContrastChanged", fn);
    assertEquals(listener, undefined);
    assertEquals(seen, [false]);
  });
});

Deno.test("macOS colors: DynamicColorMacOS, ColorWithSystemEffectMacOS, NSColor / Windows names", async () => {
  await withGlobals({ matchMedia: () => ({ matches: false }) }, () => {
    assertEquals(DynamicColorMacOS({ light: "white", dark: "black" }), "white");
    assertEquals(PlatformColor("controlAccentColor"), "#007aff");
    assertEquals(PlatformColor("SystemColorWindowTextColor"), "CanvasText");
    assertEquals(PlatformColor("SystemAccentColor"), "#0078d4");
  });
  assertEquals(ColorWithSystemEffectMacOS("#336699", "none"), "#336699");
  assertEquals(
    ColorWithSystemEffectMacOS("#336699", "pressed"),
    "color-mix(in srgb, #336699, black 20%)",
  );
});

Deno.test("Platform on Deno Desktop: denextDesktop, os, and the macos / windows select keys", async () => {
  const spec = { ios: "ios", macos: "macos", windows: "windows", default: "default" };
  await withGlobals({ __denext: { desktop: true, os: "darwin" } }, () => {
    assertEquals(Platform.OS, "web");
    assertEquals(Platform.constants.denextDesktop, true);
    assertEquals(Platform.constants.os, "macos");
    assertEquals(Platform.select(spec), "macos");
    assertEquals(Platform.select({ web: "web", ...spec }), "web", "web still wins");
  });
  await withGlobals({ __denext: { desktop: true, os: "windows" } }, () => {
    assertEquals(Platform.select(spec), "windows");
  });
  await withGlobals({ __denext: { desktop: true } }, () => {
    assertEquals(Platform.constants.os, undefined, "a runtime without os");
    assertEquals(Platform.select(spec), "default");
  });
  assertEquals(Platform.constants.denextDesktop, false);
  assertEquals(Platform.select(spec), "default", "a browser never picks desktop keys");
});

Deno.test("RN mode + Deno Desktop coexist: Platform.OS is web, runtimePlatform() is desktop (caps route to the desktop branch)", async () => {
  // RN mode and the desktop-capability runtime are independent axes: RN mode only rewrites which
  // module `react-native*` imports resolve to (react-native-web + the overlay), so React Native's
  // Platform.OS stays "web"; the desktop caps key off `runtimePlatform()` (denext/mobile's own
  // marker), NOT off Platform.OS. This pins that an RN-mode app in a Deno Desktop window still
  // reaches the desktop branch — the per-capability routing itself is covered by
  // tests/desktop-mobile-branches.test.ts.
  await withGlobals({ __denext: { desktop: true, os: "darwin" } }, () => {
    assertEquals(Platform.OS, "web", "RN mode: react-native-web reports web");
    assertEquals(Platform.constants.denextDesktop, true);
    assertEquals(
      runtimePlatform(),
      "desktop",
      "denext/mobile caps see desktop regardless of Platform.OS, so they route to the desktop bridge",
    );
  });
  assertEquals(runtimePlatform(), "web", "off desktop, caps keep their web path");
});

Deno.test("Flyout content is rendered with flushSync-stable identity", () => {
  // Opening twice keeps one content node (no duplicate portals).
  const Flyout = createFlyout(fakeModal as Any, fakeView as Any);
  const { container, rerender, root } = mount(() => h(Flyout as Any, { isOpen: true }, "c"));
  flushSync(() => rerender());
  assertEquals((container.firstChild as Any).childNodes.length, 2);
  const style = JSON.parse((container.firstChild as Any).childNodes[1].getAttribute("data-style"));
  assertEquals([style.left, style.top], ["50%", "50%"], "no target: centred");
  root.unmount();
});

Deno.test("desktop View: draggedTypes — files dragged onto the view (web: the DOM's File objects)", () => {
  const View = createDesktopView(fakeView as Any, "macos");
  const seen: Array<[string, Any]> = [];
  const { container, root } = mount(() =>
    h(View as Any, {
      draggedTypes: ["fileUrl"],
      onDragEnter: (e: Any) => seen.push(["enter", e]),
      onDragLeave: (e: Any) => seen.push(["leave", e]),
      onDrop: (e: Any) => seen.push(["drop", e]),
    }, "x")
  );
  const el = container.firstChild as Any;
  const file = { name: "a.png", type: "image/png", size: 3 };
  let prevented = 0;
  const preventDefault = () => void prevented++;
  el.dispatch("dragenter", { dataTransfer: { files: [file] }, preventDefault });
  el.dispatch("dragover", { preventDefault });
  el.dispatch("drop", { dataTransfer: { files: [file] }, preventDefault });
  el.dispatch("dragleave", { dataTransfer: { files: [] } });
  assertEquals(seen.map(([k]) => k), ["enter", "drop", "leave"]);
  const dropped = seen[1][1].nativeEvent.dataTransfer;
  assertEquals(dropped.types, ["fileUrl"]);
  assertEquals(
    [dropped.files[0].name, dropped.files[0].type, dropped.files[0].size],
    ["a.png", "image/png", 3],
  );
  assertEquals(dropped.files[0].file, file);
  assertEquals(prevented, 3, "dragenter, dragover and drop accept the drag");
  // Without draggedTypes the view takes no drags.
  root.unmount();
});

Deno.test("desktop View in a Deno Desktop window: native drops, drag region and vibrancy", async () => {
  const { createFakeDesktopRuntime, until } = await import("./helpers/desktop-fake-runtime.ts");
  const { resetDesktopBridgeForTesting } = await import("../src/desktop/bridge-client.ts");
  let queue: unknown[] = [];
  const rt = createFakeDesktopRuntime({
    window: {
      capabilities: () => ({ fileDrop: true }),
      takeDrops: () => queue.splice(0, queue.length),
      setBackdrop: () => ({ applied: true }),
    },
  });
  const restore = rt.install();
  try {
    assertEquals(runtimePlatform(), "desktop");
    const View = createDesktopView(fakeView as Any, "macos");
    const drops: Any[] = [];
    const { container, root } = mount(() =>
      h(View as Any, {
        draggedTypes: "fileUrl",
        onDrop: (e: Any) => drops.push(e.nativeEvent.dataTransfer.files),
        mouseDownCanMoveWindow: true,
        allowsVibrancy: true,
      }, "x")
    );
    const el = container.firstChild as Any;
    await until(() => rt.calls.some((c) => c.method === "capabilities"));
    await until(() => rt.calls.some((c) => c.method === "setBackdrop"));
    assertEquals(rt.calls.find((c) => c.method === "setBackdrop")!.args, { backdrop: "vibrancy" });
    await until(() => String(el.getAttribute("style") ?? "").includes("app-region"));
    await new Promise((r) => setTimeout(r, 20));
    // The DOM drop is only accepted: the files come from the runtime, with handles.
    el.dispatch("drop", { dataTransfer: { files: [{ name: "dom.txt" }] } });
    queue = [
      { x: 0, y: 0, files: [{ handle: "h1", name: "a.txt", path: "/tmp/a.txt", size: 1 }] },
      { x: 500, y: 500, files: [{ handle: "h2", name: "b.txt", path: "/tmp/b.txt", size: 1 }] },
    ];
    rt.emit("window", "drop", null);
    await until(() => drops.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(drops.length, 1, "the drop outside the view is not its drop");
    assertEquals(drops[0][0].handle, "h1");
    assertEquals(drops[0][0].uri, "file:///tmp/a.txt");
    root.unmount();
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
});
