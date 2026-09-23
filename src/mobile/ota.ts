/**
 * Over-the-air (OTA) UI updates for `denext/mobile`: the web side of the native
 * `DenextOta` Capacitor plugin that `denext mobile add-ota` installs.
 *
 * The shell bundles a static export stamped with `_denext/ota.json` (`spa.ota`, or
 * `denext ota manifest out`). {@linkcode checkForUiUpdate} fetches the same manifest from
 * a server and, when its version differs from the UI running now, has the native side
 * download, verify and switch to it. The switched-to UI must call {@linkcode otaBooted}
 * once it has rendered, or the native watchdog rolls it back after 15 s.
 *
 * An app that asks the user first splits that in two: {@linkcode prepareUiUpdate} downloads
 * and verifies the new UI and leaves it staged (the running UI is untouched), the app shows
 * its own prompt (the manifest's `required` and `notes` feed it), and
 * {@linkcode applyUiUpdate} switches to the staged UI. A staged UI is never switched to on
 * its own, not even at the next launch.
 *
 * Nothing runs at import, and every function takes a no-op path on the web (no
 * `window.Capacitor` native platform, or no `DenextOta` plugin registered).
 *
 * @module
 */

import { shellPlugin } from "./bridge.ts";
import { isOtaManifest, OTA_MANIFEST_PATH, type OtaManifest } from "./ota-manifest.ts";

/** The native plugin's name: `window.Capacitor.Plugins.DenextOta`. */
const PLUGIN_NAME = "DenextOta";
const DEFAULT_TIMEOUT_MS = 15_000;

/** What the native side reports about the UI versions on this device. */
export interface OtaStatus {
  /** The confirmed downloaded version, or `null` while the bundled UI runs. */
  readonly current: string | null;
  /** The version bundled with the app binary (its `public/_denext/ota.json`), if stamped. */
  readonly bundled: string | null;
  /** A version on its trial launch (not yet confirmed by {@linkcode otaBooted}). */
  readonly pending: string | null;
  /** The last version rolled back; `apply` refuses it until {@linkcode otaReset}. */
  readonly rejected: string | null;
  /**
   * A version downloaded and verified by {@linkcode prepareUiUpdate} and waiting for
   * {@linkcode applyUiUpdate}, or `null`. It never becomes the running UI on its own.
   */
  readonly staged: string | null;
}

/** The JS face of the native `DenextOta` plugin (Capacitor seeds a stub per method). */
interface DenextOtaPlugin {
  status(): Promise<Partial<OtaStatus>>;
  apply(options: {
    baseUrl: string;
    headers: Record<string, string>;
    manifest: OtaManifest;
  }): Promise<unknown>;
  booted(): Promise<unknown>;
  reset(): Promise<unknown>;
  /** Added with prepare/apply; a shell installed before that lacks them. */
  download?(options: {
    baseUrl: string;
    headers: Record<string, string>;
    manifest: OtaManifest;
  }): Promise<unknown>;
  /** Added with prepare/apply; a shell installed before that lacks them. */
  activate?(options: { version: string }): Promise<unknown>;
}

/** A plugin whose shell also has the staged-update methods. */
type StagingOtaPlugin = DenextOtaPlugin & Required<Pick<DenextOtaPlugin, "download" | "activate">>;

/** Options for {@linkcode checkForUiUpdate} and {@linkcode prepareUiUpdate}. */
export interface OtaCheckOptions {
  /**
   * The web root the UI is served from, e.g. `"https://api.example.com/mobile-ui"`. The
   * manifest is fetched from `${baseUrl}/_denext/ota.json` and each file from
   * `${baseUrl}/<path>`. A trailing slash is ignored.
   */
  baseUrl: string;
  /**
   * Headers sent with the manifest request AND with every native file download, e.g.
   * `{ authorization: "Bearer …" }`. Serve the UI behind the same auth as your API.
   */
  headers?: Record<string, string>;
  /** Timeout for the manifest request, in ms. Default 15 000. */
  timeoutMs?: number;
  /** The `fetch` to use for the manifest (default: the global `fetch`). */
  fetch?: typeof fetch;
}

/** The outcome of {@linkcode checkForUiUpdate}. It never throws; every failure is a value. */
export type OtaCheckResult =
  /** Not inside the native shell, or the shell has no `DenextOta` plugin. */
  | { readonly kind: "unsupported" }
  /** The server offers the version already running. */
  | { readonly kind: "current" }
  /** The new UI was downloaded and verified; the webview is reloading into it. */
  | { readonly kind: "applied"; readonly version: string }
  /**
   * The native side declined: `"rejected"` (this version was rolled back on this device;
   * `otaReset()` clears that) or `"busy"` (an apply or a trial launch is in progress).
   */
  | { readonly kind: "skipped"; readonly reason: "rejected" | "busy" }
  /** Network, HTTP, JSON, manifest-shape, timeout, download or integrity failure. */
  | { readonly kind: "error"; readonly reason: string };

/**
 * The outcome of {@linkcode prepareUiUpdate}. It never throws; every failure is a value.
 */
export type OtaPrepareResult =
  /**
   * Not inside the native shell, or the shell's `DenextOta` plugin predates staged updates
   * (re-run `denext mobile add-ota --force` to update it).
   */
  | { readonly kind: "unsupported" }
  /** The server offers the version already running. */
  | { readonly kind: "current" }
  /**
   * The new UI is downloaded, verified and staged; pass `version` to
   * {@linkcode applyUiUpdate} to switch to it. `required` and `notes` come from the
   * manifest (`denext ota manifest --required --notes …`), defaulting to `false` and `null`.
   */
  | {
    readonly kind: "ready";
    readonly version: string;
    readonly required: boolean;
    readonly notes: string | null;
  }
  /**
   * The native side declined: `"rejected"` (this version was rolled back on this device;
   * `otaReset()` clears that) or `"busy"` (a download or a trial launch is in progress).
   */
  | { readonly kind: "skipped"; readonly reason: "rejected" | "busy" }
  /** Network, HTTP, JSON, manifest-shape, timeout, download or integrity failure. */
  | { readonly kind: "error"; readonly reason: string };

/**
 * The outcome of {@linkcode applyUiUpdate} when it settles. On success the webview reloads
 * into the new UI, so the promise does not settle at all.
 */
export type OtaApplyResult =
  /** Not inside the native shell, or its `DenextOta` plugin predates staged updates. */
  | { readonly kind: "unsupported" }
  /**
   * The native side refused: the version is not the staged one (`not_staged`), a download or
   * trial is in progress (`busy`), the version was rolled back (`rejected`), or it is not a
   * version at all (`invalid`). `reason` is the native message.
   */
  | { readonly kind: "error"; readonly reason: string };

/** The `DenextOta` plugin when the shell registered one with every method, else undefined. */
function otaPlugin(): DenextOtaPlugin | undefined {
  const plugin = shellPlugin(PLUGIN_NAME) as Partial<DenextOtaPlugin> | undefined;
  if (typeof plugin !== "object" || plugin === null) return undefined;
  const methods = [plugin.status, plugin.apply, plugin.booted, plugin.reset];
  return methods.every((m) => typeof m === "function") ? plugin as DenextOtaPlugin : undefined;
}

/** The `DenextOta` plugin when it also has `download` and `activate`, else undefined. */
function stagingPlugin(): StagingOtaPlugin | undefined {
  const plugin = otaPlugin();
  return typeof plugin?.download === "function" && typeof plugin.activate === "function"
    ? plugin as StagingOtaPlugin
    : undefined;
}

/** A thrown value's message. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The `code` of a Capacitor plugin rejection (`CapacitorException.code`), if any. */
function codeOf(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
}

/** Fetch and validate `${baseUrl}/_denext/ota.json`; a string is the failure reason. */
async function fetchManifest(
  baseUrl: string,
  options: OtaCheckOptions,
): Promise<OtaManifest | string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const doFetch = options.fetch ?? globalThis.fetch;
    const response = await doFetch(`${baseUrl}/${OTA_MANIFEST_PATH}`, {
      headers: options.headers ?? {},
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return `manifest request failed with HTTP ${response.status}`;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      if (controller.signal.aborted) throw err;
      return "the manifest is not valid JSON";
    }
    return isOtaManifest(body) ? body : "the manifest is malformed";
  } catch (err) {
    return controller.signal.aborted
      ? `manifest request timed out after ${timeoutMs} ms`
      : `manifest request failed: ${messageOf(err)}`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The steps {@linkcode checkForUiUpdate} and {@linkcode prepareUiUpdate} share: fetch and
 * validate the manifest, then compare it with the running UI. A result means stop there;
 * otherwise the manifest to install and the trimmed base URL.
 */
async function newerManifest(
  plugin: DenextOtaPlugin,
  options: OtaCheckOptions,
): Promise<
  | { readonly kind: "current" }
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "newer"; readonly manifest: OtaManifest; readonly baseUrl: string }
> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const manifest = await fetchManifest(baseUrl, options);
  if (typeof manifest === "string") return { kind: "error", reason: manifest };
  let status: Partial<OtaStatus>;
  try {
    status = await plugin.status();
  } catch (err) {
    return { kind: "error", reason: `status failed: ${messageOf(err)}` };
  }
  if (manifest.version === (status.current ?? status.bundled ?? null)) return { kind: "current" };
  return { kind: "newer", manifest, baseUrl };
}

/** A native download/apply rejection as a `skipped` or `error` result. */
function refusal(
  err: unknown,
):
  | { readonly kind: "skipped"; readonly reason: "rejected" | "busy" }
  | { readonly kind: "error"; readonly reason: string } {
  const code = codeOf(err);
  if (code === "rejected" || code === "busy") return { kind: "skipped", reason: code };
  return { kind: "error", reason: messageOf(err) };
}

/** The whole check; {@linkcode checkForUiUpdate} adds the single-flight wrapper. */
async function runCheck(options: OtaCheckOptions): Promise<OtaCheckResult> {
  // Native `apply` (download + switch in one call), which every DenextOta shell has.
  const plugin = otaPlugin();
  if (!plugin) return { kind: "unsupported" };
  const found = await newerManifest(plugin, options);
  if (found.kind !== "newer") return found;
  const { manifest, baseUrl } = found;
  try {
    await plugin.apply({ baseUrl, headers: { ...options.headers }, manifest });
  } catch (err) {
    return refusal(err);
  }
  return { kind: "applied", version: manifest.version };
}

/** The whole prepare; {@linkcode prepareUiUpdate} adds the single-flight wrapper. */
async function runPrepare(options: OtaCheckOptions): Promise<OtaPrepareResult> {
  const plugin = stagingPlugin();
  if (!plugin) return { kind: "unsupported" };
  const found = await newerManifest(plugin, options);
  if (found.kind !== "newer") return found;
  const { manifest, baseUrl } = found;
  try {
    await plugin.download({ baseUrl, headers: { ...options.headers }, manifest });
  } catch (err) {
    return refusal(err);
  }
  return {
    kind: "ready",
    version: manifest.version,
    required: manifest.required === true,
    notes: typeof manifest.notes === "string" ? manifest.notes : null,
  };
}

/**
 * One run at a time: a call made while another is in flight gets that call's promise (and
 * its options). A throw from `run` settles as `onError(err)`, so the result never rejects.
 */
function singleFlight<T>(
  run: (options: OtaCheckOptions) => Promise<T>,
  onError: (err: unknown) => T,
): (options: OtaCheckOptions) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (options) => {
    if (inFlight) return inFlight;
    const flight = run(options).catch(onError).finally(() => {
      inFlight = null;
    });
    inFlight = flight;
    return flight;
  };
}

/** Any unexpected throw as an `error` result. */
const asError = (err: unknown): { readonly kind: "error"; readonly reason: string } => ({
  kind: "error",
  reason: messageOf(err),
});

const checkFlight = singleFlight<OtaCheckResult>(runCheck, asError);
const prepareFlight = singleFlight<OtaPrepareResult>(runPrepare, asError);

/**
 * Check a server for a newer UI and, when it offers a different version, install it.
 *
 * 1. Fetches `${baseUrl}/_denext/ota.json` (with `headers`, `cache: "no-store"` and a
 *    timeout) and validates its shape.
 * 2. Asks the native `DenextOta` plugin for its {@linkcode OtaStatus}; if the manifest's
 *    version equals the running UI (`current`, else `bundled`), it returns `current`.
 * 3. Otherwise the plugin downloads `${baseUrl}/<path>` for every file (copying files it
 *    already has by SHA-256), verifies each SHA-256 and size, switches the webview's web
 *    root to the new directory and reloads. The new page must call {@linkcode otaBooted}
 *    within 15 s or it is rolled back.
 *
 * It never throws. Outside the native shell it resolves `{ kind: "unsupported" }` without
 * touching the network. One check runs at a time: a call made while another is in flight
 * gets that call's promise (and its options).
 *
 * @param options Where the UI is served, plus headers, timeout and `fetch`.
 * @returns What happened, as an {@linkcode OtaCheckResult}.
 * @example
 * ```ts
 * "use client";
 * import { checkForUiUpdate, onAppResume, otaBooted } from "denext/mobile";
 *
 * const check = () =>
 *   checkForUiUpdate({
 *     baseUrl: "https://api.example.com/mobile-ui",
 *     headers: { authorization: `Bearer ${token}` },
 *   });
 * // After the first render: confirm this UI to the native watchdog, then check.
 * await otaBooted();
 * await check();
 * onAppResume((awayMs) => awayMs >= 10_000 && void check());
 * ```
 */
export function checkForUiUpdate(options: OtaCheckOptions): Promise<OtaCheckResult> {
  return checkFlight(options);
}

/**
 * Download and verify a newer UI WITHOUT switching to it, so the app can ask the user first.
 *
 * 1. Fetches and validates `${baseUrl}/_denext/ota.json`, exactly as
 *    {@linkcode checkForUiUpdate} does; the running version resolves `current`.
 * 2. Otherwise the native plugin downloads (or copies, by SHA-256) and verifies every file
 *    into the version's own directory and records it as **staged**. The running UI keeps
 *    running; a version already staged resolves at once.
 * 3. Resolves `ready` with the manifest's `required` (default `false`) and `notes` (default
 *    `null`) for the app's prompt. Switch with {@linkcode applyUiUpdate}.
 *
 * A staged UI is never switched to on its own, not even at the next launch; a newer prepare
 * replaces it, and {@linkcode otaReset} (or a new app binary) drops it. It never throws.
 * Outside the native shell, or with a `DenextOta` plugin that predates staged updates, it
 * resolves `{ kind: "unsupported" }` without touching the network. One prepare runs at a
 * time: a call made while another is in flight gets that call's promise (and its options).
 *
 * @param options Where the UI is served, plus headers, timeout and `fetch`.
 * @returns What happened, as an {@linkcode OtaPrepareResult}.
 * @example
 * ```ts
 * "use client";
 * import { applyUiUpdate, otaBooted, prepareUiUpdate } from "denext/mobile";
 *
 * await otaBooted();
 * const update = await prepareUiUpdate({ baseUrl: "https://api.example.com/mobile-ui" });
 * if (update.kind === "ready") {
 *   // Your own modal; a required update offers no "Later".
 *   const ok = update.required || confirm(update.notes ?? "A new version is ready. Restart?");
 *   if (ok) await applyUiUpdate(update.version);
 * }
 * ```
 */
export function prepareUiUpdate(options: OtaCheckOptions): Promise<OtaPrepareResult> {
  return prepareFlight(options);
}

/**
 * Switch to the UI {@linkcode prepareUiUpdate} staged: the native side starts its trial,
 * arms the 15 s rollback watchdog, points the webview at it and reloads. The new page must
 * call {@linkcode otaBooted}, exactly as after {@linkcode checkForUiUpdate}.
 *
 * On success the page reloads, so the returned promise does not settle; it resolves only
 * with a failure: `unsupported` off native (or with a plugin that predates staged updates),
 * or `error` when the native side refuses (`version` is not the staged one, a download or
 * trial is in progress, or the version was rolled back). It never throws.
 *
 * @param version The `version` from a `ready` {@linkcode OtaPrepareResult}.
 * @returns A promise that settles only on failure, as an {@linkcode OtaApplyResult}.
 * @example
 * ```ts
 * import { applyUiUpdate } from "denext/mobile";
 * const failed = await applyUiUpdate(update.version); // only returns if it could not switch
 * console.warn("UI update failed", failed);
 * ```
 */
export async function applyUiUpdate(version: string): Promise<OtaApplyResult> {
  const plugin = stagingPlugin();
  if (!plugin) return { kind: "unsupported" };
  try {
    await plugin.activate({ version });
  } catch (err) {
    return { kind: "error", reason: messageOf(err) };
  }
  // The native side has switched the web root and is reloading: this page is going away.
  return await new Promise<never>(() => {});
}

/**
 * Confirm to the native side that the running UI booted. Call it once after the app's
 * first render: a UI on its trial launch that never calls it is rolled back by the
 * native watchdog after 15 s (and on the next launch, if the app died first). Harmless on
 * the bundled UI or a confirmed one.
 *
 * Resolves on the web and when the plugin is missing, and never rejects: a failure here
 * must not break the app that just booted.
 *
 * @returns A promise that settles once the native side has recorded the boot.
 * @example
 * ```tsx
 * "use client";
 * import { useEffect } from "denext";
 * import { otaBooted } from "denext/mobile";
 *
 * export function BootConfirm() {
 *   useEffect(() => void otaBooted(), []);
 *   return null;
 * }
 * ```
 */
export async function otaBooted(): Promise<void> {
  try {
    await otaPlugin()?.booted();
  } catch {
    // Best effort: the watchdog decides, and a thrown confirm must not break the page.
  }
}

/**
 * The native side's view of the UI versions on this device, or `null` on the web and
 * when the shell has no `DenextOta` plugin.
 *
 * @returns The {@linkcode OtaStatus}, or `null` off native.
 * @throws When the native plugin rejects.
 * @example
 * ```ts
 * import { otaStatus } from "denext/mobile";
 * const status = await otaStatus();
 * console.log(status?.current ?? status?.bundled ?? "web");
 * ```
 */
export async function otaStatus(): Promise<OtaStatus | null> {
  const plugin = otaPlugin();
  if (!plugin) return null;
  const s = await plugin.status();
  return {
    current: s.current ?? null,
    bundled: s.bundled ?? null,
    pending: s.pending ?? null,
    rejected: s.rejected ?? null,
    staged: s.staged ?? null,
  };
}

/**
 * Return to the UI bundled with the app: delete every downloaded version (a staged one
 * included), forget the rejected one, and reload the webview. A no-op on the web.
 *
 * @returns A promise that settles once the native side has reset (the page then reloads).
 * @throws When the native plugin rejects, e.g. with code `"busy"` during a download.
 * @example
 * ```ts
 * import { otaReset } from "denext/mobile";
 * await otaReset(); // e.g. from a "Reset UI" button in a debug menu
 * ```
 */
export async function otaReset(): Promise<void> {
  await otaPlugin()?.reset();
}
