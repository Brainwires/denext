// Discovery for the `jobs/` directory: scan it, import each module, and register its
// default-exported {@linkcode Job}. Kept separate from `./jobs.ts` (the runtime core that user
// job files import `defineJob` from) so that core stays free of the filesystem walk. Runtime
// discovery — like route discovery, denext imports job modules from source at server boot, so no
// build manifest is needed.

import { join } from "@std/path";
import {
  abortJobRuns,
  collectSchedules,
  isJob,
  markJobsDiscovered,
  registerJob,
  scheduleJobs,
  setJobRecorder,
} from "./jobs.ts";
import { JOB_HISTORY_DB, type JobHistoryStore, sqliteJobHistoryStore } from "./job-history.ts";
import type { JobHistoryConfig } from "./config.ts";
import { inRootContext } from "./root-context.ts";
import { guardLegacyMigrateJob } from "./legacy-migrate-job.ts";
import { importModules } from "./module-walk.ts";

/**
 * Discover `jobs/**` under `jobsDir`, import each module, and register the job it
 * default-exports (or names `job`). Returns the discovered names, sorted. A missing directory is
 * fine (returns `[]`); a module that fails to load or lacks a `defineJob` default export is logged
 * and skipped — a bad job file never takes the server down.
 */
export async function discoverJobs(jobsDir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const { rel, name, path, mod } of importModules(jobsDir, "job")) {
    const job = mod.default ?? mod.job;
    if (isJob(job)) {
      registerJob(
        name,
        name === "migrate"
          ? guardLegacyMigrateJob(
            job,
            await Deno.readTextFile(path),
            join(jobsDir, "..", "migrations"),
          )
          : job,
      );
      found.push(name);
    } else {
      console.error(
        `denext: jobs/${rel} does not default-export defineJob(...) — skipped`,
      );
    }
  }
  return found.sort();
}

/**
 * Boot the scheduled-jobs subsystem at server startup: discover `<projectDir>/jobs/**`, then
 * register every schedule (per-job + `config.scheduledJobs`) with `Deno.cron` or the userland
 * scheduler. A no-op — and no log — when the app defines no jobs and no schedules. Returns a
 * disposer that stops the scheduler (for the dev server's re-boots / graceful shutdown).
 */
export async function bootScheduledJobs(
  projectDir: string,
  config: {
    scheduledJobs?: Record<string, string | string[]>;
    jobs?: HistoryConfigSlice;
  } | undefined,
  outDir?: string,
): Promise<() => void> {
  // Before the early return on purpose: an app with no jobs/ directory and no config schedules
  // can still register jobs programmatically and call `runJob` from a route handler, and those
  // runs belong in the history too. Installing costs nothing — the handle opens on the first run.
  const stopRecording = startRunHistory(config, outDir ?? join(projectDir, ".denext"));
  const names = await discoverJobs(join(projectDir, "jobs"));
  markJobsDiscovered(); // a cron the entrypoint registered early (registerCronSchedules) may run

  const entries = collectSchedules(config?.scheduledJobs);
  if (names.length === 0 && entries.length === 0) return stopRecording;
  const dispose = scheduleJobs(entries);
  console.log(
    `  ${names.length} job(s)` +
      (entries.length ? `, ${entries.length} schedule(s) registered` : " (no schedules)"),
  );
  return () => {
    dispose();
    abortJobRuns(); // on-demand runs (`runJob` from a route handler) stop with the scheduler
    stopRecording();
  };
}

/** The part of the config the history wiring reads. */
type HistoryConfigSlice = { history?: boolean | JobHistoryConfig; historyMaxRuns?: number };

/**
 * The configured history store, or `null` when history is off. `custom` says whether the app
 * passed its own (`jobs: { history: { store } }`) — denext owns only the default one.
 *
 * Not re-exported from `server/mod.ts`: denext's own wiring (`denext job --history` and the
 * server boot share it).
 *
 * @param config The project config (only `jobs` is read).
 * @param outDir The build directory the default database lives in.
 * @returns The store and whose it is, or `null`.
 */
export function historyStoreFor(
  config: { jobs?: HistoryConfigSlice } | undefined,
  outDir: string,
): { store: JobHistoryStore; custom: boolean } | null {
  const history = config?.jobs?.history;
  if (history === true) {
    return {
      store: sqliteJobHistoryStore({
        path: join(outDir, JOB_HISTORY_DB),
        maxRuns: config?.jobs?.historyMaxRuns,
      }),
      custom: false,
    };
  }
  if (!history || typeof history !== "object") return null;
  if (history.store) return { store: history.store, custom: true };
  return {
    store: sqliteJobHistoryStore({
      path: join(outDir, JOB_HISTORY_DB),
      maxRuns: history.maxRuns ?? config?.jobs?.historyMaxRuns,
    }),
    custom: false,
  };
}

/** Whether the config turns history on (`true`, or the object form). */
export function historyEnabled(config: { jobs?: HistoryConfigSlice } | undefined): boolean {
  const history = config?.jobs?.history;
  return history === true || (!!history && typeof history === "object");
}

/**
 * Install the run recorder when — and only when — the project asked for it.
 *
 * Exported for `denext job <name>`, which never boots the scheduler and would otherwise record
 * nothing — the one place a human is most likely to look for a manual run. Not re-exported from
 * `server/mod.ts`: it is denext's own wiring, not an app's extension point.
 *
 * This is where "off by default" is decided, deliberately at boot rather than inside `runJob`:
 * a low-level function should not be loading config, and reading it once here means every
 * in-process `runJob` records, whether it came from the scheduler, a route handler or an action.
 *
 * The recorder never waits on the store and swallows anything it throws or rejects with: a run
 * is never failed or delayed by its own bookkeeping, whatever store the app configured.
 *
 * @param config The project config (only `jobs` is read).
 * @param outDir The build directory the default database lives in.
 * @param options `closeCustom`: the disposer also waits for the last writes and closes an
 *   app-supplied store (a one-shot `denext job` process, which ends right after). The server
 *   never closes one: a dev re-boot installs the same config's store again.
 * @returns A function that stops recording and closes the default store. A no-op when history
 *   is off.
 */
export function startRunHistory(
  config: { jobs?: HistoryConfigSlice } | undefined,
  outDir: string,
  options: { closeCustom?: boolean } = {},
): () => Promise<void> {
  const off = () => Promise.resolve();
  if (!historyEnabled(config)) return off;
  if (onDenoDeploy()) {
    // Not refused: the app explicitly asked. But the file is per-isolate and ephemeral there, so
    // what the panel shows is one isolate's fragment that resets when it cycles — and a history
    // that is quietly wrong is worse than none. A latch cannot help, because the write SUCCEEDS.
    // A custom store (Postgres) is shared, so the warning is for the default file only.
    const history = config?.jobs?.history;
    if (!(history && typeof history === "object" && history.store)) {
      console.warn(
        "denext: jobs.history is on, but this is Deno Deploy — .denext/jobs.db is per-isolate " +
          "and ephemeral, so the history you see is one isolate's fragment and resets when it cycles.",
      );
    }
  }
  try {
    const resolved = historyStoreFor(config, outDir);
    if (!resolved) return off;
    const { store, custom } = resolved;
    const pending = new Set<Promise<unknown>>();
    setJobRecorder((run) => {
      try {
        // In the root context, whatever store it is: `runJob` may run inside a request, and a
        // store's lazily opened connection or timer must not carry that request along.
        const result = inRootContext(() => store.record(run));
        if (result && typeof (result as Promise<void>).then === "function") {
          const settled = Promise.resolve(result).catch(() => {}).finally(() =>
            pending.delete(settled)
          );
          pending.add(settled);
        }
      } catch { /* a store that throws loses its row, never the run */ }
    });
    return async () => {
      setJobRecorder(null);
      if (custom && !options.closeCustom) return;
      try {
        await Promise.all(pending);
        await store.close?.();
      } catch { /* closing history is never worth a failed shutdown */ }
    };
  } catch {
    // Installing history is never worth failing a boot over.
    return off;
  }
}

/** Whether this process is running on Deno Deploy. */
function onDenoDeploy(): boolean {
  try {
    return Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined;
  } catch {
    return false; // no --allow-env: not Deploy, as far as we can tell
  }
}
