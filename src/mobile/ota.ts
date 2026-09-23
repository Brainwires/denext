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
}

/** Options for {@linkcode checkForUiUpdate}. */
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

/** The `DenextOta` plugin when the shell registered one with every method, else undefined. */
function otaPlugin(): DenextOtaPlugin | undefined {
  const plugin = shellPlugin(PLUGIN_NAME) as Partial<DenextOtaPlugin> | undefined;
  if (typeof plugin !== "object" || plugin === null) return undefined;
  const methods = [plugin.status, plugin.apply, plugin.booted, plugin.reset];
  return methods.every((m) => typeof m === "function") ? plugin as DenextOtaPlugin : undefined;
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

/** The whole check; {@linkcode checkForUiUpdate} adds the single-flight wrapper. */
async function runCheck(options: OtaCheckOptions): Promise<OtaCheckResult> {
  const plugin = otaPlugin();
  if (!plugin) return { kind: "unsupported" };
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
  try {
    await plugin.apply({ baseUrl, headers: { ...options.headers }, manifest });
  } catch (err) {
    const code = codeOf(err);
    if (code === "rejected" || code === "busy") return { kind: "skipped", reason: code };
    return { kind: "error", reason: messageOf(err) };
  }
  return { kind: "applied", version: manifest.version };
}

let inFlight: Promise<OtaCheckResult> | null = null;

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
  if (inFlight) return inFlight;
  const run = runCheck(options).catch((err): OtaCheckResult => ({
    kind: "error",
    reason: messageOf(err),
  })).finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
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
  };
}

/**
 * Return to the UI bundled with the app: delete every downloaded version, forget the
 * rejected one, and reload the webview. A no-op on the web.
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
