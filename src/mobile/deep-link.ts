/**
 * Deep links for `denext/mobile`: the custom-scheme and universal / app links that open the
 * app, through the native `App` plugin (`@capacitor/app`, installed by `denext mobile add
 * deep-links`).
 *
 * @module
 */

import { useEffect, useRef } from "../runtime/hooks.ts";
import {
  acceptsLink,
  createFanout,
  type Fanout,
  type LinkAccept,
  linkPath,
  type LinkRoute,
  navigateTo,
  type RouteOnce,
} from "./link-routing.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";
import { isAuthSessionCallback } from "./auth-session.ts";

/** One link that opened the app. */
export interface DeepLinkEvent {
  /** The full URL, as the OS delivered it. */
  readonly url: string;
  /** The in-app path it opens (`myapp://threads/42` → `/threads/42`), when it maps to one. */
  readonly path?: string;
  /** `true` for the link that cold-started the app, `false` for one opened while it ran. */
  readonly launch: boolean;
}

/** Options for {@linkcode onDeepLink} and {@linkcode useDeepLink}. */
export interface DeepLinkOptions {
  /**
   * Which links to act on: a predicate over the parsed URL, or an allow-list
   * `{ schemes?, hosts? }`. The default accepts any custom scheme (the OS only delivers the
   * ones the app registered) and no `https` link: list your universal / app link domains in
   * `hosts`. A refused link reaches neither the callback nor the router.
   */
  readonly accept?: LinkAccept;
  /**
   * Navigate to the link's in-app path (default `true`): the path is pushed onto the history
   * and `popstate` fired, which denext's App Router and history-based SPA routers follow. Pass
   * a function to navigate with your own router, or `false` to leave it to the callback.
   * However many subscribers see one link, it is navigated at most once.
   */
  readonly route?: LinkRoute;
}

/** The JS side of `@capacitor/app`, as far as deep links go. */
interface AppPlugin {
  getLaunchUrl(): Promise<{ url?: string } | undefined>;
  addListener(
    eventName: "appUrlOpen",
    listener: (event: { url?: string }) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** A link before it is filtered, as the hub hands it to each subscriber. */
interface RawLink {
  readonly url: string;
  readonly launch: boolean;
}

/** Page-lifetime state: one native listener, and the launch URL's bookkeeping. */
interface DeepLinkHub {
  readonly fanout: Fanout<RawLink>;
  /** Delivers to the current subscribers; set while the native listener is attached. */
  emit?: (link: RawLink) => void;
  /** Whether `getLaunchUrl()` was asked for (once per page). */
  launchRequested: boolean;
  /** Whether it answered; `appUrlOpen` events wait in `buffer` until then. */
  launchResolved: boolean;
  buffer: string[];
  /** The launch URL delivered on this page, and when the hub started. */
  launchUrl?: string;
  startedAt: number;
  /** Whether the `appUrlOpen` copy of the launch URL was already dropped. */
  copyDropped: boolean;
  /** A launch link that found no subscriber, for the next one. */
  pending?: RawLink;
}

/** The `sessionStorage` key holding the last link delivered in this webview session. */
const LAST_LINK_KEY = "denext:deep-link:last";
/** How long after start an `appUrlOpen` equal to the launch URL counts as its native copy. */
const LAUNCH_COPY_MS = 10_000;

let hub: DeepLinkHub | undefined;

/** The native plugin, when the shell has it. */
function appPlugin(): AppPlugin | undefined {
  return nativePlugin<AppPlugin>("App", ["getLaunchUrl", "addListener"]);
}

/** The last link delivered in this webview session, surviving a reload (best effort). */
function lastLink(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(LAST_LINK_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Remember `url` as delivered, so a reload does not replay it as a launch. */
function rememberLink(url: string): void {
  try {
    globalThis.sessionStorage?.setItem(LAST_LINK_KEY, url);
  } catch {
    // Storage off: a reload may replay the launch link.
  }
}

/** Hand `link` to the subscribers, or keep it for the next one when there are none. */
function dispatch(h: DeepLinkHub, link: RawLink): void {
  rememberLink(link.url);
  if (h.emit) h.emit(link);
  else h.pending = link;
}

/**
 * Whether a warm `appUrlOpen` is the native copy of the launch URL: Capacitor 8 also fires
 * `appUrlOpen` for the link that launched the app (retained until the first listener).
 */
function isLaunchCopy(h: DeepLinkHub, url: string): boolean {
  if (h.copyDropped || url !== h.launchUrl) return false;
  if (Date.now() - h.startedAt > LAUNCH_COPY_MS) return false;
  h.copyDropped = true;
  return true;
}

/** One `appUrlOpen` from the shell. */
function onUrlOpen(h: DeepLinkHub, url: unknown): void {
  if (typeof url !== "string" || url === "") return;
  if (!h.launchResolved) return void h.buffer.push(url);
  if (!isLaunchCopy(h, url)) dispatch(h, { url, launch: false });
}

/** `getLaunchUrl()` answered: deliver a fresh launch URL, then any buffered warm links. */
function launchResolved(h: DeepLinkHub, url: string | undefined): void {
  h.launchResolved = true;
  // The shell keeps answering the same URL for the page's lifetime (iOS: the last URL
  // opened), so one already delivered in this session is a reload, not a launch.
  if (url && url !== lastLink()) {
    h.launchUrl = url;
    dispatch(h, { url, launch: true });
  }
  const buffered = h.buffer;
  h.buffer = [];
  for (const warm of buffered) onUrlOpen(h, warm);
}

/** The page's hub, created on first use. */
function deepLinkHub(): DeepLinkHub {
  return hub ??= {
    fanout: createFanout<RawLink>((emit) => {
      const h = deepLinkHub();
      h.emit = emit;
      // A listener whose removal is still in flight (h.emit moved on) delivers nothing.
      const stop = listenerDisposer(
        appPlugin()?.addListener("appUrlOpen", (event) => {
          if (h.emit === emit) onUrlOpen(h, event?.url);
        }),
      );
      return () => {
        h.emit = undefined;
        stop();
      };
    }),
    launchRequested: false,
    launchResolved: false,
    buffer: [],
    startedAt: 0,
    copyDropped: false,
  };
}

/** Ask the shell for the launch URL, once per page. */
function requestLaunch(h: DeepLinkHub, plugin: AppPlugin): void {
  if (h.launchRequested) return;
  h.launchRequested = true;
  h.startedAt = Date.now();
  plugin.getLaunchUrl().then(
    (result) => launchResolved(h, typeof result?.url === "string" ? result.url : undefined),
    () => launchResolved(h, undefined),
  );
}

/** Filter one link for one subscriber, call it, and navigate (once per link). */
function deliver(
  link: RawLink,
  once: RouteOnce,
  callback: (event: DeepLinkEvent) => void,
  options: DeepLinkOptions,
): void {
  // An auth session's OAuth callback (Android delivers it here too) is openAuthSession's.
  if (isAuthSessionCallback(link.url)) return;
  let url: URL;
  try {
    url = new URL(link.url);
  } catch {
    return;
  }
  if (!acceptsLink(url, options.accept)) return;
  const path = linkPath(url);
  callback({ url: link.url, path, launch: link.launch });
  const route = options.route ?? true;
  if (path === undefined || route === false || once.done) return;
  once.done = true;
  navigateTo(path, url, route);
}

/** Subscribe with options read at delivery time (the hook passes its latest ones). */
function subscribe(
  callback: (event: DeepLinkEvent) => void,
  options: () => DeepLinkOptions,
): () => void {
  const plugin = appPlugin();
  if (!plugin) return () => {};
  const h = deepLinkHub();
  const stop = h.fanout.subscribe((link, once) => deliver(link, once, callback, options()));
  requestLaunch(h, plugin);
  const pending = h.pending;
  if (pending) {
    h.pending = undefined;
    queueMicrotask(() => h.emit ? h.emit(pending) : (h.pending = pending));
  }
  return stop;
}

/**
 * Call `callback` for every link that opens the app, and (by default) navigate to it.
 *
 * - **Cold start:** the link that launched the app is delivered once per page, with
 *   `launch: true`, to every subscriber registered before the shell answers (so subscribe
 *   early: a root layout or the app shell). A subscriber that registers after that, say on a
 *   component that remounts after a navigation, never sees it again, and neither does the
 *   page after a reload in the same session (e.g. an OTA update).
 * - **Warm:** every link opened while the app runs, with `launch: false`. A link that arrives
 *   while nobody is subscribed waits in the shell for the next subscriber.
 * - **Filter:** only links that pass `options.accept` (default: the app's custom schemes, no
 *   `https` host) reach `callback`. An unfiltered deep link is an injection vector: anyone
 *   can craft one, so treat its path and query as untrusted input.
 * - **Route:** an accepted link's in-app path is navigated (see
 *   {@linkcode DeepLinkOptions.route}), once per link however many subscribers see it.
 * - **Auth callbacks:** while {@linkcode openAuthSession} waits in the shell, links with its
 *   callback scheme (and, for a few seconds after, the callback it received) are its own and
 *   are not delivered here.
 *
 * On the web (and during SSR) there is no native plugin and this does nothing: the browser
 * already loaded the linked URL. Needs `@capacitor/app` in the shell (`denext mobile add
 * deep-links --scheme myapp`).
 *
 * @param callback Called with each accepted link.
 * @param options Which links to accept, and how to navigate.
 * @returns A function that unsubscribes.
 * @example
 * ```ts
 * import { onDeepLink } from "denext/mobile";
 *
 * const stop = onDeepLink(
 *   ({ url, launch }) => analytics.track("deep_link", { url, launch }),
 *   { accept: { schemes: ["myapp"], hosts: ["app.example.com"] } },
 * );
 * ```
 */
export function onDeepLink(
  callback: (event: DeepLinkEvent) => void,
  options: DeepLinkOptions = {},
): () => void {
  return subscribe(callback, () => options);
}

/**
 * Hook form of {@linkcode onDeepLink}: subscribes on mount, unsubscribes on unmount. The latest
 * `callback` and `options` are used for each link (they are held in refs), so fresh closures
 * each render never re-subscribe.
 *
 * @param callback Called with each accepted link.
 * @param options Which links to accept, and how to navigate.
 * @example
 * ```tsx
 * "use client";
 * import { useRouter } from "denext";
 * import { useDeepLink } from "denext/mobile";
 *
 * export function DeepLinks() {
 *   const router = useRouter();
 *   useDeepLink(() => {}, {
 *     accept: { schemes: ["myapp"], hosts: ["app.example.com"] },
 *     route: (path) => router.push(path),
 *   });
 *   return null;
 * }
 * ```
 */
export function useDeepLink(
  callback: (event: DeepLinkEvent) => void,
  options?: DeepLinkOptions,
): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;
  const optsRef = useRef(options);
  optsRef.current = options;
  useEffect(() => subscribe((event) => cbRef.current(event), () => optsRef.current ?? {}), []);
}

/** Forget the page's deep-link state (tests only). */
export function resetDeepLinksForTesting(): void {
  hub = undefined;
}
