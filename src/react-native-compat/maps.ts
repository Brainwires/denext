/**
 * `react-native-maps` for denext (React Native mode): `MapView` is `denext/mobile`'s native
 * `"map"` view (MapKit on iOS, OpenStreetMap through osmdroid on Android: `denext mobile add
 * native-map`), and a labelled placeholder wherever that view is not registered natively (the
 * web, a shell without the plugin). The package's native views have no web build, so React
 * Native mode resolves the package here.
 *
 * `region` / `initialRegion` set the camera: the region's center, and a zoom level from its
 * `longitudeDelta` for the window's width. `onRegionChange` / `onRegionChangeComplete` get the
 * region back when the map moves (deltas from the zoom level, the same way), `mapType`
 * (`standard`, `satellite`, `hybrid`; `mutedStandard` / `terrain` draw `standard`),
 * `scrollEnabled` / `zoomEnabled` and the `<Marker>`s that are the map's direct children (or in
 * fragments and arrays) with their `coordinate`, `title` and `onPress` reach the native map.
 * The ref's `animateToRegion`, `animateCamera`, `setCamera`, `fitToCoordinates` and
 * `getCamera` move and read it. Callouts, polylines, polygons, circles, overlays, tiles, the
 * user-location dot and `provider` are accepted and draw nothing.
 *
 * @example
 * ```ts
 * import MapView, { Marker } from "react-native-maps"; // → this module
 * import { h } from "denext/jsx-runtime";
 *
 * h(MapView, {
 *   style: { flex: 1 },
 *   initialRegion: { latitude: 51.5, longitude: -0.12, latitudeDelta: 0.05, longitudeDelta: 0.05 },
 * }, h(Marker, { coordinate: { latitude: 51.5, longitude: -0.12 }, title: "London" }));
 * ```
 *
 * @module
 */

import { Fragment, h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { useImperativeHandle, useRef, useState } from "../runtime/hooks.ts";
import {
  NativeMap,
  type NativeMapCommand,
  type NativeMapMarker,
  type NativeMapRegion,
  setNativeMapRegion,
} from "../expo/internal/map-view.ts";

/** A point. */
export interface LatLng {
  /** Latitude. */
  latitude: number;
  /** Longitude. */
  longitude: number;
}

/** A visible area: its center and extent in degrees. */
export interface Region extends LatLng {
  /** The latitude extent. */
  latitudeDelta: number;
  /** The longitude extent. */
  longitudeDelta: number;
}

/** A camera. */
export interface Camera {
  /** The center. */
  center: LatLng;
  /** The zoom level (Google) / derived from `altitude` otherwise. */
  zoom?: number;
  /** The heading (always 0 here). */
  heading?: number;
  /** The pitch (always 0 here). */
  pitch?: number;
  /** The altitude in meters (Apple). */
  altitude?: number;
}

/** `<Marker>` props. */
export interface MarkerProps {
  /** Where it is. */
  coordinate: LatLng;
  /** The callout title. */
  title?: string;
  /** The callout description (ignored). */
  description?: string;
  /** An id for `fitToSuppliedMarkers` (ignored). */
  identifier?: string;
  /** Tapped. */
  onPress?: (event: { nativeEvent: { coordinate: LatLng; id?: string } }) => void;
  /** Other props (`pinColor`, `image`, custom children): ignored. */
  [prop: string]: unknown;
}

/** `<MapView>` props. */
export interface MapViewProps {
  /** The controlled camera region. */
  region?: Region;
  /** The first camera region. */
  initialRegion?: Region;
  /** The map type. */
  mapType?: "standard" | "satellite" | "hybrid" | "mutedStandard" | "terrain" | "none";
  /** Whether it pans (default `true`). */
  scrollEnabled?: boolean;
  /** Whether it zooms (default `true`). */
  zoomEnabled?: boolean;
  /** The map moved. */
  onRegionChange?: (region: Region, details: { isGesture?: boolean }) => void;
  /** The map finished moving. */
  onRegionChangeComplete?: (region: Region, details: { isGesture?: boolean }) => void;
  /** A marker was tapped. */
  onMarkerPress?: (event: { nativeEvent: { coordinate: LatLng; id?: string } }) => void;
  /** The map is ready. */
  onMapReady?: () => void;
  /** The style. */
  style?: unknown;
  /** Markers and overlays. */
  children?: VNodeChildren;
  /** The ref (a {@linkcode MapViewRef}). */
  ref?: unknown;
  /** Other props (`provider`, `showsUserLocation`, …): ignored. */
  [prop: string]: unknown;
}

/** What a `<MapView>` ref offers. */
export interface MapViewRef {
  /** Move to `region`. */
  animateToRegion(region: Region, duration?: number): void;
  /** Move the camera. */
  animateCamera(camera: Partial<Camera>, options?: { duration?: number }): void;
  /** Move the camera at once. */
  setCamera(camera: Partial<Camera>): void;
  /** Frame `coordinates`. */
  fitToCoordinates(
    coordinates: LatLng[],
    options?: { edgePadding?: unknown; animated?: boolean },
  ): void;
  /** Frame every marker. */
  fitToElements(options?: { animated?: boolean }): void;
  /** The camera now. */
  getCamera(): Promise<Camera>;
  /** The visible bounds. */
  getMapBoundaries(): Promise<{ northEast: LatLng; southWest: LatLng }>;
}

/** Google Maps as the provider (ignored: the native map is the platform's own). */
export const PROVIDER_GOOGLE = "google";
/** The platform's map as the provider. */
export const PROVIDER_DEFAULT: undefined = undefined;

/** The map types. */
export const MAP_TYPES = {
  STANDARD: "standard",
  SATELLITE: "satellite",
  HYBRID: "hybrid",
  TERRAIN: "terrain",
  NONE: "none",
  MUTEDSTANDARD: "mutedStandard",
} as const;

/** The map view's width in px, for the zoom ↔ degrees conversion (the window's). */
function viewWidth(): number {
  const w = (globalThis as { innerWidth?: number }).innerWidth;
  return typeof w === "number" && w > 0 ? w : 390;
}

/** The web-map zoom level that shows `longitudeDelta` degrees across the view. */
export function zoomForDelta(longitudeDelta: number, width = viewWidth()): number {
  const delta = Math.max(1e-6, Math.min(360, longitudeDelta));
  return Math.max(0, Math.min(20, Math.log2((360 * width) / (256 * delta))));
}

/** The degrees across the view at `zoom`. */
export function deltaForZoom(zoom: number, width = viewWidth()): number {
  return Math.min(360, (360 * width) / (256 * 2 ** zoom));
}

/** A region as the native camera. */
function toNative(region: Region): NativeMapRegion {
  return {
    latitude: region.latitude,
    longitude: region.longitude,
    zoom: zoomForDelta(region.longitudeDelta),
  };
}

/** The native camera as a region. */
function fromNative(r: NativeMapRegion): Region {
  const delta = deltaForZoom(r.zoom);
  return {
    latitude: r.latitude,
    longitude: r.longitude,
    latitudeDelta: delta,
    longitudeDelta: delta,
  };
}

/**
 * A marker on a {@linkcode MapView}: read by the map (a direct child, or in fragments and
 * arrays); renders nothing itself.
 *
 * @param _props The marker.
 * @returns null.
 */
export function Marker(_props: MarkerProps): null {
  return null;
}

/** An overlay the map does not draw here (renders nothing). */
function inert(name: string): (props: Record<string, unknown>) => null {
  const Inert = (_props: Record<string, unknown>): null => null;
  Object.defineProperty(Inert, "name", { value: name });
  return Inert;
}

/** A marker's callout (not drawn). */
export const Callout: (props: Record<string, unknown>) => null = /* @__PURE__ */ inert("Callout");
/** A view inside a callout (not drawn). */
export const CalloutSubview: (props: Record<string, unknown>) => null = /* @__PURE__ */ inert(
  "CalloutSubview",
);
/** A polyline (not drawn). */
export const Polyline: (props: Record<string, unknown>) => null = /* @__PURE__ */ inert(
  "Polyline",
);
/** A polygon (not drawn). */
export const Polygon: (props: Record<string, unknown>) => null = /* @__PURE__ */ inert("Polygon");
/** A circle (not drawn). */
export const Circle: (props: Record<string, unknown>) => null = /* @__PURE__ */ inert("Circle");
/** An image overlay (not drawn). */
export const Overlay: (props: Record<string, unknown>) => null = /* @__PURE__ */ inert("Overlay");
/** A heatmap (not drawn). */
export const Heatmap: (props: Record<string, unknown>) => null = /* @__PURE__ */ inert("Heatmap");
/** GeoJSON shapes (not drawn). */
export const Geojson: (props: Record<string, unknown>) => null = /* @__PURE__ */ inert("Geojson");
/** URL tiles (not drawn). */
export const UrlTile: (props: Record<string, unknown>) => null = /* @__PURE__ */ inert("UrlTile");
/** Local tiles (not drawn). */
export const LocalTile: (props: Record<string, unknown>) => null = /* @__PURE__ */ inert(
  "LocalTile",
);
/** WMS tiles (not drawn). */
export const WMSTile: (props: Record<string, unknown>) => null = /* @__PURE__ */ inert("WMSTile");

/** The markers among a map's children (direct, or in fragments and arrays). */
function collectMarkers(children: unknown, out: MarkerProps[] = []): MarkerProps[] {
  if (Array.isArray(children)) {
    for (const child of children) collectMarkers(child, out);
    return out;
  }
  const node = children as VNode | null;
  if (!node || typeof node !== "object" || !("type" in node)) return out;
  if ((node.type as unknown) === Marker) out.push(node.props as unknown as MarkerProps);
  else if (node.type === Fragment) collectMarkers(node.props.children, out);
  return out;
}

/** The native markers of the collected ones. */
function nativeMarkers(markers: readonly MarkerProps[]): NativeMapMarker[] {
  const out: NativeMapMarker[] = [];
  for (const m of markers) {
    const { latitude, longitude } = m.coordinate ?? {};
    if (typeof latitude !== "number" || typeof longitude !== "number") continue;
    out.push({ latitude, longitude, ...(m.title ? { title: m.title } : {}) });
  }
  return out;
}

/** The region framing `coordinates` (with a margin). */
function regionAround(coordinates: readonly LatLng[]): Region | null {
  if (coordinates.length === 0) return null;
  const lats = coordinates.map((c) => c.latitude);
  const lons = coordinates.map((c) => c.longitude);
  const [minLat, maxLat, minLon, maxLon] = [
    Math.min(...lats),
    Math.max(...lats),
    Math.min(...lons),
    Math.max(...lons),
  ];
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta: Math.max(0.005, (maxLat - minLat) * 1.2),
    longitudeDelta: Math.max(0.005, (maxLon - minLon) * 1.2),
  };
}

/** The shared state the ref methods read. */
interface MapState {
  command: NativeMapCommand;
  region: Region | null;
  markers: MarkerProps[];
}

/** A `<MapView>` ref over the native map. */
function mapRef(state: { current: MapState }): MapViewRef {
  const move = (region: Region | null, animated = true) => {
    if (region) {
      setNativeMapRegion(state.current.command, toNative(region), animated).catch(() => {});
    }
  };
  const cameraRegion = (camera: Partial<Camera>): Region | null => {
    const center = camera.center ?? state.current.region;
    if (!center) return null;
    const delta = camera.zoom !== undefined
      ? deltaForZoom(camera.zoom)
      : state.current.region?.longitudeDelta ?? deltaForZoom(12);
    return {
      latitude: center.latitude,
      longitude: center.longitude,
      latitudeDelta: delta,
      longitudeDelta: delta,
    };
  };
  const camera = (): Camera => {
    const r = state.current.region;
    const center = r
      ? { latitude: r.latitude, longitude: r.longitude }
      : { latitude: 0, longitude: 0 };
    return { center, zoom: r ? zoomForDelta(r.longitudeDelta) : 0, heading: 0, pitch: 0 };
  };
  return {
    animateToRegion: (region) => move(region),
    animateCamera: (c) => move(cameraRegion(c)),
    setCamera: (c) => move(cameraRegion(c), false),
    fitToCoordinates: (coordinates, options) => move(regionAround(coordinates), options?.animated),
    fitToElements: (options) =>
      move(regionAround(state.current.markers.map((m) => m.coordinate)), options?.animated),
    getCamera: () => Promise.resolve(camera()),
    getMapBoundaries() {
      const r = state.current.region;
      if (!r) return Promise.reject(new Error("react-native-maps: the region is not known yet"));
      return Promise.resolve({
        northEast: {
          latitude: r.latitude + r.latitudeDelta / 2,
          longitude: r.longitude + r.longitudeDelta / 2,
        },
        southWest: {
          latitude: r.latitude - r.latitudeDelta / 2,
          longitude: r.longitude - r.longitudeDelta / 2,
        },
      });
    },
  };
}

/**
 * A map: the native `"map"` view, else a placeholder.
 *
 * @param props The camera, markers, events and style.
 * @returns The view.
 */
export function MapView(props: MapViewProps): VNode {
  const [initial] = useState(() => props.initialRegion ?? null);
  const markers = collectMarkers(props.children);
  const state = useRef<MapState>({ command: null, region: props.region ?? initial, markers });
  state.current.markers = markers;
  if (props.region) state.current.region = props.region;
  const latest = useRef(props);
  latest.current = props;
  useImperativeHandle(props.ref as never, () => mapRef(state), []);
  const camera = props.region ?? initial;
  return h(NativeMap, {
    region: camera ? toNative(camera) : undefined,
    markers: nativeMarkers(markers),
    mapType: props.mapType === "satellite" || props.mapType === "hybrid"
      ? props.mapType
      : "standard",
    interactive: props.scrollEnabled !== false || props.zoomEnabled !== false,
    style: props.style,
    onRegionChange(r: NativeMapRegion) {
      const region = fromNative(r);
      state.current.region = region;
      latest.current.onRegionChange?.(region, { isGesture: true });
      latest.current.onRegionChangeComplete?.(region, { isGesture: true });
    },
    onMarkerPress(index: number) {
      const marker = state.current.markers[index];
      if (!marker) return;
      const event = { nativeEvent: { coordinate: marker.coordinate, id: marker.identifier } };
      marker.onPress?.(event);
      latest.current.onMarkerPress?.(event);
    },
    onCommand(command: NativeMapCommand) {
      state.current.command = command;
      if (command) latest.current.onMapReady?.();
    },
  });
}

/** The package's default export: {@linkcode MapView}. */
export default MapView;
