/**
 * The `notifications` capability: `denext/mobile`'s local notifications as the OS's own, through
 * `Deno.desktop.notifications` (denext's pinned Deno Desktop runtime) — shown now or at a time,
 * repeating, cancelled and listed, with action buttons (`setNotificationCategories`), the
 * permission status, and clicks routed to `onLocalNotificationTapped`, including the click that
 * launched the app.
 *
 * Mechanisms (the runtime's): macOS `UNUserNotificationCenter`, Windows toasts
 * (`ScheduledToastNotification`), Linux `org.freedesktop.Notifications` with the runtime's own timer
 * (it delivers while the app runs and re-arms at the next launch). From runtime 2.9.7-denext.11 a
 * Linux app installed from its `.deb` / `.rpm` posts through the xdg-desktop-portal, so a click
 * starts it when it isn't running, and a systemd user timer posts a scheduled one while it is
 * closed; `capabilities` passes on the runtime's reasons where it can't.
 *
 * A notification's runtime tag is `denext-<id>`; each occurrence of a repeating one is
 * `denext-<id>-<time>`. The OS has no repeating trigger the runtime exposes, so this capability
 * schedules the next {@linkcode REPEAT_HORIZON} occurrences of a repeating notification and tops
 * the series up while the app runs and at each launch (the series lives in the scheduled
 * notifications' data, so nothing else is stored). A repeating notification of an app that is not
 * launched again stops after those occurrences.
 *
 * Clicks are PULLED, like deep links: each click is queued and a payload-free `tap` signal goes
 * down the event stream; the page takes the queue (`take`), so a click is seen once, never again
 * after a reload.
 *
 * The page's web `Notification` (the shim the desktop runtime injects when this capability is on,
 * see `notification-shim.ts`) posts through `webShow` / `webClose`: its notifications are tagged
 * `denext-web-<key>`, never listed by `pending` nor touched by `cancel`, and their clicks go to a
 * queue of their own (`webTake`, signalled by `webtap`), so `onLocalNotificationTapped` never sees
 * a click on a web notification.
 *
 * Under the stock runtime (no `Deno.desktop.notifications`) every method answers `unavailable` and
 * the page keeps the WebView's Notification API (immediate only).
 *
 * Runtime-only (imported by the caps resolver, never a client bundle).
 *
 * @module
 */

import { type DesktopCapability, type DesktopCapCtx, DesktopCapError } from "../extension.ts";
import {
  type DesktopAppApi,
  desktopAppApi,
  type DesktopNotificationAction,
  type DesktopNotificationResponse,
  type DesktopNotificationsApi,
  type DesktopScheduledNotification,
} from "../launch-events.ts";
import {
  dateOf,
  int,
  type LocalNotificationTrigger,
  nextMatch,
  secondsOf,
  triggerComponents,
} from "../../mobile/notification-trigger.ts";
import { platformFacts } from "./platform.ts";
import { createPullQueue, type PullQueue } from "./queue.ts";

/** How many occurrences of a repeating notification are scheduled ahead. */
export const REPEAT_HORIZON = 16;
/** The most notifications this capability keeps scheduled (macOS keeps 64 per app). */
const MAX_PENDING = 60;
/** The runtime's limit on a notification's stored data (JSON). */
const MAX_DATA_BYTES = 4096;
/** The longest title / body accepted. */
const MAX_TEXT = 4096;
/** The tag prefix of this capability's notifications. */
const TAG_PREFIX = "denext-";
/**
 * How long a prompting `permission` request waits for the OS before it answers with the state known
 * so far. macOS never answers an ad-hoc signed app's authorization request on some machines (CI
 * runners), and the page's web `Notification` shim bounds its own `requestPermission()` the same way.
 */
const PERMISSION_REQUEST_TIMEOUT_MS = 30_000;

/** A repeating series as stored with each of its occurrences. */
interface SeriesSpec {
  /** The trigger (a `date` trigger never repeats). */
  readonly trigger: LocalNotificationTrigger;
  /** The first occurrence (ms): an interval series counts its periods from it. */
  readonly anchor: number;
}

/** What this capability stores in a notification's `data`. */
interface StoredMeta {
  /** The notification's id. */
  readonly id: number;
  /** The title and body (absent when they did not fit the data limit). */
  readonly t?: string;
  readonly b?: string;
  /** The series, for an occurrence of a repeating notification. */
  readonly r?: SeriesSpec;
}

/** The tag prefix of the page's web `Notification`s (`webShow`). */
const WEB_TAG_PREFIX = "denext-web-";
/** A web notification's key: what the page's shim derives from its `tag` (or picks at random). */
const WEB_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** One click on a web notification, as the page's shim takes it. */
interface WebTapWire {
  readonly key: string;
  /** The action button's id, or `""` for the notification itself. */
  readonly action: string;
}

/** One click, as the page takes it. */
interface NotificationTapWire {
  readonly id: number;
  readonly actionId: string;
  readonly title?: string;
  readonly body?: string;
  readonly data: Record<string, unknown>;
  readonly launch: boolean;
}

/** Options for {@linkcode notificationsCapability}. */
export interface NotificationsCapabilityOptions {
  /** The runtime's app API (default `Deno.desktop`); tests pass a fake. */
  readonly api?: DesktopAppApi;
  /** The clock (tests). */
  readonly now?: () => number;
  /** Shows a notification now where the runtime cannot schedule (default the Deno `Notification`). */
  readonly showNow?: NotificationCtor;
  /** Top up repeating series at startup (default `true` under the pinned runtime). */
  readonly autoTopUp?: boolean;
  /** Arms the next top-up (default an unref'd `setTimeout`); tests pass their own. */
  readonly timer?: (run: () => void, ms: number) => () => void;
  /**
   * How long a prompting permission request waits for the OS (default
   * {@linkcode PERMISSION_REQUEST_TIMEOUT_MS}); tests pass less.
   */
  readonly permissionTimeoutMs?: number;
}

/** The default top-up timer: a `setTimeout` that does not keep the process alive. */
function unrefTimer(run: () => void, ms: number): () => void {
  const id = setTimeout(run, ms);
  Deno.unrefTimer(id);
  return () => clearTimeout(id);
}

/** The Deno process's `Notification` (the Web Notifications API of `deno desktop`). */
type NotificationCtor = new (
  title: string,
  options?: { body?: string; tag?: string; data?: unknown; actions?: DesktopNotificationAction[] },
) => EventTarget;

/**
 * What the runtime's session probe says about notifications here (runtime 2.9.7-denext.11, Linux):
 * the transport, and why a click can't start the app when it isn't running (`coldStart` false) or
 * why a scheduled notification waits for the app to run (`schedulePersists` false). `"unknown"` /
 * `null` from an older runtime and on macOS and Windows, where the OS does both.
 */
async function notificationFacts(api: DesktopAppApi | undefined) {
  const facts = await platformFacts(api);
  return {
    transport: facts.notificationTransport,
    coldStartReason: facts.notificationColdStartReason,
    schedulePersistsReason: facts.notificationScheduleReason,
  };
}

/** The runtime's notifications API, or `unavailable` (the page then uses the WebView's). */
function nativeApi(api: DesktopAppApi | undefined): DesktopNotificationsApi {
  const n = api?.notifications;
  if (typeof n?.schedule !== "function" || typeof n.getScheduled !== "function") {
    throw new DesktopCapError(
      "unavailable",
      "this Deno Desktop runtime has no native notifications (denext's pinned runtime adds them)",
    );
  }
  return n;
}

/** A `validation` error. */
function invalid(message: string): DesktopCapError {
  return new DesktopCapError("validation", message);
}

/** Run `fn`, turning a thrown `TypeError` / `RangeError` (the trigger checks) into `validation`. */
function checked<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof TypeError || err instanceof RangeError) throw invalid(err.message);
    throw err;
  }
}

/** A string argument up to {@linkcode MAX_TEXT} characters. */
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > MAX_TEXT) {
    throw invalid(`${name} must be a string up to ${MAX_TEXT} characters`);
  }
  return value;
}

/** A plain-object argument (or `{}` when absent). */
function record(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw invalid(`${name} must be an object`);
  return value as Record<string, unknown>;
}

/** Whether `t` fires more than once (a calendar trigger repeats unless `repeats: false`). */
function repeats(t: LocalNotificationTrigger): boolean {
  switch (t.type) {
    case "date":
      return false;
    case "interval":
      return t.repeats === true;
    case "calendar":
      return t.repeats !== false;
    default:
      return true;
  }
}

/** The trigger from the wire (`date` as ms), checked. */
function triggerOf(raw: unknown): LocalNotificationTrigger | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || typeof (raw as { type?: unknown }).type !== "string") {
    throw invalid("trigger must be an object with a type");
  }
  const t = raw as LocalNotificationTrigger;
  checked(() => {
    if (t.type === "date") dateOf("schedule", t.date);
    else if (t.type === "interval") secondsOf("schedule", t);
    else if (!triggerComponents("schedule", t)) {
      throw new TypeError(`unknown trigger type "${String((t as { type?: unknown }).type)}"`);
    }
  });
  return t;
}

/** The first time `t` fires at or after `now` (`now` when there is no trigger), or `null`. */
function firstAt(t: LocalNotificationTrigger | undefined, now: number): number | null {
  if (!t) return now;
  if (t.type === "date") return Math.max(dateOf("schedule", t.date), now);
  if (t.type === "interval") return now + secondsOf("schedule", t) * 1000;
  return nextMatch(triggerComponents("schedule", t)!, now)?.getTime() ?? null;
}

/** Up to `count` occurrences of `series` after `after`, ascending. */
export function seriesTimes(series: SeriesSpec, after: number, count: number): number[] {
  const out: number[] = [];
  const t = series.trigger;
  if (t.type === "interval") {
    const period = secondsOf("schedule", t) * 1000;
    let k = Math.max(0, Math.floor((after - series.anchor) / period) + 1);
    if (series.anchor > after) k = 0;
    while (out.length < count) out.push(series.anchor + period * k++);
    return out;
  }
  const c = triggerComponents("schedule", t);
  let from = after;
  while (c && out.length < count) {
    const next = nextMatch(c, from)?.getTime();
    if (next === undefined) break;
    out.push(next);
    from = next;
  }
  return out;
}

/** The stored data for a notification: the meta plus the app's own `data`, within the limit. */
function storedData(meta: StoredMeta, data: Record<string, unknown>): unknown {
  const full = { denext: meta, data };
  if (JSON.stringify(full).length <= MAX_DATA_BYTES) return full;
  const lean = { denext: { id: meta.id, ...(meta.r ? { r: meta.r } : {}) }, data };
  if (JSON.stringify(lean).length <= MAX_DATA_BYTES) return lean;
  throw invalid("data is too large: a desktop notification stores at most 4 KiB of JSON");
}

/** The meta and app data stored with a scheduled or clicked notification, else `undefined`. */
function metaOf(
  data: unknown,
  tag: unknown,
): { meta: StoredMeta; data: Record<string, unknown> } | undefined {
  const d = data as { denext?: StoredMeta; data?: unknown } | null | undefined;
  const app = typeof d?.data === "object" && d.data !== null
    ? d.data as Record<string, unknown>
    : {};
  if (typeof d?.denext?.id === "number") return { meta: d.denext, data: app };
  const m = typeof tag === "string" ? /^denext-(-?\d+)(?:-\d+)?$/.exec(tag) : null;
  return m ? { meta: { id: Number(m[1]) }, data: app } : undefined;
}

/** The tag of notification `id` (one occurrence of a series carries its time). */
function tagOf(id: number, at?: number): string {
  return at === undefined ? `${TAG_PREFIX}${id}` : `${TAG_PREFIX}${id}-${at}`;
}

/** Whether `tag` belongs to notification `id`. */
function ownsTag(tag: string, id: number): boolean {
  return tag === tagOf(id) || tag.startsWith(`${tagOf(id)}-`);
}

/** The time of a scheduled entry, in ms. */
function atOf(entry: DesktopScheduledNotification): number {
  return entry.at instanceof Date ? entry.at.getTime() : Number(entry.at ?? 0);
}

/** The action buttons of a category, from the wire. */
function categoryActions(raw: unknown): DesktopNotificationAction[] {
  if (!Array.isArray(raw)) throw invalid("a category needs an actions array");
  return raw.map((a) => {
    const x = record(a, "action");
    if (typeof x.id !== "string" || x.id === "" || typeof x.title !== "string") {
      throw invalid("an action needs a string id and title");
    }
    return { action: x.id, title: x.title };
  });
}

/** The web key of a notification posted by `webShow` (from its data, else its tag), if it is one. */
function webKeyOf(data: unknown, tag: unknown): string | undefined {
  const w = (data as { denext?: { w?: unknown } } | null | undefined)?.denext?.w;
  if (typeof w === "string" && WEB_KEY.test(w)) return w;
  if (typeof tag !== "string" || !tag.startsWith(WEB_TAG_PREFIX)) return undefined;
  const key = tag.slice(WEB_TAG_PREFIX.length);
  return WEB_KEY.test(key) ? key : undefined;
}

/** A click on a web notification as the shim takes it, or `undefined` for any other click. */
function webTapOf(r: DesktopNotificationResponse): WebTapWire | undefined {
  const key = webKeyOf(r.data, r.tag);
  if (key === undefined) return undefined;
  return { key, action: typeof r.action === "string" ? r.action : "" };
}

/** A click as the page takes it, or `undefined` for a notification this capability did not post. */
function tapOf(r: DesktopNotificationResponse, launch: boolean): NotificationTapWire | undefined {
  if (webKeyOf(r.data, r.tag) !== undefined) return undefined;
  const found = metaOf(r.data, r.tag);
  if (!found) return undefined;
  const { meta, data } = found;
  return {
    id: meta.id,
    actionId: typeof r.action === "string" && r.action !== "" ? r.action : "tap",
    ...(typeof meta.t === "string" ? { title: meta.t } : {}),
    ...(typeof meta.b === "string" ? { body: meta.b } : {}),
    data,
    launch: launch || r.launch === true,
  };
}

/**
 * The notification permission without prompting: the Permissions API of the Deno process (the
 * pinned runtime answers `notifications` from the OS), else `Notification.permission`.
 */
async function queryPermission(): Promise<string> {
  try {
    const perms = (globalThis.navigator as { permissions?: Permissions } | undefined)?.permissions;
    const status = await perms?.query({ name: "notifications" as PermissionName });
    if (status?.state) return status.state;
  } catch {
    // Deno's own Permissions API does not know `notifications` outside a desktop window.
  }
  const cached = (globalThis as { Notification?: { permission?: string } }).Notification
    ?.permission;
  return cached === "granted" || cached === "denied" ? cached : "prompt";
}

/** The OS answer, or `undefined` once `ms` pass first (the timer is cleared either way). */
function withinBound<T>(answer: Promise<T>, ms: number): Promise<T | undefined> {
  let id: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<undefined>((resolve) => {
    id = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([answer, expiry]).finally(() => clearTimeout(id));
}

/**
 * The notification permission requests of one capability: at most one OS prompt at a time (a
 * request made while one is open shares it), each caller answered within `timeoutMs` — with the
 * state known so far when the OS has not answered — and the OS answer, however late, remembered
 * for the next caller.
 */
function permissionRequests(timeoutMs: number) {
  let open: Promise<string> | undefined;
  let answered: string | undefined;

  /** The state without prompting: the OS's when it is decided, else the last OS answer. */
  const query = async (): Promise<string> => {
    const state = await queryPermission();
    return state === "prompt" && answered !== undefined ? answered : state;
  };

  /** Ask the OS (once, however many callers), bounded. */
  const request = async (ask: () => Promise<string>): Promise<string> => {
    if (!open) {
      const asked = ask().then((state) => {
        answered = state;
        return state;
      });
      open = asked;
      // Settled either way: the next request asks again (the OS answers at once when decided).
      const settle = () => {
        if (open === asked) open = undefined;
      };
      asked.then(settle, settle);
    }
    return (await withinBound(open, timeoutMs)) ?? await query();
  };

  return { query, request };
}

/** One validated `schedule` call. */
interface ScheduleRequest {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, unknown>;
  readonly trigger?: LocalNotificationTrigger;
  readonly categoryId?: string;
}

/** The arguments of `schedule`, checked. */
function scheduleRequest(args: unknown): ScheduleRequest {
  const a = record(args, "arguments");
  const id = checked(() => int("schedule", "id", a.id, -0x80000000, 0x7fffffff));
  const categoryId = a.categoryId === undefined ? undefined : text(a.categoryId, "categoryId");
  return {
    id,
    title: text(a.title, "title"),
    body: text(a.body ?? "", "body"),
    data: record(a.data, "data"),
    trigger: triggerOf(a.trigger),
    ...(categoryId !== undefined ? { categoryId } : {}),
  };
}

/**
 * Build the `notifications` capability.
 *
 * @param options The runtime API, clock and fallbacks (tests).
 * @returns The capability.
 */
export function notificationsCapability(
  options: NotificationsCapabilityOptions = {},
): DesktopCapability {
  const api = () => options.api ?? desktopAppApi();
  const now = options.now ?? Date.now;
  const categories = new Map<string, DesktopNotificationAction[]>();
  let queue: PullQueue<NotificationTapWire> | undefined;
  let webQueue: PullQueue<WebTapWire> | undefined;
  let cancelTopUp: (() => void) | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const permission = permissionRequests(
    options.permissionTimeoutMs ?? PERMISSION_REQUEST_TIMEOUT_MS,
  );

  /** Run `fn` after every earlier scheduling change (they read and write the same list). */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  /** Our scheduled notifications. */
  const scheduled = async (n: DesktopNotificationsApi) =>
    (await n.getScheduled()).filter((e) =>
      typeof e.tag === "string" && e.tag.startsWith(TAG_PREFIX)
    );

  /** Cancel every scheduled (and delivered) notification of `id`. */
  const cancelId = async (n: DesktopNotificationsApi, id: number) => {
    for (const e of await scheduled(n)) if (ownsTag(e.tag, id)) n.cancel(e.tag);
    n.cancel(tagOf(id));
  };

  /** Queue a click on one of our notifications for the page (the app's, or a web one). */
  const route = (r: DesktopNotificationResponse, launch: boolean) => {
    const web = webTapOf(r);
    if (web) return void webQueue?.push(web);
    const tap = tapOf(r, launch);
    if (tap) queue?.push(tap);
  };

  /** Show now where the runtime cannot schedule: the Deno `Notification`, its clicks queued. */
  const showNow = (
    shown: { title: string; body: string; tag: string },
    actions: DesktopNotificationAction[],
    data: unknown,
  ) => {
    const Ctor = options.showNow ??
      (globalThis as { Notification?: NotificationCtor }).Notification;
    if (typeof Ctor !== "function") {
      throw new DesktopCapError("unsupported", "notifications cannot be shown here", {
        status: 501,
      });
    }
    const n = new Ctor(shown.title, { body: shown.body, tag: shown.tag, data, actions });
    const onResponse = (action: string | null) => route({ tag: shown.tag, action, data }, false);
    n.addEventListener("click", () => onResponse(null));
    n.addEventListener(
      "action",
      (e) => onResponse((e as Event & { action?: string }).action ?? null),
    );
  };

  /** Schedule one notification (every occurrence ahead, for a repeating one). */
  const schedule = async (req: ScheduleRequest): Promise<void> => {
    const n = nativeApi(api());
    const actions = req.categoryId ? categories.get(req.categoryId) ?? [] : [];
    const first = checked(() => firstAt(req.trigger, now()));
    if (first === null) throw invalid("the trigger never fires");
    await cancelId(n, req.id);
    const meta = { id: req.id, t: req.title, b: req.body };
    const can = n.capabilities?.() ?? {};
    if (!req.trigger && can.schedule === false) {
      return showNow({ ...req, tag: tagOf(req.id) }, actions, storedData(meta, req.data));
    }
    if (can.schedule === false) {
      throw new DesktopCapError("unsupported", "notifications cannot be scheduled here", {
        status: 501,
      });
    }
    if (!req.trigger || !repeats(req.trigger)) {
      const data = storedData(meta, req.data);
      await n.schedule({
        title: req.title,
        body: req.body,
        at: first,
        tag: tagOf(req.id),
        actions,
        data,
      });
      return;
    }
    const series: SeriesSpec = { trigger: req.trigger, anchor: first };
    const room = Math.max(1, MAX_PENDING - (await scheduled(n)).length);
    const times = [first, ...seriesTimes(series, first, Math.min(REPEAT_HORIZON, room) - 1)];
    const data = storedData({ ...meta, r: series }, req.data);
    for (const at of times) {
      await n.schedule({
        title: req.title,
        body: req.body,
        at,
        tag: tagOf(req.id, at),
        actions,
        data,
      });
    }
    armTopUp(times);
  };

  /** Schedule the next check of the repeating series, when half of `times` has fired. */
  const armTopUp = (times: number[]) => {
    if (times.length === 0) return;
    const due = times[Math.floor(times.length / 2)] - now();
    const delay = Math.min(Math.max(due, 1000), 6 * 3600 * 1000);
    cancelTopUp?.();
    cancelTopUp = (options.timer ?? unrefTimer)(() => void serial(topUp).catch(() => {}), delay);
  };

  /** Schedule the missing occurrences of one series (at most `room`); returns all its times. */
  const topUpSeries = async (
    n: DesktopNotificationsApi,
    entries: DesktopScheduledNotification[],
    room: number,
  ): Promise<{ times: number[]; added: number }> => {
    const times = entries.map(atOf).sort((a, b) => a - b);
    const sample = entries[0];
    const { meta } = metaOf(sample.data, sample.tag)!;
    const need = Math.min(REPEAT_HORIZON - times.length, room);
    const more = need > 0 ? seriesTimes(meta.r!, times[times.length - 1], need) : [];
    for (const at of more) {
      await n.schedule({
        title: sample.title ?? "",
        body: sample.body ?? "",
        at,
        tag: tagOf(meta.id, at),
        actions: sample.actions ?? [],
        data: sample.data,
      });
    }
    return { times: [...times, ...more], added: more.length };
  };

  /** Keep every repeating series {@linkcode REPEAT_HORIZON} occurrences ahead. */
  const topUp = async (): Promise<void> => {
    const n = nativeApi(api());
    const list = await scheduled(n);
    const bySeries = new Map<number, DesktopScheduledNotification[]>();
    for (const e of list) {
      const found = metaOf(e.data, e.tag);
      if (found?.meta.r) bySeries.set(found.meta.id, [...bySeries.get(found.meta.id) ?? [], e]);
    }
    let room = MAX_PENDING - list.length;
    let soonest: number[] | undefined;
    const middle = (t: number[]) => t[Math.floor(t.length / 2)];
    for (const entries of bySeries.values()) {
      const { times, added } = await topUpSeries(n, entries, room);
      room -= added;
      if (!soonest || middle(times) < middle(soonest)) soonest = times;
    }
    if (soonest) armTopUp(soonest);
  };

  /**
   * Start queueing clicks (once): the cold-start ones first, then the live event. The app's go to
   * `take` (signalled by `tap`), the page's web notifications' to `webTake` (`webtap`).
   */
  const install = (ctx: DesktopCapCtx) => {
    if (queue && webQueue) return { queue, webQueue };
    queue = createPullQueue<NotificationTapWire>(() => ctx.emit("tap", null));
    webQueue = createPullQueue<WebTapWire>(() => ctx.emit("webtap", null));
    const a = api();
    const launched = a?.launchNotificationResponses;
    for (const r of Array.isArray(launched) ? launched : []) route(r, true);
    a?.addEventListener?.(
      "notificationresponse",
      (e) => route((e as CustomEvent).detail ?? {}, false),
    );
    return { queue, webQueue };
  };

  /** Post a web notification now (`webShow`), replacing one with the same key. */
  const webShow = async (req: { key: string; title: string; body: string }) => {
    const n = nativeApi(api());
    const tag = `${WEB_TAG_PREFIX}${req.key}`;
    const data = { denext: { w: req.key } };
    n.cancel(tag);
    if ((n.capabilities?.() ?? {}).schedule === false) {
      return showNow({ title: req.title, body: req.body, tag }, [], data);
    }
    await n.schedule({ title: req.title, body: req.body, at: now(), tag, actions: [], data });
  };

  if (options.autoTopUp !== false && api()?.notifications) {
    queueMicrotask(() => void serial(topUp).catch(() => {}));
  }

  return {
    name: "notifications",
    methods: {
      capabilities: {
        handler: async () => ({
          ...nativeApi(api()).capabilities(),
          categories: true,
          ...await notificationFacts(api()),
        }),
      },
      // Posting an OS notification needs an UNSCOPED `--allow-sys` under the pinned runtime.
      schedule: {
        permissions: { sys: ["*"] },
        handler: async (args) => {
          const req = scheduleRequest(args);
          await serial(() => schedule(req));
          return { id: req.id };
        },
      },
      cancel: {
        handler: async (args) => {
          const ids = (record(args, "arguments").ids ?? []) as unknown;
          if (!Array.isArray(ids)) throw invalid("ids must be an array");
          const n = nativeApi(api());
          await serial(async () => {
            for (const id of ids) {
              await cancelId(n, checked(() => int("cancel", "id", id, -0x80000000, 0x7fffffff)));
            }
          });
          return null;
        },
      },
      pending: {
        handler: async () => {
          const seen = new Set<number>();
          const out: Array<{ id: number; title: string; body: string; extra: unknown }> = [];
          const list = (await scheduled(nativeApi(api()))).sort((a, b) => atOf(a) - atOf(b));
          for (const e of list) {
            const found = webKeyOf(e.data, e.tag) === undefined ? metaOf(e.data, e.tag) : undefined;
            if (!found || seen.has(found.meta.id)) continue;
            seen.add(found.meta.id);
            out.push({
              id: found.meta.id,
              title: e.title ?? "",
              body: e.body ?? "",
              extra: found.data,
            });
          }
          return out;
        },
      },
      setCategories: {
        handler: (args) => {
          nativeApi(api());
          const list = record(args, "arguments").categories;
          if (!Array.isArray(list)) throw invalid("categories must be an array");
          const next = new Map<string, DesktopNotificationAction[]>();
          for (const c of list) {
            const x = record(c, "category");
            next.set(text(x.id, "category id"), categoryActions(x.actions));
          }
          categories.clear();
          for (const [id, actions] of next) categories.set(id, actions);
          return null;
        },
      },
      permission: {
        // The handler bounds a prompting request itself (`permissionTimeoutMs`), then answers with
        // the state known so far; the bridge's own timeout would answer `timeout` instead.
        timeoutMs: false,
        handler: async (args) => {
          const n = nativeApi(api());
          const a = record(args, "arguments");
          const state = a.request === true
            ? await permission.request(() =>
              n.requestPermission(a.provisional === true ? { provisional: true } : undefined)
            )
            : await permission.query();
          return { state };
        },
      },
      take: {
        handler: (_args, ctx) => {
          nativeApi(api());
          return install(ctx).queue.take();
        },
      },
      // The page's web `Notification` (the injected shim): show now, close, and its clicks.
      webShow: {
        permissions: { sys: ["*"] },
        handler: async (args, ctx) => {
          const a = record(args, "arguments");
          if (typeof a.key !== "string" || !WEB_KEY.test(a.key)) {
            throw invalid("key must be 1-64 letters, digits, '-' or '_'");
          }
          const req = {
            key: a.key,
            title: text(a.title, "title"),
            body: text(a.body ?? "", "body"),
          };
          install(ctx);
          await serial(() => webShow(req));
          return null;
        },
      },
      webClose: {
        handler: (args) => {
          const key = record(args, "arguments").key;
          if (typeof key !== "string" || !WEB_KEY.test(key)) throw invalid("key is malformed");
          nativeApi(api()).cancel(`${WEB_TAG_PREFIX}${key}`);
          return null;
        },
      },
      webTake: {
        handler: (_args, ctx) => {
          nativeApi(api());
          return install(ctx).webQueue.take();
        },
      },
    },
    events: ["tap", "webtap"],
  };
}
