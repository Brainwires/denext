// Automatic confirmation of a full-app update (`desktop.update.autoConfirm`, default on).
//
// After the runtime swaps in a new version, that version's first launch is its TRIAL: unless it
// calls `confirmAppUpdate()`, the next launch rolls it back and refuses it from then on. An app
// that never calls it would therefore roll back every update. So `runDesktop` confirms on the
// app's behalf at the same "the UI rendered" signal the UI-overlay updater uses: the injected boot
// beacon, which the page POSTs (token-gated) once its `load` event fired. A trial that crashes
// before the window loads never beacons, so it still rolls back.
//
// Internal (not an entrypoint): `runDesktop` composes it; tests drive it with fake runtime hooks.

import { appUpdateStatus, confirmAppUpdate } from "./app-updater.ts";

/** The runtime hooks auto-confirmation needs (injectable for tests). */
export interface AppUpdateConfirmDeps {
  /** The runtime's update status, or `null` outside denext's pinned runtime. */
  readonly status: () => { readonly trial: boolean } | null;
  /** Confirm the pending update; `true` when one was confirmed. */
  readonly confirm: () => boolean;
  /** Where a failure or a confirmation is reported. */
  readonly log: (message: string) => void;
}

const RUNTIME_DEPS: AppUpdateConfirmDeps = {
  status: appUpdateStatus,
  confirm: confirmAppUpdate,
  log: (message) => console.error(`desktop: ${message}`),
};

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The boot hook that confirms this launch's full-app update, or `undefined` when there is nothing
 * to confirm: auto-confirm is off (`enabled === false`), the runtime has no updater, or this is not
 * a trial launch. Decided once at startup, so a launch that is not a trial injects no beacon for
 * it. The hook confirms at most once; a failed confirm is logged and retried on the next beacon
 * (a reload), and the update otherwise stays on trial (fail-safe: it rolls back).
 *
 * @param enabled `desktop.update.autoConfirm` (`undefined` means the default, on).
 * @param deps The runtime hooks (tests pass fakes).
 * @returns The hook to run when the window has loaded, or `undefined`.
 */
export function appUpdateAutoConfirm(
  enabled: boolean | undefined,
  deps: AppUpdateConfirmDeps = RUNTIME_DEPS,
): (() => void) | undefined {
  if (enabled === false) return undefined;
  let trial: boolean;
  try {
    trial = deps.status()?.trial === true;
  } catch (err) {
    deps.log(`cannot read the app update status: ${describe(err)}`);
    return undefined;
  }
  if (!trial) return undefined;
  let confirmed = false;
  return () => {
    if (confirmed) return;
    try {
      confirmed = deps.confirm();
      if (confirmed) deps.log("the window loaded; confirmed the updated app version");
    } catch (err) {
      deps.log(`confirming the app update failed (it stays on trial): ${describe(err)}`);
    }
  };
}

/**
 * Compose the boot hooks (the UI overlay's watchdog confirm and the full-app update's confirm)
 * into the one handler the boot beacon triggers, or `undefined` when neither applies (then no
 * beacon is injected at all). The app confirm runs first and never stops the overlay's.
 *
 * @param hooks The hooks; `undefined` entries are skipped.
 * @returns The combined handler, or `undefined`.
 */
export function combineBootHooks(
  ...hooks: ReadonlyArray<(() => void | Promise<void>) | undefined>
): (() => Promise<void>) | undefined {
  const active = hooks.filter((h): h is () => void | Promise<void> => h !== undefined);
  if (active.length === 0) return undefined;
  return async () => {
    for (const hook of active) await hook();
  };
}
