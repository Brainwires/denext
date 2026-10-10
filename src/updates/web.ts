/**
 * `denext/updates` in a browser tab: a newer deploy is picked up by reloading. The deployed
 * build's version is read from `_denext/ota.json` (what `spa.ota: true` and `denext ota manifest`
 * write next to the export; its `version` hashes every file) or the configured `versionUrl`, and
 * compared with the version this page was built as. Loaded by {@link ./mod.ts} off the native
 * shells.
 *
 * @module
 */

import { isOtaManifest, OTA_MANIFEST_PATH } from "../mobile/ota-manifest.ts";
import type {
  UpdateFailure,
  UpdateProgressListener,
  UpdatesCheck,
  UpdatesResult,
  WebUpdatesConfig,
} from "./types.ts";

/** The default request timeout, in ms. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** The version this page was first seen to run (see {@linkcode WebUpdatesConfig.currentVersion}). */
let baseline: string | undefined;

/** Forget the remembered page version (tests). @internal */
export function resetWebUpdatesForTesting(): void {
  baseline = undefined;
}

/** A version from a response body: a manifest's `version`, a `version` / `buildId`, or text. */
function versionOf(text: string): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    const plain = text.trim();
    return plain !== "" && plain.length <= 256 && !plain.includes("<") ? plain : undefined;
  }
  if (isOtaManifest(body)) return body.version;
  const fields = body as { version?: unknown; buildId?: unknown } | null;
  for (const v of [fields?.version, fields?.buildId]) {
    if (typeof v === "string" && v !== "") return v;
  }
  return typeof body === "string" || typeof body === "number" ? String(body) : undefined;
}

/** The deployed version, or the failure. */
async function deployedVersion(
  config: WebUpdatesConfig,
): Promise<{ version: string } | { failure: UpdateFailure }> {
  const url = config.versionUrl ?? `/${OTA_MANIFEST_PATH}`;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fail = (code: string, message: string) => ({
    failure: { target: "web" as const, code, message },
  });
  try {
    const doFetch = config.fetch ?? globalThis.fetch;
    const response = await doFetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      return fail("no_version", `${url} answered HTTP ${response.status}`);
    }
    const version = versionOf(await response.text());
    return version === undefined ? fail("no_version", `${url} names no version`) : { version };
  } catch (err) {
    return controller.signal.aborted
      ? fail("network", `${url} did not answer in ${timeoutMs} ms`)
      : fail("network", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** The deployed version compared with this page's: newer, current, or why it could not say. */
async function compare(
  config: WebUpdatesConfig,
): Promise<{ newer?: string; failure?: UpdateFailure }> {
  const deployed = await deployedVersion(config);
  if ("failure" in deployed) return { failure: deployed.failure };
  const running = config.currentVersion ?? (baseline ??= deployed.version);
  return deployed.version === running ? {} : { newer: deployed.version };
}

/**
 * Check whether a newer build is deployed.
 *
 * @param config Where the version is read.
 * @returns What is on offer.
 */
export async function checkWeb(config: WebUpdatesConfig = {}): Promise<UpdatesCheck> {
  const { newer, failure } = await compare(config);
  return {
    platform: "web",
    available: newer !== undefined,
    updates: newer === undefined
      ? []
      : [{ target: "web", version: newer, required: false, notes: null }],
    needsStoreUpdate: false,
    failures: failure ? [failure] : [],
  };
}

/**
 * Reload into a newer build when one is deployed. The page is then replaced, so the promise does
 * not settle.
 *
 * @param config Where the version is read, and how to reload.
 * @param onProgress Progress reports.
 * @returns What happened, when the page keeps running.
 */
export async function applyWeb(
  config: WebUpdatesConfig = {},
  onProgress: UpdateProgressListener,
): Promise<UpdatesResult> {
  onProgress({ target: "web", stage: "checking" });
  const { newer, failure } = await compare(config);
  const result = (failures: UpdateFailure[]): UpdatesResult => ({
    platform: "web",
    applied: [],
    restartRequired: false,
    needsStoreUpdate: false,
    failures,
  });
  if (failure) {
    onProgress({ target: "web", stage: "failed", error: failure.message, code: failure.code });
    return result([failure]);
  }
  if (newer === undefined) {
    onProgress({ target: "web", stage: "up-to-date" });
    return result([]);
  }
  onProgress({ target: "web", stage: "ready", version: newer });
  onProgress({ target: "web", stage: "applying", version: newer });
  const reload = config.reload ??
    (() => (globalThis as { location?: { reload?: () => void } }).location?.reload?.());
  reload();
  // The page is being replaced by the new build.
  return await new Promise<never>(() => {});
}
