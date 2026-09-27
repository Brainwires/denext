/**
 * Crash reporting for `denext/mobile`: {@linkcode initCrashReporting} starts Sentry's Capacitor SDK
 * (`@sentry/capacitor`, installed with its sibling web SDK by `denext mobile add sentry`), which
 * reports native crashes through sentry-cocoa / sentry-android and JavaScript errors through the
 * web SDK, and on the web falls back to the web SDK alone.
 *
 * The SDKs are the app's own packages, passed in as loaders (`() => import("@sentry/capacitor")`),
 * so nothing is fetched or bundled until the app calls this, and an app that never imports this
 * function ships none of it.
 *
 * The release defaults to the UI version the page was served with: the `version` of the
 * `_denext/ota.json` next to it (`spa.ota`, or `denext ota manifest`), which is a hash of the
 * exported files. `denext export --sourcemaps hidden` writes the matching source maps to
 * `.denext/sourcemaps`, and CI uploads them under the same release, so stack traces of every UI
 * (the bundled one and each over-the-air update) resolve to the source. No `dist` is set by
 * default: one UI version runs on several app binaries, and Sentry matches uploaded files only
 * when the event's dist equals the upload's.
 *
 * @module
 */

// The version of the `_denext/ota.json` next to this page (what otaBooted() confirms with).
import { pageUiVersion as pageRelease } from "./ota.ts";

/** The slice of `@sentry/capacitor` this uses: `init(options, siblingInit)`. */
export interface SentryCapacitorSdk {
  /** `Sentry.init(options, siblingInit)`: starts the native SDKs and the sibling web SDK. */
  init(
    options: Record<string, unknown>,
    siblingInit?: (options: Record<string, unknown>) => void,
  ): void;
}

/** The slice of the sibling SDK (`@sentry/browser`, `@sentry/react`, …): its `init`. */
export interface SentrySiblingSdk {
  /** The web SDK's `init`, which `@sentry/capacitor` calls with the merged options. */
  init(options: Record<string, unknown>): void;
}

/** Options for {@linkcode initCrashReporting}. */
export interface CrashReportingOptions {
  /** The project's DSN (a public value; it only allows sending events). */
  readonly dsn: string;
  /** Loads `@sentry/capacitor`: `() => import("@sentry/capacitor")`. */
  readonly sdk: () => Promise<SentryCapacitorSdk>;
  /** Loads the sibling web SDK: `() => import("@sentry/browser")` (or `@sentry/react`). */
  readonly sibling: () => Promise<SentrySiblingSdk>;
  /**
   * The release. Default: the OTA UI version of this page's `_denext/ota.json`, or none when the
   * export is not stamped (then uploaded source maps cannot be matched).
   */
  readonly release?: string;
  /** The environment (`production`, `staging`, …). */
  readonly environment?: string;
  /** A `dist`, only when your source-map upload passes the same `--dist`. */
  readonly dist?: string;
  /** Any other `Sentry.init` option (sampling rates, integrations, `beforeSend`, …). */
  readonly options?: Readonly<Record<string, unknown>>;
}

/** What {@linkcode initCrashReporting} started with. */
export interface CrashReportingStarted {
  /** The release sent with every event, if any. */
  readonly release: string | undefined;
}

let started: Promise<CrashReportingStarted> | undefined;

/** Start the SDKs; see {@linkcode initCrashReporting}. */
async function start(opts: CrashReportingOptions): Promise<CrashReportingStarted> {
  const [sdk, sibling, release] = await Promise.all([
    opts.sdk(),
    opts.sibling(),
    opts.release === undefined ? pageRelease() : Promise.resolve(opts.release),
  ]);
  const options: Record<string, unknown> = { ...opts.options, dsn: opts.dsn };
  if (release !== undefined) options.release = release;
  if (opts.environment !== undefined) options.environment = opts.environment;
  if (opts.dist !== undefined) options.dist = opts.dist;
  sdk.init(options, sibling.init);
  return { release };
}

/**
 * Start crash reporting once: load the SDKs, work out the release (the OTA UI version), and call
 * `Sentry.init(options, sibling.init)`. Later calls return the first call's result. Call it as
 * early as possible, before the app renders.
 *
 * @param opts The DSN, the SDK loaders, and optional release / environment / dist / options.
 * @returns What it started with.
 * @throws When an SDK fails to load (the next call tries again).
 * @example
 * ```ts
 * import { initCrashReporting } from "denext/mobile";
 *
 * await initCrashReporting({
 *   dsn: "https://public@o0.ingest.sentry.io/0",
 *   sdk: () => import("@sentry/capacitor"),
 *   sibling: () => import("@sentry/browser"),
 *   environment: "production",
 *   options: { tracesSampleRate: 0.1 },
 * });
 * ```
 */
export function initCrashReporting(opts: CrashReportingOptions): Promise<CrashReportingStarted> {
  if (started) return started;
  const attempt = start(opts);
  started = attempt;
  attempt.catch(() => {
    if (started === attempt) started = undefined;
  });
  return attempt;
}

/** Forget a started SDK (tests only). */
export function resetCrashReportingForTesting(): void {
  started = undefined;
}
