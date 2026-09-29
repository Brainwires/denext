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
 * scrolling ancestors, innermost first, then the document: smoothly, starting with the keyboard's
 * own ~250 ms animation (at once under `prefers-reduced-motion`).
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
  scrollTo?(options: { top: number; behavior: "smooth" | "instant" }): void;
}

/** How long a smooth reveal runs: iOS's keyboard animation, which it moves with. */
const SMOOTH_MS = 250;

/** Until when a smooth reveal is in flight (re-checks wait for it rather than chase it). */
let smoothUntil = 0;

/** Whether the user asked for reduced motion (then the reveal is instant). */
function reducedMotion(): boolean {
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  try {
    return typeof mm === "function" && mm("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Scroll `box` to `top`: smoothly (in step with the keyboard) where the element can, else at
 * once.
 */
function scrollBoxTo(box: ScrollBox, top: number, smooth: boolean): void {
  if (smooth && typeof box.scrollTo === "function") {
    box.scrollTo({ top, behavior: "smooth" });
    smoothUntil = Date.now() + SMOOTH_MS + 30;
  } else box.scrollTop = top;
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
function scrollUpBy(field: ScrollBox, delta: number, smooth: boolean): number {
  let left = delta;
  for (let p = field.parentElement; p && left > 0.5; p = p.parentElement) {
    if (!scrolls(p)) continue;
    const before = p.scrollTop;
    const top = Math.min(before + left, p.scrollHeight - p.clientHeight);
    if (top <= before) continue;
    scrollBoxTo(p, top, smooth);
    left -= top - before;
  }
  const doc = (globalThis as { document?: { scrollingElement?: ScrollBox | null } }).document
    ?.scrollingElement;
  if (doc && left > 0.5) {
    const top = Math.min(doc.scrollTop + left, doc.scrollHeight - doc.clientHeight);
    if (top > doc.scrollTop) {
      left -= top - doc.scrollTop;
      scrollBoxTo(doc, top, smooth);
    }
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
  if (shift <= 0.5) return false;
  // Smooth, in step with the keyboard (instant under reduced motion). While one runs the
  // field's position is mid-flight: a re-check then waits for the next trigger.
  if (Date.now() < smoothUntil) return false;
  return scrollUpBy(field, shift, !reducedMotion()) < shift;
}

/** The page-lifetime watcher: how many views use it, the latest covered height, its re-check. */
interface Watcher {
  users: number;
  covered: number;
  check: () => void;
  stop: () => void;
}

let watcher: Watcher | undefined;

/**
 * Reveal the field on the next animation frame (at once without `requestAnimationFrame`),
 * tracking the queued frame's id in `frames` until it runs.
 */
function revealNextFrame(frames: Set<number>, covered: () => number): void {
  const raf = (globalThis as { requestAnimationFrame?: (fn: () => void) => number })
    .requestAnimationFrame;
  if (!raf) {
    revealFocusedField(covered());
    return;
  }
  let ran = false;
  let id = 0;
  id = raf(() => {
    ran = true;
    frames.delete(id);
    revealFocusedField(covered());
  });
  // A synchronous rAF (tests) has already run: nothing left to cancel.
  if (!ran) frames.add(id);
}

/** The page's listeners: window and visual-viewport resizes and `focusin` re-check the field. */
function startWatcher(g: {
  addEventListener: EventTarget["addEventListener"];
  removeEventListener?: EventTarget["removeEventListener"];
  visualViewport?: EventTarget | null;
  document: EventTarget;
}): Watcher {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  // Frames queued by a settled timer, cancelled with the timers so no reveal runs after `stop`.
  const frames = new Set<number>();
  const w: Watcher = {
    users: 0,
    covered: 0,
    check: () => {
      for (const ms of SETTLE_MS) {
        const t = setTimeout(() => {
          timers.delete(t);
          revealNextFrame(frames, () => w.covered);
        }, ms);
        timers.add(t);
      }
    },
    stop: () => {
      g.removeEventListener?.("resize", w.check);
      vv?.removeEventListener("resize", w.check);
      g.document.removeEventListener("focusin", w.check);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      const caf = (globalThis as { cancelAnimationFrame?: (id: number) => void })
        .cancelAnimationFrame;
      if (caf) { for (const id of frames) caf(id); }
      frames.clear();
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
