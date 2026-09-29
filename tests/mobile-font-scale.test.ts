// denext/mobile's font scale (src/mobile/accessibility.ts): the OS text size from the
// DenextAccessibility plugin as the factor the page must apply (iOS: Dynamic Type whole;
// Android: over the WebView's text zoom), change events, the hook, and applyFontScale's opt-in
// root font size.

import { assertEquals } from "@std/assert";
import {
  applyFontScale,
  fontScaleNow,
  getFontScale,
  onFontScaleChange,
  resetFontScaleForTesting,
} from "../src/mobile/accessibility.ts";
import { type Any, fakePlugin, inShell, settle, withGlobals } from "./helpers/mobile-fakes.ts";

/** A fake root element with an inline style. */
function fakeRoot(fontSize = "") {
  const props = new Map<string, string>();
  const style: Any = {
    fontSize,
    setProperty: (k: string, v: string) => void props.set(k, v),
    removeProperty: (k: string) => void props.delete(k),
  };
  return { el: { style } as Any, props };
}

Deno.test("font scale: iOS answers Dynamic Type whole; Android over the WebView's text zoom", async () => {
  resetFontScaleForTesting();
  const ios = fakePlugin(["isScreenReaderEnabled", "getFontScale"], {
    getFontScale: { value: 1.353 },
  });
  await inShell("ios", { DenextAccessibility: ios.plugin }, async () => {
    assertEquals(await getFontScale(), 1.353);
    assertEquals(fontScaleNow(), 1.353);
  });
  resetFontScaleForTesting();
  const android = fakePlugin(["isScreenReaderEnabled", "getFontScale"], {
    getFontScale: { value: 1.3, textZoom: 130 },
  });
  await inShell("android", { DenextAccessibility: android.plugin }, async () => {
    assertEquals(await getFontScale(), 1, "the WebView already applies it");
  });
  const unzoomed = fakePlugin(["isScreenReaderEnabled", "getFontScale"], {
    getFontScale: { value: 1.3, textZoom: 100 },
  });
  await inShell("android", { DenextAccessibility: unzoomed.plugin }, async () => {
    assertEquals(await getFontScale(), 1.3);
  });
  resetFontScaleForTesting();
});

Deno.test("font scale: 1 on the web, in a shell without the plugin, or a generation-1 plugin", async () => {
  resetFontScaleForTesting();
  assertEquals(await getFontScale(), 1);
  await inShell("ios", {}, async () => assertEquals(await getFontScale(), 1));
  const v1 = fakePlugin(["isScreenReaderEnabled"]);
  await inShell("ios", { DenextAccessibility: v1.plugin }, async () => {
    assertEquals(await getFontScale(), 1);
    assertEquals(typeof onFontScaleChange(() => {}), "function");
  });
});

Deno.test("font scale: change events update the factor; applyFontScale follows and restores", async () => {
  resetFontScaleForTesting();
  const plugin = fakePlugin(["isScreenReaderEnabled", "getFontScale"], {
    getFontScale: { value: 1.235 },
  });
  const root = fakeRoot();
  await inShell("ios", { DenextAccessibility: plugin.plugin }, async () => {
    const seen: number[] = [];
    const stop = onFontScaleChange((s) => seen.push(s));
    await settle();
    const dispose = applyFontScale({ max: 2 });
    await settle();
    assertEquals(root.el.style.fontSize, "19.76px", "16px computed × 1.235");
    assertEquals(root.props.get("--dnx-font-scale"), "1.235");
    plugin.fire("fontScaleChanged", { value: 3.571 });
    assertEquals(seen, [3.571]);
    assertEquals(root.el.style.fontSize, "32px", "capped at max 2");
    plugin.fire("fontScaleChanged", { value: 1 });
    assertEquals(root.el.style.fontSize, "", "the default size restores the page's own");
    dispose();
    stop();
    assertEquals(root.props.has("--dnx-font-scale"), false);
    assertEquals(plugin.listening(), 0);
  }, {
    document: { documentElement: root.el },
    getComputedStyle: () => ({ fontSize: "16px" }),
  });
  resetFontScaleForTesting();
});

Deno.test("font scale: applyFontScale without a document is a no-op", async () => {
  await withGlobals({ document: undefined }, () => {
    applyFontScale()();
  });
});
