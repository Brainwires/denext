/**
 * One "update everything" API for every platform a denext app ships to (`denext/updates`):
 * {@linkcode checkForUpdates} says what is on offer and {@linkcode applyUpdates} installs it,
 * reporting progress in one shape ({@linkcode UpdateProgress}). Each platform keeps its own
 * mechanism and every one of its safety checks:
 *
 * - **iOS / Android** (the Capacitor shell): the over-the-air UI (`denext mobile add-ota`). The
 *   native side verifies the signature, the sequence (no downgrade), `minNative` and the native
 *   fingerprint before staging anything; a UI that needs a newer binary is reported as
 *   `needsStoreUpdate`.
 * - **Deno Desktop**: the whole app (`desktop.update.manifestUrl`, denext's pinned runtime: a
 *   signed, unexpired, newer manifest and the same code signer) when a newer one is on offer,
 *   which brings its own UI, else the signed UI overlay (`desktop.update.ui`), through the
 *   `updates` capability (`denext desktop add updates`), with download percentages.
 * - **A browser tab**: a newer deploy (the version in `_denext/ota.json`, or `web.versionUrl`)
 *   is picked up by reloading.
 *
 * Installing replaces the page where the platform does (a phone's UI switch, a browser reload, a
 * desktop app's relaunch): {@linkcode applyUpdates} then does not settle. A desktop UI overlay is
 * served from the next launch (`restartRequired`).
 *
 * Client-only and opt-in: nothing runs at import, and each platform's code is loaded on the first
 * call that needs it, so the module costs a page that never calls it nothing.
 *
 * @example
 * ```tsx
 * "use client";
 * import { useState } from "denext";
 * import { applyUpdates, checkForUpdates, type UpdateProgress } from "denext/updates";
 *
 * const config = { ota: { baseUrl: "https://api.example.com/mobile-ui" } };
 *
 * export function UpdateButton() {
 *   const [progress, setProgress] = useState<UpdateProgress | null>(null);
 *   const update = async () => {
 *     const found = await checkForUpdates(config);
 *     if (found.needsStoreUpdate) return alert("Please update the app from the store.");
 *     if (!found.available) return;
 *     const done = await applyUpdates(config, setProgress);
 *     if (done.restartRequired) alert("Restart to finish updating.");
 *   };
 *   return (
 *     <button type="button" onClick={update}>
 *       {progress ? `${progress.target}: ${progress.stage} ${progress.percent ?? ""}` : "Update"}
 *     </button>
 *   );
 * }
 * ```
 *
 * @module
 */

import { runtimePlatform } from "../mobile/bridge.ts";
import type {
  UpdateProgressListener,
  UpdatesCheck,
  UpdatesConfig,
  UpdatesResult,
} from "./types.ts";

export type {
  AvailableUpdate,
  DesktopUpdatesConfig,
  UpdateFailure,
  UpdateProgress,
  UpdateProgressListener,
  UpdatesCheck,
  UpdatesConfig,
  UpdatesResult,
  UpdateStage,
  UpdateTarget,
  WebUpdatesConfig,
} from "./types.ts";

/**
 * What the server offers this app, on whatever platform it runs. It never throws: a target that
 * could not be checked is listed in `failures`.
 *
 * On a phone the check also downloads and verifies the new UI and stages it (the running UI keeps
 * running), so what it reports is already verified and {@linkcode applyUpdates} switches at once.
 * On Deno Desktop the app's Deno side verifies each manifest before reporting it. In a browser it
 * compares the deployed build's version with this page's.
 *
 * @param config Where each platform's updates come from (only the running platform's part is
 * read).
 * @returns What is on offer.
 * @example
 * ```ts
 * import { checkForUpdates } from "denext/updates";
 *
 * const found = await checkForUpdates({ ota: { baseUrl: "https://api.example.com/mobile-ui" } });
 * for (const u of found.updates) console.log(`${u.target} ${u.version}`, u.notes ?? "");
 * ```
 */
export async function checkForUpdates(config: UpdatesConfig = {}): Promise<UpdatesCheck> {
  const platform = runtimePlatform();
  try {
    if (platform === "ios" || platform === "android") {
      const { checkMobile } = await import("./mobile.ts");
      return await checkMobile(platform, config);
    }
    if (platform === "desktop") {
      const { checkDesktop } = await import("./desktop.ts");
      return await checkDesktop(config.desktop);
    }
    const { checkWeb } = await import("./web.ts");
    return await checkWeb(config.web);
  } catch (err) {
    return {
      platform,
      available: false,
      updates: [],
      needsStoreUpdate: false,
      failures: [{
        target: platform === "web" ? "web" : "ui",
        code: "failed",
        message: messageOf(err),
      }],
    };
  }
}

/**
 * Install every update on offer, reporting each step to `onProgress`: on a phone the new UI, on
 * Deno Desktop the whole app (or, when no newer app is on offer, the UI overlay), in a browser
 * the newer deploy. It never
 * throws; a target that failed is listed in `failures` (and reported as `stage: "failed"`).
 *
 * When installing replaces the running page (a phone's UI switch, a browser reload, a desktop
 * app's install-and-relaunch), the promise does not settle. A desktop UI overlay alone is
 * served from the next launch: the result says `restartRequired`. A second call while one runs
 * finds the first's download in progress and reports it (`busy` on desktop).
 *
 * @param config Where each platform's updates come from.
 * @param onProgress Called with each step.
 * @returns What happened, when the page keeps running.
 * @example
 * ```ts
 * import { applyUpdates } from "denext/updates";
 *
 * const result = await applyUpdates({}, (p) => {
 *   status.textContent = `${p.target}: ${p.stage}${p.percent === undefined ? "" : ` ${p.percent}%`}`;
 * });
 * if (result.restartRequired) showRestartPrompt();
 * ```
 */
export function applyUpdates(
  config: UpdatesConfig = {},
  onProgress: UpdateProgressListener = () => {},
): Promise<UpdatesResult> {
  return runApply(config, guarded(onProgress));
}

/** The listener, with its throws contained (a broken progress bar must not stop an update). */
function guarded(listener: UpdateProgressListener): UpdateProgressListener {
  return (progress) => {
    try {
      listener(progress);
    } catch {
      // the app's listener threw: the update goes on
    }
  };
}

/** {@linkcode applyUpdates} without the single-flight wrapper. */
async function runApply(
  config: UpdatesConfig,
  onProgress: UpdateProgressListener,
): Promise<UpdatesResult> {
  const platform = runtimePlatform();
  try {
    if (platform === "ios" || platform === "android") {
      const { applyMobile } = await import("./mobile.ts");
      return await applyMobile(platform, config, onProgress);
    }
    if (platform === "desktop") {
      const { applyDesktop } = await import("./desktop.ts");
      return await applyDesktop(config.desktop, onProgress);
    }
    const { applyWeb } = await import("./web.ts");
    return await applyWeb(config.web, onProgress);
  } catch (err) {
    const target = platform === "web" ? "web" : "ui";
    const message = messageOf(err);
    onProgress({ target, stage: "failed", error: message, code: "failed" });
    return {
      platform,
      applied: [],
      restartRequired: false,
      needsStoreUpdate: false,
      failures: [{ target, code: "failed", message }],
    };
  }
}

/** A thrown value's message. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
