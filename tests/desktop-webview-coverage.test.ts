// The edges of src/desktop/webview.ts and webview-handle.ts the feature tests leave out, over a
// fake bridge whose `window` methods answer what each case needs: odd capability and create
// answers, odd call results (capture with no bytes, evaluate with no value, a state of the wrong
// shape, getZoom with no factor), `closed` from a call ending the handle, malformed or unknown
// webview events, the pending queue's id cap, a listener that throws, events queued after a
// `closed`; and attachWebView without the browser layout APIs (timer frames, no viewport), with a
// change arriving while a call is in flight, and detached with a frame pending or twice.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  attachWebView,
  createWebView,
  type WebViewAnchor,
  webViewCapabilities,
  type WebViewHandle,
} from "../src/desktop/window.ts";
import { resetWebViewsForTesting } from "../src/desktop/webview.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { isDesktopBridgeError } from "../src/desktop/client.ts";
import {
  createFakeDesktopRuntime,
  type FakeMethod,
  until,
} from "./helpers/desktop-fake-runtime.ts";
import { withGlobals } from "./helpers/mobile-fakes.ts";

const BOUNDS = { x: 0, y: 0, width: 100, height: 100 };

type Rt = ReturnType<typeof createFakeDesktopRuntime>;

/** Run `fn` with a fake desktop bridge whose `window` capability has `methods`. */
async function withBridge(
  methods: Record<string, FakeMethod>,
  fn: (rt: Rt) => Promise<void>,
): Promise<void> {
  const rt = createFakeDesktopRuntime({ window: methods });
  const restore = rt.install();
  try {
    await fn(rt);
  } finally {
    resetWebViewsForTesting();
    resetDesktopBridgeForTesting();
    restore();
  }
}

/** A create answering the ids in `ids`, in turn. */
function creates(...ids: unknown[]): FakeMethod {
  return () => ids.shift();
}

Deno.test("web views page: capabilities keep only known engines and true flags", async () => {
  const answers: unknown[] = [
    { supported: true, engines: ["cef", "gecko", 3, "wkwebview"], capture: true, zoom: "yes" },
    { supported: true, engines: "cef" },
    null,
  ];
  await withBridge({ webViewCapabilities: () => answers.shift() }, async () => {
    const a = await webViewCapabilities();
    assertEquals(a.supported, true);
    assertEquals(a.engines, ["cef", "wkwebview"]);
    assertEquals([a.capture, a.zoom, a.find], [true, false, false]);
    const b = await webViewCapabilities();
    assertEquals([b.supported, b.engines], [true, []]);
    const c = await webViewCapabilities();
    assertEquals([c.supported, c.engines, c.capture], [false, [], false]);
  });
});

Deno.test("web views page: a create answering no id is a bridge_error", async () => {
  await withBridge({ webViewCreate: creates({}, { id: "" }, { id: 7 }) }, async () => {
    for (let i = 0; i < 3; i++) {
      const err = await assertRejects(() =>
        createWebView({ url: "https://a.example", bounds: BOUNDS })
      );
      assert(isDesktopBridgeError(err) && err.code === "bridge_error");
    }
  });
});

Deno.test("web views page: odd call results are shaped; back / forward / find on the wire", async () => {
  const states: unknown[] = [
    "nonsense",
    { url: 1, title: null, load: "loading", canGoBack: "yes", zOrder: Number.NaN },
    { url: "u", title: "t", load: "interactive", canGoForward: true, zOrder: 3 },
    { load: "failed" },
  ];
  const zooms: unknown[] = [null, { factor: "2" }, { factor: 2 }];
  const methods: Record<string, FakeMethod> = {
    webViewCreate: creates({ id: "v1" }),
    webViewCall: (args) => {
      const { method } = args as { method: string };
      if (method === "capture") return {};
      if (method === "evaluate") return {};
      if (method === "state") return states.shift();
      if (method === "getZoom") return zooms.shift();
      return null;
    },
  };
  await withBridge(methods, async (rt) => {
    const view = await createWebView({ url: "https://a.example", bounds: BOUNDS });
    const blob = await view.capture();
    assertEquals([blob.type, blob.size], ["image/png", 0]);
    assertEquals(await view.evaluate("x"), null);
    assertEquals(await view.state(), {
      url: "",
      title: "",
      load: "complete",
      canGoBack: false,
      canGoForward: false,
      zOrder: 0,
    });
    assertEquals(await view.state(), {
      url: "",
      title: "",
      load: "loading",
      canGoBack: false,
      canGoForward: false,
      zOrder: 0,
    });
    assertEquals(await view.state(), {
      url: "u",
      title: "t",
      load: "interactive",
      canGoBack: false,
      canGoForward: true,
      zOrder: 3,
    });
    assertEquals((await view.state()).load, "failed");
    assertEquals([await view.getZoom(), await view.getZoom(), await view.getZoom()], [1, 1, 2]);
    await view.back();
    await view.forward();
    await view.find("needle");
    const wire = rt.calls.filter((c) => c.method === "webViewCall").map((c) => c.args);
    assertEquals(wire.slice(-3), [
      { id: "v1", method: "back", args: {} },
      { id: "v1", method: "forward", args: {} },
      { id: "v1", method: "find", args: { text: "needle" } },
    ]);
  });
});

Deno.test("web views page: a call answered closed ends the handle; other errors leave it open", async () => {
  const codes = ["unsupported", "closed"];
  const methods: Record<string, FakeMethod> = {
    webViewCreate: creates({ id: "v1" }),
    webViewCall: () => {
      throw { code: codes.shift(), message: "no" };
    },
  };
  await withBridge(methods, async (rt) => {
    const view = await createWebView({ url: "https://a.example", bounds: BOUNDS });
    const closed: unknown[] = [];
    view.on("closed", (e) => closed.push(e));
    const first = await assertRejects(() => view.reload());
    assert(isDesktopBridgeError(first) && first.code === "unsupported");
    assertEquals(closed, []);
    const second = await assertRejects(() => view.stop());
    assert(isDesktopBridgeError(second) && second.code === "closed");
    assertEquals(closed, [{}]);
    // Closed now: no request, and close() is a no-op; a listener added later is never called.
    const before = rt.calls.length;
    await view.close();
    const stop = view.on("title", () => closed.push("late"));
    stop();
    assertEquals(rt.calls.length, before);
  });
});

Deno.test("web views page: malformed events are dropped; unknown ids queue, at most 16 of them", async () => {
  await withBridge(
    { webViewCreate: creates({ id: "first" }, { id: "late" }, { id: "x0" }) },
    async (rt) => {
      const first = await createWebView({ url: "https://a.example", bounds: BOUNDS });
      const seen: string[] = [];
      first.on("title", (e) => seen.push(`title:${JSON.stringify(e)}`));
      for (
        const bad of [
          null,
          { event: "title" },
          { id: "first", event: 5 },
          { id: "first", event: "no-such-event", detail: {} },
        ]
      ) rt.emit("window", "webview", bad);
      rt.emit("window", "webview", { id: "first", event: "title" }); // no detail: {}
      // Events for views the page has no handle for: 17 ids, the oldest dropped.
      for (let i = 0; i < 17; i++) {
        rt.emit("window", "webview", { id: `x${i}`, event: "title", detail: { title: `x${i}` } });
      }
      // A view whose queue holds closed and then another event.
      rt.emit("window", "webview", { id: "late", event: "title", detail: { title: "early" } });
      rt.emit("window", "webview", { id: "late", event: "closed", detail: {} });
      rt.emit("window", "webview", { id: "late", event: "title", detail: { title: "after" } });
      await rt.settled();
      assertEquals(seen, ["title:{}"]);

      const late = await createWebView({ url: "https://b.example", bounds: BOUNDS });
      const lateSeen: string[] = [];
      late.on("title", (e) => lateSeen.push(e.title));
      late.on("closed", () => lateSeen.push("closed"));
      await until(() => lateSeen.includes("closed"));
      await rt.settled();
      assertEquals(lateSeen, ["early", "closed"]);

      // x0 was the oldest of the 18 queued ids: its event was dropped.
      const x0 = await createWebView({ url: "https://c.example", bounds: BOUNDS });
      const x0Seen: string[] = [];
      x0.on("title", (e) => x0Seen.push(e.title));
      await rt.settled();
      assertEquals(x0Seen, []);
    },
  );
});

Deno.test("web views page: a throwing listener is reported, the others still hear the event", async () => {
  const reported: unknown[] = [];
  const onError = (e: ErrorEvent) => {
    e.preventDefault();
    reported.push(e.error);
  };
  globalThis.addEventListener("error", onError);
  try {
    await withBridge({ webViewCreate: creates({ id: "v1" }) }, async (rt) => {
      const view = await createWebView({ url: "https://a.example", bounds: BOUNDS });
      const heard: string[] = [];
      view.on("title", () => {
        throw new Error("listener broke");
      });
      view.on("title", (e) => heard.push(e.title));
      rt.emit("window", "webview", { id: "v1", event: "title", detail: { title: "t" } });
      await until(() => heard.length === 1 && reported.length === 1);
      assertEquals((reported[0] as Error).message, "listener broke");
    });
  } finally {
    globalThis.removeEventListener("error", onError);
  }
});

// ---------------------------------------------------------------------------------------------
// attachWebView without (and with partial) browser layout APIs
// ---------------------------------------------------------------------------------------------

/** A handle recording its calls; `hold` makes setBounds wait for `release`. */
function recordingHandle() {
  const calls: string[] = [];
  let held: (() => void) | undefined;
  const state = { hold: false };
  const handle = {
    id: "1",
    setBounds: (b: { x: number; y: number; width: number; height: number }) => {
      calls.push(`bounds:${b.x},${b.y},${b.width},${b.height}`);
      if (!state.hold) return Promise.resolve();
      return new Promise<void>((r) => held = r);
    },
    setVisible: (v: boolean) => {
      calls.push(`visible:${v}`);
      return Promise.resolve();
    },
    on: () => () => {},
  } as unknown as WebViewHandle;
  return { handle, calls, state, release: () => held?.() };
}

/** An element whose rect the test sets. */
function anchor(rect = { left: 10, top: 20, width: 300, height: 200 }) {
  const el = {
    rect,
    getBoundingClientRect() {
      return el.rect;
    },
  };
  return el as typeof el & WebViewAnchor;
}

Deno.test("attachWebView: without the layout APIs it runs on timer frames, unclipped by a viewport", async () => {
  const { handle, calls } = recordingHandle();
  const el = anchor({ left: -50, top: 5000, width: 300, height: 200 });
  const detach = attachWebView(handle, el);
  await until(() => calls.length === 2);
  // No innerWidth / innerHeight: the element's own rect is the viewport, nothing cut.
  assertEquals(calls, ["bounds:-50,5000,300,200", "visible:true"]);
  detach();
  detach();
});

Deno.test("attachWebView: detaching with a timer frame pending cancels it", async () => {
  const realClear = globalThis.clearTimeout;
  const cleared: unknown[] = [];
  const clear = (id?: number) => {
    cleared.push(id);
    realClear(id);
  };
  await withGlobals({ clearTimeout: clear }, () => {
    const { handle, calls } = recordingHandle();
    const detach = attachWebView(handle, anchor());
    detach();
    assertEquals(cleared.length, 1);
    assertEquals(calls, []);
  });
});

Deno.test("attachWebView: a change while a call is in flight runs one more frame; a frame after detach does nothing", async () => {
  const frames: Array<() => void> = [];
  const resizeCbs = new Set<() => void>();
  const cancelled: number[] = [];
  const globals = {
    innerWidth: 1000,
    innerHeight: 800,
    requestAnimationFrame: (cb: () => void) => frames.push(cb),
    cancelAnimationFrame: (id: number) => void cancelled.push(id),
    ResizeObserver: class {
      constructor(readonly cb: () => void) {}
      observe() {
        resizeCbs.add(this.cb);
      }
      disconnect() {
        resizeCbs.delete(this.cb);
      }
    },
    getComputedStyle: () => ({ overflowX: "visible", overflowY: "visible" }),
  };
  const frame = async () => {
    frames.splice(0).forEach((f) => f());
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  await withGlobals(globals, async () => {
    const { handle, calls, state, release } = recordingHandle();
    const el = anchor();
    state.hold = true;
    const detach = attachWebView(handle, el);
    await frame();
    assertEquals(calls, ["bounds:10,20,300,200"]);
    // The element moves while setBounds is in flight: no frame yet, one once the call ends.
    el.rect = { left: 12, top: 20, width: 300, height: 200 };
    resizeCbs.forEach((f) => f());
    assertEquals(frames.length, 0);
    state.hold = false;
    release();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assertEquals(frames.length, 1);
    await frame();
    assertEquals(calls, ["bounds:10,20,300,200", "visible:true", "bounds:12,20,300,200"]);
    // A frame scheduled, then detached: cancelled; the frame running anyway does nothing.
    el.rect = { left: 14, top: 20, width: 300, height: 200 };
    resizeCbs.forEach((f) => f());
    assertEquals(frames.length, 1);
    detach();
    assertEquals(cancelled.length, 1);
    await frame();
    assertEquals(calls.length, 3);
  });
});

Deno.test("attachWebView: detached while a call is in flight, the pending change is dropped", async () => {
  const frames: Array<() => void> = [];
  const resizeCbs = new Set<() => void>();
  const globals = {
    requestAnimationFrame: (cb: () => void) => frames.push(cb),
    ResizeObserver: class {
      constructor(readonly cb: () => void) {}
      observe() {
        resizeCbs.add(this.cb);
      }
      disconnect() {
        resizeCbs.delete(this.cb);
      }
    },
  };
  await withGlobals(globals, async () => {
    const { handle, calls, state, release } = recordingHandle();
    const el = anchor();
    state.hold = true;
    const detach = attachWebView(handle, el);
    frames.splice(0).forEach((f) => f());
    await Promise.resolve();
    el.rect = { left: 1, top: 1, width: 5, height: 5 };
    resizeCbs.forEach((f) => f()); // dirty while in flight
    const cbs = [...resizeCbs];
    detach();
    cbs.forEach((f) => f()); // a late observer callback after detach
    release();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assertEquals(frames.length, 0);
    assertEquals(calls, ["bounds:10,20,300,200"]);
  });
});
