/**
 * `expo-widgets` for denext, over `denext/mobile`'s home-screen widgets and Live Activities
 * (`denext mobile add widget --name <Name>` / `live-activity --name <Name>` install the native
 * side). The widget's and the Live Activity's UI are the generated SwiftUI files, not the
 * `"widget"` layout function: that function is kept but never rendered, and the props an update
 * passes are the JSON snapshot (a widget) or the state (a Live Activity) the native UI reads.
 *
 * - `Widget.updateSnapshot(props)` is `setWidgetData(name, props)`; `updateTimeline(entries)`
 *   stores the entry that applies now (later entries are not scheduled natively); `reload()` is
 *   `reloadWidgets(name)`.
 * - `LiveActivityFactory.start(props)` is `startLiveActivity(name, {}, props, { push: true })`
 *   (retried without push when the app has no push entitlement); it returns at once, and the
 *   activity's id is known once ActivityKit has started it. `getInstances()` returns the
 *   activities known so far and refreshes the list from ActivityKit in the background.
 * - The push token listeners are `onLiveActivityPushToken` / `onLiveActivityPushToStartToken`.
 *
 * On the web (and in a shell without the plugins) widget updates do nothing, `start` throws, and
 * the listeners are never called, as before. Widget taps (`addUserInteractionListener`) never
 * fire: the generated widgets open the app instead.
 *
 * @example
 * ```ts
 * import { createLiveActivity, createWidget } from "denext/expo/widgets";
 *
 * const usage = createWidget("Usage", layout);
 * usage.updateSnapshot({ title: "Weekly", body: "41% left" });
 * const activity = createLiveActivity("AgentWork", liveLayout).start({ title: "Running" });
 * ```
 *
 * @module
 */

import { type Subscription, subscription } from "./internal/common.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import { reloadWidgets, setWidgetData } from "../mobile/widgets.ts";
import {
  endLiveActivity,
  listLiveActivities,
  type LiveActivityError,
  liveActivityPushToken,
  type LiveActivityValues,
  onLiveActivityPushToken,
  onLiveActivityPushToStartToken,
  startLiveActivity,
  updateLiveActivity,
} from "../mobile/live-activity.ts";

export type { Subscription };

/** A widget's timeline entry. */
export interface WidgetTimelineEntry<T extends object = object> {
  /** When the entry applies. */
  date: Date;
  /** The widget's props at that time. */
  props: T;
}

/** What a widget layout receives besides its props (never rendered here). */
export type WidgetEnvironment<T extends object | undefined = undefined> = {
  /** The date of the timeline entry. */
  date: Date;
  /** The widget family. */
  widgetFamily: string;
  /** The widget's configuration (a configurable widget's chosen values). */
  configuration: T;
  /** Other environment values. */
  [key: string]: unknown;
};

/** A Live Activity layout function (never rendered here). */
export type LiveActivityComponent<T extends object = object> = (
  props: T,
  environment: Record<string, unknown>,
) => unknown;

/** How an ended Live Activity is dismissed: at once, the system's default, or at a time. */
export type LiveActivityDismissalPolicy = "default" | "immediate" | { after: Date };

/** A Live Activity push token event. */
export interface PushTokenEvent {
  /** The Live Activity's id. */
  activityId: string;
  /** The token (hex). */
  pushToken: string;
}

/** A push-to-start token event (iOS 17.2+). */
export interface PushToStartTokenEvent {
  /** The token (hex) a server starts Live Activities with. */
  activityPushToStartToken: string;
}

/** A widget interaction event (never emitted here). */
export interface UserInteractionEvent {
  /** The widget. */
  source: string;
  /** The button or toggle. */
  target: string;
  /** When. */
  timestamp: number;
  /** The event type. */
  type: "ExpoWidgetsUserInteraction";
}

/** Report a background widget / Live Activity failure (Expo's calls are fire-and-forget). */
function report(what: string, err: unknown): void {
  console.warn(`denext/expo/widgets: ${what} failed`, err);
}

/** A home-screen widget: its updates store the JSON snapshot the native widget renders. */
export class Widget<
  PropsType extends object = object,
  _ConfigurationType extends object | undefined = undefined,
> {
  /** The widget's name (its kind: the `--name` it was added with). */
  readonly name: string;
  #timeline: WidgetTimelineEntry<PropsType>[] = [];

  /**
   * Create it.
   *
   * @param name The widget's name.
   * @param _layout Its layout (never rendered: the native widget draws the snapshot).
   */
  constructor(name: string, _layout: (props: PropsType, environment: never) => unknown) {
    this.name = name;
  }

  /** Ask the OS to redraw the widget from its stored snapshot. */
  reload(): void {
    reloadWidgets(this.name).catch((err) => report(`reload of widget ${this.name}`, err));
  }

  /**
   * Replace the timeline: stores the entry that applies now (the latest one not in the future,
   * else the earliest) as the snapshot. Later entries are kept for {@linkcode getTimeline} but
   * not scheduled natively.
   *
   * @param entries The entries.
   */
  updateTimeline(entries: WidgetTimelineEntry<PropsType>[]): void {
    const sorted = [...entries].sort((a, b) => a.date.getTime() - b.date.getTime());
    this.#timeline = sorted;
    const now = Date.now();
    const current = sorted.filter((e) => e.date.getTime() <= now).at(-1) ?? sorted[0];
    if (current) this.#store(current.props);
  }

  /**
   * Replace the snapshot.
   *
   * @param props The props the native widget shows.
   */
  updateSnapshot(props: PropsType): void {
    this.#timeline = [{ date: new Date(), props }];
    this.#store(props);
  }

  /**
   * The timeline this app set in this session.
   *
   * @returns The entries.
   */
  getTimeline(): Promise<WidgetTimelineEntry<PropsType>[]> {
    return Promise.resolve([...this.#timeline]);
  }

  #store(props: PropsType): void {
    setWidgetData(this.name, props).catch((err) => report(`update of widget ${this.name}`, err));
  }
}

/** Called when an activity ends, to drop it from its factory's instances. */
const onEnded = new WeakMap<object, () => void>();

/** Whether a rejection means "no token here", which Expo reports as `null`. */
function noToken(err: unknown): boolean {
  const code = (err as Partial<LiveActivityError> | undefined)?.code;
  return code === "timeout" || code === "not_found" || code === "unsupported";
}

/** The ActivityKit dismissal for an Expo policy. */
function dismissalOf(policy: LiveActivityDismissalPolicy | undefined) {
  return typeof policy === "object" && policy !== null ? policy.after : policy ?? "default";
}

/** A running Live Activity. */
export class LiveActivity<T extends object = object> {
  #id = "";
  readonly #ready: Promise<string>;

  /**
   * Create it.
   *
   * @param id The activity's id, or the promise of it while it is starting.
   */
  constructor(id: string | Promise<string>) {
    if (typeof id === "string") this.#id = id;
    this.#ready = Promise.resolve(id);
    this.#ready.then(
      (value) => void (this.#id = value),
      (err) => report("Live Activity start", err),
    );
  }

  /**
   * The activity's ActivityKit id.
   *
   * @returns The id; `""` until ActivityKit has started it.
   */
  getId(): string {
    return this.#id;
  }

  /**
   * Replace its state.
   *
   * @param props The state the native UI shows.
   * @param _staleDate Not passed on (the activity never goes stale).
   * @returns A promise that settles once ActivityKit has it.
   */
  async update(props: T, _staleDate?: Date): Promise<void> {
    await updateLiveActivity(await this.#ready, props as LiveActivityValues);
  }

  /**
   * End it.
   *
   * @param dismissalPolicy When it leaves the Lock Screen.
   * @param props A final state.
   * @param _contentDate Not passed on.
   * @returns A promise that settles once it has ended.
   */
  async end(
    dismissalPolicy?: LiveActivityDismissalPolicy,
    props?: T,
    _contentDate?: Date,
  ): Promise<void> {
    const id = await this.#ready;
    await endLiveActivity(id, {
      ...(props === undefined ? {} : { state: props as LiveActivityValues }),
      dismissal: dismissalOf(dismissalPolicy),
    });
    onEnded.get(this)?.();
  }

  /**
   * Its push token, if ActivityKit has issued one.
   *
   * @returns The hex token, or `null` (not issued yet, no push entitlement, or ended).
   */
  async getPushToken(): Promise<string | null> {
    try {
      return await liveActivityPushToken(await this.#ready, { timeoutMs: 0 });
    } catch (err) {
      if (noToken(err)) return null;
      throw err;
    }
  }

  /**
   * Listen for its push tokens.
   *
   * @param listener Called with each token ActivityKit issues it.
   * @returns A subscription to remove.
   */
  addPushTokenListener(listener: (event: PushTokenEvent) => void): Subscription {
    return subscription(onLiveActivityPushToken(({ id, token }) => {
      if (id === this.#id) listener({ activityId: id, pushToken: token });
    }));
  }
}

/** Starts and lists the Live Activities of one name. */
export class LiveActivityFactory<T extends object = object> {
  /** The Live Activity name (its `--name`). */
  readonly name: string;
  #instances: LiveActivity<T>[] = [];
  #refreshing = false;

  /**
   * Create it, and read the activities of this name already running.
   *
   * @param name The Live Activity name.
   * @param _layout Its layout (never rendered: the generated SwiftUI UI draws it).
   */
  constructor(name: string, _layout: LiveActivityComponent<T>) {
    this.name = name;
    this.#refresh();
  }

  /**
   * Start an activity with `props` as its state.
   *
   * @param props The first state.
   * @param _url Not passed on (the activity opens the app).
   * @param _staleDate Not passed on.
   * @returns The activity; its id is known once ActivityKit has started it.
   * @throws {Error} Outside the iOS app with the DenextLiveActivity plugin.
   */
  start(props: T, _url?: string, _staleDate?: Date): LiveActivity<T> {
    if (!nativePlugin("DenextLiveActivity", ["start"])) {
      throw new Error(
        `Live Activity "${this.name}" cannot start: Live Activities need the iOS app with the ` +
          "DenextLiveActivity plugin (denext mobile add live-activity)",
      );
    }
    const state = props as LiveActivityValues;
    const id = startLiveActivity(this.name, {}, state, { push: true }).catch((err) =>
      (err as LiveActivityError).code === "failed"
        ? startLiveActivity(this.name, {}, state)
        : Promise.reject(err)
    );
    const activity = this.#track(new LiveActivity<T>(id));
    id.catch(() => this.#drop(activity));
    return activity;
  }

  /**
   * The running activities of this name known so far. Each call also refreshes the list from
   * ActivityKit in the background (activities started earlier, by a push, or ended elsewhere).
   *
   * @returns The activities.
   */
  getInstances(): LiveActivity<T>[] {
    this.#refresh();
    return [...this.#instances];
  }

  #track(activity: LiveActivity<T>): LiveActivity<T> {
    this.#instances.push(activity);
    onEnded.set(activity, () => this.#drop(activity));
    return activity;
  }

  #drop(activity: LiveActivity<T>): void {
    this.#instances = this.#instances.filter((a) => a !== activity);
  }

  #refresh(): void {
    // A plugin installed before list() existed cannot tell what runs: keep what is known.
    if (this.#refreshing || !nativePlugin("DenextLiveActivity", ["list"])) return;
    this.#refreshing = true;
    listLiveActivities().then((running) => {
      const ids = new Set(running.filter((a) => a.name === this.name).map((a) => a.id));
      // Keep the ones still starting (no id yet) and the ones still running.
      this.#instances = this.#instances.filter((a) => a.getId() === "" || ids.has(a.getId()));
      const known = new Set(this.#instances.map((a) => a.getId()));
      for (const id of ids) if (!known.has(id)) this.#track(new LiveActivity<T>(id));
    }).catch((err) => report("listing Live Activities", err)).finally(() => {
      this.#refreshing = false;
    });
  }
}

/**
 * Declare a widget.
 *
 * @param name The widget's name (its `--name`).
 * @param widget Its layout (never rendered).
 * @returns The widget.
 */
export function createWidget<
  PropsType extends object = object,
  ConfigurationType extends object | undefined = undefined,
>(
  name: string,
  widget: (props: PropsType, context: WidgetEnvironment<ConfigurationType>) => unknown,
): Widget<PropsType, ConfigurationType> {
  return new Widget(name, widget as (props: PropsType, environment: never) => unknown);
}

/**
 * Declare a Live Activity name.
 *
 * @param name The Live Activity name (its `--name`).
 * @param liveActivity Its layout (never rendered).
 * @returns The factory.
 */
export function createLiveActivity<T extends object = object>(
  name: string,
  liveActivity: LiveActivityComponent<T>,
): LiveActivityFactory<T> {
  return new LiveActivityFactory(name, liveActivity);
}

/**
 * A dismissal policy: remove the ended activity at `date` (iOS caps it at four hours).
 *
 * @param date When.
 * @returns The policy.
 */
export function after(date: Date): { after: Date } {
  return { after: date };
}

/**
 * Listen for widget taps: never called here (the generated widgets open the app).
 *
 * @param _listener The listener.
 * @returns A subscription to remove.
 */
export function addUserInteractionListener(
  _listener: (event: UserInteractionEvent) => void,
): Subscription {
  return subscription(() => {});
}

/**
 * Listen for the push-to-start tokens ActivityKit issues the app (iOS 17.2+), the current one
 * included.
 *
 * @param listener Called with each token.
 * @returns A subscription to remove.
 */
export function addPushToStartTokenListener(
  listener: (event: PushToStartTokenEvent) => void,
): Subscription {
  return subscription(
    onLiveActivityPushToStartToken(({ token }) => listener({ activityPushToStartToken: token })),
  );
}

/** The shared widgets folder: none here (widgets read the JSON snapshot, not files). */
export const widgetsDirectory = "";
