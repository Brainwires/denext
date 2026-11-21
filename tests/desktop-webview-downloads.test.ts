// Web view downloads and permission requests (src/desktop/webview-downloads.ts, webview.ts,
// webview-handle.ts, caps/webview.ts): `downloads: "app"` / `permissions: "app"` probed against
// the runtime's capabilities; the download item's state machine (will-download once, `updated`,
// `done` once, a download with no listener cancelled, the view closing ending it); the page's
// `save` destinations confined by the fs / file-drag rules and never an absolute path, desktop.ts's
// `save` taking one; the permission handler (allow, refuse, a throw, a rejection, the time limit,
// no handler, a cancelled request's late answer dropped); a page load settling the requests its
// page left waiting; and the page side end to end over the fake bridge.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createWindowController } from "../src/desktop/caps/window.ts";
import { type DesktopCapCtx, DesktopCapError } from "../src/desktop/extension.ts";
import type { DesktopAppApi } from "../src/desktop/launch-events.ts";
import { PickedPaths } from "../src/desktop/picked-paths.ts";
import { createWebViewMedia, downloadEventOf } from "../src/desktop/webview-downloads.ts";
import {
  createWebView,
  type WebViewDownloadDone,
  type WebViewDownloadItem,
  type WebViewHandle,
} from "../src/desktop/webview.ts";
import { resetWebViewsForTesting } from "../src/desktop/webview.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { isDesktopBridgeError } from "../src/desktop/client.ts";
import {
  createFakeDesktopRuntime,
  type FakeMethod,
  until,
} from "./helpers/desktop-fake-runtime.ts";

/** The runtime's WebViewError. */
class FakeWebViewError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** A runtime web view with app-decided downloads and permission requests. */
class FakeView extends EventTarget {
  static next = 1;
  readonly id = FakeView.next++;
  calls: unknown[][] = [];
  closed = false;
  failWith?: string;
  constructor(readonly options: Record<string, unknown>) {
    super();
  }
  setBounds() {}
  setVisible() {}
  navigate() {}
  back() {}
  forward() {}
  reload() {}
  stop() {}
  focus() {}
  state() {
    return {};
  }
  capture() {
    return Promise.resolve(new Uint8Array());
  }
  evaluate() {
    return Promise.resolve(null);
  }
  controlDownload(...args: unknown[]) {
    if (this.failWith) {
      const code = this.failWith;
      this.failWith = undefined;
      throw new FakeWebViewError(code, `runtime says ${code}`);
    }
    this.calls.push(["controlDownload", ...args]);
  }
  respondToPermissionRequest(...args: unknown[]) {
    this.calls.push(["respond", ...args]);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.fire("closed", {});
  }
  fire(event: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(event, { detail }));
  }
  download(detail: Record<string, unknown>) {
    this.fire("download", { url: "https://a.example/f.zip", filename: "f.zip", ...detail });
  }
}

/** A runtime view class without the new members (an older runtime). */
class OldView extends EventTarget {}

const CAPS = {
  supported: true,
  engine: "cef",
  downloadEvents: true,
  downloadPause: true,
  permissionRequests: true,
};
const BOUNDS = { x: 0, y: 0, width: 10, height: 10 };

/** A window controller over a fake window, with app folders and picked paths. */
function controller(opts: {
  caps?: Record<string, unknown>;
  viewClass?: unknown;
  dirs?: { data: string; cache: string; documents: string };
  picked?: PickedPaths;
  revealPath?: (path: string) => Promise<void>;
} = {}) {
  const made: FakeView[] = [];
  const win = Object.assign(new EventTarget(), {
    createWebView: (o: Record<string, unknown>) => {
      const v = new FakeView(o);
      made.push(v);
      return v;
    },
  });
  const emits: Array<{ event: string; data: unknown }> = [];
  const c = createWindowController({
    window: win,
    api: { webViewCapabilities: () => opts.caps ?? CAPS } as unknown as DesktopAppApi,
    emit: (_cap, event, data) => void emits.push({ event, data }),
    exit: () => {},
    webViewClass: opts.viewClass ?? FakeView,
    appOrigins: () => [],
    ...(opts.dirs ? { dirs: opts.dirs } : {}),
    ...(opts.picked ? { picked: opts.picked } : {}),
    ...(opts.revealPath ? { revealPath: opts.revealPath } : {}),
  });
  const call = async (method: string, args: unknown) =>
    await c.capability.methods[method].handler(args, {} as DesktopCapCtx);
  return { c, call, made, emits, win };
}

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

/** Temporary app folders (removed after `fn`). */
async function withDirs(
  fn: (dirs: { data: string; cache: string; documents: string }, root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const dirs = {
    data: join(root, "data"),
    cache: join(root, "cache"),
    documents: join(root, "docs"),
  };
  try {
    await fn(dirs, root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test('web view media: downloads / permissions "app" reach the runtime where it reports them', async () => {
  const { call, made } = controller();
  await call("webViewCreate", {
    options: { url: "https://a.example", bounds: BOUNDS, downloads: "app", permissions: "app" },
  });
  assertEquals([made[0].options.downloads, made[0].options.permissions], ["app", "app"]);
  await call("webViewCreate", {
    options: { url: "https://a.example", bounds: BOUNDS, permissions: { prompts: "app" } },
  });
  assertEquals(made[1].options.permissions, "app");
  assertEquals(
    await call("webViewCapabilities", {}) as Record<string, unknown>,
    {
      ...(await call("webViewCapabilities", {}) as Record<string, unknown>),
      downloadEvents: true,
      downloadPause: true,
      permissionRequests: true,
    },
  );
  // An engine without them, or a runtime without the members: unsupported, nothing created.
  for (
    const c of [
      controller({ caps: { ...CAPS, downloadEvents: false, permissionRequests: false } }),
      controller({ viewClass: OldView }),
    ]
  ) {
    const caps = await c.call("webViewCapabilities", {}) as Record<string, unknown>;
    assertEquals([caps.downloadEvents, caps.downloadPause, caps.permissionRequests], [
      false,
      false,
      false,
    ]);
    for (const extra of [{ downloads: "app" }, { permissions: "app" }]) {
      const err = await rejection(() =>
        c.call("webViewCreate", { options: { url: "https://a.example", bounds: BOUNDS, ...extra } })
      );
      assertEquals(err.code, "unsupported");
    }
    assertEquals(c.made.length, 0);
  }
});

Deno.test("web view media: the page's download calls are checked; save goes to a confined path", async () => {
  await withDirs(async (dirs, root) => {
    const picked = new PickedPaths();
    const { call, made, emits } = controller({ dirs, picked });
    const { id } = await call("webViewCreate", {
      options: { url: "https://a.example", bounds: BOUNDS, downloads: "app" },
    }) as { id: string };
    const v = made[0];
    v.download({ id: 7, state: "requested", receivedBytes: 0 });
    assertEquals(emits.at(-1), {
      event: "webview",
      data: {
        id,
        event: "download",
        detail: {
          id: 7,
          state: "requested",
          receivedBytes: 0,
          url: "https://a.example/f.zip",
          filename: "f.zip",
        },
      },
    });
    const ctl = (args: Record<string, unknown>) =>
      call("webViewCall", { id, method: "controlDownload", args });
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ download: "7", action: "cancel" }, "validation"],
      [{ download: -1, action: "cancel" }, "validation"],
      [{ download: 7, action: "open" }, "validation"],
      [{ download: 7, action: "cancel", target: { directory: "data", path: "x" } }, "validation"],
      [{ download: 7, action: "save", target: "/etc/passwd" }, "validation"],
      [
        { download: 7, action: "save", target: { directory: "data", path: "/etc/passwd" } },
        "validation",
      ],
      [{ download: 7, action: "save", target: { directory: "home", path: "x" } }, "validation"],
      [{ download: 7, action: "save", target: { directory: "data", path: "" } }, "validation"],
      [
        { download: 7, action: "save", target: { directory: "data", path: "../out.zip" } },
        "forbidden",
      ],
      [
        { download: 7, action: "save", target: { directory: "data", path: "CEF/Cookies" } },
        "forbidden",
      ],
      [
        { download: 7, action: "save", target: { directory: { picked: "forged" }, path: "" } },
        "forbidden",
      ],
    ];
    for (const [args, code] of bad) {
      assertEquals((await rejection(() => ctl(args))).code, code, JSON.stringify(args));
    }
    assertEquals(v.calls, []);
    // An app folder: the path under it, its folders made.
    await ctl({ download: 7, action: "save", target: { directory: "cache", path: "dl/f.zip" } });
    assertEquals(v.calls.at(-1), ["controlDownload", 7, "save", join(dirs.cache, "dl", "f.zip")]);
    assert((await Deno.stat(join(dirs.cache, "dl"))).isDirectory);
    // A picked file (saveFile: read-write) is the file itself; a picked folder takes a path in it.
    const file = picked.add(join(root, "chosen.zip"), "readwrite");
    await ctl({ download: 7, action: "save", target: { directory: { picked: file }, path: "" } });
    assertEquals(v.calls.at(-1), ["controlDownload", 7, "save", join(root, "chosen.zip")]);
    await Deno.mkdir(join(root, "folder"));
    const folder = picked.add(join(root, "folder"), "folder");
    await ctl({
      download: 7,
      action: "save",
      target: { directory: { picked: folder }, path: "a/b.zip" },
    });
    assertEquals(v.calls.at(-1), [
      "controlDownload",
      7,
      "save",
      join(root, "folder", "a", "b.zip"),
    ]);
    for (const path of ["", "../x"]) {
      const err = await rejection(() =>
        ctl({ download: 7, action: "save", target: { directory: { picked: folder }, path } })
      );
      assert(err.code === "validation" || err.code === "forbidden", path);
    }
    const readOnly = picked.add(join(root, "dropped.zip"), "read");
    assertEquals(
      (await rejection(() =>
        ctl({ download: 7, action: "save", target: { directory: { picked: readOnly }, path: "" } })
      )).code,
      "forbidden",
    );
    // The other actions pass through; the runtime's refusal maps (invalid → validation).
    for (const action of ["saveAs", "pause", "resume", "cancel"]) {
      await ctl({ download: 7, action });
    }
    assertEquals(v.calls.slice(-4).map((c) => c[2]), ["saveAs", "pause", "resume", "cancel"]);
    v.failWith = "invalid";
    assertEquals(
      (await rejection(() => ctl({ download: 7, action: "cancel" }))).code,
      "validation",
    );
    // The permission answer.
    const answer = (args: unknown) =>
      call("webViewCall", { id, method: "respondToPermissionRequest", args });
    assertEquals((await rejection(() => answer({ request: 1, allow: "yes" }))).code, "validation");
    assertEquals((await rejection(() => answer({ request: 1.5, allow: true }))).code, "validation");
    await answer({ request: 3, allow: true });
    assertEquals(v.calls.at(-1), ["respond", 3, true]);
  });
  // Without app folders or picked paths wired, a page save names nothing it may write.
  const bare = controller();
  const { id } = await bare.call("webViewCreate", {
    options: { url: "https://a.example", bounds: BOUNDS, downloads: "app" },
  }) as { id: string };
  const err = await rejection(() =>
    bare.call("webViewCall", {
      id,
      method: "controlDownload",
      args: { download: 1, action: "save", target: { directory: "data", path: "x" } },
    })
  );
  assertEquals(err.code, "validation");
});

Deno.test("web view media: an older runtime's view answers unsupported to the decisions", async () => {
  const { call, made } = controller();
  const { id } = await call("webViewCreate", {
    options: { url: "https://a.example", bounds: BOUNDS },
  }) as { id: string };
  Object.defineProperty(made[0], "controlDownload", { value: undefined });
  Object.defineProperty(made[0], "respondToPermissionRequest", { value: undefined });
  for (
    const [method, args] of [
      ["controlDownload", { download: 1, action: "cancel" }],
      ["respondToPermissionRequest", { request: 1, allow: false }],
    ] as const
  ) {
    assertEquals(
      (await rejection(() => call("webViewCall", { id, method, args }))).code,
      "unsupported",
    );
  }
});

Deno.test("web view media: a page load settles what its page left waiting, nothing else", async () => {
  const { c, call, made } = controller();
  const { id } = await call("webViewCreate", {
    options: { url: "https://a.example", bounds: BOUNDS, downloads: "app", permissions: "app" },
  }) as { id: string };
  const v = made[0];
  // desktop.ts's own view is its handle's business, not the page's.
  const own = await c.createWebView({ url: "https://b.example", bounds: BOUNDS, downloads: "app" });
  own.on("will-download", () => {});
  made[1].download({ id: 50, state: "requested", receivedBytes: 0 });
  v.download({ id: 1, state: "requested", receivedBytes: 0 }); // waiting
  v.download({ id: 2, state: "requested", receivedBytes: 0 });
  await call("webViewCall", {
    id,
    method: "controlDownload",
    args: { download: 2, action: "saveAs" },
  });
  v.download({ id: 3, state: "requested", receivedBytes: 0 });
  v.download({ id: 3, state: "progressing", receivedBytes: 5 }); // decided (it runs)
  v.fire("permission-request", {
    id: 10,
    state: "requested",
    origin: "https://a.example",
    permissions: ["camera"],
  });
  v.fire("permission-request", {
    id: 11,
    state: "requested",
    origin: "https://a.example",
    permissions: ["camera"],
  });
  v.fire("permission-request", { id: 11, state: "cancelled" });
  v.fire("permission-request", {
    id: 12,
    state: "requested",
    origin: "https://a.example",
    permissions: [],
  });
  await call("webViewCall", {
    id,
    method: "respondToPermissionRequest",
    args: { request: 12, allow: true },
  });
  v.calls.length = 0;
  await c.capability.onPageLoad!();
  assertEquals(v.calls, [["controlDownload", 1, "cancel"], ["respond", 10, false]]);
  assertEquals(made[1].calls, []);
  // Once only.
  await c.capability.onPageLoad!();
  assertEquals(v.calls.length, 2);
  // A runtime that throws (over already) is fine; a closed view is skipped.
  v.download({ id: 4, state: "requested", receivedBytes: 0 });
  v.failWith = "invalid";
  await c.capability.onPageLoad!();
  v.download({ id: 5, state: "requested", receivedBytes: 0 });
  v.close();
  await c.capability.onPageLoad!();
  assertEquals(v.calls.length, 2);
  await own.close();
});

/** desktop.ts's handle over a fresh controller (with `reveal` recorded). */
async function backendView(opts: { answerMs?: number } = {}) {
  const revealed: string[] = [];
  const made: FakeView[] = [];
  const win = Object.assign(new EventTarget(), {
    createWebView: (o: Record<string, unknown>) => {
      const v = new FakeView(o);
      made.push(v);
      return v;
    },
  });
  const { createWebViewHost } = await import("../src/desktop/caps/webview.ts");
  const host = createWebViewHost({
    window: win as never,
    api: { webViewCapabilities: () => CAPS },
    emit: () => {},
    webViewClass: FakeView,
    revealPath: (p) => (revealed.push(p), Promise.resolve()),
    ...(opts.answerMs !== undefined ? { answerMs: opts.answerMs } : {}),
  });
  const view = await host.create({
    url: "https://a.example",
    bounds: BOUNDS,
    downloads: "app",
    permissions: "app",
  });
  return { view, v: made[0], revealed, host };
}

Deno.test("web view media: desktop.ts's item — once per download, updated, done once, save takes an absolute path", async () => {
  const { view, v, revealed } = await backendView();
  const items: WebViewDownloadItem[] = [];
  const raw: unknown[] = [];
  view.on("download", (e) => raw.push(e.state));
  view.on("will-download", (item) => items.push(item));
  v.download({
    id: 1,
    state: "requested",
    receivedBytes: 0,
    totalBytes: 100,
    mimeType: "application/zip",
  });
  v.download({ id: 1, state: "requested", receivedBytes: 0 }); // a repeat: no second item
  assertEquals(items.length, 1);
  const item = items[0];
  assertEquals(
    [
      item.id,
      item.url,
      item.filename,
      item.mimeType,
      item.totalBytes,
      item.state,
      item.receivedBytes,
    ],
    [1, "https://a.example/f.zip", "f.zip", "application/zip", 100, "requested", 0],
  );
  assertEquals([item.path, item.paused, item.canResume], [undefined, false, false]);
  await assertRejects(() => item.reveal(), DesktopCapError, "no path");
  await assertRejects(() => item.save("relative/f.zip"), DesktopCapError, "absolute");
  await item.save("/tmp/f.zip");
  assertEquals(v.calls.at(-1), ["controlDownload", 1, "save", "/tmp/f.zip"]);
  const updates: Array<[string, number, boolean]> = [];
  const dones: WebViewDownloadDone[] = [];
  const stop = item.on("updated", (i) => updates.push([i.state, i.receivedBytes, i.paused]));
  item.on("done", (d) => dones.push(d));
  item.on("updated", () => {
    throw new Error("a broken listener stops nobody");
  });
  v.download({ id: 1, state: "progressing", receivedBytes: 10, path: "/tmp/f.zip" });
  await item.pause();
  v.download({ id: 1, state: "progressing", receivedBytes: 10, paused: true });
  await item.resume();
  v.download({ id: 1, state: "progressing", receivedBytes: 40 });
  assertEquals(updates, [["progressing", 10, false], ["progressing", 10, true], [
    "progressing",
    40,
    false,
  ]]);
  assertEquals(item.path, "/tmp/f.zip");
  await item.reveal();
  assertEquals(revealed, ["/tmp/f.zip"]);
  stop();
  // An interruption it can resume from is not the end.
  v.download({
    id: 1,
    state: "interrupted",
    receivedBytes: 40,
    canResume: true,
    reason: "network",
  });
  assertEquals([item.state, item.canResume, dones.length], ["interrupted", true, 0]);
  v.download({ id: 1, state: "completed", receivedBytes: 100, path: "/tmp/f.zip" });
  v.download({ id: 1, state: "completed", receivedBytes: 100 }); // after the end: nothing
  assertEquals(dones, [{ state: "completed", reason: "network", path: "/tmp/f.zip" }]);
  assertEquals(item.on("done", () => {})(), undefined, "subscribing after the end is a no-op");
  await item.saveAs();
  await item.cancel();
  assertEquals(raw, [
    "requested",
    "requested",
    "progressing",
    "progressing",
    "progressing",
    "interrupted",
    "completed",
    "completed",
  ]);
  // A download nothing listens for is cancelled at once; an interruption without resume ends it.
  const bare = await backendView();
  bare.v.download({ id: 9, state: "requested", receivedBytes: 0 });
  assertEquals(bare.v.calls, [["controlDownload", 9, "cancel"]]);
  bare.v.download({ id: 9, state: "cancelled", receivedBytes: 0 });
  const ended: WebViewDownloadDone[] = [];
  bare.view.on("will-download", (i) => i.on("done", (d) => ended.push(d)));
  bare.v.download({ id: 10, state: "requested", receivedBytes: 0 });
  bare.v.download({ id: 10, state: "interrupted", receivedBytes: 3, reason: "server" });
  assertEquals(ended, [{ state: "interrupted", reason: "server" }]);
  // Malformed events are ignored.
  bare.v.fire("download", { id: "x", state: "requested" });
  bare.v.fire("download", { id: 11, state: "weird" });
  bare.v.fire("download", "not json");
  assertEquals(downloadEventOf(null), null);
});

Deno.test("web view media: the view closing ends its downloads (done: cancelled) and drops its requests", async () => {
  const { view, v } = await backendView({ answerMs: 60_000 });
  const done: WebViewDownloadDone[] = [];
  const order: string[] = [];
  view.on("will-download", (i) => i.on("done", (d) => (done.push(d), order.push("done"))));
  view.on("closed", () => order.push("closed"));
  v.download({ id: 1, state: "requested", receivedBytes: 0 });
  v.download({ id: 2, state: "requested", receivedBytes: 0 });
  v.download({ id: 2, state: "interrupted", receivedBytes: 1, canResume: true });
  let answered = false;
  view.setPermissionRequestHandler(() => new Promise(() => {})); // never answers
  v.fire("permission-request", {
    id: 5,
    state: "requested",
    origin: "https://a.example",
    permissions: ["camera"],
  });
  await view.close();
  assertEquals(done, [{ state: "cancelled" }, { state: "cancelled" }]);
  assertEquals(order, ["done", "done", "closed"]);
  answered = v.calls.some((c) => c[0] === "respond");
  assertEquals(answered, false, "no late answer, and its 60 s timer is gone (no leak)");
});

Deno.test("web view media: the permission handler — allow, refuse, throw, reject, time out, none, cancelled", async () => {
  const { view, v } = await backendView({ answerMs: 30 });
  const ask = (id: number) =>
    v.fire("permission-request", {
      id,
      state: "requested",
      origin: "https://a.example",
      permissions: ["camera", 7],
      frame: { isMain: false, origin: "https://ads.example" },
    });
  const answers = () => v.calls.filter((c) => c[0] === "respond").map((c) => [c[1], c[2]]);
  // No handler: refused at once.
  ask(1);
  assertEquals(answers(), [[1, false]]);
  const seen: unknown[] = [];
  const raw: unknown[] = [];
  const timeouts: unknown[] = [];
  view.on("permission-request", (e) => {
    raw.push(e.state);
    if (e.state === "cancelled" && e.reason === "timeout") timeouts.push(e.id);
  });
  view.setPermissionRequestHandler((req) => {
    seen.push(req);
    if (req.id === 2) return true;
    if (req.id === 3) return false;
    if (req.id === 4) throw new Error("boom");
    if (req.id === 5) return Promise.reject(new Error("no"));
    if (req.id === 6) return "yes" as unknown as boolean;
    if (req.id === 9) return Promise.resolve(true);
    return new Promise(() => {}); // 7, 8: never
  });
  for (const id of [2, 3, 4, 5, 6]) ask(id);
  await until(() => answers().length === 6);
  // Each settles on its own turn (a rejection takes longer): compare by id.
  assertEquals(
    answers().slice(1).sort((a, b) => (a[0] as number) - (b[0] as number)),
    [[2, true], [3, false], [4, false], [5, false], [6, false]],
  );
  assertEquals(seen[0], {
    id: 2,
    origin: "https://a.example",
    permissions: ["camera"],
    frame: { isMain: false, origin: "https://ads.example" },
  });
  // No answer in time: refused, and a cancelled event names the time limit.
  assertEquals(timeouts, []);
  ask(7);
  await until(() => answers().length === 7);
  assertEquals(answers().at(-1), [7, false]);
  await until(() => timeouts.length === 1);
  assertEquals(timeouts, [7]);
  // Cancelled before the answer: the answer is dropped.
  let release: ((v: boolean) => void) | undefined;
  view.setPermissionRequestHandler(() => new Promise<boolean>((r) => (release = r)));
  ask(8);
  ask(8); // a repeat of a pending request is ignored
  await until(() => release !== undefined);
  v.fire("permission-request", { id: 8, state: "cancelled" });
  release!(true);
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(answers().length, 7);
  // A request the runtime cancelled is no timeout: no second cancelled event of denext's own.
  assertEquals(timeouts, [7]);
  // Malformed requests are ignored; null removes the handler.
  v.fire("permission-request", { id: 20, state: "requested" });
  v.fire("permission-request", { state: "requested" });
  view.setPermissionRequestHandler(null);
  ask(21);
  assertEquals(answers().at(-1), [21, false]);
  assert(raw.includes("cancelled"));
  await view.close();
});

Deno.test("web view media: the media core on its own (a runtime answer that fails is swallowed)", async () => {
  const fired: string[] = [];
  const m = createWebViewMedia({
    control: () => Promise.reject(new Error("over")),
    respond: () => Promise.reject(new Error("cancelled")),
    reveal: () => Promise.resolve(),
    hasListeners: () => false,
    fire: (e) => void fired.push(e),
    fail: (code, message) => Object.assign(new Error(message), { code }),
    onListenerError: () => {},
  });
  m.download({ id: 1, state: "requested", url: "u", filename: "f", receivedBytes: 0 });
  m.download({ id: 1, state: "progressing", receivedBytes: 1 }); // untracked: ignored
  m.permissionRequest({ id: 1, state: "requested", origin: "o", permissions: [] });
  m.permissionRequest("junk");
  m.closed();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(fired, []);
});

Deno.test("web view media: a request the handler leaves unanswered fires cancelled with reason timeout", async () => {
  const fired: Array<[string, unknown]> = [];
  const responded: Array<[number, boolean]> = [];
  const m = createWebViewMedia({
    control: () => Promise.resolve(),
    respond: (id, allow) => (responded.push([id, allow]), Promise.resolve()),
    reveal: () => Promise.resolve(),
    hasListeners: () => true,
    fire: (e, d) => void fired.push([e, d]),
    fail: (code, message) => Object.assign(new Error(message), { code }),
    onListenerError: () => {},
    answerMs: 20,
  });
  m.setPermissionRequestHandler((req) => req.id === 1 ? true : new Promise(() => {}));
  m.permissionRequest({ id: 1, state: "requested", origin: "o", permissions: ["camera"] });
  m.permissionRequest({ id: 2, state: "requested", origin: "o", permissions: ["camera"] });
  await until(() => responded.length === 2);
  assertEquals(responded, [[1, true], [2, false]]);
  assertEquals(fired, [["permission-request", { id: 2, state: "cancelled", reason: "timeout" }]]);
  m.closed();
});

// ---------------------------------------------------------------------------------------------
// Page side, end to end through the fake bridge to a real controller
// ---------------------------------------------------------------------------------------------

Deno.test("web view media page: will-download, save to an app folder, reveal, permission handler, close", async () => {
  await withDirs(async (dirs) => {
    const shell: unknown[] = [];
    const ctl = controller({ dirs, revealPath: (path) => (shell.push(path), Promise.resolve()) });
    const methods: Record<string, FakeMethod> = {};
    for (const name of ["webViewCapabilities", "webViewCreate", "webViewCall"]) {
      methods[name] = (args) => ctl.call(name, args);
    }
    const rt = createFakeDesktopRuntime({ window: methods });
    const forward = ctl.emits.push.bind(ctl.emits);
    ctl.emits.push = (...items) => {
      for (const e of items) rt.emit("window", e.event, e.data);
      return forward(...items);
    };
    const restore = rt.install();
    try {
      const view: WebViewHandle = await createWebView({
        url: "https://a.example",
        bounds: BOUNDS,
        downloads: "app",
        permissions: "app",
      });
      const v = ctl.made[0];
      // No will-download listener: the page cancels it.
      v.download({ id: 1, state: "requested", receivedBytes: 0 });
      await until(() => v.calls.length === 1);
      assertEquals(v.calls[0], ["controlDownload", 1, "cancel"]);
      const items: WebViewDownloadItem[] = [];
      const raw: unknown[] = [];
      view.on("will-download", (i) => items.push(i));
      view.on("download", (e) => raw.push([e.id, e.state]));
      v.download({ id: 2, state: "requested", receivedBytes: 0 });
      await until(() => items.length === 1);
      const item = items[0];
      const err = await assertRejects(() => item.save("/etc/passwd"));
      assert(isDesktopBridgeError(err) && err.code === "validation");
      await item.save({ directory: "documents", path: "f.zip" });
      assertEquals(v.calls.at(-1), ["controlDownload", 2, "save", join(dirs.documents, "f.zip")]);
      const notYet = await assertRejects(() => item.reveal());
      assert(isDesktopBridgeError(notYet) && notYet.code === "not_found");
      const dones: WebViewDownloadDone[] = [];
      item.on("done", (d) => dones.push(d));
      v.download({
        id: 2,
        state: "completed",
        receivedBytes: 9,
        path: join(dirs.documents, "f.zip"),
      });
      await until(() => dones.length === 1);
      await item.reveal();
      assertEquals(shell, [join(dirs.documents, "f.zip")]);
      // Saved through saveAs() to a place of the user's choosing (outside every app folder): its
      // own file is revealed, the item being the capability.
      v.download({ id: 3, state: "requested", receivedBytes: 0 });
      await until(() => items.length === 2);
      await items[1].saveAs();
      v.download({ id: 3, state: "completed", receivedBytes: 1, path: "/Users/u/Desktop/f.zip" });
      await until(() => items[1].path === "/Users/u/Desktop/f.zip");
      await items[1].reveal();
      assertEquals(shell.at(-1), "/Users/u/Desktop/f.zip");
      // Any other path is refused, and so is a download with no file or one the view never had.
      const other = await rejection(() =>
        ctl.call("webViewCall", {
          id: String(v.id),
          method: "revealDownload",
          args: { download: 3, path: "/etc/passwd" },
        })
      );
      assertEquals(other.code, "forbidden");
      const unknown = await rejection(() =>
        ctl.call("webViewCall", {
          id: String(v.id),
          method: "revealDownload",
          args: { download: 99, path: "/Users/u/Desktop/f.zip" },
        })
      );
      assertEquals(unknown.code, "not_found");
      const bad = await rejection(() =>
        ctl.call("webViewCall", {
          id: String(v.id),
          method: "revealDownload",
          args: { download: 3 },
        })
      );
      assertEquals(bad.code, "validation");
      assertEquals(shell.length, 2);
      // The permission handler, through the wire.
      view.setPermissionRequestHandler((req) => req.permissions.includes("microphone"));
      v.fire("permission-request", {
        id: 4,
        state: "requested",
        origin: "https://a.example",
        permissions: ["microphone"],
      });
      v.fire("permission-request", {
        id: 5,
        state: "requested",
        origin: "https://a.example",
        permissions: ["camera"],
      });
      await until(() => v.calls.filter((c) => c[0] === "respond").length === 2);
      assertEquals(v.calls.filter((c) => c[0] === "respond"), [["respond", 4, true], [
        "respond",
        5,
        false,
      ]]);
      // A running download ends cancelled when the view closes.
      v.download({ id: 6, state: "requested", receivedBytes: 0 });
      await until(() => items.length === 3);
      const last: WebViewDownloadDone[] = [];
      items[2].on("done", (d) => last.push(d));
      await view.close();
      assertEquals(last, [{ state: "cancelled" }]);
      await rt.settled();
      assert(raw.length >= 3);
    } finally {
      resetWebViewsForTesting();
      resetDesktopBridgeForTesting();
      restore();
    }
  });
});
