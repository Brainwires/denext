/**
 * The `notifications` capability: `denext/mobile`'s local notifications as the OS's own, through
 * `Deno.desktop.notifications` (denext's pinned Deno Desktop runtime) — shown now or at a time,
 * repeating, cancelled and listed, with action buttons (`setNotificationCategories`), the
 * permission status, and clicks routed to `onLocalNotificationTapped`, including the click that
 * launched the app.
 *
 * Mechanisms (the runtime's): macOS `UNUserNotificationCenter`, Windows toasts
 * (`ScheduledToastNotification`), Linux `org.freedesktop.Notifications` with the runtime's own timer
 * (it delivers while the app runs and re-arms at the next launch).
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

/** A click as the page takes it, or `undefined` for a notification this capability did not post. */
function tapOf(r: DesktopNotificationResponse, launch: boolean): NotificationTapWire | undefined {
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
  let cancelTopUp: (() => void) | undefined;
  let chain: Promise<unknown> = Promise.resolve();

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

  /** Show now where the runtime cannot schedule: the Deno `Notification`, its clicks queued. */
  const showNow = (req: ScheduleRequest, actions: DesktopNotificationAction[], data: unknown) => {
    const Ctor = options.showNow ??
      (globalThis as { Notification?: NotificationCtor }).Notification;
    if (typeof Ctor !== "function") {
      throw new DesktopCapError("unsupported", "notifications cannot be shown here", {
        status: 501,
      });
    }
    const shown = new Ctor(req.title, { body: req.body, tag: tagOf(req.id), data, actions });
    const onResponse = (action: string | null) => {
      const tap = tapOf({ tag: tagOf(req.id), action, data }, false);
      if (tap) queue?.push(tap);
    };
    shown.addEventListener("click", () => onResponse(null));
    shown.addEventListener(
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
      return showNow(req, actions, storedData(meta, req.data));
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

  /** Start queueing clicks (once): the cold-start ones first, then the live event. */
  const install = (ctx: DesktopCapCtx): PullQueue<NotificationTapWire> => {
    if (queue) return queue;
    const q = createPullQueue<NotificationTapWire>(() => ctx.emit("tap", null));
    queue = q;
    const a = api();
    const launched = a?.launchNotificationResponses;
    for (const r of Array.isArray(launched) ? launched : []) {
      const tap = tapOf(r, true);
      if (tap) q.push(tap);
    }
    a?.addEventListener?.("notificationresponse", (e) => {
      const tap = tapOf((e as CustomEvent).detail ?? {}, false);
      if (tap) q.push(tap);
    });
    return q;
  };

  if (options.autoTopUp !== false && api()?.notifications) {
    queueMicrotask(() => void serial(topUp).catch(() => {}));
  }

  return {
    name: "notifications",
    methods: {
      capabilities: {
        handler: () => ({ ...nativeApi(api()).capabilities(), categories: true }),
      },
      schedule: {
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
            const found = metaOf(e.data, e.tag);
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
        timeoutMs: false,
        handler: async (args) => {
          const n = nativeApi(api());
          const a = record(args, "arguments");
          const state = a.request === true
            ? await n.requestPermission(a.provisional === true ? { provisional: true } : undefined)
            : await queryPermission();
          return { state };
        },
      },
      take: {
        handler: (_args, ctx) => {
          nativeApi(api());
          return install(ctx).take();
        },
      },
    },
    events: ["tap"],
  };
}
