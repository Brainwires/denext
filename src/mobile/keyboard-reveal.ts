/**
 * Keep the focused text field above the on-screen keyboard while a keyboard-aware view
 * ({@linkcode KeyboardAvoidingView}, React Native mode's, {@linkcode KeyboardStickyView}) is
 * mounted. The views make room; this scrolls the field into it.
 *
 * WebKit scrolls a field into view when it is focused, which is before the keyboard is up: where
 * the WebView then resizes around the keyboard (the iOS shell's default `resize: "native"`,
 * Android) the field ends up under the new bottom edge, inside an inner scroller that nothing
 * scrolls, and where the keyboard covers the page (`resize: "none"`) the room a view makes
 * appears after the focus scroll. So after every viewport resize, overlap change and focus, once
 * layout settles, a field whose bottom is below the visible bottom (the visual viewport's, less
 * the part of the keyboard that covers the page) is scrolled up by the difference through its
 * scrolling ancestors, innermost first, then the document.
 *
 * Internal to `denext/mobile`; not re-exported.
 *
 * @module
 */

/** Space kept between the field and the keyboard, in px. */
const GAP_PX = 12;

/** When to re-check after a trigger: next frame, then once the keyboard animation has ended. */
const SETTLE_MS: readonly number[] = [0, 120, 320];

/** The slice of an element this module reads and scrolls. */
interface ScrollBox {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly parentElement: ScrollBox | null;
  getBoundingClientRect(): { top: number; bottom: number };
}

/** Whether `el` is a text field the keyboard is up for (an input that takes text, a textarea, contenteditable). */
function isTextField(el: unknown): boolean {
  const e = el as { tagName?: string; type?: string; isContentEditable?: boolean } | null;
  if (!e || typeof e.tagName !== "string") return false;
  if (e.isContentEditable) return true;
  const tag = e.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag !== "input") return false;
  return !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i.test(
    e.type ?? "text",
  );
}

/** Whether `el` scrolls vertically (content taller than it, and `overflow-y` lets it scroll). */
function scrolls(el: ScrollBox): boolean {
  if (el.scrollHeight <= el.clientHeight + 1) return false;
  const overflow = getComputedStyle(el as unknown as Element).overflowY;
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

/**
 * Scroll `field` up by `delta` px through its scrolling ancestors (innermost first, each as far
 * as it can), then the document for what is left.
 *
 * @returns The px it could not scroll.
 */
function scrollUpBy(field: ScrollBox, delta: number): number {
  let left = delta;
  for (let p = field.parentElement; p && left > 0.5; p = p.parentElement) {
    if (!scrolls(p)) continue;
    const before = p.scrollTop;
    p.scrollTop = Math.min(before + left, p.scrollHeight - p.clientHeight);
    left -= p.scrollTop - before;
  }
  const doc = (globalThis as { document?: { scrollingElement?: ScrollBox | null } }).document
    ?.scrollingElement;
  if (doc && left > 0.5) {
    const before = doc.scrollTop;
    doc.scrollTop = before + left;
    left -= doc.scrollTop - before;
  }
  return Math.max(0, left);
}

/**
 * The bottom of what the user sees, in viewport px: the visual viewport's bottom, and no lower
 * than the layout viewport's height less the part of the keyboard that covers the page.
 */
function visibleBottom(coveredPx: number): number {
  const g = globalThis as {
    innerHeight?: number;
    visualViewport?: { height: number; offsetTop: number } | null;
  };
  const layout = (g.innerHeight ?? 0) - coveredPx;
  const vv = g.visualViewport;
  return vv ? Math.min(vv.offsetTop + vv.height, layout) : layout;
}

/**
 * Scroll the focused text field above the keyboard when it is below the visible bottom.
 *
 * @param coveredPx The part of the layout viewport the keyboard covers (0 when the WebView
 *   resizes around it).
 * @returns Whether it scrolled.
 */
export function revealFocusedField(coveredPx: number): boolean {
  const doc = (globalThis as { document?: { activeElement?: unknown } }).document;
  const field = doc?.activeElement as ScrollBox | null | undefined;
  if (!field || !isTextField(field)) return false;
  const rect = field.getBoundingClientRect();
  const delta = rect.bottom + GAP_PX - visibleBottom(coveredPx);
  if (delta <= 0.5) return false;
  // A field taller than the visible area keeps its top in view instead.
  const shift = Math.min(delta, Math.max(0, rect.top - GAP_PX));
  return shift > 0.5 && scrollUpBy(field, shift) < shift;
}

/** The page-lifetime watcher: how many views use it, the latest covered height, its re-check. */
interface Watcher {
  users: number;
  covered: number;
  check: () => void;
  stop: () => void;
}

let watcher: Watcher | undefined;

/** The page's listeners: window and visual-viewport resizes and `focusin` re-check the field. */
function startWatcher(g: {
  addEventListener: EventTarget["addEventListener"];
  removeEventListener?: EventTarget["removeEventListener"];
  visualViewport?: EventTarget | null;
  document: EventTarget;
}): Watcher {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const w: Watcher = {
    users: 0,
    covered: 0,
    check: () => {
      for (const ms of SETTLE_MS) {
        const t = setTimeout(() => {
          timers.delete(t);
          const raf = (globalThis as { requestAnimationFrame?: (fn: () => void) => void })
            .requestAnimationFrame;
          if (raf) raf(() => revealFocusedField(w.covered));
          else revealFocusedField(w.covered);
        }, ms);
        timers.add(t);
      }
    },
    stop: () => {
      g.removeEventListener?.("resize", w.check);
      vv?.removeEventListener("resize", w.check);
      g.document.removeEventListener("focusin", w.check);
      for (const t of timers) clearTimeout(t);
    },
  };
  const vv = g.visualViewport;
  g.addEventListener("resize", w.check);
  vv?.addEventListener("resize", w.check);
  g.document.addEventListener("focusin", w.check);
  return w;
}

/**
 * Join the page's reveal watcher (started by the first view, stopped when the last leaves).
 *
 * @returns `leave`, and `covered` to report the latest covered height (a change re-checks).
 */
export function joinFocusedFieldReveal(): { leave: () => void; covered: (px: number) => void } {
  const g = globalThis as {
    addEventListener?: EventTarget["addEventListener"];
    removeEventListener?: EventTarget["removeEventListener"];
    visualViewport?: EventTarget | null;
    document?: EventTarget;
  };
  if (typeof g.addEventListener !== "function" || !g.document) {
    return { leave: () => {}, covered: () => {} };
  }
  const w = watcher ??= startWatcher(g as Parameters<typeof startWatcher>[0]);
  w.users++;
  let left = false;
  return {
    leave: () => {
      if (left) return;
      left = true;
      if (--w.users > 0) return;
      w.stop();
      if (watcher === w) watcher = undefined;
    },
    covered: (px: number) => {
      if (w.covered === px) return;
      w.covered = px;
      w.check();
    },
  };
}
