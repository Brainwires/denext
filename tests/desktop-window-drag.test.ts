/**
 * The stacking order of the app's windows, the pointer and cross-window drag sessions
 * (`src/desktop/window-drag.ts`): against a fake `Deno.desktop`, a fake clock and a recorded
 * event stream.
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DesktopCapError } from "../src/desktop/extension.ts";
import type { DesktopAppApi } from "../src/desktop/launch-events.ts";
import { createWindowController } from "../src/desktop/caps/window.ts";
import { createWindowRegistry, type RegistryWindow } from "../src/desktop/window-registry.ts";
import {
  type DragSessionEvent,
  getPointer,
  getWindowOrder,
  onDragSession,
  startDragSession,
} from "../src/desktop/window.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { isDesktopBridgeError } from "../src/desktop/client.ts";
import { createFakeDesktopRuntime, until } from "./helpers/desktop-fake-runtime.ts";
import {
  createWindowStacking,
  type DragEvent,
  MAX_DATA_CHARS,
  MAX_SESSION_MS,
  type RuntimePointer,
  type StackingWindow,
} from "../src/desktop/window-drag.ts";

interface Rig {
  pointer: RuntimePointer | null | "throw";
  order: readonly number[] | null | "throw" | undefined;
  windows: StackingWindow[];
  focus: string[];
  sent: Array<[string, DragEvent]>;
  now: number;
  /** Run the sampling timer once (as the interval would). */
  tick(): void;
  intervals: number[];
  cleared: number;
  stacking: ReturnType<typeof createWindowStacking>;
}

function rig(options: { withoutApi?: boolean; withoutPointer?: boolean } = {}): Rig {
  let timer: (() => void) | undefined;
  let ids = 0;
  const r: Rig = {
    pointer: { x: 100, y: 100, buttons: 1, windowId: 11 },
    order: [12, 11],
    windows: [
      { id: "main", windowId: 11, innerPosition: () => [10, 40] },
      { id: "window-1", windowId: 12, innerPosition: () => [500, 60] },
      { id: "hidden", windowId: 13, visible: false },
    ],
    focus: ["main", "hidden", "window-1"],
    sent: [],
    now: 1_000,
    tick: () => timer?.(),
    intervals: [],
    cleared: 0,
    stacking: undefined as unknown as ReturnType<typeof createWindowStacking>,
  };
  const api = {
    ...(r.order === undefined ? {} : {
      windowOrder: () => {
        if (r.order === "throw") throw new Error("gone");
        return r.order as readonly number[] | null;
      },
    }),
    ...(options.withoutPointer ? {} : {
      pointer: () => {
        if (r.pointer === "throw") throw new Error("gone");
        return r.pointer;
      },
    }),
  };
  r.stacking = createWindowStacking({
    ...(options.withoutApi ? {} : { api }),
    windows: () => r.windows,
    focusOrder: () => r.focus,
    emit: (data, target) => r.sent.push([target, data]),
    setInterval: (fn, ms) => {
      timer = fn;
      r.intervals.push(ms);
      return 7;
    },
    clearInterval: (handle) => {
      assertEquals(handle, 7);
      timer = undefined;
      r.cleared++;
    },
    now: () => r.now,
    newId: () => `s${++ids}`,
  });
  return r;
}

/** The events sent, as `[target, type, extra…]`. */
const brief = (r: Rig) =>
  r.sent.map(([target, e]) =>
    [
      target,
      e.type,
      ...(e.window !== undefined ? [`window=${e.window}`] : []),
      ...(e.clientX !== undefined ? [`client=${e.clientX},${e.clientY}`] : []),
      ...(e.cancelled ? [`cancelled${e.reason ? `:${e.reason}` : ""}`] : []),
    ].join(" ")
  );

function code(fn: () => unknown): string {
  return assertThrows(fn, DesktopCapError).code;
}

Deno.test("order: the OS's stacking order, by the windows' own ids", () => {
  const r = rig();
  assertEquals(r.stacking.order(), { ids: ["window-1", "main"], source: "os" });
  // A window the registry does not know (closing) is skipped; a repeat counts once.
  r.order = [99, 11, 12, 11];
  assertEquals(r.stacking.order(), { ids: ["main", "window-1"], source: "os" });
  // Nothing on screen is still the OS's answer.
  r.order = [];
  assertEquals(r.stacking.order(), { ids: [], source: "os" });
});

Deno.test("order: the focus order where the OS does not tell", () => {
  // null (a Wayland session), a throw, and a runtime without the call.
  for (const order of [null, "throw"] as const) {
    const r = rig();
    r.order = order;
    // The windows that had the focus, most recent first, visible ones only.
    assertEquals(r.stacking.order(), { ids: ["main", "window-1"], source: "focus" });
    // A visible window that never had the focus comes last.
    r.focus = ["window-1"];
    assertEquals(r.stacking.order(), { ids: ["window-1", "main"], source: "focus" });
  }
  const none = rig({ withoutApi: true });
  assertEquals(none.stacking.order(), { ids: ["main", "window-1"], source: "focus" });
});

Deno.test("pointer: the screen position, the window under it and the page position", () => {
  const r = rig();
  assertEquals(r.stacking.pointer(), {
    x: 100,
    y: 100,
    buttons: 1,
    window: "main",
    clientX: 90,
    clientY: 60,
  });
  // Over nothing of the app's: no window, no page position.
  r.pointer = { x: -5, y: 2000, buttons: 0, windowId: null };
  assertEquals(r.stacking.pointer(), { x: -5, y: 2000, buttons: 0, window: null });
  // Over a window the registry does not know.
  r.pointer = { x: 1, y: 2, buttons: 4, windowId: 99 };
  assertEquals(r.stacking.pointer(), { x: 1, y: 2, buttons: 4, window: null });
  // A window whose page position the runtime cannot tell.
  r.pointer = { x: 1, y: 2, buttons: 0, windowId: 13 };
  assertEquals(r.stacking.pointer(), { x: 1, y: 2, buttons: 0, window: "hidden" });
});

Deno.test("pointer: unsupported where the OS does not tell", () => {
  const r = rig();
  r.pointer = null;
  assertEquals(code(() => r.stacking.pointer()), "unsupported");
  r.pointer = "throw";
  assertEquals(code(() => r.stacking.pointer()), "unsupported");
  r.pointer = { x: NaN, y: 0, buttons: 0, windowId: null };
  assertEquals(code(() => r.stacking.pointer()), "unsupported");
  assertEquals(code(() => rig({ withoutPointer: true }).stacking.pointer()), "unsupported");
  assertEquals(code(() => rig({ withoutApi: true }).stacking.pointer()), "unsupported");
});

Deno.test("drag: from one window to another, then a drop", () => {
  const r = rig();
  const data = { tab: "t1", nested: [1, 2] };
  const { session } = r.stacking.dragStart({ data }, "main");
  assertEquals(session, "s1");
  assertEquals(r.intervals, [16]);
  // The first sample is taken at once: the origin is under the pointer.
  assertEquals(brief(r), ["main enter client=90,60", "main move window=main"]);
  assertEquals(r.sent[0][1].data, data);
  // The data is a copy: a later change in the page's object is not what is delivered.
  data.tab = "changed";

  // Nothing changed: nothing is sent.
  r.sent.length = 0;
  r.tick();
  assertEquals(brief(r), []);

  // Within the origin.
  r.pointer = { x: 120, y: 110, buttons: 1, windowId: 11 };
  r.tick();
  assertEquals(brief(r), ["main over client=110,70", "main move window=main"]);

  // Out of every window of the app (over the desktop, or another app's window).
  r.sent.length = 0;
  r.pointer = { x: 300, y: 110, buttons: 1, windowId: null };
  r.tick();
  assertEquals(brief(r), ["main leave", "main move window=null"]);

  // Over the other window: it hears the pointer in ITS page.
  r.sent.length = 0;
  r.pointer = { x: 520, y: 100, buttons: 1, windowId: 12 };
  r.tick();
  assertEquals(brief(r), ["window-1 enter client=20,40", "main move window=window-1"]);
  assertEquals(r.sent[0][1].data, { tab: "t1", nested: [1, 2] });
  assertEquals(r.sent[0][1].origin, "main");

  // Released there: a drop for the window, the end for the origin, and the timer stops.
  r.sent.length = 0;
  r.pointer = { x: 530, y: 105, buttons: 0, windowId: 12 };
  r.tick();
  assertEquals(brief(r), [
    "window-1 over client=30,45",
    "main move window=window-1",
    "window-1 drop client=30,45",
    "main end window=window-1",
  ]);
  assertEquals(r.sent[2][1].data, { tab: "t1", nested: [1, 2] });
  assertEquals(r.cleared, 1);
  // Over: a late tick does nothing, and a new session may start.
  r.sent.length = 0;
  r.tick();
  assertEquals(brief(r), []);
  r.pointer = { x: 100, y: 100, buttons: 1, windowId: 11 };
  assertEquals(r.stacking.dragStart({}, "window-1").session, "s2");
});

Deno.test("drag: released outside the app drops on no window", () => {
  const r = rig();
  r.stacking.dragStart({ data: 1 }, "main");
  r.sent.length = 0;
  r.pointer = { x: 900, y: 900, buttons: 0, windowId: null };
  r.tick();
  assertEquals(brief(r), ["main leave", "main move window=null", "main end window=null"]);
  assertEquals(r.sent[2][1].cancelled, undefined);
});

Deno.test("drag: only the origin cancels; the window under the pointer leaves", () => {
  const r = rig();
  const { session } = r.stacking.dragStart({}, "main");
  r.pointer = { x: 520, y: 100, buttons: 1, windowId: 12 };
  r.tick();
  r.sent.length = 0;
  // Another window, a wrong id and no id cancel nothing (and say no more than that).
  assertEquals(r.stacking.dragCancel({ session }, "window-1"), { cancelled: false });
  assertEquals(r.stacking.dragCancel({ session: "nope" }, "main"), { cancelled: false });
  assertEquals(r.stacking.dragCancel(null, "main"), { cancelled: false });
  assertEquals(brief(r), []);
  assertEquals(r.stacking.dragCancel({ session }, "main"), { cancelled: true });
  assertEquals(brief(r), [
    "window-1 leave cancelled",
    "main end window=null cancelled:cancelled",
  ]);
  assertEquals(r.cleared, 1);
  // Cancelled once.
  assertEquals(r.stacking.dragCancel({ session }, "main"), { cancelled: false });
});

Deno.test("drag: a closed origin ends it; a closed target is forgotten", () => {
  const r = rig();
  r.stacking.dragStart({}, "main");
  r.pointer = { x: 520, y: 100, buttons: 1, windowId: 12 };
  r.tick();
  r.sent.length = 0;
  // The target closes: no `leave` for pages that are gone, and the session goes on.
  r.windows = r.windows.filter((w) => w.id !== "window-1");
  r.stacking.windowClosed("window-1");
  r.pointer = { x: 521, y: 100, buttons: 1, windowId: null };
  r.tick();
  assertEquals(brief(r), ["main move window=null"]);
  // An unrelated window closing changes nothing.
  r.stacking.windowClosed("hidden");
  // The origin closes: the session ends with nothing sent to its (gone) pages.
  r.sent.length = 0;
  r.stacking.windowClosed("main");
  assertEquals(brief(r), []);
  assertEquals(r.cleared, 1);
  // With no session, a close is a no-op.
  r.stacking.windowClosed("main");

  // The origin closes while the pointer is over another window: that one leaves.
  const b = rig();
  b.stacking.dragStart({}, "main");
  b.pointer = { x: 520, y: 100, buttons: 1, windowId: 12 };
  b.tick();
  b.sent.length = 0;
  b.stacking.windowClosed("main");
  assertEquals(brief(b), ["window-1 leave cancelled"]);
});

Deno.test("drag: it ends when the OS stops telling the pointer, and after ten minutes", () => {
  const r = rig();
  r.stacking.dragStart({}, "main");
  r.sent.length = 0;
  r.pointer = null;
  r.tick();
  assertEquals(brief(r), [
    "main leave cancelled",
    "main end window=null cancelled:unavailable",
  ]);
  assertEquals(r.cleared, 1);

  const t = rig();
  t.stacking.dragStart({}, "main");
  t.sent.length = 0;
  t.now += MAX_SESSION_MS;
  t.tick();
  assertEquals(brief(t), []);
  t.now += 1;
  t.tick();
  assertEquals(brief(t), ["main leave cancelled", "main end window=null cancelled:timeout"]);
});

Deno.test("drag: what is refused", () => {
  const r = rig();
  // One session at a time.
  r.stacking.dragStart({}, "main");
  assertEquals(code(() => r.stacking.dragStart({}, "window-1")), "conflict");
  r.stacking.stop();
  assertEquals(r.cleared, 1);
  r.stacking.stop();

  // No button held.
  r.pointer = { x: 1, y: 1, buttons: 0, windowId: 11 };
  assertEquals(code(() => r.stacking.dragStart({}, "main")), "not_dragging");
  // Only the secondary button.
  r.pointer = { x: 1, y: 1, buttons: 2, windowId: 11 };
  assertEquals(code(() => r.stacking.dragStart({}, "main")), "not_dragging");
  // The OS does not tell.
  r.pointer = null;
  assertEquals(code(() => r.stacking.dragStart({}, "main")), "unsupported");
  r.pointer = { x: 1, y: 1, buttons: 1, windowId: 11 };
  // A window the registry does not know.
  assertEquals(code(() => r.stacking.dragStart({}, "ghost")), "not_found");
  // The interval, and the data.
  for (const intervalMs of [7, 101, NaN, "16", null]) {
    assertEquals(code(() => r.stacking.dragStart({ intervalMs }, "main")), "validation");
  }
  assertEquals(
    code(() => r.stacking.dragStart({ data: "x".repeat(MAX_DATA_CHARS) }, "main")),
    "validation",
  );
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assertEquals(code(() => r.stacking.dragStart({ data: loop }, "main")), "validation");
  assertEquals(code(() => r.stacking.dragStart({ data: () => 1 }, "main")), "validation");
  // None of the refusals started a timer or sent anything.
  assertEquals(r.intervals.length, 1);
  // The largest data that fits, a custom interval, and no arguments at all.
  r.stacking.dragStart({ data: "x".repeat(MAX_DATA_CHARS - 2), intervalMs: 8 }, "main");
  assertEquals(r.intervals, [16, 8]);
  r.stacking.stop();
  r.stacking.dragStart(undefined, "main");
  assertEquals(r.sent.at(-2)?.[1].data, null);
});

Deno.test("drag: a window whose page position is unknown gets the event without it", () => {
  const r = rig();
  r.windows[1] = {
    id: "window-1",
    windowId: 12,
    innerPosition: () => {
      throw new Error("closing");
    },
  };
  r.stacking.dragStart({}, "main");
  r.sent.length = 0;
  r.pointer = { x: 520, y: 100, buttons: 1, windowId: 12 };
  r.tick();
  assertEquals(brief(r), ["main leave", "window-1 enter", "main move window=window-1"]);
});

// --- through the window registry's `windows` capability -------------------------------------

/** A runtime window with an id and a page position, as the pinned runtime's BrowserWindow. */
class FakeWin extends EventTarget implements RegistryWindow {
  static next = 20;
  static made: FakeWin[] = [];
  readonly windowId = ++FakeWin.next;
  hidden = false;
  inner: [number, number] = [0, 0];
  constructor(readonly options?: Record<string, unknown>) {
    super();
    FakeWin.made.push(this);
  }
  bind() {}
  navigate() {}
  show() {
    this.hidden = false;
  }
  hide() {
    this.hidden = true;
  }
  focus() {}
  close() {}
  isVisible() {
    return !this.hidden;
  }
  getBounds() {
    return { x: 0, y: 0, width: 800, height: 600 };
  }
  setBounds() {}
  getInnerPosition(): [number, number] {
    return this.inner;
  }
}

Deno.test("registry: order, pointer and a drag session over real registry windows", async () => {
  FakeWin.made = [];
  const main = new FakeWin();
  main.inner = [0, 30];
  let pointer: { x: number; y: number; buttons: number; windowId: number | null } | null = {
    x: 50,
    y: 80,
    buttons: 1,
    windowId: main.windowId,
  };
  let order: number[] | null = null;
  const api = Object.assign(new EventTarget(), {
    quitOnLastWindowClosed: true,
    windowOrder: () => order,
    pointer: () => pointer,
  }) as unknown as DesktopAppApi;
  const emitted: Array<[string, string, DragEvent, string | undefined, unknown]> = [];
  const reg = createWindowRegistry({
    BrowserWindow: FakeWin,
    api,
    appUrl: (path) => `app://localhost${path}`,
    emit: (cap, event, data, target, options) =>
      void emitted.push([cap, event, data as DragEvent, target, options]),
    keepAlive: () => true,
    exit: () => {},
    warn: () => {},
    controller: (window, _id, closed) =>
      createWindowController({ window, api, emit: () => {}, closed }),
  });
  reg.adopt(main, "main");
  const call = (method: string, args: unknown, windowId: string) =>
    reg.capability.methods[method].handler(args, { windowId } as never);
  const other = reg.open({ url: "/other" });
  const otherWin = other.window as FakeWin;
  otherWin.inner = [400, 30];

  // The capability declares the event the pages subscribe to.
  assert(reg.capability.events?.includes("drag"));

  // The OS's order, mapped to registry ids; the focus order where it does not tell.
  order = [otherWin.windowId, main.windowId];
  assertEquals(await call("order", {}, "main"), { ids: [other.id, "main"], source: "os" });
  order = null;
  main.dispatchEvent(new Event("focus"));
  assertEquals(await call("order", {}, "main"), { ids: ["main", other.id], source: "focus" });
  otherWin.hide();
  assertEquals(await call("order", {}, "main"), { ids: ["main"], source: "focus" });
  otherWin.show();

  // The backend's own accessors (`windows.order()` / `windows.pointer()` in desktop.ts).
  assertEquals(reg.order(), { ids: ["main", other.id], source: "focus" });
  assertEquals(reg.pointer()?.window, "main");
  const held = pointer;
  pointer = null;
  assertEquals(reg.pointer(), null);
  pointer = held;

  assertEquals(await call("pointer", {}, other.id), {
    x: 50,
    y: 80,
    buttons: 1,
    window: "main",
    clientX: 50,
    clientY: 50,
  });

  // A session from the main window, dropped on the other one: each event goes to ONE window,
  // live pages only.
  const drags = () => emitted.filter((e) => e[1] === "drag").map((e) => `${e[3]} ${e[2].type}`);
  const { session } = await call("dragStart", { data: { n: 1 } }, "main") as {
    session: string;
  };
  try {
    assertEquals(drags(), ["main enter", "main move"]);
    assert(
      emitted.filter((e) => e[1] === "drag").every((e) =>
        e[0] === "windows" && (e[4] as { retain?: boolean }).retain === false
      ),
    );
    // Only the origin cancels.
    assertEquals(await call("dragCancel", { session }, other.id), { cancelled: false });
    pointer = { x: 450, y: 90, buttons: 0, windowId: otherWin.windowId };
    await until(() => emitted.some((e) => e[1] === "drag" && e[2].type === "end"));
    assertEquals(drags().slice(2), [
      "main leave",
      `${other.id} enter`,
      "main move",
      `${other.id} drop`,
      "main end",
    ]);
    const drop = emitted.find((e) => e[2].type === "drop")![2];
    assertEquals([drop.clientX, drop.clientY, drop.data, drop.origin], [50, 60, { n: 1 }, "main"]);
  } finally {
    await call("dragCancel", { session }, "main");
  }

  // A window that closes during its own session ends it (the timer stops: no leak at the end
  // of this test).
  pointer = { x: 450, y: 90, buttons: 1, windowId: otherWin.windowId };
  await call("dragStart", {}, other.id);
  reg.closed(other.id);
  const before = emitted.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assertEquals(emitted.slice(before).filter((e) => e[1] === "drag"), []);
  // And a new session can start at once.
  pointer = { x: 50, y: 80, buttons: 1, windowId: main.windowId };
  const again = await call("dragStart", {}, "main") as { session: string };
  assertEquals(await call("dragCancel", { session: again.session }, "main"), { cancelled: true });
});

// --- the page side (`denext/desktop/window`) ------------------------------------------------

Deno.test("client: getWindowOrder, getPointer, startDragSession and onDragSession", async () => {
  let pointerFails: string | null = null;
  let started = 0;
  const rt = createFakeDesktopRuntime({
    windows: {
      order: () => ({ ids: ["window-1", 7, "main"], source: "os" }),
      pointer: () => {
        if (pointerFails) throw { code: pointerFails, message: "no" };
        return { x: 1, y: 2, buttons: 0, window: null };
      },
      dragStart: (args) => {
        const a = args as { data?: unknown; intervalMs?: number };
        if (a.intervalMs === 1) throw { code: "validation", message: "bad interval" };
        // A session id is never reused (the runtime's are random).
        if (++started > 1) return { session: `s${9 + started}` };
        // The first events can be on the stream before the call's answer is read.
        rt.emit("windows", "drag", {
          session: "s9",
          type: "move",
          x: 5,
          y: 6,
          buttons: 1,
          window: "main",
        });
        return { session: "s9" };
      },
      dragCancel: () => ({ cancelled: true }),
    },
  });
  const restore = rt.install();
  try {
    assertEquals(await getWindowOrder(), { ids: ["window-1", "main"], source: "os" });
    assertEquals(await getPointer(), { x: 1, y: 2, buttons: 0, window: null });
    // Where the OS does not tell: null, not a throw. Any other failure is thrown.
    pointerFails = "unsupported";
    assertEquals(await getPointer(), null);
    pointerFails = "internal";
    const err = await assertRejects(() => getPointer());
    assert(isDesktopBridgeError(err) && err.code === "internal");

    // The target side.
    const heard: DragSessionEvent[] = [];
    const off = onDragSession((e) => heard.push(e));

    // The origin side: moves through onMove, the end through `ended`.
    const moves: Array<[number, number, string | null]> = [];
    const drag = await startDragSession({
      data: { tab: 1 },
      intervalMs: 20,
      onMove: (m) => moves.push([m.x, m.y, m.window]),
    });
    assertEquals(drag.id, "s9");
    assertEquals(rt.calls.at(-1)?.args, { data: { tab: 1 }, intervalMs: 20 });
    rt.emit("windows", "drag", {
      session: "other",
      type: "move",
      x: 0,
      y: 0,
      buttons: 1,
      window: null,
    });
    rt.emit("windows", "drag", {
      session: "s9",
      type: "move",
      x: 7,
      y: 8,
      buttons: 1,
      window: null,
    });
    rt.emit("windows", "drag", {
      session: "s9",
      type: "enter",
      origin: "main",
      x: 7,
      y: 8,
      buttons: 1,
      clientX: 3,
      clientY: 4,
      data: { tab: 1 },
    });
    rt.emit("windows", "drag", {
      session: "s9",
      type: "leave",
      origin: "main",
      x: 9,
      y: 9,
      buttons: 1,
      cancelled: true,
    });
    rt.emit("windows", "drag", {
      session: "s9",
      type: "bogus",
      origin: "main",
      x: 9,
      y: 9,
      buttons: 1,
    });
    rt.emit("windows", "drag", { type: "drop", origin: "main", x: 9, y: 9, buttons: 0 });
    rt.emit("windows", "drag", {
      session: "s9",
      type: "end",
      x: 9,
      y: 10,
      buttons: 0,
      window: "window-1",
    });
    assertEquals(await drag.ended, { window: "window-1", x: 9, y: 10, cancelled: false });
    await until(() => heard.length === 2);
    // The early move (sent before the answer) was not lost; another session's was ignored.
    assertEquals(moves, [[5, 6, "main"], [7, 8, null]]);
    assertEquals(heard, [
      {
        session: "s9",
        type: "enter",
        origin: "main",
        x: 7,
        y: 8,
        buttons: 1,
        clientX: 3,
        clientY: 4,
        data: { tab: 1 },
      },
      { session: "s9", type: "leave", origin: "main", x: 9, y: 9, buttons: 1, cancelled: true },
    ]);
    await drag.cancel();
    assertEquals(rt.calls.at(-1)?.args, { session: "s9" });
    off();

    // A cancelled end carries its reason; a refused start rejects and leaves no subscription.
    const second = await startDragSession();
    assertEquals(rt.calls.at(-1)?.args, {});
    assertEquals(second.id, "s11");
    rt.emit("windows", "drag", {
      session: "s11",
      type: "end",
      x: 1,
      y: 1,
      buttons: 1,
      window: null,
      cancelled: true,
      reason: "timeout",
    });
    assertEquals(await second.ended, {
      window: null,
      x: 1,
      y: 1,
      cancelled: true,
      reason: "timeout",
    });
    const refused = await assertRejects(() => startDragSession({ intervalMs: 1 }));
    assert(isDesktopBridgeError(refused) && refused.code === "validation");
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
});
