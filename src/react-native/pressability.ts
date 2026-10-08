/**
 * React Native's `usePressability` for React Native mode: the press state machine behind
 * `Pressable` and the `Touchable*` components, as event handlers to spread on a `View` —
 * react-native-web's `View` runs the responder props (`onStartShouldSetResponder`,
 * `onResponderGrant` … `onResponderTerminate`), `onClick`, focus and mouse events. The order and
 * timing are React Native's: `onPressIn` (after `delayPressIn`), `onLongPress` after
 * `delayLongPress` (500 ms by default, counted from the press in), and on release `onPressOut`
 * (held until the press has lasted `minPressDuration`, 130 ms by default, or `delayPressOut`)
 * then `onPress` unless a long press took it. A pointer's click is the responder's; a click
 * without a pointer (the keyboard, assistive technology) presses directly, except the one that
 * trails a responder release (older WebKit's click has no `pointerType`): that is the same press.
 *
 * @module
 */

import { useInsertionEffect, useRef } from "../runtime/hooks.ts";

/** An event the handlers receive (react-native-web's synthetic responder / DOM event). */
export interface PressEvent {
  /** The native event. */
  readonly nativeEvent?: unknown;
  /** Keep the event (React Native's pooling; harmless here). */
  persist?(): void;
  /** The element the handler is on. */
  readonly currentTarget?: unknown;
  /** The element the event started at. */
  readonly target?: unknown;
  /** Stop the event bubbling. */
  stopPropagation?(): void;
}

/** React Native's `PressabilityConfig`. */
export interface PressabilityConfig {
  /** Whether a parent responder may take the gesture over (default `true`). */
  readonly cancelable?: boolean | null;
  /** Ignore presses. */
  readonly disabled?: boolean | null;
  /** Ms before `onPressIn` (default 0). */
  readonly delayPressIn?: number | null;
  /** Ms before `onPressOut` (default 0). */
  readonly delayPressOut?: number | null;
  /** Ms from the press in to `onLongPress` (default 500 − `delayPressIn`, at least 10). */
  readonly delayLongPress?: number | null;
  /** The least ms between `onPressIn` and `onPressOut` (default 130). */
  readonly minPressDuration?: number | null;
  /** Ms before `onHoverIn`. */
  readonly delayHoverIn?: number | null;
  /** Ms before `onHoverOut`. */
  readonly delayHoverOut?: number | null;
  /** Called on focus. */
  readonly onFocus?: ((event: PressEvent) => unknown) | null;
  /** Called on blur. */
  readonly onBlur?: ((event: PressEvent) => unknown) | null;
  /** The pointer entered. */
  readonly onHoverIn?: ((event: PressEvent) => unknown) | null;
  /** The pointer left. */
  readonly onHoverOut?: ((event: PressEvent) => unknown) | null;
  /** A long press. */
  readonly onLongPress?: ((event: PressEvent) => unknown) | null;
  /** A press. */
  readonly onPress?: ((event: PressEvent) => unknown) | null;
  /** The press began. */
  readonly onPressIn?: ((event: PressEvent) => unknown) | null;
  /** The touch moved while pressed. */
  readonly onPressMove?: ((event: PressEvent) => unknown) | null;
  /** The press ended. */
  readonly onPressOut?: ((event: PressEvent) => unknown) | null;
  /** Accepted (the web has no native responder to block). */
  readonly blockNativeResponder?: boolean | null;
  /** Accepted (no touch sound on the web). */
  readonly android_disableSound?: boolean | null;
  /** Accepted. */
  readonly hitSlop?: unknown;
  /** Accepted. */
  readonly pressRectOffset?: unknown;
}

/** The handlers `usePressability` returns, for a `View`. */
export interface PressabilityEventHandlers {
  onBlur(event: PressEvent): void;
  onFocus(event: PressEvent): void;
  onClick(event: PressEvent): void;
  onStartShouldSetResponder(): boolean;
  onResponderGrant(event: PressEvent): boolean;
  onResponderMove(event: PressEvent): void;
  onResponderRelease(event: PressEvent): void;
  onResponderTerminate(event: PressEvent): void;
  onResponderTerminationRequest(): boolean;
  onMouseEnter?(event: PressEvent): void;
  onMouseLeave?(event: PressEvent): void;
}

/** React Native's defaults. */
const LONG_PRESS_DELAY = 500;
const MIN_PRESS_DURATION = 130;
/** How long after a responder release its trailing click may arrive (ms). */
const TRAILING_CLICK_WINDOW = 1000;

/** React Native's `normalizeDelay`. */
function delay(value: number | null | undefined, min = 0, fallback = 0): number {
  return Math.max(min, value ?? fallback);
}

/** Where the press is. */
type PressState = "idle" | "pending" | "active" | "long";

/** One press target's state machine (React Native's `Pressability`, the touch part). */
class Pressability {
  config: PressabilityConfig;
  #state: PressState = "idle";
  #activatedAt = 0;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #pressInTimer: ReturnType<typeof setTimeout> | undefined;
  #longTimer: ReturnType<typeof setTimeout> | undefined;
  #hoverTimer: ReturnType<typeof setTimeout> | undefined;
  #hovered = false;
  /** When the last responder release happened, until its trailing click (if any) arrives. */
  #releasedAt: number | undefined;
  readonly handlers: PressabilityEventHandlers;

  constructor(config: PressabilityConfig) {
    this.config = config;
    this.handlers = this.#makeHandlers();
  }

  /** Clear every pending timer and return to idle (unmount). */
  reset(): void {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.#pressInTimer = this.#longTimer = this.#hoverTimer = undefined;
    this.#state = "idle";
  }

  #later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      fn();
    }, ms);
    this.#timers.add(t);
    return t;
  }

  #cancel(t: ReturnType<typeof setTimeout> | undefined): void {
    if (t === undefined) return;
    clearTimeout(t);
    this.#timers.delete(t);
  }

  #activate(event: PressEvent): void {
    this.#activatedAt = Date.now();
    this.config.onPressIn?.(event);
  }

  #deactivate(event: PressEvent): void {
    const { onPressOut } = this.config;
    if (!onPressOut) return;
    const held = Date.now() - this.#activatedAt;
    const wait = Math.max(
      delay(this.config.minPressDuration, 0, MIN_PRESS_DURATION) - held,
      delay(this.config.delayPressOut),
    );
    if (wait > 0) this.#later(() => onPressOut(event), wait);
    else onPressOut(event);
  }

  #grant(event: PressEvent): boolean {
    event.persist?.();
    this.#cancel(this.#pressInTimer);
    this.#cancel(this.#longTimer);
    this.#state = "pending";
    const pressIn = delay(this.config.delayPressIn);
    const toActive = (): void => {
      if (this.#state !== "pending") return;
      this.#state = "active";
      this.#activate(event);
    };
    if (pressIn > 0) this.#pressInTimer = this.#later(toActive, pressIn);
    else toActive();
    const longPress = delay(this.config.delayLongPress, 10, LONG_PRESS_DELAY - pressIn);
    this.#longTimer = this.#later(() => {
      if (this.#state !== "active") return;
      this.#state = "long";
      this.config.onLongPress?.(event);
    }, longPress + pressIn);
    return this.config.blockNativeResponder === true;
  }

  #release(event: PressEvent): void {
    const was = this.#state;
    this.#cancel(this.#pressInTimer);
    this.#cancel(this.#longTimer);
    this.#state = "idle";
    if (was === "idle") return;
    this.#releasedAt = Date.now();
    if (was === "pending") this.#activate(event);
    this.#deactivate(event);
    const { onLongPress, onPress } = this.config;
    if (onPress && !(onLongPress && was === "long")) onPress(event);
  }

  #terminate(event: PressEvent): void {
    const was = this.#state;
    this.#cancel(this.#pressInTimer);
    this.#cancel(this.#longTimer);
    this.#state = "idle";
    if (was === "active" || was === "long") this.#deactivate(event);
  }

  #hover(event: PressEvent, inside: boolean): void {
    if (inside === this.#hovered) return;
    this.#hovered = inside;
    this.#cancel(this.#hoverTimer);
    const cb = inside ? this.config.onHoverIn : this.config.onHoverOut;
    if (!cb) return;
    const wait = delay(inside ? this.config.delayHoverIn : this.config.delayHoverOut);
    if (wait > 0) this.#hoverTimer = this.#later(() => cb(event), wait);
    else cb(event);
  }

  #makeHandlers(): PressabilityEventHandlers {
    return {
      onBlur: (event) => void this.config.onBlur?.(event),
      onFocus: (event) => void this.config.onFocus?.(event),
      onClick: (event) => {
        const pointer = (event?.nativeEvent as { pointerType?: unknown } | undefined)
          ?.pointerType;
        // The click a responder release is followed by belongs to that press; older WebKit's
        // carries no pointerType, so it is told apart by arriving right after the release.
        const released = this.#releasedAt;
        this.#releasedAt = undefined;
        if (typeof pointer === "string" && pointer !== "") return; // the responder's press
        if (released !== undefined && Date.now() - released <= TRAILING_CLICK_WINDOW) return;
        if (event?.currentTarget !== event?.target) {
          event?.stopPropagation?.();
          return;
        }
        const { onPress, disabled } = this.config;
        if (onPress && disabled !== true) onPress(event);
      },
      onStartShouldSetResponder: () => this.config.disabled !== true,
      onResponderGrant: (event) => this.#grant(event),
      onResponderMove: (event) => void this.config.onPressMove?.(event),
      onResponderRelease: (event) => this.#release(event),
      onResponderTerminate: (event) => this.#terminate(event),
      onResponderTerminationRequest: () => this.config.cancelable ?? true,
      onMouseEnter: (event) => this.#hover(event, true),
      onMouseLeave: (event) => this.#hover(event, false),
    };
  }
}

/**
 * React Native's `usePressability`: press handlers for `config` (see the module docs), stable
 * for the component's life and re-configured on each render; `null` for a `null` config.
 *
 * @param config The press callbacks and delays.
 * @returns The handlers to spread on a `View`, or `null`.
 */
export function usePressability(
  config: PressabilityConfig | null | undefined,
): PressabilityEventHandlers | null {
  const ref = useRef<Pressability | null>(null);
  if (config != null && ref.current === null) ref.current = new Pressability(config);
  const pressability = ref.current;
  useInsertionEffect(() => {
    if (config != null && pressability) pressability.config = config;
  }, [config, pressability]);
  useInsertionEffect(() => {
    if (pressability) return () => pressability.reset();
  }, [pressability]);
  return pressability?.handlers ?? null;
}
