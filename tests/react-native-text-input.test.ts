// React Native mode's TextInput (src/react-native/text-input.ts): react-native-web's TextInput
// wrapped with React Native's outline (none unless styled), a one-line placeholder, and the
// React Native props it drops (autoComplete / textContentType tokens, submitBehavior,
// onEndEditing, cursorColor / selectionColor), its statics kept. A stand-in records the props
// react-native-web would get.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { render } from "../src/testing/mod.ts";
import { withTextInputDefaults } from "../src/react-native/mod.ts";
import {
  blurOnSubmitFor,
  htmlAutoComplete,
  SELECTION_CLASS,
  TEXT_INPUT_CLASS,
  textInputProps,
} from "../src/react-native/text-input.ts";
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

Deno.test("htmlAutoComplete: React Native's autoComplete and iOS's textContentType as HTML tokens", () => {
  assertEquals(htmlAutoComplete("password-new", undefined), "new-password");
  assertEquals(htmlAutoComplete("sms-otp", undefined), "one-time-code");
  assertEquals(htmlAutoComplete("name-given", undefined), "given-name");
  assertEquals(htmlAutoComplete("postal-address-region", undefined), "address-level1");
  assertEquals(htmlAutoComplete("password", undefined), "current-password");
  assertEquals(htmlAutoComplete("email", "username"), "email", "same spelling; autoComplete wins");
  assertEquals(htmlAutoComplete(undefined, "oneTimeCode"), "one-time-code");
  assertEquals(htmlAutoComplete(undefined, "newPassword"), "new-password");
  assertEquals(htmlAutoComplete(undefined, "emailAddress"), "email");
  assertEquals(htmlAutoComplete(undefined, "none"), "off");
  assertEquals(htmlAutoComplete(undefined, "flightNumber"), undefined, "no HTML token");
  assertEquals(htmlAutoComplete(undefined, "toString"), undefined, "own keys only");
  assertEquals(htmlAutoComplete("", undefined), undefined);
});

Deno.test("blurOnSubmitFor: submitBehavior as react-native-web's blurOnSubmit", () => {
  assertEquals(blurOnSubmitFor("blurAndSubmit", true), true);
  assertEquals(blurOnSubmitFor("submit", false), false);
  assertEquals(blurOnSubmitFor("newline", false), true, "single-line: blurAndSubmit");
  assertEquals(blurOnSubmitFor("newline", true), false, "multiline: the newline");
  assertEquals(blurOnSubmitFor(undefined, true), undefined);
});

/** A keydown as react-native-web hands it to onKeyPress. */
function enter(value: string, init: { shiftKey?: boolean; isComposing?: boolean } = {}) {
  let prevented = false;
  return {
    key: "Enter",
    shiftKey: init.shiftKey ?? false,
    target: { value },
    nativeEvent: { isComposing: init.isComposing ?? false } as Record<string, unknown>,
    preventDefault() {
      prevented = true;
    },
    isDefaultPrevented: () => prevented,
  };
}

Deno.test("textInputProps: React Native-only props mapped and removed", () => {
  const out = textInputProps({
    autoComplete: "sms-otp",
    textContentType: "oneTimeCode",
    submitBehavior: "blurAndSubmit",
    cursorColor: "red",
    selectionColor: "blue",
    style: { color: "black" },
  });
  assertEquals(out.autoComplete, "one-time-code");
  assertEquals(out.blurOnSubmit, true);
  for (const key of ["textContentType", "submitBehavior", "cursorColor", "selectionColor"]) {
    assert(!(key in out), `${key} is not passed to react-native-web`);
  }
  const style = out.style as unknown[];
  assertEquals(style[2], { $$css: true, denextSelection: SELECTION_CLASS });
  assertEquals(style[3], { color: "black" });
  assertEquals(style[4], { caretColor: "red", "--denext-rn-selection": "blue" });
  const plain = textInputProps({ selectionColor: "green" });
  assertEquals((plain.style as unknown[]).at(-1), {
    caretColor: "green",
    "--denext-rn-selection": "green",
  }, "selectionColor tints the caret when there is no cursorColor");
  assertEquals((textInputProps({}).style as unknown[]).length, 3, "nothing added unasked");
  assert(!("autoComplete" in textInputProps({})), "react-native-web's default stays");
});

Deno.test("textInputProps: submitBehavior='submit' on a multiline input submits and keeps the text", () => {
  const submitted: unknown[] = [];
  const keys: string[] = [];
  const out = textInputProps({
    multiline: true,
    submitBehavior: "submit",
    onSubmitEditing: (e) => submitted.push(e.nativeEvent?.text),
    onKeyPress: (e) => keys.push(e.key ?? ""),
  });
  assertEquals(out.blurOnSubmit, false, "no blur");
  const onKeyPress = out.onKeyPress as (e: unknown) => void;
  const e = enter("hello");
  onKeyPress(e);
  assertEquals(submitted, ["hello"]);
  assert(e.isDefaultPrevented(), "no newline, and react-native-web skips its own submit");
  onKeyPress(enter("a", { shiftKey: true }));
  onKeyPress(enter("b", { isComposing: true }));
  assertEquals(submitted, ["hello"], "Shift+Enter and an IME composition are not submits");
  assertEquals(keys, ["Enter", "Enter", "Enter"], "the app's onKeyPress still runs first");
  assert(
    !("onKeyPress" in textInputProps({ submitBehavior: "submit", onSubmitEditing() {} })),
    "a single-line input already submits without blurring",
  );
});

Deno.test("textInputProps: onEndEditing runs with the text before onBlur", () => {
  const calls: string[] = [];
  const out = textInputProps({
    onEndEditing: (e) => calls.push(`end:${e.nativeEvent?.text}`),
    onBlur: () => calls.push("blur"),
  });
  (out.onBlur as (e: unknown) => void)({ target: { value: "typed" }, nativeEvent: {} });
  assertEquals(calls, ["end:typed", "blur"]);
  assert(!("onEndEditing" in out));
});

Deno.test("withTextInputDefaults: the selection rule is in the stylesheet", async () => {
  const { doc } = makeDom();
  function Base(): VNode {
    return h("input", {});
  }
  const TextInput = withTextInputDefaults(Base as never) as unknown as (
    p: Record<string, unknown>,
  ) => VNode;
  await withGlobals({ document: doc }, async () => {
    const screen = await render(h(TextInput, { selectionColor: "#0a84ff" }));
    await screen.unmount();
  });
  const rules = doc.head.childNodes.map((n) => (n as { textContent?: string }).textContent ?? "");
  assert(rules.some((r) => r.includes(`.${SELECTION_CLASS}::selection{background-color:`)));
});
