/**
 * Location that keeps arriving while the app is in the background, for `denext/mobile`: the
 * `BackgroundGeolocation` plugin (`@capgo/background-geolocation`, installed by `denext mobile
 * add background-location`) in the shell. iOS keeps the updates flowing with the `location`
 * background mode and Always authorization; Android runs a foreground service with a visible
 * notification. Elsewhere (the web, or a shell without the plugin) it falls back to the
 * foreground {@linkcode watchPosition}, which stops when the page is hidden.
 *
 * Only one background watch runs at a time (the plugin has one): starting another stops the
 * previous one first.
 *
 * @module
 */

import {
  type GeolocationError,
  type GeolocationErrorCode,
  type GeoPosition,
  watchPosition,
} from "./geolocation.ts";
import { nativePlugin } from "./plugin.ts";

/** Options for {@linkcode watchPositionInBackground}. */
export interface BackgroundLocationOptions {
  /**
   * Android: the foreground-service notification shown while tracking (Android requires one).
   * Defaults: title `"Using your location"`, message `"Tracking your location in the
   * background."`. Say what the app does with it; Play reviews this text.
   */
  readonly notification?: { readonly title?: string; readonly message?: string };
  /** The distance, in metres, the device must move before the next fix (default 0: every fix). */
  readonly distanceFilterM?: number;
  /** Accept a cached fix while the first GPS fix is pending (check `timestamp`; default false). */
  readonly allowStale?: boolean;
  /**
   * Ask for the location permissions when they are not granted yet (default true). With false,
   * a missing permission fails with `denied`; ask first with `requestPermission("location")`.
   */
  readonly requestPermissions?: boolean;
  /**
   * Also POST every fix as JSON to this URL from native code, which keeps working while the
   * WebView is suspended (Android even after the app is swiped away). Best effort: no queue and
   * no retry.
   */
  readonly url?: string;
  /** Headers for the {@linkcode BackgroundLocationOptions.url | url} POSTs (an auth token). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** The plugin's `Location`. */
interface RawLocation {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  altitude?: number | null;
  altitudeAccuracy?: number | null;
  bearing?: number | null;
  speed?: number | null;
  time?: number | null;
}

/** The JS side of `@capgo/background-geolocation` (the calls used here). */
interface BackgroundGeolocationPlugin {
  start(
    options: Record<string, unknown>,
    callback: (location?: RawLocation | null, error?: { message?: string; code?: string }) => void,
  ): unknown;
  stop(): Promise<void>;
}

/** The native plugin, when the shell has it. */
function backgroundPlugin(): BackgroundGeolocationPlugin | undefined {
  return nativePlugin<BackgroundGeolocationPlugin>("BackgroundGeolocation", ["start", "stop"]);
}

/**
 * Whether background location is available here: the shell has the `BackgroundGeolocation`
 * plugin (`denext mobile add background-location`). When false,
 * {@linkcode watchPositionInBackground} watches in the foreground only.
 *
 * @returns Whether fixes keep arriving in the background.
 * @example
 * ```ts
 * import { isBackgroundLocationAvailable } from "denext/mobile";
 *
 * if (!isBackgroundLocationAvailable()) showNotice("Keep the app open while recording.");
 * ```
 */
export function isBackgroundLocationAvailable(): boolean {
  return backgroundPlugin() !== undefined;
}

/** A plugin failure as a {@linkcode GeolocationError}. */
function backgroundError(error: { message?: string; code?: string } | unknown): GeolocationError {
  const raw = (typeof error === "object" && error !== null ? error : {}) as {
    message?: unknown;
    code?: unknown;
  };
  const code: GeolocationErrorCode = raw.code === "NOT_AUTHORIZED" ? "denied" : "unavailable";
  const err = new Error(
    `watchPositionInBackground: ${String(raw.message ?? error ?? "location failed")}`,
  ) as Error & { code: GeolocationErrorCode };
  err.name = "GeolocationError";
  err.code = code;
  return err;
}

/** A plugin fix as a {@linkcode GeoPosition}. */
function toPosition(raw: RawLocation): GeoPosition {
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    latitude: Number(raw.latitude),
    longitude: Number(raw.longitude),
    accuracy: num(raw.accuracy) ?? 0,
    altitude: num(raw.altitude),
    altitudeAccuracy: num(raw.altitudeAccuracy),
    heading: num(raw.bearing),
    speed: num(raw.speed),
    timestamp: num(raw.time) ?? Date.now(),
  };
}

/** The options in the plugin's vocabulary. */
function startOptions(options: BackgroundLocationOptions): Record<string, unknown> {
  return {
    backgroundTitle: options.notification?.title ?? "Using your location",
    backgroundMessage: options.notification?.message ??
      "Tracking your location in the background.",
    requestPermissions: options.requestPermissions !== false,
    stale: options.allowStale === true,
    distanceFilter: options.distanceFilterM ?? 0,
    ...(options.url === undefined ? {} : { url: options.url, headers: options.headers ?? {} }),
  };
}

/** The watch whose fixes are delivered (the plugin runs one at a time). */
let active: symbol | undefined;
/** The last plugin start / stop, which the next one waits for. */
let pending: Promise<void> | undefined;

/** Run `step` after every earlier start / stop has settled. */
function enqueue(step: () => unknown): Promise<void> {
  const run = (pending ?? Promise.resolve()).then(step).then(() => {}, () => {});
  pending = run;
  return run;
}

/**
 * Follow the position in the foreground and the background: `callback` runs with each fix
 * until the returned function (or {@linkcode stopBackgroundLocation}) is called. A failure
 * (permission refused: `denied`; anything else: `unavailable`) goes to `onError`.
 *
 * In the shell with `@capgo/background-geolocation` the first call asks for location access
 * (iOS: While Using, then Always when the app goes to the background; Android 13+: also the
 * notification permission for the tracking notification). Without the plugin it is the
 * foreground {@linkcode watchPosition} (see {@linkcode isBackgroundLocationAvailable}).
 *
 * @param callback Called with each fix.
 * @param options The Android notification, distance filter, permission prompt and native URL.
 * @param onError Called with each failure.
 * @returns A function that stops this watch.
 * @example
 * ```ts
 * import { watchPositionInBackground } from "denext/mobile";
 *
 * const stop = watchPositionInBackground((p) => route.push([p.longitude, p.latitude]), {
 *   notification: { title: "Recording your run", message: "Tap to return to the app." },
 *   distanceFilterM: 10,
 * });
 * ```
 */
export function watchPositionInBackground(
  callback: (position: GeoPosition) => void,
  options: BackgroundLocationOptions = {},
  onError?: (error: GeolocationError) => void,
): () => void {
  const plugin = backgroundPlugin();
  if (!plugin) return watchPosition(callback, {}, onError);
  const token = Symbol("background-location");
  const replacing = active !== undefined;
  active = token;
  let stopped = false;
  const live = () => !stopped && active === token;
  const fail = (err: unknown) => void (live() && onError?.(backgroundError(err)));
  enqueue(async () => {
    // The plugin rejects a second start: a watch still running stops first.
    if (replacing) await plugin.stop().catch(() => {});
    if (!live()) return;
    try {
      Promise.resolve(
        plugin.start(startOptions(options), (location, error) => {
          if (!live()) return;
          if (error) fail(error);
          else if (location) callback(toPosition(location));
        }),
      ).catch(fail);
    } catch (err) {
      fail(err);
    }
  });
  return () => {
    if (stopped) return;
    stopped = true;
    if (active !== token) return;
    active = undefined;
    enqueue(() => plugin.stop().catch(() => {}));
  };
}

/**
 * Stop background location, whichever watch started it. Resolves once the plugin has stopped
 * (at once without the plugin: stop a foreground fallback with the function
 * {@linkcode watchPositionInBackground} returned).
 *
 * @returns A promise that settles when tracking has stopped.
 * @example
 * ```ts
 * import { stopBackgroundLocation } from "denext/mobile";
 *
 * await stopBackgroundLocation(); // on sign-out
 * ```
 */
export async function stopBackgroundLocation(): Promise<void> {
  const plugin = backgroundPlugin();
  if (!plugin) return;
  active = undefined;
  await enqueue(() => plugin.stop().catch(() => {}));
}
