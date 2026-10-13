// The timer-driven half of the jobs runtime — the userland minute scheduler and the retry
// backoff — on Vitest's fake clock (denext's Deno toolchain; see CONTRIBUTING.md → Vitest files).
// Timers fire only when a test advances the clock, and `Date` moves with it, so every wait is
// exact: no sleeps, no hand-rolled clock, and a 24-day backoff costs nothing to wait out.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearJobs,
  defineJob,
  type JobRunRecord,
  registerJob,
  runJob,
  scheduleJobs,
  setJobRecorder,
} from "../src/server/jobs.ts";

/** 20 s into a minute, so the first matching minute is 40 s away. */
const START = new Date("2026-01-01T00:00:20Z");
/** The longest delay a timer can hold (2^31-1 ms, ~24.8 days). */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

beforeEach(() => {
  clearJobs();
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  setJobRecorder(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A job whose every run blocks until the test releases it, recording the run's signal. */
function blockingJob() {
  const runs: { signal: AbortSignal; release: () => void }[] = [];
  const job = defineJob({
    handler: ({ signal }) =>
      new Promise<void>((release) => {
        runs.push({ signal, release });
      }),
  });
  return { job, runs };
}

/** A job that always fails, logging the fake-clock time of each attempt. */
function failingJob(retry: Parameters<typeof defineJob>[0]["retry"]) {
  const at: number[] = [];
  const job = defineJob({
    retry,
    handler: () => {
      at.push(Date.now());
      throw new Error(`attempt ${at.length}`);
    },
  });
  return { job, at };
}

/** The gaps between consecutive attempt times. */
const gaps = (at: number[]) => at.slice(1).map((t, i) => t - at[i]);

describe("userland scheduler", () => {
  it("never fires on registration, once per matching minute, never overlapping, aborted on dispose", async () => {
    const { job, runs } = blockingJob();
    registerJob("job", job);
    const dispose = scheduleJobs([{ cron: "* * * * *", job: "job" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs.length, "Deno.cron never fires on registration; neither does this").toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs.length, "the next minute fires the job once").toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs.length, "a still-running instance is not started again").toBe(1);
    runs[0].release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs.length, "once it finished, the next matching minute fires").toBe(2);
    expect(runs[1].signal.aborted).toBe(false);
    dispose();
    expect(runs[1].signal.aborted, "dispose aborts the in-flight run's signal").toBe(true);
    runs[1].release();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs.length, "and the tick is stopped").toBe(2);
    expect(vi.getTimerCount(), "no timer is left behind").toBe(0);
  });

  it("fires on the minute boundary itself, not a tick later", async () => {
    const { job, runs } = blockingJob();
    registerJob("job", job);
    const dispose = scheduleJobs([{ cron: "* * * * *", job: "job" }]);
    await vi.advanceTimersByTimeAsync(39_999); // 00:00:59.999
    expect(runs.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1); // 00:01:00.000
    expect(runs.length).toBe(1);
    runs[0].release();
    dispose();
  });

  it("a step expression fires only on its own minutes", async () => {
    const fired: string[] = [];
    registerJob("five", defineJob({ handler: () => void fired.push(new Date().toISOString()) }));
    const dispose = scheduleJobs([{ cron: "*/5 * * * *", job: "five" }]);
    await vi.advanceTimersByTimeAsync(16 * 60_000); // to 00:16:20
    expect(fired).toEqual([
      "2026-01-01T00:05:00.000Z",
      "2026-01-01T00:10:00.000Z",
      "2026-01-01T00:15:00.000Z",
    ]);
    dispose();
  });

  it("a wall clock stepped backwards does not re-fire an already-run minute", async () => {
    const { job, runs } = blockingJob();
    registerJob("job", job);
    const dispose = scheduleJobs([{ cron: "* * * * *", job: "job" }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs.length).toBe(1);
    runs[0].release();
    // An NTP correction steps the wall clock back two minutes; the timers keep their schedule.
    vi.setSystemTime(Date.now() - 120_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs.length, "a minute that already fired is not fired again").toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs.length, "…nor is the last fired minute itself, reached a second time").toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs.length, "the first minute past it fires as usual").toBe(2);
    runs[1].release();
    dispose();
  });

  it("the overlap guard treats a retrying run as still running", async () => {
    let starts = 0;
    registerJob(
      "job",
      defineJob({
        retry: { attempts: 3, backoff: 90_000 },
        handler: ({ attempt }) => {
          if (attempt === 1) starts++;
          throw new Error("x");
        },
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dispose = scheduleJobs([{ cron: "* * * * *", job: "job" }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(starts).toBe(1);
    // Three retries 90 s apart (270 s): the minutes that match meanwhile start nothing new.
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(starts, "a retrying run is not overlapped").toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(starts, "once its retries ran out, the next minute fires").toBe(2);
    expect(console.error).toHaveBeenCalled(); // the exhausted run's error is reported
    dispose();
  });
});

describe("retry backoff", () => {
  it("waits exactly the backoff between attempts (exponential, capped)", async () => {
    const { job, at } = failingJob({ attempts: 4, backoff: { delayMs: 100, maxDelayMs: 300 } });
    registerJob("exp", job);
    const done = runJob("exp").catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(at.length).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(at.length, "not a millisecond early").toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(at.length).toBe(2);
    await vi.runAllTimersAsync();
    expect(((await done) as Error).message).toBe("attempt 5");
    expect(gaps(at)).toEqual([100, 200, 300, 300]);
  });

  it("a fixed backoff waits the same delay every time", async () => {
    const { job, at } = failingJob({ attempts: 2, backoff: { strategy: "fixed", delayMs: 50 } });
    registerJob("fixed", job);
    const done = runJob("fixed").catch(() => {});
    await vi.runAllTimersAsync();
    await done;
    expect(gaps(at)).toEqual([50, 50]);
  });

  it("the default backoff doubles from 1 s", async () => {
    const { job, at } = failingJob({ attempts: 4 });
    registerJob("default", job);
    const done = runJob("default").catch(() => {});
    await vi.runAllTimersAsync();
    await done;
    expect(gaps(at)).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("the default cap is five minutes", async () => {
    const { job, at } = failingJob({ attempts: 4, backoff: { delayMs: 100_000 } });
    registerJob("capped", job);
    const done = runJob("capped").catch(() => {});
    await vi.runAllTimersAsync();
    await done;
    expect(gaps(at)).toEqual([100_000, 200_000, 300_000, 300_000]);
  });

  it("a backoff past setTimeout's 2^31-1 ms limit is clamped to it: it waits, then retries", async () => {
    for (const backoff of [2 ** 32, { delayMs: 2 ** 32, maxDelayMs: 2 ** 33 }]) {
      clearJobs();
      const { job, at } = failingJob({ attempts: 1, backoff });
      registerJob("long", job);
      const done = runJob("long").catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000); // a day
      expect(at.length, `backoff ${JSON.stringify(backoff)} retried early`).toBe(1);
      await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY - 24 * 60 * 60_000);
      expect(at.length).toBe(2);
      expect(await done).toBe("attempt 2");
      expect(gaps(at)).toEqual([MAX_TIMER_DELAY]);
    }
  });

  it("an abort during the backoff stops retrying with the last error, recorded as final", async () => {
    const { job, at } = failingJob({ attempts: 5, backoff: 60_000 });
    registerJob("slow", job);
    const seen: JobRunRecord[] = [];
    setJobRecorder((r) => seen.push(r));
    const controller = new AbortController();
    const done = runJob("slow", undefined, { signal: controller.signal }).catch((e: Error) =>
      e.message
    );
    await vi.advanceTimersByTimeAsync(30_000); // halfway through the first wait
    controller.abort();
    expect(await done).toBe("attempt 1");
    expect(at.length).toBe(1);
    expect(vi.getTimerCount(), "the aborted wait's timer is cleared").toBe(0);
    expect(seen.map((r) => [r.attempt, r.willRetry])).toEqual([[1, false]]);
  });
});
