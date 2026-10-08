/**
 * `expo-battery` for denext: the battery level and charging state.
 *
 * - In the Capacitor shell, `@capacitor/device`'s `getBatteryInfo()` (`denext mobile add
 *   device`). The plugin reports no change events, so a listener (or a hook) polls it every
 *   {@linkcode BATTERY_POLL_MS} while one is subscribed.
 * - On the web, the Battery Status API (`navigator.getBattery()`, Chromium browsers) with its
 *   change events; elsewhere (Safari, Firefox) the level is `-1` and the state `UNKNOWN`, as on
 *   Expo's web build.
 *
 * Low Power Mode and Android's battery optimisation are not observable here: both read
 * `false`, and the low-power listener never fires.
 *
 * @example
 * ```ts
 * import * as Battery from "denext/expo/battery";
 *
 * const level = await Battery.getBatteryLevelAsync(); // 0–1, or -1 when unknown
 * const sub = Battery.addBatteryStateListener(({ batteryState }) => console.log(batteryState));
 * ```
 *
 * @module
 */

import { useEffect, useState } from "../runtime/hooks.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import { createEmitter, type Emitter, type Subscription, subscription } from "./internal/common.ts";

export type { Subscription };

/** The battery's charging state. */
export enum BatteryState {
  /** Unknown. */
  UNKNOWN = 0,
  /** On battery. */
  UNPLUGGED = 1,
  /** Charging. */
  CHARGING = 2,
  /** Plugged in and full. */
  FULL = 3,
  /** Plugged in, not charging. */
  NOT_CHARGING = 4,
}

/** The battery's level, state and Low Power Mode together. */
export interface PowerState {
  /** 0–1, or -1 when unknown. */
  batteryLevel: number;
  /** The charging state. */
  batteryState: BatteryState;
  /** Whether Low Power Mode is on (always `false` here). */
  lowPowerMode: boolean;
}

/** What a level listener receives. */
export interface BatteryLevelEvent {
  /** 0–1. */
  batteryLevel: number;
}

/** What a state listener receives. */
export interface BatteryStateEvent {
  /** The new state. */
  batteryState: BatteryState;
}

/** What a Low Power Mode listener receives. */
export interface PowerModeEvent {
  /** Whether Low Power Mode is on. */
  lowPowerMode: boolean;
}

/** How often the shell's battery is polled while a listener is subscribed (ms). */
export const BATTERY_POLL_MS = 30_000;

/** `@capacitor/device`'s battery call. */
interface DeviceBatteryPlugin {
  getBatteryInfo(): Promise<{ batteryLevel?: number; isCharging?: boolean }>;
}

/** The Battery Status API's manager. */
interface BatteryManagerLike {
  level: number;
  charging: boolean;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

/** One reading: the level (0–1, or -1) and whether it charges (null: unknown). */
interface Reading {
  level: number;
  charging: boolean | null;
}

/** The shell's Device plugin with getBatteryInfo, if installed. */
function devicePlugin(): DeviceBatteryPlugin | undefined {
  return nativePlugin<DeviceBatteryPlugin>("Device", ["getBatteryInfo"]);
}

/** The Battery Status API's manager, or null where the browser has none. */
async function batteryManager(): Promise<BatteryManagerLike | null> {
  const nav = (globalThis as { navigator?: { getBattery?: () => Promise<BatteryManagerLike> } })
    .navigator;
  if (typeof nav?.getBattery !== "function") return null;
  try {
    return await nav.getBattery();
  } catch {
    return null;
  }
}

/** The battery now. */
async function read(): Promise<Reading> {
  const plugin = devicePlugin();
  if (plugin) {
    const info = await plugin.getBatteryInfo();
    return {
      level: typeof info.batteryLevel === "number" ? info.batteryLevel : -1,
      charging: typeof info.isCharging === "boolean" ? info.isCharging : null,
    };
  }
  const manager = await batteryManager();
  return manager
    ? { level: manager.level, charging: manager.charging }
    : { level: -1, charging: null };
}

/** A reading's state. */
function stateOf({ level, charging }: Reading): BatteryState {
  if (charging === null) return BatteryState.UNKNOWN;
  if (!charging) return BatteryState.UNPLUGGED;
  return level >= 1 ? BatteryState.FULL : BatteryState.CHARGING;
}

/**
 * Watch the battery: the shell's plugin polled, or the Battery Status API's events. Calls
 * `onChange` with the previous and the new reading whenever one differs from the last (the
 * first reading is the baseline, not a change).
 */
function watch(onChange: (previous: Reading, next: Reading) => void): () => void {
  let stopped = false;
  let last: Reading | undefined;
  const report = (reading: Reading) => {
    if (stopped || (last && last.level === reading.level && last.charging === reading.charging)) {
      return;
    }
    const previous = last;
    last = reading;
    if (previous) onChange(previous, reading);
  };
  if (devicePlugin()) {
    const poll = () => read().then(report, () => {});
    poll();
    const id = setInterval(poll, BATTERY_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }
  let manager: BatteryManagerLike | null = null;
  const onEvent = () => manager && report({ level: manager.level, charging: manager.charging });
  batteryManager().then((m) => {
    if (stopped || !m) return;
    manager = m;
    report({ level: m.level, charging: m.charging });
    m.addEventListener("levelchange", onEvent);
    m.addEventListener("chargingchange", onEvent);
  });
  return () => {
    stopped = true;
    manager?.removeEventListener("levelchange", onEvent);
    manager?.removeEventListener("chargingchange", onEvent);
  };
}

/** The level listeners and the state listeners share one watch. */
const levels: Emitter<BatteryLevelEvent> = createEmitter<BatteryLevelEvent>();
const states: Emitter<BatteryStateEvent> = createEmitter<BatteryStateEvent>();
const lowPower: Emitter<PowerModeEvent> = createEmitter<PowerModeEvent>();

/** The shared watch, started by the first level or state listener. */
let stopWatch: (() => void) | undefined;
let watchers = 0;

/** Count a listener in; the first starts the watch. */
function retain(): () => void {
  if (watchers++ === 0) {
    stopWatch = watch((previous, next) => {
      if (next.level !== previous.level) levels.emit({ batteryLevel: next.level });
      const state = stateOf(next);
      if (state !== stateOf(previous)) states.emit({ batteryState: state });
    });
  }
  return () => {
    if (--watchers === 0) {
      stopWatch?.();
      stopWatch = undefined;
    }
  };
}

/** Subscribe `listener` to `emitter`, holding the shared watch until it is removed. */
function watched<T>(emitter: Emitter<T>, listener: (value: T) => void): Subscription {
  const release = retain();
  const sub = emitter.subscribe(listener);
  return subscription(() => {
    sub.remove();
    release();
  });
}

/**
 * Whether the battery can be read: the shell with `@capacitor/device`, or a browser with the
 * Battery Status API.
 *
 * @returns Whether it is available.
 */
export async function isAvailableAsync(): Promise<boolean> {
  return devicePlugin() !== undefined || (await batteryManager()) !== null;
}

/**
 * The battery level.
 *
 * @returns 0–1, or -1 when it cannot be read.
 */
export async function getBatteryLevelAsync(): Promise<number> {
  return (await read()).level;
}

/**
 * The charging state.
 *
 * @returns The state (`UNKNOWN` when it cannot be read).
 */
export async function getBatteryStateAsync(): Promise<BatteryState> {
  return stateOf(await read());
}

/**
 * Whether Low Power Mode is on: not observable here.
 *
 * @returns `false`.
 */
export function isLowPowerModeEnabledAsync(): Promise<boolean> {
  return Promise.resolve(false);
}

/**
 * Whether Android's battery optimisation applies to the app: not observable here.
 *
 * @returns `false`.
 */
export function isBatteryOptimizationEnabledAsync(): Promise<boolean> {
  return Promise.resolve(false);
}

/**
 * The level, state and Low Power Mode together.
 *
 * @returns The power state.
 */
export async function getPowerStateAsync(): Promise<PowerState> {
  const reading = await read();
  return { batteryLevel: reading.level, batteryState: stateOf(reading), lowPowerMode: false };
}

/**
 * Call `listener` when the level changes.
 *
 * @param listener Called with the new level.
 * @returns A subscription to remove.
 */
export function addBatteryLevelListener(
  listener: (event: BatteryLevelEvent) => void,
): Subscription {
  return watched(levels, listener);
}

/**
 * Call `listener` when the charging state changes.
 *
 * @param listener Called with the new state.
 * @returns A subscription to remove.
 */
export function addBatteryStateListener(
  listener: (event: BatteryStateEvent) => void,
): Subscription {
  return watched(states, listener);
}

/**
 * Call `listener` when Low Power Mode changes: never, since it is not observable here.
 *
 * @param listener The listener.
 * @returns A subscription to remove.
 */
export function addLowPowerModeListener(listener: (event: PowerModeEvent) => void): Subscription {
  return lowPower.subscribe(listener);
}

/**
 * Hook form: the level, -1 until it is read.
 *
 * @returns The level.
 */
export function useBatteryLevel(): number {
  const [level, setLevel] = useState(-1);
  useEffect(() => {
    getBatteryLevelAsync().then(setLevel, () => {});
    const sub = addBatteryLevelListener((e) => setLevel(e.batteryLevel));
    return () => sub.remove();
  }, []);
  return level;
}

/**
 * Hook form: the charging state, `UNKNOWN` until it is read.
 *
 * @returns The state.
 */
export function useBatteryState(): BatteryState {
  const [state, setState] = useState(BatteryState.UNKNOWN);
  useEffect(() => {
    getBatteryStateAsync().then(setState, () => {});
    const sub = addBatteryStateListener((e) => setState(e.batteryState));
    return () => sub.remove();
  }, []);
  return state;
}

/**
 * Hook form: whether Low Power Mode is on (always `false` here).
 *
 * @returns `false`.
 */
export function useLowPowerMode(): boolean {
  return false;
}

/**
 * Hook form of {@linkcode getPowerStateAsync}, updated on every change.
 *
 * @returns The power state.
 */
export function usePowerState(): PowerState {
  const level = useBatteryLevel();
  const state = useBatteryState();
  return { batteryLevel: level, batteryState: state, lowPowerMode: false };
}
