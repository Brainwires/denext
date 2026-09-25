/**
 * `expo-haptics` for denext: the same API over `denext/mobile`'s {@linkcode haptic}
 * (`@capacitor/haptics` in the Capacitor shell, the Vibration API on the web).
 *
 * In React Native mode (`reactNative` in `denext.config.ts`) `import * as Haptics from
 * "expo-haptics"` resolves here, so app code runs unchanged.
 *
 * @example
 * ```ts
 * import * as Haptics from "denext/expo/haptics";
 *
 * await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
 * await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
 * ```
 *
 * @module
 */

import { haptic, type HapticKind } from "../mobile/haptics.ts";

/** A notification feedback kind for {@linkcode notificationAsync}. */
export enum NotificationFeedbackType {
  /** A task succeeded. */
  Success = "success",
  /** A task produced a warning. */
  Warning = "warning",
  /** A task failed. */
  Error = "error",
}

/** An impact weight for {@linkcode impactAsync}. */
export enum ImpactFeedbackStyle {
  /** A small, light collision. */
  Light = "light",
  /** A moderate collision. */
  Medium = "medium",
  /** A strong collision. */
  Heavy = "heavy",
  /** A soft, flexible collision (played as `light`). */
  Soft = "soft",
  /** A rigid, inflexible collision (played as `heavy`). */
  Rigid = "rigid",
}

/** Android's haptic feedback constants for {@linkcode performAndroidHapticsAsync}. */
export enum AndroidHaptics {
  /** Confirm. */
  Confirm = "confirm",
  /** Reject. */
  Reject = "reject",
  /** Gesture start. */
  Gesture_Start = "gesture-start",
  /** Gesture end. */
  Gesture_End = "gesture-end",
  /** Toggle on. */
  Toggle_On = "toggle-on",
  /** Toggle off. */
  Toggle_Off = "toggle-off",
  /** Clock tick. */
  Clock_Tick = "clock-tick",
  /** Context click. */
  Context_Click = "context-click",
  /** Drag start. */
  Drag_Start = "drag-start",
  /** Keyboard tap. */
  Keyboard_Tap = "keyboard-tap",
  /** Keyboard press. */
  Keyboard_Press = "keyboard-press",
  /** Keyboard release. */
  Keyboard_Release = "keyboard-release",
  /** Long press. */
  Long_Press = "long-press",
  /** Virtual key. */
  Virtual_Key = "virtual-key",
  /** Virtual key release. */
  Virtual_Key_Release = "virtual-key-release",
  /** No haptics. */
  No_Haptics = "no-haptics",
  /** Segment tick. */
  Segment_Tick = "segment-tick",
  /** Frequent segment tick. */
  Segment_Frequent_Tick = "segment-frequent-tick",
  /** Text handle move. */
  Text_Handle_Move = "text-handle-move",
}

/** Impact styles denext has no direct kind for, mapped to the nearest one. */
const IMPACT: Readonly<Record<string, HapticKind>> = {
  light: "light",
  medium: "medium",
  heavy: "heavy",
  soft: "light",
  rigid: "heavy",
};

/** Android constants, grouped by the denext kind that plays them. */
const ANDROID: Readonly<Record<string, HapticKind>> = {
  "confirm": "success",
  "reject": "error",
  "long-press": "heavy",
  "gesture-start": "medium",
  "drag-start": "medium",
  "context-click": "medium",
};

/**
 * Play a notification haptic (`Success`, `Warning` or `Error`).
 *
 * @param type The kind (default `Success`).
 * @returns A promise that settles once the haptic was requested.
 */
export async function notificationAsync(
  type: NotificationFeedbackType = NotificationFeedbackType.Success,
): Promise<void> {
  await haptic(type as HapticKind);
}

/**
 * Play an impact haptic. `Soft` plays as `light` and `Rigid` as `heavy`.
 *
 * @param style The weight (default `Medium`).
 * @returns A promise that settles once the haptic was requested.
 */
export async function impactAsync(
  style: ImpactFeedbackStyle = ImpactFeedbackStyle.Medium,
): Promise<void> {
  const kind = IMPACT[style];
  if (!kind) throw new TypeError(`impactAsync: unknown style "${String(style)}"`);
  await haptic(kind);
}

/**
 * Play a selection-change tick.
 *
 * @returns A promise that settles once the haptic was requested.
 */
export async function selectionAsync(): Promise<void> {
  await haptic("selection");
}

/**
 * Play an Android haptic constant. denext has no per-constant native call, so each constant
 * plays the nearest denext kind (`Confirm` → success, `Reject` → error, `No_Haptics` →
 * nothing, anything else → a selection tick), on every platform.
 *
 * @param type The constant.
 * @returns A promise that settles once the haptic was requested.
 */
export async function performAndroidHapticsAsync(type: AndroidHaptics): Promise<void> {
  if (type === AndroidHaptics.No_Haptics) return;
  await haptic(ANDROID[type] ?? "selection");
}
