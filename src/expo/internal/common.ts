/**
 * Helpers the `denext/expo/*` shims share: Expo's subscription and permission shapes, a
 * small event fan-out, the app-config global, and the host view the component shims render.
 * Internal: not a `denext/expo/*` entrypoint. Nothing here runs at import time.
 *
 * @module
 */

import { useCallback, useEffect, useState } from "../../runtime/hooks.ts";
import type { VNodeType } from "../../jsx/types.ts";
import * as RN from "./react-native.ts";

/** What Expo's `add…Listener` functions return. */
export interface Subscription {
  /** Stop listening. Calling it again does nothing. */
  remove(): void;
}

/** A {@linkcode Subscription} whose `remove` calls `stop` once. */
export function subscription(stop: () => void): Subscription {
  let removed = false;
  return {
    remove() {
      if (removed) return;
      removed = true;
      stop();
    },
  };
}

/**
 * The error a web stand-in for a native-only Expo class throws when constructed. Most (like
 * `CameraNativeModule` or `ExpoUpdatesModule`) are type declarations of what
 * `requireNativeModule` returns, not objects an app builds; the package's JS API is the way in.
 *
 * @param pkg The package (`"expo-camera"`).
 * @param name The class (`"CameraNativeModule"`).
 */
export function nativeOnly(pkg: string, name: string): Error {
  return new Error(
    `denext/expo: ${pkg}'s ${name} is native-only and unavailable on the web. ` +
      `Use ${pkg}'s JS API instead.`,
  );
}

/** A permission's state, as `expo-modules-core` reports it. */
export enum PermissionStatus {
  /** The user granted it. */
  GRANTED = "granted",
  /** Not asked yet. */
  UNDETERMINED = "undetermined",
  /** The user refused it. */
  DENIED = "denied",
}

/** When a permission expires: `"never"`, or a timestamp. */
export type PermissionExpiration = "never" | number;

/** A permission answer, as every Expo permission API returns it. */
export interface PermissionResponse {
  /** The state. */
  status: PermissionStatus;
  /** When it expires (always `"never"` here). */
  expires: PermissionExpiration;
  /** Whether `status` is `granted`. */
  granted: boolean;
  /** Whether asking again can still show a prompt. */
  canAskAgain: boolean;
}

/** Options for a permission hook ({@linkcode createPermissionHook}). */
export type PermissionHookOptions<Options extends object> = Options & {
  /** Read the permission on mount (default `true`). */
  get?: boolean;
  /** Request the permission on mount (default `false`). */
  request?: boolean;
};

/** A {@linkcode PermissionResponse} for `status`. */
export function permissionResponse(status: PermissionStatus): PermissionResponse {
  return {
    status,
    expires: "never",
    granted: status === PermissionStatus.GRANTED,
    canAskAgain: status !== PermissionStatus.DENIED,
  };
}

/** The Permissions API answer for `name` (`camera`, `microphone`, …), or `undetermined`. */
export async function webPermission(name: string): Promise<PermissionStatus> {
  const permissions = (globalThis as {
    navigator?: { permissions?: { query?: (d: { name: string }) => Promise<{ state: string }> } };
  }).navigator?.permissions;
  if (typeof permissions?.query !== "function") return PermissionStatus.UNDETERMINED;
  try {
    const { state } = await permissions.query({ name });
    if (state === "granted") return PermissionStatus.GRANTED;
    return state === "denied" ? PermissionStatus.DENIED : PermissionStatus.UNDETERMINED;
  } catch {
    return PermissionStatus.UNDETERMINED;
  }
}

/**
 * Ask for camera and/or microphone access the web way (`getUserMedia`, stopped at once), and
 * report the outcome.
 */
export async function requestMediaPermission(
  constraints: { video?: boolean; audio?: boolean },
): Promise<PermissionStatus> {
  const media = (globalThis as {
    navigator?: { mediaDevices?: { getUserMedia?: (c: unknown) => Promise<MediaStream> } };
  }).navigator?.mediaDevices;
  if (typeof media?.getUserMedia !== "function") return PermissionStatus.DENIED;
  try {
    const stream = await media.getUserMedia(constraints);
    for (const track of stream.getTracks()) track.stop();
    return PermissionStatus.GRANTED;
  } catch {
    return PermissionStatus.DENIED;
  }
}

/**
 * Expo's `createPermissionHook`: a hook returning `[response, request, get]` that reads (or,
 * with `request: true`, requests) the permission on mount.
 *
 * @param methods How to read and how to request the permission.
 * @returns The hook.
 */
export function createPermissionHook<P extends PermissionResponse, Options extends object>(
  methods: {
    getMethod: (options?: Options) => Promise<P>;
    requestMethod: (options?: Options) => Promise<P>;
  },
): (options?: PermissionHookOptions<Options>) => [P | null, () => Promise<P>, () => Promise<P>] {
  return function usePermission(options) {
    const [status, setStatus] = useState<P | null>(null);
    const request = useCallback(async () => {
      const next = await methods.requestMethod(options);
      setStatus(next);
      return next;
    }, []);
    const get = useCallback(async () => {
      const next = await methods.getMethod(options);
      setStatus(next);
      return next;
    }, []);
    useEffect(() => {
      if (options?.request === true) request().catch(() => {});
      else if (options?.get !== false) get().catch(() => {});
    }, []);
    return [status, request, get];
  };
}

/** A set of listeners, called in subscription order. */
export interface Emitter<T> {
  /** Call every listener with `value`; a throwing listener does not stop the others. */
  emit(value: T): void;
  /** Add `listener`; `onFirst` runs when the set goes from empty to one. */
  subscribe(listener: (value: T) => void): Subscription;
  /** How many listeners there are. */
  readonly size: number;
}

/**
 * A listener set. `start` runs when the first listener arrives and returns the stop that
 * runs when the last one leaves (a native listener shared by every subscriber).
 */
export function createEmitter<T>(start?: (emit: (value: T) => void) => () => void): Emitter<T> {
  const listeners = new Set<(value: T) => void>();
  let stop: (() => void) | undefined;
  const emit = (value: T) => {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  };
  return {
    emit,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1 && start) stop = start(emit);
      return subscription(() => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop?.();
          stop = undefined;
        }
      });
    },
    get size() {
      return listeners.size;
    },
  };
}

/**
 * The global an app sets to its Expo app config (`app.json`'s `expo` object) before the
 * bundle runs; `expo-constants`'s `expoConfig` and `expo-updates` read it.
 */
const EXPO_CONFIG_GLOBAL = "__DENEXT_EXPO_CONFIG__";

/** The Expo app config from {@linkcode EXPO_CONFIG_GLOBAL}, or null. */
export function expoConfigGlobal(): Record<string, unknown> | null {
  const value = (globalThis as Record<string, unknown>)[EXPO_CONFIG_GLOBAL];
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

/** The host a view-like shim renders: react-native-web's `View`, else a `<div>`. */
export function hostView(): VNodeType {
  return RN.View ?? "div";
}

/** Whether the shims render through react-native-web (React Native mode). */
export function hasReactNative(): boolean {
  return RN.View !== undefined;
}

/** A React Native style (object, array, falsy) merged into one object. */
export function flattenStyle(style: unknown): Record<string, unknown> {
  if (RN.StyleSheet) return { ...RN.StyleSheet.flatten(style) };
  const out: Record<string, unknown> = {};
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.assign(out, value);
  };
  visit(style);
  return out;
}

/** React Native's shorthand style keys, as the CSS properties they set. */
const SHORTHANDS: Readonly<Record<string, readonly string[]>> = {
  paddingHorizontal: ["paddingLeft", "paddingRight"],
  paddingVertical: ["paddingTop", "paddingBottom"],
  marginHorizontal: ["marginLeft", "marginRight"],
  marginVertical: ["marginTop", "marginBottom"],
};

/** A flattened React Native style as a DOM style: the shorthands expanded. */
function domStyle(style: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style)) {
    const targets = SHORTHANDS[key];
    if (targets) { for (const target of targets) out[target] = value; }
    else out[key] = value;
  }
  return out;
}

/** The DOM defaults a React Native `View` has. */
const VIEW_DEFAULTS: Readonly<Record<string, unknown>> = {
  display: "flex",
  flexDirection: "column",
  position: "relative",
  boxSizing: "border-box",
  minWidth: 0,
  minHeight: 0,
};

/**
 * The `style` prop for {@linkcode hostView}: `[base, style]` for react-native-web, else one
 * DOM style object with a `View`'s flex defaults, `base`, then `style`.
 */
export function viewStyle(style: unknown, base?: Record<string, unknown>): unknown {
  if (hasReactNative()) return base ? [base, style] : style;
  return domStyle({ ...VIEW_DEFAULTS, ...base, ...flattenStyle(style) });
}

/** The overlay colour of a tint, scaled by intensity. */
function tintColor(tint: string, alpha: number): string {
  if (/dark/i.test(tint)) return `rgba(25,25,25,${(alpha * 0.5).toFixed(3)})`;
  if (/light|extraLight/i.test(tint)) return `rgba(255,255,255,${(alpha * 0.6).toFixed(3)})`;
  return `rgba(255,255,255,${(alpha * 0.3).toFixed(3)})`;
}

/** The CSS a blur of `intensity` (0–100) with `tint` needs: a backdrop blur and a tint. */
export function blurStyle(intensity: number, tint: string): Record<string, string> {
  const clamped = Math.max(0, Math.min(100, intensity));
  const filter = `blur(${Math.round(clamped / 5)}px)`;
  return {
    backdropFilter: filter,
    WebkitBackdropFilter: filter,
    backgroundColor: tintColor(tint, clamped / 100),
  };
}
