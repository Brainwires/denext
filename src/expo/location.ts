/**
 * `expo-location` for denext: foreground location over `denext/mobile`'s geolocation
 * (`@capacitor/geolocation` in the Capacitor shell, `denext mobile add geolocation`;
 * `navigator.geolocation` on the web) and its permission API.
 *
 * Provided: the foreground permission calls and hook, `getCurrentPositionAsync`,
 * `getLastKnownPositionAsync`, `watchPositionAsync` (with `distanceInterval` applied here),
 * the provider status, and the enums. **Geocoding** needs a geocoding service, which neither the
 * WebView nor the plugin has: `geocodeAsync` / `reverseGeocodeAsync` call the geocoder you pass
 * to {@linkcode setGeocoder} (any HTTP geocoding API), and reject naming it without one. Not
 * provided (see the manifest): background location and geofencing (they need a background task
 * runner and a Capacitor 8 background-location plugin denext does not ship yet), the compass
 * heading and motion activity. Background permission reads denied.
 *
 * @example
 * ```ts
 * import * as Location from "denext/expo/location";
 *
 * const { status } = await Location.requestForegroundPermissionsAsync();
 * if (status === "granted") {
 *   const here = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
 * }
 * ```
 *
 * @module
 */

import {
  geolocationPlugin,
  type GeoPosition,
  type GeoPositionOptions,
  getCurrentPosition,
  watchPosition,
} from "../mobile/geolocation.ts";
import { checkPermission, type PermissionState, requestPermission } from "../mobile/permissions.ts";
import {
  createPermissionHook,
  type PermissionExpiration,
  type PermissionHookOptions,
  type PermissionResponse,
  permissionResponse,
  PermissionStatus,
} from "./internal/common.ts";

export { PermissionStatus };
export type { PermissionExpiration, PermissionHookOptions, PermissionResponse };

/** How precise a fix should be. */
export enum LocationAccuracy {
  /** ~3 km. */
  Lowest = 1,
  /** ~1 km. */
  Low = 2,
  /** ~100 m. */
  Balanced = 3,
  /** ~10 m. */
  High = 4,
  /** The best available. */
  Highest = 5,
  /** The best available, for navigation. */
  BestForNavigation = 6,
}

/** iOS: the kind of activity (accepted, not applied here). */
export enum LocationActivityType {
  /** Other. */
  Other = 1,
  /** Driving navigation. */
  AutomotiveNavigation = 2,
  /** Fitness. */
  Fitness = 3,
  /** Other navigation. */
  OtherNavigation = 4,
  /** Airborne. */
  Airborne = 5,
}

/** A geofencing event (geofencing is not provided). */
export enum LocationGeofencingEventType {
  /** Entered. */
  Enter = 1,
  /** Left. */
  Exit = 2,
}

/** A geofence region's state (geofencing is not provided). */
export enum LocationGeofencingRegionState {
  /** Unknown. */
  Unknown = 0,
  /** Inside. */
  Inside = 1,
  /** Outside. */
  Outside = 2,
}

/** Motion activity confidence (motion activity is not provided). */
export enum MotionActivityConfidence {
  /** Low. */
  Low = 0,
  /** Medium. */
  Medium = 1,
  /** High. */
  High = 2,
}

/** Motion activity kinds (motion activity is not provided). */
export enum MotionActivityType {
  /** Driving. */
  Automotive = "automotive",
  /** Cycling. */
  Cycling = "cycling",
  /** Running. */
  Running = "running",
  /** Walking. */
  Walking = "walking",
  /** Still. */
  Stationary = "stationary",
  /** Unknown. */
  Unknown = "unknown",
}

export {
  LocationAccuracy as Accuracy,
  LocationActivityType as ActivityType,
  LocationGeofencingEventType as GeofencingEventType,
  LocationGeofencingRegionState as GeofencingRegionState,
};

/** Options for a position read or watch. */
export type LocationOptions = {
  /** The accuracy (default `Balanced`; `High` and up use GPS). */
  accuracy?: LocationAccuracy;
  /** Android: offer to turn on location services (ignored). */
  mayShowUserSettingsDialog?: boolean;
  /** A watch's minimum time between updates, in ms (Android). */
  timeInterval?: number;
  /** A watch's minimum distance between updates, in metres (applied here). */
  distanceInterval?: number;
};

/** Options for {@linkcode getLastKnownPositionAsync}. */
export type LocationLastKnownOptions = {
  /** The oldest acceptable fix, in ms. */
  maxAge?: number;
  /** The worst acceptable accuracy, in metres. */
  requiredAccuracy?: number;
};

/** A position's coordinates. */
export type LocationObjectCoords = {
  /** Latitude. */
  latitude: number;
  /** Longitude. */
  longitude: number;
  /** Altitude, when known. */
  altitude: number | null;
  /** Horizontal accuracy in metres. */
  accuracy: number | null;
  /** Altitude accuracy in metres, when known. */
  altitudeAccuracy: number | null;
  /** Heading in degrees, when moving. */
  heading: number | null;
  /** Speed in m/s, when moving. */
  speed: number | null;
};

/** A position. */
export type LocationObject = {
  /** The coordinates. */
  coords: LocationObjectCoords;
  /** When it was taken, in ms since the epoch. */
  timestamp: number;
  /** Android: whether it came from a mock provider (not reported: `false`). */
  mocked?: boolean;
};

/** A position callback. */
export type LocationCallback = (location: LocationObject) => unknown;

/** A watch's error callback. */
export type LocationErrorCallback = (reason: string) => void;

/** Which location providers are on. */
export type LocationProviderStatus = {
  /** Whether a location source is there (the WebView cannot see the system switch). */
  locationServicesEnabled: boolean;
  /** Whether background updates can run (never, here). */
  backgroundModeEnabled: boolean;
  /** Android: GPS (not reported). */
  gpsAvailable?: boolean;
  /** Android: the network provider (not reported). */
  networkAvailable?: boolean;
  /** Android: the passive provider (not reported). */
  passiveAvailable?: boolean;
};

/** A coordinate a geocoder returns. */
export type LocationGeocodedLocation = {
  /** Latitude. */
  latitude: number;
  /** Longitude. */
  longitude: number;
  /** Altitude, when known. */
  altitude?: number;
  /** Accuracy in metres, when known. */
  accuracy?: number;
};

/** An address a reverse geocoder returns. */
export type LocationGeocodedAddress = {
  /** City. */
  city: string | null;
  /** District. */
  district: string | null;
  /** Street number. */
  streetNumber: string | null;
  /** Street. */
  street: string | null;
  /** Region / state. */
  region: string | null;
  /** Subregion / county. */
  subregion: string | null;
  /** Country. */
  country: string | null;
  /** Postal code. */
  postalCode: string | null;
  /** A name for the place. */
  name: string | null;
  /** ISO 3166 country code. */
  isoCountryCode: string | null;
  /** IANA time zone. */
  timezone: string | null;
  /** The address as one line. */
  formattedAddress: string | null;
};

/** What `watchPositionAsync` returns. */
export type LocationSubscription = {
  /** Stop watching. */
  remove: () => void;
};

/** iOS permission details. */
export type PermissionDetailsLocationIOS = {
  /** The granted scope. */
  scope: "whenInUse" | "always" | "none";
  /** Precise or approximate. */
  accuracy: "full" | "reduced";
};

/** Android permission details. */
export type PermissionDetailsLocationAndroid = {
  /** Fine, coarse, or none. */
  accuracy: "fine" | "coarse" | "none";
};

/** A location permission answer, with the platform details. */
export type LocationPermissionResponse = PermissionResponse & {
  /** iOS details. */
  ios?: PermissionDetailsLocationIOS;
  /** Android details. */
  android?: PermissionDetailsLocationAndroid;
};

/** A geocoding service for {@linkcode geocodeAsync} / {@linkcode reverseGeocodeAsync}. */
export interface Geocoder {
  /** Coordinates for an address. */
  geocode?: (address: string) => Promise<LocationGeocodedLocation[]>;
  /** Addresses for coordinates. */
  reverseGeocode?: (
    location: Pick<LocationGeocodedLocation, "latitude" | "longitude">,
  ) => Promise<LocationGeocodedAddress[]>;
}

let geocoder: Geocoder | null = null;
let lastFix: LocationObject | null = null;
let watchIds = 0;

/**
 * Plug in a geocoding service (denext only; Expo's native geocoders have no WebView
 * equivalent). Pass `null` to remove it.
 *
 * @param next The geocoder, or null.
 * @example
 * ```ts
 * import * as Location from "denext/expo/location";
 *
 * Location.setGeocoder({
 *   reverseGeocode: async ({ latitude, longitude }) => myGeocodingApi.reverse(latitude, longitude),
 * });
 * ```
 */
export function setGeocoder(next: Geocoder | null): void {
  geocoder = next;
}

/** A denext position as Expo's, remembered as the last known fix. */
function toLocation(p: GeoPosition): LocationObject {
  lastFix = {
    coords: {
      latitude: p.latitude,
      longitude: p.longitude,
      altitude: p.altitude,
      accuracy: p.accuracy,
      altitudeAccuracy: p.altitudeAccuracy,
      heading: p.heading,
      speed: p.speed,
    },
    timestamp: p.timestamp,
    mocked: false,
  };
  return lastFix;
}

/** Expo's options as denext's. */
function geoOptions(options: LocationOptions = {}): GeoPositionOptions {
  return {
    accuracy: (options.accuracy ?? LocationAccuracy.Balanced) >= LocationAccuracy.High
      ? "high"
      : "balanced",
    ...(options.timeInterval === undefined ? {} : { minimumIntervalMs: options.timeInterval }),
  };
}

/** A permission status as Expo's answer. */
function locationResponse(state: PermissionState | undefined): LocationPermissionResponse {
  const status = state === "granted" || state === "limited"
    ? PermissionStatus.GRANTED
    : state === "denied" || state === "blocked"
    ? PermissionStatus.DENIED
    : PermissionStatus.UNDETERMINED;
  const reduced = state === "limited";
  const granted = status === PermissionStatus.GRANTED;
  return {
    ...permissionResponse(status),
    canAskAgain: state !== "blocked",
    ios: { scope: granted ? "whenInUse" : "none", accuracy: reduced ? "reduced" : "full" },
    android: { accuracy: granted ? (reduced ? "coarse" : "fine") : "none" },
  };
}

/** A permission read that treats "nothing can answer" as undetermined. */
async function orUndetermined(read: () => Promise<PermissionState>) {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/**
 * The foreground location permission.
 *
 * @returns The permission.
 */
export async function getForegroundPermissionsAsync(): Promise<LocationPermissionResponse> {
  return locationResponse(await orUndetermined(() => checkPermission("location")));
}

/**
 * Ask for the foreground location permission.
 *
 * @returns The permission.
 */
export async function requestForegroundPermissionsAsync(): Promise<LocationPermissionResponse> {
  return locationResponse(await orUndetermined(() => requestPermission("location")));
}

/** Hook form of the foreground permission: `[response, request, get]`. */
export const useForegroundPermissions: (
  options?: PermissionHookOptions<object>,
) => [
  LocationPermissionResponse | null,
  () => Promise<LocationPermissionResponse>,
  () => Promise<LocationPermissionResponse>,
] = createPermissionHook({
  getMethod: getForegroundPermissionsAsync,
  requestMethod: requestForegroundPermissionsAsync,
});

/** Background location: not available (denied, and not askable). */
function backgroundDenied(): Promise<PermissionResponse> {
  return Promise.resolve({ ...permissionResponse(PermissionStatus.DENIED), canAskAgain: false });
}

/**
 * The background location permission: always denied here (background location is not
 * shipped).
 *
 * @returns Denied.
 */
export function getBackgroundPermissionsAsync(): Promise<PermissionResponse> {
  return backgroundDenied();
}

/**
 * Ask for background location: always denied here (background location is not shipped).
 *
 * @returns Denied.
 */
export function requestBackgroundPermissionsAsync(): Promise<PermissionResponse> {
  return backgroundDenied();
}

/** Hook form of the background permission (always denied). */
export const useBackgroundPermissions: (
  options?: PermissionHookOptions<object>,
) => [
  PermissionResponse | null,
  () => Promise<PermissionResponse>,
  () => Promise<PermissionResponse>,
] = createPermissionHook({
  getMethod: getBackgroundPermissionsAsync,
  requestMethod: requestBackgroundPermissionsAsync,
});

/** Whether any location source is here (the native plugin or `navigator.geolocation`). */
function hasSource(): boolean {
  const nav = (globalThis as { navigator?: { geolocation?: unknown } }).navigator;
  return geolocationPlugin() !== undefined || typeof nav?.geolocation === "object";
}

/**
 * Whether location services are on: here, whether a location source exists (a WebView cannot
 * read the system switch; a read then fails with "unavailable").
 *
 * @returns `true` when there is a source.
 */
export function hasServicesEnabledAsync(): Promise<boolean> {
  return Promise.resolve(hasSource());
}

/**
 * The provider status, as far as a WebView can tell.
 *
 * @returns The status.
 */
export function getProviderStatusAsync(): Promise<LocationProviderStatus> {
  return Promise.resolve({ locationServicesEnabled: hasSource(), backgroundModeEnabled: false });
}

/**
 * Android: ask to turn on the network provider (does nothing here).
 *
 * @returns A promise that resolves.
 */
export function enableNetworkProviderAsync(): Promise<void> {
  return Promise.resolve();
}

/**
 * Whether background location can run: never, here.
 *
 * @returns `false`.
 */
export function isBackgroundLocationAvailableAsync(): Promise<boolean> {
  return Promise.resolve(false);
}

/**
 * The current position.
 *
 * @param options The accuracy.
 * @returns The position.
 */
export async function getCurrentPositionAsync(options?: LocationOptions): Promise<LocationObject> {
  return toLocation(await getCurrentPosition(geoOptions(options)));
}

/**
 * The last known position, or null: the last fix this app got (within `maxAge` and
 * `requiredAccuracy`), else a cached fix from the platform when it has one.
 *
 * @param options The oldest and least accurate acceptable fix.
 * @returns The position, or null.
 */
export async function getLastKnownPositionAsync(
  options: LocationLastKnownOptions = {},
): Promise<LocationObject | null> {
  const fits = (fix: LocationObject | null) =>
    fix !== null &&
    (options.maxAge === undefined || Date.now() - fix.timestamp <= options.maxAge) &&
    (options.requiredAccuracy === undefined ||
      (fix.coords.accuracy ?? Infinity) <= options.requiredAccuracy);
  if (fits(lastFix)) return lastFix;
  try {
    const cached = toLocation(
      await getCurrentPosition({
        accuracy: "balanced",
        maximumAgeMs: options.maxAge ?? Number.MAX_SAFE_INTEGER,
        timeoutMs: 2_000,
      }),
    );
    return fits(cached) ? cached : null;
  } catch {
    return null;
  }
}

/** The distance between two coordinates, in metres (haversine). */
function metresBetween(a: LocationObjectCoords, b: LocationObjectCoords): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * Watch the position; `callback` runs for each fix at least `distanceInterval` metres from the
 * last one delivered.
 *
 * @param options Accuracy, interval and distance.
 * @param callback Called with each fix.
 * @param errorHandler Called with each failure's message.
 * @returns A subscription to remove.
 */
export function watchPositionAsync(
  options: LocationOptions,
  callback: LocationCallback,
  errorHandler?: LocationErrorCallback,
): Promise<LocationSubscription> {
  let delivered: LocationObject | null = null;
  const min = options?.distanceInterval ?? 0;
  watchIds++;
  const stop = watchPosition(
    (p) => {
      const next = toLocation(p);
      if (delivered && min > 0 && metresBetween(delivered.coords, next.coords) < min) return;
      delivered = next;
      callback(next);
    },
    geoOptions(options),
    (err) => errorHandler?.(err.message),
  );
  return Promise.resolve({ remove: stop });
}

/**
 * The id of the latest watch (Expo internals; a counter here).
 *
 * @returns The id.
 */
export function _getCurrentWatchId(): number {
  return watchIds;
}

/**
 * Install Expo's `navigator.geolocation` polyfill: the WebView and the browser already have
 * `navigator.geolocation`, so this does nothing.
 */
export function installWebGeolocationPolyfill(): void {}

/** Expo's native event emitter (unused here: listeners go through the watch functions). */
export const EventEmitter: {
  addListener: (event: string, listener: (...args: unknown[]) => void) => { remove(): void };
  removeAllListeners: (event: string) => void;
} = {
  addListener: () => ({ remove() {} }),
  removeAllListeners: () => {},
};

/** The rejection for a geocoding call without a geocoder. */
function noGeocoder(fn: string): Error {
  return new Error(
    `${fn}: no geocoder. A WebView has no geocoding service; plug one in with ` +
      "setGeocoder({ geocode, reverseGeocode }) from denext/expo/location (any HTTP geocoding API).",
  );
}

/**
 * Coordinates for an address, through the geocoder set with {@linkcode setGeocoder}.
 *
 * @param address The address.
 * @returns The coordinates (rejects without a geocoder).
 */
export async function geocodeAsync(address: string): Promise<LocationGeocodedLocation[]> {
  if (!geocoder?.geocode) throw noGeocoder("geocodeAsync");
  return await geocoder.geocode(address);
}

/**
 * Addresses for coordinates, through the geocoder set with {@linkcode setGeocoder}.
 *
 * @param location The coordinates.
 * @returns The addresses (rejects without a geocoder).
 */
export async function reverseGeocodeAsync(
  location: Pick<LocationGeocodedLocation, "latitude" | "longitude">,
): Promise<LocationGeocodedAddress[]> {
  if (!geocoder?.reverseGeocode) throw noGeocoder("reverseGeocodeAsync");
  return await geocoder.reverseGeocode(location);
}
