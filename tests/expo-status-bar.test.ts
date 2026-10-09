// The `denext/expo/status-bar` shim: Expo's StatusBar over React Native mode's StatusBar, so
// `style` maps to the system bars in the Capacitor shell (faked `SystemBars`), with "auto" /
// "inverted" following the page's color scheme, and nothing happens in a browser.

import { assertEquals } from "@std/assert";
import { act } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { setStatusBarHidden, setStatusBarStyle, StatusBar } from "../src/expo/status-bar.ts";
import { resetStatusBarForTesting } from "../src/react-native/status-bar.ts";
import { makeDom } from "./helpers/dom.ts";
import {
  type Any,
  fakePlugin,
  inShell,
  mount,
  settle,
  Target,
  withGlobals,
} from "./helpers/mobile-fakes.ts";

const BAR_METHODS = ["setStyle", "show", "hide", "setAnimation"];

/**
 * Commit pending renders and run their passive effects, then let promise callbacks run. Not a
 * sleep: a short one lost to the effects' own task when the parallel suite loaded the machine.
 */
async function tick(): Promise<void> {
  await act(() => undefined);
  await settle();
}

/** Globals for a page whose system scheme is `scheme` (a live `prefers-color-scheme` query). */
function schemeEnv(scheme: "light" | "dark") {
  const media = Object.assign(new Target(), { matches: scheme === "dark" });
  const { doc } = makeDom();
  return {
    media,
    globals: {
      document: doc,
      matchMedia: () => media,
      getComputedStyle: () => ({ colorScheme: "" }),
    },
  };
}

Deno.test("expo-status-bar: the static setters map Expo's style for the page's scheme", async () => {
  const bars = fakePlugin(BAR_METHODS);
  const { globals } = schemeEnv("light");
  try {
    await inShell("ios", { SystemBars: bars.plugin }, () => {
      setStatusBarStyle("light");
      setStatusBarStyle("auto"); // light page → dark content
      setStatusBarStyle("inverted"); // light page → light content
      setStatusBarHidden(true, "fade");
      StatusBar.setStyle("dark");
    }, globals);
    assertEquals(bars.calls, [
      ["setStyle", { style: "DARK", bar: "StatusBar" }],
      ["setStyle", { style: "LIGHT", bar: "StatusBar" }],
      ["setStyle", { style: "DARK", bar: "StatusBar" }],
      ["hide", { bar: "StatusBar", animation: "FADE" }],
      ["setStyle", { style: "LIGHT", bar: "StatusBar" }],
    ]);
  } finally {
    resetStatusBarForTesting();
  }
});

Deno.test("expo-status-bar: <StatusBar style=auto> follows a scheme change while mounted", async () => {
  const bars = fakePlugin(BAR_METHODS);
  const { media, globals } = schemeEnv("light");
  try {
    await inShell("android", { SystemBars: bars.plugin }, async () => {
      const { root } = mount(() => h(StatusBar as Any, { style: "auto" }));
      const lastStyle = () => bars.calls.filter(([m]) => m === "setStyle").at(-1);
      await tick();
      assertEquals(lastStyle(), ["setStyle", { style: "LIGHT", bar: "StatusBar" }]);
      media.matches = true;
      media.fire("change", { matches: true });
      await tick();
      assertEquals(lastStyle(), ["setStyle", { style: "DARK", bar: "StatusBar" }]);
      root.unmount();
    }, globals);
  } finally {
    resetStatusBarForTesting();
  }
});

Deno.test("expo-status-bar: nothing in a browser", async () => {
  const bars = fakePlugin(BAR_METHODS);
  const { globals } = schemeEnv("dark");
  try {
    await withGlobals(
      { ...globals, Capacitor: { Plugins: { SystemBars: bars.plugin } } },
      async () => {
        setStatusBarStyle("auto");
        const { root } = mount(() => h(StatusBar as Any, { style: "light", hidden: true }));
        await tick();
        root.unmount();
      },
    );
    assertEquals(bars.calls, []);
  } finally {
    resetStatusBarForTesting();
  }
});
