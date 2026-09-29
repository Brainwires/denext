// `nativeModule` (denext/mobile) and the React Native / Expo faces built on it: a Capacitor
// plugin by name inside the shell, a desktop extension on Deno Desktop, null on the web; the
// options and positional call conventions; events; the dev warning for a result used without
// await. React Native mode's `turboModule`, `NativeModules` and `NativeEventEmitter`
// (src/react-native/native-modules.ts) and Expo's `requireNativeModule` / `EventEmitter`
// (src/expo/expo.ts) reach the same plugin.

import { assert, assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert";
import {
  nativeModule,
  nativeModuleName,
  onNativeEvent,
  positionalPayload,
  positionalResult,
} from "../src/mobile/native-module.ts";
import {
  createNativeEventEmitter,
  createNativeModules,
  nativeHostComponent,
  turboModule,
} from "../src/react-native/mod.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { type Any, mount, settle } from "./helpers/mobile-fakes.ts";
import {
  EventEmitter,
  requireNativeModule,
  requireNativeView,
  requireOptionalNativeModule,
} from "../src/expo/expo.ts";

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

/** A fake Capacitor plugin: records calls, answers `answer(method, payload)`, keeps listeners. */
function fakePlugin(answer: (method: string, payload: unknown) => unknown) {
  const calls: [string, unknown][] = [];
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  const plugin: Record<string, unknown> = {
    addListener(event: string, fn: (d: unknown) => void) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, set = new Set());
      set.add(fn);
      return Promise.resolve({ remove: () => set!.delete(fn) });
    },
  };
  for (const m of ["echo", "add", "fail", "status"]) {
    plugin[m] = (payload: unknown) => {
      calls.push([m, payload]);
      return Promise.resolve(answer(m, payload));
    };
  }
  const emit = (event: string, data: unknown) => {
    for (const fn of listeners.get(event) ?? []) fn(data);
  };
  return { plugin, calls, listeners, emit };
}

/** Run `fn` with a native shell holding `plugins`; the globals are restored after. */
async function inShell(plugins: Record<string, unknown>, fn: () => Promise<void>): Promise<void> {
  const before = g.Capacitor;
  g.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios", Plugins: plugins };
  try {
    await fn();
  } finally {
    if (before === undefined) delete g.Capacitor;
    else g.Capacitor = before;
  }
}

/** Let pending microtasks (listener handles) settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("nativeModule: null on the web (and during SSR)", () => {
  assertEquals(nativeModule("Scanner"), null);
  assertThrows(() => nativeModule(""), TypeError);
  assertEquals(onNativeEvent("Scanner", "x", () => {})(), undefined, "a no-op unsubscribe");
});

Deno.test("nativeModule: the Capacitor plugin, options convention (as is)", async () => {
  const fake = fakePlugin((m, p) => m === "status" ? { ready: true, p } : undefined);
  await inShell({ Scanner: fake.plugin }, async () => {
    assertEquals(nativeModule("Missing"), null, "a plugin the shell lacks");
    const scanner = nativeModule<{ status(o: { id: number }): { ready: boolean } }>("Scanner")!;
    assertEquals(nativeModuleName(scanner), "Scanner");
    assertEquals(await scanner.status({ id: 1 }), { ready: true, p: { id: 1 } } as never);
    assertEquals(fake.calls, [["status", { id: 1 }]]);
    const loose = nativeModule("Scanner") as unknown as Record<string, () => Promise<unknown>>;
    await assertRejects(() => loose.nope(), Error, "Scanner.nope() is not a method");
    assertEquals((scanner as unknown as { then?: unknown }).then, undefined, "not a thenable");
    assertEquals(String(scanner), "[native module Scanner]");
  });
});

Deno.test("nativeModule: positional convention sends { args } and unwraps { value }", async () => {
  const fake = fakePlugin((m, p) => {
    const args = (p as { args: number[] }).args;
    return m === "add" ? { value: args[0] + args[1] } : { value: 1, other: 2 };
  });
  await inShell({ Calc: fake.plugin }, async () => {
    const calc = nativeModule<{ add(a: number, b: number): number; echo(): unknown }>("Calc", {
      calls: "positional",
    })!;
    assertEquals(await calc.add(2, 3), 5);
    assertEquals(fake.calls[0], ["add", { args: [2, 3] }]);
    assertEquals(await calc.echo(), { value: 1, other: 2 }, "only a lone value unwraps");
    // React Native's emitter bookkeeping does nothing.
    const rn = calc as unknown as { removeListeners(n: number): unknown };
    assertEquals(rn.removeListeners(1), undefined);
  });
  assertEquals(positionalPayload([{ a: 1 }]), { a: 1, args: [{ a: 1 }] });
  assertEquals(positionalPayload([[1], "x"]), { args: [[1], "x"] });
  assertEquals(positionalResult(undefined), undefined);
  assertEquals(positionalResult({ value: [1] }), [1]);
});

Deno.test("nativeModule: events through addListener and onNativeEvent", async () => {
  const fake = fakePlugin(() => undefined);
  await inShell({ Scanner: fake.plugin }, async () => {
    const scanner = nativeModule<object, { progress: { percent: number } }>("Scanner")!;
    const seen: number[] = [];
    const sub = scanner.addListener("progress", ({ percent }) => seen.push(percent));
    const stop = onNativeEvent<{ percent: number }>(
      "Scanner",
      "progress",
      (d) => seen.push(-d.percent),
    );
    await tick();
    fake.emit("progress", { percent: 10 });
    sub.remove();
    sub.remove();
    stop();
    await tick();
    fake.emit("progress", { percent: 20 });
    assertEquals(seen, [10, -10]);
    assertEquals(fake.listeners.get("progress")?.size, 0, "both native listeners removed");
    // React Native's one-argument addListener(eventName) subscribes nothing.
    (scanner.addListener as (e: string) => { remove(): void })("progress").remove();
  });
});

Deno.test("nativeModule: dev build warns once when a result is used without await", async () => {
  const fake = fakePlugin(() => ({ value: 3 }));
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (msg: string) => warnings.push(msg);
  g.__denextDev = true;
  try {
    await inShell({ Calc: fake.plugin }, async () => {
      const calc = nativeModule("Calc", { calls: "positional" }) as unknown as Record<
        string,
        () => Promise<unknown>
      >;
      assertEquals(await calc.add(), 3, "awaiting never warns");
      await calc.add().then((v) => assertEquals(v, 3));
      assertEquals(warnings, []);
      const result = calc.add();
      assert(result instanceof Promise);
      void (result as unknown as { length: unknown }).length;
      void (result as unknown as { length: unknown }).length;
      assertEquals(warnings.length, 1, warnings.join("\n"));
      assert(warnings[0].includes("Calc.add() returns a Promise"), warnings[0]);
      await result;
    });
  } finally {
    console.warn = warn;
    delete g.__denextDev;
  }
});

Deno.test("nativeModule: Deno Desktop routes to the desktop extension of that name", async () => {
  const requests: unknown[] = [];
  const fetchBefore = globalThis.fetch;
  g.__denext = { desktop: true, token: "t0k" };
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return Promise.resolve(Response.json({ ok: true, data: { value: 42 } }));
  }) as typeof fetch;
  try {
    const ext = nativeModule("scanner", { calls: "positional" }) as unknown as Record<
      string,
      (...a: unknown[]) => Promise<unknown>
    >;
    assert(ext !== null);
    assertEquals(await ext.listDevices("usb"), 42);
    assertEquals(requests, [{ cap: "scanner", method: "listDevices", args: { args: ["usb"] } }]);
  } finally {
    globalThis.fetch = fetchBefore;
    delete g.__denext;
  }
});

Deno.test("React Native mode: turboModule / NativeModules / NativeEventEmitter", async () => {
  const fake = fakePlugin((_m, p) => ({ value: (p as { args: string[] }).args[0] }));
  assertEquals(turboModule("Echo"), null, "no module on the web");
  await inShell({ Echo: fake.plugin }, async () => {
    const mod = turboModule("Echo")!;
    assertStrictEquals(turboModule("Echo"), mod, "one client per module");
    assertEquals(await (mod.echo as (s: string) => Promise<string>)("hi"), "hi");

    const NativeModules = createNativeModules("RNW_UI_MANAGER");
    assertEquals(NativeModules.UIManager, "RNW_UI_MANAGER");
    assertStrictEquals(NativeModules.Echo, mod);
    assertEquals(NativeModules.Nope, undefined);
    assert("Echo" in NativeModules);
    assert(!("Nope" in NativeModules));

    // A stand-in for react-native-web's vendored emitter (its RCTDeviceEventEmitter).
    class Base {
      listeners = new Map<string, Set<(...a: unknown[]) => unknown>>();
      constructor(public nativeModule?: unknown) {}
      addListener(type: string, fn: (...a: unknown[]) => unknown) {
        let set = this.listeners.get(type);
        if (!set) this.listeners.set(type, set = new Set());
        set.add(fn);
        return { remove: () => set!.delete(fn) };
      }
      removeAllListeners(type: string) {
        this.listeners.delete(type);
      }
      listenerCount(type: string) {
        return this.listeners.get(type)?.size ?? 0;
      }
      emit(type: string, ...args: unknown[]) {
        for (const fn of this.listeners.get(type) ?? []) fn(...args);
      }
    }
    const Emitter = createNativeEventEmitter(Base);
    const emitter = new Emitter(mod) as unknown as Base;
    assertEquals(emitter.nativeModule, undefined, "the base never sees a module served here");
    const got: unknown[] = [];
    const sub = emitter.addListener("echoed", (d) => got.push(d));
    await tick();
    fake.emit("echoed", { message: "native" });
    emitter.emit("echoed", "local");
    assertEquals(got, [{ message: "native" }, "local"]);
    sub.remove();
    await tick();
    fake.emit("echoed", { message: "gone" });
    assertEquals(got.length, 2);
    emitter.addListener("echoed", (d) => got.push(d));
    await tick();
    emitter.removeAllListeners("echoed");
    await tick();
    fake.emit("echoed", { message: "gone" });
    assertEquals(got.length, 2);
    // Any other module keeps react-native-web's behaviour.
    const plain = new Emitter({ addListener() {} }) as unknown as Base;
    assert(plain.nativeModule !== undefined);
  });
});

Deno.test("Expo: requireNativeModule / requireOptionalNativeModule / EventEmitter(module)", async () => {
  const missing = requireNativeModule<Record<string, () => unknown>>("ExpoScanner");
  assertThrows(() => missing.scan(), Error, "Cannot find native module");
  assertEquals(requireOptionalNativeModule("ExpoScanner"), null);
  const fake = fakePlugin((_m, p) => ({ value: (p as { args: number[] }).args.length }));
  await inShell({ ExpoScanner: fake.plugin }, async () => {
    const mod = requireNativeModule<Record<string, (...a: unknown[]) => Promise<unknown>>>(
      "ExpoScanner",
    );
    assertEquals(await mod.add(1, 2, 3), 3);
    assert(requireOptionalNativeModule("ExpoScanner") !== null);
    const emitter = new EventEmitter<{ tick: (n: number) => void }>(mod);
    const seen: number[] = [];
    const listener = (n: number) => seen.push(n);
    const sub = emitter.addListener("tick", listener);
    await tick();
    fake.emit("tick", 1);
    emitter.emit("tick", 2);
    sub.remove();
    await tick();
    fake.emit("tick", 3);
    assertEquals(seen, [1, 2]);
  });
});

Deno.test("React Native / Expo native views: one host component per type over a slot", async () => {
  const Chart = nativeHostComponent("chart");
  assertStrictEquals(nativeHostComponent("chart"), Chart, "stable identity per type");
  assertStrictEquals(
    requireNativeView("ExpoMaps", "AppleMapsView"),
    nativeHostComponent("ExpoMaps_AppleMapsView") as never,
    "Expo's <Module>_<View> key",
  );
  assertStrictEquals(requireNativeView("ExpoBlur") as unknown, nativeHostComponent("ExpoBlur"));
  assertStrictEquals(
    requireNativeView("ExpoBlur", "ExpoBlur") as unknown,
    nativeHostComponent("ExpoBlur"),
  );
  // On the web (no DenextNativeViews plugin) the slot renders its children; a style array is
  // flattened onto the slot.
  const { container } = mount(() =>
    h(
      Chart as Any,
      { style: [{ height: "80px" }, null, [{ width: "50px" }]], values: [1] },
      h("span", null, "fallback"),
    )
  );
  await settle();
  const slot = container.firstChild;
  assertEquals(slot.style.getPropertyValue("height"), "80px");
  assertEquals(slot.style.getPropertyValue("width"), "50px");
  const hasSpan = (n: Any): boolean =>
    n?.tagName === "SPAN" || [...(n?.childNodes ?? [])].some(hasSpan);
  assert(hasSpan(slot), "the children render where the view type is not registered");
});
