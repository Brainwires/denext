/**
 * Store (native binary) updates for `denext/mobile`: whether the App Store / Play Store has a
 * newer build, Android's in-app immediate and flexible updates, and a one-call prompt for
 * when an over-the-air UI update needs a newer binary. Everything goes through the native
 * `AppUpdate` plugin (`@capawesome/capacitor-app-update`, installed by `denext mobile add
 * app-update`); on the web there is no store, so each function reports `unsupported`.
 *
 * @module
 */

import { nativePlatform, openExternal } from "./bridge.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";

/** The plugin's `AppUpdateInfo`, as far as it is read here. */
interface RawUpdateInfo {
  currentVersionName?: string;
  availableVersionName?: string;
  currentVersionCode?: string;
  availableVersionCode?: string;
  availableVersionReleaseDate?: string;
  updateAvailability?: number;
  updatePriority?: number;
  immediateUpdateAllowed?: boolean;
  flexibleUpdateAllowed?: boolean;
  clientVersionStalenessDays?: number;
  installStatus?: number;
  minimumOsVersion?: string;
}

/** The plugin's `FlexibleUpdateState`. */
interface RawFlexibleState {
  installStatus?: number;
  bytesDownloaded?: number;
  totalBytesToDownload?: number;
}

/** The JS side of `@capawesome/capacitor-app-update`. */
interface AppUpdatePlugin {
  getAppUpdateInfo(options?: { country?: string }): Promise<RawUpdateInfo>;
  openAppStore(options?: { appId?: string; androidPackageName?: string }): Promise<void>;
  performImmediateUpdate(): Promise<{ code?: number }>;
  startFlexibleUpdate(): Promise<{ code?: number }>;
  completeFlexibleUpdate(): Promise<void>;
  addListener(
    event: "onFlexibleUpdateStateChange",
    fn: (state: RawFlexibleState) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** Whether the store has a newer build: the plugin's `AppUpdateAvailability`, named. */
export type AppUpdateAvailability =
  | "unknown"
  | "not-available"
  | "available"
  | "in-progress"
  /** Not in the native shell, or no `AppUpdate` plugin. */
  | "unsupported";

/** What {@linkcode getAppUpdateInfo} reports. Fields a platform does not know are absent. */
export interface AppUpdateInfo {
  /** Whether the store has a newer build. */
  readonly availability: AppUpdateAvailability;
  /** Shorthand for `availability === "available"`. */
  readonly available: boolean;
  /** The running version name (iOS `CFBundleShortVersionString`, Android `versionName`). */
  readonly currentVersion?: string;
  /** The store's version name (iOS only). */
  readonly availableVersion?: string;
  /** The running build number (iOS `CFBundleVersion`, Android `versionCode`). */
  readonly currentBuild?: string;
  /** The store's build number (Android only). */
  readonly availableBuild?: string;
  /** When the store build was released, ISO 8601 (iOS only). */
  readonly releaseDate?: string;
  /** The update's priority, 0–5, as set through the Play Developer API (Android only). */
  readonly priority?: number;
  /** Days since the Play Store learned of the update (Android only). */
  readonly stalenessDays?: number;
  /** Whether Android allows an immediate (full-screen, blocking) update now. */
  readonly immediateAllowed?: boolean;
  /** Whether Android allows a flexible (background download) update now. */
  readonly flexibleAllowed?: boolean;
  /** The lowest iOS version the store build runs on (iOS only). */
  readonly minimumOsVersion?: string;
}

/**
 * How an in-app update call ended: the plugin's `AppUpdateResultCode`, named, plus
 * `"unsupported"` (not Android, or no plugin).
 */
export type AppUpdateOutcome =
  | "accepted"
  | "cancelled"
  | "failed"
  | "not-available"
  | "not-allowed"
  | "info-missing"
  | "unsupported";

/** A flexible update's progress, from {@linkcode onFlexibleUpdateProgress}. */
export interface FlexibleUpdateProgress {
  /** The install status, named. `"downloaded"` means {@linkcode completeFlexibleUpdate} may run. */
  readonly status:
    | "unknown"
    | "pending"
    | "downloading"
    | "installing"
    | "installed"
    | "failed"
    | "cancelled"
    | "downloaded";
  /** Bytes downloaded so far (while downloading). */
  readonly bytesDownloaded?: number;
  /** Total bytes to download (while downloading). */
  readonly totalBytes?: number;
}

/** `AppUpdateAvailability` (0–3) → name. */
const AVAILABILITY: readonly AppUpdateAvailability[] = [
  "unknown",
  "not-available",
  "available",
  "in-progress",
];

/** `AppUpdateResultCode` (0–5) → name. */
const OUTCOMES: readonly AppUpdateOutcome[] = [
  "accepted",
  "cancelled",
  "failed",
  "not-available",
  "not-allowed",
  "info-missing",
];

/** `FlexibleUpdateInstallStatus` → name (11 is DOWNLOADED). */
function installStatus(code: number | undefined): FlexibleUpdateProgress["status"] {
  const names: Record<number, FlexibleUpdateProgress["status"]> = {
    1: "pending",
    2: "downloading",
    3: "installing",
    4: "installed",
    5: "failed",
    6: "cancelled",
    11: "downloaded",
  };
  return (code !== undefined && names[code]) || "unknown";
}

/** The `AppUpdate` plugin, when the shell has it. */
function updatePlugin(): AppUpdatePlugin | undefined {
  return nativePlugin<AppUpdatePlugin>("AppUpdate", ["getAppUpdateInfo", "openAppStore"]);
}

/** `value` when it is a string, else nothing (for spreading into a result). */
function str<K extends string>(key: K, value: unknown): { [P in K]?: string } {
  return typeof value === "string" && value !== "" ? { [key]: value } as { [P in K]: string } : {};
}

/** `value` when it is a finite number, else nothing. */
function num<K extends string>(key: K, value: unknown): { [P in K]?: number } {
  return typeof value === "number" && Number.isFinite(value)
    ? { [key]: value } as { [P in K]: number }
    : {};
}

/** `value` when it is a boolean, else nothing. */
function bool<K extends string>(key: K, value: unknown): { [P in K]?: boolean } {
  return typeof value === "boolean" ? { [key]: value } as { [P in K]: boolean } : {};
}

/** The plugin's info, normalized. */
function toInfo(raw: RawUpdateInfo): AppUpdateInfo {
  const availability = AVAILABILITY[raw.updateAvailability ?? 0] ?? "unknown";
  return {
    availability,
    available: availability === "available",
    ...str("currentVersion", raw.currentVersionName),
    ...str("availableVersion", raw.availableVersionName),
    ...str("currentBuild", raw.currentVersionCode),
    ...str("availableBuild", raw.availableVersionCode),
    ...str("releaseDate", raw.availableVersionReleaseDate),
    ...num("priority", raw.updatePriority),
    ...num("stalenessDays", raw.clientVersionStalenessDays),
    ...bool("immediateAllowed", raw.immediateUpdateAllowed),
    ...bool("flexibleAllowed", raw.flexibleUpdateAllowed),
    ...str("minimumOsVersion", raw.minimumOsVersion),
  };
}

/**
 * Ask the store whether a newer build of the app exists.
 *
 * - iOS: the App Store lookup API (by bundle id; pass `country` when the app is not in the US
 *   store). It compares version names, so bump `CFBundleShortVersionString` per release.
 * - Android: the Play Core in-app update API. It only answers for a build installed from Play
 *   (internal testing counts); a sideloaded or debug build reads `not-available`.
 * - Elsewhere: `{ availability: "unsupported", available: false }`.
 *
 * @param options `country`: the two-letter App Store country code (iOS only).
 * @returns The store's answer, normalized. It rejects when the plugin fails (no network, no
 * Play Store).
 * @example
 * ```ts
 * import { getAppUpdateInfo, openAppStore } from "denext/mobile";
 *
 * const info = await getAppUpdateInfo();
 * if (info.available && confirm(`Version ${info.availableVersion ?? "new"} is out. Update?`)) {
 *   await openAppStore({ appStoreId: "123456789" });
 * }
 * ```
 */
export async function getAppUpdateInfo(options: { country?: string } = {}): Promise<AppUpdateInfo> {
  const plugin = updatePlugin();
  if (!plugin) return { availability: "unsupported", available: false };
  const raw = await plugin.getAppUpdateInfo(options.country ? { country: options.country } : {});
  return toInfo(raw ?? {});
}

/** Where {@linkcode openAppStore} sends the user. */
export interface AppStoreOptions {
  /** The numeric App Store id (`123456789`): needed on iOS. */
  readonly appStoreId?: string;
  /** The Android package; default the running app's. */
  readonly androidPackage?: string;
}

/**
 * Open the app's store page (the App Store on iOS, Play on Android) so the user can update.
 * Without the plugin, natively or on the web, it opens the store URL instead (the App Store
 * when `appStoreId` is given, else Play when `androidPackage` is).
 *
 * @param options The App Store id (required on iOS) and the Android package (optional).
 * @returns A promise that settles once the store was opened. It rejects with a `TypeError` on
 * iOS without `appStoreId`, or when no plugin is there and neither id is given.
 * @example
 * ```ts
 * import { openAppStore } from "denext/mobile";
 * await openAppStore({ appStoreId: "123456789" });
 * ```
 */
export async function openAppStore(options: AppStoreOptions = {}): Promise<void> {
  const platform = nativePlatform();
  if (platform === "ios" && !options.appStoreId) {
    throw new TypeError("openAppStore: iOS needs appStoreId (the numeric App Store id)");
  }
  const plugin = updatePlugin();
  if (plugin) {
    return await plugin.openAppStore({
      ...(options.appStoreId ? { appId: options.appStoreId } : {}),
      ...(options.androidPackage ? { androidPackageName: options.androidPackage } : {}),
    });
  }
  const ios = options.appStoreId && platform !== "android";
  if (ios) return await openExternal(`https://apps.apple.com/app/id${options.appStoreId}`);
  if (options.androidPackage) {
    return await openExternal(
      `https://play.google.com/store/apps/details?id=${encodeURIComponent(options.androidPackage)}`,
    );
  }
  throw new TypeError("openAppStore: pass appStoreId and/or androidPackage");
}

/** Run one of the Android in-app update calls and name its result code. */
async function androidUpdate(
  run: (plugin: AppUpdatePlugin) => Promise<{ code?: number }>,
): Promise<AppUpdateOutcome> {
  const plugin = nativePlatform() === "android"
    ? nativePlugin<AppUpdatePlugin>("AppUpdate", [
      "performImmediateUpdate",
      "startFlexibleUpdate",
    ])
    : undefined;
  if (!plugin) return "unsupported";
  const result = await run(plugin);
  return OUTCOMES[result?.code ?? 2] ?? "failed";
}

/**
 * Android: start Play's immediate update, a full-screen flow the user completes before using
 * the app again (Play restarts the app when it finishes). Call {@linkcode getAppUpdateInfo}
 * first: Play refuses (`info-missing`) otherwise, and `immediateAllowed` says whether it may.
 *
 * @returns How it ended: `accepted`, `cancelled`, `failed`, `not-available`, `not-allowed`,
 * `info-missing`, or `unsupported` off Android or without the plugin.
 * @example
 * ```ts
 * import { getAppUpdateInfo, performImmediateUpdate } from "denext/mobile";
 * const info = await getAppUpdateInfo();
 * if (info.available && info.immediateAllowed) await performImmediateUpdate();
 * ```
 */
export function performImmediateUpdate(): Promise<AppUpdateOutcome> {
  return androidUpdate((plugin) => plugin.performImmediateUpdate());
}

/**
 * Android: start Play's flexible update, which downloads in the background while the app keeps
 * running. Follow it with {@linkcode onFlexibleUpdateProgress}, and once the status is
 * `"downloaded"`, call {@linkcode completeFlexibleUpdate} (after asking the user) to install and
 * restart. Call {@linkcode getAppUpdateInfo} first.
 *
 * @returns Whether the user accepted the download (`accepted`, `cancelled`, …), or
 * `unsupported` off Android.
 * @example
 * ```ts
 * import { completeFlexibleUpdate, onFlexibleUpdateProgress, startFlexibleUpdate } from "denext/mobile";
 * const stop = onFlexibleUpdateProgress((p) => {
 *   if (p.status === "downloaded") showRestartBanner(() => completeFlexibleUpdate());
 * });
 * await startFlexibleUpdate();
 * ```
 */
export function startFlexibleUpdate(): Promise<AppUpdateOutcome> {
  return androidUpdate((plugin) => plugin.startFlexibleUpdate());
}

/**
 * Android: install a downloaded flexible update, restarting the app. A no-op elsewhere.
 *
 * @returns A promise that settles once Play took over (the app restarts).
 * @example
 * ```ts
 * import { completeFlexibleUpdate } from "denext/mobile";
 * await completeFlexibleUpdate();
 * ```
 */
export async function completeFlexibleUpdate(): Promise<void> {
  const plugin = nativePlatform() === "android"
    ? nativePlugin<AppUpdatePlugin>("AppUpdate", ["completeFlexibleUpdate"])
    : undefined;
  if (plugin) await plugin.completeFlexibleUpdate();
}

/**
 * Android: follow a flexible update's download and install. Off Android, or without the
 * plugin, the callback never runs.
 *
 * @param cb Called with each state change.
 * @returns A function that stops listening.
 * @example
 * ```ts
 * import { onFlexibleUpdateProgress } from "denext/mobile";
 * const stop = onFlexibleUpdateProgress(({ status, bytesDownloaded, totalBytes }) => {
 *   if (status === "downloading" && totalBytes) setProgress(bytesDownloaded! / totalBytes);
 * });
 * ```
 */
export function onFlexibleUpdateProgress(
  cb: (progress: FlexibleUpdateProgress) => void,
): () => void {
  const plugin = nativePlatform() === "android"
    ? nativePlugin<AppUpdatePlugin>("AppUpdate", ["addListener"])
    : undefined;
  if (!plugin) return () => {};
  return listenerDisposer(
    plugin.addListener("onFlexibleUpdateStateChange", (state) =>
      cb({
        status: installStatus(state?.installStatus),
        ...num("bytesDownloaded", state?.bytesDownloaded),
        ...num("totalBytes", state?.totalBytesToDownload),
      })),
  );
}

/** Options for {@linkcode promptStoreUpdate}. */
export interface PromptStoreUpdateOptions extends AppStoreOptions {
  /**
   * Ask the user first; resolving `false` skips the update. Default: no question (the OTA
   * refusal that usually calls this means the current binary cannot take the new UI).
   */
  readonly confirm?: (info: AppUpdateInfo) => boolean | Promise<boolean>;
  /**
   * Android: `"immediate"` (the default) runs Play's full-screen update when Play allows it,
   * `"flexible"` a background download; either falls back to the store page.
   */
  readonly android?: "immediate" | "flexible";
  /** Open the store page even when the store reports no newer build. Default `false`. */
  readonly force?: boolean;
}

/**
 * What {@linkcode promptStoreUpdate} did: `"updating"` (Play's in-app update started),
 * `"store-opened"`, `"declined"` (the `confirm` callback said no), `"up-to-date"` (the store
 * has no newer build), or `"unsupported"`.
 */
export type PromptStoreUpdateResult =
  | "updating"
  | "store-opened"
  | "declined"
  | "up-to-date"
  | "unsupported";

/** Android's in-app update for `mode`, when Play allows it; null to fall back to the store. */
async function playUpdate(
  info: AppUpdateInfo,
  mode: "immediate" | "flexible",
): Promise<PromptStoreUpdateResult | null> {
  if (nativePlatform() !== "android") return null;
  const allowed = mode === "immediate" ? info.immediateAllowed : info.flexibleAllowed;
  if (!allowed) return null;
  const outcome = mode === "immediate"
    ? await performImmediateUpdate()
    : await startFlexibleUpdate();
  if (outcome === "accepted") return "updating";
  return outcome === "cancelled" ? "declined" : null;
}

/**
 * Take the user to a newer app binary: check the store, optionally ask (`confirm`), then run
 * Play's in-app update on Android (immediate by default) or open the store page. Made for the
 * OTA refusals that mean "this UI needs a newer binary" (`native_too_old`,
 * `native_mismatch`): pass it as `checkForUiUpdate`'s `onNativeUpdateRequired`.
 *
 * @param options The store ids, the `confirm` question, the Android mode, and `force`.
 * @returns What it did. It rejects when the plugin fails, or as {@linkcode openAppStore} does.
 * @example
 * ```ts
 * import { checkForUiUpdate, promptStoreUpdate } from "denext/mobile";
 *
 * await checkForUiUpdate({
 *   baseUrl: "https://api.example.com/mobile-ui",
 *   onNativeUpdateRequired: () =>
 *     promptStoreUpdate({
 *       appStoreId: "123456789",
 *       confirm: () => confirm("This version is out of date. Update now?"),
 *     }),
 * });
 * ```
 */
export async function promptStoreUpdate(
  options: PromptStoreUpdateOptions = {},
): Promise<PromptStoreUpdateResult> {
  if (nativePlatform() === "web") return "unsupported";
  const info = await getAppUpdateInfo();
  if (info.availability === "not-available" && !options.force) return "up-to-date";
  if (options.confirm && !(await options.confirm(info))) return "declined";
  const played = info.availability === "available"
    ? await playUpdate(info, options.android ?? "immediate")
    : null;
  if (played) return played;
  await openAppStore(options);
  return "store-opened";
}
