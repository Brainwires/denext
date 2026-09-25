/**
 * `expo-updates` for denext: over-the-air updates through `denext/mobile`'s OTA client
 * ({@linkcode prepareUiUpdate} / {@linkcode applyUiUpdate}: the `DenextOta` plugin that
 * `denext mobile add-ota` installs in the Capacitor shell).
 *
 * The update server is the Expo config's `updates.url` (see `denext/expo/constants`): the
 * web root the UI is served from, whose `_denext/ota.json` manifest `denext ota manifest`
 * writes. `isEnabled` is true inside the native shell when that URL is set.
 *
 * - `checkForUpdateAsync` stages a newer UI (download and verify) and reports it available;
 * - `fetchUpdateAsync` reports the staged update as new;
 * - `reloadAsync` switches to a staged update, or reloads the page.
 *
 * Expo's update metadata (`updateId`, `channel`, `manifest`, the log) has no counterpart:
 * those read null or empty.
 *
 * @example
 * ```ts
 * import * as Updates from "denext/expo/updates";
 *
 * if (Updates.isEnabled && (await Updates.checkForUpdateAsync()).isAvailable) {
 *   await Updates.fetchUpdateAsync();
 *   await Updates.reloadAsync();
 * }
 * ```
 *
 * @module
 */

import { nativePlatform } from "../mobile/bridge.ts";
import { applyUiUpdate, prepareUiUpdate } from "../mobile/ota.ts";
import { expoConfigGlobal } from "./internal/common.ts";

/** Why no update is available. */
export enum UpdateCheckResultNotAvailableReason {
  /** The server offers nothing newer. */
  NO_UPDATE_AVAILABLE_ON_SERVER = "noUpdateAvailableOnServer",
  /** The selection policy rejected it. */
  UPDATE_REJECTED_BY_SELECTION_POLICY = "updateRejectedBySelectionPolicy",
  /** It failed before (rolled back on this device). */
  UPDATE_PREVIOUSLY_FAILED = "updatePreviouslyFailed",
  /** A rollback was rejected. */
  ROLLBACK_REJECTED_BY_SELECTION_POLICY = "rollbackRejectedBySelectionPolicy",
  /** No embedded rollback configuration. */
  ROLLBACK_NO_EMBEDDED = "rollbackNoEmbeddedConfiguration",
}

/** When updates are checked automatically. */
export enum UpdatesCheckAutomaticallyValue {
  /** On every load. */
  ON_LOAD = "ON_LOAD",
  /** After an error recovery. */
  ON_ERROR_RECOVERY = "ON_ERROR_RECOVERY",
  /** On Wi-Fi only. */
  WIFI_ONLY = "WIFI_ONLY",
  /** Never (denext checks when the app asks). */
  NEVER = "NEVER",
}

/** An update's manifest, as far as denext knows it. */
export interface Manifest {
  /** The UI version. */
  id: string;
  /** Whether the manifest marks it required. */
  required?: boolean;
  /** The release notes. */
  notes?: string | null;
}

/** What {@linkcode checkForUpdateAsync} resolves with. */
export type UpdateCheckResult =
  | { isAvailable: true; manifest: Manifest; isRollBackToEmbedded: false; reason: undefined }
  | {
    isAvailable: false;
    manifest: undefined;
    isRollBackToEmbedded: false;
    reason: UpdateCheckResultNotAvailableReason;
  };

/** What {@linkcode fetchUpdateAsync} resolves with. */
export type UpdateFetchResult =
  | { isNew: true; manifest: Manifest; isRollBackToEmbedded: false }
  | { isNew: false; manifest: undefined; isRollBackToEmbedded: false };

/** A log entry (there are none here). */
export interface UpdatesLogEntry {
  /** When. */
  timestamp: number;
  /** What. */
  message: string;
  /** The code. */
  code: string;
  /** The level. */
  level: string;
}

/** What {@linkcode useUpdates} returns. */
export interface UseUpdatesReturnType {
  /** The running update. */
  currentlyRunning: {
    isEmbeddedLaunch: boolean;
    isEmergencyLaunch: boolean;
    emergencyLaunchReason: string | null;
  };
  /** Whether the startup check is running. */
  isStartupProcedureRunning: boolean;
  /** Whether an update is available. */
  isUpdateAvailable: boolean;
  /** Whether an update is downloaded and waiting. */
  isUpdatePending: boolean;
  /** Whether a check is running. */
  isChecking: boolean;
  /** Whether a download is running. */
  isDownloading: boolean;
  /** Whether the app is restarting. */
  isRestarting: boolean;
  /** How many restarts happened. */
  restartCount: number;
}

/** The update server from the Expo config's `updates.url`, or null. */
function updatesUrl(): string | null {
  const updates = expoConfigGlobal()?.updates as { url?: unknown; enabled?: unknown } | undefined;
  if (updates?.enabled === false || typeof updates?.url !== "string") return null;
  return updates.url;
}

/** Whether updates can run: in the native shell, with an update URL. */
function enabled(): boolean {
  return nativePlatform() !== "web" && updatesUrl() !== null;
}

/** Whether updates are enabled (in the native shell with `updates.url` set). */
export const isEnabled: boolean = /* @__PURE__ */ enabled();
/** The running update's id (not tracked here): null. */
export const updateId: string | null = null;
/** The release channel (not used here): null. */
export const channel: string | null = null;
/** The runtime version (not used here): null. */
export const runtimeVersion: string | null = null;
/** When updates are checked: `NEVER` (the app asks). */
export const checkAutomatically: UpdatesCheckAutomaticallyValue | null =
  UpdatesCheckAutomaticallyValue.NEVER;
/** Whether this is an emergency launch: `false`. */
export const isEmergencyLaunch = false;
/** Why this is an emergency launch: null. */
export const emergencyLaunchReason: string | null = null;
/** How long the launch took: null. */
export const launchDuration: number | null = null;
/** Whether the embedded bundle is running (not tracked here): `true`. */
export const isEmbeddedLaunch = true;
/** Whether embedded assets are used: `true`. */
export const isUsingEmbeddedAssets = true;
/** The running manifest (not tracked here): empty. */
export const manifest: Partial<Manifest> = {};
/** When the running update was created: null. */
export const createdAt: Date | null = null;
/** The local asset map: empty. */
export const localAssets: Record<string, string> = {};

/** The version staged by the last successful check. */
let staged: Manifest | null = null;

/** The result for "nothing available". */
function notAvailable(reason: UpdateCheckResultNotAvailableReason): UpdateCheckResult {
  return { isAvailable: false, manifest: undefined, isRollBackToEmbedded: false, reason };
}

/**
 * Check the update server, and stage a newer UI when there is one (it is downloaded and
 * verified now, so {@linkcode fetchUpdateAsync} has nothing left to do).
 *
 * @returns Whether an update is available. It rejects when updates are disabled or the
 * check fails.
 */
export async function checkForUpdateAsync(): Promise<UpdateCheckResult> {
  const baseUrl = updatesUrl();
  if (!enabled() || !baseUrl) throw new Error("expo-updates: updates are not enabled here");
  const result = await prepareUiUpdate({ baseUrl });
  switch (result.kind) {
    case "ready":
      staged = { id: result.version, required: result.required, notes: result.notes };
      return {
        isAvailable: true,
        manifest: staged,
        isRollBackToEmbedded: false,
        reason: undefined,
      };
    case "current":
    case "unsupported":
      return notAvailable(UpdateCheckResultNotAvailableReason.NO_UPDATE_AVAILABLE_ON_SERVER);
    case "skipped":
      return notAvailable(
        result.reason === "rejected"
          ? UpdateCheckResultNotAvailableReason.UPDATE_PREVIOUSLY_FAILED
          : UpdateCheckResultNotAvailableReason.UPDATE_REJECTED_BY_SELECTION_POLICY,
      );
    default:
      throw new Error(`expo-updates: ${result.reason}`);
  }
}

/**
 * Download the update: the check already staged it, so this reports it.
 *
 * @returns `isNew: true` with the staged update, else `isNew: false`.
 */
export async function fetchUpdateAsync(): Promise<UpdateFetchResult> {
  if (!staged) await checkForUpdateAsync().catch(() => undefined);
  return staged
    ? { isNew: true, manifest: staged, isRollBackToEmbedded: false }
    : { isNew: false, manifest: undefined, isRollBackToEmbedded: false };
}

/**
 * Switch to the staged update (the page reloads into it), or reload the page when none is
 * staged.
 *
 * @param _options Reload-screen options (ignored).
 * @returns A promise that settles only if the switch failed.
 */
export async function reloadAsync(_options?: { reloadScreenOptions?: unknown }): Promise<void> {
  if (staged) {
    const failed = await applyUiUpdate(staged.id);
    throw new Error(`expo-updates: could not apply ${staged.id} (${failed.kind})`);
  }
  (globalThis as { location?: { reload(): void } }).location?.reload();
}

/**
 * The update log: empty (denext's OTA client reports through its results).
 *
 * @param _maxAge Ignored.
 * @returns An empty list.
 */
export function readLogEntriesAsync(_maxAge?: number): Promise<UpdatesLogEntry[]> {
  return Promise.resolve([]);
}

/**
 * Clear the update log: nothing to clear.
 *
 * @returns A promise that settles at once.
 */
export function clearLogEntriesAsync(): Promise<void> {
  return Promise.resolve();
}

/**
 * The extra request parameters (not used here): empty.
 *
 * @returns An empty record.
 */
export function getExtraParamsAsync(): Promise<Record<string, string>> {
  return Promise.resolve({});
}

/**
 * Set an extra request parameter: not used here (does nothing).
 *
 * @param _key The key.
 * @param _value The value.
 * @returns A promise that settles at once.
 */
export function setExtraParamAsync(_key: string, _value: string | null | undefined): Promise<void> {
  return Promise.resolve();
}

/**
 * Hook form of the update state: a static snapshot here (no state machine is exposed).
 *
 * @returns The state.
 */
export function useUpdates(): UseUpdatesReturnType {
  return {
    currentlyRunning: {
      isEmbeddedLaunch: true,
      isEmergencyLaunch: false,
      emergencyLaunchReason: null,
    },
    isStartupProcedureRunning: false,
    isUpdateAvailable: staged !== null,
    isUpdatePending: staged !== null,
    isChecking: false,
    isDownloading: false,
    isRestarting: false,
    restartCount: 0,
  };
}
