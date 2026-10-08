/**
 * The `UIManager` members React Native has and react-native-web lacks, for React Native mode.
 * A view is named by its element (what a ref holds; react-native-web has no numeric tags) or a
 * ref object holding it. The DOM answers what it can: `measureLayoutRelativeToParent`,
 * `viewIsDescendantOf`, `findSubviewIn` and `sendAccessibilityEvent` work on the elements;
 * `getConstants` / `getConstantsForViewManager` / `getDefaultEventTypes` / `lazilyLoadView`
 * report no native view managers. The Paper renderer's own calls (`createView`, `setChildren`,
 * `manageChildren`, `setJSResponder`, `clearJSResponder`) log the error React Native's New
 * Architecture logs for them and do nothing: React builds the DOM itself.
 *
 * @module
 */

/** A view: an element, or a ref object holding one. */
type ViewTag = unknown;

/** The slice of an element these members read. */
interface ViewNode {
  readonly nodeType?: number;
  readonly parentNode?: unknown;
  getBoundingClientRect?(): { left: number; top: number; width: number; height: number };
  contains?(other: unknown): boolean;
  focus?(): void;
  click?(): void;
  dispatchEvent?(event: unknown): boolean;
  ownerDocument?: { elementFromPoint?(x: number, y: number): unknown } | null;
}

/** The element a tag names, or null. */
function nodeOf(tag: ViewTag): ViewNode | null {
  const v = tag && typeof tag === "object" && "current" in (tag as object)
    ? (tag as { current: unknown }).current
    : tag;
  return v && typeof v === "object" && (v as ViewNode).nodeType === 1 ? v as ViewNode : null;
}

/** An element's frame in the viewport (zeros without layout). */
function rectOf(node: ViewNode): { left: number; top: number; width: number; height: number } {
  const r = node.getBoundingClientRect?.();
  return r
    ? { left: r.left, top: r.top, width: r.width, height: r.height }
    : { left: 0, top: 0, width: 0, height: 0 };
}

/** React Native's New Architecture error for a renderer-only call. */
function softError(method: string): void {
  console.error(
    `[ReactNative Architecture][JS] '${method}' is not available in the new React Native architecture.`,
  );
}

/** Android's `AccessibilityEvent` types `sendAccessibilityEvent` takes (React Native's). */
const ACCESSIBILITY_FOCUSED = 0x00000008;
const ACCESSIBILITY_CLICKED = 0x00000001;
const ACCESSIBILITY_WINDOW_STATE = 0x00000020;
const ACCESSIBILITY_HOVER_ENTER = 0x00000080;

/** The members, by name. */
const MEMBERS: Readonly<Record<string, unknown>> = {
  /** The view's frame relative to its parent: `callback(left, top, width, height)`. */
  measureLayoutRelativeToParent(
    tag: ViewTag,
    onFail: (error: unknown) => void,
    onSuccess: (left: number, top: number, width: number, height: number) => void,
  ): void {
    const node = nodeOf(tag);
    const parent = node ? nodeOf(node.parentNode) : null;
    if (!node || !parent) return onFail?.(new Error("measureLayoutRelativeToParent: no view"));
    const r = rectOf(node);
    const p = rectOf(parent);
    onSuccess(r.left - p.left, r.top - p.top, r.width, r.height);
  },
  /** `callback([isDescendant])`: whether `tag` is inside `ancestorTag` (not the same view). */
  viewIsDescendantOf(
    tag: ViewTag,
    ancestorTag: ViewTag,
    callback: (result: boolean[]) => void,
  ): void {
    const node = nodeOf(tag);
    const ancestor = nodeOf(ancestorTag);
    if (!node || !ancestor) return;
    callback([node !== ancestor && ancestor.contains?.(node) === true]);
  },
  /**
   * The deepest view at `point` (`[x, y]` in the view's coordinates): `callback(view, pageX,
   * pageY, width, height)`; nothing when the point is outside it.
   */
  findSubviewIn(
    tag: ViewTag,
    point: readonly number[],
    callback: (view: unknown, left: number, top: number, width: number, height: number) => void,
  ): void {
    const node = nodeOf(tag);
    if (!node) return;
    const r = rectOf(node);
    const hit = nodeOf(node.ownerDocument?.elementFromPoint?.(r.left + point[0], r.top + point[1]));
    if (!hit || (hit !== node && node.contains?.(hit) !== true)) return;
    const h = rectOf(hit);
    callback(hit, h.left, h.top, h.width, h.height);
  },
  /**
   * Android's accessibility events on the view: focused (8) moves focus to it, clicked (1)
   * clicks it; window-state (32) and hover-enter (128) have no web action; other types are
   * dropped with React Native's error.
   */
  sendAccessibilityEvent(tag: ViewTag, eventType: number): void {
    const node = nodeOf(tag);
    if (eventType === ACCESSIBILITY_FOCUSED) node?.focus?.();
    else if (eventType === ACCESSIBILITY_CLICKED) node?.click?.();
    else if (eventType !== ACCESSIBILITY_WINDOW_STATE && eventType !== ACCESSIBILITY_HOVER_ENTER) {
      console.error(
        `sendAccessibilityEvent() dropping event: Called with unsupported eventType: ${eventType}`,
      );
    }
  },
  /** The native view managers' constants: none on the web. */
  getConstants: (): Record<string, unknown> => ({}),
  /** A native view manager's constants: none on the web (`{}`). */
  getConstantsForViewManager: (_name: string): Record<string, unknown> => ({}),
  /** The native default event types: none on the web. */
  getDefaultEventTypes: (): string[] => [],
  /** Load a native view manager lazily: there is none to load (`{}`, as React Native's). */
  lazilyLoadView(_name: string): Record<string, unknown> {
    softError("lazilyLoadView");
    return {};
  },
  createView: () => softError("createView"),
  setChildren: () => softError("setChildren"),
  manageChildren: () => softError("manageChildren"),
  setJSResponder: () => softError("setJSResponder"),
  clearJSResponder: () => softError("clearJSResponder"),
};

/**
 * react-native-web's `UIManager` with the members React Native's has and it lacks (see the
 * module docs), added in place; a member it already has is kept.
 *
 * @param UIManager react-native-web's `UIManager`.
 * @returns The same object.
 */
export function withUIManagerStatics<T extends object>(UIManager: T): T {
  const u = UIManager as Record<string, unknown>;
  for (const [name, value] of Object.entries(MEMBERS)) u[name] ??= value;
  return UIManager;
}
