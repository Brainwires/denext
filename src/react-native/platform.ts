/**
 * React Native's `Platform` for React Native mode. `Platform.OS` stays `"web"` everywhere,
 * including inside the Capacitor shell: react-native-web's own internals and the libraries a
 * React Native app pulls in branch on it to pick their DOM code paths (see the module docs on
 * {@linkcode Platform}). What the shell adds is best-effort `Version` and `isPad`, a
 * `Platform.select` that falls back to the shell's own `ios` / `android` key, and
 * `Platform.constants` (with `denextShell`, the runtime the page is in).
 *
 * @module
 */

import { nativePlatform, type RuntimePlatform, runtimePlatform } from "../mobile/bridge.ts";

/** What `Platform.select` picks from. */
export type PlatformSelectSpec<T> = {
  readonly web?: T;
  readonly default?: T;
  readonly ios?: T;
  readonly android?: T;
  readonly native?: T;
  readonly macos?: T;
  readonly windows?: T;
  readonly [platform: string]: T | undefined;
};

/** React Native's `Platform.constants.reactNativeVersion`. */
export interface ReactNativeVersion {
  /** The major version (0). */
  readonly major: number;
  /** The minor version. */
  readonly minor: number;
  /** The patch version. */
  readonly patch: number;
  /** The prerelease tag, or `null`. */
  readonly prerelease: string | null;
}

/**
 * `Platform.constants` in React Native mode: the fields React Native's iOS and Android
 * constants share, filled from the device where the shell tells, plus `denextShell`.
 */
export interface PlatformConstants {
  /** The React Native API level React Native mode implements (its parity target). */
  readonly reactNativeVersion: ReactNativeVersion;
  /** Whether `NODE_ENV` is `"test"`. */
  readonly isTesting: boolean;
  /** Whether the user asked for reduced motion (`prefers-reduced-motion: reduce`). */
  readonly isDisableAnimations: boolean;
  /**
   * The OS version: iOS's `"17.4"` in the iOS shell, Android's release (`"14"`) in the
   * Android shell, else `"0.0.0"`.
   */
  readonly osVersion: string;
  /** `"iOS"`, `"Android"`, or `"web"` (a browser or Deno Desktop). */
  readonly systemName: "iOS" | "Android" | "web";
  /** iOS's `interfaceIdiom`: `"pad"` on an iPad, `"phone"` on a phone, else `"unknown"`. */
  readonly interfaceIdiom: "phone" | "pad" | "unknown";
  /** Always `false` (a web view has no 3D Touch API). */
  readonly forceTouchAvailable: boolean;
  /** Android's API level in the Android shell (as `Platform.Version`), else `undefined`. */
  readonly Version?: number;
  /** Android's release (`"14"`) in the Android shell, else `undefined`. */
  readonly Release?: string;
  /**
   * The runtime the page runs in, as `denext/mobile`'s `runtimePlatform()` reports it: `"ios"`
   * or `"android"` inside the Capacitor shell, `"desktop"` inside Deno Desktop, else `"web"`.
   * `Platform.OS` is `"web"` in all four; this is how React Native code tells them apart.
   */
  readonly denextShell: RuntimePlatform;
  /** Whether the page runs in a Deno Desktop window (`denextShell === "desktop"`). */
  readonly denextDesktop: boolean;
  /**
   * In Deno Desktop, the host OS (`"macos"`, `"windows"` or `"linux"`) as the desktop runtime
   * reports it, else `undefined` (a runtime that does not report it too).
   */
  readonly os?: DesktopOS;
}

/** A Deno Desktop host OS, as {@linkcode PlatformConstants}'s `os` names it. */
export type DesktopOS = "macos" | "windows" | "linux";

/** React Native's `Platform` module, as React Native mode provides it. */
export interface PlatformStatic {
  /** Always `"web"`: the code runs on react-native-web, in a browser or the shell's WebView. */
  readonly OS: "web";
  /** The OS version inside the shell (iOS: `"17.4"`; Android: the API level), else `"0.0.0"`. */
  readonly Version: string | number;
  /** Whether the device is an iPad (the iOS shell, or iPadOS Safari). */
  readonly isPad: boolean;
  /** Always `false`. */
  readonly isTV: boolean;
  /** Whether `NODE_ENV` is `"test"`. */
  readonly isTesting: boolean;
  /**
   * Whether animations are off: React Native's `constants.isDisableAnimations ?? isTesting`;
   * the constant is always set here (the user's reduced-motion preference), so it decides.
   */
  readonly isDisableAnimations: boolean;
  /** The device's constants and `denextShell` (see {@linkcode PlatformConstants}). */
  readonly constants: PlatformConstants;
  /**
   * The value for this platform: `spec.web` when present; else, inside the iOS / Android
   * shell, `spec.ios` / `spec.android`; else `spec.default` (see {@linkcode Platform}).
   */
  select<T>(spec: PlatformSelectSpec<T>): T | undefined;
}

/** The React Native release React Native mode's surface is measured against. */
export const REACT_NATIVE_VERSION: ReactNativeVersion = {
  major: 0,
  minor: 86,
  patch: 3,
  prerelease: null,
};

/** Android release → API level, for `Platform.Version` in the Android shell. */
const ANDROID_API: Readonly<Record<string, number>> = {
  "16": 36,
  "15": 35,
  "14": 34,
  "13": 33,
  "12": 31,
  "11": 30,
  "10": 29,
  "9": 28,
  "8.1": 27,
  "8": 26,
  "7.1": 25,
  "7": 24,
  "6": 23,
};

/** `navigator.userAgent`, or `""`. */
function userAgent(): string {
  return (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "";
}

/** The Android API level for a user agent's `Android <release>`, when known. */
function androidApiLevel(ua: string): number | undefined {
  const release = /\bAndroid (\d+)(?:\.(\d+))?/.exec(ua);
  if (!release) return undefined;
  const [, major, minor] = release;
  return ANDROID_API[`${major}.${minor ?? "0"}`] ?? ANDROID_API[major];
}

/** The iOS version (`"17.4"`) of a user agent's `OS 17_4 like Mac OS X`, when present. */
function iosVersion(ua: string): string | undefined {
  const m = /\bOS (\d+(?:_\d+)*) like Mac OS X/.exec(ua);
  return m ? m[1].replaceAll("_", ".") : undefined;
}

/** Android's release (`"14"`, `"8.1"`) from a user agent's `Android <release>`, when present. */
function androidRelease(ua: string): string | undefined {
  return /\bAndroid (\d+(?:\.\d+)?)/.exec(ua)?.[1];
}

/** `Platform.Version`: the shell's OS version when the user agent says it, else `"0.0.0"`. */
function platformVersion(): string | number {
  const shell = nativePlatform();
  const ua = userAgent();
  if (shell === "ios") return iosVersion(ua) ?? "0.0.0";
  if (shell === "android") return androidApiLevel(ua) ?? "0.0.0";
  return "0.0.0";
}

/** Whether the device is an iPad: `iPad` in the user agent, or iPadOS's desktop-class one. */
function isIpad(): boolean {
  const ua = userAgent();
  if (/\biPad\b/.test(ua)) return true;
  const touch = (globalThis as { navigator?: { maxTouchPoints?: number } }).navigator
    ?.maxTouchPoints;
  return /\bMacintosh\b/.test(ua) && typeof touch === "number" && touch > 1;
}

/** Whether `process.env.NODE_ENV` is `"test"`, read defensively (no `process` in a browser). */
function isTestEnv(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.NODE_ENV === "test";
}

/**
 * The Deno Desktop host OS from the runtime's injected `globalThis.__denext.os` (normalized:
 * `darwin` / `mac` → `"macos"`, `win32` → `"windows"`), or undefined outside Deno Desktop or
 * when the runtime does not report it.
 */
function desktopOS(): DesktopOS | undefined {
  if (runtimePlatform() !== "desktop") return undefined;
  const raw = (globalThis as { __denext?: { os?: unknown } }).__denext?.os;
  if (typeof raw !== "string") return undefined;
  const os = raw.toLowerCase();
  if (os === "macos" || os === "darwin" || os === "mac" || os === "osx") return "macos";
  if (os === "windows" || os === "win32" || os === "win") return "windows";
  return os === "linux" ? "linux" : undefined;
}

/** Whether the user asked for reduced motion. */
function reducedMotion(): boolean {
  const match = (globalThis as { matchMedia?: (q: string) => { matches?: boolean } }).matchMedia;
  return typeof match === "function" &&
    match("(prefers-reduced-motion: reduce)")?.matches === true;
}

/** `Platform.constants`, read now. */
function platformConstants(): PlatformConstants {
  const shell = nativePlatform();
  const ua = userAgent();
  const base = {
    reactNativeVersion: REACT_NATIVE_VERSION,
    isTesting: isTestEnv(),
    isDisableAnimations: reducedMotion(),
    forceTouchAvailable: false,
    denextShell: runtimePlatform(),
    denextDesktop: runtimePlatform() === "desktop",
    ...(desktopOS() ? { os: desktopOS() } : {}),
  };
  if (shell === "ios") {
    return {
      ...base,
      osVersion: iosVersion(ua) ?? "0.0.0",
      systemName: "iOS",
      interfaceIdiom: isIpad() ? "pad" : "phone",
    };
  }
  if (shell === "android") {
    const release = androidRelease(ua);
    return {
      ...base,
      osVersion: release ?? "0.0.0",
      systemName: "Android",
      interfaceIdiom: "unknown",
      Version: androidApiLevel(ua),
      Release: release,
    };
  }
  return {
    ...base,
    osVersion: "0.0.0",
    systemName: "web",
    interfaceIdiom: isIpad() ? "pad" : "unknown",
  };
}

/**
 * `Platform.select`'s pick. `web` wins everywhere, as in react-native-web: code keyed on `web`
 * is the DOM path, and the shell is a DOM. Without a `web` key, the iOS / Android shell takes
 * its own `ios` / `android` key and Deno Desktop its host OS's `macos` / `windows` / `linux`
 * key (when the runtime reports the OS), then `default`; a browser takes `default`.
 * `native` is never picked: it names React Native's native renderer, which a web view lacks.
 */
function selectFor<T>(spec: PlatformSelectSpec<T>): T | undefined {
  if ("web" in spec) return spec.web;
  const shell = nativePlatform();
  if (shell !== "web" && shell in spec) return spec[shell];
  const os = desktopOS();
  if (os && os in spec) return spec[os];
  return spec.default;
}

/**
 * React Native's `Platform` in React Native mode.
 *
 * `OS` is `"web"` in a browser and inside the Capacitor shell alike. Reporting `"ios"` / `"android"` inside the
 * shell would send code down native-only paths that do not exist in a web view:
 * react-native-web itself reads `Platform.OS` to pick native modules (its vendored
 * `NativeAnimatedHelper` and `NativeEventEmitter` require a native module on `"ios"` /
 * `"android"`), and so do the libraries React Native apps depend on (Reanimated's `IS_WEB`,
 * Gesture Handler's `findNodeHandle`, `Platform.OS === "web"` guards around DOM code). Use
 * `Platform.constants.denextShell` (or `runtimePlatform()` from `denext/mobile`) to tell the
 * shell apart.
 *
 * `select(spec)` picks, in order:
 *
 * 1. `spec.web`, everywhere (as react-native-web does: `web` code is DOM code, and the shell is
 *    a DOM);
 * 2. inside the iOS / Android shell, the shell's own key, `spec.ios` / `spec.android` (as React
 *    Native on that device would), so `Platform.select({ ios: 44, android: 56 })` is not
 *    `undefined` in the shell; in Deno Desktop, the host OS's key, `spec.macos` /
 *    `spec.windows` / `spec.linux` (as `react-native-macos` / `-windows` would), when the
 *    runtime reports the OS (`Platform.constants.os`);
 * 3. `spec.default`.
 *
 * `spec.native` is never picked (it means React Native's native renderer), a browser picks
 * neither shell nor desktop keys, and Deno Desktop never picks `ios` / `android`.
 *
 * On top of react-native-web's `Platform`, inside the shell `Version` is the OS version read
 * from the user agent (iOS: a string like `"17.4"`; Android: the API level, a number), and
 * `isPad` is true on an iPad (also in iPadOS Safari).
 *
 * @example
 * ```ts
 * import { Platform } from "react-native";
 * import { runtimePlatform } from "denext/mobile";
 *
 * const pad = Platform.select({ web: 12, default: 16 });
 * // 44 in the iOS shell, 56 in the Android shell, undefined in a browser (no `default`).
 * const header = Platform.select({ ios: 44, android: 56 });
 * const inIosShell = Platform.constants.denextShell === "ios"; // or runtimePlatform() === "ios"
 * ```
 */
export const Platform: PlatformStatic = {
  OS: "web",
  get Version() {
    return platformVersion();
  },
  get isPad() {
    return isIpad();
  },
  isTV: false,
  get isTesting() {
    return isTestEnv();
  },
  get isDisableAnimations() {
    return reducedMotion();
  },
  get constants() {
    return platformConstants();
  },
  select<T>(spec: PlatformSelectSpec<T>): T | undefined {
    return selectFor(spec);
  },
};
