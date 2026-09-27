/**
 * `react-native-keyboard-controller` for denext (React Native mode), over `denext/mobile`'s
 * keyboard (`@capacitor/keyboard` in the Capacitor shell, the visual viewport / VirtualKeyboard
 * API on the web). The package's web binding does nothing, so React Native mode resolves the
 * package here.
 *
 * - Views: `KeyboardProvider` (provides the keyboard context), `KeyboardAvoidingView` and
 *   `KeyboardStickyView` (`denext/mobile`'s, which move only by the part of the keyboard that
 *   covers the page), `KeyboardAwareScrollView` (scrolls the focused input above the keyboard,
 *   `bottomOffset` px clear, and pads its content by the covered height), `KeyboardToolbar`
 *   (previous / next / done over the page's inputs, riding on the keyboard, with its compound
 *   parts), `OverKeyboardView`, `KeyboardExtender` and the package's pass-through native views.
 * - `KeyboardController`: `dismiss()` (resolves once the keyboard is down), `setFocusTo("next"
 *   | "prev" | "current")` over the page's focusable inputs in document order, `isVisible()`,
 *   `state()`; the Android input-mode and iOS preload / translucency calls do nothing.
 * - `KeyboardEvents.addListener("keyboardWillShow" | "keyboardDidShow" | "keyboardWillHide" |
 *   "keyboardDidHide", cb)`; the `did` events follow after the keyboard's animation.
 * - Hooks: `useKeyboardHandler({ onStart, onMove, onInteractive, onEnd })` (called on the JS
 *   thread; `onMove` steps through the keyboard's animation when its duration is known),
 *   `useKeyboardAnimation` (React Native `Animated.Value`s: `height` runs 0 → −keyboard
 *   height, `progress` 0 → 1), `useReanimatedKeyboardAnimation` (Reanimated shared values when
 *   the app has Reanimated: React Native mode generates it from the app's
 *   `react-native-reanimated` through {@linkcode reanimatedKeyboardExports}), `useKeyboardState`,
 *   `useKeyboardController`, `useFocusedInputHandler` (text and selection changes),
 *   `useWindowDimensions`, `useAnimatedKeyboard`.
 *
 * Interactive dismissal (`KeyboardGestureArea`, `onInteractive`) never fires: a web view has no
 * interactive keyboard gesture.
 *
 * @example
 * ```ts
 * import { KeyboardProvider, KeyboardStickyView } from "react-native-keyboard-controller";
 * import { h } from "denext/jsx-runtime";
 *
 * h(KeyboardProvider, null, h(KeyboardStickyView, { offset: { opened: 0 } }, "composer"));
 * ```
 *
 * @module
 */

import { Fragment, h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren, VNodeType } from "../jsx/types.ts";
import {
  type Context,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "../runtime/hooks.ts";
import { createContext } from "../runtime/context.ts";
import {
  hideKeyboard,
  type KeyboardState as MobileKeyboardState,
  onKeyboardChange,
} from "../mobile/keyboard-state.ts";
import {
  KeyboardAvoidingView as MobileAvoidingView,
  KeyboardStickyView as MobileStickyView,
} from "../mobile/keyboard-views.ts";
import {
  createEmitter,
  type Emitter,
  flattenStyle,
  hostView,
  type Subscription,
  viewStyle,
} from "../expo/internal/common.ts";
import * as RN from "./internal/react-native.ts";

// ---- events and the imperative module -------------------------------------------------

/** A keyboard event name. */
export type KeyboardControllerEvents =
  | "keyboardWillShow"
  | "keyboardDidShow"
  | "keyboardWillHide"
  | "keyboardDidHide";

/** A keyboard event's payload (and {@linkcode KeyboardController}'s `state()`). */
export interface KeyboardEventData {
  /** The keyboard's height in px. */
  height: number;
  /** The animation's duration in ms (0 when unknown). */
  duration: number;
  /** When the event happened (ms since the epoch). */
  timestamp: number;
  /** The focused input's tag (always -1 on the web). */
  target: number;
  /** The focused input's keyboard type (always `default`). */
  type: string;
  /** The keyboard's appearance (always `light`). */
  appearance: "dark" | "light";
}

/** A keyboard event with its name. */
interface NamedEvent {
  name: KeyboardControllerEvents;
  data: KeyboardEventData;
}

/** The shared keyboard tracker (created on first use). */
interface Tracker {
  events: Emitter<NamedEvent>;
  last: KeyboardEventData;
  visible: boolean;
  lastFocused: unknown;
}

/** The one tracker, created lazily (nothing runs at import). */
let tracker: Tracker | null = null;

/** The initial event data. */
function initialData(): KeyboardEventData {
  return {
    height: 0,
    duration: 0,
    timestamp: Date.now(),
    target: -1,
    type: "default",
    appearance: "light",
  };
}

/** The tracker, created on first use. */
function getTracker(): Tracker {
  if (tracker) return tracker;
  const t: Tracker = {
    events: null as never,
    last: initialData(),
    visible: false,
    lastFocused: null,
  };
  t.events = createEmitter<NamedEvent>((emit) =>
    onKeyboardChange((state: MobileKeyboardState) => {
      const duration = state.animationDuration ?? 0;
      const data: KeyboardEventData = {
        ...initialData(),
        height: state.visible ? state.height : 0,
        duration,
      };
      if (state.visible === t.visible && !state.visible) return;
      const showing = state.visible;
      t.visible = showing;
      t.last = data;
      emit({ name: showing ? "keyboardWillShow" : "keyboardWillHide", data });
      const did = () => emit({ name: showing ? "keyboardDidShow" : "keyboardDidHide", data });
      if (duration > 0) setTimeout(did, duration);
      else did();
    })
  );
  tracker = t;
  return t;
}

/** Keep the tracker listening (for `state()` / `isVisible()` / `setFocusTo("current")`). */
let keepAlive: Subscription | null = null;

/** Start the permanent tracker subscription and focus tracking, once. */
function ensureTracking(): Tracker {
  const t = getTracker();
  if (!keepAlive) {
    keepAlive = t.events.subscribe(() => {});
    const doc = (globalThis as {
      document?: { addEventListener?: (t: string, f: (e: { target?: unknown }) => void) => void };
    }).document;
    doc?.addEventListener?.("focusin", (e) => {
      t.lastFocused = e.target ?? null;
    });
  }
  return t;
}

/** Forget the tracker (for tests). */
export function resetKeyboardControllerForTesting(): void {
  keepAlive?.remove();
  keepAlive = null;
  tracker = null;
}

/**
 * The keyboard's events: `addListener(name, cb)` returns a subscription whose `remove()` stops
 * it.
 */
export const KeyboardEvents: {
  /** Listen to `name`. */
  addListener(
    name: KeyboardControllerEvents,
    cb: (e: KeyboardEventData) => void,
  ): Subscription;
} = {
  addListener(name, cb) {
    return getTracker().events.subscribe((event) => {
      if (event.name === name) cb(event.data);
    });
  },
};

/** An event source that never fires (the package's internal focus / window events). */
const SILENT_EVENTS = {
  /** Listen (never fires). */
  addListener: (_name: string, _cb: (e: unknown) => void): Subscription => ({ remove() {} }),
};

/** The package's focused-input events (internal; never fire here). */
export const FocusedInputEvents: typeof SILENT_EVENTS = SILENT_EVENTS;

/** The package's window-resize events (never fire; {@linkcode useWindowDimensions} listens itself). */
export const WindowDimensionsEvents: typeof SILENT_EVENTS = SILENT_EVENTS;

/** A focus direction for {@linkcode KeyboardController}'s `setFocusTo`. */
export type Direction = "next" | "prev" | "current";

/** Options of `KeyboardController.dismiss`. */
export interface DismissOptions {
  /** Keep focus on the input (only possible in the shell with `@capacitor/keyboard`). */
  keepFocus: boolean;
  /** Animate the dismissal (ignored). */
  animated: boolean;
}

/** The slice of a focusable element `setFocusTo` uses. */
interface Focusable {
  focus?(): void;
  disabled?: boolean;
  tabIndex?: number;
  getAttribute?(name: string): string | null;
}

/** The page's focusable text inputs, in document order. */
function focusableInputs(): Focusable[] {
  const doc = (globalThis as {
    document?: { querySelectorAll?: (s: string) => ArrayLike<Focusable> };
  }).document;
  if (typeof doc?.querySelectorAll !== "function") return [];
  const all = Array.from(
    doc.querySelectorAll(
      'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]),textarea,[contenteditable="true"],[contenteditable=""]',
    ),
  );
  return all.filter((el) => !el.disabled && el.tabIndex !== -1);
}

/** Move focus to the next / previous input, or back to the last focused one. */
function setFocusTo(direction: Direction): void {
  const t = ensureTracking();
  const doc = (globalThis as { document?: { activeElement?: unknown } }).document;
  if (direction === "current") {
    (t.lastFocused as Focusable | null)?.focus?.();
    return;
  }
  const inputs = focusableInputs();
  const current = inputs.indexOf((doc?.activeElement ?? t.lastFocused) as Focusable);
  if (current === -1) return;
  const next = inputs[current + (direction === "next" ? 1 : -1)];
  next?.focus?.();
}

/** Dismiss the keyboard; resolves once it is down (at most a second later). */
function dismiss(options?: Partial<DismissOptions>): Promise<void> {
  const t = ensureTracking();
  if (!t.visible) {
    return hideKeyboard().catch(() => {});
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      sub.remove();
      clearTimeout(timer);
      resolve();
    };
    const sub = KeyboardEvents.addListener("keyboardDidHide", finish);
    const timer = setTimeout(finish, 1000);
    hideKeyboard().catch(finish);
    if (options?.keepFocus !== true) {
      const doc = (globalThis as { document?: { activeElement?: { blur?: () => void } } })
        .document;
      doc?.activeElement?.blur?.();
    }
  });
}

/** Does nothing (an Android / iOS native setting). */
function noop(): void {}

/** The imperative keyboard module. */
export const KeyboardController: {
  /** Android's default soft-input mode (does nothing). */
  setDefaultMode(): void;
  /** Android's soft-input mode (does nothing). */
  setInputMode(mode: number): void;
  /** iOS keyboard preload (does nothing). */
  preload(): void;
  /** iOS keyboard translucency (does nothing). */
  setTranslucent(translucent: boolean): void;
  /** Dismiss the keyboard. */
  dismiss(options?: Partial<DismissOptions>): Promise<void>;
  /** Move focus to the next / previous input, or back to the current one. */
  setFocusTo(direction: Direction): void;
  /** Whether the keyboard is up. */
  isVisible(): boolean;
  /** The last keyboard event's data. */
  state(): KeyboardEventData;
} = {
  setDefaultMode: noop,
  setInputMode: noop,
  preload: noop,
  setTranslucent: noop,
  dismiss,
  setFocusTo,
  isVisible: () => ensureTracking().visible,
  state: () => ensureTracking().last,
};

/** The package's native module (its methods do nothing, as in its web build). */
export const KeyboardControllerNative: Record<string, unknown> = {
  setDefaultMode: noop,
  setInputMode: noop,
  preload: noop,
  setTranslucent: noop,
  dismiss: noop,
  setFocusTo: noop,
  viewPositionInWindow: () => Promise.resolve({ x: 0, y: 0, width: 0, height: 0 }),
  addListener: noop,
  removeListeners: noop,
  getConstants: () => ({ keyboardBorderRadius: 0 }),
};

/** The package's native view commands (do nothing). */
export const KeyboardControllerViewCommands: {
  /** Re-measure the focused input (does nothing). */
  synchronizeFocusedInputLayout(ref: unknown): void;
} = { synchronizeFocusedInputLayout: noop };

/** Android's `windowSoftInputMode` flags (`KeyboardController.setInputMode` ignores them). */
export enum AndroidSoftInputModes {
  /** Nothing. */
  SOFT_INPUT_ADJUST_NOTHING = 48,
  /** Pan. */
  SOFT_INPUT_ADJUST_PAN = 32,
  /** Resize. */
  SOFT_INPUT_ADJUST_RESIZE = 16,
  /** Unspecified. */
  SOFT_INPUT_ADJUST_UNSPECIFIED = 0,
  /** Forward navigation. */
  SOFT_INPUT_IS_FORWARD_NAVIGATION = 256,
  /** Adjust mask. */
  SOFT_INPUT_MASK_ADJUST = 240,
  /** State mask. */
  SOFT_INPUT_MASK_STATE = 15,
  /** Mode changed. */
  SOFT_INPUT_MODE_CHANGED = 512,
  /** Always hidden. */
  SOFT_INPUT_STATE_ALWAYS_HIDDEN = 3,
  /** Always visible. */
  SOFT_INPUT_STATE_ALWAYS_VISIBLE = 5,
  /** Hidden. */
  SOFT_INPUT_STATE_HIDDEN = 2,
  /** Unchanged. */
  SOFT_INPUT_STATE_UNCHANGED = 1,
  /** Visible. */
  SOFT_INPUT_STATE_VISIBLE = 4,
}

/** The keyboard's corner radius (0: a web view does not know it). */
export const KEYBOARD_BORDER_RADIUS = 0;
/** Whether the keyboard has rounded corners (false). */
export const KEYBOARD_HAS_ROUNDED_CORNERS = false;

// ---- hooks -------------------------------------------------------------------------------

/** One step of the keyboard's movement, as the handlers receive it. */
export interface NativeEvent {
  /** 0 (hidden) to 1 (fully shown). */
  progress: number;
  /** The keyboard's height in px at this step. */
  height: number;
  /** The animation's duration in ms (0 when unknown). */
  duration: number;
  /** The focused input's tag (always -1). */
  target: number;
}

/** The handlers of {@linkcode useKeyboardHandler}. */
export type KeyboardHandler = Partial<{
  /** The keyboard starts moving (with its destination). */
  onStart: (e: NativeEvent) => void;
  /** A step of the movement. */
  onMove: (e: NativeEvent) => void;
  /** The movement ended. */
  onEnd: (e: NativeEvent) => void;
  /** An interactive (gesture-driven) move (never fires on the web). */
  onInteractive: (e: NativeEvent) => void;
}>;

/** Ease-out cubic, like the platform keyboard curve. */
function ease(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Drive `handler` from the keyboard: `onStart` with the destination, `onMove` per animation
 * frame over the keyboard's duration (once, at the destination, when the duration is
 * unknown), then `onEnd`. Returns the unsubscribe.
 */
function watchKeyboardMotion(get: () => KeyboardHandler): () => void {
  let from = 0;
  let frame: number | undefined;
  const raf = (globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number })
    .requestAnimationFrame;
  const caf = (globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame;
  const stop = onKeyboardChange((state) => {
    const to = state.visible ? state.height : 0;
    const duration = state.animationDuration ?? 0;
    const max = Math.max(from, to) || 1;
    const event = (height: number): NativeEvent => ({
      height,
      progress: Math.max(0, Math.min(1, height / max)),
      duration,
      target: -1,
    });
    if (frame !== undefined) caf?.(frame);
    frame = undefined;
    const start = from;
    from = to;
    get().onStart?.(event(to));
    if (duration <= 0 || typeof raf !== "function") {
      get().onMove?.(event(to));
      get().onEnd?.(event(to));
      return;
    }
    let t0: number | undefined;
    const step = (stamp: number) => {
      const now = typeof stamp === "number" ? stamp : Date.now();
      t0 ??= now;
      const t = Math.min(1, (now - t0) / duration);
      const height = start + (to - start) * ease(t);
      get().onMove?.(event(height));
      if (t < 1) frame = raf(step);
      else {
        frame = undefined;
        get().onEnd?.(event(to));
      }
    };
    frame = raf(step);
  });
  return () => {
    if (frame !== undefined) caf?.(frame);
    stop();
  };
}

/**
 * Follow the keyboard's movement: the handlers run on the JS thread (the latest ones, so they
 * may close over state).
 *
 * @param handler The handlers.
 * @param _deps Accepted for compatibility (the latest handlers always run).
 */
export function useKeyboardHandler(handler: KeyboardHandler, _deps?: unknown[]): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => watchKeyboardMotion(() => latest.current), []);
}

/**
 * The same as {@linkcode useKeyboardHandler}.
 *
 * @param handler The handlers.
 * @param deps Accepted for compatibility.
 */
export function useGenericKeyboardHandler(handler: KeyboardHandler, deps?: unknown[]): void {
  useKeyboardHandler(handler, deps);
}

/** A value holder standing in for an animated value outside React Native mode. */
export interface ValueHolder {
  /** The current value. */
  value: number;
}

/** What {@linkcode useKeyboardAnimation} returns. */
export interface AnimatedContext {
  /** 0 → 1 as the keyboard shows. */
  progress: unknown;
  /** 0 → −keyboard height as the keyboard shows. */
  height: unknown;
}

/** An animated value: React Native's `Animated.Value`, else a {@linkcode ValueHolder}. */
function animatedValue(): { set(v: number): void; handle: unknown } {
  const Value = RN.Animated?.Value;
  if (Value) {
    const v = new Value(0);
    return { set: (n) => v.setValue(n), handle: v };
  }
  const holder: ValueHolder = { value: 0 };
  return { set: (n) => (holder.value = n), handle: holder };
}

/**
 * The keyboard's height and progress as React Native `Animated.Value`s (in React Native mode;
 * value holders elsewhere): `height` runs from 0 to −keyboard height, `progress` from 0 to 1.
 *
 * @returns `{ height, progress }`.
 */
export function useKeyboardAnimation(): AnimatedContext {
  const values = useMemo(() => ({ height: animatedValue(), progress: animatedValue() }), []);
  useKeyboardHandler({
    onMove: (e) => {
      values.height.set(-e.height);
      values.progress.set(e.progress);
    },
  });
  return useMemo(
    () => ({ height: values.height.handle, progress: values.progress.handle }),
    [values],
  );
}

/** What {@linkcode useReanimatedKeyboardAnimation} returns. */
export interface ReanimatedContext {
  /** 0 → 1 as the keyboard shows. */
  progress: ValueHolder;
  /** 0 → −keyboard height as the keyboard shows. */
  height: ValueHolder;
}

/**
 * The keyboard's height and progress as `{ value }` holders. React Native mode replaces this
 * with Reanimated shared values when the app has `react-native-reanimated`
 * ({@linkcode reanimatedKeyboardExports}); these holders update but do not re-render.
 *
 * @returns `{ height, progress }`.
 */
export function useReanimatedKeyboardAnimation(): ReanimatedContext {
  const values = useMemo(() => ({ height: { value: 0 }, progress: { value: 0 } }), []);
  useKeyboardHandler({
    onMove: (e) => {
      values.height.value = -e.height;
      values.progress.value = e.progress;
    },
  });
  return values;
}

/** `useAnimatedKeyboard`'s states. */
export const KeyboardState: {
  /** Not known yet. */
  readonly UNKNOWN: 0;
  /** Showing. */
  readonly OPENING: 1;
  /** Shown. */
  readonly OPEN: 2;
  /** Hiding. */
  readonly CLOSING: 3;
  /** Hidden. */
  readonly CLOSED: 4;
} = { UNKNOWN: 0, OPENING: 1, OPEN: 2, CLOSING: 3, CLOSED: 4 };

/** What {@linkcode useAnimatedKeyboard} returns. */
export interface AnimatedKeyboard {
  /** The keyboard's height (positive). */
  height: ValueHolder;
  /** A {@linkcode KeyboardState} value. */
  state: ValueHolder;
}

/**
 * Reanimated's `useAnimatedKeyboard` shape (`height` positive, `state`) as `{ value }`
 * holders; Reanimated shared values when the app has `react-native-reanimated`.
 *
 * @returns `{ height, state }`.
 */
export function useAnimatedKeyboard(): AnimatedKeyboard {
  const values = useMemo(() => ({ height: { value: 0 }, state: { value: 0 } }), []);
  useKeyboardHandler(keyboardStateHandler(values));
  return values;
}

/** The handler behind `useAnimatedKeyboard` for any `{ value }` holders. */
function keyboardStateHandler(values: AnimatedKeyboard): KeyboardHandler {
  return {
    onStart: (e) => {
      values.state.value = e.height > 0 ? KeyboardState.OPENING : KeyboardState.CLOSING;
    },
    onMove: (e) => {
      values.height.value = e.height;
    },
    onEnd: (e) => {
      values.state.value = e.height > 0 ? KeyboardState.OPEN : KeyboardState.CLOSED;
      values.height.value = e.height;
    },
  };
}

/** The slice of `react-native-reanimated` {@linkcode reanimatedKeyboardExports} uses. */
export interface ReanimatedLike {
  /** Reanimated's `useSharedValue`. */
  useSharedValue<T>(initial: T): { value: T };
}

/** What {@linkcode reanimatedKeyboardExports} returns. */
export interface ReanimatedKeyboardExports {
  /** {@linkcode useReanimatedKeyboardAnimation} over Reanimated shared values. */
  useReanimatedKeyboardAnimation(): ReanimatedContext;
  /** {@linkcode useAnimatedKeyboard} over Reanimated shared values. */
  useAnimatedKeyboard(): AnimatedKeyboard;
}

/**
 * The Reanimated hooks built on the app's own `react-native-reanimated` (React Native mode
 * generates `export const { useReanimatedKeyboardAnimation, useAnimatedKeyboard } =
 * reanimatedKeyboardExports(reanimated)` when the app has it): shared values that
 * `useAnimatedStyle` follows.
 *
 * @param reanimated `import * as reanimated from "react-native-reanimated"`.
 * @returns The hooks.
 */
export function reanimatedKeyboardExports(reanimated: ReanimatedLike): ReanimatedKeyboardExports {
  return {
    useReanimatedKeyboardAnimation() {
      const height = reanimated.useSharedValue(0);
      const progress = reanimated.useSharedValue(0);
      useKeyboardHandler({
        onMove: (e) => {
          height.value = -e.height;
          progress.value = e.progress;
        },
      });
      return { height, progress };
    },
    useAnimatedKeyboard() {
      const height = reanimated.useSharedValue(0);
      const state = reanimated.useSharedValue(0);
      const values = { height, state };
      useKeyboardHandler(keyboardStateHandler(values));
      return values;
    },
  };
}

/** The keyboard's state as {@linkcode useKeyboardState} reports it. */
export type IKeyboardState = KeyboardEventData & {
  /** Whether the keyboard is up. */
  isVisible: boolean;
};

/**
 * The keyboard's state (or `selector` of it), re-rendering on show / hide.
 *
 * @param selector Picks the part to watch (default: all of it).
 * @returns The selected state.
 */
export function useKeyboardState<T = IKeyboardState>(
  selector: (state: IKeyboardState) => T = (s) => s as unknown as T,
): T {
  const read = () => {
    const t = ensureTracking();
    return selector({ ...t.last, isVisible: t.visible });
  };
  const [value, setValue] = useState<T>(read);
  const latest = useRef(selector);
  latest.current = selector;
  useEffect(() => {
    const subs = (["keyboardWillShow", "keyboardDidHide"] as const).map((name) =>
      KeyboardEvents.addListener(name, () => {
        const t = ensureTracking();
        setValue(() => latest.current({ ...t.last, isVisible: t.visible }));
      })
    );
    return () => subs.forEach((s) => s.remove());
  }, []);
  return value;
}

/** The window's size. */
export interface WindowDimensions {
  /** Width in px. */
  width: number;
  /** Height in px. */
  height: number;
}

/**
 * The window's size, updated on resize.
 *
 * @returns `{ width, height }`.
 */
export function useWindowDimensions(): WindowDimensions {
  const read = (): WindowDimensions => {
    const w = globalThis as { innerWidth?: number; innerHeight?: number };
    return { width: w.innerWidth ?? 0, height: w.innerHeight ?? 0 };
  };
  const [size, setSize] = useState<WindowDimensions>(read);
  useEffect(() => {
    const g = globalThis as {
      addEventListener?: (t: string, f: () => void) => void;
      removeEventListener?: (t: string, f: () => void) => void;
    };
    if (typeof g.addEventListener !== "function") return;
    const update = () => setSize(read());
    g.addEventListener("resize", update);
    return () => g.removeEventListener?.("resize", update);
  }, []);
  return size;
}

/** Android's resize mode hook (does nothing). */
export function useResizeMode(): void {}

/** A focused input's text change. */
export interface FocusedInputTextChangedEvent {
  /** The input's text. */
  text: string;
}

/** A focused input's selection change. */
export interface FocusedInputSelectionChangedEvent {
  /** The input's tag (always -1). */
  target: number;
  /** The selection (positions only; `x` / `y` are 0). */
  selection: {
    start: { x: number; y: number; position: number };
    end: { x: number; y: number; position: number };
  };
}

/** The handlers of {@linkcode useFocusedInputHandler}. */
export type FocusedInputHandler = Partial<{
  /** The focused input's text changed. */
  onChangeText: (e: FocusedInputTextChangedEvent) => void;
  /** The focused input's selection changed. */
  onSelectionChange: (e: FocusedInputSelectionChangedEvent) => void;
}>;

/** The slice of an input the focused-input handler reads. */
interface TextTarget {
  value?: string;
  textContent?: string | null;
  selectionStart?: number | null;
  selectionEnd?: number | null;
}

/**
 * Follow the focused input's text and selection (document `input` / `selectionchange`
 * events).
 *
 * @param handler The handlers.
 * @param _deps Accepted for compatibility (the latest handlers always run).
 */
export function useFocusedInputHandler(handler: FocusedInputHandler, _deps?: unknown[]): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const doc = (globalThis as {
      document?: {
        activeElement?: unknown;
        addEventListener?: (t: string, f: (e: { target?: unknown }) => void) => void;
        removeEventListener?: (t: string, f: (e: { target?: unknown }) => void) => void;
      };
    }).document;
    if (typeof doc?.addEventListener !== "function") return;
    const onInput = (e: { target?: unknown }) => {
      const el = e.target as TextTarget | undefined;
      if (!el) return;
      latest.current.onChangeText?.({ text: el.value ?? el.textContent ?? "" });
    };
    const onSelection = () => {
      const el = doc.activeElement as TextTarget | undefined;
      if (!el || typeof el.selectionStart !== "number") return;
      latest.current.onSelectionChange?.({
        target: -1,
        selection: {
          start: { x: 0, y: 0, position: el.selectionStart ?? 0 },
          end: { x: 0, y: 0, position: el.selectionEnd ?? el.selectionStart ?? 0 },
        },
      });
    };
    doc.addEventListener("input", onInput);
    doc.addEventListener("selectionchange", onSelection);
    return () => {
      doc.removeEventListener?.("input", onInput);
      doc.removeEventListener?.("selectionchange", onSelection);
    };
  }, []);
}

/** A focused input's layout. */
export interface FocusedInputLayoutChangedEvent {
  /** The input's tag (always -1). */
  target: number;
  /** Its scroll view's tag (always -1). */
  parentScrollViewTarget: number;
  /** Its box in px, relative to the viewport (`absolute*` the same). */
  layout: {
    x: number;
    y: number;
    width: number;
    height: number;
    absoluteX: number;
    absoluteY: number;
  };
}

/** The focused input's layout, or null (read on demand). */
function focusedLayout(): FocusedInputLayoutChangedEvent | null {
  const doc = (globalThis as { document?: { activeElement?: unknown } }).document;
  const el = doc?.activeElement as
    | { getBoundingClientRect?: () => { left: number; top: number; width: number; height: number } }
    | undefined;
  const rect = el?.getBoundingClientRect?.();
  if (!rect) return null;
  return {
    target: -1,
    parentScrollViewTarget: -1,
    layout: {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      absoluteX: rect.left,
      absoluteY: rect.top,
    },
  };
}

/**
 * The focused input's layout as a `{ value }` holder (refreshed on focus and by `update()`).
 *
 * @returns `{ input, update }`.
 */
export function useReanimatedFocusedInput(): {
  input: { value: FocusedInputLayoutChangedEvent | null };
  update: () => Promise<void>;
} {
  const input = useMemo(() => ({ value: null as FocusedInputLayoutChangedEvent | null }), []);
  const update = useMemo(() => () => {
    input.value = focusedLayout();
    return Promise.resolve();
  }, [input]);
  useEffect(() => {
    const doc = (globalThis as {
      document?: {
        addEventListener?: (t: string, f: () => void) => void;
        removeEventListener?: (t: string, f: () => void) => void;
      };
    }).document;
    if (typeof doc?.addEventListener !== "function") return;
    const onFocus = () => void update();
    doc.addEventListener("focusin", onFocus);
    return () => doc.removeEventListener?.("focusin", onFocus);
  }, []);
  return { input, update };
}

// ---- the provider and its context -----------------------------------------------------

/** The value of {@linkcode KeyboardContext}. */
export interface KeyboardAnimationContext {
  /** Whether the module is enabled. */
  enabled: boolean;
  /** The keyboard as `Animated` values. */
  animated: AnimatedContext;
  /** The keyboard as `{ value }` holders. */
  reanimated: ReanimatedContext;
  /** The focused input's layout. */
  layout: { value: FocusedInputLayoutChangedEvent | null };
  /** Refresh `layout`. */
  update: () => Promise<void>;
  /** Register worklet handlers (does nothing; use {@linkcode useKeyboardHandler}). */
  setKeyboardHandlers: (handlers: unknown) => () => void;
  /** Register input handlers (does nothing; use {@linkcode useFocusedInputHandler}). */
  setInputHandlers: (handlers: unknown) => () => void;
  /** Enable or disable the module. */
  setEnabled: (value: boolean | ((prev: boolean) => boolean)) => void;
}

/** The context default: a module enabled with fresh values and no-op setters. */
function defaultContext(): KeyboardAnimationContext {
  return {
    enabled: true,
    animated: { height: { value: 0 }, progress: { value: 0 } },
    reanimated: { height: { value: 0 }, progress: { value: 0 } },
    layout: { value: null },
    update: () => Promise.resolve(),
    setKeyboardHandlers: () => noop,
    setInputHandlers: () => noop,
    setEnabled: noop,
  };
}

/** The keyboard context {@linkcode KeyboardProvider} provides (null outside one). */
export const KeyboardContext: Context<KeyboardAnimationContext | null> = /* @__PURE__ */
  createContext<KeyboardAnimationContext | null>(null);

/**
 * The nearest {@linkcode KeyboardProvider}'s context (a default one outside a provider).
 *
 * @returns The context.
 */
export function useKeyboardContext(): KeyboardAnimationContext {
  const context = useContext(KeyboardContext);
  return context ?? defaultContext();
}

/**
 * Whether the module is enabled, and a setter (the provider's; local state outside one).
 *
 * @returns `{ enabled, setEnabled }`.
 */
export function useKeyboardController(): {
  enabled: boolean;
  setEnabled: (value: boolean | ((prev: boolean) => boolean)) => void;
} {
  const context = useContext(KeyboardContext);
  const [local, setLocal] = useState(true);
  return context
    ? { enabled: context.enabled, setEnabled: context.setEnabled }
    : { enabled: local, setEnabled: setLocal };
}

/** `KeyboardProvider` props. */
export interface KeyboardProviderProps {
  /** The app. */
  children?: VNodeChildren;
  /** Whether the module starts enabled (default `true`). */
  enabled?: boolean;
  /** Android status-bar translucency (ignored). */
  statusBarTranslucent?: boolean;
  /** Android navigation-bar translucency (ignored). */
  navigationBarTranslucent?: boolean;
  /** Android edge-to-edge (ignored). */
  preserveEdgeToEdge?: boolean;
  /** iOS keyboard preload (ignored). */
  preload?: boolean;
}

/**
 * Provide the keyboard context to the app (render it at the root, as the package asks).
 *
 * @param props The initial `enabled` and the app.
 * @returns The app, inside the context.
 */
export function KeyboardProvider(props: KeyboardProviderProps): VNode {
  const [enabled, setEnabled] = useState(props.enabled !== false);
  const animated = useKeyboardAnimation();
  const reanimated = useReanimatedKeyboardAnimation();
  const focused = useReanimatedFocusedInput();
  const value = useMemo<KeyboardAnimationContext>(() => ({
    enabled,
    animated,
    reanimated,
    layout: focused.input,
    update: focused.update,
    setKeyboardHandlers: () => noop,
    setInputHandlers: () => noop,
    setEnabled,
  }), [enabled, animated, reanimated, focused.input]);
  return h(KeyboardContext as unknown as VNodeType, { value }, props.children);
}

// ---- views -------------------------------------------------------------------------------

/** React Native's shorthand style keys, as the CSS properties they set. */
const SHORTHANDS: Readonly<Record<string, readonly string[]>> = {
  paddingHorizontal: ["paddingLeft", "paddingRight"],
  paddingVertical: ["paddingTop", "paddingBottom"],
  marginHorizontal: ["marginLeft", "marginRight"],
  marginVertical: ["marginTop", "marginBottom"],
};

/**
 * A React Native style as the plain `<div>` style `denext/mobile`'s keyboard views take: the
 * style flattened, the shorthands expanded, on top of a `View`'s flex defaults.
 */
function domViewStyle(style: unknown): Record<string, string | number | undefined> {
  const out: Record<string, string | number | undefined> = {
    display: "flex",
    flexDirection: "column",
    position: "relative",
    boxSizing: "border-box",
  };
  for (const [key, value] of Object.entries(flattenStyle(style))) {
    const v = typeof value === "number" || typeof value === "string" ? value : undefined;
    if (v === undefined) continue;
    const targets = SHORTHANDS[key];
    if (targets) { for (const target of targets) out[target] = v; }
    else out[key] = v;
  }
  return out;
}

/** `KeyboardAvoidingView` props (plus any view prop). */
export interface KeyboardAvoidingViewProps {
  /** How to make room (default `padding`; `translate-with-padding` pads). */
  behavior?: "height" | "padding" | "position" | "translate-with-padding";
  /** `false` turns the avoidance off (default `true`). */
  enabled?: boolean;
  /** px of the covered height to ignore. */
  keyboardVerticalOffset?: number;
  /** Measure the offset automatically (ignored). */
  automaticOffset?: boolean;
  /** With `position`: the style of the inner view that moves. */
  contentContainerStyle?: unknown;
  /** The style. */
  style?: unknown;
  /** The content. */
  children?: VNodeChildren;
  /** Other view props. */
  [prop: string]: unknown;
}

/**
 * A view that makes room for the keyboard (`denext/mobile`'s `KeyboardAvoidingView`).
 *
 * @param props The behavior, offset, style and children.
 * @returns The view.
 */
export function KeyboardAvoidingView(props: KeyboardAvoidingViewProps): VNode {
  const {
    behavior = "padding",
    automaticOffset: _auto,
    contentContainerStyle,
    style,
    children,
    ...rest
  } = props;
  const kind = behavior === "translate-with-padding" ? "padding" : behavior;
  if (kind === "position") {
    return h(
      hostView(),
      { style: viewStyle(style) },
      h(MobileAvoidingView, {
        ...rest,
        behavior: kind,
        style: domViewStyle(contentContainerStyle),
      }, children),
    );
  }
  return h(MobileAvoidingView, { ...rest, behavior: kind, style: domViewStyle(style) }, children);
}

/** `KeyboardStickyView` props (plus any view prop). */
export interface KeyboardStickyViewProps {
  /** Extra shift in px while the keyboard is closed / open. */
  offset?: { closed?: number; opened?: number };
  /** `false` keeps the view where its style puts it (default `true`). */
  enabled?: boolean;
  /** The style. */
  style?: unknown;
  /** The content. */
  children?: VNodeChildren;
  /** Other view props. */
  [prop: string]: unknown;
}

/**
 * A view that rides on top of the keyboard (`denext/mobile`'s `KeyboardStickyView`).
 *
 * @param props The offset, style and children.
 * @returns The view.
 */
export function KeyboardStickyView(props: KeyboardStickyViewProps): VNode {
  const { style, children, ...rest } = props;
  return h(MobileStickyView, { ...rest, style: domViewStyle(style) }, children);
}

/** How far the keyboard covers the layout viewport now (0 without a visual viewport). */
function coveredPx(): number {
  const g = globalThis as {
    innerHeight?: number;
    visualViewport?: { height?: number; offsetTop?: number };
  };
  const vv = g.visualViewport;
  if (!vv || typeof g.innerHeight !== "number" || typeof vv.height !== "number") return 0;
  return Math.max(0, Math.round(g.innerHeight - (vv.offsetTop ?? 0) - vv.height));
}

/** The slice of a scroll container {@linkcode KeyboardAwareScrollView} scrolls. */
interface ScrollNode {
  scrollTop?: number;
  getBoundingClientRect?(): { top: number; bottom: number };
  contains?(node: unknown): boolean;
  getScrollableNode?(): ScrollNode;
}

/** Scroll `node` so the focused element inside it clears the keyboard by `bottomOffset`. */
function revealFocused(node: ScrollNode | null, bottomOffset: number): void {
  const host = node?.getScrollableNode?.() ?? node;
  const doc = (globalThis as { document?: { activeElement?: unknown } }).document;
  const active = doc?.activeElement as ScrollNode | undefined;
  if (!host || !active || typeof host.contains !== "function" || !host.contains(active)) return;
  const rect = active.getBoundingClientRect?.();
  const g = globalThis as {
    innerHeight?: number;
    visualViewport?: { height?: number; offsetTop?: number };
  };
  if (!rect) return;
  const visibleBottom = g.visualViewport?.height !== undefined
    ? (g.visualViewport.offsetTop ?? 0) + g.visualViewport.height
    : (g.innerHeight ?? 0) - coveredPx();
  const overflow = rect.bottom + bottomOffset - visibleBottom;
  if (overflow > 0 && typeof host.scrollTop === "number") host.scrollTop += overflow;
}

/** How {@linkcode KeyboardAwareScrollView} adds room at the bottom. */
export type KeyboardAwareScrollViewMode = "insets" | "layout";

/** `KeyboardAwareScrollView` props (plus any `ScrollView` prop). */
export interface KeyboardAwareScrollViewProps {
  /** The gap in px to keep between the focused input and the keyboard (default 0). */
  bottomOffset?: number;
  /** Do not scroll back when the keyboard hides (the web never scrolls back). */
  disableScrollOnKeyboardHide?: boolean;
  /** `false` turns the behaviour off (default `true`). */
  enabled?: boolean;
  /** Extra px of room below the content while the keyboard is up. */
  extraKeyboardSpace?: number;
  /** How the room is added (ignored: a spacer at the end of the content). */
  mode?: KeyboardAwareScrollViewMode;
  /** The scroll view component (default React Native's `ScrollView`). */
  ScrollViewComponent?: VNodeType;
  /** A ref to the scroll view (with `assureFocusedInputVisible()` added). */
  ref?: unknown;
  /** The style. */
  style?: unknown;
  /** The content. */
  children?: VNodeChildren;
  /** Other `ScrollView` props. */
  [prop: string]: unknown;
}

/** Assign `value` to a ref (a function or an object). */
function assignRef(ref: unknown, value: unknown): void {
  if (typeof ref === "function") ref(value);
  else if (ref && typeof ref === "object") (ref as { current: unknown }).current = value;
}

/**
 * A `ScrollView` that keeps the focused input above the keyboard.
 *
 * @param props The offsets and the `ScrollView` props.
 * @returns The scroll view.
 */
export function KeyboardAwareScrollView(props: KeyboardAwareScrollViewProps): VNode {
  const {
    bottomOffset = 0,
    disableScrollOnKeyboardHide: _noScroll,
    enabled = true,
    extraKeyboardSpace = 0,
    mode: _mode,
    ScrollViewComponent,
    ref,
    style,
    children,
    ...rest
  } = props;
  const node = useRef<ScrollNode | null>(null);
  const [covered, setCovered] = useState(0);
  const latest = useRef({ bottomOffset, enabled });
  latest.current = { bottomOffset, enabled };
  useEffect(() => {
    const reveal = () => {
      if (latest.current.enabled) revealFocused(node.current, latest.current.bottomOffset);
    };
    const stop = onKeyboardChange((state) => {
      setCovered(state.visible ? coveredPx() || state.height : 0);
      if (state.visible) setTimeout(reveal, 0);
    });
    const doc = (globalThis as {
      document?: {
        addEventListener?: (t: string, f: () => void) => void;
        removeEventListener?: (t: string, f: () => void) => void;
      };
    }).document;
    doc?.addEventListener?.("focusin", reveal);
    return () => {
      stop();
      doc?.removeEventListener?.("focusin", reveal);
    };
  }, []);
  const Scroll = ScrollViewComponent ?? RN.ScrollView;
  const setRef = (instance: unknown) => {
    node.current = instance as ScrollNode | null;
    if (instance && typeof instance === "object") {
      (instance as { assureFocusedInputVisible?: () => void }).assureFocusedInputVisible = () =>
        revealFocused(node.current, latest.current.bottomOffset);
    }
    assignRef(ref, instance);
  };
  const room = enabled && covered > 0 ? covered + extraKeyboardSpace : 0;
  const spacer = room > 0
    ? h(hostView(), { style: viewStyle({ height: room }), "aria-hidden": "true" })
    : null;
  if (Scroll) {
    return h(Scroll, { ...rest, ref: setRef, style }, children, spacer);
  }
  return h(
    "div",
    { ...rest, ref: setRef, style: { ...domViewStyle(style), overflowY: "auto" } },
    children as never,
    spacer,
  );
}

/**
 * A chat scroll view: a {@linkcode KeyboardAwareScrollView} (the keyboard pushes the content
 * up by the covered height; inverted-list anchoring is left to the list).
 *
 * @param props The `ScrollView` props.
 * @returns The scroll view.
 */
export function KeyboardChatScrollView(props: KeyboardAwareScrollViewProps): VNode {
  return h(KeyboardAwareScrollView, props);
}

/** A toolbar theme's colours. */
export interface KeyboardToolbarColors {
  /** Enabled buttons. */
  primary: string;
  /** Disabled buttons. */
  disabled: string;
  /** The bar's background. */
  background: string;
  /** The press ripple. */
  ripple: string;
}

/** The toolbar's light and dark colours. */
export interface KeyboardToolbarTheme {
  /** Light mode. */
  light: KeyboardToolbarColors;
  /** Dark mode. */
  dark: KeyboardToolbarColors;
}

/** The package's default toolbar colours. */
export const DefaultKeyboardToolbarTheme: KeyboardToolbarTheme = {
  light: { primary: "#2c2c2c", disabled: "#B0BEC5", background: "#f3f3f4", ripple: "#bcbcbcbc" },
  dark: { primary: "#fafafa", disabled: "#707070", background: "#2C2C2E", ripple: "#F8F8F888" },
};

/** `KeyboardToolbar` props. */
export interface KeyboardToolbarProps {
  /** Content between the arrows and Done. */
  content?: VNodeChildren;
  /** The colours (default {@linkcode DefaultKeyboardToolbarTheme}). */
  theme?: KeyboardToolbarTheme;
  /** Done's label (default `Done`). */
  doneText?: VNodeChildren;
  /** Show the previous / next arrows (default `true`). */
  showArrows?: boolean;
  /** Called after "next". */
  onNextCallback?: (event: unknown) => void;
  /** Called after "previous". */
  onPrevCallback?: (event: unknown) => void;
  /** Called after "done". */
  onDoneCallback?: (event: unknown) => void;
  /** Background opacity as a hex pair (default `FF`). */
  opacity?: string;
  /** Left / right insets in px. */
  insets?: { left: number; right: number };
  /** Extra shift while the keyboard is closed / open. */
  offset?: { closed?: number; opened?: number };
  /** `false` hides the toolbar (default `true`). */
  enabled?: boolean;
  /** Compound parts (`KeyboardToolbar.Prev` / `.Next` / `.Done` / `.Content`) replacing the default layout. */
  children?: VNodeChildren;
  /** Other props (`button`, `icon`, `blur` are accepted and ignored). */
  [prop: string]: unknown;
}

/** Whether the page is in dark mode. */
function prefersDark(): boolean {
  const media = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  return typeof media === "function" && media("(prefers-color-scheme: dark)").matches;
}

/** A toolbar button. */
function toolbarButton(
  label: VNodeChildren,
  action: string,
  onPress: (event: unknown) => void,
  color: string,
): VNode {
  return h("button", {
    type: "button",
    "data-action": action,
    "aria-label": action,
    // Keep the input focused: the press must not take focus away.
    onMouseDown: (e: { preventDefault?: () => void }) => e.preventDefault?.(),
    onClick: onPress,
    style: {
      background: "none",
      border: 0,
      padding: "8px 12px",
      font: "inherit",
      color,
      cursor: "pointer",
    },
  }, label);
}

/** Compound "previous" button. */
function Prev(props: { onPress?: (e: unknown) => void; children?: VNodeChildren }): VNode {
  return toolbarButton(props.children ?? "‹", "previous", (e) => {
    KeyboardController.setFocusTo("prev");
    props.onPress?.(e);
  }, "inherit");
}

/** Compound "next" button. */
function Next(props: { onPress?: (e: unknown) => void; children?: VNodeChildren }): VNode {
  return toolbarButton(props.children ?? "›", "next", (e) => {
    KeyboardController.setFocusTo("next");
    props.onPress?.(e);
  }, "inherit");
}

/** Compound "done" button. */
function Done(
  props: { onPress?: (e: unknown) => void; text?: VNodeChildren; children?: VNodeChildren },
): VNode {
  return toolbarButton(props.children ?? props.text ?? "Done", "done", (e) => {
    void KeyboardController.dismiss();
    props.onPress?.(e);
  }, "inherit");
}

/** Compound content slot. */
function Content(props: { children?: VNodeChildren }): VNode {
  return h("div", { style: { flex: 1, display: "flex", alignItems: "center" } }, props.children);
}

/** Compound background slot. */
function Background(props: { children?: VNodeChildren }): VNode {
  return h("div", { style: { position: "absolute", inset: 0, zIndex: -1 } }, props.children);
}

/** A native group view (a plain view here). */
function Group(props: { children?: VNodeChildren; [prop: string]: unknown }): VNode {
  const { children, style, ...rest } = props;
  return h(hostView(), { ...rest, style: viewStyle(style) }, children as never);
}

/**
 * The toolbar body: rendered only while the keyboard is up, riding on it.
 */
function ToolbarImpl(props: KeyboardToolbarProps): VNode {
  const {
    content,
    theme = DefaultKeyboardToolbarTheme,
    doneText,
    showArrows = true,
    onNextCallback,
    onPrevCallback,
    onDoneCallback,
    opacity = "FF",
    insets,
    offset,
    enabled = true,
    children,
  } = props;
  const visible = useKeyboardState((s) => s.isVisible);
  if (!enabled || !visible) return null as unknown as VNode;
  const colors = prefersDark() ? theme.dark : theme.light;
  const background = /^#[0-9a-f]{6}$/i.test(colors.background)
    ? colors.background + opacity
    : colors.background;
  const body = children ?? [
    showArrows ? h(Prev, { onPress: onPrevCallback }) : null,
    showArrows ? h(Next, { onPress: onNextCallback }) : null,
    h(Content, null, content),
    h(Done, { onPress: onDoneCallback, text: doneText }),
  ];
  return h(MobileStickyView, {
    offset,
    role: "toolbar",
    "data-denext-keyboard-toolbar": "",
    style: {
      position: "fixed",
      left: 0,
      right: 0,
      bottom: 0,
      display: "flex",
      flexDirection: "row",
      alignItems: "center",
      height: 42,
      paddingLeft: insets?.left ?? 0,
      paddingRight: insets?.right ?? 0,
      background,
      color: colors.primary,
      zIndex: 1000,
    },
  }, body);
}

/** The toolbar with its compound parts. */
type ToolbarComponent = ((props: KeyboardToolbarProps) => VNode) & {
  /** The background slot. */
  Background: typeof Background;
  /** The content slot. */
  Content: typeof Content;
  /** The previous button. */
  Prev: typeof Prev;
  /** The next button. */
  Next: typeof Next;
  /** The done button. */
  Done: typeof Done;
  /** A native group (a plain view). */
  Group: typeof Group;
};

/**
 * A bar on top of the keyboard with previous / next (over the page's inputs in document
 * order) and Done (dismisses), shown while the keyboard is up. Compound parts
 * (`KeyboardToolbar.Prev`, `.Next`, `.Done`, `.Content`, `.Background`) replace the default
 * layout when given as children.
 */
export const KeyboardToolbar: ToolbarComponent = /* @__PURE__ */ Object.assign(ToolbarImpl, {
  Background,
  Content,
  Prev,
  Next,
  Done,
  Group,
});

/** `OverKeyboardView` props. */
export interface OverKeyboardViewProps {
  /** Whether it shows. */
  visible: boolean;
  /** The content. */
  children?: VNodeChildren;
}

/**
 * Content shown over everything (the keyboard included, natively) while `visible`: a fixed
 * full-screen layer here.
 *
 * @param props `visible` and the content.
 * @returns The layer, or nothing.
 */
export function OverKeyboardView(props: OverKeyboardViewProps): VNode {
  if (!props.visible) return null as unknown as VNode;
  return h("div", {
    "data-denext-over-keyboard": "",
    style: { position: "fixed", inset: 0, zIndex: 2147483000, pointerEvents: "box-none" },
  }, props.children);
}

/** `KeyboardExtender` props. */
export interface KeyboardExtenderProps {
  /** Whether it shows (default `true`). */
  enabled?: boolean;
  /** The content. */
  children?: VNodeChildren;
}

/**
 * Content that extends the keyboard (natively part of it): shown on top of the keyboard, as a
 * {@linkcode KeyboardStickyView} bar, while it is up.
 *
 * @param props `enabled` and the content.
 * @returns The bar, or nothing.
 */
export function KeyboardExtender(props: KeyboardExtenderProps): VNode {
  const visible = useKeyboardState((s) => s.isVisible);
  if (props.enabled === false || !visible) return null as unknown as VNode;
  return h(MobileStickyView, {
    style: { position: "fixed", left: 0, right: 0, bottom: 0 },
  }, props.children);
}

/**
 * Content drawn behind the keyboard (a translucent keyboard natively): its children, as is.
 *
 * @param props The content.
 * @returns The children.
 */
export function KeyboardEffects(props: { children?: VNodeChildren }): VNode {
  return h(Fragment, null, props.children);
}

/** A pass-through view (the package's native views, a plain view on the web). */
function passThroughView(
  props: { children?: unknown; style?: unknown; [p: string]: unknown },
): VNode {
  const { children, style, ...rest } = props;
  return h(hostView(), { ...rest, style: viewStyle(style) }, children as never);
}

/** The package's native container view (a plain view). */
export const KeyboardControllerView: typeof passThroughView = passThroughView;
/** The interactive-dismissal gesture area (a plain view: no keyboard gesture on the web). */
export const KeyboardGestureArea: typeof passThroughView = passThroughView;
/** The native over-keyboard view (a plain view). */
export const RCTOverKeyboardView: typeof passThroughView = passThroughView;
/** The native keyboard background view (a plain view). */
export const KeyboardBackgroundView: typeof passThroughView = passThroughView;
/** The native keyboard extender view (a plain view). */
export const RCTKeyboardExtender: typeof passThroughView = passThroughView;
/** The native clipping scroll view (a plain view). */
export const ClippingScrollView: typeof passThroughView = passThroughView;
/** The native toolbar group view (a plain view). */
export const RCTKeyboardToolbarGroupView: typeof passThroughView = passThroughView;
