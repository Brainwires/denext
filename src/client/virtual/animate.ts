/**
 * `itemLayoutAnimation` for `VirtualList`: FLIP animations of the rendered rows when the DATA
 * changes (inserts fade in, removals fade out as a detached ghost, moved rows glide from their
 * old place). Only rows in the rendered window animate, only for data changes (never for a
 * scroll), and positions are read after the list re-anchored — so a row the anchor kept still
 * does not move, and anchoring never fights an animation. Off (the default) it costs nothing:
 * the controller never calls in here.
 *
 * Uses the Web Animations API (`Element.animate`); where it is missing nothing animates.
 *
 * @module
 */

/** Options of `itemLayoutAnimation`. */
export interface ItemLayoutAnimationOptions {
  /** Duration in ms. Default 200. */
  readonly duration?: number;
  /** CSS easing. Default `"ease"`. */
  readonly easing?: string;
  /** Animate inserted rows (fade + slight scale). Default `true`. */
  readonly enter?: boolean;
  /** Animate removed rows (a fading ghost). Default `true`. */
  readonly exit?: boolean;
}

/** A row's box before the change. */
interface Before {
  readonly el: Element;
  readonly top: number;
  readonly left: number;
  readonly width: number;
}

/** What a FLIP pass needs from the list. */
export interface FlipHost {
  /** Rendered row elements by key. */
  rows(): Iterable<readonly [string | number, Element]>;
  /** The element to hang exit ghosts in (the list's inner element). */
  ghostParent(): Element | null;
}

/** Whether `el.animate` exists. */
function canAnimate(el: Element): el is Element & { animate: Element["animate"] } {
  return typeof (el as { animate?: unknown }).animate === "function";
}

/** `el.getBoundingClientRect()`, or `undefined` without layout. */
function box(el: Element): DOMRect | undefined {
  try {
    const r = el.getBoundingClientRect?.();
    return r && (r.width !== 0 || r.height !== 0) ? r : undefined;
  } catch {
    return undefined;
  }
}

/** Snapshot before a data change; `play` after the commit. */
export class FlipSnapshot {
  readonly #before = new Map<string | number, Before>();
  readonly #keys: ReadonlySet<string | number>;

  /**
   * @param host The list.
   * @param oldKeys Every key of the OLD data that is rendered (to tell a scrolled-in row from
   * an inserted one).
   */
  constructor(host: FlipHost, readonly oldKeys: ReadonlySet<string | number>) {
    for (const [key, el] of host.rows()) {
      const r = box(el);
      if (r) this.#before.set(key, { el, top: r.top, left: r.left, width: r.width });
    }
    this.#keys = oldKeys;
  }

  /**
   * Animate: moved rows from their old box, new keys (absent from the old data) in, and
   * removed keys (absent from `newKeys`) out.
   */
  // fallow-ignore-next-line unused-class-member -- called by the controller (`#playFlip`)
  play(
    host: FlipHost,
    isNewKey: (key: string | number) => boolean,
    isRemoved: (key: string | number) => boolean,
    opts: ItemLayoutAnimationOptions,
  ): void {
    const timing = { duration: opts.duration ?? 200, easing: opts.easing ?? "ease" };
    const seen = new Set<string | number>();
    for (const [key, el] of host.rows()) {
      seen.add(key);
      if (canAnimate(el)) this.#animateRow(key, el, isNewKey, opts, timing);
    }
    if (opts.exit !== false) this.#exitRemoved(host, seen, isRemoved, timing);
  }

  /** A rendered row: slide it from its old box, or fade a new key in. */
  #animateRow(
    key: string | number,
    el: Element & { animate: Element["animate"] },
    isNewKey: (key: string | number) => boolean,
    opts: ItemLayoutAnimationOptions,
    timing: KeyframeAnimationOptions,
  ): void {
    const was = this.#before.get(key);
    if (!was) {
      if (opts.enter !== false && isNewKey(key)) {
        el.animate(
          [{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "none" }],
          timing,
        );
      }
      return;
    }
    const now = box(el);
    if (!now) return;
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], timing);
  }

  /** Fade out a ghost of every old rendered row whose key was removed from the data. */
  #exitRemoved(
    host: FlipHost,
    seen: ReadonlySet<string | number>,
    isRemoved: (key: string | number) => boolean,
    timing: KeyframeAnimationOptions,
  ): void {
    const parent = host.ghostParent();
    for (const [key, was] of this.#before) {
      if (seen.has(key) || !isRemoved(key) || !parent || !this.#keys.has(key)) continue;
      this.#ghost(parent, was, timing);
    }
  }

  /** A fading copy of a removed row, laid over where it was. */
  #ghost(parent: Element, was: Before, timing: KeyframeAnimationOptions): void {
    const clone = (was.el as Element & { cloneNode?: (deep: boolean) => Node }).cloneNode?.(true) as
      | HTMLElement
      | undefined;
    const origin = box(parent);
    if (!clone || !origin || !canAnimate(clone)) return;
    clone.removeAttribute?.("data-vl-row");
    clone.setAttribute?.("aria-hidden", "true");
    clone.setAttribute?.("data-vl-ghost", "");
    const s = clone.style;
    if (!s) return;
    s.position = "absolute";
    s.top = `${was.top - origin.top}px`;
    s.left = `${was.left - origin.left}px`;
    s.width = `${was.width}px`;
    s.pointerEvents = "none";
    s.margin = "0";
    parent.appendChild(clone);
    const anim = clone.animate([{ opacity: 1 }, { opacity: 0 }], timing);
    const done = () => clone.remove?.();
    if (anim && "finished" in anim) anim.finished.then(done, done);
    else setTimeout(done, (timing.duration as number) + 50);
  }
}
