/**
 * `LayoutAnimation.configureNext` for React Native mode: FLIP over the next DOM commit.
 *
 * React Native animates every view the next layout pass moves, creates or deletes.
 * react-native-web ships the API as a no-op. Here `configureNext` measures the page's elements,
 * waits for the next DOM change (the commit the app's `setState` causes), measures again before
 * that frame paints, and plays Web Animations from the old geometry to the new one:
 *
 *   - `update`: a view that moved is translated from its old position (FLIP; a transform, so
 *     the compositor runs it). A view that changed size snaps to its new size (size is layout,
 *     which a compositor animation can't touch without distorting the content).
 *   - `create`: a view that appeared animates `create.property` (`opacity` or a scale) in.
 *   - `delete`: a view that disappeared is drawn once more, as a snapshot clone in a fixed
 *     layer at its old place, and animates the property out.
 *
 * Each block's `type` maps to a CSS easing (`spring` to a sampled `linear()` spring). A
 * document with more than {@linkcode MAX_ELEMENTS} elements is not measured (the callback still
 * fires). React Native mode's build routes react-native-web's
 * `UIManager.configureNextLayoutAnimation` here (src/build/reanimated-offload.ts); the module is
 * loaded as source and has no imports.
 *
 * @module
 */

/** A `LayoutAnimation` animation block (`create` / `update` / `delete`). */
export interface LayoutAnimationAnim {
  type?: string;
  property?: string;
  duration?: number;
  delay?: number;
  springDamping?: number;
}

/** `LayoutAnimation.configureNext`'s config. */
export interface LayoutAnimationConfig {
  duration?: number;
  create?: LayoutAnimationAnim;
  update?: LayoutAnimationAnim;
  delete?: LayoutAnimationAnim;
}

/** The most elements measured; a bigger document skips the animation. */
const MAX_ELEMENTS = 3000;

/** How long a configured animation waits for its commit before it is dropped (ms). */
const WAIT_MS = 1000;

/** The pending configuration, its snapshot and the observer waiting for the commit. */
interface Pending {
  config: LayoutAnimationConfig;
  rects: Map<Element, DOMRect>;
  observer: MutationObserver;
  records: MutationRecord[];
  timer: ReturnType<typeof setTimeout>;
  callbacks: (() => void)[];
}

let pending: Pending | null = null;

/** The easing for a block's `type`. */
export function easingFor(anim: LayoutAnimationAnim | undefined): string {
  switch (anim?.type) {
    case "linear":
      return "linear";
    case "easeIn":
      return "ease-in";
    case "easeOut":
    case "keyboard":
      return "ease-out";
    case "spring":
      return springEasing(anim.springDamping ?? 0.5);
    default:
      return "ease-in-out";
  }
}

/** A damped spring's progress curve as a CSS `linear()` easing (ease-out without support). */
export function springEasing(damping: number): string {
  const zeta = Math.min(Math.max(damping, 0.05), 1);
  const omega = 12;
  const points: string[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const decay = Math.exp(-zeta * omega * t);
    const wd = omega * Math.sqrt(Math.max(1 - zeta * zeta, 1e-4));
    const x = 1 - decay * (Math.cos(wd * t) + (zeta * omega / wd) * Math.sin(wd * t));
    points.push((i === 40 ? 1 : x).toFixed(4));
  }
  const value = `linear(${points.join(", ")})`;
  return typeof CSS !== "undefined" && CSS.supports?.("animation-timing-function", value)
    ? value
    : "ease-out";
}

/** The keyframe that hides a created / deleted view by `property`. */
export function hiddenFrame(property: string | undefined, transform: string): Keyframe {
  const base = transform === "none" ? "" : ` ${transform}`;
  switch (property) {
    case "scaleX":
      return { transform: `scaleX(0)${base}` };
    case "scaleY":
      return { transform: `scaleY(0)${base}` };
    case "scaleXY":
      return { transform: `scale(0)${base}` };
    default:
      return { opacity: 0 };
  }
}

/** The elements to measure; null when there are too many. */
function measurable(): Element[] | null {
  const all = document.body?.getElementsByTagName("*");
  if (!all || all.length > MAX_ELEMENTS) return null;
  return [...all].filter((el) => el.namespaceURI === "http://www.w3.org/1999/xhtml");
}

/** Every element's page rectangle. */
function snapshot(elements: Element[]): Map<Element, DOMRect> {
  const rects = new Map<Element, DOMRect>();
  for (const el of elements) rects.set(el, el.getBoundingClientRect());
  return rects;
}

/**
 * Schedule a layout animation for the next DOM change (React Native's
 * `LayoutAnimation.configureNext`).
 *
 * @param config The animation blocks and duration.
 * @param onAnimationDidEnd Called once the animations have finished (or when nothing animates).
 */
export function configureNext(
  config: LayoutAnimationConfig,
  onAnimationDidEnd?: () => void,
): void {
  const done = typeof onAnimationDidEnd === "function" ? onAnimationDidEnd : () => {};
  if (pending) {
    pending.config = config;
    pending.callbacks.push(done);
    return;
  }
  const elements = typeof document === "undefined" || typeof Element === "undefined" ||
      typeof Element.prototype.animate !== "function"
    ? null
    : measurable();
  if (!elements) {
    queueMicrotask(done);
    return;
  }
  const records: MutationRecord[] = [];
  let scheduled = false;
  // The first change is the commit: measure again in that frame's animation callbacks, after
  // the rest of the commit has landed and before it paints.
  const observer = new MutationObserver((list) => {
    records.push(...list);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => apply(observer));
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  pending = {
    config,
    rects: snapshot(elements),
    observer,
    records,
    timer: setTimeout(() => drop(observer), WAIT_MS),
    callbacks: [done],
  };
}

/** Give up on a configuration whose commit never came. */
function drop(observer: MutationObserver): void {
  if (pending?.observer !== observer) return;
  const { callbacks } = pending;
  observer.disconnect();
  pending = null;
  callbacks.forEach((cb) => cb());
}

/** The page's current state against the snapshot: play the animations. */
function apply(observer: MutationObserver): void {
  if (pending?.observer !== observer) return;
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  observer.disconnect();
  p.records.push(...observer.takeRecords());
  const anims = [
    ...moveAnimations(p),
    ...createAnimations(p),
    ...deleteAnimations(p),
  ];
  Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => {
    p.callbacks.forEach((cb) => cb());
  });
}

/** An animation block's timing. */
function timingOf(config: LayoutAnimationConfig, anim: LayoutAnimationAnim | undefined) {
  return {
    duration: anim?.duration ?? config.duration ?? 300,
    delay: anim?.delay ?? 0,
    easing: easingFor(anim),
    fill: "backwards" as const,
  };
}

/** The moved views' FLIP translations (each relative to its nearest moved ancestor). */
function moveAnimations(p: Pending): Animation[] {
  const update = p.config.update;
  if (!update) return [];
  const timing = timingOf(p.config, update);
  const shift = new Map<Element, { x: number; y: number }>();
  const out: Animation[] = [];
  for (const [el, before] of p.rects) {
    if (!el.isConnected) continue;
    const after = el.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    shift.set(el, { x: dx, y: dy });
    const inherited = inheritedShift(el, shift);
    const x = dx - inherited.x;
    const y = dy - inherited.y;
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue;
    const transform = getComputedStyle(el).transform;
    const own = transform === "none" ? "" : ` ${transform}`;
    out.push(el.animate([{ transform: `translate(${x}px, ${y}px)${own}` }, {}], timing));
  }
  return out;
}

/** The translation an element's nearest measured ancestor already applies to it. */
function inheritedShift(el: Element, shift: Map<Element, { x: number; y: number }>) {
  for (let a = el.parentElement; a; a = a.parentElement) {
    const s = shift.get(a);
    if (s) return s;
  }
  return { x: 0, y: 0 };
}

/** The views added by the commit (the roots of each added subtree). */
function addedRoots(p: Pending): Element[] {
  const out = new Set<Element>();
  for (const r of p.records) {
    for (const n of r.addedNodes) {
      if (n instanceof Element && n.isConnected && !p.rects.has(n)) out.add(n);
    }
  }
  return [...out].filter((el) => ![...out].some((o) => o !== el && o.contains(el)));
}

/** The created views' entrance. */
function createAnimations(p: Pending): Animation[] {
  const create = p.config.create;
  if (!create) return [];
  const timing = timingOf(p.config, create);
  return addedRoots(p).map((el) =>
    el.animate([hiddenFrame(create.property, getComputedStyle(el).transform), {}], timing)
  );
}

/** The removed views (the roots of each removed subtree that was measured). */
function removedRoots(p: Pending): { el: Element; rect: DOMRect }[] {
  const out: { el: Element; rect: DOMRect }[] = [];
  for (const r of p.records) {
    for (const n of r.removedNodes) {
      const rect = n instanceof Element && !n.isConnected ? p.rects.get(n) : undefined;
      if (rect && rect.width > 0 && rect.height > 0) out.push({ el: n as Element, rect });
    }
  }
  return out;
}

/** The deleted views' exit, played on snapshot clones in a fixed layer. */
function deleteAnimations(p: Pending): Animation[] {
  const del = p.config.delete;
  const removed = del ? removedRoots(p) : [];
  if (removed.length === 0) return [];
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  document.body.appendChild(layer);
  const timing = { ...timingOf(p.config, del), fill: "forwards" as const };
  const anims = removed.map(({ el, rect }) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.style.position = "fixed";
    clone.style.margin = "0";
    clone.style.left = `${rect.left}px`;
    clone.style.top = `${rect.top}px`;
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    layer.appendChild(clone);
    return clone.animate([{}, hiddenFrame(del!.property, "none")], timing);
  });
  Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => layer.remove());
  return anims;
}
