/**
 * `expo-screen-orientation` for denext: the same API over `denext/mobile`'s
 * {@linkcode lockOrientation} / {@linkcode unlockOrientation} / {@linkcode getOrientation} /
 * {@linkcode onOrientationChange} (`@capacitor/screen-orientation` in the Capacitor shell:
 * `denext mobile add screen-orientation`; the Screen Orientation API in a browser, where a lock
 * usually needs fullscreen). `OrientationLock.OTHER` / `UNKNOWN` and
 * `lockPlatformAsync`'s Android constant are not lockable; the iOS size classes are
 * `UNKNOWN`.
 *
 * @example
 * ```ts
 * import * as ScreenOrientation from "denext/expo/screen-orientation";
 *
 * await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
 * ```
 *
 * @module
 */

import {
  getOrientation,
  lockOrientation,
  onOrientationChange,
  type Orientation as DenextOrientation,
  type OrientationLock as DenextLock,
  unlockOrientation,
} from "../mobile/screen-orientation.ts";
import { createEmitter, type Emitter, type Subscription } from "./internal/common.ts";

export type { Subscription };

/** The screen's orientation. */
export enum Orientation {
  /** Not known. */
  UNKNOWN = 0,
  /** Portrait, right way up. */
  PORTRAIT_UP = 1,
  /** Portrait, upside down. */
  PORTRAIT_DOWN = 2,
  /** Landscape, turned left. */
  LANDSCAPE_LEFT = 3,
  /** Landscape, turned right. */
  LANDSCAPE_RIGHT = 4,
}

/** What {@linkcode lockAsync} locks to. */
export enum OrientationLock {
  /** The app's default (every orientation it allows). */
  DEFAULT = 0,
  /** Every orientation. */
  ALL = 1,
  /** Either portrait. */
  PORTRAIT = 2,
  /** Portrait, right way up. */
  PORTRAIT_UP = 3,
  /** Portrait, upside down. */
  PORTRAIT_DOWN = 4,
  /** Either landscape. */
  LANDSCAPE = 5,
  /** Landscape, turned left. */
  LANDSCAPE_LEFT = 6,
  /** Landscape, turned right. */
  LANDSCAPE_RIGHT = 7,
  /** A platform-specific lock (not lockable here). */
  OTHER = 8,
  /** Not known (not lockable). */
  UNKNOWN = 9,
}

/** iOS size classes (always `UNKNOWN` here). */
export enum SizeClassIOS {
  /** Not known. */
  UNKNOWN = 0,
  /** Compact. */
  COMPACT = 1,
  /** Regular. */
  REGULAR = 2,
}

/** The web's orientation lock names. */
export enum WebOrientationLock {
  /** Portrait, right way up. */
  PORTRAIT_PRIMARY = "portrait-primary",
  /** Portrait, upside down. */
  PORTRAIT_SECONDARY = "portrait-secondary",
  /** Either portrait. */
  PORTRAIT = "portrait",
  /** Landscape, primary. */
  LANDSCAPE_PRIMARY = "landscape-primary",
  /** Landscape, secondary. */
  LANDSCAPE_SECONDARY = "landscape-secondary",
  /** Either landscape. */
  LANDSCAPE = "landscape",
  /** Any. */
  ANY = "any",
  /** The device's natural orientation. */
  NATURAL = "natural",
  /** Not known. */
  UNKNOWN = "unknown",
}

/** The web's orientation names. */
export enum WebOrientation {
  /** Portrait, right way up. */
  PORTRAIT_PRIMARY = "portrait-primary",
  /** Portrait, upside down. */
  PORTRAIT_SECONDARY = "portrait-secondary",
  /** Landscape, primary. */
  LANDSCAPE_PRIMARY = "landscape-primary",
  /** Landscape, secondary. */
  LANDSCAPE_SECONDARY = "landscape-secondary",
}

/** A platform lock ({@linkcode lockPlatformAsync}). */
export type PlatformOrientationInfo = {
  /** Android's `ActivityInfo` constant (not lockable here). */
  screenOrientationConstantAndroid?: number;
  /** iOS: the allowed orientations (the first one's family is locked). */
  screenOrientationArrayIOS?: Orientation[];
  /** The web lock. */
  screenOrientationLockWeb?: WebOrientationLock;
};

/** The orientation and (iOS) size classes. */
export type ScreenOrientationInfo = {
  /** The orientation. */
  orientation: Orientation;
  /** iOS vertical size class. */
  verticalSizeClass?: SizeClassIOS;
  /** iOS horizontal size class. */
  horizontalSizeClass?: SizeClassIOS;
};

/** What an orientation listener receives. */
export type OrientationChangeEvent = {
  /** The lock in force. */
  orientationLock: OrientationLock;
  /** The new orientation. */
  orientationInfo: ScreenOrientationInfo;
};

/** An orientation listener. */
export type OrientationChangeListener = (event: OrientationChangeEvent) => void;

/** denext's lock for each lockable Expo lock. */
const LOCKS: Readonly<Partial<Record<OrientationLock, DenextLock>>> = {
  [OrientationLock.DEFAULT]: "any",
  [OrientationLock.ALL]: "any",
  [OrientationLock.PORTRAIT]: "portrait",
  [OrientationLock.PORTRAIT_UP]: "portrait-primary",
  [OrientationLock.PORTRAIT_DOWN]: "portrait-secondary",
  [OrientationLock.LANDSCAPE]: "landscape",
  [OrientationLock.LANDSCAPE_LEFT]: "landscape-primary",
  [OrientationLock.LANDSCAPE_RIGHT]: "landscape-secondary",
};

/** Expo's orientation for denext's. */
function toOrientation(o: DenextOrientation): Orientation {
  switch (o) {
    case "portrait-primary":
      return Orientation.PORTRAIT_UP;
    case "portrait-secondary":
      return Orientation.PORTRAIT_DOWN;
    case "landscape-primary":
      return Orientation.LANDSCAPE_LEFT;
    case "landscape-secondary":
      return Orientation.LANDSCAPE_RIGHT;
    default:
      return Orientation.UNKNOWN;
  }
}

/** The lock last applied through this module. */
let currentLock = OrientationLock.DEFAULT;

/**
 * Lock the screen to `orientationLock`.
 *
 * @param orientationLock The lock.
 * @returns Settles once locked; rejects for a lock that is not lockable here.
 */
export async function lockAsync(orientationLock: OrientationLock): Promise<void> {
  const lock = LOCKS[orientationLock];
  if (!lock) {
    throw new TypeError(`expo-screen-orientation: lock ${orientationLock} is not supported`);
  }
  if (orientationLock === OrientationLock.DEFAULT) await unlockOrientation();
  else await lockOrientation(lock);
  currentLock = orientationLock;
}

/**
 * Lock with a platform-specific description: the web lock, else the first iOS orientation.
 *
 * @param options The platform lock.
 * @returns Settles once locked.
 */
export async function lockPlatformAsync(options: PlatformOrientationInfo): Promise<void> {
  const web = options.screenOrientationLockWeb;
  if (web && web !== WebOrientationLock.UNKNOWN) {
    await lockOrientation(web as DenextLock);
    currentLock = OrientationLock.OTHER;
    return;
  }
  const first = options.screenOrientationArrayIOS?.[0];
  const lock = first === Orientation.PORTRAIT_UP
    ? OrientationLock.PORTRAIT_UP
    : first === Orientation.PORTRAIT_DOWN
    ? OrientationLock.PORTRAIT_DOWN
    : first === Orientation.LANDSCAPE_LEFT
    ? OrientationLock.LANDSCAPE_LEFT
    : first === Orientation.LANDSCAPE_RIGHT
    ? OrientationLock.LANDSCAPE_RIGHT
    : null;
  if (lock === null) {
    throw new TypeError("expo-screen-orientation: lockPlatformAsync needs a web or iOS lock");
  }
  await lockAsync(lock);
}

/**
 * Release the lock.
 *
 * @returns Settles once unlocked.
 */
export async function unlockAsync(): Promise<void> {
  await unlockOrientation();
  currentLock = OrientationLock.DEFAULT;
}

/**
 * The current orientation.
 *
 * @returns The orientation.
 */
export async function getOrientationAsync(): Promise<Orientation> {
  return toOrientation(await getOrientation());
}

/**
 * The lock applied through this module (`DEFAULT` until one is).
 *
 * @returns The lock.
 */
export function getOrientationLockAsync(): Promise<OrientationLock> {
  return Promise.resolve(currentLock);
}

/**
 * The platform lock: the web lock name of the current lock.
 *
 * @returns The platform lock.
 */
export function getPlatformOrientationLockAsync(): Promise<PlatformOrientationInfo> {
  const lock = LOCKS[currentLock];
  return Promise.resolve({
    screenOrientationLockWeb: (lock ?? "unknown") as WebOrientationLock,
  });
}

/**
 * Whether `orientationLock` can be applied here.
 *
 * @param orientationLock The lock.
 * @returns Whether {@linkcode lockAsync} accepts it.
 */
export function supportsOrientationLockAsync(orientationLock: OrientationLock): Promise<boolean> {
  return Promise.resolve(LOCKS[orientationLock] !== undefined);
}

/** The listeners added and not yet removed (made on first use). */
let live: Set<Subscription> | undefined;

/** The listeners, over one denext orientation listener. */
let emitter: Emitter<OrientationChangeEvent> | undefined;

/** The shared emitter (made on first use). */
function orientationEmitter(): Emitter<OrientationChangeEvent> {
  return emitter ??= createEmitter<OrientationChangeEvent>((emit) =>
    onOrientationChange((o) =>
      emit({
        orientationLock: currentLock,
        orientationInfo: {
          orientation: toOrientation(o),
          verticalSizeClass: SizeClassIOS.UNKNOWN,
          horizontalSizeClass: SizeClassIOS.UNKNOWN,
        },
      })
    )
  );
}

/**
 * Listen for orientation changes.
 *
 * @param listener Called with each change.
 * @returns The subscription.
 */
export function addOrientationChangeListener(listener: OrientationChangeListener): Subscription {
  const inner = orientationEmitter().subscribe(listener);
  const subs = live ??= new Set();
  const sub: Subscription = {
    remove() {
      subs.delete(sub);
      inner.remove();
    },
  };
  subs.add(sub);
  return sub;
}

/** Remove every orientation listener. */
export function removeOrientationChangeListeners(): void {
  for (const sub of [...(live ?? [])]) sub.remove();
}

/**
 * Remove one listener.
 *
 * @param subscription What {@linkcode addOrientationChangeListener} returned.
 */
export function removeOrientationChangeListener(subscription: Subscription): void {
  subscription.remove();
}
