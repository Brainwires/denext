/**
 * `expo-widgets` for denext: a stub. Home-screen widgets and Live Activities are native
 * iOS extensions with no web or Capacitor counterpart here. The factories return objects
 * whose updates do nothing, so modules that declare widgets at import time load; starting a
 * Live Activity throws, and the listeners are never called.
 *
 * @example
 * ```ts
 * import { createLiveActivity } from "denext/expo/widgets";
 *
 * const activity = createLiveActivity("AgentWork", layout); // inert
 * activity.getInstances(); // []
 * ```
 *
 * @module
 */

import { type Subscription, subscription } from "./internal/common.ts";

export type { Subscription };

/** A widget's timeline entry. */
export interface WidgetTimelineEntry<T extends object = object> {
  /** When the entry applies. */
  date: Date;
  /** The widget's props at that time. */
  props: T;
}

/** What a widget layout receives besides its props. */
export type WidgetEnvironment<T extends object | undefined = undefined> = {
  /** The widget family. */
  widgetFamily: string;
  /** The widget's configuration. */
  configuration?: T;
  /** Other environment values. */
  [key: string]: unknown;
};

/** A Live Activity layout function. */
export type LiveActivityComponent<T extends object = object> = (
  props: T,
  environment: Record<string, unknown>,
) => unknown;

/** How an ended Live Activity is dismissed. */
export type LiveActivityDismissalPolicy = "default" | "immediate" | { after: Date };

/** A Live Activity push token event. */
export interface PushTokenEvent {
  /** The token. */
  pushToken: string;
}

/** A home-screen widget (inert here). */
export class Widget<
  PropsType extends object = object,
  _ConfigurationType extends object | undefined = undefined,
> {
  /** The widget's name. */
  readonly name: string;

  /**
   * Create it.
   *
   * @param name The widget's name.
   * @param _layout Its layout (never rendered here).
   */
  constructor(name: string, _layout: (props: PropsType, environment: never) => unknown) {
    this.name = name;
  }

  /** Reload the widget: does nothing. */
  reload(): void {}

  /** Replace the timeline: does nothing. */
  updateTimeline(_entries: WidgetTimelineEntry<PropsType>[]): void {}

  /** Replace the snapshot: does nothing. */
  updateSnapshot(_props: PropsType): void {}

  /** The timeline: empty. */
  getTimeline(): Promise<WidgetTimelineEntry<PropsType>[]> {
    return Promise.resolve([]);
  }
}

/** A running Live Activity (none can start here). */
export class LiveActivity<T extends object = object> {
  /**
   * Create it.
   *
   * @param id The activity's id.
   */
  constructor(private readonly id: string) {}

  /** The activity's id. */
  getId(): string {
    return this.id;
  }

  /** Update it: does nothing. */
  update(_props: T, _staleDate?: Date): Promise<void> {
    return Promise.resolve();
  }

  /** End it: does nothing. */
  end(
    _dismissalPolicy?: LiveActivityDismissalPolicy,
    _props?: T,
    _contentDate?: Date,
  ): Promise<void> {
    return Promise.resolve();
  }

  /** Its push token: none. */
  getPushToken(): Promise<string | null> {
    return Promise.resolve(null);
  }

  /** Listen for push tokens: never called. */
  addPushTokenListener(_listener: (event: PushTokenEvent) => void): Subscription {
    return subscription(() => {});
  }
}

/** Starts Live Activities of one kind (none can start here). */
export class LiveActivityFactory<T extends object = object> {
  /** The activity kind's name. */
  readonly name: string;

  /**
   * Create it.
   *
   * @param name The kind's name.
   * @param _layout Its layout (never rendered here).
   */
  constructor(name: string, _layout: LiveActivityComponent<T>) {
    this.name = name;
  }

  /** Start an activity: not possible here, so it throws. */
  start(_props: T, _url?: string, _staleDate?: Date): LiveActivity<T> {
    throw new Error(
      `Live Activity "${this.name}" cannot start: Live Activities are native iOS only`,
    );
  }

  /** The running activities: none. */
  getInstances(): LiveActivity<T>[] {
    return [];
  }
}

/**
 * Declare a widget (inert here).
 *
 * @param name The widget's name.
 * @param widget Its layout.
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
 * Declare a Live Activity kind (inert here).
 *
 * @param name The kind's name.
 * @param liveActivity Its layout.
 * @returns The factory.
 */
export function createLiveActivity<T extends object = object>(
  name: string,
  liveActivity: LiveActivityComponent<T>,
): LiveActivityFactory<T> {
  return new LiveActivityFactory(name, liveActivity);
}

/**
 * A timeline policy: refresh after `date`.
 *
 * @param date When.
 * @returns The policy.
 */
export function after(date: Date): { after: Date } {
  return { after: date };
}

/**
 * Listen for widget taps: never called here.
 *
 * @param _listener The listener.
 * @returns A subscription to remove.
 */
export function addUserInteractionListener(_listener: (event: unknown) => void): Subscription {
  return subscription(() => {});
}

/**
 * Listen for push-to-start tokens: never called here.
 *
 * @param _listener The listener.
 * @returns A subscription to remove.
 */
export function addPushToStartTokenListener(_listener: (event: unknown) => void): Subscription {
  return subscription(() => {});
}

/** The shared widgets folder: none here. */
export const widgetsDirectory = "";
