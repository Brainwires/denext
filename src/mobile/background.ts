/**
 * Background tasks for `denext/mobile`: periodic work that runs while the app is in the
 * background (or not running at all), through Capacitor's official Background Runner
 * (`@capacitor/background-runner`, installed by `denext mobile add background`).
 *
 * Each task is a module in the project's `background/` folder whose default export is a
 * {@linkcode defineBackgroundTask}. `denext export` bundles them into one runner script
 * (`denext-background.js` in the export) that the plugin runs in its own headless JavaScript
 * engine: no DOM, no `window`, no page state, only `fetch`, timers, `crypto`,
 * `TextEncoder`/`TextDecoder`, `console` and the runner's `Capacitor*` globals. The OS decides
 * when it runs (see the docs' platform limits); denext runs every task whose `interval` has
 * passed each time it does.
 *
 * @module
 */

import { nativePlugin } from "./plugin.ts";

/** The key/value store a task sees: UserDefaults on iOS, SharedPreferences on Android. */
export interface BackgroundKeyValue {
  /** The stored string, or `null`. */
  get(key: string): string | null;
  /** Store a string. */
  set(key: string, value: string): void;
  /** Remove a key. */
  remove(key: string): void;
}

/** What a task's handler receives. */
export interface BackgroundTaskContext {
  /** The task's name. */
  readonly name: string;
  /**
   * Why it runs: `"schedule"` (the OS woke the runner) or `"dispatch"` (the page called
   * {@linkcode runBackgroundTask}).
   */
  readonly trigger: "schedule" | "dispatch";
  /** What {@linkcode runBackgroundTask} passed; `{}` for a scheduled run. */
  readonly details: Readonly<Record<string, unknown>>;
  /** A persistent string store shared by every task (and kept between runs). */
  readonly kv: BackgroundKeyValue;
  /**
   * When the run must be done, as a `Date.now()` value: about 25 s after it started, inside
   * iOS's ~30 s budget. Stop starting new work after it.
   */
  readonly deadline: number;
}

/** A task, as {@linkcode defineBackgroundTask} returns it (the module's default export). */
export interface BackgroundTask {
  /** Its name: letters, digits, `-` and `_`, starting with a letter; unique in the app. */
  readonly name: string;
  /**
   * The least time between runs, in minutes (at least 15: Android's WorkManager floor; iOS
   * treats it as a hint). Default 15.
   */
  readonly interval: number;
  /** The work. A rejection is logged and the task retried at its next due run. */
  readonly handler: (context: BackgroundTaskContext) => void | Promise<void>;
}

/** The input to {@linkcode defineBackgroundTask}. */
export interface BackgroundTaskDefinition {
  /** See {@linkcode BackgroundTask.name}. */
  readonly name: string;
  /** See {@linkcode BackgroundTask.interval}. */
  readonly interval?: number;
  /** See {@linkcode BackgroundTask.handler}. */
  readonly handler: (context: BackgroundTaskContext) => void | Promise<void>;
}

/** The runner label `denext mobile add background` configures (and iOS's task identifier). */
export const BACKGROUND_RUNNER_LABEL = "dev.denext.background";

/** A task name, as the runner's event names allow. */
const TASK_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Declare a background task: the default export of a `background/<name>.ts` module.
 *
 * @param definition The name, the interval in minutes (≥ 15, default 15) and the handler.
 * @returns The task (validated), for `export default`.
 * @throws TypeError for a bad name, an interval under 15 minutes, or a missing handler.
 * @example
 * ```ts
 * // background/sync-inbox.ts
 * import { defineBackgroundTask } from "denext/mobile";
 *
 * export default defineBackgroundTask({
 *   name: "sync-inbox",
 *   interval: 30,
 *   handler: async ({ kv }) => {
 *     const since = kv.get("inbox:since") ?? "0";
 *     const res = await fetch(`https://api.example.com/inbox?since=${since}`);
 *     const { unread, cursor } = await res.json();
 *     kv.set("inbox:since", String(cursor));
 *     kv.set("inbox:unread", String(unread));
 *   },
 * });
 * ```
 */
export function defineBackgroundTask(definition: BackgroundTaskDefinition): BackgroundTask {
  const { name, handler } = definition;
  if (typeof name !== "string" || !TASK_NAME.test(name)) {
    throw new TypeError(
      `defineBackgroundTask: name ${JSON.stringify(name)} must be letters, digits, "-" or "_", ` +
        "starting with a letter",
    );
  }
  const interval = definition.interval ?? 15;
  if (!Number.isFinite(interval) || interval < 15) {
    throw new TypeError(
      `defineBackgroundTask(${name}): interval is in minutes and at least 15 (Android's floor)`,
    );
  }
  if (typeof handler !== "function") {
    throw new TypeError(`defineBackgroundTask(${name}): handler must be a function`);
  }
  return { name, interval, handler };
}

/** The JS side of `@capacitor/background-runner` used from the page. */
interface BackgroundRunnerPlugin {
  dispatchEvent(options: {
    label: string;
    event: string;
    details: Record<string, unknown>;
  }): Promise<unknown>;
}

/**
 * Run one background task now, from the page, in the runner's engine (for example after a
 * sign-in, to warm the cache a later background run will extend). The task runs whatever its
 * interval; its handler sees `trigger: "dispatch"` and `details`.
 *
 * @param name The task's name.
 * @param details JSON-serialisable input for the handler.
 * @returns `true` when the runner ran it, `false` off the native shell or without the plugin.
 * It rejects when the task throws or does not exist.
 * @example
 * ```ts
 * import { runBackgroundTask } from "denext/mobile";
 * await runBackgroundTask("sync-inbox", { reason: "signed-in" });
 * ```
 */
export async function runBackgroundTask(
  name: string,
  details: Record<string, unknown> = {},
): Promise<boolean> {
  const plugin = nativePlugin<BackgroundRunnerPlugin>("CapacitorBackgroundRunner", [
    "dispatchEvent",
  ]);
  if (!plugin) return false;
  await plugin.dispatchEvent({ label: BACKGROUND_RUNNER_LABEL, event: name, details });
  return true;
}
