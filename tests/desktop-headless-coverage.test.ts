// Headless runs (src/desktop/headless.ts) on odd inputs: an environment that cannot be read, a
// window that cannot hide or be changed, a constructor called without options, a Dock that is not
// an object, was made headless before, has only `setVisible`, or throws when switched. All on
// plain fakes; no window is created (tests/desktop-headless.test.ts has the main behaviour).

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  DESKTOP_HEADLESS_ENV,
  desktopHeadless,
  headlessDock,
  headlessWindow,
  headlessWindowConstructor,
  withHeadlessLaunchEnv,
} from "../src/desktop/headless.ts";

/** Run `fn` with `Deno.env.get` throwing, as it does where env access is not granted. */
function withUnreadableEnv(fn: () => void): void {
  const get = Deno.env.get;
  Deno.env.get = () => {
    throw new Deno.errors.NotCapable("env access not granted");
  };
  try {
    fn();
  } finally {
    Deno.env.get = get;
  }
}

Deno.test("desktopHeadless / withHeadlessLaunchEnv: an unreadable environment is not headless", () => {
  withUnreadableEnv(() => {
    assertEquals(desktopHeadless(), false);
    const env = { A: "1" };
    assertStrictEquals(withHeadlessLaunchEnv(env), env);
  });
  // The launch env's own value wins over the inherited one, either way.
  const off = { [DESKTOP_HEADLESS_ENV]: "0" };
  assertStrictEquals(withHeadlessLaunchEnv(off, "1"), off);
  assertEquals(withHeadlessLaunchEnv({}, " TRUE ")[DESKTOP_HEADLESS_ENV], "1");
});

Deno.test("headlessWindow: not an object, already headless, frozen, or unable to hide", () => {
  assertEquals(headlessWindow(null), null);
  assertEquals(headlessWindow(7), 7);
  assertEquals(headlessWindow("w"), "w");

  // A frozen window cannot take the guards: it is returned unchanged, and `hide` still runs.
  let hidden = 0;
  const frozen = Object.freeze({
    hide() {
      hidden++;
    },
    show() {
      return "shown";
    },
  });
  assertStrictEquals(headlessWindow(frozen), frozen);
  assertEquals(hidden, 1);
  assertEquals(frozen.show(), "shown");

  // A window whose `hide` throws still gets the guards; a second call leaves it alone.
  const calls: string[] = [];
  const win = {
    hide(): void {
      throw new Error("not ready");
    },
    show() {
      calls.push("show");
    },
    focus() {
      calls.push("focus");
    },
    unminimize() {
      calls.push("unminimize");
    },
    title: "kept",
  };
  assertStrictEquals(headlessWindow(win), win);
  win.show();
  win.focus();
  win.unminimize();
  assertEquals(calls, []);
  assertEquals(win.title, "kept");
  const show = win.show;
  assertStrictEquals(headlessWindow(win), win);
  assertStrictEquals(win.show, show);

  // A window without `hide` (or any surfacing method) is marked and returned.
  const bare = { id: 1 };
  assertStrictEquals(headlessWindow(bare), bare);
  assertEquals(Object.keys(bare), ["id"]);
});

Deno.test("headlessWindowConstructor: a non-function is returned as it is; odd options become {}", () => {
  assertEquals(headlessWindowConstructor(undefined), undefined);
  const notCtor = { BrowserWindow: true };
  assertStrictEquals(headlessWindowConstructor(notCtor), notCtor);

  class Win {
    static kind = "win";
    shown = 0;
    constructor(readonly options?: Record<string, unknown>) {}
    show() {
      this.shown++;
    }
  }
  const Ctor = headlessWindowConstructor(Win);
  const made = [
    new Ctor(),
    new Ctor(null as unknown as Record<string, unknown>),
    new Ctor("x" as unknown as Record<string, unknown>),
    new Ctor({ width: 3, show: true }),
  ];
  assertEquals(made.map((w) => w.options), [
    { show: false },
    { show: false },
    { show: false },
    { width: 3, show: false },
  ]);
  for (const w of made) {
    assert(w instanceof Win);
    w.show();
    assertEquals(w.shown, 0);
  }
  assertEquals((Ctor as unknown as typeof Win).kind, "win");
});

Deno.test("headlessDock: not an object, already headless, setVisible only, nothing at all", () => {
  assertEquals(headlessDock(undefined), undefined);
  assertEquals(headlessDock(null), null);
  assertEquals(headlessDock(1), 1);

  // An older Dock with only setVisible: hidden now, setVisible(true) does nothing.
  const visible: boolean[] = [];
  const old = {
    setVisible(v: boolean) {
      visible.push(v);
    },
  };
  headlessDock(old);
  assertEquals(old.setVisible(true), undefined);
  old.setVisible(false);
  assertEquals(visible, [false, false]);

  // A second call leaves it alone.
  const setVisible = old.setVisible;
  assertStrictEquals(headlessDock(old), old);
  assertStrictEquals(old.setVisible, setVisible);

  // A Dock with none of the methods is only marked.
  const empty = {};
  assertStrictEquals(headlessDock(empty), empty);
  assertEquals(Object.keys(empty), []);
});

Deno.test("headlessDock: a policy switch that throws still installs the guards", () => {
  const policies: string[] = [];
  let bounced = 0;
  const dock = {
    setActivationPolicy(p: string): boolean {
      policies.push(p);
      if (policies.length === 1) throw new Error("older runtime");
      return true;
    },
    setVisible(_v: boolean) {},
    bounce() {
      bounced++;
    },
  };
  headlessDock(dock);
  dock.bounce();
  assertEquals(bounced, 0);
  assertEquals(dock.setActivationPolicy("regular"), false);
  assertEquals(dock.setActivationPolicy("accessory"), true);
  assertEquals(policies, ["accessory", "accessory"]);
});
