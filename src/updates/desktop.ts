/**
 * `denext/updates` in a Deno Desktop window: the `updates` capability (`denext desktop add
 * updates`) checks, downloads and installs the whole app (`desktop.update.manifestUrl`) when a
 * newer one is on offer, else the app's signed UI overlay (`desktop.update.ui`), with the
 * download's progress pushed down the bridge's event stream. The checks themselves (signatures, no downgrade, expiry, replay, the same
 * code signer) run in the app's Deno side. Loaded by {@link ./mod.ts} only in a desktop window.
 *
 * @module
 */

import { desktopRpc, subscribeDesktopEvent } from "../desktop/bridge-client.ts";
import type {
  AvailableUpdate,
  DesktopUpdatesConfig,
  UpdateFailure,
  UpdateProgress,
  UpdateProgressListener,
  UpdatesCheck,
  UpdatesResult,
} from "./types.ts";

/** The capability's name on the bridge. */
const CAP = "updates";

/** The two desktop targets, in the order they are installed. */
type DesktopTarget = "ui" | "app";

/** One target's `check` answer (see `src/desktop/caps/updates.ts`). */
interface TargetCheck {
  readonly state?: unknown;
  readonly version?: unknown;
  readonly required?: unknown;
  readonly notes?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

/** What one target's check means for the page. */
type Found =
  | { readonly kind: "skip" }
  | { readonly kind: "current" }
  | { readonly kind: "update"; readonly update: AvailableUpdate }
  | { readonly kind: "superseded" }
  | { readonly kind: "failed"; readonly failure: UpdateFailure };

/** A string field, or `fallback`. */
function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/** A bridge rejection's message without its `desktop updates.<method>: <code>: ` prefix. */
const BRIDGE_PREFIX = /^desktop updates\.\w+: [\w-]+: /;

/** A rejection's code and message. */
function failureOf(target: DesktopTarget, err: unknown): UpdateFailure {
  const e = err as { code?: unknown; message?: unknown } | null;
  const message = str(e?.message, "the update failed").replace(BRIDGE_PREFIX, "");
  return { target, code: str(e?.code, "failed"), message };
}

/** Read one target's check answer. A target the config does not set up is skipped quietly. */
function found(target: DesktopTarget, raw: TargetCheck | undefined): Found {
  switch (raw?.state) {
    case "available":
      return {
        kind: "update",
        update: {
          target,
          version: str(raw.version, ""),
          required: raw.required === true,
          notes: typeof raw.notes === "string" ? raw.notes : null,
        },
      };
    case "up-to-date":
      return { kind: "current" };
    case "failed":
      return {
        kind: "failed",
        failure: {
          target,
          code: str(raw.code, "failed"),
          message: str(raw.message, "the check failed"),
        },
      };
    default:
      // `unconfigured` / `unsupported`: this app does not update that target.
      return { kind: "skip" };
  }
}

/** The targets the config asks for. */
function targets(config: DesktopUpdatesConfig | undefined): DesktopTarget[] {
  return (["ui", "app"] as const).filter((t) => config?.[t] !== false);
}

/** Ask the capability what each target offers; no answers and a failure per target when it cannot. */
async function checkAll(
  config: DesktopUpdatesConfig | undefined,
): Promise<{ found: Map<DesktopTarget, Found>; failures: UpdateFailure[] }> {
  const wanted = targets(config);
  let answer: { ui?: TargetCheck; app?: TargetCheck };
  try {
    answer = await desktopRpc<{ ui?: TargetCheck; app?: TargetCheck }>(CAP, "check", {}, {
      timeoutMs: 120_000,
    });
  } catch (err) {
    const failures = wanted.map((t) => {
      const f = failureOf(t, err);
      return f.code === "unavailable"
        ? { ...f, message: "the updates capability is off (denext desktop add updates)" }
        : f;
    });
    return { found: new Map(), failures };
  }
  const map = new Map<DesktopTarget, Found>();
  for (const t of wanted) map.set(t, found(t, answer?.[t]));
  return { found: supersede(map), failures: [] };
}

/**
 * Leave the UI overlay out when a full-app update is on offer: the new app brings its own UI, and
 * an overlay built for the running app must not be installed over it (the overlay updater drops
 * overlays of another bundle at launch anyway). The overlay becomes `superseded`.
 */
function supersede(map: Map<DesktopTarget, Found>): Map<DesktopTarget, Found> {
  if (map.get("app")?.kind === "update" && map.get("ui")?.kind === "update") {
    map.set("ui", { kind: "superseded" });
  }
  return map;
}

/**
 * Check what the app's Deno side offers.
 *
 * @param config Which targets.
 * @returns What is on offer.
 */
export async function checkDesktop(
  config: DesktopUpdatesConfig | undefined,
): Promise<UpdatesCheck> {
  const { found: map, failures } = await checkAll(config);
  const updates: AvailableUpdate[] = [];
  for (const f of map.values()) {
    if (f.kind === "update") updates.push(f.update);
    if (f.kind === "failed") failures.push(f.failure);
  }
  return {
    platform: "desktop",
    available: updates.length > 0,
    updates,
    needsStoreUpdate: false,
    failures,
  };
}

/** A random id for this run, so a replayed `progress` event from an earlier run is ignored. */
function newRunId(): string {
  return crypto.randomUUID();
}

/** Forward this run's `progress` events from the capability to `onProgress`. */
function forwardProgress(runId: string, onProgress: UpdateProgressListener): () => void {
  return subscribeDesktopEvent(CAP, "progress", (data) => {
    const d = data as Partial<UpdateProgress> & { runId?: unknown } | null;
    if (d?.runId !== runId || (d.target !== "ui" && d.target !== "app")) return;
    onProgress({
      target: d.target,
      stage: "downloading",
      ...(typeof d.version === "string" ? { version: d.version } : {}),
      ...(typeof d.percent === "number" ? { percent: d.percent } : {}),
    });
  });
}

/** What installing one target did. */
type Installed =
  | { readonly kind: "current" }
  | { readonly kind: "applied"; readonly update: AvailableUpdate; readonly restart: boolean }
  | { readonly kind: "relaunching" }
  | { readonly kind: "failed"; readonly failure: UpdateFailure };

/** Download, then apply, one target's update. */
async function install(
  target: DesktopTarget,
  update: AvailableUpdate,
  runId: string,
  onProgress: UpdateProgressListener,
): Promise<Installed> {
  let staged: { state?: unknown; version?: unknown };
  try {
    staged = await desktopRpc(CAP, "download", { target, runId }, { timeoutMs: false });
  } catch (err) {
    return { kind: "failed", failure: failureOf(target, err) };
  }
  if (staged?.state !== "ready") return { kind: "current" };
  const version = str(staged.version, update.version);
  onProgress({ target, stage: "ready", version });
  onProgress({ target, stage: "applying", version });
  let applied: { quitting?: unknown; restartRequired?: unknown };
  try {
    applied = await desktopRpc(CAP, "apply", { target, version });
  } catch (err) {
    return { kind: "failed", failure: failureOf(target, err) };
  }
  if (target === "app") {
    return applied?.quitting === true ? { kind: "relaunching" } : {
      kind: "failed",
      failure: { target, code: "quit_refused", message: "the app did not quit to install" },
    };
  }
  return {
    kind: "applied",
    update: { ...update, version },
    restart: applied?.restartRequired === true,
  };
}

/**
 * Install what the app's Deno side offers: the whole app when a newer one is on offer (its UI comes
 * with it, so the overlay is skipped as `superseded`), else the UI overlay. A full-app install
 * quits and relaunches the app, so the promise does not settle then.
 *
 * @param config Which targets.
 * @param onProgress Progress reports.
 * @returns What happened, when the app keeps running.
 */
export async function applyDesktop(
  config: DesktopUpdatesConfig | undefined,
  onProgress: UpdateProgressListener,
): Promise<UpdatesResult> {
  for (const target of targets(config)) onProgress({ target, stage: "checking" });
  const { found: map, failures } = await checkAll(config);
  for (const f of failures) {
    onProgress({ target: f.target, stage: "failed", error: f.message, code: f.code });
  }
  const runId = newRunId();
  const stop = forwardProgress(runId, onProgress);
  const applied: AvailableUpdate[] = [];
  let restartRequired = false;
  try {
    for (const [target, f] of map) {
      const outcome: Installed | Found = f.kind === "update"
        ? await install(target, f.update, runId, onProgress)
        : f;
      switch (outcome.kind) {
        case "applied":
          applied.push(outcome.update);
          restartRequired ||= outcome.restart;
          onProgress({ target, stage: "done", version: outcome.update.version });
          break;
        case "relaunching":
          // The app is quitting to swap itself: nothing after this runs.
          return await new Promise<never>(() => {});
        case "failed":
          failures.push(outcome.failure);
          onProgress({
            target,
            stage: "failed",
            error: outcome.failure.message,
            code: outcome.failure.code,
          });
          break;
        case "superseded":
          // The full-app update below brings its own UI.
          onProgress({ target, stage: "up-to-date", code: "superseded" });
          break;
        case "current":
        case "skip":
          // Nothing newer, or a target this app does not update (no config for it).
          onProgress({ target, stage: "up-to-date" });
          break;
      }
    }
  } finally {
    stop();
  }
  return { platform: "desktop", applied, restartRequired, needsStoreUpdate: false, failures };
}
