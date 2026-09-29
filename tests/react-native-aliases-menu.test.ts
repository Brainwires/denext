// React Native mode's MaskedView (@react-native-masked-view/masked-view,
// @expo/ui/community/masked-view) and MenuView (@react-native-menu/menu,
// @expo/ui/community/menu) stand-ins, on the in-memory DOM (the plain-DOM fallbacks).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { gradientImageOf, MaskedView } from "../src/react-native-compat/masked-view.ts";
import { LinearGradient } from "../src/react-native-compat/linear-gradient.ts";
import { type MenuAction, menuItems, MenuView } from "../src/react-native-compat/menu.ts";
import ExpoMaskedView from "../src/expo/ui-community-masked-view.ts";
import { MenuView as ExpoMenuView } from "../src/expo/ui-community-menu.ts";
import { type Any, fakePlugin, inShell, mount, settle } from "./helpers/mobile-fakes.ts";

/** The first element named `tag` under `node`. */
function find(node: Any, tag: string): Any {
  for (const c of node.childNodes ?? []) {
    if (c.nodeType !== 1) continue;
    if (c.tagName?.toLowerCase() === tag) return c;
    const hit = find(c, tag);
    if (hit) return hit;
  }
  return null;
}

Deno.test("gradientImageOf: a LinearGradient element's CSS, else null", () => {
  assertEquals(
    gradientImageOf(h(LinearGradient, { colors: ["black", "transparent"] })),
    "linear-gradient(180deg, black 0%, transparent 100%)",
  );
  assertStringIncludes(
    gradientImageOf(h("x", { colors: ["a", "b"], start: [0, 0.5], end: [1, 0.5] }))!,
    "90deg",
  );
  assertEquals(gradientImageOf(h("x", { colors: [] })), null);
  assertEquals(gradientImageOf("text"), null);
});

Deno.test("MaskedView: a gradient mask is a CSS mask-image; gradient text; else unmasked", () => {
  const faded = mount(() =>
    h(MaskedView, { maskElement: h(LinearGradient, { colors: ["black", "transparent"] }) }, "x")
  );
  const div = find(faded.container, "div");
  assertStringIncludes(div.style.cssText, "mask-image:linear-gradient(180deg");
  assertEquals(div.textContent, "x");

  const text = mount(() =>
    h(
      MaskedView,
      { maskElement: h("span", { style: { fontSize: 20 } }, "Hello") },
      h(LinearGradient, { colors: ["red", "blue"] }),
    )
  );
  const span = find(text.container, "span");
  assertEquals(span.textContent, "Hello");
  assertStringIncludes(span.style.cssText, "background-clip:text");
  assertStringIncludes(span.style.cssText, "linear-gradient(180deg, red 0%, blue 100%)");

  const warnings: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args[0]);
  try {
    const plain = mount(() => h(ExpoMaskedView, { maskElement: h("div", null) }, "kept"));
    assertEquals(find(plain.container, "div").textContent, "kept");
    mount(() => h(MaskedView, { maskElement: null }, "again"));
  } finally {
    console.warn = warn;
  }
  assertEquals(warnings.length, 1, "warns once");
});

Deno.test("menuItems: hidden left out, inline sections spliced, submenus prefixed, flags kept", () => {
  const actions: MenuAction[] = [
    { id: "share", title: "Share", state: "on" },
    { title: "Hidden", attributes: { hidden: true } },
    { title: "Edit", displayInline: true, subactions: [{ id: "copy", title: "Copy" }] },
    {
      title: "Sort",
      subactions: [{ id: "name", title: "By name", attributes: { disabled: true } }],
    },
    { id: "delete", title: "Delete", attributes: { destructive: true } },
  ];
  assertEquals(menuItems(actions), [
    { id: "share", label: "Share", disabled: undefined, destructive: undefined, icon: "✓" },
    { id: "copy", label: "Copy", disabled: undefined, destructive: undefined, icon: undefined },
    {
      id: "name",
      label: "Sort › By name",
      disabled: true,
      destructive: undefined,
      icon: undefined,
    },
    { id: "delete", label: "Delete", disabled: undefined, destructive: true, icon: undefined },
  ]);
});

Deno.test("MenuView: a tap opens the native menu; the choice reaches onPressAction", async () => {
  const menu = fakePlugin(["show"], { show: { selectedId: "b" } });
  await inShell("ios", { DenextContextMenu: menu.plugin }, async () => {
    const events: string[] = [];
    const view = mount(() =>
      h(ExpoMenuView, {
        title: "Pick",
        actions: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
        onOpenMenu: () => events.push("open"),
        onPressAction: ({ nativeEvent }: { nativeEvent: { event: string } }) =>
          events.push(`press:${nativeEvent.event}`),
        onCloseMenu: () => events.push("close"),
        testID: "trigger",
      }, "•••")
    );
    const trigger = find(view.container, "div");
    assertEquals(trigger.getAttribute("data-testid"), "trigger");
    trigger.dispatch("click", { clientX: 3, clientY: 4 });
    await settle();
    await settle();
    assertEquals(events, ["open", "press:b", "close"]);
    const [method, arg] = menu.calls[0] as [string, Any];
    assertEquals(method, "show");
    assertEquals(arg.title, "Pick");
    assertEquals(arg.items.map((i: Any) => i.id), ["a", "b"]);
  });
});

Deno.test("MenuView: shouldOpenOnLongPress opens on a right click, not a tap", async () => {
  const menu = fakePlugin(["show"], { show: { selectedId: null } });
  await inShell("android", { DenextContextMenu: menu.plugin }, async () => {
    const pressed: string[] = [];
    const view = mount(() =>
      h(MenuView, {
        shouldOpenOnLongPress: true,
        actions: [{ title: "Only" }],
        onPressAction: () => pressed.push("x"),
      })
    );
    const trigger = find(view.container, "div");
    trigger.dispatch("click");
    await settle();
    assertEquals(menu.calls.length, 0, "a tap does nothing");
    let prevented = false;
    trigger.dispatch("contextmenu", {
      clientX: 1,
      clientY: 2,
      preventDefault: () => (prevented = true),
    });
    await settle();
    await settle();
    assertEquals(menu.calls.length, 1);
    assert(prevented, "the browser menu is suppressed");
    assertEquals(pressed, [], "a dismissal presses nothing");
  });
});
