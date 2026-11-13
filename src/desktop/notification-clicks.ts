/**
 * Clicks on the app's notifications, read from `Deno.desktop` once and shared (denext's pinned
 * runtime). The runtime dispatches a `"notificationresponse"` event per click (`{ tag, action,
 * data, launch }`) and keeps the clicks that came before the first listener — the one that
 * launched the app — in `launchNotificationResponses`, taken on first read. So one dispatcher per
 * `Deno.desktop` reads that list once, listens once, and fans every click out to its consumers:
 * the `notifications` capability (the pages' taps and web notification clicks) and the backend's
 * hooks (`runDesktop({ onNotificationClick })`, `DesktopRuntime.onNotificationClick`, an
 * extension's `host.onNotificationClick`).
 *
 * Each kind of consumer gets the clicks that came before it first subscribed (the launch list,
 * then any that arrived while only the other kind listened), with `launch: true`, as the runtime
 * itself would have kept them for the first listener; the pages' behaviour is the same whether or
 * not the backend listens. Among the backend's hooks every hook gets those early clicks when it
 * subscribes, so a hook added after `runDesktop()` resolved still hears the click that launched
 * the app.
 *
 * @module
 */

import type { DesktopAppApi, DesktopNotificationResponse } from "./launch-events.ts";

/** A click on one of the app's notifications, as the backend's hooks receive it. */
export interface DesktopNotificationClick {
  /**
   * The notification's tag: the one it was posted with (`Deno.desktop.notifications.schedule({
   * tag })`, a `new Notification(title, { tag })`), or the one denext gave it (`denext-<id>…` for
   * `scheduleNotification`, `denext-web-…` for a page's web notification).
   */
  readonly tag: string;
  /** The action button clicked, or `null` for the notification itself. */
  readonly action: string | null;
  /** The `data` it was posted with, as the runtime round-trips it (`null` when none). */
  readonly data: unknown;
  /** `true` for the click that launched the app (or one that came before the backend listened). */
  readonly launch: boolean;
}

/** A backend hook on notification clicks: a throw or a rejection is logged. */
export type DesktopNotificationClickListener = (
  click: DesktopNotificationClick,
) => void | Promise<void>;

/** The consumers of the clicks: the pages (the `notifications` capability) and the backend. */
export type NotificationClickConsumer = "page" | "backend";

/** One raw click as a consumer receives it: the runtime's response and whether it came early. */
export type NotificationResponseSink = (r: DesktopNotificationResponse, launch: boolean) => void;

/** The most early clicks kept for a consumer that has not subscribed yet. */
const MAX_EARLY = 64;

/** The shared state over one `Deno.desktop`. */
interface Dispatcher {
  readonly sinks: Set<
    { readonly kind: NotificationClickConsumer; readonly sink: NotificationResponseSink }
  >;
  readonly early: Record<NotificationClickConsumer, DesktopNotificationResponse[]>;
  readonly subscribed: Set<NotificationClickConsumer>;
}

const dispatchers = new WeakMap<object, Dispatcher>();

/** The dispatcher over `api`, made (reading the launch list, listening) on first use. */
function dispatcherOf(api: DesktopAppApi): Dispatcher {
  const known = dispatchers.get(api);
  if (known) return known;
  const raw = api.launchNotificationResponses;
  const launched = Array.isArray(raw) ? [...raw] : [];
  const d: Dispatcher = {
    sinks: new Set(),
    early: { page: [...launched], backend: [...launched] },
    subscribed: new Set(),
  };
  dispatchers.set(api, d);
  api.addEventListener?.("notificationresponse", (e) => {
    const r: DesktopNotificationResponse = (e as CustomEvent).detail ?? {};
    for (const kind of ["page", "backend"] as const) {
      if (!d.subscribed.has(kind) && d.early[kind].length < MAX_EARLY) d.early[kind].push(r);
    }
    for (const { sink } of [...d.sinks]) sink(r, false);
  });
  return d;
}

/**
 * Subscribe `sink` to the clicks on the app's notifications: first the ones that came before this
 * kind of consumer first subscribed (`launch` true; replayed to each subscriber of the kind), then
 * every click as it arrives. Without `Deno.desktop` (the stock runtime, a sidecar's child) nothing
 * is ever delivered; without its event target only the launch list is.
 *
 * @param api `Deno.desktop`, or `undefined`.
 * @param kind Which consumer subscribes.
 * @param sink Called with each raw response.
 * @returns The unsubscribe.
 */
export function subscribeNotificationResponses(
  api: DesktopAppApi | undefined,
  kind: NotificationClickConsumer,
  sink: NotificationResponseSink,
): () => void {
  if (typeof api !== "object" || api === null) return () => {};
  const d = dispatcherOf(api);
  d.subscribed.add(kind);
  for (const r of d.early[kind]) sink(r, true);
  const entry = { kind, sink };
  d.sinks.add(entry);
  return () => void d.sinks.delete(entry);
}

/** A raw response as the hooks receive it, or `undefined` for a malformed one (no string tag). */
function clickOf(
  r: DesktopNotificationResponse,
  launch: boolean,
): DesktopNotificationClick | undefined {
  if (typeof r.tag !== "string") return undefined;
  return {
    tag: r.tag,
    action: typeof r.action === "string" && r.action !== "" ? r.action : null,
    data: r.data ?? null,
    launch: launch || r.launch === true,
  };
}

/** One backend hook, and the clicks it has yet to get behind its early-click replay. */
interface HookEntry {
  readonly fn: DesktopNotificationClickListener;
  queued?: DesktopNotificationClick[];
}

/** The backend's notification-click hooks (what {@linkcode createNotificationClickHooks} returns). */
export interface NotificationClickHooks {
  /**
   * Subscribe `fn`: the early clicks reach it on a microtask, ahead of any later click. Returns
   * the unsubscribe.
   */
  add(fn: DesktopNotificationClickListener): () => void;
}

/**
 * The backend's hooks on notification clicks over `api`. The dispatcher is subscribed when the
 * first hook is added; each hook then gets the early clicks (the one that launched the app among
 * them) once, on a microtask after it subscribed, and every later click as it arrives.
 *
 * @param api `Deno.desktop`, or `undefined` (every hook is then kept by nobody).
 * @param warn Where a failing hook is reported.
 * @returns The hooks.
 */
export function createNotificationClickHooks(
  api: DesktopAppApi | undefined,
  warn: (message: string) => void,
): NotificationClickHooks {
  // A hook's `queued` holds its clicks until its early-click replay ran (kept in order).
  const hooks = new Set<HookEntry>();
  const early: DesktopNotificationClick[] = [];
  let listening = false;
  const call = (fn: DesktopNotificationClickListener, click: DesktopNotificationClick) => {
    const failed = (err: unknown) =>
      warn(`a notification-click handler failed: ${err instanceof Error ? err.message : err}`);
    try {
      const out = fn(click);
      if (out && typeof (out as Promise<void>).then === "function") {
        (out as Promise<void>).then(undefined, failed);
      }
    } catch (err) {
      failed(err);
    }
  };
  const deliver = (entry: HookEntry, click: DesktopNotificationClick) =>
    entry.queued ? void entry.queued.push(click) : call(entry.fn, click);
  const flush = (entry: HookEntry) => {
    const queued = entry.queued ?? [];
    entry.queued = undefined;
    for (const click of queued) if (hooks.has(entry)) call(entry.fn, click);
  };
  return {
    add(fn) {
      const entry: HookEntry = { fn };
      hooks.add(entry);
      if (!listening) {
        listening = true;
        subscribeNotificationResponses(api, "backend", (r, launch) => {
          const click = clickOf(r, launch);
          if (!click) return;
          if (launch) return void early.push(click);
          for (const h of [...hooks]) deliver(h, click);
        });
      }
      if (early.length > 0) {
        entry.queued = [...early];
        queueMicrotask(() => flush(entry));
      }
      return () => void hooks.delete(entry);
    },
  };
}
