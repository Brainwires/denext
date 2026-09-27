/**
 * `react-native-haptic-feedback` for denext's React Native mode: the same API over
 * `denext/mobile`'s {@linkcode haptic} (`@capacitor/haptics` in the Capacitor shell, the
 * Vibration API on the web).
 *
 * Each of the package's 34 feedback types plays the closest of denext's seven kinds (impacts
 * as light / medium / heavy, notifications as success / warning / error, the ticks and key
 * clicks as a selection tick; `noHaptics` plays nothing). `impact`'s intensity picks the
 * weight; patterns play each event as a light or heavy tap at its time. AHAP files (Core
 * Haptics) cannot play: `playAHAP` resolves without effect and `playHaptic` plays the
 * fallback pattern. The Android `ignoreAndroidSystemSettings` / `enableVibrateFallback`
 * options are accepted and ignored.
 *
 * @example
 * ```ts
 * import HapticFeedback, { HapticFeedbackTypes } from "react-native-haptic-feedback";
 *
 * HapticFeedback.trigger(HapticFeedbackTypes.impactMedium);
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useMemo } from "../runtime/hooks.ts";
import { haptic, type HapticKind } from "../mobile/haptics.ts";
import { isNativeShell } from "../mobile/bridge.ts";
import * as RN from "./internal/react-native.ts";

/** The feedback types. */
export enum HapticFeedbackTypes {
  /** A selection change. */
  selection = "selection",
  /** A light impact. */
  impactLight = "impactLight",
  /** A medium impact. */
  impactMedium = "impactMedium",
  /** A heavy impact. */
  impactHeavy = "impactHeavy",
  /** A rigid impact. */
  rigid = "rigid",
  /** A soft impact. */
  soft = "soft",
  /** A success notification. */
  notificationSuccess = "notificationSuccess",
  /** A warning notification. */
  notificationWarning = "notificationWarning",
  /** An error notification. */
  notificationError = "notificationError",
  /** A clock tick. */
  clockTick = "clockTick",
  /** A context click. */
  contextClick = "contextClick",
  /** A key press. */
  keyboardPress = "keyboardPress",
  /** A key release. */
  keyboardRelease = "keyboardRelease",
  /** A key tap. */
  keyboardTap = "keyboardTap",
  /** A long press. */
  longPress = "longPress",
  /** A text handle move. */
  textHandleMove = "textHandleMove",
  /** A virtual key. */
  virtualKey = "virtualKey",
  /** A virtual key release. */
  virtualKeyRelease = "virtualKeyRelease",
  /** A click effect. */
  effectClick = "effectClick",
  /** A double-click effect. */
  effectDoubleClick = "effectDoubleClick",
  /** A heavy click effect. */
  effectHeavyClick = "effectHeavyClick",
  /** A tick effect. */
  effectTick = "effectTick",
  /** A confirmation. */
  confirm = "confirm",
  /** A rejection. */
  reject = "reject",
  /** A gesture start. */
  gestureStart = "gestureStart",
  /** A gesture end. */
  gestureEnd = "gestureEnd",
  /** A segment tick. */
  segmentTick = "segmentTick",
  /** A frequent segment tick. */
  segmentFrequentTick = "segmentFrequentTick",
  /** A toggle switched on. */
  toggleOn = "toggleOn",
  /** A toggle switched off. */
  toggleOff = "toggleOff",
  /** A drag start. */
  dragStart = "dragStart",
  /** A gesture threshold crossed. */
  gestureThresholdActivate = "gestureThresholdActivate",
  /** A gesture threshold uncrossed. */
  gestureThresholdDeactivate = "gestureThresholdDeactivate",
  /** Nothing. */
  noHaptics = "noHaptics",
}

/** A feedback type, as the enum or its string. */
export type HapticFeedbackTypesValue = HapticFeedbackTypes | `${HapticFeedbackTypes}`;

/** The Android options (accepted and ignored). */
export interface HapticOptions {
  /** Vibrate when the device has no haptic engine. */
  enableVibrateFallback?: boolean;
  /** Play even when the system turned haptics off. */
  ignoreAndroidSystemSettings?: boolean;
}

/** One event of a pattern. */
export interface HapticEvent {
  /** When it plays, in ms from the pattern's start. */
  time: number;
  /** A tap or a sustained buzz. */
  type?: "transient" | "continuous";
  /** A continuous event's length in ms. */
  duration?: number;
  /** 0–1: above 0.5 plays a heavy tap, else a light one. */
  intensity?: number;
  /** 0–1 (ignored). */
  sharpness?: number;
}

/** A character of the pattern notation. */
export type PatternChar = "o" | "O" | "." | "-" | "=";

/** The system's haptic settings, as far as they are known. */
export interface SystemHapticStatus {
  /** Whether vibration is on. */
  vibrationEnabled: boolean;
  /** The ringer mode (unknown here: `null`). */
  ringerMode: "silent" | "vibrate" | "normal" | null;
}

/** Which denext kind each feedback type plays (absent: nothing). */
const KINDS: Readonly<Record<string, HapticKind>> = {
  selection: "selection",
  impactLight: "light",
  impactMedium: "medium",
  impactHeavy: "heavy",
  rigid: "heavy",
  soft: "light",
  notificationSuccess: "success",
  notificationWarning: "warning",
  notificationError: "error",
  clockTick: "selection",
  contextClick: "light",
  keyboardPress: "selection",
  keyboardRelease: "selection",
  keyboardTap: "selection",
  longPress: "heavy",
  textHandleMove: "selection",
  virtualKey: "selection",
  virtualKeyRelease: "selection",
  effectClick: "light",
  effectDoubleClick: "light",
  effectHeavyClick: "heavy",
  effectTick: "selection",
  confirm: "success",
  reject: "error",
  gestureStart: "selection",
  gestureEnd: "selection",
  segmentTick: "selection",
  segmentFrequentTick: "selection",
  toggleOn: "light",
  toggleOff: "light",
  dragStart: "light",
  gestureThresholdActivate: "selection",
  gestureThresholdDeactivate: "selection",
};

let enabled = true;
let timers: ReturnType<typeof setTimeout>[] = [];

/** Play `kind`, never throwing (haptics are a nicety). */
function play(kind: HapticKind | undefined): void {
  if (!enabled || !kind) return;
  haptic(kind).catch(() => {});
}

/**
 * Play a feedback type.
 *
 * @param type The type (default `selection`).
 * @param _options The Android options (ignored).
 */
export function trigger(
  type: HapticFeedbackTypesValue = HapticFeedbackTypes.selection,
  _options?: HapticOptions,
): void {
  play(KINDS[type]);
}

/**
 * Play an impact whose weight follows `intensity`: under 0.34 light, under 0.67 medium, else
 * heavy (a notification type plays as itself).
 *
 * @param type The type (default `impactMedium`).
 * @param intensity 0–1 (default 0.7).
 * @param _options The Android options (ignored).
 */
export function impact(
  type: HapticFeedbackTypesValue = HapticFeedbackTypes.impactMedium,
  intensity = 0.7,
  _options?: HapticOptions,
): void {
  const kind = KINDS[type];
  if (kind !== "light" && kind !== "medium" && kind !== "heavy") return play(kind);
  play(intensity < 0.34 ? "light" : intensity < 0.67 ? "medium" : "heavy");
}

/**
 * Play a pattern: each event as a light or heavy tap at its time.
 *
 * @param events The events ({@linkcode pattern} builds them from a notation string).
 * @param _options The Android options (ignored).
 */
export function triggerPattern(events: readonly HapticEvent[], _options?: HapticOptions): void {
  if (!enabled) return;
  for (const event of events) {
    const kind: HapticKind = (event.intensity ?? 1) > 0.5 ? "heavy" : "light";
    timers.push(setTimeout(() => play(kind), Math.max(0, event.time)));
  }
}

/** Cancel a pattern that is still playing. */
export function stop(): void {
  for (const timer of timers) clearTimeout(timer);
  timers = [];
}

/**
 * Whether haptics can play: always in the Capacitor shell, else where the Vibration API exists.
 *
 * @returns Whether they can.
 */
export function isSupported(): boolean {
  if (isNativeShell()) return true;
  const nav = (globalThis as { navigator?: { vibrate?: unknown } }).navigator;
  return typeof nav?.vibrate === "function";
}

/**
 * Turn every call of this module on or off.
 *
 * @param value On or off.
 */
export function setEnabled(value: boolean): void {
  enabled = value;
  if (!value) stop();
}

/**
 * Whether haptics are on ({@linkcode setEnabled}).
 *
 * @returns Whether they are.
 */
export function isEnabled(): boolean {
  return enabled;
}

/**
 * Play an AHAP file (iOS Core Haptics). Not available: resolves without effect.
 *
 * @param _fileName The file, or an AHAP object.
 * @returns A resolved promise.
 */
export function playAHAP(_fileName: unknown): Promise<void> {
  return Promise.resolve();
}

/**
 * The system's haptic settings: vibration is reported on where haptics can play, and the
 * ringer mode is unknown.
 *
 * @returns The status.
 */
export function getSystemHapticStatus(): Promise<SystemHapticStatus> {
  return Promise.resolve({ vibrationEnabled: isSupported(), ringerMode: null });
}

/**
 * Whether `status` says the ringer is silent.
 *
 * @param status From {@linkcode getSystemHapticStatus}.
 * @returns Whether it is.
 */
export function isRingerSilent(status: SystemHapticStatus): boolean {
  return status.ringerMode === "silent";
}

/** The characters {@linkcode pattern} accepts. */
export const PATTERN_CHARS: ReadonlySet<string> = new Set(["o", "O", ".", "-", "="]);

/** How far one tap advances the pattern (ms). */
const TAP_MS = 100;
/** The gap each gap character adds (ms). */
const GAPS: Readonly<Record<string, number>> = { ".": 150, "-": 400, "=": 1000 };

/**
 * Turn the pattern notation into events: `o` a soft tap, `O` a strong one (100 ms apart),
 * `.` a 150 ms gap, `-` 400 ms, `=` 1000 ms.
 *
 * @param notation The notation (`"oO.O"`).
 * @returns The events.
 * @throws {TypeError} On any other character.
 */
export function pattern(notation: string): HapticEvent[] {
  const events: HapticEvent[] = [];
  let cursor = 0;
  [...notation].forEach((ch, i) => {
    if (!PATTERN_CHARS.has(ch)) {
      throw new TypeError(
        `pattern(): invalid character "${ch}" at position ${i}. Allowed characters are: o O . - =`,
      );
    }
    if (ch === "o" || ch === "O") {
      const strong = ch === "O";
      events.push({
        time: cursor,
        type: "transient",
        intensity: strong ? 1 : 0.4,
        sharpness: strong ? 0.8 : 0.4,
      });
      cursor += TAP_MS;
    } else cursor += GAPS[ch];
  });
  return events;
}

/** The named preset patterns. */
export const Patterns: {
  /** Soft then strong: `oO.O`. */
  readonly success: readonly HapticEvent[];
  /** Two double hits: `OO.OO`. */
  readonly error: readonly HapticEvent[];
  /** `O.O`. */
  readonly warning: readonly HapticEvent[];
  /** A double heartbeat: `oO--oO`. */
  readonly heartbeat: readonly HapticEvent[];
  /** A rapid triple tap: `o.o.o`. */
  readonly tripleClick: readonly HapticEvent[];
  /** A rise and fall: `o-O=o`. */
  readonly notification: readonly HapticEvent[];
} = {
  success: [
    { time: 0, type: "transient", intensity: 0.4, sharpness: 0.4 },
    { time: 100, type: "transient", intensity: 1, sharpness: 0.8 },
    { time: 350, type: "transient", intensity: 1, sharpness: 0.8 },
  ],
  error: [
    { time: 0, type: "transient", intensity: 1, sharpness: 0.8 },
    { time: 100, type: "transient", intensity: 1, sharpness: 0.8 },
    { time: 350, type: "transient", intensity: 1, sharpness: 0.8 },
    { time: 450, type: "transient", intensity: 1, sharpness: 0.8 },
  ],
  warning: [
    { time: 0, type: "transient", intensity: 1, sharpness: 0.8 },
    { time: 250, type: "transient", intensity: 1, sharpness: 0.8 },
  ],
  heartbeat: [
    { time: 0, type: "transient", intensity: 0.4, sharpness: 0.4 },
    { time: 100, type: "transient", intensity: 1, sharpness: 0.8 },
    { time: 1000, type: "transient", intensity: 0.4, sharpness: 0.4 },
    { time: 1100, type: "transient", intensity: 1, sharpness: 0.8 },
  ],
  tripleClick: [
    { time: 0, type: "transient", intensity: 0.4, sharpness: 0.4 },
    { time: 250, type: "transient", intensity: 0.4, sharpness: 0.4 },
    { time: 500, type: "transient", intensity: 0.4, sharpness: 0.4 },
  ],
  notification: [
    { time: 0, type: "transient", intensity: 0.4, sharpness: 0.4 },
    { time: 500, type: "transient", intensity: 1, sharpness: 0.8 },
    { time: 1600, type: "transient", intensity: 0.4, sharpness: 0.4 },
  ],
};

/**
 * Play a haptic file where it can play, else `fallback`: AHAP never plays here, so this plays
 * the fallback pattern.
 *
 * @param _ahapFile The AHAP file (ignored).
 * @param fallback The pattern to play.
 * @param options The Android options (ignored).
 * @returns A promise that settles once scheduled.
 */
export function playHaptic(
  _ahapFile: unknown,
  fallback: readonly HapticEvent[],
  options?: HapticOptions,
): Promise<void> {
  triggerPattern(fallback, options);
  return Promise.resolve();
}

/** What {@linkcode useHaptics} returns. */
export interface Haptics {
  /** {@linkcode trigger} with the hook's options. */
  trigger(type?: HapticFeedbackTypesValue, options?: HapticOptions): void;
  /** {@linkcode triggerPattern} with the hook's options. */
  triggerPattern(events: readonly HapticEvent[], options?: HapticOptions): void;
  /** {@linkcode stop}. */
  stop(): void;
  /** {@linkcode isSupported}. */
  isSupported(): boolean;
  /** {@linkcode playHaptic}. */
  playHaptic(
    ahapFile: unknown,
    fallback: readonly HapticEvent[],
    options?: HapticOptions,
  ): Promise<void>;
  /** {@linkcode impact}. */
  impact(type?: HapticFeedbackTypesValue, intensity?: number, options?: HapticOptions): void;
  /** {@linkcode setEnabled}. */
  setEnabled(value: boolean): void;
  /** {@linkcode isEnabled}. */
  isEnabled(): boolean;
  /** {@linkcode getSystemHapticStatus}. */
  getSystemHapticStatus(): Promise<SystemHapticStatus>;
  /** {@linkcode playAHAP}. */
  playAHAP(fileName: unknown): Promise<void>;
}

/**
 * The calls above as a stable object.
 *
 * @param _defaultOptions The Android options (ignored).
 * @returns The calls.
 */
export function useHaptics(_defaultOptions?: HapticOptions): Haptics {
  return useMemo(() => ({
    trigger,
    triggerPattern,
    stop,
    isSupported,
    playHaptic,
    impact,
    setEnabled,
    isEnabled,
    getSystemHapticStatus,
    playAHAP,
  }), []);
}

/** `TouchableHaptic` props. */
export interface TouchableHapticProps {
  /** The feedback type (default `impactMedium`). */
  hapticType?: HapticFeedbackTypesValue;
  /** Which press plays it (default `onPressIn`). */
  hapticTrigger?: "onPressIn" | "onPress" | "onLongPress";
  /** The Android options (ignored). */
  hapticOptions?: HapticOptions;
  /** Called on press in. */
  onPressIn?: (event: unknown) => void;
  /** Called on press. */
  onPress?: (event: unknown) => void;
  /** Called on long press. */
  onLongPress?: (event: unknown) => void;
  /** Any other `Pressable` prop. */
  [prop: string]: unknown;
}

/**
 * A `Pressable` (a `<button>` outside React Native mode) that plays feedback on a press.
 *
 * @param props The feedback, when it plays, and the pressable's props.
 * @returns The pressable.
 */
export function TouchableHaptic(props: TouchableHapticProps): VNode {
  const {
    hapticType = HapticFeedbackTypes.impactMedium,
    hapticTrigger = "onPressIn",
    hapticOptions: _options,
    onPressIn,
    onPress,
    onLongPress,
    ...rest
  } = props;
  const wrap = (name: string, fn?: (event: unknown) => void) => (event: unknown) => {
    if (hapticTrigger === name) trigger(hapticType);
    fn?.(event);
  };
  if (RN.Pressable) {
    return h(RN.Pressable, {
      ...rest,
      onPressIn: wrap("onPressIn", onPressIn),
      onPress: wrap("onPress", onPress),
      onLongPress: wrap("onLongPress", onLongPress),
    });
  }
  return h("button", {
    type: "button",
    ...rest,
    onPointerDown: wrap("onPressIn", onPressIn),
    onClick: wrap("onPress", onPress),
    onContextMenu: wrap("onLongPress", onLongPress),
  });
}

/** The package's default export. */
const RNHapticFeedback: {
  /** {@linkcode trigger}. */
  readonly trigger: typeof trigger;
  /** {@linkcode stop}. */
  readonly stop: typeof stop;
  /** {@linkcode isSupported}. */
  readonly isSupported: typeof isSupported;
  /** {@linkcode triggerPattern}. */
  readonly triggerPattern: typeof triggerPattern;
  /** {@linkcode getSystemHapticStatus}. */
  readonly getSystemHapticStatus: typeof getSystemHapticStatus;
  /** {@linkcode setEnabled}. */
  readonly setEnabled: typeof setEnabled;
  /** {@linkcode isEnabled}. */
  readonly isEnabled: typeof isEnabled;
  /** {@linkcode impact}. */
  readonly impact: typeof impact;
  /** {@linkcode playAHAP}. */
  readonly playAHAP: typeof playAHAP;
} = {
  trigger,
  stop,
  isSupported,
  triggerPattern,
  getSystemHapticStatus,
  setEnabled,
  isEnabled,
  impact,
  playAHAP,
};

export default RNHapticFeedback;
