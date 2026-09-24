/**
 * Push notifications for `denext/mobile`, through the native `PushNotifications` plugin
 * (`@capacitor/push-notifications`, installed by `denext mobile add push`): permission, the
 * device token (APNs on iOS, FCM on Android) for your server to send to, and the received /
 * tapped notification events.
 *
 * @module
 */

import { useEffect, useRef } from "../runtime/hooks.ts";
import { nativePlatform } from "./bridge.ts";
import {
  acceptsLink,
  createFanout,
  type Fanout,
  internalPath,
  type LinkAccept,
  linkPath,
  type LinkRoute,
  navigateTo,
  type RouteOnce,
} from "./link-routing.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";

/** Whether the app may show notifications, or `"unsupported"` outside the native shell. */
export type PushPermission = "granted" | "denied" | "prompt" | "unsupported";

/** A device's push registration: the token your server sends to, and where it is valid. */
export interface PushRegistration {
  /** `"ios"`: an APNs device token (hex). `"android"`: an FCM registration token. */
  readonly platform: "ios" | "android";
  /** The token. It can change: register on every launch and send the server the latest. */
  readonly token: string;
}

/** Options for {@linkcode registerForPush}. */
export interface RegisterForPushOptions {
  /** How long to wait for the OS to answer, in milliseconds (default 15000). */
  readonly timeoutMs?: number;
}

/** A push notification, as the shell reports it. */
export interface PushNotification {
  /** The notification's id, when the platform reports one. */
  readonly id?: string;
  /** The notification's title, when it has one. */
  readonly title?: string;
  /** The notification's body text, when it has one. */
  readonly body?: string;
  /** The custom payload keys your server sent (on iOS, the whole payload, `aps` included). */
  readonly data: Readonly<Record<string, unknown>>;
}

/** A tap on (or an action of) a notification. */
export interface PushTap {
  /** The notification that was tapped. */
  readonly notification: PushNotification;
  /** `"tap"` for the notification itself, else the action's identifier. */
  readonly actionId: string;
  /** The text typed into a text-input action, if any. */
  readonly inputValue?: string;
}

/** Options for {@linkcode onPushTapped} and {@linkcode usePushTapped}. */
export interface PushTapOptions {
  /**
   * Which `data.url` links to act on, as for deep links: a predicate or `{ schemes?, hosts? }`
   * (default: the app's custom schemes and no `https` host). A `data.path` must be an in-app
   * path (`/…`, never `//…`); an allow-list does not apply to it, a predicate sees it as a
   * URL on the page's origin.
   */
  readonly accept?: LinkAccept;
  /**
   * Navigate to the tapped notification's `data.path` (an in-app path such as `/threads/42`)
   * or `data.url` (an accepted link) (default `true`, as for deep links); a function
   * navigates with your own router, `false` leaves it to the callback. At most once per tap.
   */
  readonly route?: LinkRoute;
}

/** A raw notification from the plugin. */
interface RawNotification {
  id?: unknown;
  title?: unknown;
  body?: unknown;
  data?: unknown;
}

/** A raw tap from the plugin. */
interface RawTap {
  actionId?: unknown;
  inputValue?: unknown;
  notification?: RawNotification;
}

/** The JS side of `@capacitor/push-notifications`. */
interface PushPlugin {
  checkPermissions(): Promise<{ receive?: string }>;
  requestPermissions(): Promise<{ receive?: string }>;
  register(): Promise<void>;
  addListener(
    eventName: "registration",
    listener: (token: { value?: string }) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
  addListener(
    eventName: "registrationError",
    listener: (error: { error?: string }) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
  addListener(
    eventName: "pushNotificationReceived",
    listener: (notification: RawNotification) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
  addListener(
    eventName: "pushNotificationActionPerformed",
    listener: (action: RawTap) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** The native plugin, when the shell has it. */
function pushPlugin(): PushPlugin | undefined {
  return nativePlugin<PushPlugin>("PushNotifications", [
    "checkPermissions",
    "requestPermissions",
    "register",
    "addListener",
  ]);
}

/** Narrow a permission state; Android's `prompt-with-rationale` is still `"prompt"`. */
function permission(state: string | undefined): PushPermission {
  return state === "granted" || state === "denied" ? state : "prompt";
}

/**
 * Ask for permission to show notifications, when it has not been decided yet, and report the
 * result: `"granted"`, `"denied"` (the user said no; only the system settings can change it)
 * or `"prompt"` (still undecided). A decided state comes back without prompting again.
 * Outside the native shell (or without `@capacitor/push-notifications`) it is
 * `"unsupported"`: there is no web-push fallback.
 *
 * Android before 13 needs no permission and always reads `"granted"`.
 *
 * @returns The permission state.
 * @example
 * ```ts
 * import { registerForPush, requestPushPermission } from "denext/mobile";
 *
 * if ((await requestPushPermission()) === "granted") {
 *   const { platform, token } = await registerForPush();
 *   await fetch("/api/devices", { method: "POST", body: JSON.stringify({ platform, token }) });
 * }
 * ```
 */
export async function requestPushPermission(): Promise<PushPermission> {
  const plugin = pushPlugin();
  if (!plugin) return "unsupported";
  const current = permission((await plugin.checkPermissions())?.receive);
  if (current !== "prompt") return current;
  return permission((await plugin.requestPermissions())?.receive);
}

let inFlight: Promise<PushRegistration> | undefined;

/** Resolve when the listener handle is in place (the bridge may answer with a promise). */
async function listen(
  handle: ListenerHandle | Promise<ListenerHandle>,
  stops: Array<() => void>,
): Promise<void> {
  stops.push(listenerDisposer(handle));
  await handle;
}

/** One registration round trip: listen, `register()`, wait for the token or the error. */
async function registerOnce(
  plugin: PushPlugin,
  timeoutMs: number,
): Promise<PushRegistration> {
  const platform = nativePlatform();
  if (platform === "web") throw new Error("registerForPush: not inside the iOS/Android shell.");
  const stops: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = new Promise<string>((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `registerForPush: no token within ${timeoutMs} ms. On iOS, AppDelegate.swift must ` +
                "forward didRegisterForRemoteNotificationsWithDeviceToken (`denext mobile add push` " +
                "adds it) and the app needs the Push Notifications capability; on Android, " +
                "android/app/google-services.json must be present.",
            ),
          ),
        timeoutMs,
      );
      // Both listeners go in before register(): iOS does not keep a token nobody listened for.
      const token = (t: { value?: string }) =>
        typeof t?.value === "string" && t.value !== ""
          ? resolve(t.value)
          : reject(new Error("registerForPush: the shell reported an empty token."));
      const error = (e: { error?: string }) =>
        reject(new Error(`registerForPush: ${e?.error || "registration failed"}`));
      Promise.all([
        listen(plugin.addListener("registration", token), stops),
        listen(plugin.addListener("registrationError", error), stops),
      ]).then(() => plugin.register()).catch(reject);
    });
    return { platform, token: await answer };
  } finally {
    clearTimeout(timer);
    for (const stop of stops) stop();
  }
}

/**
 * Register the device for remote notifications and resolve its token, for your server to send
 * to through APNs (iOS) or FCM (Android). denext ships no push relay: store the token on your
 * server (with the user it belongs to) and send from there.
 *
 * It listens for the plugin's `registration` / `registrationError` events, calls `register()`,
 * and resolves the first answer, rejecting after `timeoutMs` (default 15 s). Its listeners are
 * removed either way. Concurrent calls share one registration. Call it on every launch: the
 * token can change. It does not ask for permission (see {@linkcode requestPushPermission}),
 * and it rejects outside the native shell or without `@capacitor/push-notifications`: there
 * is no web-push fallback.
 *
 * @param options The timeout.
 * @returns The platform and its token.
 * @example
 * ```ts
 * import { registerForPush } from "denext/mobile";
 *
 * const { platform, token } = await registerForPush();
 * await api("/api/devices", "POST", { body: { platform, token } });
 * ```
 */
export function registerForPush(options: RegisterForPushOptions = {}): Promise<PushRegistration> {
  const plugin = pushPlugin();
  if (!plugin) {
    return Promise.reject(
      new Error(
        "registerForPush: needs the iOS/Android shell with @capacitor/push-notifications " +
          "(`denext mobile add push`); there is no web-push fallback.",
      ),
    );
  }
  return inFlight ??= registerOnce(plugin, options.timeoutMs ?? 15_000).finally(() => {
    inFlight = undefined;
  });
}

/** A string field, or undefined. */
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A raw notification as a {@linkcode PushNotification}. */
function toNotification(raw: RawNotification | undefined): PushNotification {
  const data = raw?.data;
  return {
    id: str(raw?.id),
    title: str(raw?.title),
    body: str(raw?.body),
    data: typeof data === "object" && data !== null ? data as Record<string, unknown> : {},
  };
}

/** A raw tap as a {@linkcode PushTap}. */
function toTap(raw: RawTap | undefined): PushTap {
  return {
    notification: toNotification(raw?.notification),
    actionId: str(raw?.actionId) ?? "tap",
    inputValue: str(raw?.inputValue),
  };
}

let receivedFanout: Fanout<PushNotification> | undefined;
let tappedFanout: Fanout<PushTap> | undefined;

/** A fan-out over one plugin event, mapped through `map`. */
function pluginFanout<Raw, T>(
  eventName: "pushNotificationReceived" | "pushNotificationActionPerformed",
  map: (raw: Raw) => T,
): Fanout<T> {
  return createFanout<T>((emit) => {
    const plugin = pushPlugin() as
      | { addListener(e: string, fn: (raw: Raw) => void): ListenerHandle | Promise<ListenerHandle> }
      | undefined;
    return listenerDisposer(plugin?.addListener(eventName, (raw) => emit(map(raw))));
  });
}

/** The in-app path and URL a tapped notification points at, when it passes `accept`. */
function tapTarget(
  data: Readonly<Record<string, unknown>>,
  accept: LinkAccept | undefined,
): { path: string; url: URL } | undefined {
  const path = typeof data.path === "string" ? internalPath(data.path) : undefined;
  if (path !== undefined) {
    // An allow-list is about schemes and hosts, so it has nothing to say about an in-app
    // path; a predicate sees the path on the page's origin.
    const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
    const url = new URL(path, origin && origin !== "null" ? origin : "https://localhost");
    return typeof accept === "function" && !acceptsLink(url, accept) ? undefined : { path, url };
  }
  if (typeof data.url !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(data.url);
  } catch {
    return undefined;
  }
  const linked = acceptsLink(url, accept) ? linkPath(url) : undefined;
  return linked === undefined ? undefined : { path: linked, url };
}

/** Call a tap subscriber, then navigate (once per tap). */
function deliverTap(
  tap: PushTap,
  once: RouteOnce,
  callback: (tap: PushTap) => void,
  options: PushTapOptions,
): void {
  callback(tap);
  const route = options.route ?? true;
  if (route === false || once.done) return;
  const target = tapTarget(tap.notification.data, options.accept);
  if (!target) return;
  once.done = true;
  navigateTo(target.path, target.url, route);
}

/** Subscribe to taps with options read at delivery time. */
function subscribeTaps(
  callback: (tap: PushTap) => void,
  options: () => PushTapOptions,
): () => void {
  if (!pushPlugin()) return () => {};
  tappedFanout ??= pluginFanout<RawTap, PushTap>("pushNotificationActionPerformed", toTap);
  return tappedFanout.subscribe((tap, once) => deliverTap(tap, once, callback, options()));
}

/** Subscribe to notifications received in the foreground. */
function subscribeReceived(callback: (notification: PushNotification) => void): () => void {
  if (!pushPlugin()) return () => {};
  receivedFanout ??= pluginFanout<RawNotification, PushNotification>(
    "pushNotificationReceived",
    toNotification,
  );
  return receivedFanout.subscribe((notification) => callback(notification));
}

/**
 * Call `callback` for each notification that arrives while the app is in the foreground (one
 * that arrives in the background shows in the tray; its tap reaches
 * {@linkcode onPushTapped}). Outside the native shell it does nothing.
 *
 * @param callback Called with each notification.
 * @returns A function that unsubscribes.
 * @example
 * ```ts
 * import { onPushReceived } from "denext/mobile";
 *
 * const stop = onPushReceived(({ title, body }) => toast(`${title}: ${body}`));
 * ```
 */
export function onPushReceived(callback: (notification: PushNotification) => void): () => void {
  return subscribeReceived(callback);
}

/**
 * Call `callback` when the user taps a notification (or one of its actions), and by default
 * navigate to its `data.path` / `data.url` (see {@linkcode PushTapOptions}).
 *
 * A tap that cold-started the app is kept by the shell until the first listener, so it still
 * arrives when you subscribe shortly after boot: subscribe early (a root layout or the app
 * shell), because only the subscribers present when it is handed over see it. Outside the
 * native shell it does nothing.
 *
 * @param callback Called with each tap.
 * @param options Which links to accept, and how to navigate.
 * @returns A function that unsubscribes.
 * @example
 * ```ts
 * import { onPushTapped } from "denext/mobile";
 *
 * // The server sends { "path": "/threads/42" } in the notification's data.
 * const stop = onPushTapped(({ notification }) => markRead(notification.id));
 * ```
 */
export function onPushTapped(
  callback: (tap: PushTap) => void,
  options: PushTapOptions = {},
): () => void {
  return subscribeTaps(callback, () => options);
}

/**
 * Hook form of {@linkcode onPushReceived}: subscribes on mount, unsubscribes on unmount, and
 * always calls the latest `callback`.
 *
 * @param callback Called with each notification received in the foreground.
 * @example
 * ```tsx
 * "use client";
 * import { usePushReceived } from "denext/mobile";
 *
 * export function Inbox() {
 *   usePushReceived(() => inbox.refetch());
 *   return <InboxList />;
 * }
 * ```
 */
export function usePushReceived(callback: (notification: PushNotification) => void): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;
  useEffect(() => subscribeReceived((notification) => cbRef.current(notification)), []);
}

/**
 * Hook form of {@linkcode onPushTapped}: subscribes on mount, unsubscribes on unmount, and
 * always uses the latest `callback` and `options`.
 *
 * @param callback Called with each tap.
 * @param options Which links to accept, and how to navigate.
 * @example
 * ```tsx
 * "use client";
 * import { useRouter } from "denext";
 * import { usePushTapped } from "denext/mobile";
 *
 * export function PushRouting() {
 *   const router = useRouter();
 *   usePushTapped(() => {}, { route: (path) => router.push(path) });
 *   return null;
 * }
 * ```
 */
export function usePushTapped(
  callback: (tap: PushTap) => void,
  options?: PushTapOptions,
): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;
  const optsRef = useRef(options);
  optsRef.current = options;
  useEffect(() => subscribeTaps((tap) => cbRef.current(tap), () => optsRef.current ?? {}), []);
}

/** Forget the shared listeners and any in-flight registration (tests only). */
export function resetPushForTesting(): void {
  inFlight = undefined;
  receivedFanout = undefined;
  tappedFanout = undefined;
}
