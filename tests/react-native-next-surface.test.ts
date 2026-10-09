// React Native mode's runtime values for the names React Native 0.88's generated types export
// that 0.86's legacy `.d.ts` did not (each existed in React Native's runtime already):
// `DeviceInfo`, `ReactNativeVersion`, `UTFSequence`, `VirtualViewMode` (a Flow enum),
// `Networking` (over fetch, React Native's event tuples), `usePressability` (React Native's press
// timing), `VirtualizedSectionList` (getItem / getItemCount sections), `Platform
// .isDisableAnimations`, and the `LogBox` / `LayoutAnimation` / `UIManager` members
// react-native-web lacks. The entry wiring is in react-native-core-build.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { act, render } from "../src/testing/mod.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode, VNodeChild } from "../src/jsx/types.ts";
import {
  createVirtualizedSectionList,
  DeviceInfo,
  Networking,
  Platform,
  ReactNativeVersion,
  usePressability,
  UTFSequence,
  VirtualViewMode,
  withLayoutAnimationStatics,
  withLogBoxStatics,
  withViewManagerCommands,
} from "../src/react-native/mod.ts";
import type { PressabilityEventHandlers } from "../src/react-native/pressability.ts";
import type { SectionListRef } from "../src/react-native/lists/types.ts";
import { all } from "./helpers/virtual-list.ts";
import { type Any, until, withGlobals } from "./helpers/mobile-fakes.ts";

// ---- constants -------------------------------------------------------------------------------

Deno.test("DeviceInfo.getConstants: the window's and screen's metrics", async () => {
  await withGlobals({
    innerWidth: 390,
    innerHeight: 844,
    devicePixelRatio: 3,
    screen: { width: 430, height: 932 },
    document: undefined,
  }, () => {
    const c = DeviceInfo.getConstants();
    assertEquals(c.Dimensions.window.width, 390);
    assertEquals(c.Dimensions.window.height, 844);
    assertEquals(c.Dimensions.window.scale, 3);
    assertEquals(c.Dimensions.screen.width, 430);
    assertEquals(c.Dimensions.screen.height, 932);
    assert(c.Dimensions.window.fontScale > 0);
    assertEquals(c.isIPhoneX_deprecated, false);
  });
});

Deno.test("ReactNativeVersion: statics and getVersionString, matching Platform.constants", () => {
  const v = Platform.constants.reactNativeVersion;
  assertEquals(
    [ReactNativeVersion.major, ReactNativeVersion.minor, ReactNativeVersion.patch],
    [v.major, v.minor, v.patch],
  );
  assertEquals(ReactNativeVersion.prerelease, v.prerelease);
  assertEquals(ReactNativeVersion.getVersionString(), `${v.major}.${v.minor}.${v.patch}`);
});

Deno.test("UTFSequence: React Native's frozen table", () => {
  assertEquals(UTFSequence.BOM, "\ufeff");
  assertEquals(UTFSequence.MDASH_SP, "\u00A0\u2014\u00A0");
  assertEquals(UTFSequence.PIZZA, "\uD83C\uDF55");
  assertEquals(Object.keys(UTFSequence).length, 15);
  assert(Object.isFrozen(UTFSequence));
});

Deno.test("VirtualViewMode: a Flow enum — values, cast, isValid, members, getName", () => {
  assertEquals(
    [VirtualViewMode.Visible, VirtualViewMode.Prerender, VirtualViewMode.Hidden],
    [0, 1, 2],
  );
  assertEquals(VirtualViewMode.cast(1), 1);
  assertEquals(VirtualViewMode.cast(7), undefined);
  assert(VirtualViewMode.isValid(2) && !VirtualViewMode.isValid("2"));
  assertEquals([...VirtualViewMode.members()], [0, 1, 2]);
  assertEquals(VirtualViewMode.getName(1), "Prerender");
  assertEquals(Object.keys(VirtualViewMode), [], "members are non-enumerable (flow-enums-runtime)");
  assert(Object.isFrozen(VirtualViewMode));
});

Deno.test("Platform.isDisableAnimations: the reduced-motion preference", async () => {
  for (const reduce of [true, false]) {
    await withGlobals({
      matchMedia: (q: string) => ({ matches: reduce && q.includes("reduce") }),
    }, () => assertEquals(Platform.isDisableAnimations, reduce));
  }
});

// ---- statics on react-native-web's objects ---------------------------------------------------

Deno.test("LogBox: React Native's members, production behaviour; existing ones kept", () => {
  const own = () => "kept";
  const box = withLogBoxStatics({ ignoreLogs: own } as Any);
  assertEquals(box.ignoreLogs, own);
  assertEquals(box.isInstalled(), false);
  for (const m of ["clearAllLogs", "addLog", "addConsoleLog", "addException"]) {
    assertEquals(box[m](), undefined, m);
  }
});

Deno.test("LayoutAnimation.setEnabled: present and, as React Native's, changes nothing", () => {
  const configureNext = () => "configured";
  const la = withLayoutAnimationStatics({ configureNext } as Any);
  assertEquals(la.setEnabled(false), undefined);
  assertEquals(la.configureNext(), "configured");
});

/** A fake element with a frame, a parent and children. */
function el(
  rect: { left: number; top: number; width: number; height: number },
  parent: Any = null,
): Any {
  const node: Any = {
    nodeType: 1,
    parentNode: parent,
    children: [] as Any[],
    getBoundingClientRect: () => rect,
    contains(o: Any) {
      for (let n = o; n; n = n.parentNode) if (n === node) return true;
      return false;
    },
    focused: 0,
    clicked: 0,
    focus() {
      node.focused++;
    },
    click() {
      node.clicked++;
    },
  };
  parent?.children.push(node);
  return node;
}

Deno.test("UIManager: measureLayoutRelativeToParent, viewIsDescendantOf, findSubviewIn, sendAccessibilityEvent", () => {
  const U = withViewManagerCommands({ measure: "own" } as Any);
  assertEquals(U.measure, "own", "react-native-web's own members are kept");
  const root = el({ left: 10, top: 20, width: 300, height: 400 });
  const child = el({ left: 30, top: 70, width: 100, height: 50 }, root);
  root.ownerDocument = {
    elementFromPoint: (x: number, y: number) => (x === 40 && y === 80 ? child : null),
  };
  let frame: number[] = [];
  U.measureLayoutRelativeToParent(child, () => {}, (...a: number[]) => (frame = a));
  assertEquals(frame, [20, 50, 100, 50]);
  let failed = false;
  U.measureLayoutRelativeToParent(root, () => (failed = true), () => {});
  assert(failed, "no parent view: onFail");
  const out: boolean[][] = [];
  U.viewIsDescendantOf({ current: child }, root, (r: boolean[]) => out.push(r));
  U.viewIsDescendantOf(root, child, (r: boolean[]) => out.push(r));
  U.viewIsDescendantOf(root, root, (r: boolean[]) => out.push(r));
  assertEquals(out, [[true], [false], [false]]);
  const hits: unknown[][] = [];
  U.findSubviewIn(root, [30, 60], (...a: unknown[]) => hits.push(a));
  U.findSubviewIn(root, [0, 0], (...a: unknown[]) => hits.push(a));
  assertEquals(hits, [[child, 30, 70, 100, 50]]);
  U.sendAccessibilityEvent(child, 8);
  U.sendAccessibilityEvent(child, 1);
  assertEquals([child.focused, child.clicked], [1, 1]);
  assertEquals(U.getConstants(), {});
  assertEquals(U.getConstantsForViewManager("RCTView"), {});
  assertEquals(U.getDefaultEventTypes(), []);
  const errors: string[] = [];
  const error = console.error;
  console.error = (m: string) => errors.push(m);
  try {
    U.sendAccessibilityEvent(child, 999);
    U.createView(1, "RCTView", 1, {});
    U.setJSResponder(1, false);
    assertEquals(U.lazilyLoadView("X"), {});
  } finally {
    console.error = error;
  }
  assertEquals(errors.length, 4);
  assert(errors[1].includes("'createView' is not available in the new React Native architecture"));
});

// ---- Networking ------------------------------------------------------------------------------

/** Collect every Networking event (by name) while `fn` runs; returns the log. */
async function networkLog(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  fn: (
    send: (opts: Partial<Record<string, unknown>>) => number,
    log: ReadonlyArray<[string, unknown[]]>,
  ) => Promise<void>,
): Promise<Array<[string, unknown[]]>> {
  const log: Array<[string, unknown[]]> = [];
  const subs = [
    "didReceiveNetworkResponse",
    "didReceiveNetworkData",
    "didReceiveNetworkIncrementalData",
    "didReceiveNetworkDataProgress",
    "didCompleteNetworkResponse",
  ].map((e) => Networking.addListener(e as never, (args) => void log.push([e, args])));
  try {
    await withGlobals({ fetch: fetchImpl }, () =>
      fn((o) => {
        let id = -1;
        Networking.sendRequest(
          (o.method as string) ?? "GET",
          undefined,
          (o.url as string) ?? "https://x.test/a",
          (o.headers as Record<string, string>) ?? {},
          o.data,
          (o.responseType as "text") ?? "text",
          (o.incremental as boolean) ?? false,
          (o.timeout as number) ?? 0,
          (rid) => (id = rid),
          false,
        );
        return id;
      }, log));
  } finally {
    for (const s of subs) s.remove();
  }
  return log;
}

/** Wait for queued work (microtasks and short timers). */
const settle = () => new Promise((r) => setTimeout(r, 10));

Deno.test("Networking.sendRequest: React Native's events over fetch (text, base64, incremental)", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const log = await networkLog(
    (url, init) => {
      seen.push({ url, init });
      return Promise.resolve(new Response("hello", { status: 201, headers: { "x-a": "1" } }));
    },
    async (send) => {
      const id = send({ method: "POST", data: { string: "body" }, headers: { a: "b" } });
      assertEquals(typeof id, "number", "the callback gets the id first");
      await settle();
      send({ responseType: "base64" });
      await settle();
      send({ incremental: true });
      await settle();
    },
  );
  assertEquals(seen[0].init.method, "POST");
  assertEquals(seen[0].init.body, "body");
  const [response, data, done] = log;
  assertEquals(response[0], "didReceiveNetworkResponse");
  assertEquals(response[1][1], 201);
  assertEquals((response[1][2] as Record<string, string>)["x-a"], "1");
  assertEquals(data, ["didReceiveNetworkData", [response[1][0], "hello"]]);
  assertEquals(done, ["didCompleteNetworkResponse", [response[1][0], "", false]]);
  assertEquals(log[4][1][1], btoa("hello"), "base64 response");
  const incremental = log.filter(([e]) => e === "didReceiveNetworkIncrementalData");
  assertEquals(incremental.map(([, a]) => a[1]).join(""), "hello");
});

Deno.test("Networking: a failure, a timeout and abortRequest", async () => {
  const log = await networkLog(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        if ((init.headers as Record<string, string>)?.fail) reject(new Error("offline"));
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    async (send, log) => {
      send({ headers: { fail: "1" } });
      send({ timeout: 5 });
      const aborted = send({});
      Networking.abortRequest(aborted);
      // The timeout's timer is armed in a later task, so a fixed sleep raced it under load.
      await until(() => log.filter(([e]) => e === "didCompleteNetworkResponse").length >= 2);
    },
  );
  const completes = log.filter(([e]) => e === "didCompleteNetworkResponse").map(([, a]) => a);
  assertEquals(completes.length, 2, "an aborted request reports nothing more");
  assertEquals(completes[0].slice(1), ["offline", false]);
  assertEquals(completes[1].slice(1), ["The request timed out.", true]);
});

Deno.test("Networking.clearCookies: removes the page's cookies, reports whether any", async () => {
  const written: string[] = [];
  const document = {
    get cookie() {
      return written.length === 0 ? "a=1; b=2" : "";
    },
    set cookie(v: string) {
      written.push(v);
    },
  };
  await withGlobals({ document }, () => {
    let result: boolean | null = null;
    Networking.clearCookies((r) => (result = r));
    assertEquals(result, true);
    assertEquals([...new Set(written.map((w) => w.split("=")[0]))], ["a", "b"]);
    Networking.clearCookies((r) => (result = r));
    assertEquals(result, false);
  });
});

Deno.test("Networking.sendRequest: incremental base64 / blob responses report didReceiveNetworkDataProgress", async () => {
  const chunks = ["hel", "lo"];
  const body = () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    });
  const log = await networkLog(
    () => Promise.resolve(new Response(body(), { headers: { "content-length": "5" } })),
    async (send) => {
      send({ responseType: "base64", incremental: true });
      await settle();
    },
  );
  const id = log[0][1][0];
  assertEquals(log.slice(1), [
    // React Native: progress (loaded, total) as the bytes arrive, then the whole body.
    ["didReceiveNetworkDataProgress", [id, 3, 5]],
    ["didReceiveNetworkDataProgress", [id, 5, 5]],
    ["didReceiveNetworkData", [id, btoa("hello")]],
    ["didCompleteNetworkResponse", [id, "", false]],
  ]);
});

Deno.test("Networking.sendRequest: a { uri } body is that file's bytes; an unknown body fails clearly", async () => {
  const seen: Array<{ url: string; body: unknown }> = [];
  const log = await networkLog(
    (url, init) => {
      seen.push({ url, body: init?.body });
      return Promise.resolve(new Response(url === "blob:file" ? "filedata" : "ok"));
    },
    async (send) => {
      send({ method: "POST", url: "https://x.test/up", data: { uri: "blob:file" } });
      await settle();
      send({ method: "POST", url: "https://x.test/bad", data: { stream: {} } });
      await settle();
    },
  );
  assertEquals(seen.map((s) => s.url), ["blob:file", "https://x.test/up"]);
  assert(seen[1].body instanceof Blob);
  assertEquals(await (seen[1].body as Blob).text(), "filedata");
  const failed = log.filter(([e]) => e === "didCompleteNetworkResponse").at(-1)!;
  assertStringIncludes(failed[1][1] as string, "Unsupported request body");
  assertEquals(seen.length, 2, "the request with an unknown body is never sent");
});

/** A `document.cookie` that keeps each cookie under its name, path and domain. */
function cookieJar(sticky: string[] = []) {
  const jar = new Map<string, { name: string; path: string; domain: string }>();
  const set = (name: string, path: string, domain = "") =>
    jar.set(`${name}|${path}|${domain}`, { name, path, domain });
  const document = {
    get cookie() {
      return [...jar.values()].map((c) => `${c.name}=1`).join("; ");
    },
    set cookie(v: string) {
      const [pair, ...attrs] = v.split(";").map((p) => p.trim());
      const name = pair.split("=")[0];
      const attr = (k: string) =>
        attrs.find((a) => a.toLowerCase().startsWith(`${k}=`))?.slice(k.length + 1) ?? "";
      if (!/expires=Thu, 01 Jan 1970/.test(v) || sticky.includes(name)) return;
      jar.delete(`${name}|${attr("path") || "/"}|${attr("domain").replace(/^\./, "")}`);
    },
  };
  return { document, set, jar };
}

Deno.test("Networking.clearCookies: removes cookies set under a deeper path or the parent domain", async () => {
  const { document, set, jar } = cookieJar();
  set("root", "/");
  set("scoped", "/app");
  set("shared", "/", "x.test");
  const location = { pathname: "/app/page", hostname: "app.x.test" };
  await withGlobals({ document, location }, () => {
    let result: boolean | null = null;
    Networking.clearCookies((r) => (result = r));
    assertEquals([...jar.values()].map((c) => c.name), []);
    assertEquals(result, true);
  });
});

Deno.test("Networking.clearCookies: reports false when no cookie could be removed", async () => {
  const { document, set } = cookieJar(["pinned"]);
  set("pinned", "/");
  await withGlobals({ document, location: { pathname: "/", hostname: "x.test" } }, () => {
    let result: boolean | null = null;
    Networking.clearCookies((r) => (result = r));
    assertEquals(result, false, "the cookie is still there");
  });
});

// ---- usePressability -------------------------------------------------------------------------

/** Run `fn` with manual timers and clock. */
async function withTimers(fn: (advance: (ms: number) => void) => Promise<void>): Promise<void> {
  let now = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  let next = 1;
  const realNow = Date.now;
  Date.now = () => now;
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) =>
        t.at <= until
      ).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].cb();
    }
    now = until;
  };
  try {
    await withGlobals({
      setTimeout: (cb: () => void, ms = 0) => {
        timers.set(next, { at: now + ms, cb });
        return next++;
      },
      clearTimeout: (id: number) => void timers.delete(id),
    }, () => fn(advance));
  } finally {
    Date.now = realNow;
  }
}

/** Mount `usePressability(config)` and return its handlers and the call log. */
async function pressable(config: Record<string, unknown>) {
  const calls: string[] = [];
  const log = (name: string) => () => void calls.push(name);
  let handlers: PressabilityEventHandlers | null = null;
  function Probe(): VNode {
    handlers = usePressability({
      onPressIn: log("in"),
      onPressOut: log("out"),
      onPress: log("press"),
      onLongPress: log("long"),
      ...config,
    });
    return h("i", null);
  }
  const screen = await render(h(Probe, null));
  return { calls, handlers: () => handlers!, screen };
}

Deno.test("usePressability: press in → out (held for minPressDuration) → press", async () => {
  await withTimers(async (advance) => {
    const { calls, handlers, screen } = await pressable({});
    const ev = {};
    assertEquals(handlers().onStartShouldSetResponder(), true);
    handlers().onResponderGrant(ev);
    assertEquals(calls, ["in"]);
    advance(50);
    handlers().onResponderRelease(ev);
    assertEquals(calls, ["in", "press"], "onPressOut waits until 130 ms have passed");
    advance(80);
    assertEquals(calls, ["in", "press", "out"]);
    await screen.unmount();
  });
});

Deno.test("usePressability: a long press takes the press; delayPressIn; disabled; cancelable", async () => {
  await withTimers(async (advance) => {
    const long = await pressable({});
    long.handlers().onResponderGrant({});
    advance(500);
    assertEquals(long.calls, ["in", "long"]);
    long.handlers().onResponderRelease({});
    assertEquals(long.calls, ["in", "long", "out"], "no onPress after a long press");
    await long.screen.unmount();

    const delayed = await pressable({ delayPressIn: 100 });
    delayed.handlers().onResponderGrant({});
    assertEquals(delayed.calls, []);
    delayed.handlers().onResponderRelease({});
    assertEquals(delayed.calls, ["in", "press"], "released before the delay: in, then press");
    advance(200);
    assertEquals(delayed.calls, ["in", "press", "out"]);
    await delayed.screen.unmount();

    const off = await pressable({ disabled: true, cancelable: false });
    assertEquals(off.handlers().onStartShouldSetResponder(), false);
    assertEquals(off.handlers().onResponderTerminationRequest(), false);
    await off.screen.unmount();
  });
});

Deno.test("usePressability: clicks — a pointer's is the responder's, the keyboard's presses", async () => {
  const { calls, handlers, screen } = await pressable({});
  const target = {};
  handlers().onClick({ nativeEvent: { pointerType: "mouse" }, currentTarget: target, target });
  assertEquals(calls, []);
  handlers().onClick({ nativeEvent: { pointerType: "" }, currentTarget: target, target });
  assertEquals(calls, ["press"]);
  let stopped = false;
  handlers().onClick({
    nativeEvent: {},
    currentTarget: target,
    target: {},
    stopPropagation: () => (stopped = true),
  });
  assertEquals(calls, ["press"], "a nested target's click is not ours");
  assert(stopped);
  await screen.unmount();
  const none = await render(h(function Null(): VNode {
    assertEquals(usePressability(null), null);
    return h("i", null);
  }, null));
  await none.unmount();
});

Deno.test("usePressability: older WebKit's pointerless click after a release is the same press", async () => {
  await withTimers(async (advance) => {
    const { calls, handlers, screen } = await pressable({});
    const target = {};
    // Safari before PointerEvent clicks: the click that follows a tap carries no pointerType.
    const click = () => handlers().onClick({ nativeEvent: {}, currentTarget: target, target });
    handlers().onResponderGrant({});
    advance(20);
    handlers().onResponderRelease({});
    click();
    assertEquals(
      calls,
      ["in", "press"],
      "the click after the responder's press is not a second one",
    );
    advance(200);
    // A later click with no gesture behind it (the keyboard, assistive technology) presses.
    click();
    assertEquals(calls, ["in", "press", "out", "press"]);
    // A long press's trailing click does not press either.
    handlers().onResponderGrant({});
    advance(600);
    handlers().onResponderRelease({});
    click();
    assertEquals(calls, ["in", "press", "out", "press", "in", "long", "out"]);
    await screen.unmount();
  });
});

// ---- VirtualizedSectionList ------------------------------------------------------------------

/** A react-native-web `View` stand-in. */
function View(props: { style?: unknown; children?: VNodeChild }): VNode {
  return h("div", null, props.children);
}

Deno.test("VirtualizedSectionList: sections read through getItem / getItemCount", async () => {
  const VSL = createVirtualizedSectionList({ View });
  let ref: SectionListRef | null = null;
  // Each section's data is a Map, not an array.
  const sections = [
    { key: "a", title: "A", data: new Map([[0, "a0"], [1, "a1"]]) },
    { key: "b", title: "B", data: new Map([[0, "b0"]]) },
  ];
  const screen = await render(h(VSL as never, {
    sections,
    ref: (r: SectionListRef | null) => (ref = r),
    getItem: (data: Map<number, string>, i: number) => data.get(i),
    getItemCount: (data: Map<number, string>) => data.size,
    keyExtractor: (item: string) => item,
    getItemLayout: (_s: unknown, i: number) => ({ length: 40, offset: 40 * i, index: i }),
    SectionSeparatorComponent: (p: { trailingItem?: string }) =>
      h("hr", { "data-text": `sep:${p.trailingItem ?? "-"}` }),
    renderSectionHeader: ({ section }: { section: { title: string } }) =>
      h("b", { "data-text": `H ${section.title}` }),
    renderItem: ({ item, index }: { item: string; index: number }) =>
      h("span", { "data-text": `${item}@${index}` }),
  }));
  const texts = all(screen).map((e) => e.getAttribute("data-text")).filter(Boolean);
  assertEquals(texts, ["H A", "sep:a0", "a0@0", "a1@1", "sep:-", "H B", "sep:b0", "b0@0", "sep:-"]);
  // b's header is flattened row 4 (header + 2 items + footer); itemIndex 1 = its first item.
  await act(() => ref!.scrollToLocation({ sectionIndex: 1, itemIndex: 1, animated: false }));
  await screen.unmount();
});

// ---- the waiver ------------------------------------------------------------------------------

Deno.test("native parity waiver: VirtualizedList's React class statics, and nothing else", async () => {
  const { diffSurfaces } = await import("../scripts/parity/diff.ts");
  const { NATIVE_WAIVERS } = await import("../scripts/parity/native/waivers.ts");
  const sym = (members: string[]) => ({
    name: "x",
    kind: "value",
    isValue: true,
    isType: false,
    members,
  });
  const surface = (members: string[]) => [{
    specifier: "react-native",
    resolved: true,
    symbols: { VirtualizedList: sym(members) },
  }];
  const real = surface(["contextType", "getDerivedStateFromProps"]);
  assertEquals(diffSurfaces(real as never, surface([]) as never, NATIVE_WAIVERS).errors, []);
  const newer = surface(["contextType", "someNewStatic"]);
  const errors = diffSurfaces(newer as never, surface([]) as never, NATIVE_WAIVERS).errors;
  assertEquals(errors.map((f) => f.symbol), ["VirtualizedList"], "a new member still fails");
});
