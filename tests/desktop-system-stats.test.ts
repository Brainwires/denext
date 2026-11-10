// System stats on the desktop: the `systemStats` capability (src/desktop/caps/system-stats.ts)
// over a fake `Deno.desktop.systemStats` (one sampler per window for `stats`, one per
// subscription, events to the subscribing window only, release on close / reload / quit, interval
// validation, `unsupported` and the runtime's `NotCapable`), the extension side `system` from
// `denext/desktop` (src/desktop/system-stats.ts), the page side `system` from
// `denext/desktop/client` (src/desktop/system-stats-client.ts) against the fake bridge, and the
// catalog / resolver wiring.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { systemStatsCapability } from "../src/desktop/caps/system-stats.ts";
import { createSystemStats, systemStatsError } from "../src/desktop/system-stats.ts";
import type {
  DenoSystemStatsApi,
  DenoSystemStatsSampler,
  SystemStats,
} from "../src/desktop/system-stats-shape.ts";
import {
  type DesktopCapability,
  type DesktopCapCtx,
  DesktopCapError,
} from "../src/desktop/extension.ts";
import type { DesktopAppApi } from "../src/desktop/launch-events.ts";
import { isDesktopBridgeError, system as pageSystem } from "../src/desktop/client.ts";
import { system as extensionSystem } from "../src/build/desktop.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { createFakeDesktopRuntime, until } from "./helpers/desktop-fake-runtime.ts";
import { DESKTOP_CAPABILITIES, desktopBuildFlags } from "../src/build/desktop-capabilities.ts";
import { DESKTOP_ADD_CAPABILITY_KEYS } from "../src/desktop/config-types.ts";
import { resolveDesktopCapabilities } from "../src/desktop/caps/mod.ts";

/** One fake runtime sampler and what was done to it. */
interface FakeSampler extends DenoSystemStatsSampler {
  readonly n: number;
  readonly statsCalls: unknown[];
  readonly listeners: { cb: (s: SystemStats) => void; options: unknown; active: boolean }[];
  closed: boolean;
  /** Fire one tick on every active listener. */
  tick(): void;
}

/** A sample whose `cpu.total` names the sampler and its call count. */
function sample(sampler: number, k: number): SystemStats {
  return {
    at: sampler * 1000 + k,
    cpu: { total: sampler + k / 100 },
    gpu: { utilization: null },
    memory: { pressure: 10 },
  };
}

/** A fake `Deno.desktop.systemStats` recording every sampler it makes. */
function fakeStats(opts: { supported?: boolean; fail?: string } = {}) {
  const samplers: FakeSampler[] = [];
  const api: DenoSystemStatsApi = {
    supported: opts.supported ?? true,
    createSampler: () => {
      const n = samplers.length + 1;
      let k = 0;
      const s: FakeSampler = {
        n,
        statsCalls: [],
        listeners: [],
        closed: false,
        stats: (options) => {
          s.statsCalls.push(options);
          if (opts.fail) {
            const err = new Error("denied by the runtime at /secret/path");
            err.name = opts.fail;
            return Promise.reject(err);
          }
          return Promise.resolve(sample(n, ++k));
        },
        onStats: (cb, options) => {
          if (options.intervalMs < 1000) throw new RangeError("intervalMs");
          const l = { cb, options, active: true };
          s.listeners.push(l);
          return () => void (l.active = false);
        },
        close: () => void (s.closed = true),
        tick: () => {
          for (const l of s.listeners) if (l.active) l.cb(sample(n, ++k));
        },
      };
      samplers.push(s);
      return s;
    },
  };
  return { desktop: { systemStats: api } as DesktopAppApi, samplers };
}

interface Sent {
  event: string;
  data: { id: string; stats: SystemStats };
  window: string | undefined;
}

/** A handler context for `windowId`, recording what it emits. */
function ctx(windowId: string, sent: Sent[]): DesktopCapCtx {
  return {
    emit: (event, data, options) =>
      void sent.push({ event, data: data as Sent["data"], window: options?.window }),
    appSupportDir: "",
    runOnMainThread: () => Promise.reject(new Error("no UI thread")),
    secureStore: {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    pickedPath: () => {
      throw new Error("no picked paths");
    },
    os: "darwin",
    windowId,
    signal: new AbortController().signal,
  };
}

/** Call one method of the capability. */
async function call(cap: DesktopCapability, method: string, args: unknown, c: DesktopCapCtx) {
  return await cap.methods[method].handler(args, c);
}

/** Expect a DesktopCapError with `code`. */
async function rejectsCode(p: () => Promise<unknown>, code: string): Promise<DesktopCapError> {
  const err = await assertRejects(p);
  assert(err instanceof DesktopCapError, String(err));
  assertEquals(err.code, code);
  return err;
}

Deno.test("systemStats cap: stats uses one sampler per window, created lazily", async () => {
  const { desktop, samplers } = fakeStats();
  const cap = systemStatsCapability({ api: desktop });
  const sent: Sent[] = [];
  assertEquals(samplers.length, 0);
  const a1 = await call(cap, "stats", {}, ctx("main", sent)) as SystemStats;
  const a2 = await call(cap, "stats", { perCore: true }, ctx("main", sent)) as SystemStats;
  const b1 = await call(cap, "stats", undefined, ctx("w2", sent)) as SystemStats;
  assertEquals(samplers.length, 2);
  // Each window's CPU delta comes off its own sampler.
  assertEquals([a1.cpu.total, a2.cpu.total, b1.cpu.total], [1.01, 1.02, 2.01]);
  assertEquals(samplers[0].statsCalls, [undefined, { perCore: true }]);
  await rejectsCode(() => call(cap, "stats", { perCore: "yes" }, ctx("main", sent)), "validation");
});

Deno.test("systemStats cap: subscribe gets its own sampler and pushes to its window only", async () => {
  const { desktop, samplers } = fakeStats();
  const cap = systemStatsCapability({ api: desktop });
  const sent: Sent[] = [];
  await call(cap, "stats", {}, ctx("main", sent));
  const { id } = await call(
    cap,
    "subscribe",
    { intervalMs: 2000, perCore: true },
    ctx("w2", sent),
  ) as {
    id: string;
  };
  assertEquals(samplers.length, 2, "the subscription never shares the stats() sampler");
  assertEquals(samplers[1].listeners[0].options, { intervalMs: 2000, perCore: true });
  samplers[1].tick();
  samplers[0].tick(); // no listener on the stats() sampler
  assertEquals(sent.map((s) => [s.event, s.window, s.data.id, s.data.stats.cpu.total]), [
    ["stats", "w2", id, 2.01],
  ]);
  // Another window cannot stop it.
  assertEquals(await call(cap, "unsubscribe", { id }, ctx("main", sent)), null);
  assert(samplers[1].listeners[0].active);
  assertEquals(await call(cap, "unsubscribe", { id }, ctx("w2", sent)), null);
  assert(!samplers[1].listeners[0].active);
  assert(samplers[1].closed);
  assert(!samplers[0].closed);
  await rejectsCode(() => call(cap, "unsubscribe", {}, ctx("w2", sent)), "validation");
});

Deno.test("systemStats cap: intervalMs is checked before the runtime is reached", async () => {
  const { desktop, samplers } = fakeStats();
  const cap = systemStatsCapability({ api: desktop });
  const sent: Sent[] = [];
  for (const intervalMs of [undefined, 999, 0, -1, Infinity, NaN, "2000"]) {
    await rejectsCode(
      () => call(cap, "subscribe", { intervalMs }, ctx("main", sent)),
      "validation",
    );
  }
  assertEquals(samplers.length, 0);
});

Deno.test("systemStats cap: a window's close, its page reload and the app's quit release it", async () => {
  const { desktop, samplers } = fakeStats();
  const cap = systemStatsCapability({ api: desktop });
  const sent: Sent[] = [];
  for (const w of ["main", "w2", "w3"]) {
    await call(cap, "stats", {}, ctx(w, sent));
    await call(cap, "subscribe", { intervalMs: 1000 }, ctx(w, sent));
  }
  // samplers: main stats 0, main sub 1, w2 stats 2, w2 sub 3, w3 stats 4, w3 sub 5
  await cap.onWindowClosed!({ id: "w2", kind: "window", appQuitting: false });
  assertEquals(samplers.map((s) => s.closed), [false, false, true, true, false, false]);
  assert(!samplers[3].listeners[0].active);
  await cap.onPageLoad!("main");
  assertEquals(samplers.map((s) => s.closed), [true, true, true, true, false, false]);
  // A new stats() after the reload starts afresh.
  await call(cap, "stats", {}, ctx("main", sent));
  assertEquals(samplers.length, 7);
  await cap.onAppQuit!();
  assert(samplers.every((s) => s.closed));
  assert(cap.perWindow, "onPageLoad must run for every window");
  assertEquals(cap.events, ["stats"]);
});

Deno.test("systemStats cap: a window keeps a bounded number of subscriptions", async () => {
  const { desktop } = fakeStats();
  const cap = systemStatsCapability({ api: desktop });
  const sent: Sent[] = [];
  for (let i = 0; i < 16; i++) {
    await call(cap, "subscribe", { intervalMs: 1000 }, ctx("main", sent));
  }
  await rejectsCode(
    () => call(cap, "subscribe", { intervalMs: 1000 }, ctx("main", sent)),
    "too_many",
  );
  await call(cap, "subscribe", { intervalMs: 1000 }, ctx("w2", sent));
});

Deno.test("systemStats cap: an older runtime or an OS without it is unsupported", async () => {
  const sent: Sent[] = [];
  for (const api of [{} as DesktopAppApi, fakeStats({ supported: false }).desktop]) {
    const cap = systemStatsCapability({ api });
    const err = await rejectsCode(() => call(cap, "stats", {}, ctx("main", sent)), "unsupported");
    assertEquals(err.status, 501);
    await rejectsCode(
      () => call(cap, "subscribe", { intervalMs: 1000 }, ctx("main", sent)),
      "unsupported",
    );
  }
  const err = await rejectsCode(
    () => call(systemStatsCapability({ api: {} }), "stats", {}, ctx("main", sent)),
    "unsupported",
  );
  assert(err.message.includes("Deno.desktop.systemStats"), err.message);
});

Deno.test("systemStats cap: the runtime's NotCapable is forbidden, naming the config key", async () => {
  const sent: Sent[] = [];
  const cap = systemStatsCapability({ api: fakeStats({ fail: "NotCapable" }).desktop });
  const err = await rejectsCode(() => call(cap, "stats", {}, ctx("main", sent)), "forbidden");
  assert(err.message.includes("desktop.capabilities.systemStats"), err.message);
  // Any other failure is a fixed message (the runtime's may name host paths).
  const other = await rejectsCode(
    () =>
      call(
        systemStatsCapability({ api: fakeStats({ fail: "Error" }).desktop }),
        "stats",
        {},
        ctx("main", sent),
      ),
    "failed",
  );
  assert(!other.message.includes("/secret"), other.message);
  assertEquals(systemStatsError(new RangeError("too fast")).code, "validation");
});

Deno.test("systemStats cap: a sampler or listener the runtime already closed, and an onStats that throws", async () => {
  let throwOnStats = false;
  const closed: number[] = [];
  let made = 0;
  const api: DenoSystemStatsApi = {
    supported: true,
    createSampler: () => {
      const n = ++made;
      return {
        stats: () => Promise.resolve(sample(n, 1)),
        onStats: () => {
          if (throwOnStats) throw new Error("the runtime refused at /secret/path");
          return () => {
            throw new Error("listener already stopped");
          };
        },
        close: () => {
          closed.push(n);
          throw new Error("sampler already closed");
        },
      };
    },
  };
  const cap = systemStatsCapability({ api: { systemStats: api } as DesktopAppApi });
  const sent: Sent[] = [];
  await call(cap, "stats", {}, ctx("main", sent));
  const { id } = await call(cap, "subscribe", { intervalMs: 1000 }, ctx("main", sent)) as {
    id: string;
  };
  // unsubscribe: a throwing off() and close() are ignored, the sampler is still closed
  assertEquals(await call(cap, "unsubscribe", { id }, ctx("main", sent)), null);
  assertEquals(closed, [2]);
  // an onStats the runtime refuses closes the new sampler and fails with a fixed message
  throwOnStats = true;
  const err = await rejectsCode(
    () => call(cap, "subscribe", { intervalMs: 1000 }, ctx("main", sent)),
    "failed",
  );
  assert(!err.message.includes("/secret"), err.message);
  assertEquals(closed, [2, 3]);
  // a window that holds nothing, and one already released, are no-ops
  await cap.onWindowClosed!({ id: "never-opened", kind: "window", appQuitting: false });
  await cap.onPageLoad!("main");
  await cap.onPageLoad!("main");
  assertEquals(closed, [2, 3, 1]);
  await rejectsCode(() => call(cap, "unsubscribe", { id: 7 }, ctx("main", sent)), "validation");
  await rejectsCode(() => call(cap, "stats", { perCore: "yes" }, ctx("main", sent)), "validation");
});

Deno.test("system (denext/desktop): stats shares one sampler, each onStats has its own", async () => {
  const { desktop, samplers } = fakeStats();
  const system = createSystemStats(() => desktop);
  assertEquals((await system.stats()).cpu.total, 1.01);
  assertEquals((await system.stats({ perCore: true })).cpu.total, 1.02);
  assertEquals(samplers.length, 1);
  const got: number[] = [];
  const stop1 = system.onStats((s) => got.push(s.cpu.total!), { intervalMs: 1500 });
  const stop2 = system.onStats(() => {}, { intervalMs: 1000, perCore: true });
  assertEquals(samplers.length, 3);
  assertEquals(samplers[1].listeners[0].options, { intervalMs: 1500 });
  assertEquals(samplers[2].listeners[0].options, { intervalMs: 1000, perCore: true });
  samplers[1].tick();
  assertEquals(got, [2.01]);
  stop1();
  stop1();
  assert(samplers[1].closed && !samplers[1].listeners[0].active);
  assert(!samplers[2].closed && !samplers[0].closed);
  stop2();
  assert(samplers[2].closed);
});

Deno.test("system (denext/desktop): interval, unsupported and NotCapable", async () => {
  const { desktop, samplers } = fakeStats();
  const system = createSystemStats(() => desktop);
  assertThrows(() => system.onStats(() => {}, { intervalMs: 500 }), RangeError);
  assertThrows(() => system.onStats(() => {}, { intervalMs: NaN }), RangeError);
  assertEquals(samplers.length, 0);
  const old = createSystemStats(() => undefined);
  await rejectsCode(() => old.stats(), "unsupported");
  const e = assertThrows(() => old.onStats(() => {}, { intervalMs: 1000 }));
  assert(e instanceof DesktopCapError && e.code === "unsupported");
  const denied = createSystemStats(() => fakeStats({ fail: "NotCapable" }).desktop);
  await rejectsCode(() => denied.stats(), "forbidden");
  // `denext/desktop`'s own `system` reads `Deno.desktop`, which a test process has none of.
  await rejectsCode(() => extensionSystem.stats(), "unsupported");
});

Deno.test("system (denext/desktop/client): stats and onStats over the bridge, filtered by id", async () => {
  let subs = 0;
  const rt = createFakeDesktopRuntime({
    systemStats: {
      stats: () => sample(1, 1),
      subscribe: () => ({ id: `s${++subs}` }),
      unsubscribe: () => null,
    },
  });
  const restore = rt.install();
  try {
    assertEquals(await pageSystem.stats(), sample(1, 1));
    await pageSystem.stats({ perCore: true });
    const got: number[] = [];
    const stop = pageSystem.onStats((s) => got.push(s.at), { intervalMs: 2000, perCore: true });
    await until(() => rt.calls.some((c) => c.method === "subscribe") && rt.openStreams() === 1);
    await rt.settled();
    rt.emit("systemStats", "stats", { id: "other", stats: sample(9, 1) });
    rt.emit("systemStats", "stats", { id: "s1", stats: sample(2, 1) });
    rt.emit("systemStats", "stats", { id: "s1", stats: sample(2, 1) }); // replayed
    rt.emit("systemStats", "stats", { id: "s1", stats: sample(2, 2) });
    await until(() => got.length === 2);
    await rt.settled();
    assertEquals(got, [2001, 2002]);
    stop();
    stop();
    await until(() => rt.calls.some((c) => c.method === "unsubscribe"));
    await rt.settled();
    assertEquals(rt.calls.map((c) => [c.method, c.args]), [
      ["stats", {}],
      ["stats", { perCore: true }],
      ["subscribe", { intervalMs: 2000, perCore: true }],
      ["unsubscribe", { id: "s1" }],
    ]);
    rt.emit("systemStats", "stats", { id: "s1", stats: sample(2, 3) });
    await rt.settled();
    assertEquals(got, [2001, 2002]);
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
});

Deno.test("system (denext/desktop/client): frames before the subscribe answer, and a stop before it", async () => {
  let subs = 0;
  const gates: PromiseWithResolvers<void>[] = [];
  const rt = createFakeDesktopRuntime({
    systemStats: {
      subscribe: async () => {
        const gate = Promise.withResolvers<void>();
        gates.push(gate);
        await gate.promise;
        return { id: `s${++subs}` };
      },
      unsubscribe: () => null,
    },
  });
  const restore = rt.install();
  try {
    // Frames that arrive before the id are kept, then only this subscription's are delivered.
    const got: number[] = [];
    const stop = pageSystem.onStats((s) => got.push(s.at), { intervalMs: 1000 });
    await until(() => gates.length === 1 && rt.openStreams() === 1);
    rt.emit("systemStats", "stats", { id: "s1", stats: sample(3, 1) });
    rt.emit("systemStats", "stats", { id: "elsewhere", stats: sample(4, 1) });
    rt.emit("systemStats", "stats", null);
    // (not rt.settled(): the subscribe is held in flight on purpose)
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(got, []);
    gates[0].resolve();
    await until(() => got.length === 1);
    assertEquals(got, [3001]);
    stop();
    await until(() => rt.calls.filter((c) => c.method === "unsubscribe").length === 1);
    await rt.settled();

    // A stop before the answer: nothing is delivered, and the id that comes back is unsubscribed.
    const late: number[] = [];
    const stopEarly = pageSystem.onStats((s) => late.push(s.at), { intervalMs: 1000 });
    await until(() => gates.length === 2);
    stopEarly();
    gates[1].resolve();
    await until(() =>
      rt.calls.some((c) => c.method === "unsubscribe" && (c.args as { id: string }).id === "s2")
    );
    await rt.settled();
    rt.emit("systemStats", "stats", { id: "s2", stats: sample(5, 1) });
    await rt.settled();
    assertEquals(late, []);
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
});

Deno.test("system (denext/desktop/client): a failed subscribe reaches onError; off desktop", async () => {
  assertThrows(() => pageSystem.onStats(() => {}, { intervalMs: 999 }), RangeError);
  const err = await assertRejects(() => pageSystem.stats());
  assert(isDesktopBridgeError(err));
  assertEquals(err.code, "unavailable");
  const errors: unknown[] = [];
  pageSystem.onStats(() => {}, { intervalMs: 1000, onError: (e) => errors.push(e) });
  await until(() => errors.length === 1);
  assert(isDesktopBridgeError(errors[0]) && errors[0].code === "unavailable");

  const rt = createFakeDesktopRuntime({
    systemStats: {
      subscribe: () => {
        throw { code: "unsupported", message: "no systemStats" };
      },
    },
  });
  const restore = rt.install();
  try {
    const seen: unknown[] = [];
    pageSystem.onStats(() => {}, { intervalMs: 1000, onError: (e) => seen.push(e) });
    await until(() => seen.length === 1);
    assert(isDesktopBridgeError(seen[0]) && seen[0].code === "unsupported");
    await rt.settled();
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
});

Deno.test("system-stats catalog: no Deno permission, a desktop add key, resolved when enabled", async () => {
  const entry = DESKTOP_CAPABILITIES["system-stats"];
  assertEquals(entry.key, "systemStats");
  assertEquals(entry.trust, "none");
  assertEquals([entry.all, entry.os], [undefined, undefined]);
  assert((DESKTOP_ADD_CAPABILITY_KEYS as readonly string[]).includes("systemStats"));
  const config = { desktop: { capabilities: { systemStats: true } } };
  for (const os of ["darwin", "windows", "linux"] as const) {
    assertEquals(desktopBuildFlags(config, os), desktopBuildFlags({}, os));
  }
  const on = await resolveDesktopCapabilities(config);
  assert(on.capabilities.some((c) => c.name === "systemStats"));
  const off = await resolveDesktopCapabilities({ desktop: { capabilities: { device: true } } });
  assert(!off.capabilities.some((c) => c.name === "systemStats"));
});
