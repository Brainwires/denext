// examples/multiwindow's counters (lib/counters.ts) over a fake host and a fake clock: a counter
// ticks to its owner window only; the owner's close detaches it (it keeps ticking, the ticks kept);
// a window reopened with the same key finds it and takes it back with the replay; the app's quit
// stops them all. Nothing here opens a window.

import { assertEquals } from "@std/assert";
import type {
  OwnedResourcesClosedWindow,
  OwnedResourcesHost,
  OwnedResourcesWindow,
} from "../src/desktop/owned-resources.ts";
import {
  type Counter,
  type CounterClock,
  counterStoreOptions,
  createCounters,
  latestCount,
  replayNote,
  type Tick,
  windowLabel,
} from "../examples/multiwindow/lib/counters.ts";
import { createOwnedResources } from "../src/desktop/owned-resources.ts";

/** The service over the real store (what desktop/counters.ts builds). */
const service = (clock: CounterClock) =>
  createCounters(clock, createOwnedResources<Counter>(counterStoreOptions));

/** A clock the test advances by hand. */
function fakeClock() {
  let now = 1000;
  const timers = new Map<number, { ms: number; due: number; fn: () => void }>();
  let next = 1;
  const clock: CounterClock = {
    now: () => now,
    every: (ms, fn) => {
      const id = next++;
      timers.set(id, { ms, due: now + ms, fn });
      return () => timers.delete(id);
    },
  };
  return {
    clock,
    running: () => timers.size,
    /** Advance `ms`, firing every interval that comes due. */
    tick: (ms: number) => {
      const end = now + ms;
      while (true) {
        const due = [...timers.values()].filter((t) => t.due <= end).sort((a, b) => a.due - b.due);
        if (due.length === 0) break;
        now = due[0].due;
        due[0].due += due[0].ms;
        due[0].fn();
      }
      now = end;
    },
  };
}

interface Sent {
  event: string;
  data: { id: string; data: Tick };
  window: string | undefined;
}

/** A fake extension host: records what is sent, fires the lifecycle hooks by hand. */
function fakeHost(open: OwnedResourcesWindow[]) {
  const sent: Sent[] = [];
  const closed = new Set<(info: OwnedResourcesClosedWindow) => void | Promise<void>>();
  const quit = new Set<() => void | Promise<void>>();
  const host: OwnedResourcesHost = {
    emit: (event, data, options) =>
      void sent.push({ event, data: data as Sent["data"], window: options?.window }),
    onWindowClosed: (fn) => {
      closed.add(fn);
      return () => closed.delete(fn);
    },
    onAppQuit: (fn) => {
      quit.add(fn);
      return () => quit.delete(fn);
    },
    windows: () => open,
  };
  return {
    host,
    sent,
    close: async (id: string, appQuitting = false) => {
      const win = open.find((w) => w.id === id)!;
      open.splice(open.indexOf(win), 1);
      for (const fn of [...closed]) await fn({ ...win, appQuitting });
    },
    quit: async () => {
      for (const fn of [...quit]) await fn();
    },
  };
}

Deno.test("multiwindow counters: a counter ticks to its window only, and is per window", () => {
  const { clock, tick } = fakeClock();
  const windows = [{ id: "main", kind: "main" as const, key: "workspace" }, {
    id: "window-1",
    kind: "window" as const,
    key: "notes",
  }];
  const { host, sent } = fakeHost(windows);
  const counters = service(clock);
  counters.connect(host);
  const a = counters.start("main");
  const b = counters.start("window-1", 500);
  tick(1000);
  assertEquals(sent.map((s) => [s.data.id, s.data.data.n, s.window]), [
    [b, 1, "window-1"],
    [a, 1, "main"],
    [b, 2, "window-1"],
  ]);
  assertEquals(counters.mine("main"), [a]);
  assertEquals(counters.mine("window-1"), [b]);
  assertEquals(counters.mine("notes"), [], "a key finds only detached counters");
});

Deno.test("multiwindow counters: a closed window's counter keeps ticking, detached, until its key reopens", async () => {
  const { clock, tick, running } = fakeClock();
  const windows = [{ id: "main", kind: "main" as const, key: "workspace" }, {
    id: "window-1",
    kind: "window" as const,
    key: "notes",
  }];
  const fake = fakeHost(windows);
  const counters = service(clock);
  counters.connect(fake.host);
  const id = counters.start("window-1");
  tick(2000);
  // The user closes "notes": the counter is detached, not stopped; its ticks go nowhere but
  // the replay.
  await fake.close("window-1");
  assertEquals(running(), 1);
  tick(3000);
  assertEquals(fake.sent.length, 2, "nothing sent while nobody owns it");
  assertEquals(counters.mine("window-1"), []);
  assertEquals(counters.mine("notes"), [id], "found by the key the window had");
  // The window comes back with the same key (a new id): it takes the counter over with the ticks
  // it missed, and hears the next ones.
  windows.push({ id: "window-2", kind: "window", key: "notes" });
  const { replay } = counters.attach(id, "window-2");
  assertEquals(replay.map((t) => t.n), [1, 2, 3, 4, 5]);
  assertEquals(replay.at(-1)?.at, 6000);
  tick(1000);
  assertEquals(fake.sent.at(-1), {
    event: "tick",
    data: { id, data: { n: 6, at: 7000 } },
    window: "window-2",
  });
  assertEquals(counters.mine("window-2"), [id]);
  // Stopped for good: gone from everywhere.
  assertEquals(await counters.stop(id), true);
  assertEquals([running(), counters.mine("window-2"), await counters.stop(id)], [0, [], false]);
});

Deno.test("multiwindow counters: the app's quit stops every counter, detached ones included", async () => {
  const { clock, tick, running } = fakeClock();
  const windows = [{ id: "main", kind: "main" as const, key: "workspace" }, {
    id: "window-1",
    kind: "window" as const,
    key: "notes",
  }];
  const fake = fakeHost(windows);
  const counters = service(clock);
  counters.connect(fake.host);
  counters.start("main");
  counters.start("window-1");
  await fake.close("window-1");
  assertEquals(running(), 2);
  // A quit's close of the main window disposes everything (appQuitting), as the quit hook does.
  await fake.close("main", true);
  assertEquals(running(), 0);
  await fake.quit();
  tick(5000);
  assertEquals(fake.sent.filter((s) => s.data.data.at > 1000).length, 0);
});

Deno.test("multiwindow page helpers: the count, the replay note and the window's label", () => {
  assertEquals(latestCount([]), 0);
  assertEquals(latestCount([{ n: 1, at: 1 }, { n: 2, at: 2 }]), 2);
  assertEquals(replayNote(0), null);
  assertEquals(replayNote(3), "3 tick(s) replayed from before the close.");
  assertEquals(windowLabel({ id: "window-1", key: "notes" }), "notes");
  assertEquals(windowLabel({ id: "window-1" }), "window-1");
});
