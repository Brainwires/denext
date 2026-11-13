// An extension's process-level host (`DesktopCapability.setup`) and `pickedPath`
// (src/desktop/bridge.ts): the host's emit streams to the page with no page call in flight, is
// scoped to the capability's declared events, keeps events until the page subscribes and can
// target one window; `pickedPath` resolves only a handle a dialog produced in this launch, never a
// string the page made up. Driven through `bridge.handle` with constructed Requests.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createDesktopBridge } from "../src/desktop/bridge.ts";
import {
  type DesktopCapability,
  DesktopCapError,
  type DesktopExtensionHost,
} from "../src/desktop/extension.ts";
import { dialogsCapability } from "../src/desktop/caps/dialogs.ts";
import { PickedPaths } from "../src/desktop/picked-paths.ts";
import type { DesktopWindowRef } from "../src/desktop/app-windows.ts";

const ORIGIN = "http://127.0.0.1:8000";
const TOKEN = "test-token-1234";

function rpc(body: unknown): Request {
  return new Request(`${ORIGIN}/_denext/desktop/rpc`, {
    method: "POST",
    headers: {
      "x-denext-desktop-token": TOKEN,
      origin: ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function call(
  bridge: ReturnType<typeof createDesktopBridge>,
  body: unknown,
): Promise<{ status: number; ok?: boolean; data?: unknown; code?: string }> {
  const req = rpc(body);
  const res = await bridge.handle(req, new URL(req.url), TOKEN);
  assert(res !== null);
  const env = await res.json();
  return { status: res.status, ok: env.ok, data: env.data, code: env.error?.code };
}

/** Read `max` SSE data frames from `window`'s event stream, then cancel it. */
async function frames(
  bridge: ReturnType<typeof createDesktopBridge>,
  max: number,
  window = "main",
): Promise<unknown[]> {
  const reader = bridge.events.open(null, window).getReader();
  const decoder = new TextDecoder();
  const out: unknown[] = [];
  let buf = "";
  try {
    while (out.length < max) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? ""; // a partial line waits for the rest
      for (const line of lines) if (line.startsWith("data: ")) out.push(JSON.parse(line.slice(6)));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.slice(0, max);
}

Deno.test("setup: an extension's host is handed over once, before any page call", () => {
  const hosts: DesktopExtensionHost[] = [];
  const ext: DesktopCapability = {
    name: "jobs",
    events: ["progress"],
    methods: {},
    setup: (host) => void hosts.push(host),
  };
  createDesktopBridge([ext], { appSupportDir: "/data" });
  assertEquals(hosts.length, 1);
  assertEquals(hosts[0].appSupportDir, "/data");
  assertEquals(hosts[0].os, Deno.build.os);
});

Deno.test("setup: the host's emit reaches a page that subscribes later, with no page call", async () => {
  let host: DesktopExtensionHost | undefined;
  const ext: DesktopCapability = {
    name: "jobs",
    events: ["progress"],
    methods: {},
    setup: (h) => (host = h),
  };
  const bridge = createDesktopBridge([ext]);
  // Work desktop.ts started on its own (a tray item): nobody called the extension.
  host!.emit("progress", { percent: 10 });
  host!.emit("progress", { percent: 20 });
  assertEquals(await frames(bridge, 2), [
    { cap: "jobs", event: "progress", data: { percent: 10 } },
    { cap: "jobs", event: "progress", data: { percent: 20 } },
  ]);
});

Deno.test("setup: the host's emit is scoped to the declared events", () => {
  let host: DesktopExtensionHost | undefined;
  createDesktopBridge([{
    name: "jobs",
    events: ["progress"],
    methods: {},
    setup: (h) => (host = h),
  }]);
  assertThrows(() => host!.emit("other", 1), Error, 'emitted undeclared event "other"');
});

Deno.test("setup: an event for one window reaches only that window's stream", async () => {
  let host: DesktopExtensionHost | undefined;
  const bridge = createDesktopBridge([{
    name: "jobs",
    events: ["progress"],
    methods: {},
    setup: (h) => (host = h),
  }]);
  host!.emit("progress", "panel only", { window: "panel" });
  host!.emit("progress", "everyone");
  assertEquals(await frames(bridge, 1, "main"), [{
    cap: "jobs",
    event: "progress",
    data: "everyone",
  }]);
  assertEquals((await frames(bridge, 2, "panel")).map((f) => (f as { data: unknown }).data), [
    "panel only",
    "everyone",
  ]);
});

Deno.test("setup: the host's confirm is refused as unsupported on a runtime without message boxes", async () => {
  let host: DesktopExtensionHost | undefined;
  createDesktopBridge([{ name: "guard", methods: {}, setup: (h) => void (host = h) }]);
  assert(host);
  // This process has no Deno.desktop (and the pinned runtime predates showMessageBox).
  const err = await assertRejects(
    () => host!.confirm({ message: "Quit anyway?", buttons: ["Quit", "Cancel"], cancelId: 1 }),
    DesktopCapError,
  );
  assertEquals([err.code, err.status], ["unsupported", 501]);
});

Deno.test("setup: the host's confirm box goes through the lifecycle (the quit guards' deadline pauses for it)", async () => {
  const boxes: Promise<unknown>[] = [];
  const owners: unknown[] = [];
  let host: DesktopExtensionHost | undefined;
  createDesktopBridge([{ name: "guard", methods: {}, setup: (h) => void (host = h) }], {
    lifecycle: {
      onWindowOpened: () => () => {},
      onWindowClosed: () => () => {},
      onAppQuit: () => () => {},
      onBeforeQuit: (_fn, owner) => (owners.push(["guard", owner]), () => {}),
      windows: () => [],
      requestQuit: (owner) => (owners.push(["quit", owner]), Promise.resolve(true)),
      whileGuardAsks: (box) => (boxes.push(box), box),
    },
  });
  const asked = host!.confirm({ message: "Quit anyway?" });
  assertEquals(boxes.length, 1, "the box was handed to whileGuardAsks");
  await assertRejects(() => asked, DesktopCapError); // no message boxes in this process
  // The guards and the quit carry the capability as their owner.
  host!.onBeforeQuit(() => true);
  assertEquals(await host!.quit(), true);
  assertEquals(owners, [["guard", "guard"], ["quit", "guard"]]);
  // Without a lifecycle (no window): quit resolves false, a menu subscription is kept by nobody.
  let bare: DesktopExtensionHost | undefined;
  createDesktopBridge([{ name: "x", methods: {}, setup: (h) => void (bare = h) }]);
  assertEquals(await bare!.quit(), false);
  bare!.onWindowMenuItem(() => {})();
});

Deno.test("setup: the host's onSecondInstance is desktop.ts's subscription, a no-op without it", () => {
  const subscribed: unknown[] = [];
  let unsubscribed = 0;
  let host: DesktopExtensionHost | undefined;
  createDesktopBridge([{ name: "single", methods: {}, setup: (h) => void (host = h) }], {
    onSecondInstance: (fn) => {
      subscribed.push(fn);
      return () => void unsubscribed++;
    },
  });
  const fn = () => {};
  const off = host!.onSecondInstance(fn);
  assertEquals(subscribed, [fn]);
  off();
  assertEquals(unsubscribed, 1);
  // No desktop runtime: kept by nobody.
  let bare: DesktopExtensionHost | undefined;
  createDesktopBridge([{ name: "x", methods: {}, setup: (h) => void (bare = h) }]);
  bare!.onSecondInstance(() => {})();
});

Deno.test("setup: the host's onNotificationClick is desktop.ts's subscription, a no-op without it", () => {
  const subscribed: unknown[] = [];
  let unsubscribed = 0;
  let host: DesktopExtensionHost | undefined;
  createDesktopBridge([{ name: "clicks", methods: {}, setup: (h) => void (host = h) }], {
    onNotificationClick: (fn) => {
      subscribed.push(fn);
      return () => void unsubscribed++;
    },
  });
  const fn = () => {};
  const off = host!.onNotificationClick(fn);
  assertEquals(subscribed, [fn]);
  off();
  assertEquals(unsubscribed, 1);
  // No desktop runtime: kept by nobody.
  let bare: DesktopExtensionHost | undefined;
  createDesktopBridge([{ name: "x", methods: {}, setup: (h) => void (bare = h) }]);
  bare!.onNotificationClick(() => {})();
});

Deno.test("setup: the host's openWindow is desktop.ts's windows.open, unsupported without it", () => {
  const opened: unknown[] = [];
  const ref = { id: "window-1", kind: "window" } as unknown as DesktopWindowRef;
  let host: DesktopExtensionHost | undefined;
  createDesktopBridge([{ name: "jobs", methods: {}, setup: (h) => void (host = h) }], {
    openWindow: (options) => {
      opened.push(options);
      return ref;
    },
  });
  assertEquals(host!.openWindow({ url: "/jobs", key: "jobs", width: 400 }), ref);
  assertEquals(opened, [{ url: "/jobs", key: "jobs", width: 400 }]);
  // No desktop runtime's windows: refused, not a silent no-op.
  let bare: DesktopExtensionHost | undefined;
  createDesktopBridge([{ name: "jobs", methods: {}, setup: (h) => void (bare = h) }]);
  const err = assertThrows(() => bare!.openWindow({ url: "/jobs" }), DesktopCapError);
  assertEquals(err.code, "unsupported");
});

Deno.test("setup: a throwing setup is logged and the bridge still serves", async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    const bridge = createDesktopBridge([{
      name: "bad",
      methods: { ping: { handler: () => "pong" } },
      setup: () => {
        throw new Error("boom");
      },
    }]);
    assertEquals((await call(bridge, { cap: "bad", method: "ping" })).data, "pong");
    assertEquals(errors.length, 1);
  } finally {
    console.error = original;
  }
});

Deno.test("ctx.emit: an event for one window skips the others", async () => {
  const bridge = createDesktopBridge([{
    name: "jobs",
    events: ["done"],
    methods: {
      finish: { handler: (_a, ctx) => (ctx.emit("done", 1, { window: "w1" }), true) },
    },
  }]);
  assertEquals((await call(bridge, { cap: "jobs", method: "finish" })).ok, true);
  assertEquals(await frames(bridge, 1, "w1"), [{ cap: "jobs", event: "done", data: 1 }]);
  bridge.emit("jobs", "marker", 0);
  assertEquals(await frames(bridge, 1, "main"), [{ cap: "jobs", event: "marker", data: 0 }]);
});

// --- pickedPath --------------------------------------------------------------

/** A bridge with the `dialogs` cap (its open dialog "chooses" `chosen`) and a `tool` extension. */
function pickingBridge(chosen: string, picked = new PickedPaths()) {
  const dialogs = dialogsCapability({
    picked,
    os: "darwin",
    api: null,
    run: () => Promise.resolve({ code: 0, stdout: chosen }),
  });
  const tool: DesktopCapability = {
    name: "tool",
    methods: {
      // What an extension does to hand the picked file to a host CLI: the path stays here.
      resolve: {
        handler: (args, ctx) => {
          const a = args as { handle?: unknown; write?: boolean };
          return { absolute: ctx.pickedPath(a.handle, { write: a.write === true }).length > 0 };
        },
      },
      pathOf: { handler: (args, ctx) => ctx.pickedPath((args as { handle?: unknown }).handle) },
    },
  };
  return createDesktopBridge([dialogs, tool], { pickedPaths: picked });
}

Deno.test("pickedPath: a handle the user picked resolves to the file's real path", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-picked-path-" });
  try {
    const file = `${dir}/disk.qcow2`;
    await Deno.writeTextFile(file, "x");
    const bridge = pickingBridge(file);
    const pick = await call(bridge, { cap: "dialogs", method: "openFile" });
    const handle = (pick.data as { files: Array<{ handle: string }> }).files[0].handle;
    const out = await call(bridge, { cap: "tool", method: "pathOf", args: { handle } });
    assertEquals(out.ok, true);
    assertEquals(out.data, await Deno.realPath(file));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pickedPath: a path string, a forged handle or a non-string is refused", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-picked-forged-" });
  try {
    const file = `${dir}/a.txt`;
    await Deno.writeTextFile(file, "x");
    const bridge = pickingBridge(file);
    // A real pick exists in this launch, so the refusals below are not just an empty set.
    await call(bridge, { cap: "dialogs", method: "openFile" });
    for (const handle of [file, "/etc/passwd", crypto.randomUUID(), "", { picked: file }, 1]) {
      const out = await call(bridge, { cap: "tool", method: "pathOf", args: { handle } });
      assertEquals([out.status, out.code], [403, "forbidden"], JSON.stringify(handle));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pickedPath: a read-only handle is refused for a write", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-picked-ro-" });
  try {
    const file = `${dir}/a.txt`;
    await Deno.writeTextFile(file, "x");
    const bridge = pickingBridge(file);
    const pick = await call(bridge, { cap: "dialogs", method: "openFile" });
    const handle = (pick.data as { files: Array<{ handle: string }> }).files[0].handle;
    assertEquals((await call(bridge, { cap: "tool", method: "resolve", args: { handle } })).data, {
      absolute: true,
    });
    const write = await call(bridge, {
      cap: "tool",
      method: "resolve",
      args: { handle, write: true },
    });
    assertEquals([write.status, write.code], [403, "forbidden"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pickedPath: without a picked-path set every handle is refused", () => {
  let host: DesktopExtensionHost | undefined;
  createDesktopBridge([{ name: "x", methods: {}, setup: (h) => (host = h) }]);
  const err = assertThrows(() => host!.pickedPath(crypto.randomUUID()), DesktopCapError);
  assertEquals(err.code, "forbidden");
});

Deno.test("PickedPaths.path: only issued handles, and read-only ones not for a write", () => {
  const picked = new PickedPaths();
  const ro = picked.add("/picked/file", "read");
  const rw = picked.add("/picked/folder", "folder");
  assertEquals(picked.path(ro), "/picked/file");
  assertEquals(picked.path(rw, true), "/picked/folder");
  assertThrows(() => picked.path(ro, true), DesktopCapError, "read-only");
  assertThrows(() => picked.path("/picked/file"), DesktopCapError, "unknown or expired");
  assertThrows(() => picked.path(undefined), DesktopCapError, "unknown or expired");
});
