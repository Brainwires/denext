/**
 * React Native's `Linking` for React Native mode: opening URLs through `denext/mobile`'s
 * `openExternal` (the in-app browser in the Capacitor shell) and the links that open the app
 * through its deep links (`@capacitor/app`). react-native-web's `Linking` never reports an
 * incoming link and returns the page URL as the initial one.
 *
 * @module
 */

import { isNativeShell, nativePlatform, openExternal } from "../mobile/bridge.ts";
import { onDeepLink } from "../mobile/deep-link.ts";
import { openAppSettings } from "../mobile/permissions.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import {
  type EmitterSubscription,
  type HandlerSubscriptions,
  handlerSubscriptions,
  type Listeners,
  listeners,
  subscription,
} from "./internal.ts";

/** One extra of `Linking.sendIntent`, as React Native types it. */
export interface IntentExtra {
  readonly key: string;
  readonly value: string | number | boolean;
}

/** What a `url` listener receives. */
export interface LinkingEvent {
  readonly url: string;
}

/** React Native's `Linking` module. */
export interface LinkingStatic {
  addEventListener(type: "url", handler: (event: LinkingEvent) => void): EmitterSubscription;
  /** Removed in React Native 0.65; kept for older libraries. */
  removeEventListener(type: "url", handler: (event: LinkingEvent) => void): void;
  /** `addEventListener` (React Native's event-emitter face). */
  addListener(type: "url", handler: (event: LinkingEvent) => void): EmitterSubscription;
  /** Call the `url` listeners with `event`, as an incoming link would. */
  emit(type: "url", event: LinkingEvent): void;
  /** How many `url` listeners there are. */
  listenerCount(type: "url"): number;
  /** Remove every `url` listener. */
  removeAllListeners(type?: "url"): void;
  openURL(url: string, target?: string): Promise<void>;
  canOpenURL(url: string): Promise<boolean>;
  getInitialURL(): Promise<string | null>;
  openSettings(): Promise<void>;
  /** Android: start an activity for `action` with `extras`. Rejects elsewhere, as in React Native. */
  sendIntent(action: string, extras?: readonly IntentExtra[]): Promise<void>;
}

/** The slice of denext's `DenextSettings` plugin `sendIntent` needs (Android only). */
interface IntentPlugin {
  sendIntent(options: { action: string; extras?: IntentExtra[] }): Promise<unknown>;
}

/** The slice of `@capacitor/app` the launch URL needs. */
interface AppLaunch {
  getLaunchUrl(): Promise<{ url?: string } | undefined>;
}

/** Schemes `openURL` refuses: code or inline content, never a place to go. */
const REFUSED = new Set(["javascript:", "data:", "vbscript:", "blob:", "file:"]);

/** Schemes `openExternal` hands off itself. */
const EXTERNAL = new Set(["http:", "https:", "mailto:", "tel:"]);

/** The registrations by handler, for the deprecated `removeEventListener`. */
let registered: HandlerSubscriptions | undefined;

/** The `url` listeners, for `emit` / `listenerCount`, and their live subscriptions. */
let urlListeners: Listeners<"url", LinkingEvent> | undefined;
let urlSubscriptions: Set<EmitterSubscription> | undefined;

/** `url` resolved against the page (as react-native-web does), or null when unparseable. */
function resolved(url: string): URL | null {
  try {
    const base = (globalThis as { location?: { href?: string } }).location?.href;
    return base ? new URL(url, base) : new URL(url);
  } catch {
    return null;
  }
}

/** Open `target` (any other scheme) the way react-native-web does: `tel:` in place, else a window. */
function openOther(target: URL, windowName: string): void {
  const g = globalThis as {
    open?: (u: string, t: string, f: string) => unknown;
    location?: { href: string };
  };
  if (target.protocol === "tel:" && g.location) {
    g.location.href = target.href;
    return;
  }
  if (typeof g.open !== "function") throw new Error("Linking.openURL: no window (SSR?)");
  g.open(target.href, windowName, "noopener");
}

/**
 * React Native's `Linking`:
 *
 * - `openURL(url)`: `http(s)`, `mailto:` and `tel:` go through `denext/mobile`'s
 *   `openExternal` (inside the shell an http(s) URL opens in the in-app browser when
 *   `@capacitor/browser` is installed); other schemes (`sms:`, another app's scheme) open in a
 *   new window, which the shell hands to the OS. A relative URL resolves against the page, as
 *   in react-native-web. `javascript:`, `data:`, `vbscript:`, `blob:` and `file:` are refused.
 * - `canOpenURL(url)`: `false` for a refused or unparseable URL, else `true` (a web view
 *   cannot ask the OS which apps handle a scheme).
 * - `getInitialURL()`: inside the shell, the link that cold-started the app
 *   (`@capacitor/app`'s launch URL), else `null`; in a browser, the page's URL.
 * - `addEventListener("url", handler)` (or `addListener`): each link that opens the app while
 *   it runs (not the launch link, which is `getInitialURL()`'s), through `denext/mobile`'s deep
 *   links with routing left to the app, as in React Native (`denext mobile add deep-links`). A
 *   browser has none. `emit`, `listenerCount` and `removeAllListeners` complete React Native's
 *   event-emitter face.
 * - `openSettings()`: the app's page in the system settings, through `denext/mobile`'s
 *   `openAppSettings()`: denext's `DenextSettings` plugin in the shell (`denext mobile add
 *   permissions`), iOS's `app-settings:` URL without it. It rejects where nothing can open them
 *   (the Android shell without the plugin, a browser).
 * - `sendIntent(action, extras?)`: inside the Android shell, starts an activity for the intent
 *   action through denext's `DenextSettings` plugin (`denext mobile add permissions`), each
 *   extra a `{ key, value }` with a string, number (put as a double, as React Native does) or
 *   boolean value; it rejects when no activity handles the action, and in the Android shell
 *   without the plugin. On iOS, the web and a Deno Desktop window it rejects with
 *   `Error("Unsupported")`, as React Native does off Android.
 *
 * @example
 * ```ts
 * import { Linking } from "react-native";
 *
 * const sub = Linking.addEventListener("url", ({ url }) => handle(url));
 * await Linking.openURL("https://denext.dev");
 * ```
 */
export const Linking: LinkingStatic = {
  addEventListener(type, handler) {
    if (type !== "url") return subscription(() => {});
    // The launch link is getInitialURL()'s, as in React Native; only later links are events.
    const stop = onDeepLink((event) => void (event.launch || handler({ url: event.url })), {
      accept: () => true,
      route: false,
    });
    const local = (urlListeners ??= listeners()).add("url", handler);
    const subs = urlSubscriptions ??= new Set();
    const sub = (registered ??= handlerSubscriptions()).track(handler, () => {
      stop();
      local.remove();
      subs.delete(sub);
    });
    subs.add(sub);
    return sub;
  },
  addListener(type, handler) {
    return Linking.addEventListener(type, handler);
  },
  emit(type, event) {
    urlListeners?.emit(type, event);
  },
  listenerCount(type) {
    return urlListeners?.count(type) ?? 0;
  },
  removeAllListeners() {
    for (const sub of [...(urlSubscriptions ?? [])]) sub.remove();
  },
  removeEventListener(_type, handler) {
    registered?.removeAll(handler);
  },
  async openURL(url, target) {
    const parsed = typeof url === "string" && url !== "" ? resolved(url) : null;
    if (!parsed) throw new TypeError(`Linking.openURL: invalid URL ${JSON.stringify(url)}`);
    if (REFUSED.has(parsed.protocol)) {
      throw new TypeError(`Linking.openURL: refusing a "${parsed.protocol}" URL`);
    }
    if (target !== undefined && !isNativeShell()) return openOther(parsed, target);
    if (EXTERNAL.has(parsed.protocol)) return await openExternal(parsed.href);
    openOther(parsed, "_blank");
  },
  canOpenURL(url) {
    const parsed = typeof url === "string" ? resolved(url) : null;
    return Promise.resolve(parsed !== null && !REFUSED.has(parsed.protocol));
  },
  async getInitialURL() {
    if (!isNativeShell()) {
      return (globalThis as { location?: { href?: string } }).location?.href ?? null;
    }
    const app = nativePlugin<AppLaunch>("App", ["getLaunchUrl"]);
    if (!app) return null;
    try {
      return (await app.getLaunchUrl())?.url || null;
    } catch {
      return null;
    }
  },
  openSettings() {
    return openAppSettings();
  },
  async sendIntent(action, extras) {
    if (nativePlatform() !== "android") throw new Error("Unsupported");
    if (typeof action !== "string" || action === "") {
      throw new TypeError(`Linking.sendIntent: invalid action ${JSON.stringify(action)}`);
    }
    const plugin = nativePlugin<IntentPlugin>("DenextSettings", ["sendIntent"]);
    if (!plugin) {
      throw new Error(
        "Linking.sendIntent needs denext's DenextSettings plugin: run `denext mobile add permissions`",
      );
    }
    await plugin.sendIntent({
      action,
      ...(extras ? { extras: extras.map(({ key, value }) => ({ key, value })) } : {}),
    });
  },
};
