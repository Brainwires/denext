// FULL-APP self-update for a `denext/desktop` (Deno Desktop) app: the whole signed bundle (macOS
// `.app`, the Windows / Linux app directory, or a Linux AppImage) is replaced by a newer signed
// build, next to the UI-overlay updater in `updater.ts` (which never touches the binary).
//
// Every trust decision is made by the denext-pinned Deno Desktop runtime (`Deno.desktop.updater`,
// Rust): this module is a typed wrapper with denext's error type. What the runtime enforces:
//
//  1. SIGNED MANIFEST, NO UNSIGNED PATH. ECDSA P-256 over the exact signed bytes, against the public
//     key baked into the app at package time (`desktop.update.publicKey` → `.deno-desktop/app.json`;
//     the `denext ota keygen` key format). A missing or bad signature is `signature` /
//     `invalid_manifest`, and an app without a baked key cannot update at all (`not_configured`).
//  2. THIS APP, A NEWER VERSION, A FRESH MANIFEST. The manifest's `app` must equal
//     `desktop.app.identifier` (`wrong_app`) and its `version` must be strictly newer than the
//     running deno.json `version` (`downgrade`; the same version is `available: false`).
//     `minVersion` marks older versions as `required` and never permits a downgrade. Every version
//     that failed to start and was rolled back is refused (`rejected`). The manifest must carry
//     `expiresAt` (refused at or after it: `expired`) and `sequence` (lower than the highest this
//     install accepted: `replayed`), so an old manifest served again can't hide a newer release.
//  3. VERIFIED BYTES. https only (`insecure_url`; loopback http behind the dev-only flag), the
//     download stops at the declared size (`size_exceeded`) and must hash to the signed SHA-256
//     (`integrity`), the archive is extracted with tar-slip / symlink / special-file refusal
//     (`unsafe_archive`), and it must be this app's shape (`bundle_mismatch`) built as the offered
//     version (the version compiled into it: `version_mismatch`).
//  4. OS CODE SIGNATURE. macOS: `codesign --verify --deep --strict`, the SAME Team ID as the
//     running app, Gatekeeper (`spctl --assess --type execute`, so the update must be NOTARIZED: a
//     Developer ID build that is not, or an Apple Development build, is refused) and the same
//     signing identifier; Windows: `WinVerifyTrust` of EVERY PE file with the SAME signer issuer
//     and subject (`os_signature`).
//     An unsigned / ad-hoc running app (a dev build) needs the dev-only `allowUnsignedDev`.
//  5. ATOMIC SWAP, CONFIRM OR ROLL BACK. A helper swaps the install once the app has exited (an
//     atomic exchange on macOS / Linux), keeps the previous app as `<name>.old`, and relaunches. The
//     new version must be confirmed ({@linkcode confirmAppUpdate}; `runDesktop` does it once the
//     window has loaded unless `desktop.update.autoConfirm` is `false`); one not confirmed by its
//     next launch is rolled back and refused from then on. No privilege escalation: an install the user cannot
//     write (`/Applications` owned by root, Program Files) is `install_not_writable`.

import { killSidecarsNow } from "./sidecar-registry.ts";

/** Why a full-app update step refused (the runtime's codes, plus `unsupported`). */
export type AppUpdateErrorCode =
  /** The runtime has no `Deno.desktop.updater` (not a Deno Desktop app, or the stock runtime). */
  | "unsupported"
  | "not_configured"
  | "invalid_manifest"
  | "signature"
  | "wrong_app"
  | "downgrade"
  | "rejected"
  | "no_platform"
  | "expired"
  | "replayed"
  | "insecure_url"
  | "size_exceeded"
  | "integrity"
  | "unsafe_archive"
  | "bundle_mismatch"
  | "version_mismatch"
  | "os_signature"
  | "install_not_writable"
  | "unsupported_layout"
  | "not_staged"
  | "busy"
  | "io";

const CODES: ReadonlySet<string> = new Set<AppUpdateErrorCode>([
  "unsupported",
  "not_configured",
  "invalid_manifest",
  "signature",
  "wrong_app",
  "downgrade",
  "rejected",
  "no_platform",
  "expired",
  "replayed",
  "insecure_url",
  "size_exceeded",
  "integrity",
  "unsafe_archive",
  "bundle_mismatch",
  "version_mismatch",
  "os_signature",
  "install_not_writable",
  "unsupported_layout",
  "not_staged",
  "busy",
  "io",
]);

/** A refusal from the full-app updater, with a machine-readable {@linkcode AppUpdateErrorCode}. */
export class AppUpdateError extends Error {
  /** Always `"AppUpdateError"`. */
  override readonly name = "AppUpdateError";
  /**
   * Create a refusal.
   *
   * @param code The machine-readable reason.
   * @param message A human-readable description.
   */
  constructor(readonly code: AppUpdateErrorCode, message: string) {
    super(message);
  }
}

/** Where the signed manifest is and how to reach it. */
export interface AppUpdaterConfig {
  /**
   * The signed manifest's URL (what `denext desktop publish-update` writes, e.g.
   * `https://updates.example.com/myapp/app-update.json`). https only.
   */
  readonly manifestUrl: string;
  /** Extra trusted CA certificates (PEM) for the manifest and archive hosts. */
  readonly caCerts?: readonly string[];
  /** Manifest request timeout in ms. Default 30 000. */
  readonly timeoutMs?: number;
  /** DEV ONLY: accept `http://` to a loopback host (a local test server). */
  readonly allowInsecureLoopback?: boolean;
  /**
   * DEV ONLY: let an unsigned / ad-hoc signed running app (a local dev build) install an update,
   * skipping the Team ID / signer comparison it cannot make. Ignored by a signed app: it can never
   * weaken the OS signature check of a release build.
   */
  readonly allowUnsignedDev?: boolean;
}

/** The result of {@linkcode checkForAppUpdate}. */
export interface AppUpdateCheck {
  /** A newer, verified version exists for this platform. */
  readonly available: boolean;
  /** The manifest's version. */
  readonly version: string;
  /** The running version. */
  readonly currentVersion: string;
  /** The running version is below the manifest's `minVersion`: do not let the user decline. */
  readonly required: boolean;
  /** The release notes, or `null`. */
  readonly releaseNotes: string | null;
  /** When the release was published (the manifest's `publishedAt`), or `null`. */
  readonly publishedAt: string | null;
  /** The archive size in bytes, or `null` when nothing is available. */
  readonly size: number | null;
  /** The manifest's `sequence` (its release counter), or `null` when nothing is available. */
  readonly sequence: number | null;
  /** When installed apps stop accepting the manifest (RFC 3339), or `null` when nothing is. */
  readonly expiresAt: string | null;
}

/** Download progress, in bytes. */
export interface AppUpdateProgress {
  /** Bytes received so far. */
  readonly transferred: number;
  /** The archive's size (from the signed manifest). */
  readonly total: number;
}

/** The result of {@linkcode downloadAppUpdate}: the update is verified and staged. */
export interface AppUpdateStaged {
  /** The staged version. */
  readonly version: string;
  /**
   * How the staged app's OS signature was established: `team` (macOS, same Team ID),
   * `authenticode` (Windows, same signer), `none` (Linux: no OS signature), or `dev-unsigned`.
   */
  readonly signatureMode: string;
  /** The shared Team ID / signer, when there is one. */
  readonly signer: string | null;
}

/** {@linkcode appUpdateStatus}: what the runtime knows about this app and any pending update. */
export interface AppUpdateStatus {
  /** Updates can run here; when not, {@link reason} says why. */
  readonly configured: boolean;
  /** Why updates cannot run here (`<code>: <message>`), or `null`. */
  readonly reason: string | null;
  /** The running version. */
  readonly version: string | null;
  /** `desktop.app.identifier`. */
  readonly appId: string | null;
  /** This build's manifest platform key, `<target>-<backend>`. */
  readonly platform: string | null;
  /** The install that would be replaced. */
  readonly install: string | null;
  /** The update phase recorded next to the install. */
  readonly phase: "idle" | "staged" | "swapping" | "swapped" | "rollingBack" | null;
  /** A swapped-in version awaiting {@linkcode confirmAppUpdate}. */
  readonly pendingVersion: string | null;
  /** The last version rolled back after failing to start. */
  readonly rejected: string | null;
  /**
   * Every version rolled back after failing to start (and newer than the last confirmed one),
   * oldest first: none of them is offered again.
   */
  readonly rejectedVersions: readonly string[];
  /** The highest manifest `sequence` this install has accepted (a lower one is `replayed`). */
  readonly manifestSequence: number | null;
  /** The previous version, when this launch follows an update. */
  readonly updatedFrom: string | null;
  /** The version rolled back, when this launch follows a rollback. */
  readonly rolledBackFrom: string | null;
  /** This is the new version's first, unconfirmed launch. */
  readonly trial: boolean;
}

/** The runtime's `Deno.desktop.updater` (only what this module calls). */
interface RuntimeUpdater {
  check(url: string, options: Record<string, unknown>): Promise<{
    available: boolean;
    version: string;
    currentVersion: string;
    required: boolean;
    releaseNotes: string | null;
    publishedAt: string | null;
    size: number | null;
    sequence?: number | null;
    expiresAt?: string | null;
  }>;
  download(options: Record<string, unknown>): Promise<{ version: string; size: number }>;
  stage(options: Record<string, unknown>): Promise<{
    version: string;
    signature: { mode: string; identity: string | null };
  }>;
  applyAndRelaunch(options: Record<string, unknown>): { quitting: boolean };
  confirm(): boolean;
  status(): AppUpdateStatus;
}

/** The runtime updater, or `undefined` outside denext's pinned Deno Desktop runtime. */
function runtimeUpdater(): RuntimeUpdater | undefined {
  const desktop = (Deno as unknown as { desktop?: { updater?: RuntimeUpdater } }).desktop;
  return desktop?.updater;
}

function requireUpdater(): RuntimeUpdater {
  const updater = runtimeUpdater();
  if (!updater) {
    throw new AppUpdateError(
      "unsupported",
      "full-app updates need denext's pinned Deno Desktop runtime (Deno.desktop.updater)",
    );
  }
  return updater;
}

/** What a macOS Gatekeeper refusal of the staged app almost always means, and the fix. */
const GATEKEEPER_HINT = "on macOS a full-app update must be signed with your Developer ID and " +
  "notarized (DENEXT_NOTARY_PROFILE when packaging)";

/**
 * The runtime's message, plus {@linkcode GATEKEEPER_HINT} when it is the macOS Gatekeeper
 * (`spctl --assess`) refusal: the runtime reports only spctl's bare verdict ("rejected"), and the
 * usual cause is a Developer ID build that was never notarized (or an Apple Development one).
 */
function withHint(code: string, message: string): string {
  if (code !== "os_signature" || !/gatekeeper|spctl/i.test(message)) return message;
  return message.includes(GATEKEEPER_HINT) ? message : `${message} (hint: ${GATEKEEPER_HINT})`;
}

/** Rethrow a runtime error as an {@linkcode AppUpdateError} (an unknown code becomes `io`). */
function rethrow(err: unknown): never {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" && CODES.has(e.code) ? e.code : "io";
  const message = typeof e?.message === "string" ? e.message : String(err);
  throw new AppUpdateError(code as AppUpdateErrorCode, withHint(code, message));
}

async function guard<T>(f: () => T | Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (err) {
    rethrow(err);
  }
}

function fetchOptions(config: AppUpdaterConfig): Record<string, unknown> {
  return {
    ...(config.caCerts ? { caCerts: [...config.caCerts] } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.allowInsecureLoopback === true ? { allowInsecureLoopback: true } : {}),
  };
}

/**
 * Fetch and verify the signed manifest. Resolves `available: false` when it offers the running
 * version; throws on anything that does not verify (see the module's invariants).
 *
 * @param config Where the manifest is.
 * @returns What the manifest offers.
 * @throws {@linkcode AppUpdateError}
 */
export async function checkForAppUpdate(config: AppUpdaterConfig): Promise<AppUpdateCheck> {
  const updater = requireUpdater();
  const r = await guard(() => updater.check(config.manifestUrl, fetchOptions(config)));
  return {
    available: r.available,
    version: r.version,
    currentVersion: r.currentVersion,
    required: r.required,
    releaseNotes: r.releaseNotes,
    publishedAt: r.publishedAt,
    size: r.size,
    sequence: r.sequence ?? null,
    expiresAt: r.expiresAt ?? null,
  };
}

/**
 * Download the update {@linkcode checkForAppUpdate} found (size-capped, SHA-256 checked) next to
 * the install, extract it safely and run the OS code-signature check. When this resolves, the
 * update is verified and staged; nothing at the install path has changed yet.
 *
 * @param config The same config as the check (its `allowUnsignedDev` applies here).
 * @param options `onProgress` (bytes) and an abort `signal`.
 * @returns The staged version and how its OS signature was established.
 * @throws {@linkcode AppUpdateError}
 */
export async function downloadAppUpdate(
  config: AppUpdaterConfig,
  options: { onProgress?: (progress: AppUpdateProgress) => void; signal?: AbortSignal } = {},
): Promise<AppUpdateStaged> {
  const updater = requireUpdater();
  await guard(() =>
    updater.download({
      ...fetchOptions(config),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  );
  const staged = await guard(() =>
    updater.stage(config.allowUnsignedDev === true ? { allowUnsignedDev: true } : {})
  );
  return {
    version: staged.version,
    signatureMode: staged.signature.mode,
    signer: staged.signature.identity,
  };
}

/**
 * Install the staged update: start the swap helper and quit the app (Electron's
 * `quitAndInstall`). The helper waits for this process to exit, swaps the install, and relaunches
 * the new version, which `runDesktop` confirms once its window has loaded (or, with
 * `desktop.update.autoConfirm: false`, the app's own {@linkcode confirmAppUpdate} call).
 *
 * The app's sidecars (`desktop.sidecars`) are ended first, so none holds the install open; to give
 * them their graceful shutdown, `await stopSidecars()` (from `denext/desktop`) before calling it.
 *
 * @param options `force: true` exits even when a `beforequit` / `close` listener refuses.
 * @returns `quitting: false` when the app refused to quit: the runtime withdraws the install
 *   request and the helper stands down, leaving the app as it was.
 * @throws {@linkcode AppUpdateError} `not_staged` when nothing was staged in this run.
 */
export function installAppUpdateAndRelaunch(
  options: { force?: boolean } = {},
): { quitting: boolean } {
  const updater = requireUpdater();
  killSidecarsNow();
  try {
    return updater.applyAndRelaunch(options.force === true ? { force: true } : {});
  } catch (err) {
    rethrow(err);
  }
}

/**
 * Confirm the running version after an update, once the app has shown it is healthy (its window
 * loaded, its backend answered): the update is final, and the previous app is moved aside and
 * deleted in the background (the call does not wait for the deletion). An update
 * not confirmed by its next launch is rolled back and that version is refused from then on. A no-op
 * (`false`) when no update is pending, so it is safe to call on every launch. `runDesktop` calls it
 * once the window has loaded unless `desktop.update.autoConfirm` is `false`.
 *
 * @returns Whether a pending update was confirmed.
 * @throws {@linkcode AppUpdateError} on a file-system failure.
 */
export function confirmAppUpdate(): boolean {
  const updater = runtimeUpdater();
  if (!updater) return false;
  try {
    return updater.confirm();
  } catch (err) {
    rethrow(err);
  }
}

/**
 * The runtime's view of full-app updates for this app, or `null` outside denext's pinned Deno
 * Desktop runtime.
 *
 * @returns The status.
 */
export function appUpdateStatus(): AppUpdateStatus | null {
  return runtimeUpdater()?.status() ?? null;
}
