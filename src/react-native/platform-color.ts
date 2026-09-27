/**
 * React Native's `PlatformColor` and `DynamicColorIOS` for React Native mode: the iOS and
 * Android system colours a React Native app names, as CSS colours. react-native-web has
 * neither, so an import of them was a build error.
 *
 * @module
 */

/** A light / dark pair, as `DynamicColorIOS` takes it. */
export interface DynamicColorIOSTuple {
  /** The colour in light mode. */
  light: string;
  /** The colour in dark mode. */
  dark: string;
  /** The colour in light mode with Increase Contrast on (`prefers-contrast: more`). */
  highContrastLight?: string;
  /** The colour in dark mode with Increase Contrast on. */
  highContrastDark?: string;
}

/** A system colour: one value, or a light / dark pair. */
type SystemColor = string | readonly [light: string, dark: string];

/** iOS's semantic and system colours (UIKit's values, light then dark). */
const IOS_COLORS: Readonly<Record<string, SystemColor>> = {
  label: ["#000000", "#ffffff"],
  secondaryLabel: ["rgba(60,60,67,0.6)", "rgba(235,235,245,0.6)"],
  tertiaryLabel: ["rgba(60,60,67,0.3)", "rgba(235,235,245,0.3)"],
  quaternaryLabel: ["rgba(60,60,67,0.18)", "rgba(235,235,245,0.16)"],
  placeholderText: ["rgba(60,60,67,0.3)", "rgba(235,235,245,0.3)"],
  link: ["#007aff", "#0984ff"],
  separator: ["rgba(60,60,67,0.29)", "rgba(84,84,88,0.6)"],
  opaqueSeparator: ["#c6c6c8", "#38383a"],
  systemBackground: ["#ffffff", "#000000"],
  secondarySystemBackground: ["#f2f2f7", "#1c1c1e"],
  tertiarySystemBackground: ["#ffffff", "#2c2c2e"],
  systemGroupedBackground: ["#f2f2f7", "#000000"],
  secondarySystemGroupedBackground: ["#ffffff", "#1c1c1e"],
  tertiarySystemGroupedBackground: ["#f2f2f7", "#2c2c2e"],
  systemFill: ["rgba(120,120,128,0.2)", "rgba(120,120,128,0.36)"],
  secondarySystemFill: ["rgba(120,120,128,0.16)", "rgba(120,120,128,0.32)"],
  tertiarySystemFill: ["rgba(118,118,128,0.12)", "rgba(118,118,128,0.24)"],
  quaternarySystemFill: ["rgba(116,116,128,0.08)", "rgba(118,118,128,0.18)"],
  systemBlue: ["#007aff", "#0a84ff"],
  systemBrown: ["#a2845e", "#ac8e68"],
  systemCyan: ["#32ade6", "#64d2ff"],
  systemGreen: ["#34c759", "#30d158"],
  systemIndigo: ["#5856d6", "#5e5ce6"],
  systemMint: ["#00c7be", "#63e6e2"],
  systemOrange: ["#ff9500", "#ff9f0a"],
  systemPink: ["#ff2d55", "#ff375f"],
  systemPurple: ["#af52de", "#bf5af2"],
  systemRed: ["#ff3b30", "#ff453a"],
  systemTeal: ["#30b0c7", "#40c8e0"],
  systemYellow: ["#ffcc00", "#ffd60a"],
  systemGray: ["#8e8e93", "#8e8e93"],
  systemGray2: ["#aeaeb2", "#636366"],
  systemGray3: ["#c7c7cc", "#48484a"],
  systemGray4: ["#d1d1d6", "#3a3a3c"],
  systemGray5: ["#e5e5ea", "#2c2c2e"],
  systemGray6: ["#f2f2f7", "#1c1c1e"],
  lightText: "rgba(255,255,255,0.6)",
  darkText: "#000000",
};

/** macOS' semantic `NSColor` names (`react-native-macos`), light then dark. */
const MACOS_COLORS: Readonly<Record<string, SystemColor>> = {
  labelColor: ["rgba(0,0,0,0.85)", "rgba(255,255,255,0.85)"],
  secondaryLabelColor: ["rgba(0,0,0,0.5)", "rgba(255,255,255,0.55)"],
  tertiaryLabelColor: ["rgba(0,0,0,0.26)", "rgba(255,255,255,0.25)"],
  quaternaryLabelColor: ["rgba(0,0,0,0.1)", "rgba(255,255,255,0.1)"],
  textColor: ["#000000", "#ffffff"],
  placeholderTextColor: ["rgba(0,0,0,0.25)", "rgba(255,255,255,0.25)"],
  textBackgroundColor: ["#ffffff", "#1e1e1e"],
  windowBackgroundColor: ["#ececec", "#323232"],
  underPageBackgroundColor: ["#969696", "#282828"],
  controlBackgroundColor: ["#ffffff", "#1e1e1e"],
  controlColor: ["#ffffff", "rgba(255,255,255,0.25)"],
  controlTextColor: ["rgba(0,0,0,0.85)", "rgba(255,255,255,0.85)"],
  disabledControlTextColor: ["rgba(0,0,0,0.25)", "rgba(255,255,255,0.25)"],
  controlAccentColor: ["#007aff", "#0a84ff"],
  keyboardFocusIndicatorColor: ["rgba(0,103,244,0.5)", "rgba(26,169,255,0.3)"],
  selectedContentBackgroundColor: ["#0063e1", "#0058d0"],
  unemphasizedSelectedContentBackgroundColor: ["#dcdcdc", "#464646"],
  selectedTextBackgroundColor: ["#b3d7ff", "#3f638b"],
  separatorColor: ["rgba(0,0,0,0.1)", "rgba(255,255,255,0.1)"],
  gridColor: ["#e6e6e6", "#1a1a1a"],
  linkColor: ["#0068da", "#419cff"],
  findHighlightColor: "#ffff00",
  systemBlueColor: ["#007aff", "#0a84ff"],
  systemBrownColor: ["#a2845e", "#ac8e68"],
  systemGrayColor: ["#8e8e93", "#98989d"],
  systemGreenColor: ["#28cd41", "#32d74b"],
  systemIndigoColor: ["#5856d6", "#5e5ce6"],
  systemOrangeColor: ["#ff9500", "#ff9f0a"],
  systemPinkColor: ["#ff2d55", "#ff375f"],
  systemPurpleColor: ["#af52de", "#bf5af2"],
  systemRedColor: ["#ff3b30", "#ff453a"],
  systemTealColor: ["#55bef0", "#5ac8f5"],
  systemYellowColor: ["#ffcc00", "#ffd60a"],
};

/**
 * Windows' `PlatformColor` names (`react-native-windows`: the `SystemColor*` resources, which
 * CSS system colors mirror, and the accent color), light then dark.
 */
const WINDOWS_COLORS: Readonly<Record<string, SystemColor>> = {
  SystemColorWindowColor: "Canvas",
  SystemColorWindowTextColor: "CanvasText",
  SystemColorButtonFaceColor: "ButtonFace",
  SystemColorButtonTextColor: "ButtonText",
  SystemColorGrayTextColor: "GrayText",
  SystemColorHighlightColor: "Highlight",
  SystemColorHighlightTextColor: "HighlightText",
  SystemColorHotlightColor: "LinkText",
  SystemAccentColor: ["#0078d4", "#4cc2ff"],
  SystemAccentColorLight1: ["#429ce3", "#99ebff"],
  SystemAccentColorDark1: ["#005a9e", "#0078d4"],
  SystemChromeMediumLowColor: ["#f2f2f2", "#2b2b2b"],
  SystemListLowColor: ["rgba(0,0,0,0.1)", "rgba(255,255,255,0.1)"],
  SystemBaseHighColor: ["#000000", "#ffffff"],
  SystemAltHighColor: ["#ffffff", "#000000"],
  TextFillColorPrimary: ["rgba(0,0,0,0.9)", "#ffffff"],
  TextFillColorSecondary: ["rgba(0,0,0,0.6)", "rgba(255,255,255,0.79)"],
  SolidBackgroundFillColorBase: ["#f3f3f3", "#202020"],
};

/** Android's `@android:color/*` resources. */
const ANDROID_COLORS: Readonly<Record<string, SystemColor>> = {
  white: "#ffffff",
  black: "#000000",
  transparent: "transparent",
  darker_gray: "#aaaaaa",
  background_dark: "#000000",
  background_light: "#ffffff",
  holo_blue_bright: "#00ddff",
  holo_blue_dark: "#0099cc",
  holo_blue_light: "#33b5e5",
  holo_green_dark: "#669900",
  holo_green_light: "#99cc00",
  holo_orange_dark: "#ff8800",
  holo_orange_light: "#ffbb33",
  holo_purple: "#aa66cc",
  holo_red_dark: "#cc0000",
  holo_red_light: "#ff4444",
};

/** Android's theme attributes (`?android:attr/*`, `?attr/*`), as Material 3's baseline theme. */
const ANDROID_ATTRS: Readonly<Record<string, SystemColor>> = {
  textColor: ["#1d1b20", "#e6e0e9"],
  textColorPrimary: ["#1d1b20", "#e6e0e9"],
  textColorSecondary: ["#49454f", "#cac4d0"],
  textColorTertiary: ["#79747e", "#938f99"],
  textColorHint: ["#79747e", "#938f99"],
  textColorLink: ["#6750a4", "#d0bcff"],
  colorBackground: ["#fef7ff", "#141218"],
  windowBackground: ["#fef7ff", "#141218"],
  colorPrimary: ["#6750a4", "#d0bcff"],
  colorPrimaryDark: ["#4f378b", "#381e72"],
  colorAccent: ["#6750a4", "#d0bcff"],
  colorControlNormal: ["#49454f", "#cac4d0"],
  colorControlActivated: ["#6750a4", "#d0bcff"],
  colorControlHighlight: ["rgba(29,27,32,0.12)", "rgba(230,224,233,0.12)"],
  colorError: ["#b3261e", "#f2b8b5"],
};

/** The system colour `name` names (iOS, `@android:color/…` or `?android:attr/…`), if known. */
function systemColor(name: string): SystemColor | undefined {
  const android = /^@android:color\/(\w+)$/.exec(name);
  if (android) return ANDROID_COLORS[android[1]];
  const attr = /^\?(?:android:)?attr\/(\w+)$/.exec(name);
  if (attr) return ANDROID_ATTRS[attr[1]];
  for (const table of [IOS_COLORS, MACOS_COLORS, WINDOWS_COLORS]) {
    if (Object.hasOwn(table, name)) return table[name];
  }
  return undefined;
}

/** `matchMedia(query).matches`, or false where it cannot be evaluated. */
function matches(query: string): boolean {
  const match = (globalThis as { matchMedia?: (q: string) => { matches?: boolean } }).matchMedia;
  return typeof match === "function" && match(query)?.matches === true;
}

/** The slice of `document` the scheme reads. */
interface SchemeDocument {
  documentElement?: { style?: { colorScheme?: string } } | null;
}

/**
 * The colour scheme now: an `Appearance.setColorScheme` override (React Native mode sets the
 * root's `color-scheme`), else the system's.
 */
function currentScheme(): "light" | "dark" {
  const doc = (globalThis as { document?: SchemeDocument }).document;
  const forced = doc?.documentElement?.style?.colorScheme;
  if (forced === "light" || forced === "dark") return forced;
  return matches("(prefers-color-scheme: dark)") ? "dark" : "light";
}

/**
 * Whether `light-dark()` would switch here: the browser supports it and the root's computed
 * `color-scheme` lets the page be both light and dark. Without that, `light-dark()` always
 * resolves to its light value, so the caller picks the current scheme's value instead.
 */
function lightDarkSwitches(): boolean {
  const g = globalThis as {
    CSS?: { supports?: (property: string, value: string) => boolean };
    document?: { documentElement?: unknown };
    getComputedStyle?: (el: unknown) => { colorScheme?: string };
  };
  if (typeof g.CSS?.supports !== "function" || typeof g.getComputedStyle !== "function") {
    return false;
  }
  if (!g.CSS.supports("color", "light-dark(#000, #fff)") || !g.document?.documentElement) {
    return false;
  }
  const scheme = g.getComputedStyle(g.document.documentElement)?.colorScheme ?? "";
  return /\blight\b/.test(scheme) && /\bdark\b/.test(scheme);
}

/** `light` / `dark` as one CSS colour: `light-dark()` when it switches here, else the current one. */
function dynamic(light: string, dark: string): string {
  if (light === dark) return light;
  if (lightDarkSwitches()) return `light-dark(${light}, ${dark})`;
  return currentScheme() === "dark" ? dark : light;
}

/** Names already warned about, so each unknown name warns once. */
let warned: Set<string> | undefined;

/**
 * React Native's `PlatformColor(...names)`: the first of `names` that is a known system colour,
 * as a CSS colour string React Native mode's styles take.
 *
 * - iOS's semantic and system colours (`label`, `secondaryLabel`, `systemBackground`,
 *   `separator`, `link`, `systemBlue` … `systemGray6`, the fills, …) with UIKit's light and
 *   dark values;
 * - macOS' `NSColor` names (`labelColor`, `windowBackgroundColor`, `controlAccentColor`,
 *   `systemRedColor`, …) with AppKit's, and Windows' (`SystemAccentColor`, the
 *   `SystemColor*` high-contrast resources as CSS system colors, `TextFillColorPrimary`, …),
 *   for `react-native-macos` / `react-native-windows` code;
 * - Android's `@android:color/*` resources (`white`, `black`, `holo_*`, …) and theme attributes
 *   (`?android:attr/textColorPrimary`, `?attr/colorAccent`, `colorBackground`, …) with
 *   Material 3's baseline values.
 *
 * A light / dark colour is `light-dark(light, dark)` when the page lets the browser switch
 * (the root's `color-scheme` is `light dark` and the browser supports `light-dark()`), so it
 * follows the system live; otherwise it is the value for the scheme in effect when called (an
 * `Appearance.setColorScheme` override, else `prefers-color-scheme`). Declare
 * `:root { color-scheme: light dark }` in the page for live switching. A name it does not know
 * is skipped (warned once in dev); when none is known it returns `undefined`, which leaves the
 * style property unset.
 *
 * @param names System colour names, the first known one wins (React Native's fallbacks).
 * @returns The CSS colour, or `undefined`.
 * @example
 * ```ts
 * import { PlatformColor, StyleSheet } from "react-native";
 *
 * const styles = StyleSheet.create({
 *   title: { color: PlatformColor("label", "?android:attr/textColorPrimary") },
 * });
 * ```
 */
export function PlatformColor(...names: string[]): string | undefined {
  for (const name of names) {
    const color = systemColor(String(name));
    if (color !== undefined) return typeof color === "string" ? color : dynamic(color[0], color[1]);
  }
  const g = globalThis as { __DEV__?: boolean };
  if (g.__DEV__ !== false && names.length > 0) {
    const key = names.join(",");
    if (!(warned ??= new Set()).has(key)) {
      warned.add(key);
      console.warn(`denext reactNative: PlatformColor(${key}) names no system colour it knows.`);
    }
  }
  return undefined;
}

/**
 * React Native's `DynamicColorIOS({ light, dark, highContrastLight?, highContrastDark? })`: one
 * CSS colour that is `light` in light mode and `dark` in dark mode (the high-contrast ones when
 * Increase Contrast is on, `prefers-contrast: more`). As {@linkcode PlatformColor}: a
 * `light-dark()` that follows the system when the page declares `color-scheme: light dark`,
 * else the value for the scheme in effect when called. It works on every platform React Native
 * mode runs on, not only iOS.
 *
 * @param tuple The colours.
 * @returns The CSS colour.
 * @example
 * ```ts
 * import { DynamicColorIOS } from "react-native";
 *
 * const border = DynamicColorIOS({ light: "#d1d1d6", dark: "#3a3a3c" });
 * ```
 */
export function DynamicColorIOS(tuple: DynamicColorIOSTuple): string {
  if (tuple === null || typeof tuple !== "object") {
    throw new TypeError("DynamicColorIOS: expected { light, dark }");
  }
  const contrast = matches("(prefers-contrast: more)");
  const light = String((contrast ? tuple.highContrastLight : undefined) ?? tuple.light);
  const dark = String((contrast ? tuple.highContrastDark : undefined) ?? tuple.dark);
  return dynamic(light, dark);
}
