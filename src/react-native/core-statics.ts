/**
 * React Native runtime values react-native-web does not have, for React Native mode's
 * `react-native` entry: `DeviceInfo`, `ReactNativeVersion`, `UTFSequence` and `VirtualViewMode`,
 * and the `LogBox` / `LayoutAnimation` members it lacks (`withLogBoxStatics`,
 * `withLayoutAnimationStatics`). Each matches React Native's JavaScript; where React Native
 * reads a native module, the web's equivalent is read instead.
 *
 * @module
 */

import { reactNativeFontScale } from "./font-scaling.ts";
import { REACT_NATIVE_VERSION } from "./platform.ts";

/** A display's metrics, as React Native's `DeviceInfo` reports them. */
export interface DisplayMetrics {
  /** Width in dp (CSS px). */
  readonly width: number;
  /** Height in dp (CSS px). */
  readonly height: number;
  /** Device pixels per dp. */
  readonly scale: number;
  /** The text size factor. */
  readonly fontScale: number;
}

/** What `DeviceInfo.getConstants()` returns. */
export interface DeviceInfoConstants {
  /** The window's and the screen's metrics. */
  readonly Dimensions: { readonly window: DisplayMetrics; readonly screen: DisplayMetrics };
  /** Always `false` (an iOS-only legacy flag). */
  readonly isIPhoneX_deprecated: boolean;
}

/** React Native's `DeviceInfo` (the native module behind `Dimensions`). */
export interface DeviceInfoStatic {
  /** The window's and screen's metrics now (what `Dimensions.get()` reads). */
  getConstants(): DeviceInfoConstants;
}

/**
 * React Native's `DeviceInfo`: `getConstants().Dimensions` holds the window's metrics (the
 * viewport) and the screen's (the display), each with `width`, `height`, `scale`
 * (`devicePixelRatio`) and `fontScale`, as react-native-web's `Dimensions` reads them.
 */
export const DeviceInfo: DeviceInfoStatic = {
  getConstants(): DeviceInfoConstants {
    const g = globalThis as {
      innerWidth?: number;
      innerHeight?: number;
      devicePixelRatio?: number;
      screen?: { width?: number; height?: number };
      document?: { documentElement?: { clientWidth?: number; clientHeight?: number } };
    };
    const root = g.document?.documentElement;
    const scale = g.devicePixelRatio || 1;
    const fontScale = reactNativeFontScale();
    const window = {
      width: root?.clientWidth ?? g.innerWidth ?? 0,
      height: root?.clientHeight ?? g.innerHeight ?? 0,
      scale,
      fontScale,
    };
    const screen = {
      width: g.screen?.width ?? window.width,
      height: g.screen?.height ?? window.height,
      scale,
      fontScale,
    };
    return { Dimensions: { window, screen }, isIPhoneX_deprecated: false };
  },
};

/**
 * React Native's `ReactNativeVersion`: the React Native release React Native mode's surface
 * matches (the version `Platform.constants.reactNativeVersion` reports).
 */
export class ReactNativeVersion {
  /** The major version. */
  static major: number = REACT_NATIVE_VERSION.major;
  /** The minor version. */
  static minor: number = REACT_NATIVE_VERSION.minor;
  /** The patch version. */
  static patch: number = REACT_NATIVE_VERSION.patch;
  /** The prerelease tag, or `null`. */
  static prerelease: string | null = REACT_NATIVE_VERSION.prerelease;

  /**
   * The version as text (`"0.86.3"`, or with `-<prerelease>`).
   *
   * @returns The version string.
   */
  static getVersionString(): string {
    const pre = this.prerelease != null ? `-${this.prerelease}` : "";
    return `${this.major}.${this.minor}.${this.patch}${pre}`;
  }
}

/** React Native's `UTFSequence` (deprecated in React Native: write the escapes directly). */
export const UTFSequence: Readonly<Record<string, string>> = Object.freeze({
  BOM: "\ufeff",
  BULLET: "\u2022",
  BULLET_SP: "\u00A0\u2022\u00A0",
  MIDDOT: "\u00B7",
  MIDDOT_SP: "\u00A0\u00B7\u00A0",
  MIDDOT_KATAKANA: "\u30FB",
  MDASH: "\u2014",
  MDASH_SP: "\u00A0\u2014\u00A0",
  NDASH: "\u2013",
  NDASH_SP: "\u00A0\u2013\u00A0",
  NEWLINE: "\u000A",
  NBSP: "\u00A0",
  PIZZA: "\uD83C\uDF55",
  TRIANGLE_LEFT: "\u25c0",
  TRIANGLE_RIGHT: "\u25b6",
});

/** A Flow enum's runtime methods (`flow-enums-runtime`'s). */
export interface FlowEnumMethods<V> {
  /** `value` when it is one of the enum's values, else `undefined`. */
  cast(value: unknown): V | undefined;
  /** Whether `value` is one of the enum's values. */
  isValid(value: unknown): value is V;
  /** The enum's values, in declaration order. */
  members(): IterableIterator<V>;
  /** The name of `value`'s member. */
  getName(value: V): string | undefined;
}

/**
 * A Flow enum object as React Native's code receives it (`flow-enums-runtime`): the members
 * as non-enumerable properties, `cast` / `isValid` / `members` / `getName` on its prototype.
 */
function flowEnum<M extends Record<string, number>>(
  members: M,
): Readonly<M> & FlowEnumMethods<M[keyof M]> {
  const reverse = new Map<unknown, string>(Object.entries(members).map(([k, v]) => [v, k]));
  const proto = Object.freeze(Object.defineProperties(Object.create(null), {
    isValid: { value: (x: unknown) => reverse.has(x) },
    cast: { value: (x: unknown) => reverse.has(x) ? x : undefined },
    members: { value: () => reverse.keys() },
    getName: { value: (x: unknown) => reverse.get(x) },
  }));
  const o = Object.create(proto);
  for (const [k, v] of Object.entries(members)) Object.defineProperty(o, k, { value: v });
  return Object.freeze(o);
}

/** React Native's `VirtualViewMode` (the modes a `VirtualView` reports), a Flow enum. */
export const VirtualViewMode:
  & Readonly<{ Visible: 0; Prerender: 1; Hidden: 2 }>
  & FlowEnumMethods<0 | 1 | 2> = /* @__PURE__ */ flowEnum({
    Visible: 0 as const,
    Prerender: 1 as const,
    Hidden: 2 as const,
  });

/**
 * react-native-web's `LogBox` with the members React Native's has: `isInstalled`,
 * `clearAllLogs`, `addLog`, `addConsoleLog` and `addException`. LogBox is React Native's
 * in-app log overlay, which the web does not have (errors reach the browser console and, in
 * development, denext's overlay), so they behave as React Native's production `LogBox` does:
 * `isInstalled()` is `false` and the rest do nothing. Members it already has are kept.
 *
 * @param LogBox react-native-web's `LogBox`.
 * @returns The same object.
 */
export function withLogBoxStatics<T extends object>(LogBox: T): T {
  const box = LogBox as Record<string, unknown>;
  const noop = (): void => {};
  box.isInstalled ??= () => false;
  box.clearAllLogs ??= noop;
  box.addLog ??= noop;
  box.addConsoleLog ??= noop;
  box.addException ??= noop;
  return LogBox;
}

/**
 * react-native-web's `LayoutAnimation` with React Native's `setEnabled(value)`. React Native's
 * own assigns its flag to itself (`isLayoutAnimationEnabled = isLayoutAnimationEnabled`), so
 * calling it changes nothing there; here too, and animations stay as configured.
 *
 * @param LayoutAnimation react-native-web's `LayoutAnimation`.
 * @returns The same object.
 */
export function withLayoutAnimationStatics<T extends object>(LayoutAnimation: T): T {
  const la = LayoutAnimation as Record<string, unknown>;
  la.setEnabled ??= (_value: boolean): void => {};
  return LayoutAnimation;
}
