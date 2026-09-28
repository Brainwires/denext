// React Native mode's small compat patches: ScrollView / VirtualList snap props as CSS scroll
// snap (src/client/virtual/snap.ts, src/react-native/scroll-snap.ts), font scaling
// (src/react-native/font-scaling.ts), Metro's @2x / @3x image variants
// (src/react-native/image-scale.ts), and the build patches over react-native-web's real
// modules (src/build/react-native-patches.ts).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import * as esbuild from "esbuild";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { render } from "../src/testing/mod.ts";
import { type DomEl, walkElements } from "../src/testing/dom.ts";
import { VirtualList } from "../src/client/virtual/virtual-list.ts";
import {
  snapMarkers,
  snapOptionsFromProps,
  snapPositions,
  snapWindow,
} from "../src/client/virtual/snap.ts";
import {
  pickImageScale,
  reactNativeFontScale,
  withFontScaleRatio,
  withFontScaling,
  withScrollSnap,
} from "../src/react-native/mod.ts";
import {
  flattenStyle,
  resetFontScalingForTesting,
  scaledTextStyle,
} from "../src/react-native/font-scaling.ts";
import { resetFontScaleForTesting } from "../src/mobile/accessibility.ts";
import {
  imageScaleModule,
  imageScaleVariants,
  reactNativePatchesPlugin,
  withDimensionsFontScale,
  wrapDefaultExport,
} from "../src/build/react-native-patches.ts";
import { fakePlugin, inShell, settle } from "./helpers/mobile-fakes.ts";

const RNW = new URL(
  "../node_modules/.deno/react-native-web@0.21.2/node_modules/react-native-web/dist/",
  import.meta.url,
);

/** Every element of a rendered screen carrying `attr`. */
function withAttr(container: unknown, attr: string): DomEl[] {
  return walkElements(container as DomEl).filter((e) => e.getAttribute(attr) !== null);
}

// ---- snap points ------------------------------------------------------------------------------

Deno.test("snap: React Native's props map to options; decelerationRate fast stops at each point", () => {
  assertEquals(snapOptionsFromProps({}), null);
  assertEquals(snapOptionsFromProps({ snapToInterval: 0 }), null);
  assertEquals(snapOptionsFromProps({ snapToInterval: 300, decelerationRate: "fast" }), {
    interval: 300,
    offsets: undefined,
    align: undefined,
    snapToStart: undefined,
    snapToEnd: undefined,
    stop: "always",
  });
  assertEquals(
    snapOptionsFromProps({ snapToOffsets: [0, 50], decelerationRate: 0.998 })?.stop,
    "normal",
  );
  assertEquals(
    snapOptionsFromProps({ snapToInterval: 1, disableIntervalMomentum: true })?.stop,
    "always",
  );
});

Deno.test("snap: positions inside the content and the window; offsets add the start and end", () => {
  assertEquals(snapPositions({ interval: 100 }, 450, 0, 1000), [0, 100, 200, 300, 400]);
  assertEquals(snapPositions({ interval: 100 }, 10_000, 250, 520), [300, 400, 500]);
  assertEquals(snapPositions({ offsets: [120, 40] }, 500, 0, 1000), [0, 40, 120, 500]);
  assertEquals(
    snapPositions({ offsets: [120, 40], snapToStart: false, snapToEnd: false }, 500, 0, 1000),
    [40, 120],
  );
  assertEquals(snapWindow(2500, 1000), [-2000, 7000]);
  assertEquals(snapPositions({ interval: 1 }, 1e7, 0, 1e7).length, 400, "capped");
});

Deno.test("snap: markers never reach past the content; alignment and stop are CSS scroll snap", () => {
  const opts = { interval: 300, align: "center" as const, stop: "always" as const };
  const markers = snapMarkers(opts, [0, 300, 600], 700, true, 0, "right");
  const styles = markers.map((m) => (m.props as { style: Record<string, string> }).style);
  assertEquals(styles.map((s) => s.width), ["300px", "300px", "100px"]);
  assertEquals(styles.map((s) => s.right), ["0px", "300px", "600px"]);
  assertEquals(styles[0].scrollSnapAlign, "center");
  assertEquals(styles[0].scrollSnapStop, "always");
  const offsets = snapMarkers({ offsets: [80] }, [80], 500, false, -10);
  const s = (offsets[0].props as { style: Record<string, string> }).style;
  assertEquals([s.top, s.height, s.scrollSnapAlign], ["70px", "0px", "start"]);
});

Deno.test("snap: VirtualList draws markers in the scroller and sets scroll-snap-type", async () => {
  const screen = await render(h(VirtualList as never, {
    style: { height: "400px" },
    count: 40,
    getItemSize: () => 100,
    getItem: (i: number) => i,
    keyExtractor: (i: number) => String(i),
    renderItem: (i: number) => h("div", null, `row ${i}`),
    scrollSnap: { interval: 200, stop: "always" },
  }));
  const markers = withAttr(screen.container, "data-dnx-snap");
  assert(markers.length > 0, "markers drawn");
  assertEquals(markers[0].getAttribute("data-dnx-snap"), "0");
  assertEquals(markers[1].getAttribute("data-dnx-snap"), "200");
  const scroller = withAttr(screen.container, "data-denext-virtual-list")[0];
  assertStringIncludes(scroller.getAttribute("style") ?? "", "scroll-snap-type:y mandatory");
  screen.unmount();
});

Deno.test("snap: the ScrollView wrapper passes through without snap props, draws markers with them", async () => {
  const calls: Record<string, unknown>[] = [];
  const Base = (props: Record<string, unknown>): VNode => {
    calls.push(props);
    return h("div", { "data-base": "" }, props.children as never);
  };
  const ScrollView = withScrollSnap(Base) as never;
  const plain = await render(h(ScrollView, { horizontal: true, style: { flex: 1 } }, "x"));
  assertEquals(calls[0].style, { flex: 1 });
  assertEquals(withAttr(plain.container, "data-dnx-snap").length, 0);
  plain.unmount();

  calls.length = 0;
  const snapping = await render(h(ScrollView, {
    horizontal: true,
    snapToInterval: 250,
    decelerationRate: "fast",
    style: { flex: 1 },
  }, "x"));
  const props = calls[calls.length - 1];
  assertEquals(props.snapToInterval, undefined, "snap props do not reach react-native-web");
  assertEquals((props.style as unknown[])[1], { scrollSnapType: "x mandatory" });
  // Content and viewport sizes arrive through onContentSizeChange / onLayout.
  await (props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width: 500 } } });
  await (props.onContentSizeChange as (w: number, h: number) => void)(1000, 300);
  await settle();
  const markers = withAttr(snapping.container, "data-dnx-snap");
  assertEquals(markers.map((m) => m.getAttribute("data-dnx-snap")), [
    "0",
    "250",
    "500",
    "750",
    "1000",
  ]);
  snapping.unmount();
});

// ---- font scaling -----------------------------------------------------------------------------

Deno.test("font scaling: fontSize and lineHeight times the factor, capped, nested Texts inherit", () => {
  assertEquals(scaledTextStyle({ style: { fontSize: 16, lineHeight: 20 } }, 1.5, false), {
    fontSize: 24,
    lineHeight: 30,
  });
  assertEquals(scaledTextStyle({ style: [{ fontSize: 10 }, null, [{ fontSize: 20 }]] }, 2, true), {
    fontSize: 40,
  });
  assertEquals(scaledTextStyle({}, 2, false), { fontSize: 28 }, "the default 14px");
  assertEquals(scaledTextStyle({}, 2, true), null, "an unsized inner Text inherits");
  assertEquals(scaledTextStyle({ style: { fontSize: 10 }, maxFontSizeMultiplier: 1.2 }, 2, false), {
    fontSize: 12,
  });
  assertEquals(
    scaledTextStyle({ style: { fontSize: 10 }, allowFontScaling: false }, 2, false),
    null,
  );
  assertEquals(scaledTextStyle({ style: { fontSize: 10 } }, 1, false), null);
  assertEquals(flattenStyle([{ a: 1 }, false, [{ a: 2, b: 3 }]]), { a: 2, b: 3 });
});

Deno.test("font scaling: the shell's Dynamic Type reaches Text and PixelRatio", async () => {
  resetFontScaleForTesting();
  resetFontScalingForTesting();
  const plugin = fakePlugin(["isScreenReaderEnabled", "getFontScale"], {
    getFontScale: { value: 2 },
  });
  const seen: unknown[] = [];
  const Base = (props: Record<string, unknown>): VNode => {
    seen.push(props.style);
    return h("span", null, props.children as never);
  };
  const Text = withFontScaling(Base) as never;
  await inShell("ios", { DenextAccessibility: plugin.plugin }, async () => {
    const PixelRatio = withFontScaleRatio({ getFontScale: () => 1 });
    assertEquals(PixelRatio.getFontScale(), 1, "before the first answer");
    await settle();
    assertEquals(reactNativeFontScale(), 2);
    assertEquals(PixelRatio.getFontScale(), 2);
    const screen = await render(h(Text, { style: { fontSize: 12 } }, h(Text, null, "inner")));
    assertEquals(seen[0], [{ fontSize: 12 }, { fontSize: 24 }]);
    assertEquals(seen[1], undefined, "the inner Text inherits");
    screen.unmount();
  });
  resetFontScaleForTesting();
  resetFontScalingForTesting();
});

// ---- @2x / @3x --------------------------------------------------------------------------------

Deno.test("image scale: React Native's pick — the smallest scale at or above the ratio, else the largest", () => {
  const v: [number, string][] = [[3, "c"], [1, "a"], [2, "b"]];
  assertEquals(pickImageScale(v, 1), "a");
  assertEquals(pickImageScale(v, 1.5), "b");
  assertEquals(pickImageScale(v, 2), "b");
  assertEquals(pickImageScale(v, 4), "c");
  assertEquals(pickImageScale([], 2), "");
});

Deno.test("image scale: variants on disk (no base file needed); a plain image is left alone", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_images_" });
  try {
    const names = [
      "logo@2x.png",
      "logo@3x.png",
      "plain.png",
      "icon.png",
      "icon@1.5x.png",
      "clear.png",
      "clear@2x.png",
      "clear@3x.png",
      "both.png",
      "both@1x.png",
      "both@2x.png",
      "one@1x.png",
    ];
    for (const f of names) {
      await Deno.writeFile(join(dir, f), new Uint8Array([137, 80, 78, 71]));
    }
    assertEquals(await imageScaleVariants(join(dir, "logo.png")), [
      [2, join(dir, "logo@2x.png")],
      [3, join(dir, "logo@3x.png")],
    ]);
    assertEquals(await imageScaleVariants(join(dir, "plain.png")), []);
    assertEquals((await imageScaleVariants(join(dir, "icon.png"))).map(([s]) => s), [1, 1.5]);
    // Metro's base file is the 1x: base + @2x + @3x with no @1x file imports only what exists.
    assertEquals(await imageScaleVariants(join(dir, "clear.png")), [
      [1, join(dir, "clear.png")],
      [2, join(dir, "clear@2x.png")],
      [3, join(dir, "clear@3x.png")],
    ]);
    // The plain file wins over an @1x; a lone @1x is not a density set.
    assertEquals((await imageScaleVariants(join(dir, "both.png")))[0], [1, join(dir, "both.png")]);
    assertEquals(await imageScaleVariants(join(dir, "one.png")), []);
    assertStringIncludes(
      imageScaleModule([[1, "/x/a.png"], [2, "/x/a@2x.png"]]),
      'pickImageScale([\n  [1, require("./a.png")],\n  [2, require("./a@2x.png")]',
    );

    // Through esbuild: `require("./logo.png")` bundles both variants and picks at run time.
    await Deno.writeTextFile(
      join(dir, "entry.js"),
      'module.exports = [require("./logo.png"), require("./clear.png")];\n',
    );
    const out = await esbuild.build({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      write: false,
      outdir: join(dir, "out"),
      format: "cjs",
      loader: { ".png": "file" },
      external: ["denext/react-native"],
      plugins: [reactNativePatchesPlugin()],
      logLevel: "silent",
    });
    const files = out.outputFiles.map((f) => f.path.slice(dir.length + 5));
    assert(files.some((f) => f.startsWith("logo@2x-")), files.join());
    assert(files.some((f) => f.startsWith("logo@3x-")), files.join());
    for (const f of ["clear-", "clear@2x-", "clear@3x-"]) {
      assert(files.some((n) => n.startsWith(f)), `${f}: ${files.join()}`);
    }
    const js = out.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
    assertStringIncludes(js, 'require("denext/react-native").pickImageScale');
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- react-native-web patches -----------------------------------------------------------------

Deno.test("patches: react-native-web's real ScrollView / Text / PixelRatio / Dimensions, ES and CJS", async () => {
  for (const cjs of [false, true]) {
    const at = (name: string) => new URL(`${cjs ? "cjs/" : ""}exports/${name}/index.js`, RNW);
    const cases: [string, string, string][] = [
      ["ScrollView", "withScrollSnap", "ForwardedScrollView"],
      ["Text", "withFontScaling", "Text"],
      ["PixelRatio", "withFontScaleRatio", "PixelRatio"],
      ["Image", "withImageStatics", "ImageWithStatics"],
    ];
    for (const [name, wrapper, local] of cases) {
      const source = await Deno.readTextFile(at(name));
      const out = wrapDefaultExport(source, wrapper, cjs);
      assert(out !== source, `${name} (${cjs ? "cjs" : "es"}) was patched`);
      if (cjs) assertStringIncludes(out, `.${wrapper}(${local});`);
      else assertStringIncludes(out, `export default __denextWrap(${local});`);
      await esbuild.transform(out, { loader: "js", format: cjs ? "cjs" : "esm" });
    }
    const dims = withDimensionsFontScale(await Deno.readTextFile(at("Dimensions")), cjs);
    assert(!/fontScale:\s*1\b/.test(dims));
    assertStringIncludes(dims, "fontScale: __denextFontScale()");
    await esbuild.transform(dims, { loader: "js", format: cjs ? "cjs" : "esm" });
  }
  assertEquals(wrapDefaultExport("export const x = 1;\n", "w", false), "export const x = 1;\n");
  assertEquals(withDimensionsFontScale("const a = 1;", false), "const a = 1;");
  await esbuild.stop();
});
