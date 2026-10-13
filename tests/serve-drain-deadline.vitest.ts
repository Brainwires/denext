// The graceful-shutdown drain deadline (`installDrainDeadline`): a drain that outlasts it calls
// `onTimeout` (the server's forced exit), a drain that settles first cancels it, and `drainMs <= 0`
// waits forever. On Vitest's fake clock (denext's Deno toolchain; CONTRIBUTING.md → Vitest files),
// so each boundary is asserted to the millisecond instead of slept past. The wiring into a real
// server (`serveWithPortFallback`) is tests/serve-utils.test.ts.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDrainDeadline } from "../src/server/serve-utils.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A drain the test settles itself. */
function drain() {
  let settle!: () => void;
  let fail!: (err: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

it("fires onTimeout exactly at the deadline when the drain outlasts it, once", async () => {
  const onTimeout = vi.fn();
  installDrainDeadline(new Promise<void>(() => {}), 20, onTimeout);
  await vi.advanceTimersByTimeAsync(19);
  expect(onTimeout).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(onTimeout).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(onTimeout, "the deadline fires exactly once").toHaveBeenCalledTimes(1);
});

it("does NOT fire when the drain settles first, even a millisecond before", async () => {
  const onTimeout = vi.fn();
  const d = drain();
  installDrainDeadline(d.promise, 50, onTimeout);
  await vi.advanceTimersByTimeAsync(49);
  d.settle();
  await vi.advanceTimersByTimeAsync(0); // the drain's settlement runs the cancel
  expect(vi.getTimerCount(), "a completed drain cancels the deadline").toBe(0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(onTimeout).not.toHaveBeenCalled();
});

it("a drain that fails also cancels the deadline", async () => {
  const onTimeout = vi.fn();
  const d = drain();
  installDrainDeadline(d.promise, 50, onTimeout);
  d.fail(new Error("drain failed"));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(onTimeout).not.toHaveBeenCalled();
});

it("the returned cancel stops the deadline", async () => {
  const onTimeout = vi.fn();
  const cancel = installDrainDeadline(new Promise<void>(() => {}), 50, onTimeout);
  cancel();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(onTimeout).not.toHaveBeenCalled();
});

it("drainMs <= 0 (or NaN) waits indefinitely: nothing is armed", async () => {
  const onTimeout = vi.fn();
  for (const ms of [0, -1, Number.NaN]) {
    const cancel = installDrainDeadline(new Promise<void>(() => {}), ms, onTimeout);
    expect(vi.getTimerCount()).toBe(0);
    cancel(); // a no-op, but callable
  }
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(onTimeout).not.toHaveBeenCalled();
});
