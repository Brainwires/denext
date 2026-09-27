// React Native mode's community stand-ins for view / keyboard packages
// (src/react-native-compat): react-native-linear-gradient, @react-native-community/blur,
// @react-native-community/datetimepicker, react-native-date-picker,
// and react-native-keyboard-controller. Each renders on the
// in-memory DOM (outside React Native mode, so the plain-DOM fallbacks) with a faked Capacitor
// shell where the behaviour depends on it.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { flushSync } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useRef } from "../src/runtime/hooks.ts";
import {
  gradientColor,
  LinearGradient,
  linearGradientCss,
} from "../src/react-native-compat/linear-gradient.ts";
import { BlurView, VibrancyView } from "../src/react-native-compat/blur.ts";
import { fromInputValue, toInputValue } from "../src/react-native-compat/internal/date-input.ts";
import DateTimePicker, {
  createDateTimeSetEvtParams,
  DateTimePickerAndroid,
  type DateTimePickerEvent,
} from "../src/react-native-compat/datetimepicker.ts";
import DatePicker from "../src/react-native-compat/date-picker.ts";
import {
  KeyboardAwareScrollView,
  KeyboardController,
  KeyboardEvents,
  KeyboardToolbar,
  reanimatedKeyboardExports,
  resetKeyboardControllerForTesting,
  useKeyboardAnimation,
  useKeyboardHandler,
  useKeyboardState,
  useReanimatedKeyboardAnimation,
} from "../src/react-native-compat/keyboard-controller.ts";
import { makeDom } from "./helpers/dom.ts";
import {
  type Any,
  fakePlugin,
  inShell,
  mount,
  settle,
  withGlobals,
} from "./helpers/mobile-fakes.ts";

/** Every element under `node`, depth first. */
function elements(node: Any): Any[] {
  const out: Any[] = [];
  const walk = (n: Any) => {
    for (const c of n.childNodes ?? []) {
      if (c.nodeType === 1) {
        out.push(c);
        walk(c);
      }
    }
  };
  walk(node);
  return out;
}

/** The first element with `tag` under `node`. */
function find(node: Any, tag: string): Any {
  return elements(node).find((e) => e.tagName === tag.toUpperCase());
}

// ---- react-native-linear-gradient ---------------------------------------------------------

Deno.test("linearGradientCss: the default top → bottom gradient, evenly spaced", () => {
  assertEquals(
    linearGradientCss(["red", "blue"], undefined, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }),
    "linear-gradient(180deg, red 0%, blue 100%)",
  );
  assertEquals(
    linearGradientCss(["a", "b", "c"], undefined, { x: 0, y: 0.5 }, { x: 1, y: 0.5 }),
    "linear-gradient(90deg, a 0%, b 50%, c 100%)",
  );
});

Deno.test("linearGradientCss: start / end inside the box re-position the stops exactly", () => {
  // Top → middle on a square: CSS's line spans the box, so the stops sit at 0% and 50%.
  assertEquals(
    linearGradientCss(["a", "b"], [0, 1], { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }),
    "linear-gradient(180deg, a 0%, b 50%)",
  );
  // A corner-to-corner diagonal on a 200×100 box points along the px vector.
  const css = linearGradientCss(["a", "b"], undefined, { x: 0, y: 0 }, { x: 1, y: 1 }, 200, 100);
  const angle = Number(/\((-?[\d.]+)deg/.exec(css)![1]);
  assertEquals(Math.round(angle * 10) / 10, 116.6);
  assertStringIncludes(css, "a 0%");
  assertStringIncludes(css, "b 100%");
});

Deno.test("gradientColor: processColor numbers become rgba()", () => {
  assertEquals(gradientColor(0xff00ff00), "rgba(0,255,0,1)");
  assertEquals(gradientColor(0x80ff0000), "rgba(255,0,0,0.502)");
  assertEquals(gradientColor("#fff"), "#fff");
});

Deno.test("LinearGradient renders a view with the gradient background (and useAngle)", () => {
  const { container } = mount(() =>
    h(LinearGradient, { colors: ["red", "blue"], style: { flex: 1 } }, "hi")
  );
  const div = find(container, "div");
  assertStringIncludes(div.style.cssText, "linear-gradient(180deg, red 0%, blue 100%)");
  assertEquals(div.textContent, "hi");
  const angled = mount(() =>
    h(LinearGradient, { colors: ["red", "blue"], useAngle: true, angle: 45 })
  );
  assertStringIncludes(find(angled.container, "div").style.cssText, "linear-gradient(45deg");
});

// ---- @react-native-community/blur -----------------------------------------------------------

Deno.test("BlurView: a backdrop blur with the tint; overlayColor and enabled={false}", () => {
  const blur = find(
    mount(() => h(BlurView, { blurType: "dark", blurAmount: 50 })).container,
    "div",
  );
  assertStringIncludes(blur.style.cssText, "blur(10px)");
  assertStringIncludes(blur.style.cssText, "rgba(25,25,25");
  const overlay = find(
    mount(() => h(BlurView, { overlayColor: "rgba(1,2,3,0.5)" })).container,
    "div",
  );
  assertStringIncludes(overlay.style.cssText, "rgba(1,2,3,0.5)");
  const off = find(mount(() => h(BlurView, { enabled: false })).container, "div");
  assert(!off.style.cssText.includes("blur("));
  const vib = find(mount(() => h(VibrancyView, { blurAmount: 20 })).container, "div");
  assertStringIncludes(vib.style.cssText, "blur(4px)");
});

// ---- the date pickers --------------------------------------------------------------------

Deno.test("date input values round-trip, keeping the parts a mode does not edit", () => {
  const base = new Date(2026, 8, 27, 14, 5, 30);
  assertEquals(toInputValue(base, "date"), "2026-09-27");
  assertEquals(toInputValue(base, "time"), "14:05");
  assertEquals(toInputValue(base, "datetime"), "2026-09-27T14:05");
  assertEquals(fromInputValue("09:30", "time", base), new Date(2026, 8, 27, 9, 30, 30));
  assertEquals(fromInputValue("2027-01-02", "date", base), new Date(2027, 0, 2, 14, 5, 30));
  assertEquals(fromInputValue("", "date", base), null);
  // A fixed offset: 12:00 UTC shown at +120 minutes is 14:00.
  const utcNoon = new Date(Date.UTC(2026, 0, 1, 12, 0));
  assertEquals(toInputValue(utcNoon, "time", 120), "14:00");
  assertEquals(fromInputValue("15:00", "time", utcNoon, 120)!.getTime(), Date.UTC(2026, 0, 1, 13));
});

Deno.test("DateTimePicker: an inline input whose edits call onChange('set') and onValueChange", () => {
  const seen: Array<[string, Date | undefined]> = [];
  const values: Date[] = [];
  const { container } = mount(() =>
    h(DateTimePicker, {
      value: new Date(2026, 8, 27, 10, 0),
      mode: "date",
      minimumDate: new Date(2026, 0, 1),
      maximumDate: new Date(2026, 11, 31),
      testID: "picker",
      onChange: (e: DateTimePickerEvent, d?: Date) => seen.push([e.type, d]),
      onValueChange: (_e: unknown, d: Date) => values.push(d),
    })
  );
  const input = find(container, "input");
  assertEquals(input.getAttribute("type"), "date");
  assertEquals(input.getAttribute("min"), "2026-01-01");
  assertEquals(input.getAttribute("max"), "2026-12-31");
  assertEquals(input.getAttribute("data-testid"), "picker");
  input.value = "2026-10-03";
  input.dispatch("input");
  assertEquals(seen, [["set", new Date(2026, 9, 3, 10, 0)]]);
  assertEquals(values, [new Date(2026, 9, 3, 10, 0)]);
  // Past the maximum: clamped.
  input.value = "2027-05-05";
  input.dispatch("input");
  assertEquals(seen[1][1], new Date(2026, 11, 31));
});

Deno.test("DateTimePicker: time mode with a minute interval sets the step", () => {
  const { container } = mount(() =>
    h(DateTimePicker, { value: new Date(), mode: "time", minuteInterval: 15 })
  );
  const input = find(container, "input");
  assertEquals(input.getAttribute("type"), "time");
  assertEquals(input.getAttribute("step"), "900");
});

Deno.test("createDateTimeSetEvtParams: the Android event shape", () => {
  const d = new Date(1000);
  assertEquals(createDateTimeSetEvtParams(d, 60), [
    { type: "set", nativeEvent: { timestamp: 1000, utcOffset: 60 } },
    d,
  ]);
});

/** The date dialog appended to `doc.body`, with its input and buttons. */
function dialogOf(doc: Any) {
  const backdrop = doc.body.childNodes.find((n: Any) =>
    n.getAttribute?.("data-denext-date-dialog") !== null
  );
  if (!backdrop) return null;
  const all = elements(backdrop);
  const button = (action: string) =>
    all.find((e) => e.tagName === "BUTTON" && e.getAttribute("data-action") === action);
  return { backdrop, input: all.find((e) => e.tagName === "INPUT"), button };
}

Deno.test("DateTimePicker in the Android shell opens a dialog: OK → set, cancel → dismissed", async () => {
  const { doc } = makeDom();
  await inShell("android", {}, async () => {
    const seen: string[] = [];
    let dismissed = 0;
    const onChange = (e: DateTimePickerEvent, d?: Date) =>
      seen.push(`${e.type}:${d?.getFullYear()}`);
    const first = mount(() =>
      h(DateTimePicker, { value: new Date(2026, 0, 1), onChange, onDismiss: () => dismissed++ })
    );
    assertEquals(find(first.container, "input"), undefined, "no inline input");
    let dialog = dialogOf(doc)!;
    assert(dialog, "the dialog opened");
    dialog.input.value = "2030-06-01";
    dialog.button("confirm").dispatch("click");
    assertEquals(seen, ["set:2030"]);
    assertEquals(dialogOf(doc), null, "closed");
    first.root.unmount();
    await settle();
    const second = mount(() =>
      h(DateTimePicker, { value: new Date(2026, 0, 1), onChange, onDismiss: () => dismissed++ })
    );
    dialog = dialogOf(doc)!;
    dialog.button("cancel").dispatch("click");
    assertEquals(seen, ["set:2030", "dismissed:2026"]);
    assertEquals(dismissed, 1);
    second.root.unmount();
  }, { document: doc });
});

Deno.test("DateTimePickerAndroid.open / dismiss", async () => {
  const { doc } = makeDom();
  await withGlobals({ document: doc }, async () => {
    const seen: string[] = [];
    DateTimePickerAndroid.open({
      value: new Date(2026, 0, 1),
      mode: "time",
      onChange: (e) => seen.push(e.type),
    });
    assertEquals(dialogOf(doc)!.input.getAttribute("type"), "time");
    assertEquals(await DateTimePickerAndroid.dismiss("time"), true);
    assertEquals(seen, ["dismissed"]);
    assertEquals(dialogOf(doc), null);
    assertEquals(await DateTimePickerAndroid.dismiss("time"), false);
  });
});

Deno.test("DatePicker: inline onDateChange; modal open → confirm / cancel", async () => {
  const { doc } = makeDom();
  await withGlobals({ document: doc }, () => {
    const changes: Date[] = [];
    const inline = mount(() =>
      h(DatePicker, {
        date: new Date(2026, 0, 1, 8, 0),
        onDateChange: (d: Date) => changes.push(d),
      })
    );
    const input = find(inline.container, "input");
    assertEquals(input.getAttribute("type"), "datetime-local", "datetime by default");
    input.value = "2026-02-03T04:05";
    input.dispatch("input");
    assertEquals(changes, [new Date(2026, 1, 3, 4, 5)]);

    const confirmed: Date[] = [];
    let cancelled = 0;
    let open = true;
    const modal = mount(() =>
      h(DatePicker, {
        modal: true,
        open,
        mode: "date",
        date: new Date(2026, 0, 1),
        title: "Pick",
        onConfirm: (d: Date) => confirmed.push(d),
        onCancel: () => cancelled++,
      })
    );
    assertEquals(find(modal.container, "input"), undefined, "nothing inline");
    let dialog = dialogOf(doc)!;
    assertStringIncludes(dialog.backdrop.textContent, "Pick");
    assertStringIncludes(dialog.backdrop.textContent, "Confirm");
    dialog.input.value = "2026-03-04";
    dialog.button("confirm").dispatch("click");
    assertEquals(confirmed.map((d) => d.getMonth()), [2]);
    open = false;
    modal.rerender();
    open = true;
    modal.rerender();
    dialog = dialogOf(doc)!;
    dialog.button("cancel").dispatch("click");
    assertEquals(cancelled, 1);
    open = false;
    modal.rerender();
    assertEquals(dialogOf(doc), null);
    modal.root.unmount();
    inline.root.unmount();
  });
});

// ---- react-native-keyboard-controller -----------------------------------------------------

const KEYBOARD_METHODS = ["hide", "setResizeMode", "getResizeMode"];

Deno.test("KeyboardEvents + KeyboardController: show / hide events, state, dismiss", async () => {
  resetKeyboardControllerForTesting();
  const kb = fakePlugin(KEYBOARD_METHODS);
  await inShell("android", { Keyboard: kb.plugin }, async () => {
    const events: string[] = [];
    const subs =
      (["keyboardWillShow", "keyboardDidShow", "keyboardWillHide", "keyboardDidHide"] as const)
        .map((name) => KeyboardEvents.addListener(name, (e) => events.push(`${name}:${e.height}`)));
    assertEquals(KeyboardController.isVisible(), false);
    await settle();
    kb.fire("keyboardWillShow", { keyboardHeight: 300 });
    assertEquals(events, ["keyboardWillShow:300", "keyboardDidShow:300"]);
    assertEquals(KeyboardController.isVisible(), true);
    assertEquals(KeyboardController.state().height, 300);
    const dismissed = KeyboardController.dismiss();
    await settle();
    assert(kb.calls.some(([m]) => m === "hide"), "Keyboard.hide() called");
    kb.fire("keyboardWillHide");
    await dismissed;
    assertEquals(events.slice(2), ["keyboardWillHide:0", "keyboardDidHide:0"]);
    assertEquals(KeyboardController.isVisible(), false);
    subs.forEach((s) => s.remove());
  });
  resetKeyboardControllerForTesting();
});

Deno.test("KeyboardController.setFocusTo walks the page's inputs in document order", () => {
  resetKeyboardControllerForTesting();
  const focused: string[] = [];
  const input = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    tabIndex: 0,
    focus() {
      focused.push(id);
      doc.activeElement = this;
    },
    ...extra,
  });
  const a = input("a"), b = input("b"), c = input("c", { disabled: true }), d = input("d");
  const doc: Any = {
    activeElement: a,
    querySelectorAll: () => [a, b, c, d],
    addEventListener: () => {},
  };
  return withGlobals({ document: doc }, () => {
    KeyboardController.setFocusTo("next");
    KeyboardController.setFocusTo("next"); // skips the disabled one
    KeyboardController.setFocusTo("prev");
    assertEquals(focused, ["b", "d", "b"]);
    resetKeyboardControllerForTesting();
  });
});

Deno.test("useKeyboardHandler / useKeyboardAnimation / useKeyboardState follow the keyboard", async () => {
  resetKeyboardControllerForTesting();
  const kb = fakePlugin(KEYBOARD_METHODS);
  await inShell("android", { Keyboard: kb.plugin }, async () => {
    const calls: string[] = [];
    const seen: Any = {};
    const { root } = mount(function Probe() {
      useKeyboardHandler({
        onStart: (e) => calls.push(`start:${e.height}:${e.progress}`),
        onMove: (e) => calls.push(`move:${e.height}`),
        onEnd: (e) => calls.push(`end:${e.height}`),
      });
      seen.anim = useKeyboardAnimation();
      seen.rea = useReanimatedKeyboardAnimation();
      seen.visible = useKeyboardState((s) => s.isVisible);
      return null;
    });
    await settle();
    flushSync(() => kb.fire("keyboardWillShow", { keyboardHeight: 280 }));
    assertEquals(calls, ["start:280:1", "move:280", "end:280"]);
    assertEquals(seen.anim.height.value, -280, "Animated fallback: a value holder");
    assertEquals(seen.anim.progress.value, 1);
    assertEquals(seen.rea.height.value, -280);
    assertEquals(seen.visible, true);
    flushSync(() => kb.fire("keyboardWillHide"));
    assertEquals(calls.slice(3), ["start:0:0", "move:0", "end:0"]);
    assertEquals(seen.visible, false);
    root.unmount();
  });
  resetKeyboardControllerForTesting();
});

Deno.test("useKeyboardHandler steps onMove through the iOS keyboard animation", async () => {
  resetKeyboardControllerForTesting();
  const kb = fakePlugin(KEYBOARD_METHODS);
  const frames: Array<(t: number) => void> = [];
  await inShell("ios", { Keyboard: kb.plugin }, async () => {
    const moves: number[] = [];
    let ended = -1;
    const { root } = mount(function Probe() {
      useKeyboardHandler({
        onMove: (e) => moves.push(e.height),
        onEnd: (e) => (ended = e.height),
      });
      return null;
    });
    await settle();
    kb.fire("keyboardWillShow", { keyboardHeight: 300 });
    frames.shift()!(0);
    frames.shift()!(125);
    frames.shift()!(250);
    assertEquals(moves[0], 0);
    assert(moves[1] > 0 && moves[1] < 300, `mid-animation: ${moves[1]}`);
    assertEquals(moves.at(-1), 300);
    assertEquals(ended, 300);
    root.unmount();
  }, {
    requestAnimationFrame: (cb: (t: number) => void) => frames.push(cb),
    cancelAnimationFrame: () => {},
  });
  resetKeyboardControllerForTesting();
});

Deno.test("reanimatedKeyboardExports: shared values from the app's Reanimated", async () => {
  resetKeyboardControllerForTesting();
  const kb = fakePlugin(KEYBOARD_METHODS);
  const reanimated = {
    useSharedValue<T>(initial: T) {
      return useRef({ value: initial, shared: true }).current;
    },
  };
  const hooks = reanimatedKeyboardExports(reanimated);
  await inShell("android", { Keyboard: kb.plugin }, async () => {
    const seen: Any = {};
    const { root } = mount(function Probe() {
      seen.anim = hooks.useReanimatedKeyboardAnimation();
      seen.kb = hooks.useAnimatedKeyboard();
      return null;
    });
    await settle();
    kb.fire("keyboardWillShow", { keyboardHeight: 250 });
    assertEquals(seen.anim.height, { value: -250, shared: true });
    assertEquals(seen.anim.progress.value, 1);
    assertEquals(seen.kb.height.value, 250);
    assertEquals(seen.kb.state.value, 2, "OPEN");
    root.unmount();
  });
  resetKeyboardControllerForTesting();
});

Deno.test("KeyboardAwareScrollView pads its content while the keyboard is up", async () => {
  resetKeyboardControllerForTesting();
  const kb = fakePlugin(KEYBOARD_METHODS);
  await inShell("android", { Keyboard: kb.plugin }, async () => {
    const { root, container } = mount(() =>
      h(KeyboardAwareScrollView, { bottomOffset: 20, extraKeyboardSpace: 10 }, "content")
    );
    await settle();
    const scroll = find(container, "div");
    assertStringIncludes(scroll.style.cssText, "overflow-y:auto");
    assertEquals(scroll.childNodes.length, 1, "no spacer while hidden");
    flushSync(() => kb.fire("keyboardWillShow", { keyboardHeight: 300 }));
    const spacer = scroll.childNodes[1];
    assertStringIncludes(spacer.style.cssText, "height:310px");
    flushSync(() => kb.fire("keyboardWillHide"));
    assertEquals(scroll.childNodes.length, 1);
    root.unmount();
    await new Promise((r) => setTimeout(r, 0)); // the reveal timer
  });
  resetKeyboardControllerForTesting();
});

Deno.test("KeyboardToolbar shows prev / next / done only while the keyboard is up", async () => {
  resetKeyboardControllerForTesting();
  const kb = fakePlugin(KEYBOARD_METHODS);
  await inShell("android", { Keyboard: kb.plugin }, async () => {
    let done = 0;
    const { root, container } = mount(() =>
      h(KeyboardToolbar, { doneText: "Fertig", onDoneCallback: () => done++ })
    );
    await settle();
    assertEquals(find(container, "button"), undefined);
    flushSync(() => kb.fire("keyboardWillShow", { keyboardHeight: 300 }));
    const buttons = elements(container).filter((e) => e.tagName === "BUTTON");
    assertEquals(buttons.map((b) => b.getAttribute("data-action")), ["previous", "next", "done"]);
    assertEquals(buttons[2].textContent, "Fertig");
    buttons[2].dispatch("click");
    assertEquals(done, 1);
    await settle();
    assert(kb.calls.some(([m]) => m === "hide"));
    flushSync(() => kb.fire("keyboardWillHide"));
    assertEquals(find(container, "button"), undefined);
    root.unmount();
  });
  resetKeyboardControllerForTesting();
});
