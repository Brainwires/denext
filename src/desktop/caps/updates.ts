/**
 * The `updates` capability: the page drives the desktop app's own updates through
 * `denext/updates` (`checkForUpdates` / `applyUpdates`), where they otherwise run only in the Deno
 * process (`denext/desktop/updater`). Two targets:
 *
 * - `ui`: the signed UI overlay (`desktop.update.ui`, the same config `runDesktop` serves the
 *   overlay from): check, download into staging (every file's SHA-256 checked), then apply (an
 *   atomic pointer swap; the new UI is served from the next launch, under the boot watchdog).
 * - `app`: the whole signed app (`desktop.update.manifestUrl`, denext's pinned runtime): check,
 *   download (size-capped, SHA-256 checked, OS code signature verified), then install and relaunch.
 *
 * Every trust decision stays where it was: the overlay's signature, sequence and platform checks
 * in `updater.ts`, the full app's in the runtime (signature, no downgrade, expiry, replay, the same
 * signer). This capability only exposes them, with download progress pushed to the page as
 * `progress` events (`{ runId, target, stage: "downloading", version, percent }`; the page passes
 * its own `runId` so a replayed event from an earlier run is ignored).
 *
 * Runtime-only (imported by the caps resolver, never a client bundle).
 *
 * @module
 */

import { type DesktopCapability, type DesktopCapCtx, DesktopCapError } from "../extension.ts";
import type {
  DesktopUpdateCheck,
  DesktopUpdatePrepared,
  DesktopUpdaterConfig,
} from "../updater.ts";
import type {
  AppUpdateCheck,
  AppUpdateProgress,
  AppUpdaterConfig,
  AppUpdateStaged,
} from "../app-updater.ts";

/** What the capability updates: the UI overlay or the whole app. */
type DesktopUpdateTarget = "ui" | "app";

/** The UI-overlay updater calls the capability makes (injectable for tests). */
export interface UiUpdaterApi {
  /** `checkForDesktopUpdate`. */
  check(config: DesktopUpdaterConfig): Promise<DesktopUpdateCheck>;
  /** `prepareDesktopUpdate`. */
  prepare(config: DesktopUpdaterConfig): Promise<DesktopUpdatePrepared>;
  /** `applyDesktopUpdate`. */
  apply(version: string, config: DesktopUpdaterConfig): Promise<void>;
}

/** The full-app updater calls the capability makes (injectable for tests). */
export interface AppUpdaterApi {
  /** `checkForAppUpdate`. */
  check(config: AppUpdaterConfig): Promise<AppUpdateCheck>;
  /** `downloadAppUpdate`. */
  download(
    config: AppUpdaterConfig,
    options: { onProgress?: (progress: AppUpdateProgress) => void; signal?: AbortSignal },
  ): Promise<AppUpdateStaged>;
  /** `installAppUpdateAndRelaunch`. */
  install(): Promise<{ quitting: boolean }>;
}

/** Options for {@linkcode updatesCapability}. */
export interface UpdatesCapabilityOptions {
  /** The UI overlay's updater config (`desktop.update.ui`); absent: the `ui` target is off. */
  readonly ui?: DesktopUpdaterConfig;
  /** The full app's updater config (`desktop.update.manifestUrl`); absent: the `app` target is off. */
  readonly app?: AppUpdaterConfig;
  /** The overlay updater (tests pass a fake). */
  readonly uiApi?: UiUpdaterApi;
  /** The full-app updater (tests pass a fake). */
  readonly appApi?: AppUpdaterApi;
}

/** One target's answer to `check`, as the page receives it. */
type DesktopTargetCheck =
  /** The config does not set this target up. */
  | { readonly state: "unconfigured" }
  /** The runtime cannot do it (the full app outside denext's pinned runtime). */
  | { readonly state: "unsupported" }
  /** Nothing newer. */
  | { readonly state: "up-to-date" }
  /** A newer, verified version. */
  | {
    readonly state: "available";
    readonly version: string;
    readonly required: boolean;
    readonly notes: string | null;
  }
  /** The check failed; `code` is the updater's. */
  | { readonly state: "failed"; readonly code: string; readonly message: string };

// The real updaters are imported on first use, as `runDesktop` imports the overlay updater: an app
// that enables nothing here never loads them.
const uiUpdater = () => import("../updater.ts");
const appUpdater = () => import("../app-updater.ts");

/** The overlay updater over `updater.ts`. */
const UI_API: UiUpdaterApi = {
  check: async (config) => (await uiUpdater()).checkForDesktopUpdate(config),
  prepare: async (config) => (await uiUpdater()).prepareDesktopUpdate(config),
  apply: async (version, config) => (await uiUpdater()).applyDesktopUpdate(version, config),
};

/** The full-app updater over `app-updater.ts`. */
const APP_API: AppUpdaterApi = {
  check: async (config) => (await appUpdater()).checkForAppUpdate(config),
  download: async (config, options) => (await appUpdater()).downloadAppUpdate(config, options),
  install: async () => (await appUpdater()).installAppUpdateAndRelaunch(),
};

/** How far the download must move (in percent) before another `progress` event is pushed. */
const PROGRESS_STEP = 5;

/** A thrown value's `code`, when it is a non-empty string. */
function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

/**
 * A failure as the error the page receives: the updater's own code and message (they name a
 * version, a manifest field or a file inside the update, never a local path), except an `io`
 * failure (a file-system error that can name the install), which gets a fixed message. The code
 * `unavailable` is the bridge's (the capability is off), so an updater never answers it.
 */
function capError(err: unknown): DesktopCapError {
  if (err instanceof DesktopCapError) return err;
  const code = codeOf(err);
  if (code === undefined || code === "unavailable") {
    return new DesktopCapError("failed", "the update failed", { status: 500 });
  }
  const message = code === "io" || !(err instanceof Error) ? "the update failed" : err.message;
  return new DesktopCapError(code, message);
}

/** The `target` argument, or a `validation` error. */
function targetArg(args: unknown): DesktopUpdateTarget {
  const target = (args as { target?: unknown } | null)?.target;
  if (target !== "ui" && target !== "app") {
    throw new DesktopCapError("validation", 'target must be "ui" or "app"');
  }
  return target;
}

/** The `runId` argument (a short string the page picks), or `null`. */
function runIdArg(args: unknown): string | null {
  const runId = (args as { runId?: unknown } | null)?.runId;
  return typeof runId === "string" && runId.length > 0 && runId.length <= 64 ? runId : null;
}

/** The overlay's check, as the page sees it. */
async function checkUi(
  config: DesktopUpdaterConfig | undefined,
  api: UiUpdaterApi,
): Promise<DesktopTargetCheck> {
  if (!config) return { state: "unconfigured" };
  try {
    const found = await api.check(config);
    if (!found.available || found.version === undefined) return { state: "up-to-date" };
    return {
      state: "available",
      version: found.version,
      required: found.required === true,
      notes: typeof found.notes === "string" ? found.notes : null,
    };
  } catch (err) {
    const e = capError(err);
    return { state: "failed", code: e.code, message: e.message };
  }
}

/** The full app's check, as the page sees it. */
async function checkApp(
  config: AppUpdaterConfig | undefined,
  api: AppUpdaterApi,
): Promise<DesktopTargetCheck> {
  if (!config) return { state: "unconfigured" };
  try {
    const found = await api.check(config);
    if (!found.available) return { state: "up-to-date" };
    return {
      state: "available",
      version: found.version,
      required: found.required,
      notes: found.releaseNotes,
    };
  } catch (err) {
    if (codeOf(err) === "unsupported") return { state: "unsupported" };
    const e = capError(err);
    return { state: "failed", code: e.code, message: e.message };
  }
}

/** A `progress` event pusher for one download: throttled to {@linkcode PROGRESS_STEP} percent. */
function progressPusher(
  ctx: DesktopCapCtx,
  runId: string | null,
  target: DesktopUpdateTarget,
  version: string,
): (percent: number) => void {
  let last = -PROGRESS_STEP;
  return (percent) => {
    const p = Math.max(0, Math.min(100, Math.floor(percent)));
    if (p < 100 && p - last < PROGRESS_STEP) return;
    if (p === last) return;
    last = p;
    ctx.emit("progress", { runId, target, stage: "downloading", version, percent: p });
  };
}

/** One in-flight download or apply per target: a second answers `busy`. */
function exclusive(): <T>(target: DesktopUpdateTarget, run: () => Promise<T>) => Promise<T> {
  const running = new Set<DesktopUpdateTarget>();
  return async (target, run) => {
    if (running.has(target)) {
      throw new DesktopCapError("busy", `an update of the ${target} is already in progress`);
    }
    running.add(target);
    try {
      return await run();
    } finally {
      running.delete(target);
    }
  };
}

/** The target's config, or a `not_configured` error. */
function configured<C>(config: C | undefined, target: DesktopUpdateTarget): C {
  if (config === undefined) {
    throw new DesktopCapError(
      "not_configured",
      target === "ui"
        ? "UI updates are not configured (desktop.update.ui)"
        : "full-app updates are not configured (desktop.update.manifestUrl)",
    );
  }
  return config;
}

/** What `download` answers: the staged version, or nothing newer. */
type DownloadResult =
  | { readonly state: "up-to-date" }
  | {
    readonly state: "ready";
    readonly version: string;
    readonly required: boolean;
    readonly notes: string | null;
  };

/** Stage a newer overlay: check, then download every file into staging. */
async function downloadUi(
  config: DesktopUpdaterConfig,
  api: UiUpdaterApi,
  push: (version: string) => (percent: number) => void,
): Promise<DownloadResult> {
  const found = await api.check(config);
  if (!found.available || found.version === undefined) return { state: "up-to-date" };
  const progress = push(found.version);
  progress(0);
  const staged = await api.prepare(config);
  progress(100);
  return {
    state: "ready",
    version: staged.version,
    required: staged.required,
    notes: staged.notes,
  };
}

/** Stage a newer app: check (the runtime keeps what it found), then download and verify it. */
async function downloadApp(
  config: AppUpdaterConfig,
  api: AppUpdaterApi,
  push: (version: string) => (percent: number) => void,
  signal: AbortSignal,
): Promise<DownloadResult> {
  const found = await api.check(config);
  if (!found.available) return { state: "up-to-date" };
  const progress = push(found.version);
  progress(0);
  const staged = await api.download(config, {
    onProgress: ({ transferred, total }) => {
      if (total > 0) progress((transferred / total) * 100);
    },
    signal,
  });
  progress(100);
  return {
    state: "ready",
    version: staged.version,
    required: found.required,
    notes: found.releaseNotes,
  };
}

/**
 * Build the `updates` capability.
 *
 * @param options The overlay and full-app configs (each target is off without its own), and the
 * updaters (tests).
 * @returns The capability: `check`, `download` (with `progress` events) and `apply`.
 */
export function updatesCapability(options: UpdatesCapabilityOptions = {}): DesktopCapability {
  const uiApi = options.uiApi ?? UI_API;
  const appApi = options.appApi ?? APP_API;
  const once = exclusive();
  return {
    name: "updates",
    events: ["progress"],
    methods: {
      // Two manifest fetches, each with the updaters' own 30 s timeout.
      check: {
        timeoutMs: 90_000,
        handler: async () => {
          const [ui, app] = await Promise.all([
            checkUi(options.ui, uiApi),
            checkApp(options.app, appApi),
          ]);
          return { ui, app };
        },
      },
      // An app archive can take minutes: no bridge timeout (a page reload aborts it).
      download: {
        timeoutMs: false,
        permissions: { write: ["$APPDATA"] },
        handler: async (args, ctx) => {
          const target = targetArg(args);
          const runId = runIdArg(args);
          const push = (version: string) => progressPusher(ctx, runId, target, version);
          return await once(target, async () => {
            try {
              return target === "ui"
                ? await downloadUi(configured(options.ui, "ui"), uiApi, push)
                : await downloadApp(configured(options.app, "app"), appApi, push, ctx.signal);
            } catch (err) {
              throw capError(err);
            }
          });
        },
      },
      apply: {
        permissions: { write: ["$APPDATA"] },
        handler: async (args) => {
          const target = targetArg(args);
          return await once(target, async () => {
            try {
              if (target === "app") {
                configured(options.app, "app");
                const { quitting } = await appApi.install();
                return { quitting: quitting === true, restartRequired: false };
              }
              const version = (args as { version?: unknown }).version;
              if (typeof version !== "string" || version === "") {
                throw new DesktopCapError("validation", "version must be the staged version");
              }
              await uiApi.apply(version, configured(options.ui, "ui"));
              // The overlay is served from the next launch (the boot watchdog confirms it then).
              return { quitting: false, restartRequired: true };
            } catch (err) {
              throw capError(err);
            }
          });
        },
      },
    },
  };
}
