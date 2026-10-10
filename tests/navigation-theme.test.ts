// denext/navigation's platform theme and shell haptics (R3-F): the stylesheet (every rule
// parses into a top-level rule; iOS glass / blur and Material 3 selectors keyed off the
// attributes the views render), the attributes and accent every navigator carries, the
// `"auto"` theme marking `<html data-dnx-shell>` only inside the native shell, the header's
// themeable custom properties (plain values as fallbacks), `data-dnx-scrolled` and the
// continuous large-title collapse, and the selection haptic on a tab switch (shell only).

import "./helpers/activity-runtime.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";
import { fakePlugin, inShell, withGlobals } from "./helpers/mobile-fakes.ts";
import { platformThemeCss, themeAttributes } from "../src/navigation/theme.ts";
import { splitRules } from "../src/navigation/animation.ts";
import { StackView } from "../src/navigation/stack-view.ts";
import { TabsView } from "../src/navigation/tabs.ts";
import { StackHeader } from "../src/navigation/header.ts";
import type { StackViewEntry } from "../src/navigation/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Every element under `root` with attribute `name`. */
function findAll(root: FakeElement, name: string): FakeElement[] {
  const out: FakeElement[] = [];
  const visit = (n: Any) => {
    if (n.nodeType === 1 && n.getAttribute(name) !== null) out.push(n);
    for (const c of n.childNodes ?? []) visit(c);
  };
  visit(root);
  return out;
}

const entry = (id: string, text: string, options = {}): StackViewEntry => ({
  id,
  element: h("p", null, text) as never,
  options,
});

Deno.test("platformThemeCss: balanced top-level rules for both looks, light and dark", () => {
  const css = platformThemeCss();
  const rules = splitRules(css);
  assert(rules.length > 25, `${rules.length} rules`);
  for (const rule of rules) assert(rule.endsWith("}"), rule);
  // Scoped to the themed element, with "auto" gated on the shell marker.
  assertStringIncludes(css, ':root[data-dnx-shell] [data-dnx-theme="auto"]');
  assertStringIncludes(css, '[data-dnx-look="ios"]');
  assertStringIncludes(css, '[data-dnx-look="android"]');
  // Light/dark: the OS preference (unless the app forces light) and the app's own switch.
  assertStringIncludes(css, "@media (prefers-color-scheme: dark)");
  assertStringIncludes(css, ':root[data-theme="dark"]');
  // iOS: translucent material and glass; the header only blurs once content is under it.
  assertStringIncludes(css, "backdrop-filter:saturate(180%) blur(20px)");
  assertStringIncludes(css, '[data-dnx-material="glass"]');
  assertStringIncludes(css, '[data-dnx-scrolled] > [data-dnx-header="ios"]');
  assertStringIncludes(css, "-apple-system");
  // Material 3: 64dp top app bar, the indicator derived from the accent.
  assertStringIncludes(css, "--dnx-header-height:64px");
  assertStringIncludes(css, "color-mix(in srgb,var(--dnx-accent)");
  assertStringIncludes(css, "prefers-reduced-transparency");
});

Deno.test("themeAttributes: theme, look, material and the accent variable", () => {
  assertEquals(themeAttributes({}, "ios"), {
    attrs: { "data-dnx-theme": "auto", "data-dnx-look": "ios", "data-dnx-material": "glass" },
    style: {},
  });
  assertEquals(
    themeAttributes({ theme: "platform", material: "blur", accentColor: "#ff2d55" }, "android"),
    {
      attrs: {
        "data-dnx-theme": "platform",
        "data-dnx-look": "android",
        "data-dnx-material": "blur",
      },
      style: { "--dnx-accent": "#ff2d55" },
    },
  );
});

Deno.test("StackHeader: themeable values are custom properties with the plain look as fallback", async () => {
  const ios = await renderToString(
    h(StackHeader, { options: { title: "Inbox" }, platform: "ios", canGoBack: true, onBack() {} }),
  );
  assertStringIncludes(ios, "position:var(--dnx-header-position, relative)");
  assertStringIncludes(ios, "height:var(--dnx-header-height, 44px)");
  assertStringIncludes(ios, "var(--dnx-header-border, 0.5px solid rgba(127, 127, 127, 0.35))");
  assertStringIncludes(ios, "padding:var(--dnx-back-padding, 0)");
  const android = await renderToString(
    h(StackHeader, {
      options: { title: "Inbox" },
      platform: "android",
      canGoBack: false,
      onBack() {},
    }),
  );
  assertStringIncludes(android, "height:var(--dnx-header-height, 56px)");
  assertStringIncludes(android, "font-size:var(--dnx-header-title-size, 20px)");
});

Deno.test("StackView: the server markup carries the theme attributes (no shell marker needed)", async () => {
  const html = await renderToString(
    h(StackView, {
      entries: [entry("a", "A")],
      onPop() {},
      platform: "ios",
      accentColor: "#34c759",
    }),
  );
  assertStringIncludes(html, 'data-dnx-theme="auto"');
  assertStringIncludes(html, 'data-dnx-look="ios"');
  assertStringIncludes(html, "--dnx-accent:#34c759");
});

Deno.test("theme auto: marks <html data-dnx-shell> inside the shell only; plain never does", async () => {
  for (
    const [platform, theme, expected] of [
      ["ios", "auto", "ios"],
      ["android", "auto", "android"],
      ["ios", "plain", null],
    ] as const
  ) {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    await inShell(platform, {}, () => {
      const root = createRoot(container as Any);
      root.render(h(StackView, { entries: [entry("a", "A")], onPop() {}, theme }));
      flushSync();
      root.unmount();
    }, { document: doc });
    assertEquals(
      doc.documentElement.getAttribute("data-dnx-shell"),
      expected,
      `${platform}/${theme}`,
    );
  }
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  await withGlobals({ document: doc }, () => {
    const root = createRoot(container as Any);
    root.render(h(StackView, { entries: [entry("a", "A")], onPop() {} }));
    flushSync();
    root.unmount();
  });
  assertEquals(doc.documentElement.getAttribute("data-dnx-shell"), null, "the web stays plain");
});

Deno.test("StackView: scrolling marks the screen and fades the large title's bar title in", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  root.render(h(StackView, {
    entries: [entry("a", "A", { headerShown: true, headerLargeTitle: true, title: "Mail" })],
    onPop() {},
    platform: "ios",
  }));
  flushSync();
  const section = findAll(container, "data-dnx-screen")[0] as Any;
  const title = findAll(container, "data-dnx-header-title")[0];
  const large = findAll(container, "data-dnx-large-title")[0];
  section.querySelector = (sel: string) =>
    sel === "[data-dnx-header-title]" ? title : sel === "[data-dnx-large-title]" ? large : null;
  const body = findAll(container, "data-dnx-screen-body")[0] as Any;
  const scroll = (top: number) => {
    body.scrollTop = top;
    body.dispatch("scroll", { currentTarget: body });
  };
  scroll(0);
  assertEquals(section.hasAttribute("data-dnx-scrolled"), false);
  assertEquals(title.style.getPropertyValue("opacity"), "0");
  scroll(34);
  assert(section.hasAttribute("data-dnx-scrolled"));
  assertEquals(title.style.getPropertyValue("opacity"), "0.5", "half-way through the fade");
  scroll(200);
  assertEquals(title.style.getPropertyValue("opacity"), "1");
  scroll(-60);
  assertEquals(section.hasAttribute("data-dnx-scrolled"), false);
  assertEquals(large.style.getPropertyValue("transform"), "scale(1.125)", "a pull stretches it");
  scroll(0);
  assertEquals(large.style.getPropertyValue("transform"), "");
  root.unmount();
});

/** Render a two-tab TabsView and press `name`; returns the Haptics calls. */
async function pressTab(
  shell: "ios" | "android" | null,
  name: string,
  props: Record<string, unknown> = {},
): Promise<Array<[string, unknown]>> {
  const haptics = fakePlugin([
    "impact",
    "notification",
    "selectionStart",
    "selectionChanged",
    "selectionEnd",
  ]);
  const pressed: string[] = [];
  const run = () => {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    const root = createRoot(container as Any);
    root.render(h(TabsView, {
      tabs: [{ name: "home", href: "", title: "Home" }, {
        name: "inbox",
        href: "",
        title: "Inbox",
      }],
      active: "home",
      panels: new Map([["home", h("p", null, "home")]]),
      onTabPress: (tab: string) => pressed.push(tab),
      ...props,
    }));
    flushSync();
    const tab = findAll(container, "data-dnx-tab").find((t) =>
      t.getAttribute("data-dnx-tab") === name
    )!;
    tab.dispatch("click", { button: 0 });
    root.unmount();
  };
  if (shell) await inShell(shell, { Haptics: haptics.plugin }, run);
  else await withGlobals({ navigator: { vibrate: () => haptics.calls.push(["vibrate", 0]) } }, run);
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(pressed, [name]);
  return haptics.calls;
}

Deno.test("TabsView: a tab switch plays a selection haptic in the shell only", async () => {
  assertEquals((await pressTab("ios", "inbox")).map((c) => c[0]), [
    "selectionStart",
    "selectionChanged",
    "selectionEnd",
  ]);
  assertEquals((await pressTab("android", "inbox")).length, 3);
  assertEquals(await pressTab("ios", "home"), [], "re-pressing the active tab: no haptic");
  assertEquals(await pressTab("ios", "inbox", { tabHaptics: false }), []);
  assertEquals(await pressTab(null, "inbox"), [], "the web never vibrates for a tab");
});

Deno.test("TabsView: bar values are themeable custom properties; the icon is marked", async () => {
  const html = await renderToString(h(TabsView, {
    tabs: [{ name: "home", href: "/", title: "Home", icon: h("i", null) }],
    active: "home",
    panels: new Map(),
    onTabPress() {},
    platform: "ios",
    theme: "platform",
    material: "blur",
  }));
  assertStringIncludes(html, 'data-dnx-theme="platform"');
  assertStringIncludes(html, 'data-dnx-material="blur"');
  assertStringIncludes(html, "var(--dnx-tabbar-pad-bottom, env(safe-area-inset-bottom, 0px))");
  assertStringIncludes(html, "var(--dnx-tabbar-border-top, 0.5px solid");
  assertStringIncludes(html, "min-height:var(--dnx-tab-min-height, 49px)");
  assertStringIncludes(html, "data-dnx-tab-icon");
});

Deno.test("StackHeader: headerBackButtonDisplayMode shapes the iOS back label", async () => {
  const draw = (options: Record<string, unknown>) =>
    renderToString(
      h(StackHeader, {
        options: { title: "Item", ...options },
        platform: "ios",
        canGoBack: true,
        backTitle: "Inbox",
        onBack() {},
      }),
    );
  const dflt = await draw({});
  assertStringIncludes(dflt, ">Inbox</span>");
  assertStringIncludes(dflt, 'aria-label="Inbox"');
  const minimal = await draw({ headerBackButtonDisplayMode: "minimal" });
  assertEquals(minimal.includes("<span"), false, "chevron only");
  assertStringIncludes(minimal, 'aria-label="Inbox"');
  const generic = await draw({ headerBackButtonDisplayMode: "generic", headerBackTitle: "X" });
  assertStringIncludes(generic, ">Back</span>");
  assertStringIncludes(generic, 'aria-label="Back"');
  assertStringIncludes(await draw({ headerBackTitle: "X" }), ">X</span>");
});
