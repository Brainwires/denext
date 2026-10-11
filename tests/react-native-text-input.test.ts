// React Native mode's TextInput look (src/react-native/text-input.ts): react-native-web's
// TextInput wrapped with React Native's outline (none unless styled) and a one-line placeholder,
// its statics kept. A stand-in records the props react-native-web would get.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { render } from "../src/testing/mod.ts";
import { withTextInputDefaults } from "../src/react-native/mod.ts";
import { TEXT_INPUT_CLASS } from "../src/react-native/text-input.ts";
import { makeDom } from "./helpers/dom.ts";
import { withGlobals } from "./helpers/mobile-fakes.ts";

Deno.test("withTextInputDefaults: the outline base, the placeholder class, then the app's style", async () => {
  const seen: Record<string, unknown>[] = [];
  function Base(props: Record<string, unknown>): VNode {
    seen.push(props);
    return h("textarea", { placeholder: props.placeholder as string });
  }
  Object.assign(Base, { State: { currentlyFocusedInput: () => null } });
  const TextInput = withTextInputDefaults(Base as never) as unknown as
    & ((p: Record<string, unknown>) => VNode)
    & { State?: unknown; displayName?: string };
  assert(TextInput.State, "statics are kept");
  assertEquals(TextInput.displayName, "TextInput");
  const appStyle = { outlineWidth: 2, outlineColor: "blue" };
  const { doc } = makeDom();
  await withGlobals({ document: doc }, async () => {
    const screen = await render(
      h(TextInput, { placeholder: "Ask the repo agent", multiline: true, style: appStyle }),
    );
    await screen.rerender(h(TextInput, { placeholder: "again", style: appStyle }));
    await screen.unmount();
  });
  const props = seen.at(-1)!;
  const style = props.style as unknown[];
  assertEquals(style[0], { outlineWidth: 0, outlineStyle: "solid" });
  assertEquals(style[1], { $$css: true, denextTextInput: TEXT_INPUT_CLASS });
  assertEquals(style[2], appStyle, "the app's outline wins (and shows solid)");
  assertEquals(seen[0].multiline, true, "the other props pass through");
  const rules = doc.head.childNodes.map((n) => (n as { textContent?: string }).textContent ?? "");
  assertEquals(rules.length, 1, "the placeholder rule is added once");
  assert(rules[0].startsWith(`.${TEXT_INPUT_CLASS}::placeholder{white-space:nowrap;`), rules[0]);
});
