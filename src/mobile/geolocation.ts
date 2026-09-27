/**
 * The device's location for `denext/mobile`: the native `Geolocation` plugin
 * (`@capacitor/geolocation`, installed by `denext mobile add geolocation`) in the shell, else
 * the browser's `navigator.geolocation`. Foreground only: background location is not shipped
 * (see the mobile docs).
 *
 * @module
 */

import { useEffect, useRef, useState } from "../runtime/hooks.ts";
import { nativePlugin } from "./plugin.ts";

/** A position fix. */
export interface GeoPosition {
  /** Latitude, in degrees. */
  readonly latitude: number;
  /** Longitude, in degrees. */
  readonly longitude: number;
  /** The horizontal accuracy radius, in metres. */
  readonly accuracy: number;
  /** Altitude above sea level in metres, when known. */
  readonly altitude: number | null;
  /** The altitude's accuracy in metres, when known. */
  readonly altitudeAccuracy: number | null;
  /** The direction of travel in degrees from true north, when moving. */
  readonly heading: number | null;
  /** The speed in metres per second, when moving. */
  readonly speed: number | null;
  /** When the fix was taken, in milliseconds since the epoch. */
  readonly timestamp: number;
}

/** How precise, fresh and quick a fix should be. */
export interface GeoPositionOptions {
  /**
   * `"high"` (GPS, the default) or `"balanced"` (network / coarse, faster and cheaper on the
   * battery). On iOS, a user who granted approximate location only gets a coarse fix anyway.
   */
  readonly accuracy?: "high" | "balanced";
  /** How long to wait for a fix, in milliseconds (default 10000). */
  readonly timeoutMs?: number;
  /** Accept a cached fix at most this old, in milliseconds (default 0: a fresh one). */
  readonly maximumAgeMs?: number;
  /** `watchPosition`, Android: the minimum time between updates, in milliseconds. */
  readonly minimumIntervalMs?: number;
}

/** Why a location read failed, as {@linkcode GeolocationError}'s `code` reports it. */
export type GeolocationErrorCode =
  /** The user refused location access (see `requestPermission("location")`). */
  | "denied"
  /** Location services are off, or no fix could be obtained. */
  | "unavailable"
  /** No fix within `timeoutMs`. */
  | "timeout"
  /** Neither the native plugin nor `navigator.geolocation` is here (SSR). */
  | "unsupported";

/** A failed location read. */
export interface GeolocationError extends Error {
  /** Why it failed. */
  readonly code: GeolocationErrorCode;
}

/** The plugin's `Position`. */
interface RawPosition {
  timestamp?: number;
  coords?: {
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    altitude?: number | null;
    altitudeAccuracy?: number | null;
    heading?: number | null;
    speed?: number | null;
  };
}

/** The JS side of `@capacitor/geolocation` (its native methods). */
interface GeolocationPlugin {
  getCurrentPosition(options: Record<string, unknown>): Promise<RawPosition>;
  watchPosition(
    options: Record<string, unknown>,
    callback: (position: RawPosition | null, err?: unknown) => void,
  ): string | Promise<string>;
  clearWatch(options: { id: string }): Promise<void>;
}

/** The plugin's error codes → {@linkcode GeolocationErrorCode}. */
const NATIVE_CODES: Readonly<Record<string, GeolocationErrorCode>> = {
  "OS-PLUG-GLOC-0003": "denied",
  "OS-PLUG-GLOC-0008": "denied",
  "OS-PLUG-GLOC-0009": "unavailable",
  "OS-PLUG-GLOC-0007": "unavailable",
  "OS-PLUG-GLOC-0017": "unavailable",
  "OS-PLUG-GLOC-0010": "timeout",
};

/** The native plugin, when the shell has it. Internal to `denext/mobile` and the Expo shim. */
export function geolocationPlugin(): GeolocationPlugin | undefined {
  return nativePlugin<GeolocationPlugin>("Geolocation", [
    "getCurrentPosition",
    "watchPosition",
    "clearWatch",
  ]);
}

/** Build a {@linkcode GeolocationError}. */
function geoError(code: GeolocationErrorCode, message: string): GeolocationError {
  const err = new Error(message) as Error & { code: GeolocationErrorCode };
  err.name = "GeolocationError";
  err.code = code;
  return err;
}

/** A native or browser failure as a {@linkcode GeolocationError}. */
function toError(fn: string, err: unknown): GeolocationError {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    const message = String((err as { message?: unknown }).message ?? "location failed");
    // The browser's GeolocationPositionError: 1 denied, 2 unavailable, 3 timeout.
    if (code === 1) return geoError("denied", `${fn}: ${message}`);
    if (code === 3) return geoError("timeout", `${fn}: ${message}`);
    if (typeof code === "string" && Object.hasOwn(NATIVE_CODES, code)) {
      return geoError(NATIVE_CODES[code], `${fn}: ${message}`);
    }
    return geoError("unavailable", `${fn}: ${message}`);
  }
  return geoError("unavailable", `${fn}: ${err instanceof Error ? err.message : String(err)}`);
}

/** A number, or null. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A plugin or browser position as a {@linkcode GeoPosition}. */
function toPosition(raw: RawPosition): GeoPosition {
  const c = raw.coords ?? {};
  return {
    latitude: Number(c.latitude),
    longitude: Number(c.longitude),
    accuracy: num(c.accuracy) ?? 0,
    altitude: num(c.altitude),
    altitudeAccuracy: num(c.altitudeAccuracy),
    heading: num(c.heading),
    speed: num(c.speed),
    timestamp: num(raw.timestamp) ?? Date.now(),
  };
}

/** The options in the plugin's / the browser's vocabulary. */
function positionOptions(options: GeoPositionOptions): Record<string, unknown> {
  return {
    enableHighAccuracy: options.accuracy !== "balanced",
    timeout: options.timeoutMs ?? 10_000,
    maximumAge: options.maximumAgeMs ?? 0,
    ...(options.minimumIntervalMs === undefined
      ? {}
      : { minimumUpdateInterval: options.minimumIntervalMs }),
  };
}

/** `navigator.geolocation`, when the browser has it. */
function webGeolocation(): Geolocation | undefined {
  const geo = (globalThis as { navigator?: { geolocation?: Geolocation } }).navigator?.geolocation;
  return typeof geo?.getCurrentPosition === "function" ? geo : undefined;
}

/** The error for a page without either source. */
function noSource(fn: string): GeolocationError {
  return geoError("unsupported", `${fn}: no location source here (called during SSR?)`);
}

/**
 * One position fix.
 *
 * In the shell with `@capacitor/geolocation` (`denext mobile add geolocation`) it asks the
 * plugin, which prompts for permission the first time; elsewhere `navigator.geolocation` (the
 * browser prompts). It rejects with a {@linkcode GeolocationError}: `denied`, `unavailable`
 * (location services off), `timeout`, or `unsupported` (no source, SSR).
 *
 * @param options Accuracy, timeout and the oldest acceptable cached fix.
 * @returns The position.
 * @example
 * ```ts
 * import { getCurrentPosition } from "denext/mobile";
 *
 * const { latitude, longitude, accuracy } = await getCurrentPosition({ accuracy: "balanced" });
 * ```
 */
export async function getCurrentPosition(options: GeoPositionOptions = {}): Promise<GeoPosition> {
  const fn = "getCurrentPosition";
  const plugin = geolocationPlugin();
  if (plugin) {
    try {
      return toPosition(await plugin.getCurrentPosition(positionOptions(options)));
    } catch (err) {
      throw toError(fn, err);
    }
  }
  const geo = webGeolocation();
  if (!geo) throw noSource(fn);
  return await new Promise<GeoPosition>((resolve, reject) =>
    geo.getCurrentPosition(
      (p) => resolve(toPosition(p as unknown as RawPosition)),
      (err) => reject(toError(fn, err)),
      positionOptions(options) as PositionOptions,
    )
  );
}

/**
 * Follow the position: `callback` runs with each new fix until the returned function is
 * called. A failure (permission refused, services turned off) goes to `onError`; the watch
 * keeps running where the platform keeps it (the browser does), so stop it yourself on
 * `denied`.
 *
 * @param callback Called with each fix.
 * @param options Accuracy, timeout and (Android) the minimum interval between updates.
 * @param onError Called with each failure.
 * @returns A function that stops the watch.
 * @example
 * ```ts
 * import { watchPosition } from "denext/mobile";
 *
 * const stop = watchPosition((p) => marker.move(p.latitude, p.longitude), { accuracy: "high" });
 * ```
 */
export function watchPosition(
  callback: (position: GeoPosition) => void,
  options: GeoPositionOptions = {},
  onError?: (error: GeolocationError) => void,
): () => void {
  const fn = "watchPosition";
  const fail = (err: unknown) => onError?.(toError(fn, err));
  const plugin = geolocationPlugin();
  if (plugin) {
    let stopped = false;
    let id: string | undefined;
    const clear = (watch: string) => void plugin.clearWatch({ id: watch }).catch(() => {});
    Promise.resolve(
      plugin.watchPosition(positionOptions(options), (position, err) => {
        if (stopped) return;
        if (err !== undefined && err !== null) fail(err);
        else if (position) callback(toPosition(position));
      }),
    ).then((watch) => stopped ? clear(watch) : void (id = watch), fail);
    return () => {
      if (stopped) return;
      stopped = true;
      if (id !== undefined) clear(id);
    };
  }
  const geo = webGeolocation();
  if (!geo) {
    queueMicrotask(() => onError?.(noSource(fn)));
    return () => {};
  }
  const watch = geo.watchPosition(
    (p) => callback(toPosition(p as unknown as RawPosition)),
    fail,
    positionOptions(options) as PositionOptions,
  );
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    geo.clearWatch(watch);
  };
}

/** Options for {@linkcode useLocation}. */
export interface UseLocationOptions extends GeoPositionOptions {
  /** Watch only while `true` (default `true`). */
  readonly enabled?: boolean;
}

/** What {@linkcode useLocation} returns. */
export interface LocationState {
  /** The latest fix, once there is one. */
  readonly position: GeoPosition | undefined;
  /** The latest failure, cleared by the next fix. */
  readonly error: GeolocationError | undefined;
}

/**
 * Hook form of {@linkcode watchPosition}: the latest fix and error, watched while mounted and
 * `enabled`. Changing `accuracy` or `minimumIntervalMs` restarts the watch.
 *
 * @param options The watch's options, and `enabled`.
 * @returns The latest position and error.
 * @example
 * ```tsx
 * "use client";
 * import { useLocation } from "denext/mobile";
 *
 * export function Here() {
 *   const { position, error } = useLocation({ accuracy: "balanced" });
 *   if (error) return <p>Location unavailable ({error.code})</p>;
 *   return <p>{position ? `${position.latitude}, ${position.longitude}` : "Locating…"}</p>;
 * }
 * ```
 */
export function useLocation(options: UseLocationOptions = {}): LocationState {
  const [state, setState] = useState<LocationState>({ position: undefined, error: undefined });
  const optsRef = useRef(options);
  optsRef.current = options;
  const enabled = options.enabled !== false;
  useEffect(() => {
    if (!enabled) return;
    return watchPosition(
      (position) => setState({ position, error: undefined }),
      optsRef.current,
      (error) => setState((prev) => ({ position: prev.position, error })),
    );
  }, [enabled, options.accuracy, options.minimumIntervalMs]);
  return state;
}
