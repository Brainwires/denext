/**
 * `denext/updates` in the iOS / Android shell: the over-the-air UI (`DenextOta`, `denext mobile
 * add-ota`). A check is `prepareUiUpdate`: the native side downloads and verifies the new UI
 * (signature, sequence, `minNative`, native fingerprint) and stages it, leaving the running UI
 * untouched, so what is reported available is already verified; applying switches to it and the
 * webview reloads. Loaded by {@link ./mod.ts} only in the shell.
 *
 * @module
 */

import {
  applyUiUpdate,
  type OtaCheckOptions,
  type OtaPrepareResult,
  prepareUiUpdate,
} from "../mobile/ota.ts";
import type { RuntimePlatform } from "../mobile/bridge.ts";
import type {
  AvailableUpdate,
  UpdateFailure,
  UpdateProgressListener,
  UpdatesCheck,
  UpdatesConfig,
  UpdatesResult,
} from "./types.ts";

/** The codes that mean only a new app binary brings the server's UI. */
const STORE_CODES = ["native_too_old", "native_mismatch"];

/** What one prepare said, as the shared shapes. */
interface Prepared {
  readonly update?: AvailableUpdate;
  readonly failure?: UpdateFailure;
  readonly needsStoreUpdate: boolean;
}

/** A failure of the `ui` target. */
function uiFailure(code: string, message: string): UpdateFailure {
  return { target: "ui", code, message };
}

/** Map a prepare result to the shared shapes. */
function fromPrepare(result: OtaPrepareResult): Prepared {
  switch (result.kind) {
    case "ready":
      return {
        update: {
          target: "ui",
          version: result.version,
          required: result.required,
          notes: result.notes,
        },
        needsStoreUpdate: false,
      };
    case "current":
      return { needsStoreUpdate: false };
    case "unsupported":
      return {
        failure: uiFailure("unsupported", "this shell has no over-the-air updates (add-ota)"),
        needsStoreUpdate: false,
      };
    case "skipped":
      return {
        failure: uiFailure(result.reason, `the update was skipped (${result.reason})`),
        needsStoreUpdate: false,
      };
    default: {
      const code = result.code ?? "failed";
      return {
        failure: uiFailure(code, result.reason),
        needsStoreUpdate: STORE_CODES.includes(code),
      };
    }
  }
}

/** Prepare (download, verify, stage) with the config's OTA options, or `not_configured`. */
async function prepare(ota: OtaCheckOptions | undefined): Promise<Prepared> {
  if (!ota) {
    return {
      failure: uiFailure("not_configured", "no over-the-air server (updates config `ota`)"),
      needsStoreUpdate: false,
    };
  }
  return fromPrepare(await prepareUiUpdate(ota));
}

/**
 * Check for (and stage) a newer UI.
 *
 * @param platform The shell's platform.
 * @param config The updates config (`ota`).
 * @returns What is on offer.
 */
export async function checkMobile(
  platform: RuntimePlatform,
  config: UpdatesConfig,
): Promise<UpdatesCheck> {
  const found = await prepare(config.ota);
  const updates = found.update ? [found.update] : [];
  return {
    platform,
    available: updates.length > 0,
    updates,
    needsStoreUpdate: found.needsStoreUpdate,
    failures: found.failure ? [found.failure] : [],
  };
}

/**
 * Install a newer UI: stage it, then switch to it. On success the webview reloads into it and the
 * promise does not settle (as `applyUiUpdate`'s); the new page must call `otaBooted()`.
 *
 * @param platform The shell's platform.
 * @param config The updates config (`ota`).
 * @param onProgress Progress reports.
 * @returns What happened, when the page keeps running.
 */
export async function applyMobile(
  platform: RuntimePlatform,
  config: UpdatesConfig,
  onProgress: UpdateProgressListener,
): Promise<UpdatesResult> {
  const result = (failures: UpdateFailure[], needsStoreUpdate = false): UpdatesResult => ({
    platform,
    applied: [],
    restartRequired: false,
    needsStoreUpdate,
    failures,
  });
  // One native step fetches the manifest and, when it is newer, downloads and verifies the UI.
  onProgress({ target: "ui", stage: "checking" });
  const found = await prepare(config.ota);
  if (found.failure) {
    const { code, message } = found.failure;
    onProgress({ target: "ui", stage: "failed", error: message, code });
    return result([found.failure], found.needsStoreUpdate);
  }
  if (!found.update) {
    onProgress({ target: "ui", stage: "up-to-date" });
    return result([]);
  }
  const { version } = found.update;
  onProgress({ target: "ui", stage: "ready", version });
  onProgress({ target: "ui", stage: "applying", version });
  // Settles only when the switch was refused: on success the page is replaced.
  const failed = await applyUiUpdate(version);
  const code = failed.kind === "error" ? failed.code ?? "failed" : "unsupported";
  const message = failed.kind === "error" ? failed.reason : "this shell cannot switch UIs";
  onProgress({ target: "ui", stage: "failed", version, error: message, code });
  return result([uiFailure(code, message)]);
}
