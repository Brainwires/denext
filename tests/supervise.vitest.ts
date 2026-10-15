// Supervision (`supervise` / `defineService`) on Vitest's fake clock: every strategy, intensity
// escalation, the exponential backoff (exact, and with jitter), shutdown ordering and the
// `shutdownMs` give-up, the restart policies, nested supervisors, and the job / sidecar / Live
// publisher adapters. Timers fire only when a test advances the clock, so every backoff is
// waited out exactly, with no sleeps (see CONTRIBUTING.md → Vitest files).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineService,
  forgetStoppedSupervisors,
  jobService,
  type Service,
  type ServiceContext,
  sidecarService,
  stopAllSupervisors,
  type SupervisableSidecar,
  supervise,
  supervisionStatus,
  SupervisorError,
} from "../src/server/supervise.ts";
import type { SupervisionEvent } from "../src/runtime/restart.ts";
import { clearJobs, defineJob, registerJob } from "../src/server/jobs.ts";
import { restartLoop } from "../src/runtime/restart.ts";

const START = new Date("2026-01-01T00:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(async () => {
  await stopAllSupervisors();
  forgetStoppedSupervisors();
  clearJobs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** No jitter: delays are exact (100 ms doubling). */
const EXACT = { initialMs: 100, maxMs: 30_000, factor: 2, jitter: 0 };

/**
 * A service the test drives: each run is recorded (its context, when it started) and stays up
 * until the test crashes or ends it, or the supervisor stops it. `log` is the shared order of
 * starts and stops across services.
 */
function controlled(name: string, log: string[], options: Partial<Service> = {}) {
  const runs: {
    ctx: ServiceContext;
    at: number;
    crash: (e?: unknown) => void;
    end: () => void;
  }[] = [];
  const service = defineService({
    name,
    ...options,
    start: (ctx) =>
      new Promise<void>((resolve, reject) => {
        log.push(`start ${name}`);
        runs.push({
          ctx,
          at: Date.now(),
          crash: (e) => reject(e ?? new Error(`${name} crashed`)),
          end: resolve,
        });
        ctx.signal.addEventListener("abort", () => {
          log.push(`stop ${name}`);
          resolve();
        });
      }),
  });
  return { service, runs };
}

/** Three children a, b, c started under `strategy`, with the start log cleared. */
async function threeUnder(strategy: "one_for_all" | "rest_for_one") {
  const order: string[] = [];
  const [a, b, c] = ["a", "b", "c"].map((name) => controlled(name, order));
  const sup = supervise({
    children: [a.service, b.service, c.service],
    strategy,
    backoff: EXACT,
    log: false,
  });
  await sup.start();
  await vi.advanceTimersByTimeAsync(0);
  order.length = 0;
  return { order, a, b, c, sup };
}

/** Collect a supervisor's events. */
function events(): { log: (e: SupervisionEvent) => void; seen: SupervisionEvent[] } {
  const seen: SupervisionEvent[] = [];
  return { log: (e) => seen.push(e), seen };
}

describe("strategies", () => {
  it("one_for_one restarts only the crashed child, after the backoff", async () => {
    const order: string[] = [];
    const a = controlled("a", order);
    const b = controlled("b", order);
    const sup = supervise({
      name: "root",
      children: [a.service, b.service],
      backoff: EXACT,
      log: false,
    });
    await sup.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["start a", "start b"]);
    a.runs[0].crash();
    await vi.advanceTimersByTimeAsync(0);
    const status = sup.status();
    expect(status.children[0].state).toBe("restarting");
    expect(status.children[0].lastError?.message).toBe("Error: a crashed");
    expect(status.children[1].state).toBe("running");
    await vi.advanceTimersByTimeAsync(99);
    expect(a.runs.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.runs.length).toBe(2);
    expect(a.runs[1].ctx.attempt).toBe(2);
    expect(b.runs.length, "b is untouched").toBe(1);
    expect(b.runs[0].ctx.signal.aborted).toBe(false);
    expect(sup.status().children[0]).toMatchObject({ state: "running", restarts: 1 });
  });

  it("one_for_all stops every other child (reverse order), then restarts them all in order", async () => {
    const { order, b, sup } = await threeUnder("one_for_all");
    b.runs[0].crash();
    await vi.advanceTimersByTimeAsync(0);
    // The crashed child's own signal aborts first (whatever it left running is told to stop),
    // then the survivors stop last-started first.
    expect(order).toEqual(["stop b", "stop c", "stop a"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(order.slice(3)).toEqual(["start a", "start b", "start c"]);
    expect(sup.status().children.map((ch) => ch.restarts)).toEqual([1, 1, 1]);
  });

  it("rest_for_one restarts the crashed child and every child started after it", async () => {
    const { order, a, b } = await threeUnder("rest_for_one");
    b.runs[0].crash();
    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual(["stop b", "stop c", "start b", "start c"]);
    expect(a.runs.length, "a, started before b, is untouched").toBe(1);
    expect(a.runs[0].ctx.signal.aborted).toBe(false);
  });
});

describe("intensity", () => {
  it("more than `intensity` restarts within `period` fails the supervisor and reports at the top", async () => {
    const order: string[] = [];
    const a = controlled("a", order);
    const b = controlled("b", order);
    const onError = vi.fn();
    const { log, seen } = events();
    const sup = supervise({
      name: "root",
      children: [a.service, b.service],
      intensity: 2,
      period: 5_000,
      backoff: EXACT,
      onError,
      log,
    });
    await sup.start();
    const done = sup.done.then(() => "resolved", (e) => e);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(0);
      a.runs[i].crash();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const error = await done;
    expect(error).toBeInstanceOf(SupervisorError);
    expect((error as SupervisorError).path).toBe("root");
    expect((error as SupervisorError).message).toContain("more than 2 restart(s) within 5000 ms");
    expect(onError).toHaveBeenCalledWith(error);
    expect(sup.status().state).toBe("failed");
    expect(b.runs[0].ctx.signal.aborted, "giving up stops every child").toBe(true);
    expect(seen.map((e) => e.event)).toContain("escalate");
    expect(supervisionStatus().map((s) => s.state), "a failed top-level stays listed").toEqual([
      "failed",
    ]);
  });

  it("restarts spread wider than `period` never add up to a failure", async () => {
    const a = controlled("a", []);
    const sup = supervise({
      children: [a.service],
      intensity: 1,
      period: 1_000,
      backoff: EXACT,
      log: false,
    });
    await sup.start();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(0);
      a.runs[i].crash();
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(sup.status().state).toBe("running");
    expect(a.runs.length).toBe(6);
  });

  it("a nested supervisor's failure escalates to its parent, which restarts it", async () => {
    const order: string[] = [];
    const inner = controlled("inner-child", order);
    const sibling = controlled("sibling", order);
    const nested = supervise({
      name: "workers",
      children: [inner.service],
      intensity: 0,
      backoff: EXACT,
    });
    const onError = vi.fn();
    const { log, seen } = events();
    const root = supervise({
      name: "root",
      children: [nested, sibling.service],
      backoff: EXACT,
      onError,
      log,
    });
    await root.start();
    await vi.advanceTimersByTimeAsync(0);
    inner.runs[0].crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.some((e) => e.event === "escalate" && e.path === "root/workers")).toBe(true);
    expect(root.status().children[0]).toMatchObject({ path: "root/workers", state: "restarting" });
    await vi.advanceTimersByTimeAsync(100);
    expect(inner.runs.length, "the parent restarted the nested tree").toBe(2);
    expect(root.status().children[0]).toMatchObject({ state: "running", restarts: 1 });
    expect(onError, "only the top of the tree reports").not.toHaveBeenCalled();
    expect(sibling.runs.length).toBe(1);
  });
});

describe("backoff", () => {
  it("doubles per restart of the same child, capped", async () => {
    const a = controlled("a", []);
    const sup = supervise({
      children: [a.service],
      intensity: 10,
      period: 60_000,
      backoff: { initialMs: 100, maxMs: 500, jitter: 0 },
      log: false,
    });
    await sup.start();
    const crashedAt: number[] = [];
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(0);
      crashedAt.push(Date.now());
      a.runs[i].crash();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    // From each crash to the next start: 100, 200, 400, then the 500 ms cap.
    expect(a.runs.slice(1).map((r, i) => r.at - crashedAt[i])).toEqual([100, 200, 400, 500, 500]);
  });

  it("jitter takes up to its share off each delay", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const a = controlled("a", []);
    const sup = supervise({
      children: [a.service],
      backoff: { initialMs: 1_000, jitter: 0.5 },
      log: false,
    });
    await sup.start();
    await vi.advanceTimersByTimeAsync(0);
    a.runs[0].crash();
    await vi.advanceTimersByTimeAsync(749);
    expect(a.runs.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.runs.length, "1000 × (1 − 0.5 × 0.5) = 750 ms").toBe(2);
  });
});

describe("shutdown", () => {
  it("stops children in reverse start order, calling each `stop`, and resolves `done`", async () => {
    const order: string[] = [];
    const stops: string[] = [];
    const a = controlled("a", order, { stop: () => void stops.push("a") });
    const b = controlled("b", order, { stop: () => void stops.push("b") });
    const c = controlled("c", order, { stop: () => void stops.push("c") });
    const sup = supervise({ children: [a.service, b.service, c.service], log: false });
    await sup.start();
    await vi.advanceTimersByTimeAsync(0);
    order.length = 0;
    const done = sup.done.then(() => "resolved");
    await sup.stop();
    expect(order).toEqual(["stop c", "stop b", "stop a"]);
    expect(stops).toEqual(["c", "b", "a"]);
    expect(await done).toBe("resolved");
    expect(sup.status().children.map((ch) => ch.state)).toEqual(["stopped", "stopped", "stopped"]);
    expect(supervisionStatus(), "a stopped supervisor leaves the registry").toEqual([]);
    expect(vi.getTimerCount(), "no timer is left behind").toBe(0);
  });

  it("a child that ignores its signal is abandoned after `shutdownMs`, and the next one still stops", async () => {
    const order: string[] = [];
    const a = controlled("a", order);
    const stuck = defineService({
      name: "stuck",
      shutdownMs: 2_000,
      start: () => new Promise<void>(() => {}), // never settles, never listens
    });
    const { log, seen } = events();
    const sup = supervise({ children: [a.service, stuck], log });
    await sup.start();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    void sup.stop().then(() => stopped = true);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(stopped).toBe(false);
    expect(order).not.toContain("stop a");
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
    expect(order).toContain("stop a");
    expect(seen.find((e) => e.event === "give-up")?.error).toContain("did not stop within 2000 ms");
  });

  it("stopAllSupervisors stops every top-level tree, last-started first", async () => {
    const order: string[] = [];
    const first = supervise({
      name: "first",
      children: [controlled("a", order).service],
      log: false,
    });
    const second = supervise({
      name: "second",
      children: [controlled("b", order).service],
      log: false,
    });
    await first.start();
    await second.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisionStatus().map((s) => s.name)).toEqual(["first", "second"]);
    order.length = 0;
    await stopAllSupervisors();
    expect(order).toEqual(["stop b", "stop a"]);
  });

  it("a stop during a pending restart cancels it", async () => {
    const a = controlled("a", []);
    const sup = supervise({ children: [a.service], backoff: EXACT, log: false });
    await sup.start();
    await vi.advanceTimersByTimeAsync(0);
    a.runs[0].crash();
    await vi.advanceTimersByTimeAsync(0);
    await sup.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(a.runs.length).toBe(1);
    expect(sup.status().children[0].state).toBe("stopped");
  });
});

describe("restart policies and services", () => {
  it("`crash` (default) leaves a clean exit stopped; `always` restarts it; `never` leaves a crash failed", async () => {
    const order: string[] = [];
    const transient = controlled("transient", order);
    const permanent = controlled("permanent", order, { restart: "always" });
    const temporary = controlled("temporary", order, { restart: "never" });
    const sup = supervise({
      children: [transient.service, permanent.service, temporary.service],
      backoff: EXACT,
      log: false,
    });
    await sup.start();
    await vi.advanceTimersByTimeAsync(0);
    transient.runs[0].end();
    permanent.runs[0].end();
    temporary.runs[0].crash();
    await vi.advanceTimersByTimeAsync(100);
    expect(sup.status().children.map((ch) => ch.state)).toEqual(["stopped", "running", "failed"]);
    expect(permanent.runs.length).toBe(2);
  });

  it("`ctx.fail` crashes a service whose start promise is still pending; a sync throw is a crash", async () => {
    let fail!: (e: unknown) => void;
    let throws = 0;
    const holder = defineService({
      name: "holder",
      start: async (ctx) => {
        fail = ctx.fail;
        await ctx.stopped;
      },
    });
    const thrower = defineService({
      name: "thrower",
      restart: "never",
      start: () => {
        throws++;
        throw new Error("sync");
      },
    });
    const sup = supervise({ children: [holder, thrower], backoff: EXACT, log: false });
    await sup.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sup.status().children[1]).toMatchObject({
      state: "failed",
      lastError: { message: "Error: sync" },
    });
    fail(new Error("socket closed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sup.status().children[0]).toMatchObject({
      state: "restarting",
      lastError: { message: "Error: socket closed" },
    });
    expect(throws).toBe(1);
  });

  it("refuses malformed options and duplicate child names", () => {
    expect(() => defineService({} as never)).toThrow(/start/);
    expect(() => defineService({ start() {}, restart: "sometimes" as never })).toThrow(/restart/);
    const s = defineService({ name: "x", start() {} });
    expect(() => supervise({ children: [s, s] })).toThrow(/two children/);
    expect(() => supervise({ children: [], strategy: "simple" as never })).toThrow(/strategy/);
    expect(() => supervise({ children: [], intensity: -1 })).toThrow(/intensity/);
    expect(() => supervise({ children: [{} as never] })).toThrow(/neither/);
    const nested = supervise({ name: "n", children: [] });
    supervise({ children: [nested] });
    expect(() => supervise({ children: [nested] })).toThrow(/already has a supervisor/);
  });
});

describe("adapters", () => {
  it("jobService runs a job's loop as a service and restarts it when it throws", async () => {
    let runs = 0;
    registerJob(
      "consume",
      defineJob({
        handler: ({ signal }) => {
          runs++;
          if (runs === 1) throw new Error("queue unreachable");
          return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        },
      }),
    );
    const sup = supervise({ children: [jobService("consume")], backoff: EXACT, log: false });
    await sup.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toBe(2);
    expect(sup.status().children[0]).toMatchObject({
      name: "job:consume",
      state: "running",
      restarts: 1,
    });
  });

  it("sidecarService treats a sidecar that gave up as a crash and restarts it", async () => {
    const listeners = new Set<(s: SupervisableSidecar["status"]) => void>();
    let status: SupervisableSidecar["status"] = { state: "ready" };
    const set = (next: SupervisableSidecar["status"]) => {
      status = next;
      for (const fn of [...listeners]) fn(next);
    };
    const restart = vi.fn(() => {
      set({ state: "starting" });
      return Promise.resolve();
    });
    const stop = vi.fn(() => {
      set({ state: "stopped" });
      return Promise.resolve();
    });
    const sidecar: SupervisableSidecar = {
      name: "api",
      get status() {
        return status;
      },
      onStatus: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      restart,
      stop,
    };
    const sup = supervise({ children: [sidecarService(sidecar)], backoff: EXACT, log: false });
    await sup.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(restart, "a sidecar already up is adopted, not restarted").not.toHaveBeenCalled();
    set({ state: "failed", lastExit: { code: 3 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(sup.status().children[0]).toMatchObject({
      name: "sidecar:api",
      state: "restarting",
      lastError: { message: "Error: sidecar api failed: code 3" },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(restart).toHaveBeenCalledTimes(1);
    await sup.stop();
    expect(stop).toHaveBeenCalled();
    expect(listeners.size, "no listener is left behind").toBe(0);
  });
});

describe("restartLoop", () => {
  it("restarts with backoff, then gives up past maxRestarts within the period", async () => {
    const { log, seen } = events();
    const at: number[] = [];
    const outcome = restartLoop({
      path: "channel:x/k",
      signal: new AbortController().signal,
      policy: { maxRestarts: 2, period: 60_000, backoff: EXACT },
      log,
      run: () => {
        at.push(Date.now());
        throw new Error("down");
      },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toBe("gave-up");
    expect(at.map((t) => t - at[0])).toEqual([0, 100, 300]);
    expect(seen.map((e) => e.event)).toEqual([
      "crash",
      "restart",
      "crash",
      "restart",
      "crash",
      "give-up",
    ]);
  });

  it("an abort ends a pending backoff wait", async () => {
    const controller = new AbortController();
    let runs = 0;
    const outcome = restartLoop({
      path: "p",
      signal: controller.signal,
      policy: { maxRestarts: 5, period: 60_000, backoff: EXACT },
      log: () => {},
      run: () => {
        runs++;
        throw new Error("x");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await outcome).toBe("stopped");
    expect(runs).toBe(1);
  });
});
