/**
 * Over-the-air (OTA) UI updates for `denext/mobile`: the web side of the native
 * `DenextOta` Capacitor plugin that `denext mobile add-ota` installs.
 *
 * The shell bundles a static export stamped with `_denext/ota.json` (`spa.ota`, or
 * `denext ota manifest out`). {@linkcode checkForUiUpdate} fetches the same manifest from
 * a server and, when its version differs from the UI running now, has the native side
 * download, verify and switch to it. The switched-to UI must call {@linkcode otaBooted}
 * once it has rendered, or the native watchdog rolls it back (after 15 s of foreground time
 * by default; Info.plist `DenextOtaBootTimeout` / meta-data `dev.denext.ota.BOOT_TIMEOUT`).
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

import { runtimePlatform, shellPlugin } from "./bridge.ts";
import { listenerDisposer, type ListenerHandle } from "./plugin.ts";
import {
  isOtaManifest,
  OTA_MANIFEST_PATH,
  OTA_PLATFORM_HEADER,
  OTA_PLATFORM_PATH,
  type OtaManifest,
  otaPlatformMismatch,
} from "./ota-manifest.ts";

/**
 * The `code` of a native `DenextOta` refusal, carried on an `error` result:
 *
 * - `invalid`: a malformed request or manifest; `busy`, `rejected`: see the results;
 * - `download`: a file could not be fetched; `integrity`: a file, or the manifest's `version`
 *   (the native side recomputes it from the file list), does not match;
 * - `not_staged`: {@linkcode applyUiUpdate} named a version that is not staged;
 * - `signature`: the app binary embeds a public key (`denext mobile add-ota --public-key`) and the
 *   manifest's `signature` is missing or does not verify;
 * - `insecure`: the binary pins origins (`denext mobile add-ota --ota-origin`) and `baseUrl` is on
 *   none of them, or it embeds no key and `baseUrl` is neither a pinned https origin nor loopback
 *   (`localhost`, `127.0.0.1`, `::1`, and `10.0.2.2` in a debuggable Android build);
 * - `downgrade`: the manifest's `sequence` is lower than the highest this device has accepted,
 *   or it has none after a sequenced manifest was accepted;
 * - `native_too_old`: the manifest's `minNative` is above the app binary's build number (iOS
 *   `CFBundleVersion`, Android `versionCode`);
 * - `native_mismatch`: the manifest's `nativeFingerprint` differs from the one the app binary
 *   embeds (`denext mobile fingerprint --write`): the UI was built for another native layer.
 *   Checked only when both carry one.
 * - `platform_mismatch`: the manifest names another target than this shell's (`ios` /
 *   `android`): it is that platform's export (`denext export --platform`), with that platform's
 *   files. Checked here, before the native side sees it. The manifest's `platform` field is not
 *   signed; the export's stamp file is (the version covers it), so a stamped export is refused
 *   by another target whether or not the field is present. Only a manifest with neither (a `web`
 *   export) fits every shell.
 *
 * The trust checks (`integrity`, `signature`, `insecure`, `downgrade`, `native_too_old`,
 * `native_mismatch`, and
 * `invalid` for a malformed or oversized manifest) run before any file is downloaded, and a
 * refusal leaves the running UI and any staged one as they were.
 */
export type OtaErrorCode =
  | "invalid"
  | "busy"
  | "rejected"
  | "download"
  | "integrity"
  | "not_staged"
  | "signature"
  | "insecure"
  | "downgrade"
  | "native_too_old"
  | "native_mismatch"
  | "platform_mismatch";

// An array literal, not a `new Set(...)`: bundlers keep a module-level constructor call,
// which would pin this module into every bundle that imports `denext/mobile`.
const OTA_ERROR_CODES: readonly string[] = [
  "invalid",
  "busy",
  "rejected",
  "download",
  "integrity",
  "not_staged",
  "signature",
  "insecure",
  "downgrade",
  "native_too_old",
  "native_mismatch",
  "platform_mismatch",
] satisfies readonly OtaErrorCode[];

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
  /**
   * The last downloaded version that failed re-verification and was taken out of service (see
   * {@linkcode onOtaRejected}), or `null`. Cleared by {@linkcode otaReset}; `null` from a shell
   * older than that check.
   */
  readonly tampered: string | null;
}

/**
 * What {@linkcode onOtaRejected} reports: a downloaded UI that failed re-verification.
 */
export interface OtaRejectedEvent {
  /** The version that was quarantined. */
  readonly version: string;
  /** The native side's reason, e.g. `"assets/app.js does not match the signed manifest."`. */
  readonly reason: string;
}

/** The JS face of the native `DenextOta` plugin (Capacitor seeds a stub per method). */
interface DenextOtaPlugin {
  status(): Promise<Partial<OtaStatus>>;
  apply(options: {
    baseUrl: string;
    headers: Record<string, string>;
    manifest: OtaManifest;
  }): Promise<unknown>;
  /** `version` binds the confirmation to this page's UI (a shell older than that ignores it). */
  booted(options: { version?: string }): Promise<unknown>;
  reset(): Promise<unknown>;
  /** Added with prepare/apply; a shell installed before that lacks them. */
  download?(options: {
    baseUrl: string;
    headers: Record<string, string>;
    manifest: OtaManifest;
  }): Promise<unknown>;
  /** Added with prepare/apply; a shell installed before that lacks them. */
  activate?(options: { version: string }): Promise<unknown>;
  /** Capacitor's listener registration (the `otaRejected` event). */
  addListener?(
    eventName: "otaRejected",
    listener: (event: Partial<OtaRejectedEvent> | undefined) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
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
  /**
   * The OTA channel this app follows (`"production"`, `"beta"`, …), sent as the
   * `x-denext-ota-channel` header on the manifest request and on every native file download. A
   * server built with `createOtaHandler({ channels })` serves that channel's release; without it
   * the server's default channel. Setting it turns on `installId: "auto"`.
   */
  channel?: string;
  /**
   * The install id sent as `x-denext-ota-install-id`, which a channels server hashes into the
   * device's staged-rollout bucket (a request without one always gets the stable release).
   * `"auto"` (the default when `channel` is set) uses {@linkcode otaInstallId}, a random id kept
   * in `localStorage`; a string is sent as given (8–128 characters of `[A-Za-z0-9_-]`, or the
   * server ignores it). Omitted without `channel`: no header.
   */
  installId?: string;
  /**
   * This shell's target, which a manifest naming another one is refused against (code
   * `platform_mismatch`) and which is sent as the `x-denext-ota-platform` header (a
   * `createOtaHandler({ platforms })` server serves each target its own export). Default:
   * `runtimePlatform()` in the iOS / Android shell.
   */
  platform?: "ios" | "android";
  /**
   * Called when the server's UI needs a newer app binary: a check or prepare that ends in an
   * `error` result with code `native_too_old` (the manifest's `minNative` is above this build) or
   * `native_mismatch` (it was built for another native fingerprint). The usual answer is a
   * store-update prompt. It is fired once per call after the result is known, not awaited into
   * it; a throw or rejection is swallowed and the result is returned unchanged.
   *
   * @example
   * ```ts
   * import { checkForUiUpdate, promptStoreUpdate } from "denext/mobile";
   *
   * await checkForUiUpdate({
   *   baseUrl: "https://api.example.com/mobile-ui",
   *   onNativeUpdateRequired: () => promptStoreUpdate({ appStoreId: "123456789" }),
   * });
   * ```
   */
  onNativeUpdateRequired?: (
    refusal: { code: "native_too_old" | "native_mismatch"; reason: string },
  ) => void | Promise<void>;
}

/** The outcome of {@linkcode checkForUiUpdate}. It never throws; every failure is a value. */
export type OtaCheckResult =
  /** Not inside the native shell, or the shell has no `DenextOta` plugin. */
  | { readonly kind: "unsupported" }
  /** The server offers the version already running (or on its trial launch). */
  | { readonly kind: "current" }
  /** The new UI was downloaded and verified; the webview is reloading into it. */
  | { readonly kind: "applied"; readonly version: string }
  /**
   * The native side declined: `"rejected"` (this version was rolled back on this device;
   * `otaReset()` clears that) or `"busy"` (an apply or a trial launch is in progress).
   */
  | { readonly kind: "skipped"; readonly reason: "rejected" | "busy" }
  /**
   * Network, HTTP, JSON, manifest-shape, timeout, download, integrity, signature or transport
   * failure. `code` is set when the native side refused (see {@linkcode OtaErrorCode}).
   */
  | { readonly kind: "error"; readonly reason: string; readonly code?: OtaErrorCode };

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
  /**
   * Network, HTTP, JSON, manifest-shape, timeout, download, integrity, signature or transport
   * failure. `code` is set when the native side refused (see {@linkcode OtaErrorCode}).
   */
  | { readonly kind: "error"; readonly reason: string; readonly code?: OtaErrorCode };

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
   * version at all (`invalid`). `reason` is the native message, `code` the native code.
   */
  | { readonly kind: "error"; readonly reason: string; readonly code?: OtaErrorCode };

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

/** A native refusal as an `error` result, with its code when it is a known one. */
function nativeError(
  err: unknown,
): { readonly kind: "error"; readonly reason: string; readonly code?: OtaErrorCode } {
  const code = codeOf(err);
  return typeof code === "string" && OTA_ERROR_CODES.includes(code)
    ? { kind: "error", reason: messageOf(err), code: code as OtaErrorCode }
    : { kind: "error", reason: messageOf(err) };
}

/** The `localStorage` key {@linkcode otaInstallId} keeps the id under. */
const INSTALL_ID_KEY = "denext:ota-install-id";

/** The id {@linkcode otaInstallId} uses when storage is unavailable (this page's lifetime). */
let memoryInstallId: string | undefined;

/** The slice of `localStorage` {@linkcode otaInstallId} uses. */
interface IdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 16 random bytes as base64url (22 characters). */
function newInstallId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * This install's stable OTA id: a random base64url string made on first use and kept in
 * `localStorage` (`denext:ota-install-id`), so a channels server (`createOtaHandler({ channels
 * })`) puts the device in the same staged-rollout bucket on every check. It identifies nothing
 * but the install; clearing the app's data makes a new one. Where storage is unavailable it
 * lasts for the page's lifetime.
 *
 * @returns The install id (22 characters of `[A-Za-z0-9_-]`).
 * @example
 * ```ts
 * import { otaInstallId } from "denext/mobile";
 * console.info("OTA install", otaInstallId());
 * ```
 */
export function otaInstallId(): string {
  let storage: IdStorage | undefined;
  try {
    storage = (globalThis as { localStorage?: IdStorage }).localStorage;
    const stored = storage?.getItem(INSTALL_ID_KEY);
    if (typeof stored === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(stored)) return stored;
  } catch {
    storage = undefined;
  }
  // An id this page already made while storage failed stays the id (and is persisted now).
  const id = memoryInstallId ?? newInstallId();
  try {
    if (storage) {
      storage.setItem(INSTALL_ID_KEY, id);
      return id;
    }
  } catch {
    // Storage refused the write (private mode, quota): keep it for this page instead.
  }
  return memoryInstallId = id;
}

/**
 * The headers of the manifest request and every native download: the app's, plus the channel's.
 * The target header goes only where a per-target feed needs it: `options.platform` was passed, or
 * the running UI is a platform export (it carries the stamp). Any custom header makes a
 * cross-origin request preflighted (`OPTIONS`), so an app with one export per feed keeps sending
 * simple GETs, as before platform exports.
 */
async function otaRequestHeaders(options: OtaCheckOptions): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.channel !== undefined) headers["x-denext-ota-channel"] = options.channel;
  const platform = shellTarget(options);
  if (platform !== undefined && (options.platform !== undefined || await runningUiStamped())) {
    headers[OTA_PLATFORM_HEADER] = platform;
  }
  const installId = options.installId ?? (options.channel !== undefined ? "auto" : undefined);
  if (installId !== undefined) {
    headers["x-denext-ota-install-id"] = installId === "auto" ? otaInstallId() : installId;
  }
  return headers;
}

let stamped: Promise<boolean> | null = null;

/**
 * Whether the running UI is a platform export: its origin serves the stamp
 * (`_denext/platform.txt`) naming a target. Same-origin, read once per page.
 */
function runningUiStamped(): Promise<boolean> {
  return stamped ??= (async () => {
    try {
      const href = (globalThis as { location?: { href?: string } }).location?.href;
      if (!href) return false;
      const response = await fetch(new URL(`/${OTA_PLATFORM_PATH}`, href), { cache: "no-store" });
      const text = response.ok ? (await response.text()).trim() : "";
      if (!response.ok) await response.body?.cancel();
      return /^(?:ios|android|macos|windows|linux)$/.test(text);
    } catch {
      return false;
    }
  })();
}

/** Forget {@linkcode runningUiStamped}'s answer (tests swap the page under it). @internal */
export function resetOtaStampForTesting(): void {
  stamped = null;
}

/** The shell's target: `options.platform`, else the shell's own (undefined off iOS / Android). */
function shellTarget(options: OtaCheckOptions): "ios" | "android" | undefined {
  if (options.platform !== undefined) return options.platform;
  const runtime = runtimePlatform();
  return runtime === "ios" || runtime === "android" ? runtime : undefined;
}

/** Fire `onNativeUpdateRequired` for a `native_too_old` / `native_mismatch` result; return it. */
function notifyNativeRequired<R extends { readonly kind: string }>(
  options: OtaCheckOptions,
  result: R,
): R {
  const callback = options.onNativeUpdateRequired;
  const code = (result as { code?: unknown }).code;
  if (
    typeof callback === "function" && result.kind === "error" &&
    (code === "native_too_old" || code === "native_mismatch")
  ) {
    const reason = String((result as { reason?: unknown }).reason ?? "");
    try {
      Promise.resolve(callback({ code, reason })).catch(() => {});
    } catch {
      // The app's handler threw: the result stands.
    }
  }
  return result;
}

/** Fetch and validate `${baseUrl}/_denext/ota.json`; a string is the failure reason. */
async function fetchManifest(
  baseUrl: string,
  options: OtaCheckOptions,
  headers: Record<string, string>,
): Promise<OtaManifest | string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const doFetch = options.fetch ?? globalThis.fetch;
    const response = await doFetch(`${baseUrl}/${OTA_MANIFEST_PATH}`, {
      headers,
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
  headers: Record<string, string>,
): Promise<
  | { readonly kind: "current" }
  | { readonly kind: "error"; readonly reason: string; readonly code?: OtaErrorCode }
  | { readonly kind: "newer"; readonly manifest: OtaManifest; readonly baseUrl: string }
> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const manifest = await fetchManifest(baseUrl, options, headers);
  if (typeof manifest === "string") return { kind: "error", reason: manifest };
  const target = shellTarget(options);
  const mismatch = target === undefined ? null : await otaPlatformMismatch(manifest, target);
  if (mismatch !== null) return { kind: "error", reason: mismatch, code: "platform_mismatch" };
  let status: Partial<OtaStatus>;
  try {
    status = await plugin.status();
  } catch (err) {
    return { kind: "error", reason: `status failed: ${messageOf(err)}` };
  }
  // A version on its trial launch is the one running (or about to be): offering it again is
  // not an update, whatever `current` still says.
  const running = status.pending ?? status.current ?? status.bundled ?? null;
  if (manifest.version === running) return { kind: "current" };
  return { kind: "newer", manifest, baseUrl };
}

/**
 * Whether a native `apply` / `download` result says it did nothing because the version is the
 * running one (`switched: false` / `staged: false`; a shell older than that says neither).
 */
function isNoOp(result: unknown, key: "switched" | "staged"): boolean {
  return typeof result === "object" && result !== null &&
    (result as Record<string, unknown>)[key] === false;
}

/** A native download/apply rejection as a `skipped` or `error` result. */
function refusal(
  err: unknown,
):
  | { readonly kind: "skipped"; readonly reason: "rejected" | "busy" }
  | { readonly kind: "error"; readonly reason: string; readonly code?: OtaErrorCode } {
  const code = codeOf(err);
  if (code === "rejected" || code === "busy") return { kind: "skipped", reason: code };
  return nativeError(err);
}

/** Where {@linkcode install} stops short of installing: every result both runs share. */
type InstallStop =
  | { readonly kind: "unsupported" }
  | { readonly kind: "current" }
  | ReturnType<typeof refusal>;

/**
 * The steps {@linkcode checkForUiUpdate} and {@linkcode prepareUiUpdate} share: `unsupported`
 * without a plugin; else fetch and validate the manifest, compare it with the running UI, and
 * hand a newer one to the native side through `call` (`apply` or `download`). A `stop` ends the
 * run: a failure, a refusal, or `current` when the version runs already (also when the native
 * side reports `noOpKey: false`). Otherwise the manifest that was installed.
 */
async function install<P extends DenextOtaPlugin>(
  plugin: P | undefined,
  options: OtaCheckOptions,
  noOpKey: "switched" | "staged",
  call: (plugin: P, request: Parameters<DenextOtaPlugin["apply"]>[0]) => Promise<unknown>,
): Promise<{ readonly stop: InstallStop } | { readonly manifest: OtaManifest }> {
  if (!plugin) return { stop: { kind: "unsupported" } };
  const headers = await otaRequestHeaders(options);
  const found = await newerManifest(plugin, options, headers);
  if (found.kind !== "newer") return { stop: found };
  const { manifest, baseUrl } = found;
  let result: unknown;
  try {
    result = await call(plugin, { baseUrl, headers, manifest });
  } catch (err) {
    return { stop: refusal(err) };
  }
  return isNoOp(result, noOpKey) ? { stop: { kind: "current" } } : { manifest };
}

/** The whole check; {@linkcode checkForUiUpdate} adds the single-flight wrapper. */
async function runCheck(options: OtaCheckOptions): Promise<OtaCheckResult> {
  // Native `apply` (download + switch in one call), which every DenextOta shell has.
  const done = await install(otaPlugin(), options, "switched", (p, request) => p.apply(request));
  return "stop" in done ? done.stop : { kind: "applied", version: done.manifest.version };
}

/** The whole prepare; {@linkcode prepareUiUpdate} adds the single-flight wrapper. */
async function runPrepare(options: OtaCheckOptions): Promise<OtaPrepareResult> {
  const done = await install(stagingPlugin(), options, "staged", (p, r) => p.download(r));
  if ("stop" in done) return done.stop;
  const { manifest } = done;
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

// Created on first use, not at module scope: a module-level call is a side effect bundlers
// keep, so `import { isNativeShell } from "denext/mobile"` would ship the whole OTA client.
let checkFlight: ((options: OtaCheckOptions) => Promise<OtaCheckResult>) | undefined;
let prepareFlight: ((options: OtaCheckOptions) => Promise<OtaPrepareResult>) | undefined;

/**
 * Check a server for a newer UI and, when it offers a different version, install it.
 *
 * 1. Fetches `${baseUrl}/_denext/ota.json` (with `headers`, `cache: "no-store"` and a
 *    timeout) and validates its shape.
 * 2. Asks the native `DenextOta` plugin for its {@linkcode OtaStatus}; if the manifest's
 *    version equals the running UI (`pending`, else `current`, else `bundled`), it returns
 *    `current` (as it does when the native side finds nothing to switch).
 * 3. Otherwise the plugin downloads `${baseUrl}/<path>` for every file (copying files it
 *    already has by SHA-256), verifies each SHA-256 and size, switches the webview's web
 *    root to the new directory and reloads. The new page must call {@linkcode otaBooted}
 *    within the boot timeout (15 s of foreground time by default) or it is rolled back.
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
  checkFlight ??= singleFlight<OtaCheckResult>(runCheck, asError);
  const flight = checkFlight(options);
  // Without a callback the in-flight promise itself is returned, so concurrent callers share it.
  return options.onNativeUpdateRequired
    ? flight.then((result) => notifyNativeRequired(options, result))
    : flight;
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
  prepareFlight ??= singleFlight<OtaPrepareResult>(runPrepare, asError);
  const flight = prepareFlight(options);
  // Without a callback the in-flight promise itself is returned, so concurrent callers share it.
  return options.onNativeUpdateRequired
    ? flight.then((result) => notifyNativeRequired(options, result))
    : flight;
}

/**
 * Switch to the UI {@linkcode prepareUiUpdate} staged: the native side starts its trial,
 * arms the rollback watchdog (15 s of foreground time by default), points the webview at it
 * and reloads. The new page must
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
    return nativeError(err);
  }
  // The native side has switched the web root and is reloading: this page is going away.
  return await new Promise<never>(() => {});
}

/** This page's own UI version, once read (see {@linkcode pageUiVersion}). */
let ownVersion: string | undefined;

/**
 * The version in the `_denext/ota.json` next to this page (the web root the webview serves), or
 * undefined without one. It names the files this page was loaded from, whatever the native side
 * has switched to since, which is what binds a confirmation to the page that sends it. The first
 * version read is kept for the page's lifetime.
 */
export async function pageUiVersion(): Promise<string | undefined> {
  if (ownVersion !== undefined) return ownVersion;
  try {
    const href = (globalThis as { location?: { href?: string } }).location?.href;
    if (typeof href !== "string") return undefined;
    const response = await fetch(new URL(`/${OTA_MANIFEST_PATH}`, href), { cache: "no-store" });
    if (!response.ok) return void await response.body?.cancel();
    const body: unknown = await response.json();
    if (isOtaManifest(body)) ownVersion = body.version;
  } catch {
    // No manifest to read (an unstamped UI, or no network stack): confirm without a version.
  }
  return ownVersion;
}

/**
 * Confirm to the native side that the running UI booted. Call it once after the app's
 * first render: a UI on its trial launch that never calls it is rolled back by the
 * native watchdog (after 15 s of foreground time by default), and on the next launch if the
 * app died twice before confirming. Harmless on the bundled UI or a confirmed one.
 *
 * It sends this page's own UI version, read from the `_denext/ota.json` the page was served
 * with (its web root), and the native side confirms only when that is the version on trial.
 * A late call from the page being replaced therefore cannot confirm the new UI. The manifest
 * is read at the first call, before the page could have been switched away from; reading
 * `otaStatus().pending` instead would name the new version as soon as the switch starts.
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
  const plugin = otaPlugin();
  if (!plugin) return;
  try {
    const version = await pageUiVersion();
    await plugin.booted(version === undefined ? {} : { version });
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
    tampered: s.tampered ?? null,
  };
}

/**
 * Call `listener` when the native side refuses a downloaded UI that no longer matches its signed
 * manifest. The shell re-verifies a downloaded UI whenever it serves it: at every launch it
 * checks the manifest stored with the files (its signature with the embedded key, and its
 * version), and it hashes each file the first time it serves it. A file changed, added or
 * removed on the device after the download (another app on a rooted or jailbroken device,
 * malware with storage access, or corruption) is never served: the version is quarantined, the
 * webview switches to the bundled UI (or the confirmed one), and this fires there. The event is
 * kept until a listener is added, so register early (in the root layout); {@linkcode otaStatus}
 * reports the same version as `tampered`. The version may be downloaded again.
 *
 * On the web, and in a shell whose `DenextOta` plugin predates this check, it never fires and
 * the returned function does nothing.
 *
 * @param listener Called with the quarantined version and the reason.
 * @returns A function that removes the listener.
 * @example
 * ```ts
 * import { onOtaRejected } from "denext/mobile";
 *
 * onOtaRejected(({ version, reason }) => reportToServer("ota-tampered", { version, reason }));
 * ```
 */
export function onOtaRejected(listener: (event: OtaRejectedEvent) => void): () => void {
  const plugin = otaPlugin();
  if (typeof plugin?.addListener !== "function") return () => {};
  return listenerDisposer(plugin.addListener("otaRejected", (event) => {
    if (typeof event?.version !== "string") return;
    listener({
      version: event.version,
      reason: typeof event.reason === "string" ? event.reason : "",
    });
  }));
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
