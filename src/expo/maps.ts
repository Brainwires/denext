/**
 * `expo-maps` for denext: a load-safe stand-in. Apple Maps and Google Maps are native views
 * a web view does not have, so `AppleMaps.View`, `GoogleMaps.View` and
 * `GoogleMaps.StreetView` render a labelled placeholder of their size (and warn once), and
 * their ref methods (`setCameraPosition`, `selectMarker`, `openLookAroundAsync`) throw a
 * denext error naming the web alternative. The enums are real, and the location permission
 * calls run over `denext/expo/location`'s foreground permission.
 *
 * For a map on the web and in the shell, render a web map instead (Leaflet or MapLibre GL:
 * see /docs/react-native, "Maps"), for example in a `.web.tsx` file beside the screen that
 * imports `expo-maps`.
 *
 * @example
 * ```ts
 * import { AppleMaps, GoogleMaps } from "denext/expo/maps";
 * import { h } from "denext/jsx-runtime";
 *
 * h(AppleMaps.View, { style: { flex: 1 } }); // a placeholder: use a web map instead
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useImperativeHandle } from "../runtime/hooks.ts";
import {
  createPermissionHook,
  hostView,
  type PermissionExpiration,
  type PermissionHookOptions,
  type PermissionResponse,
  PermissionStatus,
  viewStyle,
} from "./internal/common.ts";
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
const HINT = "Render a web map (Leaflet or MapLibre GL) instead: see /docs/react-native, Maps.";

/** Props of a map view stand-in (whatever the native view takes). */
export type MapViewProps = Record<string, unknown> & { style?: unknown; ref?: unknown };

/** The ref handle of a map view stand-in: every method throws. */
export interface MapViewHandle {
  /** Move the camera (throws). */
  setCameraPosition(config?: CameraPosition): void;
  /** Select a marker (throws). */
  selectMarker(id?: string, options?: { zoom?: number; moveCamera?: boolean }): void;
  /** Open Look Around (rejects). */
  openLookAroundAsync(coordinates: Coordinates): Promise<void>;
}

/** The ref handle of `name`: each method fails with {@linkcode HINT}. */
function mapHandle(name: string): MapViewHandle {
  const fail = (method: string) => nativeViewError("expo-maps", `${name}.${method}`, HINT);
  return {
    setCameraPosition() {
      throw fail("setCameraPosition");
    },
    selectMarker() {
      throw fail("selectMarker");
    },
    openLookAroundAsync() {
      return Promise.reject(fail("openLookAroundAsync"));
    },
  };
}

/** A map view stand-in: a grey box with a note, of the view's size. */
function mapStub(name: string): (props: MapViewProps) => VNode {
  const Stub = (props: MapViewProps): VNode => {
    useImperativeHandle(props.ref as never, () => mapHandle(name), []);
    warnNativeView("expo-maps", name, `denext renders a placeholder. ${HINT}`);
    return h(
      hostView(),
      {
        accessibilityLabel: "Map unavailable",
        style: viewStyle(props.style, {
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#e5e7eb",
          minHeight: 120,
        }),
      },
      h("span", { style: { color: "#4b5563", fontSize: 13, padding: 8 } }, "Map unavailable"),
    );
  };
  Object.defineProperty(Stub, "name", { value: name });
  return Stub;
}

/** Google Maps: the view stand-ins and the enums. */
export const GoogleMaps: {
  /** The map (a placeholder). */
  View: (props: MapViewProps) => VNode;
  /** Street View (a placeholder). */
  StreetView: (props: MapViewProps) => VNode;
  /** The map types. */
  MapType: typeof GoogleMapsMapType;
  /** The color schemes. */
  MapColorScheme: typeof GoogleMapsColorScheme;
} = {
  View: /* @__PURE__ */ mapStub("GoogleMaps.View"),
  StreetView: /* @__PURE__ */ mapStub("GoogleMaps.StreetView"),
  MapType: GoogleMapsMapType,
  MapColorScheme: GoogleMapsColorScheme,
};

/** Apple Maps: the view stand-in and the enums. */
export const AppleMaps: {
  /** The map (a placeholder). */
  View: (props: MapViewProps) => VNode;
  /** The map types. */
  MapType: typeof AppleMapsMapType;
  /** The elevation styles. */
  MapStyleElevation: typeof AppleMapsMapStyleElevation;
  /** The color schemes. */
  MapColorScheme: typeof AppleMapsColorScheme;
  /** The polyline contour styles. */
  ContourStyle: typeof AppleMapsContourStyle;
} = {
  View: /* @__PURE__ */ mapStub("AppleMaps.View"),
  MapType: AppleMapsMapType,
  MapStyleElevation: AppleMapsMapStyleElevation,
  MapColorScheme: AppleMapsColorScheme,
  ContourStyle: AppleMapsContourStyle,
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
