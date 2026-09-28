/**
 * The map view the map shims share (`expo-maps`' `AppleMaps.View` / `GoogleMaps.View`,
 * `react-native-maps`' `MapView`): `denext/mobile`'s `"map"` native view slot (MapKit on iOS,
 * osmdroid on Android: `denext mobile add native-map`), with a labelled placeholder as the web
 * fallback wherever that view type is not registered natively (the web, a shell without the
 * plugin). Internal: not a `denext/expo/*` entrypoint. Nothing here runs at import time.
 *
 * @module
 */

import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../../jsx/types.ts";
import { useCallback, useRef } from "../../runtime/hooks.ts";
import { nativePlatform } from "../../mobile/bridge.ts";
import { NativeViewSlot, type NativeViewSlotHandle } from "../../mobile/native-view.ts";
import { flattenStyle, hostView, viewStyle } from "./common.ts";

/** A marker, as the native `"map"` view takes it. */
export interface NativeMapMarker {
  /** Latitude. */
  readonly latitude: number;
  /** Longitude. */
  readonly longitude: number;
  /** The callout title. */
  readonly title?: string;
}

/** Where the native map looks: its center and web-map zoom level (0–20). */
export interface NativeMapRegion {
  /** The center's latitude. */
  readonly latitude: number;
  /** The center's longitude. */
  readonly longitude: number;
  /** The zoom level. */
  readonly zoom: number;
}

/** The native map's command runner, or null while there is no native view. */
export type NativeMapCommand = NativeViewSlotHandle["command"] | null;

/** Props of {@linkcode NativeMap}. */
export interface NativeMapProps {
  /** The camera, or undefined to leave it where it is. */
  readonly region?: Partial<NativeMapRegion>;
  /** The markers. */
  readonly markers?: readonly NativeMapMarker[];
  /** `"standard"`, `"satellite"` or `"hybrid"`. */
  readonly mapType?: string;
  /** Whether it pans and zooms (default `true`). */
  readonly interactive?: boolean;
  /** The React Native style of the view. */
  readonly style?: unknown;
  /** The camera moved (a pan, a zoom). */
  readonly onRegionChange?: (region: NativeMapRegion) => void;
  /** A marker was tapped. */
  readonly onMarkerPress?: (index: number, title: string) => void;
  /** Receives the command runner once the view is native, and null when it is gone. */
  readonly onCommand?: (command: NativeMapCommand) => void;
  /** DOM drawn over the map (callouts, buttons). */
  readonly overlay?: VNodeChildren;
  /** The accessible name of the placeholder. */
  readonly label?: string;
  /** Called when the placeholder renders outside a native shell (to warn once). */
  readonly onPlaceholder?: () => void;
}

/** A finite number, or undefined. */
function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The native props for `props` (only what is set, so nothing moves the camera by accident). */
function nativeProps(props: NativeMapProps): Record<string, unknown> {
  const out: Record<string, unknown> = {
    markers: (props.markers ?? []).map((m) => ({ ...m })),
    interactive: props.interactive !== false,
  };
  if (props.mapType) out.mapType = props.mapType;
  const lat = finite(props.region?.latitude);
  const lon = finite(props.region?.longitude);
  if (lat !== undefined && lon !== undefined) {
    out.latitude = lat;
    out.longitude = lon;
    out.zoom = finite(props.region?.zoom) ?? 12;
  }
  return out;
}

/** A native event's region, or null when it is not one. */
function eventRegion(data: unknown): NativeMapRegion | null {
  const d = data as Record<string, unknown> | null;
  const latitude = finite(d?.latitude);
  const longitude = finite(d?.longitude);
  const zoom = finite(d?.zoom);
  return latitude === undefined || longitude === undefined || zoom === undefined
    ? null
    : { latitude, longitude, zoom };
}

/** The web fallback: a grey box of the view's size saying the map is unavailable. */
function MapPlaceholder(props: { label: string; onPlaceholder?: () => void }): VNode {
  const { label } = props;
  if (nativePlatform() === "web") props.onPlaceholder?.();
  return h(
    hostView(),
    {
      accessibilityLabel: label,
      "aria-label": label,
      style: viewStyle(undefined, {
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#e5e7eb",
        flex: 1,
        minHeight: 120,
      }),
    },
    h("span", { style: { color: "#4b5563", fontSize: 13, padding: 8 } }, label),
  );
}

/**
 * A map: the native `"map"` view where it is registered, else a placeholder.
 *
 * @param props The camera, markers, events and style.
 * @returns The view.
 */
export function NativeMap(props: NativeMapProps): VNode {
  const latest = useRef(props);
  latest.current = props;
  const onEvent = useCallback((name: string, data: unknown) => {
    const p = latest.current;
    if (name === "regionChange") {
      const region = eventRegion(data);
      if (region) p.onRegionChange?.(region);
    } else if (name === "markerPress") {
      const d = data as { index?: unknown; title?: unknown } | null;
      if (typeof d?.index === "number") p.onMarkerPress?.(d.index, String(d.title ?? ""));
    }
  }, []);
  const onCommand = useCallback((command: NativeMapCommand) => {
    latest.current.onCommand?.(command);
  }, []);
  const style = flattenStyle(props.style) as Record<string, string | number | undefined>;
  return h(NativeViewSlot, {
    type: "map",
    props: nativeProps(props),
    onEvent,
    onCommand,
    overlay: props.overlay,
    style: { display: "flex", flexDirection: "column", minHeight: 120, ...style },
    children: h(MapPlaceholder, {
      label: props.label ?? "Map unavailable",
      onPlaceholder: props.onPlaceholder,
    }),
  });
}

/**
 * Move a native map's camera (the `"map"` view's `setRegion` command); rejects while the map is
 * the placeholder.
 *
 * @param command The runner {@linkcode NativeMap} handed out, or null.
 * @param region Where to look.
 * @param animated Whether the move animates (default `true`).
 * @returns Settles once the native view has moved.
 */
export function setNativeMapRegion(
  command: NativeMapCommand,
  region: NativeMapRegion,
  animated = true,
): Promise<unknown> {
  if (!command) {
    return Promise.reject(
      new Error("denext: the map is not a native view here (`denext mobile add native-map`)."),
    );
  }
  return command("setRegion", { ...region, animated });
}
