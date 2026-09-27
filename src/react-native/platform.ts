/**
 * React Native's `Platform` for React Native mode. `Platform.OS` stays `"web"` everywhere,
 * including inside the Capacitor shell: react-native-web's own internals and the libraries a
 * React Native app pulls in branch on it to pick their DOM code paths (see the module docs on
 * {@linkcode Platform}). What the shell adds is best-effort `Version` and `isPad`; ask
 * `denext/mobile`'s `runtimePlatform()` for the shell itself.
 *
 * @module
 */

import { nativePlatform } from "../mobile/bridge.ts";

/** What `Platform.select` picks from. */
export type PlatformSelectSpec<T> = {
  readonly web?: T;
  readonly default?: T;
  readonly ios?: T;
  readonly android?: T;
  readonly native?: T;
  readonly [platform: string]: T | undefined;
};

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
  /** `spec.web` when present, else `spec.default`, as react-native-web picks. */
  select<T>(spec: PlatformSelectSpec<T>): T | undefined;
}

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
 * React Native's `Platform` in React Native mode.
 *
 * `OS` is `"web"` in a browser and inside the Capacitor shell alike, and `select` picks `web`,
 * else `default`, exactly as react-native-web does. Reporting `"ios"` / `"android"` inside the
 * shell would send code down native-only paths that do not exist in a web view:
 * react-native-web itself reads `Platform.OS` to pick native modules (its vendored
 * `NativeAnimatedHelper` and `NativeEventEmitter` require a native module on `"ios"` /
 * `"android"`), and so do the libraries React Native apps depend on (Reanimated's `IS_WEB`,
 * Gesture Handler's `findNodeHandle`, `Platform.OS === "web"` guards around DOM code). Use
 * `runtimePlatform()` from `denext/mobile` to tell the shell apart.
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
 * const inIosShell = runtimePlatform() === "ios";
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
  select<T>(spec: PlatformSelectSpec<T>): T | undefined {
    return "web" in spec ? spec.web : spec.default;
  },
};
