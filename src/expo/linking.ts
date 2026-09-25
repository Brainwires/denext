/**
 * `expo-linking` for denext: app links over `denext/mobile`'s deep links
 * ({@linkcode onDeepLink}: the `@capacitor/app` `appUrlOpen` event in the Capacitor shell)
 * and {@linkcode openExternal}.
 *
 * `createURL` builds a `<scheme>://…` link inside the native shell (the scheme comes from the
 * `scheme` option or the Expo config's `scheme`, see `denext/expo/constants`) and a URL on
 * the page's origin on the web, as Expo's web build does. `openSettings` and `sendIntent`
 * are not available to a web view and reject.
 *
 * @example
 * ```ts
 * import * as Linking from "denext/expo/linking";
 *
 * const redirect = Linking.createURL("auth/callback", { queryParams: { from: "app" } });
 * const sub = Linking.addEventListener("url", ({ url }) => console.log(url));
 * ```
 *
 * @module
 */

import { useEffect, useState } from "../runtime/hooks.ts";
import { nativePlatform, openExternal } from "../mobile/bridge.ts";
import { onDeepLink } from "../mobile/deep-link.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import { expoConfigGlobal, type Subscription, subscription } from "./internal/common.ts";

export type { Subscription };

/** A URL's query parameters. */
export type QueryParams = Record<string, undefined | string | string[]>;

/** A URL split into its parts. */
export interface ParsedURL {
  /** The scheme without `:`, or null. */
  scheme: string | null;
  /** The host, or null. */
  hostname: string | null;
  /** The path without the leading `/`, or null. */
  path: string | null;
  /** The query parameters, or null. */
  queryParams: QueryParams | null;
}

/** Options for {@linkcode createURL}. */
export interface CreateURLOptions {
  /** The URL scheme (default: the Expo config's `scheme`). */
  scheme?: string;
  /** Query parameters to add. */
  queryParams?: QueryParams;
  /** Use `scheme:///path` instead of `scheme://path`. */
  isTripleSlashed?: boolean;
}

/** What a URL listener receives. */
export interface EventType {
  /** The URL that opened the app. */
  url: string;
  /** The underlying event (unused here). */
  nativeEvent?: MessageEvent;
}

/** A URL listener. */
export type URLListener = (event: EventType) => void;

/** An Android intent extra (intents are not available here). */
export interface SendIntentExtras {
  /** The extra's key. */
  key: string;
  /** The extra's value. */
  value: string | number | boolean;
}

/** The JS side of `@capacitor/app`'s launch URL. */
interface AppLaunchPlugin {
  getLaunchUrl(): Promise<{ url?: string } | undefined>;
}

/** The launch URL once read; `null` when there was none. */
let initialUrl: string | null | undefined;

/** The page's URL, or null (SSR). */
function pageUrl(): string | null {
  return (globalThis as { location?: { href?: string } }).location?.href ?? null;
}

/** The page's origin, or `""` (SSR). */
function pageOrigin(): string {
  return (globalThis as { location?: { origin?: string } }).location?.origin ?? "";
}

/**
 * The URL schemes the Expo config lists (`scheme`: a string or an array).
 *
 * @returns The schemes, possibly none.
 */
export function collectManifestSchemes(): string[] {
  const scheme = expoConfigGlobal()?.scheme;
  if (typeof scheme === "string") return [scheme];
  return Array.isArray(scheme) ? scheme.filter((s): s is string => typeof s === "string") : [];
}

/**
 * Whether the Expo config names a custom scheme.
 *
 * @returns `true` when it does.
 */
export function hasCustomScheme(): boolean {
  return collectManifestSchemes().length > 0;
}

/**
 * Whether an Expo config is available (`globalThis.__DENEXT_EXPO_CONFIG__`).
 *
 * @returns `true` when it is set.
 */
export function hasConstantsManifest(): boolean {
  return expoConfigGlobal() !== null;
}

/**
 * The scheme to build links with: `options.scheme`, else the Expo config's first scheme.
 *
 * @param options The explicit scheme; `isSilent` is accepted for compatibility.
 * @returns The scheme. It throws when there is none.
 */
export function resolveScheme(options: { scheme?: string; isSilent?: boolean }): string {
  const scheme = options.scheme ?? collectManifestSchemes()[0];
  if (!scheme) throw new Error("expo-linking: no scheme (set `scheme` in the Expo config)");
  return scheme;
}

/** `queryParams` as a query string (with `?`), or `""`. */
function queryString(queryParams: QueryParams | undefined): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(queryParams ?? {})) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      search.append(key, item);
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/**
 * A URL that opens `path` in this app: `<scheme>://path` inside the native shell, the page's
 * origin plus `/path` on the web.
 *
 * @param path The in-app path (a leading `/` is dropped).
 * @param options The scheme, query parameters and triple-slash form.
 * @returns The URL.
 */
export function createURL(path: string, options: CreateURLOptions = {}): string {
  const clean = String(path ?? "").replace(/^\/+/, "");
  const query = queryString(options.queryParams);
  if (nativePlatform() !== "web") {
    const scheme = options.scheme ?? collectManifestSchemes()[0];
    if (scheme) return `${scheme}:${options.isTripleSlashed ? "///" : "//"}${clean}${query}`;
  }
  return `${pageOrigin()}/${clean}${query}`;
}

/**
 * Split `url` into scheme, host, path and query.
 *
 * @param url The URL.
 * @returns Its parts.
 */
export function parse(url: string): ParsedURL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { scheme: null, hostname: null, path: url || null, queryParams: null };
  }
  const queryParams: QueryParams = {};
  for (const key of new Set(parsed.searchParams.keys())) {
    const all = parsed.searchParams.getAll(key);
    queryParams[key] = all.length > 1 ? all : all[0];
  }
  return {
    scheme: parsed.protocol.replace(/:$/, "") || null,
    hostname: parsed.hostname || null,
    path: decodeURIComponent(parsed.pathname.replace(/^\/+/, "")) || null,
    queryParams,
  };
}

/**
 * The URL that launched the app: `@capacitor/app`'s launch URL in the native shell, the
 * page's URL on the web.
 *
 * @returns The URL, or null when the app was not opened by a link.
 */
export async function getInitialURL(): Promise<string | null> {
  if (initialUrl !== undefined) return initialUrl;
  if (nativePlatform() === "web") return pageUrl();
  const plugin = nativePlugin<AppLaunchPlugin>("App", ["getLaunchUrl"]);
  initialUrl = (await plugin?.getLaunchUrl())?.url ?? null;
  return initialUrl;
}

/**
 * The parts of {@linkcode getInitialURL}.
 *
 * @returns The parsed launch URL.
 */
export async function parseInitialURLAsync(): Promise<ParsedURL> {
  const url = await getInitialURL();
  return url ? parse(url) : { scheme: null, hostname: null, path: null, queryParams: null };
}

/**
 * The launch URL, synchronously: the page's URL on the web; natively, the launch URL once
 * {@linkcode getInitialURL} has read it, else null.
 *
 * @returns The URL, or null.
 */
export function getLinkingURL(): string | null {
  return nativePlatform() === "web" ? pageUrl() : initialUrl ?? null;
}

/** Forget the launch URL (a later {@linkcode getLinkingURL} natively reads null). */
export function clearInitialURL(): void {
  initialUrl = null;
}

/**
 * Call `handler` for each link that opens the app while it runs (the launch link comes from
 * {@linkcode getInitialURL}). The link is not routed: that stays the handler's job.
 *
 * @param _type `"url"`.
 * @param handler Called with each link.
 * @returns A subscription to remove.
 */
export function addEventListener(_type: "url", handler: URLListener): Subscription {
  return subscription(
    onDeepLink((event) => {
      if (!event.launch) handler({ url: event.url });
    }, { accept: () => true, route: false }),
  );
}

/**
 * Open `url` outside the app (`denext/mobile`'s `openExternal`: the in-app browser for a
 * web link natively, a new window on the web). Only `http:`, `https:`, `mailto:` and `tel:`
 * are allowed.
 *
 * @param url The URL.
 * @returns `true` once handed off. It rejects for another scheme.
 */
export async function openURL(url: string): Promise<true> {
  await openExternal(url);
  return true;
}

/**
 * Whether {@linkcode openURL} would accept `url`.
 *
 * @param url The URL.
 * @returns `true` for an `http:`, `https:`, `mailto:` or `tel:` URL.
 */
export function canOpenURL(url: string): Promise<boolean> {
  return Promise.resolve(/^(https?|mailto|tel):/i.test(url));
}

/**
 * Open the app's system settings: not available to a web view.
 *
 * @returns A promise that rejects.
 */
export function openSettings(): Promise<void> {
  return Promise.reject(new Error("openSettings is not supported here (no native settings API)"));
}

/**
 * Send an Android intent: not available to a web view.
 *
 * @param _action The intent action.
 * @param _extras Intent extras.
 * @returns A promise that rejects.
 */
export function sendIntent(_action: string, _extras?: SendIntentExtras[]): Promise<void> {
  return Promise.reject(new Error("sendIntent is not supported here (Android intents only)"));
}

/**
 * Hook form: the launch URL, then each link that opens the app while mounted.
 *
 * @returns The latest URL, or null.
 */
export function useURL(): string | null {
  const [url, setUrl] = useState<string | null>(getLinkingURL);
  useEffect(() => {
    let active = true;
    getInitialURL().then((initial) => active && setUrl(initial), () => {});
    const sub = addEventListener("url", (event) => setUrl(event.url));
    return () => {
      active = false;
      sub.remove();
    };
  }, []);
  return url;
}

/**
 * Hook form of {@linkcode getLinkingURL}.
 *
 * @returns The launch URL, or null.
 */
export function useLinkingURL(): string | null {
  return useURL();
}
