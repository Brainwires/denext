// Embedded web views (src/desktop/webview.ts, caps/webview.ts, caps/window.ts, app-windows.ts,
// webview-config.ts): the page's createWebView / webViewCapabilities and their wire calls, the
// handle's events routed by id, capture as a Blob and `closed` ending the handle; attachWebView
// following an element (one setBounds per frame, only on a change; hidden while detached, empty or
// out of view; stopping on detach and on `closed`); the backend's checks over a mocked runtime
// (argument validation, http(s) only, the app's own origin refused, allowedOrigins, the
// per-window limit shared with desktop.ts's views, a page driving only its own views, runtime
// error codes mapped, events to the owning window's page, cleanup on `closed` and on the window
// closing, an older runtime reporting `supported: false`); and `desktop.webViews` validation.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
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
import { createWindowController } from "../src/desktop/caps/window.ts";
import { type DesktopCapCtx, DesktopCapError } from "../src/desktop/extension.ts";
import type { DesktopAppApi } from "../src/desktop/launch-events.ts";
import { setUpDesktopWindows } from "../src/desktop/app-windows.ts";
import {
  resolveDesktopWebViewSettings,
  webViewsConfigProblem,
} from "../src/desktop/webview-config.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import {
  createFakeDesktopRuntime,
  type FakeMethod,
  until,
} from "./helpers/desktop-fake-runtime.ts";
import { withGlobals } from "./helpers/mobile-fakes.ts";

// ---------------------------------------------------------------------------------------------
// A mocked runtime: Deno.WebView, BrowserWindow.prototype.createWebView, webViewCapabilities
// ---------------------------------------------------------------------------------------------

/** The runtime's WebViewError. */
class FakeWebViewError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** A runtime web view recording its calls. */
class FakeWebView extends EventTarget {
  static next = 1;
  readonly id = FakeWebView.next++;
  calls: Array<[string, unknown]> = [];
  closed = false;
  /** Make the next call throw this runtime error code. */
  failWith?: string;
  constructor(readonly options: Record<string, unknown>) {
    super();
  }
  #rec(name: string, arg?: unknown) {
    if (this.failWith) {
      const code = this.failWith;
      this.failWith = undefined;
      throw new FakeWebViewError(code, `runtime says ${code}`);
    }
    this.calls.push([name, arg]);
  }
  setBounds(b: unknown) {
    this.#rec("setBounds", b);
  }
  setVisible(v: boolean) {
    this.#rec("setVisible", v);
  }
  navigate(url: string) {
    this.#rec("navigate", url);
  }
  back() {
    this.#rec("back");
  }
  forward() {
    this.#rec("forward");
  }
  reload(o?: unknown) {
    this.#rec("reload", o);
  }
  stop() {
    this.#rec("stop");
  }
  focus() {
    this.#rec("focus");
  }
  state() {
    this.#rec("state");
    return {
      url: "https://a.example/",
      title: "A",
      load: "complete",
      canGoBack: true,
      canGoForward: false,
      visible: true,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    };
  }
  capture(o?: unknown): Promise<Uint8Array> {
    this.#rec("capture", o);
    return Promise.resolve(new Uint8Array([137, 80, 78, 71]));
  }
  evaluate(script: string): Promise<unknown> {
    if (script === "throw") return Promise.reject(new FakeWebViewError("error", "boom"));
    this.#rec("evaluate", script);
    return Promise.resolve(script === "undef" ? undefined : { n: 1 });
  }
  close() {
    this.#rec("close");
    if (this.closed) return;
    this.closed = true;
    this.fire("closed", {});
  }
  fire(event: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(event, { detail }));
  }
}

/** A runtime window with `createWebView` (or without, `old`). */
function fakeWindow(old = false) {
  const made: FakeWebView[] = [];
  const win = Object.assign(new EventTarget(), {
    setTitle() {},
    createWebView: old ? undefined : (options: Record<string, unknown>) => {
      const v = new FakeWebView(options);
      made.push(v);
      return v;
    },
  });
  if (old) delete (win as { createWebView?: unknown }).createWebView;
  return { win, made };
}

/** A window controller over a fake window, with its page emits recorded. */
function controller(opts: {
  old?: boolean;
  caps?: unknown;
  limit?: number;
  allowedOrigins?: string[] | null;
  appOrigins?: string[];
} = {}) {
  const { win, made } = fakeWindow(opts.old);
  const emits: Array<{ cap: string; event: string; data: unknown }> = [];
  const api = {
    ...(opts.caps === undefined ? {} : { webViewCapabilities: () => opts.caps }),
  } as unknown as DesktopAppApi;
  const c = createWindowController({
    window: win,
    api,
    emit: (cap, event, data) => void emits.push({ cap, event, data }),
    exit: () => {},
    webViews: () => ({ limit: opts.limit ?? 8, allowedOrigins: opts.allowedOrigins ?? null }),
    appOrigins: () => opts.appOrigins ?? ["http://127.0.0.1:65304"],
  });
  const call = async (method: string, args: unknown) =>
    await c.capability.methods[method].handler(args, {} as DesktopCapCtx);
  return { c, call, made, emits, win };
}

const CAPS = {
  supported: true,
  engine: "cef",
  capture: true,
  evaluate: true,
  persistentPartitions: true,
  permissionPrompts: true,
};
const BOUNDS = { x: 10, y: 20, width: 300, height: 200 };

/** The DesktopCapError a call rejects with. */
async function rejection(fn: () => unknown): Promise<DesktopCapError> {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof DesktopCapError, `not a DesktopCapError: ${err}`);
    return err;
  }
  throw new Error("expected a rejection");
}

// ---------------------------------------------------------------------------------------------
// Backend: capabilities, create, checks
// ---------------------------------------------------------------------------------------------

Deno.test("web views backend: capabilities from the runtime, supported: false on an older one", async () => {
  assertEquals(await controller({ caps: CAPS }).call("webViewCapabilities", {}), {
    supported: true,
    engines: ["cef"],
    capture: true,
    evaluate: true,
  });
  const none = { supported: false, engines: [], capture: false, evaluate: false };
  // No Deno.desktop.webViewCapabilities, or no BrowserWindow.createWebView, or the engine says no.
  assertEquals(await controller().call("webViewCapabilities", {}), none);
  assertEquals(await controller({ caps: CAPS, old: true }).call("webViewCapabilities", {}), none);
  assertEquals(
    await controller({ caps: { ...CAPS, supported: false, capture: true } }).call(
      "webViewCapabilities",
      {},
    ),
    none,
  );
  // An older runtime: create rejects unsupported (501), before anything else is asked of it.
  const old = controller({ old: true });
  const err = await rejection(() =>
    old.call("webViewCreate", { options: { url: "https://a.example", bounds: BOUNDS } })
  );
  assertEquals([err.code, err.status], ["unsupported", 501]);
});

Deno.test("web views backend: create passes the checked options and answers a string id", async () => {
  const { call, made } = controller({ caps: CAPS });
  const out = await call("webViewCreate", {
    options: {
      url: "https://a.example/x",
      bounds: { x: 1.5, y: -2, width: 0, height: 10 },
      partition: "ephemeral:tile-1",
      visible: false,
      allowPopups: "deny",
      downloads: "ask",
      permissions: "ask",
      userAgent: "Qutty/1",
      extra: "dropped",
    },
  }) as { id: string };
  assertEquals(out, { id: String(made[0].id) });
  assertEquals(made[0].options, {
    url: "https://a.example/x",
    bounds: { x: 1.5, y: -2, width: 0, height: 10 },
    partition: "ephemeral:tile-1",
    visible: false,
    allowPopups: "deny",
    downloads: "ask",
    permissions: "ask",
    userAgent: "Qutty/1",
  });
});

Deno.test("web views backend: every argument is validated before the runtime is touched", async () => {
  const { call, made } = controller({ caps: CAPS });
  const bad: Array<[unknown, string]> = [
    [undefined, "options"],
    [{ bounds: BOUNDS }, "url"],
    [{ url: "https://a.example" }, "bounds"],
    [{ url: "https://a.example", bounds: { ...BOUNDS, x: NaN } }, "bounds.x"],
    [{ url: "https://a.example", bounds: { ...BOUNDS, width: -1 } }, "bounds.width"],
    [{ url: "https://a.example", bounds: { ...BOUNDS, y: Infinity } }, "bounds.y"],
    [{ url: "https://a.example", bounds: BOUNDS, partition: ":bad" }, "partition"],
    [{ url: "https://a.example", bounds: BOUNDS, partition: "x".repeat(65) }, "partition"],
    [{ url: "https://a.example", bounds: BOUNDS, visible: "yes" }, "visible"],
    [{ url: "https://a.example", bounds: BOUNDS, allowPopups: "tab" }, "allowPopups"],
    [{ url: "https://a.example", bounds: BOUNDS, downloads: "save" }, "downloads"],
    [{ url: "https://a.example", bounds: BOUNDS, permissions: "allow" }, "permissions"],
    [{ url: "https://a.example", bounds: BOUNDS, userAgent: "a\nb" }, "userAgent"],
  ];
  for (const [options, field] of bad) {
    const err = await rejection(() => call("webViewCreate", { options }));
    assertEquals(err.code, "validation", field);
    assertStringIncludes(err.message, field);
  }
  assertEquals(made.length, 0);
});

Deno.test("web views backend: http(s) only, never the app's origin, allowedOrigins on create and navigate", async () => {
  const { call, made } = controller({
    caps: CAPS,
    appOrigins: ["http://127.0.0.1:65304", "myapp://app", "https://app.example"],
  });
  for (
    const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "myapp://app/",
      "data:text/html,x",
      "not a url",
      "http://127.0.0.1:65304/_denext/desktop/rpc",
      "http://localhost:65304/",
      "http://[::1]:65304/",
      "https://app.example/page",
    ]
  ) {
    const err = await rejection(() => call("webViewCreate", { options: { url, bounds: BOUNDS } }));
    assertEquals(err.code, "not_allowed_url", url);
  }
  assertEquals(made.length, 0);
  // Another loopback port is another server: allowed.
  await call("webViewCreate", { options: { url: "http://127.0.0.1:8080/", bounds: BOUNDS } });

  const scoped = controller({ caps: CAPS, allowedOrigins: ["https://docs.example"] });
  const err = await rejection(() =>
    scoped.call("webViewCreate", { options: { url: "https://evil.example/", bounds: BOUNDS } })
  );
  assertEquals(err.code, "not_allowed_url");
  assertStringIncludes(err.message, "allowedOrigins");
  const { id } = await scoped.call("webViewCreate", {
    options: { url: "https://docs.example/a", bounds: BOUNDS },
  }) as { id: string };
  await scoped.call("webViewCall", {
    id,
    method: "navigate",
    args: { url: "https://docs.example/b" },
  });
  const nav = await rejection(() =>
    scoped.call("webViewCall", { id, method: "navigate", args: { url: "https://evil.example/" } })
  );
  assertEquals(nav.code, "not_allowed_url");
  const navApp = await rejection(() =>
    call("webViewCall", {
      id: String(made[0].id),
      method: "navigate",
      args: { url: "http://127.0.0.1:65304/" },
    })
  );
  assertEquals(navApp.code, "not_allowed_url");
  assertEquals(scoped.made[0].calls, [["navigate", "https://docs.example/b"]]);
});

Deno.test("web views backend: the per-window limit counts the page's and desktop.ts's views", async () => {
  const { c, call, made } = controller({ caps: CAPS, limit: 2 });
  const opts = { url: "https://a.example", bounds: BOUNDS };
  await call("webViewCreate", { options: opts });
  const backend = await c.createWebView(opts);
  const err = await rejection(() => call("webViewCreate", { options: opts }));
  assertEquals([err.code, err.status], ["limit", 429]);
  await assertRejects(() => c.createWebView(opts), DesktopCapError, "desktop.webViews.limit");
  // A closed view frees its slot.
  await backend.close();
  await call("webViewCreate", { options: opts });
  assertEquals(made.length, 3);
});

Deno.test("web views backend: webViewCall drives the runtime view, results shaped", async () => {
  const { call, made } = controller({ caps: CAPS });
  const { id } = await call("webViewCreate", {
    options: { url: "https://a.example", bounds: BOUNDS },
  }) as { id: string };
  const v = made[0];
  const run = (method: string, args?: unknown) => call("webViewCall", { id, method, args });
  assertEquals(await run("setBounds", { x: 1, y: 2, width: 3, height: 4 }), null);
  assertEquals(await run("setVisible", { visible: false }), null);
  assertEquals(await run("back"), null);
  assertEquals(await run("forward", null), null);
  assertEquals(await run("reload", { ignoreCache: true }), null);
  assertEquals(await run("reload", {}), null);
  assertEquals(await run("stop"), null);
  assertEquals(await run("focus"), null);
  assertEquals(await run("state"), {
    url: "https://a.example/",
    title: "A",
    load: "complete",
    canGoBack: true,
    canGoForward: false,
  });
  assertEquals(await run("capture", { format: "jpeg", quality: 80.4 }), {
    base64: "iVBORw==",
    type: "image/jpeg",
  });
  assertEquals(await run("evaluate", { script: "1+1" }), { value: { n: 1 } });
  assertEquals(await run("evaluate", { script: "undef" }), { value: null });
  assertEquals(v.calls, [
    ["setBounds", { x: 1, y: 2, width: 3, height: 4 }],
    ["setVisible", false],
    ["back", undefined],
    ["forward", undefined],
    ["reload", { ignoreCache: true }],
    ["reload", undefined],
    ["stop", undefined],
    ["focus", undefined],
    ["state", undefined],
    ["capture", { format: "jpeg", quality: 80 }],
    ["evaluate", "1+1"],
    ["evaluate", "undef"],
  ]);
  // Bad arguments never reach it.
  for (
    const [method, args] of [
      ["setBounds", { x: 1, y: 2, width: 3 }],
      ["setVisible", { visible: 1 }],
      ["reload", { ignoreCache: "yes" }],
      ["capture", { format: "gif" }],
      ["capture", { quality: 101 }],
      ["evaluate", { script: 1 }],
      ["teleport", {}],
    ] as const
  ) {
    assertEquals((await rejection(() => run(method, args))).code, "validation", method);
  }
  assertEquals((await rejection(() => call("webViewCall", { id, args: {} }))).code, "validation");
  assertEquals(
    (await rejection(() => call("webViewCall", { id, method: "back", args: [] }))).code,
    "validation",
  );
  assertEquals(v.calls.length, 12);
});

Deno.test("web views backend: the runtime's error codes map onto the bridge's", async () => {
  const { call, made, win } = controller({ caps: CAPS });
  const { id } = await call("webViewCreate", {
    options: { url: "https://a.example", bounds: BOUNDS },
  }) as { id: string };
  const v = made[0];
  for (
    const [runtime, bridge] of [
      ["unsupported", "unsupported"],
      ["not_allowed_url", "not_allowed_url"],
      ["limit", "limit"],
      ["invalid", "validation"],
      ["failed", "failed"],
      ["something_new", "failed"],
    ]
  ) {
    v.failWith = runtime;
    const err = await rejection(() => call("webViewCall", { id, method: "stop" }));
    assertEquals(err.code, bridge, runtime);
    assertStringIncludes(err.message, `runtime says ${runtime}`);
  }
  const thrown = await rejection(() =>
    call("webViewCall", { id, method: "evaluate", args: { script: "throw" } })
  );
  assertEquals(thrown.code, "error");
  // The runtime refusing the create itself (laufey's own 32, a closed window).
  (win as unknown as { createWebView: () => never }).createWebView = () => {
    throw new FakeWebViewError("limit", "32 web views");
  };
  const lim = await rejection(() =>
    call("webViewCreate", { options: { url: "https://a.example", bounds: BOUNDS } })
  );
  assertEquals(lim.code, "limit");
  (win as unknown as { createWebView: () => never }).createWebView = () => {
    throw new FakeWebViewError("closed", "window gone");
  };
  assertEquals(
    (await rejection(() =>
      call("webViewCreate", { options: { url: "https://a.example", bounds: BOUNDS } })
    )).code,
    "closed",
  );
});

Deno.test("web views backend: events go to the owning page; closed is last and drops the view", async () => {
  const { call, made, emits } = controller({ caps: CAPS });
  const { id } = await call("webViewCreate", {
    options: { url: "https://a.example", bounds: BOUNDS },
  }) as { id: string };
  const v = made[0];
  v.fire("title", { title: "Hello" });
  v.fire(
    "load",
    JSON.stringify({
      state: "failed",
      url: "https://a.example/",
      error: { code: "dns", message: "x" },
    }),
  );
  v.fire("focus-change", { focused: true });
  v.fire("closed", {});
  v.fire("title", { title: "after" });
  assertEquals(emits, [
    { cap: "window", event: "webview", data: { id, event: "title", detail: { title: "Hello" } } },
    {
      cap: "window",
      event: "webview",
      data: {
        id,
        event: "load",
        detail: {
          state: "failed",
          url: "https://a.example/",
          error: { code: "dns", message: "x" },
        },
      },
    },
    {
      cap: "window",
      event: "webview",
      data: { id, event: "focus-change", detail: { focused: true } },
    },
    { cap: "window", event: "webview", data: { id, event: "closed", detail: {} } },
  ]);
  // Gone: its id answers closed.
  assertEquals((await rejection(() => call("webViewCall", { id, method: "stop" }))).code, "closed");
});

Deno.test("web views backend: a page drives only its own window's views, never desktop.ts's", async () => {
  const a = controller({ caps: CAPS });
  const b = controller({ caps: CAPS });
  const { id } = await a.call("webViewCreate", {
    options: { url: "https://a.example", bounds: BOUNDS },
  }) as { id: string };
  // Another window's page: not its view.
  assertEquals(
    (await rejection(() => b.call("webViewCall", { id, method: "stop" }))).code,
    "closed",
  );
  // desktop.ts's view in the same window: not the page's to drive, and its events stay backend.
  const backend = await a.c.createWebView({ url: "https://b.example", bounds: BOUNDS });
  assertEquals(
    (await rejection(() => a.call("webViewCall", { id: backend.id, method: "stop" }))).code,
    "closed",
  );
  a.emits.length = 0;
  const seen: string[] = [];
  backend.on("title", (e) => seen.push(e.title));
  a.made[1].fire("title", { title: "B" });
  assertEquals(seen, ["B"]);
  assertEquals(a.emits, []);
  assertEquals(
    (await rejection(() => a.call("webViewCall", { id: "", method: "stop" }))).code,
    "validation",
  );
});

Deno.test("web views backend: desktop.ts's handle — same checks, Blob capture, closed ends it", async () => {
  const { c, made } = controller({ caps: CAPS, appOrigins: ["http://127.0.0.1:1"] });
  await assertRejects(
    () => c.createWebView({ url: "http://localhost:1/", bounds: BOUNDS }),
    DesktopCapError,
    "own origin",
  );
  const h = await c.createWebView({ url: "https://a.example", bounds: BOUNDS });
  assertEquals(h.id, String(made[0].id));
  await h.setBounds({ x: 0, y: 0, width: 5, height: 5 });
  await h.reload({ ignoreCache: true });
  assertEquals((await h.state()).title, "A");
  const blob = await h.capture({ format: "jpeg" });
  assertEquals([blob.type, blob.size], ["image/jpeg", 4]);
  assertEquals(await h.evaluate<{ n: number }>("x"), { n: 1 });
  const closed: unknown[] = [];
  h.on("closed", (e) => closed.push(e));
  await h.close();
  await h.close();
  assertEquals(closed, [{}]);
  await assertRejects(() => h.stop(), DesktopCapError, "closed");
  assertEquals(h.on("title", () => {})(), undefined);
});

Deno.test("web views backend: the window closing drops its views (desktop.ts hears closed)", async () => {
  const { c, call, made } = controller({ caps: CAPS, limit: 1 });
  const h = await c.createWebView({ url: "https://a.example", bounds: BOUNDS });
  let closed = 0;
  h.on("closed", () => closed++);
  c.windowClosed();
  assertEquals(closed, 1);
  // The runtime's own closed after that changes nothing; the slot is free.
  made[0].fire("closed", {});
  assertEquals(closed, 1);
  await call("webViewCreate", { options: { url: "https://a.example", bounds: BOUNDS } });
});

Deno.test("web views backend: win.createWebView on desktop.ts's window refs, the window's limit shared", async () => {
  const { win, made } = fakeWindow();
  const api = Object.assign(new EventTarget(), {
    quitOnLastWindowClosed: true,
    screens: () => [],
    webViewCapabilities: () => CAPS,
  }) as unknown as DesktopAppApi;
  const s = setUpDesktopWindows({
    window: win,
    api,
    emit: () => {},
    wantsTray: false,
    os: "darwin",
    exit: () => {},
    warn: () => {},
    appSettings: { keepAlive: true },
    runtimeVersion: "3.0.0-denext.22",
    webViews: { limit: 1, allowedOrigins: null },
    appOrigins: () => ["https://app.example"],
  });
  s.install();
  const main = s.windows.get("main")!;
  await assertRejects(
    () => main.createWebView({ url: "https://app.example/", bounds: BOUNDS }),
    DesktopCapError,
    "own origin",
  );
  const h = await main.createWebView({ url: "https://a.example/", bounds: BOUNDS });
  assertEquals(h.id, String(made[0].id));
  // The page of the same window shares the limit.
  const page = s.registry!.router.methods.webViewCreate;
  const err = await rejection(() =>
    page.handler({ options: { url: "https://b.example/", bounds: BOUNDS } }, {
      windowId: "main",
    } as DesktopCapCtx)
  );
  assertEquals(err.code, "limit");
});

// ---------------------------------------------------------------------------------------------
// Page side, end to end through the fake bridge to a real controller
// ---------------------------------------------------------------------------------------------

type Rt = ReturnType<typeof createFakeDesktopRuntime>;

/** A fake desktop window whose `window` capability's web view methods are a real controller's. */
async function inDesktop(
  fn: (rt: Rt, ctl: ReturnType<typeof controller>) => Promise<void>,
  opts: Parameters<typeof controller>[0] = { caps: CAPS },
): Promise<void> {
  const ctl = controller(opts);
  const methods: Record<string, FakeMethod> = {};
  for (const name of ["webViewCapabilities", "webViewCreate", "webViewCall"]) {
    methods[name] = (args) => ctl.call(name, args);
  }
  const rt = createFakeDesktopRuntime({ window: methods });
  // The controller's page events go out on the fake stream.
  const forward = ctl.emits.push.bind(ctl.emits);
  ctl.emits.push = (...items) => {
    for (const e of items) rt.emit(e.cap, e.event, e.data);
    return forward(...items);
  };
  const restore = rt.install();
  try {
    await fn(rt, ctl);
  } finally {
    resetWebViewsForTesting();
    resetDesktopBridgeForTesting();
    restore();
  }
}

Deno.test("web views page: off desktop every call rejects unavailable, without a request", async () => {
  for (
    const fn of [
      () => createWebView({ url: "https://a.example", bounds: BOUNDS }),
      webViewCapabilities,
    ]
  ) {
    const err = await assertRejects(fn);
    assert(isDesktopBridgeError(err) && err.code === "unavailable");
  }
  resetWebViewsForTesting();
});

Deno.test("web views page: capabilities and create on the wire; an older runtime says supported: false", async () => {
  await inDesktop(async (rt) => {
    assertEquals(await webViewCapabilities(), {
      supported: true,
      engines: ["cef"],
      capture: true,
      evaluate: true,
    });
    const view = await createWebView({ url: "https://a.example", bounds: BOUNDS, partition: "p1" });
    assertEquals(typeof view.id, "string");
    assertEquals(rt.calls.map((c) => [c.method, c.args]), [
      ["webViewCapabilities", {}],
      ["webViewCreate", { options: { url: "https://a.example", bounds: BOUNDS, partition: "p1" } }],
    ]);
  });
  await inDesktop(async () => {
    assertEquals(await webViewCapabilities(), {
      supported: false,
      engines: [],
      capture: false,
      evaluate: false,
    });
    const err = await assertRejects(() =>
      createWebView({ url: "https://a.example", bounds: BOUNDS })
    );
    assert(isDesktopBridgeError(err) && err.code === "unsupported");
  }, { old: true });
});

Deno.test("web views page: the handle's calls, capture as a Blob, evaluate's value", async () => {
  await inDesktop(async (rt, ctl) => {
    const view = await createWebView({ url: "https://a.example", bounds: BOUNDS });
    await view.setBounds({ x: 1, y: 2, width: 3, height: 4 });
    await view.setVisible(false);
    await view.navigate("https://a.example/next");
    await view.reload({ ignoreCache: true });
    await view.reload();
    await view.focus();
    assertEquals(await view.state(), {
      url: "https://a.example/",
      title: "A",
      load: "complete",
      canGoBack: true,
      canGoForward: false,
    });
    const blob = await view.capture();
    assertEquals([blob.type, blob.size], ["image/png", 4]);
    assertEquals([...new Uint8Array(await blob.arrayBuffer())], [137, 80, 78, 71]);
    assertEquals(await view.evaluate("1"), { n: 1 });
    const wire = rt.calls.filter((c) => c.method === "webViewCall").map((c) => c.args);
    assertEquals(wire.slice(0, 4), [
      { id: view.id, method: "setBounds", args: { x: 1, y: 2, width: 3, height: 4 } },
      { id: view.id, method: "setVisible", args: { visible: false } },
      { id: view.id, method: "navigate", args: { url: "https://a.example/next" } },
      { id: view.id, method: "reload", args: { ignoreCache: true } },
    ]);
    const err = await assertRejects(() => view.navigate("file:///etc/hosts"));
    assert(isDesktopBridgeError(err) && err.code === "not_allowed_url");
    assertEquals(ctl.made[0].calls.at(-1), ["evaluate", "1"]);
  });
});

Deno.test("web views page: events reach their handle by id; closed ends the handle", async () => {
  await inDesktop(async (rt, ctl) => {
    const a = await createWebView({ url: "https://a.example", bounds: BOUNDS });
    const b = await createWebView({ url: "https://b.example", bounds: BOUNDS });
    const titles: string[] = [];
    const urls: unknown[] = [];
    const closedA: unknown[] = [];
    const stopTitle = a.on("title", (e) => titles.push(`a:${e.title}`));
    b.on("title", (e) => titles.push(`b:${e.title}`));
    a.on("url", (e) => urls.push(e));
    a.on("closed", (e) => closedA.push(e));
    ctl.made[0].fire("title", { title: "one" });
    ctl.made[1].fire("title", { title: "two" });
    ctl.made[0].fire("url", { url: "https://a.example/2", canGoBack: true, canGoForward: false });
    await until(() => titles.length === 2 && urls.length === 1);
    assertEquals(titles.sort(), ["a:one", "b:two"]);
    assertEquals(urls, [{ url: "https://a.example/2", canGoBack: true, canGoForward: false }]);
    stopTitle();
    ctl.made[0].fire("title", { title: "unheard" });
    // The window closing the view: closed once, then calls reject closed without a request.
    ctl.made[0].fire("closed", {});
    await until(() => closedA.length === 1);
    await rt.settled();
    assertEquals(titles.length, 2);
    const before = rt.calls.length;
    const err = await assertRejects(() => a.stop());
    assert(isDesktopBridgeError(err) && err.code === "closed");
    assertEquals(rt.calls.length, before);
    // close() on b fires closed once, even though the runtime's event follows.
    const closedB: unknown[] = [];
    b.on("closed", (e) => closedB.push(e));
    await b.close();
    await b.close();
    await rt.settled();
    assertEquals(closedB, [{}]);
  });
});

Deno.test("web views page: events that arrive before the create answers are delivered in order", async () => {
  await inDesktop(async (rt, ctl) => {
    // The runtime fires a load the moment the view exists, before the page has the id.
    const original = ctl.win.createWebView!;
    ctl.win.createWebView = (o: Record<string, unknown>) => {
      const v = original(o);
      queueMicrotask(() => v.fire("load", { state: "loading", url: "https://a.example/" }));
      return v;
    };
    // ...and the create's answer is slow, so the page reads the event first.
    const call = ctl.call;
    ctl.call = async (name, args) => {
      const out = await call(name, args);
      if (name === "webViewCreate") await new Promise((r) => setTimeout(r, 100));
      return out;
    };
    const view = await createWebView({ url: "https://a.example", bounds: BOUNDS });
    assertEquals(rt.calls.length, 1);
    const loads: string[] = [];
    view.on("load", (e) => loads.push(e.state));
    ctl.made[0].fire("load", { state: "complete", url: "https://a.example/" });
    await until(() => loads.length === 2);
    assertEquals(loads, ["loading", "complete"]);
  });
});

// ---------------------------------------------------------------------------------------------
// attachWebView
// ---------------------------------------------------------------------------------------------

/** A handle recording setBounds / setVisible, with `closed` fired by `fireClosed`. */
function fakeHandle(failCode?: string) {
  const calls: string[] = [];
  const closedFns = new Set<() => void>();
  const handle = {
    id: "1",
    setBounds: (b: { x: number; y: number; width: number; height: number }) => {
      if (failCode) return Promise.reject(Object.assign(new Error(failCode), { code: failCode }));
      calls.push(`bounds:${b.x},${b.y},${b.width},${b.height}`);
      return Promise.resolve();
    },
    setVisible: (v: boolean) => {
      calls.push(`visible:${v}`);
      return Promise.resolve();
    },
    on: (event: string, fn: () => void) => {
      if (event !== "closed") return () => {};
      closedFns.add(fn);
      return () => void closedFns.delete(fn);
    },
  } as unknown as WebViewHandle;
  return { handle, calls, fireClosed: () => [...closedFns].forEach((f) => f()), closedFns };
}

/** Browser layout globals with controllable observers, frames and media queries. */
function fakeLayout() {
  const frames: Array<() => void> = [];
  const resizeCbs = new Set<() => void>();
  const ioCbs = new Set<(e: Array<{ isIntersecting: boolean }>) => void>();
  const listeners = new Map<string, Set<() => void>>();
  const media: Array<{ query: string; fns: Set<() => void> }> = [];
  const globals = {
    innerWidth: 1000,
    innerHeight: 800,
    devicePixelRatio: 1,
    requestAnimationFrame: (cb: () => void) => frames.push(cb),
    cancelAnimationFrame: () => {},
    ResizeObserver: class {
      cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe() {
        resizeCbs.add(this.cb);
      }
      disconnect() {
        resizeCbs.delete(this.cb);
      }
    },
    IntersectionObserver: class {
      cb: (e: Array<{ isIntersecting: boolean }>) => void;
      constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) {
        this.cb = cb;
      }
      observe() {
        ioCbs.add(this.cb);
      }
      disconnect() {
        ioCbs.delete(this.cb);
      }
    },
    matchMedia: (query: string) => {
      const m = { query, fns: new Set<() => void>() };
      media.push(m);
      return {
        addEventListener: (_t: string, fn: () => void) => m.fns.add(fn),
        removeEventListener: (_t: string, fn: () => void) => m.fns.delete(fn),
      };
    },
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => void listeners.get(type)?.delete(fn),
  };
  /** Run the pending animation frames, then let the calls they started settle. */
  const frame = async () => {
    const run = frames.splice(0);
    run.forEach((f) => f());
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { globals, frames, frame, resizeCbs, ioCbs, listeners, media };
}

/** An element whose rect and connection the test sets. */
function anchor(rect = { left: 10, top: 20, width: 300, height: 200 }) {
  const el = {
    rect,
    isConnected: true,
    getBoundingClientRect() {
      return el.rect;
    },
  };
  return el as typeof el & WebViewAnchor;
}

Deno.test("attachWebView: glued to the element, at most one setBounds per frame, only on a change", async () => {
  const layout = fakeLayout();
  await withGlobals(layout.globals, async () => {
    const { handle, calls } = fakeHandle();
    const el = anchor();
    const detach = attachWebView(handle, el);
    await layout.frame();
    assertEquals(calls, ["bounds:10,20,300,200", "visible:true"]);
    // Scroll, resize and an observer firing in one frame: one call, the latest rect.
    el.rect = { left: 10, top: 5, width: 300, height: 200 };
    layout.listeners.get("scroll")!.forEach((f) => f());
    layout.listeners.get("resize")!.forEach((f) => f());
    layout.resizeCbs.forEach((f) => f());
    assertEquals(layout.frames.length, 1);
    await layout.frame();
    assertEquals(calls.slice(2), ["bounds:10,5,300,200"]);
    // Nothing changed: nothing sent.
    layout.resizeCbs.forEach((f) => f());
    await layout.frame();
    assertEquals(calls.length, 3);
    // A devicePixelRatio change re-arms the resolution query for the new ratio.
    assertEquals(layout.media[0].query, "(resolution: 1dppx)");
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    el.rect = { left: 11, top: 5, width: 300, height: 200 };
    layout.media[0].fns.forEach((f) => f());
    assertEquals(layout.media[0].fns.size, 0);
    assertEquals(layout.media[1].query, "(resolution: 2dppx)");
    await layout.frame();
    assertEquals(calls.slice(3), ["bounds:11,5,300,200"]);
    detach();
    assertEquals(layout.resizeCbs.size + layout.ioCbs.size + layout.media[1].fns.size, 0);
    assertEquals(layout.listeners.get("scroll")!.size + layout.listeners.get("resize")!.size, 0);
    el.rect = { left: 0, top: 0, width: 1, height: 1 };
    layout.resizeCbs.forEach((f) => f());
    await layout.frame();
    assertEquals(calls.length, 4);
  });
});

Deno.test("attachWebView: hidden while detached, empty or out of view, shown again when back", async () => {
  const layout = fakeLayout();
  await withGlobals(layout.globals, async () => {
    const { handle, calls } = fakeHandle();
    const el = anchor();
    attachWebView(handle, el);
    await layout.frame();
    calls.length = 0;
    // display: none / zero size.
    el.rect = { left: 0, top: 0, width: 0, height: 0 };
    layout.resizeCbs.forEach((f) => f());
    await layout.frame();
    assertEquals(calls, ["visible:false"]);
    // Back at its old place: shown, no bounds needed.
    el.rect = { left: 10, top: 20, width: 300, height: 200 };
    layout.resizeCbs.forEach((f) => f());
    await layout.frame();
    assertEquals(calls, ["visible:false", "visible:true"]);
    // Out of the document.
    el.isConnected = false;
    layout.resizeCbs.forEach((f) => f());
    await layout.frame();
    el.isConnected = true;
    layout.resizeCbs.forEach((f) => f());
    await layout.frame();
    // Clipped away by a scroller (IntersectionObserver), then entirely below the viewport.
    layout.ioCbs.forEach((f) => f([{ isIntersecting: false }]));
    await layout.frame();
    layout.ioCbs.forEach((f) => f([{ isIntersecting: true }]));
    await layout.frame();
    el.rect = { left: 10, top: 900, width: 300, height: 200 };
    layout.listeners.get("scroll")!.forEach((f) => f());
    await layout.frame();
    assertEquals(calls.slice(2), [
      "visible:false",
      "visible:true",
      "visible:false",
      "visible:true",
      "visible:false", // below the viewport: hidden, no bounds sent
    ]);
  });
});

Deno.test("attachWebView: stops when the view closes; hideWhenOutOfView: false keeps it shown", async () => {
  const layout = fakeLayout();
  await withGlobals(layout.globals, async () => {
    const { handle, calls, fireClosed, closedFns } = fakeHandle();
    const el = anchor({ left: 10, top: 900, width: 300, height: 200 });
    attachWebView(handle, el, { hideWhenOutOfView: false });
    await layout.frame();
    assertEquals(calls, ["bounds:10,900,300,200", "visible:true"]);
    fireClosed();
    assertEquals(closedFns.size, 0);
    assertEquals(layout.resizeCbs.size, 0);
    layout.listeners.get("scroll")?.forEach((f) => f());
    await layout.frame();
    assertEquals(calls.length, 2);
    // A view that answers closed stops the attachment too.
    const failing = fakeHandle("closed");
    attachWebView(failing.handle, anchor());
    await layout.frame();
    assertEquals(layout.resizeCbs.size, 0);
    assertEquals(failing.closedFns.size, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// desktop.webViews
// ---------------------------------------------------------------------------------------------

Deno.test("desktop.webViews: validated in the config and at launch", () => {
  assertEquals(webViewsConfigProblem(undefined), null);
  assertEquals(
    webViewsConfigProblem({ limit: 1, allowedOrigins: ["https://a.example:8443"] }),
    null,
  );
  for (
    const [value, field] of [
      [[], "webViews"],
      [{ limit: 0 }, "webViews.limit"],
      [{ limit: 33 }, "webViews.limit"],
      [{ limit: 2.5 }, "webViews.limit"],
      [{ allowedOrigins: "https://a.example" }, "webViews.allowedOrigins"],
      [{ allowedOrigins: ["https://a.example/path"] }, "webViews.allowedOrigins[0]"],
      [
        { allowedOrigins: ["https://ok.example", "https://*.example"] },
        "webViews.allowedOrigins[1]",
      ],
      [{ allowedOrigins: ["myapp://app"] }, "webViews.allowedOrigins[0]"],
      [{ allowedOrigins: ["https://u:p@a.example"] }, "webViews.allowedOrigins[0]"],
    ] as const
  ) {
    assertEquals(webViewsConfigProblem(value)?.[0], field, JSON.stringify(value));
  }
  assertEquals(resolveDesktopWebViewSettings({}), { limit: 8, allowedOrigins: null });
  assertEquals(
    resolveDesktopWebViewSettings({
      webViews: { limit: 3, allowedOrigins: ["HTTPS://Docs.Example:443/", "https://docs.example"] },
    }),
    { limit: 3, allowedOrigins: ["https://docs.example"] },
  );
  let threw = "";
  try {
    resolveDesktopWebViewSettings({ webViews: { limit: 99 } });
  } catch (err) {
    threw = (err as Error).message;
  }
  assertStringIncludes(threw, "desktop.webViews.limit");
  const errorOf = (webViews: unknown) => {
    try {
      validateDenextConfig({ desktop: { webViews } } as unknown as DenextConfig);
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  };
  assertEquals(errorOf({ limit: 4, allowedOrigins: ["https://a.example"] }), "");
  assertStringIncludes(errorOf({ limit: 40 }), "desktop.webViews.limit");
  assertStringIncludes(
    errorOf({ allowedOrigins: ["ftp://a.example"] }),
    "desktop.webViews.allowedOrigins[0]",
  );
});
