/**
 * The shapes `denext/updates` shares across platforms (re-exported from {@link ./mod.ts}).
 *
 * @module
 */

import type { OtaCheckOptions } from "../mobile/ota.ts";
import type { RuntimePlatform } from "../mobile/bridge.ts";

/**
 * What an update replaces:
 *
 * - `ui`: the app's web UI without a new binary (a phone's over-the-air UI, a Deno Desktop app's
 *   signed UI overlay);
 * - `app`: the whole Deno Desktop app (a new signed build, installed and relaunched);
 * - `web`: the page in a browser (a newer deploy, picked up by reloading).
 */
export type UpdateTarget = "ui" | "app" | "web";

/**
 * Where one target's update is:
 *
 * - `checking`: asking the server what it offers;
 * - `downloading`: fetching and verifying it (`percent` when the platform reports it);
 * - `ready`: downloaded and verified, not yet switched to;
 * - `applying`: switching (the page reloads, or the app relaunches, right after);
 * - `done`: switched, where the page keeps running (a desktop UI overlay serves from the next
 *   launch);
 * - `up-to-date`: nothing newer;
 * - `failed`: see `error` and `code`.
 */
export type UpdateStage =
  | "checking"
  | "downloading"
  | "ready"
  | "applying"
  | "done"
  | "up-to-date"
  | "failed";

/** One progress report from `applyUpdates`, the same shape on every platform. */
export interface UpdateProgress {
  /** What is being updated. */
  readonly target: UpdateTarget;
  /** How far it got. */
  readonly stage: UpdateStage;
  /** The version being installed, once known. */
  readonly version?: string;
  /** Download progress, 0–100, where the platform reports it (a desktop download). */
  readonly percent?: number;
  /** Why it failed (`stage: "failed"`). */
  readonly error?: string;
  /** The machine-readable reason it failed (`stage: "failed"`), e.g. `signature`, `downgrade`. */
  readonly code?: string;
}

/** An update the server offers, verified where the platform verifies before installing. */
export interface AvailableUpdate {
  /** What it replaces. */
  readonly target: UpdateTarget;
  /** The offered version. */
  readonly version: string;
  /** The release says the user may not decline it. */
  readonly required: boolean;
  /** The release notes, or `null`. */
  readonly notes: string | null;
}

/** A target that could not be checked or installed. */
export interface UpdateFailure {
  /** The target. */
  readonly target: UpdateTarget;
  /**
   * The machine-readable reason: the platform updater's own code (`signature`, `downgrade`,
   * `expired`, `network`, …), or `not_configured`, `unavailable` (the desktop `updates`
   * capability is not enabled), `unsupported`, `no_version` (the web build has no version to read).
   */
  readonly code: string;
  /** A human-readable reason. */
  readonly message: string;
}

/** What `checkForUpdates` found. */
export interface UpdatesCheck {
  /** The platform it ran on (`runtimePlatform()`). */
  readonly platform: RuntimePlatform;
  /** Whether anything newer is offered (`updates` is not empty). */
  readonly available: boolean;
  /** Each newer version on offer, UI first. */
  readonly updates: readonly AvailableUpdate[];
  /**
   * The server's UI needs a newer app binary than this one (a phone's `native_too_old` /
   * `native_mismatch`): only a store update brings it. Prompt for one (`promptStoreUpdate`).
   */
  readonly needsStoreUpdate: boolean;
  /** Targets that could not be checked. */
  readonly failures: readonly UpdateFailure[];
}

/** What `applyUpdates` did, when it returns (a reload or relaunch never returns). */
export interface UpdatesResult {
  /** The platform it ran on. */
  readonly platform: RuntimePlatform;
  /** The updates installed. */
  readonly applied: readonly AvailableUpdate[];
  /**
   * An installed update takes effect at the next launch (a desktop UI overlay): offer a restart
   * (`quitApp()` from `denext/desktop/window`).
   */
  readonly restartRequired: boolean;
  /** As in {@linkcode UpdatesCheck.needsStoreUpdate}. */
  readonly needsStoreUpdate: boolean;
  /** Targets that failed. */
  readonly failures: readonly UpdateFailure[];
}

/** How a browser tab learns that a newer build is deployed. */
export interface WebUpdatesConfig {
  /**
   * The URL of the deployed build's version: a `_denext/ota.json` manifest (its `version`; what
   * `spa.ota: true` or `denext ota manifest` writes), JSON with a string `version` or `buildId`,
   * or plain text. Default `"/_denext/ota.json"`.
   */
  readonly versionUrl?: string;
  /**
   * The version this page was built as. Default: the version read the first time this page asks
   * (kept for the page's lifetime), so check once early, at startup.
   */
  readonly currentVersion?: string;
  /** The `fetch` to use (default the global one). */
  readonly fetch?: typeof fetch;
  /** Request timeout in ms. Default 15 000. */
  readonly timeoutMs?: number;
  /** How to pick up the new build. Default `location.reload()`. */
  readonly reload?: () => void;
}

/** Which Deno Desktop targets to update (both by default). */
export interface DesktopUpdatesConfig {
  /** The signed UI overlay (`desktop.update.ui`). Default `true`. */
  readonly ui?: boolean;
  /** The whole app (`desktop.update.manifestUrl`). Default `true`. */
  readonly app?: boolean;
}

/**
 * Where each platform's updates come from. Only the running platform's part is read, so one
 * config serves every build.
 */
export interface UpdatesConfig {
  /**
   * iOS / Android: the over-the-air UI server (`checkForUiUpdate`'s options: `baseUrl`, `headers`,
   * `channel`, …). Without it a phone reports `not_configured`.
   */
  readonly ota?: OtaCheckOptions;
  /**
   * Deno Desktop: which targets to update. The feeds themselves are `desktop.update` in
   * `denext.config.ts`, read by the app's Deno side (`denext desktop add updates`).
   */
  readonly desktop?: DesktopUpdatesConfig;
  /** A browser tab: where the deployed build's version is read. */
  readonly web?: WebUpdatesConfig;
}

/** Reports progress (see {@linkcode UpdateProgress}). */
export type UpdateProgressListener = (progress: UpdateProgress) => void;
