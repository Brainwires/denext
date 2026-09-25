/**
 * `expo-constants` for denext: a `Constants` object whose `expoConfig` is the app's Expo
 * config, read from `globalThis.__DENEXT_EXPO_CONFIG__`.
 *
 * Set that global (the `expo` object of `app.json` / `app.config.ts`) before the bundle
 * runs, for example with an inline script in `spa.head`, or define it at build time. Without
 * it `expoConfig` is null. Every field is read when accessed, so a late assignment still
 * shows. `platform` reports `ios`/`android` inside the Capacitor shell and `web` elsewhere;
 * `appOwnership` is null and `executionEnvironment` is `standalone`, as for a standalone
 * Expo build.
 *
 * @example
 * ```ts
 * import Constants from "denext/expo/constants";
 *
 * const variant = Constants.expoConfig?.extra?.appVariant;
 * ```
 *
 * @module
 */

import { nativePlatform } from "../mobile/bridge.ts";
import { expoConfigGlobal } from "./internal/common.ts";

/** Who owns the running app (`expo` only inside Expo Go; null here). */
export enum AppOwnership {
  /** Expo Go. */
  Expo = "expo",
}

/** How the app is running. */
export enum ExecutionEnvironment {
  /** A bare React Native app. */
  Bare = "bare",
  /** A standalone build (what denext reports). */
  Standalone = "standalone",
  /** Expo Go. */
  StoreClient = "storeClient",
}

/** The iOS interface idiom. */
export enum UserInterfaceIdiom {
  /** A phone. */
  Handset = "handset",
  /** A tablet. */
  Tablet = "tablet",
  /** A desktop. */
  Desktop = "desktop",
  /** A TV. */
  TV = "tv",
  /** Unsupported. */
  Unsupported = "unsupported",
}

/** Per-platform facts (`Constants.platform`). */
export interface PlatformManifest {
  /** iOS facts, inside the iOS shell. */
  ios?: Record<string, unknown>;
  /** Android facts, inside the Android shell. */
  android?: Record<string, unknown>;
  /** Web facts (the user agent), elsewhere. */
  web?: Record<string, unknown>;
  /** The app's URL scheme. */
  scheme?: string;
  /** Other fields. */
  [key: string]: unknown;
}

/** The `Constants` object's shape. */
export interface Constants {
  /** Who owns the app: null (not Expo Go). */
  readonly appOwnership: AppOwnership | null;
  /** Whether this is a dev build. */
  readonly debugMode: boolean;
  /** The device name (not known to a web view). */
  readonly deviceName?: string;
  /** The device year class: null. */
  readonly deviceYearClass: number | null;
  /** `standalone`. */
  readonly executionEnvironment: ExecutionEnvironment;
  /** The page's URL. */
  readonly experienceUrl: string;
  /** The Expo runtime version: null. */
  readonly expoRuntimeVersion: string | null;
  /** The Expo client version: null. */
  readonly expoVersion: string | null;
  /** Whether the app is headless: `false`. */
  readonly isHeadless: boolean;
  /** The linking URI: the page's origin plus `/`. */
  readonly linkingUri: string;
  /** The embedded manifest: null. */
  readonly manifest: null;
  /** The EAS Update manifest: null. */
  readonly manifest2: null;
  /** The app's Expo config from `globalThis.__DENEXT_EXPO_CONFIG__`, or null. */
  readonly expoConfig: Record<string, unknown> | null;
  /** The Expo Go config: null. */
  readonly expoGoConfig: null;
  /** The EAS config (`expoConfig.extra.eas`), or null. */
  readonly easConfig: Record<string, unknown> | null;
  /** A per-page-load session id. */
  readonly sessionId: string;
  /** The status bar height (not known to a web view): 0. */
  readonly statusBarHeight: number;
  /** The system fonts: none listed. */
  readonly systemFonts: string[];
  /** Per-platform facts. */
  readonly platform: PlatformManifest;
  /** The web view's user agent. */
  getWebViewUserAgentAsync(): Promise<string | null>;
}

/** The page's user agent, or null (SSR). */
function userAgent(): string | null {
  return (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? null;
}

/** The page's origin plus `/`, or `""` (SSR). */
function pageRoot(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  return origin ? `${origin}/` : "";
}

let session: string | undefined;

/** The Expo constants, read when accessed. */
const constants: Constants = {
  appOwnership: null,
  get debugMode() {
    return (globalThis as { __DEV__?: unknown }).__DEV__ === true;
  },
  deviceYearClass: null,
  executionEnvironment: ExecutionEnvironment.Standalone,
  get experienceUrl() {
    return pageRoot();
  },
  expoRuntimeVersion: null,
  expoVersion: null,
  isHeadless: false,
  get linkingUri() {
    return pageRoot();
  },
  manifest: null,
  manifest2: null,
  get expoConfig() {
    return expoConfigGlobal();
  },
  expoGoConfig: null,
  get easConfig() {
    const extra = expoConfigGlobal()?.extra as { eas?: Record<string, unknown> } | undefined;
    return extra?.eas ?? null;
  },
  get sessionId() {
    return session ??= crypto.randomUUID();
  },
  statusBarHeight: 0,
  systemFonts: [],
  get platform() {
    const platform = nativePlatform();
    const scheme = expoConfigGlobal()?.scheme;
    const facts: PlatformManifest = typeof scheme === "string" ? { scheme } : {};
    facts[platform] = platform === "web" ? { ua: userAgent() } : {};
    return facts;
  },
  getWebViewUserAgentAsync() {
    return Promise.resolve(userAgent());
  },
};

/** The Expo constants (`import Constants from "expo-constants"`). */
export default constants;
