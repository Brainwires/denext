/**
 * `expo-maps` for denext. `AppleMaps.View` and `GoogleMaps.View` are `denext/mobile`'s native
 * `"map"` view (MapKit on iOS, OpenStreetMap through osmdroid on Android: `denext mobile add
 * native-map`): `cameraPosition`, `markers` (`coordinates`, `title`), `properties.mapType`,
 * `uiSettings` scroll / zoom, `onCameraMove`, `onMarkerClick`, and the ref's
 * `setCameraPosition` / `selectMarker` reach the native map. Wherever that view is not
 * registered natively (the web, a shell without the plugin) they render a labelled
 * placeholder of their size, and the ref methods throw a denext error naming the fix.
 * `GoogleMaps.StreetView` is always a placeholder, `openLookAroundAsync` rejects, and the
 * other props (polylines, circles, user location, …) are ignored. The enums are real, and the
 * location permission calls run over `denext/expo/location`'s foreground permission.
 *
 * For a map on the web, render a web map (Leaflet or MapLibre GL: see /docs/react-native,
 * "Maps") in a `.web.tsx` file beside the screen that imports `expo-maps`.
 *
 * @example
 * ```ts
 * import { AppleMaps } from "denext/expo/maps";
 * import { h } from "denext/jsx-runtime";
 *
 * h(AppleMaps.View, {
 *   style: { flex: 1 },
 *   cameraPosition: { coordinates: { latitude: 51.5, longitude: -0.12 }, zoom: 12 },
 * });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useImperativeHandle, useRef } from "../runtime/hooks.ts";
import {
  createPermissionHook,
  hostView,
  type PermissionExpiration,
  type PermissionHookOptions,
  type PermissionResponse,
  PermissionStatus,
  viewStyle,
} from "./internal/common.ts";
import {
  NativeMap,
  type NativeMapCommand,
  type NativeMapMarker,
  type NativeMapRegion,
  setNativeMapRegion,
} from "./internal/map-view.ts";
import { nativeViewError, warnNativeView } from "./internal/native-view.ts";
import { getForegroundPermissionsAsync, requestForegroundPermissionsAsync } from "./location.ts";

export { PermissionStatus };
export type { PermissionExpiration, PermissionHookOptions, PermissionResponse };

/** A point on the map. */
export type Coordinates = {
  /** Latitude. */
  latitude?: number;
  /** Longitude. */
  longitude?: number;
};

/** Where the camera looks. */
export type CameraPosition = {
  /** The center. */
  coordinates?: Coordinates;
  /** The zoom level. */
  zoom?: number;
};

/** Google Maps' map types. */
export enum GoogleMapsMapType {
  /** Satellite imagery with roads and labels. */
  HYBRID = "HYBRID",
  /** The standard road map. */
  NORMAL = "NORMAL",
  /** Satellite imagery. */
  SATELLITE = "SATELLITE",
  /** Terrain. */
  TERRAIN = "TERRAIN",
}

/** Google Maps' color schemes. */
export enum GoogleMapsColorScheme {
  /** Light. */
  LIGHT = "LIGHT",
  /** Dark. */
  DARK = "DARK",
  /** The system's. */
  FOLLOW_SYSTEM = "FOLLOW_SYSTEM",
}

/** Apple Maps' map types. */
export enum AppleMapsMapType {
  /** Satellite imagery with roads and labels. */
  HYBRID = "HYBRID",
  /** The standard map. */
  STANDARD = "STANDARD",
  /** Satellite imagery. */
  IMAGERY = "IMAGERY",
}

/**
 * Apple Maps' point-of-interest categories (MapKit's `MKPointOfInterestCategory`), for a
 * map's point-of-interest filter (accepted and ignored by the native map view here).
 */
export enum AppleMapPointOfInterestCategory {
  MUSEUM = "MUSEUM",
  MUSIC_VENUE = "MUSIC_VENUE",
  THEATER = "THEATER",
  LIBRARY = "LIBRARY",
  PLANETARIUM = "PLANETARIUM",
  SCHOOL = "SCHOOL",
  UNIVERSITY = "UNIVERSITY",
  MOVIE_THEATER = "MOVIE_THEATER",
  NIGHTLIFE = "NIGHTLIFE",
  FIRE_STATION = "FIRE_STATION",
  HOSPITAL = "HOSPITAL",
  PHARMACY = "PHARMACY",
  POLICE = "POLICE",
  CASTLE = "CASTLE",
  FORTRESS = "FORTRESS",
  LANDMARK = "LANDMARK",
  NATIONAL_MONUMENT = "NATIONAL_MONUMENT",
  BAKERY = "BAKERY",
  BREWERY = "BREWERY",
  CAFE = "CAFE",
  DISTILLERY = "DISTILLERY",
  FOOD_MARKET = "FOOD_MARKET",
  RESTAURANT = "RESTAURANT",
  WINERY = "WINERY",
  ANIMAL_SERVICE = "ANIMAL_SERVICE",
  ATM = "ATM",
  AUTOMOTIVE_REPAIR = "AUTOMOTIVE_REPAIR",
  BANK = "BANK",
  BEAUTY = "BEAUTY",
  EV_CHARGER = "EV_CHARGER",
  FITNESS_CENTER = "FITNESS_CENTER",
  LAUNDRY = "LAUNDRY",
  MAILBOX = "MAILBOX",
  POST_OFFICE = "POST_OFFICE",
  RESTROOM = "RESTROOM",
  SPA = "SPA",
  STORE = "STORE",
  AMUSEMENT_PARK = "AMUSEMENT_PARK",
  AQUARIUM = "AQUARIUM",
  BEACH = "BEACH",
  CAMPGROUND = "CAMPGROUND",
  FAIRGROUND = "FAIRGROUND",
  MARINA = "MARINA",
  NATIONAL_PARK = "NATIONAL_PARK",
  PARK = "PARK",
  RV_PARK = "RV_PARK",
  ZOO = "ZOO",
  BASEBALL = "BASEBALL",
  BASKETBALL = "BASKETBALL",
  BOWLING = "BOWLING",
  GO_KART = "GO_KART",
  GOLF = "GOLF",
  HIKING = "HIKING",
  MINI_GOLF = "MINI_GOLF",
  ROCK_CLIMBING = "ROCK_CLIMBING",
  SKATE_PARK = "SKATE_PARK",
  SKATING = "SKATING",
  SKIING = "SKIING",
  SOCCER = "SOCCER",
  STADIUM = "STADIUM",
  TENNIS = "TENNIS",
  VOLLEYBALL = "VOLLEYBALL",
  AIRPORT = "AIRPORT",
  CAR_RENTAL = "CAR_RENTAL",
  CONVENTION_CENTER = "CONVENTION_CENTER",
  GAS_STATION = "GAS_STATION",
  HOTEL = "HOTEL",
  PARKING = "PARKING",
  PUBLIC_TRANSPORT = "PUBLIC_TRANSPORT",
  FISHING = "FISHING",
  KAYAKING = "KAYAKING",
  SURFING = "SURFING",
  SWIMMING = "SWIMMING",
}

/** Apple Maps' polyline contour styles. */
export enum AppleMapsContourStyle {
  /** Straight segments. */
  STRAIGHT = "STRAIGHT",
  /** Geodesic curves. */
  GEODESIC = "GEODESIC",
}

/** Apple Maps' elevation styles. */
export enum AppleMapsMapStyleElevation {
  /** The system's choice. */
  AUTOMATIC = "AUTOMATIC",
  /** Flat. */
  FLAT = "FLAT",
  /** Realistic 3D. */
  REALISTIC = "REALISTIC",
}

/** Apple Maps' color schemes. */
export enum AppleMapsColorScheme {
  /** The system's. */
  AUTOMATIC = "AUTOMATIC",
  /** Light. */
  LIGHT = "LIGHT",
  /** Dark. */
  DARK = "DARK",
}

/** Where the placeholder sends a developer. */
const HINT = "Street View has no native view here: render a web alternative instead.";

/** Props of a map view (the common `expo-maps` props; any other prop is ignored). */
export type MapViewProps = Record<string, unknown> & {
  /** Where the camera looks. */
  cameraPosition?: CameraPosition;
  /** The markers (`coordinates`, `title`, `id`). */
  markers?: ReadonlyArray<{ coordinates?: Coordinates; title?: string; id?: string }>;
  /** Map properties (`mapType`). */
  properties?: { mapType?: string } & Record<string, unknown>;
  /** UI settings (`scrollEnabled` / `zoomEnabled` false turns interaction off). */
  uiSettings?: Record<string, unknown>;
  /** The camera moved. */
  onCameraMove?: (event: { coordinates: Coordinates; zoom: number }) => void;
  /** A marker was tapped. */
  onMarkerClick?: (marker: { coordinates?: Coordinates; title?: string; id?: string }) => void;
  /** The style. */
  style?: unknown;
  /** The ref (a {@linkcode MapViewHandle}). */
  ref?: unknown;
};

/** The ref handle of a map view. */
export interface MapViewHandle {
  /** Move the camera (the native map; throws while the map is the web placeholder). */
  setCameraPosition(config?: CameraPosition): void;
  /** Select a marker: moves the camera to it (throws while the map is the web placeholder). */
  selectMarker(id?: string, options?: { zoom?: number; moveCamera?: boolean }): void;
  /** Open Look Around (rejects: not provided). */
  openLookAroundAsync(coordinates: Coordinates): Promise<void>;
}

/** The native map type of an Apple / Google map type enum value. */
function nativeMapType(type: unknown): string | undefined {
  switch (type) {
    case "HYBRID":
      return "hybrid";
    case "IMAGERY":
    case "SATELLITE":
      return "satellite";
    case "STANDARD":
    case "NORMAL":
    case "TERRAIN":
      return "standard";
    default:
      return undefined;
  }
}

/** The native markers of an `expo-maps` markers prop. */
function nativeMarkers(markers: MapViewProps["markers"]): NativeMapMarker[] {
  const out: NativeMapMarker[] = [];
  for (const m of markers ?? []) {
    const { latitude, longitude } = m?.coordinates ?? {};
    if (typeof latitude !== "number" || typeof longitude !== "number") continue;
    out.push({ latitude, longitude, ...(m.title ? { title: m.title } : {}) });
  }
  return out;
}

/** The coordinates of `c` when it has both, else null. */
function point(c: Coordinates | undefined): { latitude: number; longitude: number } | null {
  return typeof c?.latitude === "number" && typeof c?.longitude === "number"
    ? { latitude: c.latitude, longitude: c.longitude }
    : null;
}

/** The ref handle of `name` over the native map's command runner. */
function mapHandle(
  name: string,
  command: { current: NativeMapCommand },
  props: { current: MapViewProps },
): MapViewHandle {
  // Throws while the map is the web placeholder, whatever the arguments.
  const runner = (method: string) => {
    if (!command.current) throw nativeViewError("expo-maps", `${name}.${method}`, NATIVE_HINT);
    return command.current;
  };
  const move = (run: NativeMapCommand, center: ReturnType<typeof point>, zoom: number) => {
    if (center) setNativeMapRegion(run, { ...center, zoom }).catch(() => {});
  };
  const camera = () => props.current.cameraPosition;
  return {
    setCameraPosition(config) {
      const run = runner("setCameraPosition");
      const center = point(config?.coordinates) ?? point(camera()?.coordinates);
      move(run, center, config?.zoom ?? camera()?.zoom ?? 12);
    },
    selectMarker(id, options) {
      const run = runner("selectMarker");
      if (options?.moveCamera === false) return;
      const marker = (props.current.markers ?? []).find((m) => m.id === id);
      move(run, point(marker?.coordinates), options?.zoom ?? camera()?.zoom ?? 15);
    },
    openLookAroundAsync() {
      return Promise.reject(nativeViewError("expo-maps", `${name}.openLookAroundAsync`, HINT));
    },
  };
}

/** What a map view's ref methods need when the map is the web placeholder. */
const NATIVE_HINT = "Add the native map (`denext mobile add native-map`) or render a web map " +
  "(Leaflet or MapLibre GL): see /docs/react-native, Maps.";

/** A map view: the native `"map"` view, else a placeholder. */
function mapView(name: string): (props: MapViewProps) => VNode {
  const View = (props: MapViewProps): VNode => {
    const command = useRef<NativeMapCommand>(null);
    const latest = useRef(props);
    latest.current = props;
    useImperativeHandle(props.ref as never, () => mapHandle(name, command, latest), []);
    const camera = props.cameraPosition;
    const ui = props.uiSettings ?? {};
    return h(NativeMap, {
      region: {
        latitude: camera?.coordinates?.latitude,
        longitude: camera?.coordinates?.longitude,
        zoom: camera?.zoom,
      },
      markers: nativeMarkers(props.markers),
      mapType: nativeMapType(props.properties?.mapType),
      interactive: ui.scrollEnabled !== false || ui.zoomEnabled !== false,
      style: props.style,
      onRegionChange: (r: NativeMapRegion) =>
        latest.current.onCameraMove?.({
          coordinates: { latitude: r.latitude, longitude: r.longitude },
          zoom: r.zoom,
        }),
      onMarkerPress: (index: number) => {
        const marker = latest.current.markers?.[index];
        if (marker) latest.current.onMarkerClick?.(marker);
      },
      onCommand: (c: NativeMapCommand) => void (command.current = c),
      onPlaceholder: () =>
        warnNativeView(
          "expo-maps",
          name,
          `denext renders a placeholder on the web. ${NATIVE_HINT}`,
        ),
    });
  };
  Object.defineProperty(View, "name", { value: name });
  return View;
}

/** A view with no native equivalent here: a grey box with a note, of the view's size. */
function mapStub(name: string): (props: MapViewProps) => VNode {
  const Stub = (props: MapViewProps): VNode => {
    warnNativeView("expo-maps", name, `denext renders a placeholder. ${HINT}`);
    return h(
      hostView(),
      {
        accessibilityLabel: "Street View unavailable",
        style: viewStyle(props.style, {
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#e5e7eb",
          minHeight: 120,
        }),
      },
      h(
        "span",
        { style: { color: "#4b5563", fontSize: 13, padding: 8 } },
        "Street View unavailable",
      ),
    );
  };
  Object.defineProperty(Stub, "name", { value: name });
  return Stub;
}

/** Google Maps: the view stand-ins and the enums. */
export const GoogleMaps: {
  /** The map: the native map view, else a placeholder. */
  View: (props: MapViewProps) => VNode;
  /** Street View (a placeholder). */
  StreetView: (props: MapViewProps) => VNode;
  /** The map types. */
  MapType: typeof GoogleMapsMapType;
  /** The color schemes. */
  MapColorScheme: typeof GoogleMapsColorScheme;
} = {
  View: /* @__PURE__ */ mapView("GoogleMaps.View"),
  StreetView: /* @__PURE__ */ mapStub("GoogleMaps.StreetView"),
  MapType: GoogleMapsMapType,
  MapColorScheme: GoogleMapsColorScheme,
};

/** Apple Maps: the view stand-in and the enums. */
export const AppleMaps: {
  /** The map: the native map view, else a placeholder. */
  View: (props: MapViewProps) => VNode;
  /** The map types. */
  MapType: typeof AppleMapsMapType;
  /** The elevation styles. */
  MapStyleElevation: typeof AppleMapsMapStyleElevation;
  /** The color schemes. */
  MapColorScheme: typeof AppleMapsColorScheme;
  /** The polyline contour styles. */
  ContourStyle: typeof AppleMapsContourStyle;
  /** The point-of-interest categories. */
  PointOfInterestCategory: typeof AppleMapPointOfInterestCategory;
} = {
  View: /* @__PURE__ */ mapView("AppleMaps.View"),
  MapType: AppleMapsMapType,
  MapStyleElevation: AppleMapsMapStyleElevation,
  MapColorScheme: AppleMapsColorScheme,
  ContourStyle: AppleMapsContourStyle,
  PointOfInterestCategory: AppleMapPointOfInterestCategory,
};

/**
 * The location permission a map's user-location dot needs: `denext/expo/location`'s
 * foreground permission.
 *
 * @returns The permission.
 */
export async function getPermissionsAsync(): Promise<PermissionResponse> {
  return await getForegroundPermissionsAsync();
}

/**
 * Ask for the location permission (`denext/expo/location`'s foreground request).
 *
 * @returns The answer.
 */
export async function requestPermissionsAsync(): Promise<PermissionResponse> {
  return await requestForegroundPermissionsAsync();
}

/** Hook form of the location permission: `[response, request, get]`. */
export const useLocationPermissions: (
  options?: PermissionHookOptions<object>,
) => [
  PermissionResponse | null,
  () => Promise<PermissionResponse>,
  () => Promise<PermissionResponse>,
] = /* @__PURE__ */ createPermissionHook({
  getMethod: getPermissionsAsync,
  requestMethod: requestPermissionsAsync,
});
