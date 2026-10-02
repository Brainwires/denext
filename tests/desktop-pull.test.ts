// The desktop runtime's pull queues end to end: the runtime half (src/desktop/caps/queue.ts — a
// bounded queue that signals the page) and the page half (src/desktop/pull.ts — one shared
// subscription per queue that takes it on the first listener and on every signal), plus the `app`
// queue's click parser (src/desktop/app-actions.ts), against the fake bridge runtime.

import { assert, assertEquals } from "@std/assert";
import { pullQueue } from "../src/desktop/pull.ts";
import { type AppActionEvent, onAppAction } from "../src/desktop/app-actions.ts";
import { createPullQueue } from "../src/desktop/caps/queue.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import {
  createFakeDesktopRuntime,
  type FakeRuntime,
  until,
} from "./helpers/desktop-fake-runtime.ts";

/** Run `fn` with the fake installed; always restores and resets. */
async function withRuntime(rt: FakeRuntime, fn: () => Promise<void>): Promise<void> {
  const restore = rt.install();
  try {
    await fn();
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
}

/** A runtime whose `cap` serves one runtime-side pull queue (emitting `event` as its signal). */
function queueRuntime(cap: string, event: string, opts: { failTake?: () => boolean } = {}) {
  const queue = createPullQueue<unknown>(() => rt.emit(cap, event, null));
  const rt: FakeRuntime = createFakeDesktopRuntime({
    [cap]: {
      take: () => {
        if (opts.failTake?.()) throw { code: "internal", message: "boom" };
        return queue.take();
      },
    },
  });
  return { rt, queue, takes: () => rt.calls.filter((c) => c.method === "take").length };
}

Deno.test("pullQueue: the first listener takes at once (the click that started the app)", async () => {
  const { rt, queue, takes } = queueRuntime("notifications", "click");
  queue.push({ id: "cold" }); // queued before the page loaded
  await withRuntime(rt, async () => {
    const got: unknown[] = [];
    const sub = pullQueue("notifications", "click", (raw) => raw);
    const stop = sub((item) => got.push(item));
    await until(() => got.length === 1);
    assertEquals(got, [{ id: "cold" }]);
    // The initial take, plus at most one more for the replayed signal of the cold push.
    assert(takes() >= 1 && takes() <= 2);
    stop();
  });
});

Deno.test("pullQueue: each signal takes again; every item reaches every listener once", async () => {
  const { rt, queue } = queueRuntime("shortcuts", "pressed");
  await withRuntime(rt, async () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const sub = pullQueue<number>("shortcuts", "pressed", (raw) => raw as number);
    const stopA = sub((n) => a.push(n));
    const stopB = sub((n) => b.push(n));
    await until(() => rt.openStreams() === 1);
    queue.push(1);
    queue.push(2);
    await until(() => a.length === 2 && b.length === 2);
    queue.push(3);
    await until(() => a.length === 3 && b.length === 3);
    // A replayed or extra signal only takes an empty queue: nothing is delivered twice.
    rt.emit("shortcuts", "pressed", null);
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(a, [1, 2, 3]);
    assertEquals(b, [1, 2, 3]);
    // One shared subscription for both listeners.
    assertEquals(rt.requests.filter((r) => r.path.endsWith("/events")).length, 1);
    stopA();
    stopB();
  });
});

Deno.test("pullQueue: parse drops items, a throwing listener does not stop the rest", async () => {
  const { rt, queue } = queueRuntime("menu", "click");
  const errors: unknown[] = [];
  const prevError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    await withRuntime(rt, async () => {
      const got: string[] = [];
      const sub = pullQueue<string>(
        "menu",
        "click",
        (raw) => typeof raw === "string" ? raw : undefined,
      );
      const stopBad = sub(() => {
        throw new Error("listener bug");
      });
      const stopGood = sub((s) => got.push(s));
      await until(() => rt.openStreams() === 1);
      queue.push("a");
      queue.push(42); // not a string: dropped by parse
      queue.push("b");
      await until(() => got.length === 2);
      assertEquals(got, ["a", "b"]);
      assertEquals(errors.length, 2); // once per delivered item, from the throwing listener
      assertEquals(String((errors[0] as unknown[])[0]), "denext: a menu listener threw");
      stopBad();
      stopGood();
    });
  } finally {
    console.error = prevError;
  }
});

Deno.test("pullQueue: a failed or malformed take delivers nothing and keeps listening", async () => {
  let failing = true;
  const { rt, queue } = queueRuntime("app", "action", { failTake: () => failing });
  await withRuntime(rt, async () => {
    const got: unknown[] = [];
    const sub = pullQueue("app", "action", (raw) => raw);
    const stop = sub((x) => got.push(x));
    await until(() => rt.calls.length >= 1); // the initial take failed
    assertEquals(got, []);
    failing = false;
    queue.push("after");
    await until(() => got.length === 1);
    assertEquals(got, ["after"]);
    stop();
  });
  // A take that answers something other than an array delivers nothing.
  const odd = createFakeDesktopRuntime({ app: { take: () => ({ not: "an array" }) } });
  await withRuntime(odd, async () => {
    const got: unknown[] = [];
    const stop = pullQueue("app", "action", (raw) => raw)((x) => got.push(x));
    await until(() => odd.calls.length === 1);
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(got, []);
    stop();
  });
});

Deno.test("pullQueue: a signal during a take makes it take again (no click is lost)", async () => {
  let release: (() => void) | undefined;
  const items: unknown[][] = [["first"], ["second"]];
  let calls = 0;
  const rt = createFakeDesktopRuntime({
    app: {
      take: async () => {
        calls++;
        if (calls === 1) await new Promise<void>((r) => (release = r));
        return items.shift() ?? [];
      },
    },
  });
  await withRuntime(rt, async () => {
    const got: unknown[] = [];
    const stop = pullQueue("app", "action", (raw) => raw)((x) => got.push(x));
    await until(() => release !== undefined && rt.openStreams() === 1);
    rt.emit("app", "action", null); // arrives while the first take is in flight
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(calls, 1); // the signal did not start a second, overlapping take
    release!();
    await until(() => got.length === 2);
    assertEquals(got, ["first", "second"]);
    assertEquals(calls, 2);
    stop();
  });
});

Deno.test("pullQueue: the last listener closes the subscription; unsubscribe is idempotent", async () => {
  const { rt, queue } = queueRuntime("notifications", "click");
  await withRuntime(rt, async () => {
    const sub = pullQueue("notifications", "click", (raw) => raw);
    const got: unknown[] = [];
    const stopA = sub((x) => got.push(x));
    const stopB = sub(() => {});
    await until(() => rt.openStreams() === 1);
    stopA();
    stopA(); // a second call must not remove another listener or close the stream
    assertEquals(rt.openStreams(), 1);
    stopB();
    await until(() => rt.openStreams() === 0);
    // Nothing listens: a push stays queued until a listener comes back and takes it.
    queue.push("later");
    const stopC = sub((x) => got.push(x));
    await until(() => got.length === 1);
    assertEquals(got, ["later"]);
    stopC();
  });
});

Deno.test("onAppAction: menu, dock, tray and tray-menu clicks are parsed; malformed ones dropped", async () => {
  const { rt, queue } = queueRuntime("app", "action");
  await withRuntime(rt, async () => {
    const got: AppActionEvent[] = [];
    const stop = onAppAction((a) => got.push(a));
    await until(() => rt.openStreams() === 1);
    for (
      const raw of [
        { source: "menu", id: "prefs" },
        { source: "dock", id: "new-window" },
        { source: "tray", tray: "main", event: "doubleClick" },
        { source: "tray", tray: "main", event: "rightClick" }, // unknown event → click
        { source: "trayMenu", tray: "main", id: "quit" },
        { source: "menu" }, // no id
        { source: "dock", id: 7 },
        { source: "tray" }, // no tray
        { source: "trayMenu", tray: "main" }, // no id
        { source: "trayMenu", id: "x" }, // no tray
        { source: "keyboard", id: "x" },
        null,
        "menu",
      ]
    ) queue.push(raw);
    await until(() => got.length === 5);
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(got, [
      { source: "menu", id: "prefs" },
      { source: "dock", id: "new-window" },
      { source: "tray", tray: "main", event: "doubleClick" },
      { source: "tray", tray: "main", event: "click" },
      { source: "trayMenu", tray: "main", id: "quit" },
    ]);
    stop();
  });
});

Deno.test("createPullQueue: the default bound keeps the newest 64", () => {
  let signals = 0;
  const q = createPullQueue<number>(() => signals++);
  for (let i = 0; i < 70; i++) q.push(i);
  assertEquals(signals, 70);
  const taken = q.take();
  assertEquals(taken.length, 64);
  assertEquals(taken[0], 6);
  assertEquals(taken[63], 69);
});
