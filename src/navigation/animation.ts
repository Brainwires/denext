/**
 * The stack's motion, as data: the platform look, `prefers-reduced-motion`, the keyframes of
 * every {@linkcode StackAnimation} for a push and a pop, the per-frame styles of the
 * interactive iOS swipe and Android predictive back, the View Transition stylesheet built from
 * the same keyframes, and the Web Animations runner that is its fallback.
 *
 * Every animation moves only `transform`, `opacity` and `filter`, which the compositor runs off
 * the main thread.
 *
 * @module
 */

import type { NavigationPlatform, StackAnimation } from "./types.ts";

/** A push adds a screen on top; a pop removes the top one. */
export type StackDirection = "push" | "pop";

/** One keyframe: the only properties the stack animates. */
export interface StackKeyframe {
  readonly offset?: number;
  readonly transform?: string;
  readonly opacity?: number;
  readonly filter?: string;
}

/** A transition between two screens, as keyframes for each. */
export interface StackFrames {
  /** Length in ms (`0` for none). */
  readonly duration: number;
  /** The CSS easing. */
  readonly easing: string;
  /** The screen arriving on top (push: the new screen; pop: the one revealed below). */
  readonly incoming: readonly StackKeyframe[];
  /** The screen leaving (push: the old top, going under; pop: the popped screen). */
  readonly outgoing: readonly StackKeyframe[];
  /** Whether the outgoing screen paints above the incoming one (a pop's popped screen). */
  readonly outgoingOnTop: boolean;
}

/** iOS: UINavigationController's curve and length. */
const IOS_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/** Material 3's emphasized-decelerate curve. */
const MATERIAL_EASING = "cubic-bezier(0.2, 0, 0, 1)";

/** The iOS parallax: the screen underneath travels this share of the width. */
const PARALLAX = 0.3;
/** The screen underneath is dimmed to this brightness at rest. */
const DIM = 0.9;

/** The user agent string, or `""` (SSR reads it off the request through the context bridge). */
function userAgent(): string {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  if (typeof document !== "undefined" && typeof nav?.userAgent === "string") return nav.userAgent;
  const bridge = (globalThis as {
    __denextCurrentRequestContext?: () => { request?: Request } | undefined;
  }).__denextCurrentRequestContext;
  return bridge?.()?.request?.headers.get("user-agent") ?? nav?.userAgent ?? "";
}

/**
 * The platform look for `ua` (default: the browser's, or on the server the request's): Android
 * for an Android user agent, iOS for everything else (iPhone, iPad, desktop). Both sides read the
 * user agent, so a server render and the hydrating client agree.
 */
export function detectPlatform(ua: string = userAgent()): NavigationPlatform {
  return /\bAndroid\b/i.test(ua) ? "android" : "ios";
}

/** Whether the user asked for reduced motion (`false` on the server). */
export function prefersReducedMotion(): boolean {
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  if (typeof document === "undefined" || typeof mm !== "function") return false;
  try {
    return mm("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** `"default"` resolved to the platform's own animation. */
export function resolveAnimation(
  animation: StackAnimation | undefined,
  platform: NavigationPlatform,
): Exclude<StackAnimation, "default" | "simple_push"> {
  if (!animation || animation === "default") {
    return platform === "android" ? "shared_axis_x" : "ios_from_right";
  }
  return animation === "simple_push" ? "slide_from_right" : animation;
}

/** `translateX(n%)`. */
const tx = (pct: number): string => `translateX(${pct}%)`;
/** `translateY(n%)`. */
const ty = (pct: number): string => `translateY(${pct}%)`;
/** `brightness(n)`. */
const dim = (n: number): string => `brightness(${n})`;

/** Push keyframes `[incoming, outgoing]` per resolved animation; a pop plays them backwards. */
function pushFrames(
  animation: Exclude<StackAnimation, "default" | "simple_push">,
): [StackKeyframe[], StackKeyframe[]] {
  switch (animation) {
    case "ios_from_right":
    case "ios_from_left": {
      const s = animation === "ios_from_right" ? 1 : -1;
      return [
        [{ transform: tx(100 * s) }, { transform: tx(0) }],
        [{ transform: tx(0), filter: dim(1) }, {
          transform: tx(-PARALLAX * 100 * s),
          filter: dim(DIM),
        }],
      ];
    }
    case "slide_from_right":
    case "slide_from_left": {
      const s = animation === "slide_from_right" ? 1 : -1;
      return [
        [{ transform: tx(100 * s) }, { transform: tx(0) }],
        [{ transform: tx(0) }, { transform: tx(-100 * s) }],
      ];
    }
    case "slide_from_bottom":
      return [[{ transform: ty(100) }, { transform: ty(0) }], []];
    case "fade_from_bottom":
      return [
        [{ transform: ty(8), opacity: 0 }, { transform: ty(0), opacity: 1 }],
        [],
      ];
    case "shared_axis_x":
      return [
        [
          { offset: 0, transform: "translateX(30px)", opacity: 0 },
          { offset: 0.35, transform: "translateX(19.5px)", opacity: 0 },
          { offset: 1, transform: "translateX(0px)", opacity: 1 },
        ],
        [
          { offset: 0, transform: "translateX(0px)", opacity: 1 },
          { offset: 0.35, transform: "translateX(-10.5px)", opacity: 0 },
          { offset: 1, transform: "translateX(-30px)", opacity: 0 },
        ],
      ];
    case "fade":
      return [[{ opacity: 0 }, { opacity: 1 }], [{ opacity: 1 }, { opacity: 0 }]];
    case "none":
      return [[], []];
  }
}

/** `frames` played backwards (offsets mirrored). */
function reversed(frames: readonly StackKeyframe[]): StackKeyframe[] {
  return [...frames].reverse().map((
    f,
  ) => (f.offset === undefined ? f : { ...f, offset: 1 - f.offset }));
}

/**
 * The keyframes of `animation` for a `direction`. A pop is the push played backwards: the
 * popped screen leaves the way it came (on top) and the screen below returns. With reduced
 * motion every animation but `"none"` becomes a 150 ms fade.
 *
 * @param animation The screen's animation (the pushed screen's for a push, the popped one's for a pop).
 * @param direction Push or pop.
 * @param platform The platform look (resolves `"default"`).
 * @param options `duration` overrides the length; `reducedMotion` defaults to the media query.
 */
export function stackFrames(
  animation: StackAnimation | undefined,
  direction: StackDirection,
  platform: NavigationPlatform,
  options: { duration?: number; reducedMotion?: boolean } = {},
): StackFrames {
  const resolved = resolveAnimation(animation, platform);
  const reduced = options.reducedMotion ?? prefersReducedMotion();
  if (resolved === "none") {
    return { duration: 0, easing: "linear", incoming: [], outgoing: [], outgoingOnTop: false };
  }
  if (reduced) {
    const fadeIn = [{ opacity: 0 }, { opacity: 1 }];
    const fadeOut = [{ opacity: 1 }, { opacity: 0 }];
    return {
      duration: 150,
      easing: "linear",
      incoming: fadeIn,
      outgoing: fadeOut,
      outgoingOnTop: direction === "pop",
    };
  }
  const [inFrames, outFrames] = pushFrames(resolved);
  const duration = options.duration ?? (platform === "android" ? 300 : 350);
  const easing = platform === "android" ? MATERIAL_EASING : IOS_EASING;
  if (direction === "push") {
    return { duration, easing, incoming: inFrames, outgoing: outFrames, outgoingOnTop: false };
  }
  // A pop: the popped screen plays its push entrance backwards, the one below its push exit.
  return {
    duration,
    easing,
    incoming: reversed(outFrames),
    outgoing: reversed(inFrames),
    outgoingOnTop: true,
  };
}

/** A per-frame style for a screen while a gesture drives it. */
export interface GestureStyle {
  readonly transform: string;
  readonly filter?: string;
  readonly borderRadius?: string;
}

/**
 * The iOS interactive swipe at `progress` (0…1) across a `width` px screen: the top screen
 * follows the finger, the one below slides back from the parallax offset and brightens.
 */
export function swipeFrame(
  progress: number,
  width: number,
): { top: GestureStyle; below: GestureStyle } {
  const p = Math.min(1, Math.max(0, progress));
  return {
    top: { transform: `translateX(${p * width}px)` },
    below: {
      transform: `translateX(${-PARALLAX * width * (1 - p)}px)`,
      filter: dim(DIM + (1 - DIM) * p),
    },
  };
}

/**
 * Android's predictive back at `progress` (0…1) from `edge`: the top screen shrinks to 90%,
 * shifts away from the edge the gesture started at, and rounds its corners; the screen below
 * waits underneath.
 */
export function predictiveFrame(
  progress: number,
  edge: "left" | "right" | "none",
  width: number,
): { top: GestureStyle; below: GestureStyle } {
  const p = Math.min(1, Math.max(0, progress));
  const shift = (edge === "right" ? -1 : 1) * p * width * 0.06;
  return {
    top: {
      transform: `translateX(${shift}px) scale(${1 - 0.1 * p})`,
      borderRadius: `${Math.round(28 * p)}px`,
    },
    below: { transform: "none" },
  };
}

// ---- View Transitions -------------------------------------------------------------------

/** The `view-transition-name` a stack screen carries during its transition. */
export const VT_NAME = "dnx-stack";

/** CSS for one keyframe. */
function keyframeCss(f: StackKeyframe): string {
  const parts: string[] = [];
  if (f.transform !== undefined) parts.push(`transform:${f.transform}`);
  if (f.opacity !== undefined) parts.push(`opacity:${f.opacity}`);
  if (f.filter !== undefined) parts.push(`filter:${f.filter}`);
  return parts.join(";");
}

/** An `@keyframes` rule for `frames` (spread evenly when they carry no offsets). */
function keyframesRule(name: string, frames: readonly StackKeyframe[]): string {
  const n = frames.length;
  const steps = frames.map((f, i) => {
    const at = f.offset ?? (n === 1 ? 1 : i / (n - 1));
    return `${Math.round(at * 1000) / 10}%{${keyframeCss(f)}}`;
  });
  return `@keyframes ${name}{${steps.join("")}}`;
}

/**
 * The View Transition rules for one animation look: `html[data-dnx-stack-anim][data-dnx-stack-dir]`
 * selects them while the stack's transition runs (the stack sets both attributes and names the
 * two screens {@linkcode VT_NAME}). The rest of the page (`root`) switches without a cross-fade.
 *
 * @param key The attribute value (`<animation>.<platform>`, or `reduced`).
 * @param push The push frames.
 * @param pop The pop frames.
 */
export function viewTransitionCss(key: string, push: StackFrames, pop: StackFrames): string {
  const out: string[] = [];
  for (const [dir, frames] of [["push", push], ["pop", pop]] as const) {
    const sel = `html[data-dnx-stack-anim="${key}"][data-dnx-stack-dir="${dir}"]`;
    const slug = `dnx-${key.replace(/[^a-z0-9]+/gi, "-")}-${dir}`;
    const timing = `${frames.duration}ms ${frames.easing} both`;
    const role = (r: "old" | "new", kf: readonly StackKeyframe[], z: number) => {
      const name = `${slug}-${r}`;
      if (kf.length > 0) out.push(keyframesRule(name, kf));
      const anim = kf.length > 0 ? `${name} ${timing}` : "none";
      out.push(
        `${sel}::view-transition-${r}(${VT_NAME}){animation:${anim};mix-blend-mode:normal;z-index:${z}}`,
      );
    };
    role("old", frames.outgoing, frames.outgoingOnTop ? 2 : 1);
    role("new", frames.incoming, frames.outgoingOnTop ? 1 : 2);
    out.push(`${sel}::view-transition-group(${VT_NAME}){animation:none}`);
    out.push(`${sel}::view-transition-image-pair(${VT_NAME}){isolation:auto}`);
    out.push(`${sel}::view-transition-old(root),${sel}::view-transition-new(root){animation:none}`);
  }
  return out.join("\n");
}

/** The stylesheet the stack's rules go into, created on first use. */
let sheet: { add(css: string): void } | null = null;
/** The rule keys already added. */
let installed: Set<string> | null = null;

/** The adopted stylesheet (CSP-safe: CSSOM, not an inline `<style>`), else a `<style>` element. */
function stackSheet(): { add(css: string): void } | null {
  if (sheet) return sheet;
  if (typeof document === "undefined") return null;
  const doc = document as Document & { adoptedStyleSheets?: CSSStyleSheet[] };
  try {
    if (Array.isArray(doc.adoptedStyleSheets) && typeof CSSStyleSheet === "function") {
      const css = new CSSStyleSheet();
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, css];
      sheet = {
        add(text) {
          for (const rule of splitRules(text)) {
            try {
              css.insertRule(rule, css.cssRules.length);
            } catch { /* an unsupported selector (no View Transitions): skip the rule */ }
          }
        },
      };
      return sheet;
    }
  } catch { /* fall through to a <style> element */ }
  const el = document.createElement("style");
  el.setAttribute("data-dnx-navigation", "");
  document.head?.appendChild(el);
  sheet = {
    add(text) {
      el.textContent = (el.textContent ?? "") + text + "\n";
    },
  };
  return sheet;
}

/** Split a stylesheet into top-level rules (brace depth 0), for `insertRule`. */
export function splitRules(css: string): string[] {
  const rules: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const rule = css.slice(start, i + 1).trim();
        if (rule) rules.push(rule);
        start = i + 1;
      }
    }
  }
  return rules;
}

/** Add `css` to the stack's stylesheet once per `key` (no-op on the server). */
export function ensureStyles(key: string, css: () => string): void {
  installed ??= new Set();
  if (installed.has(key)) return;
  const target = stackSheet();
  if (!target) return;
  installed.add(key);
  target.add(css());
}

/**
 * Make sure the View Transition rules for `animation` on `platform` exist, and return the key
 * to put in `data-dnx-stack-anim`.
 */
export function ensureViewTransitionRules(
  animation: StackAnimation | undefined,
  platform: NavigationPlatform,
  duration?: number,
): string {
  const reduced = prefersReducedMotion();
  const key = reduced
    ? "reduced"
    : `${resolveAnimation(animation, platform)}.${platform}${duration ? "." + duration : ""}`;
  ensureStyles(`vt:${key}`, () =>
    viewTransitionCss(
      key,
      stackFrames(animation, "push", platform, { duration, reducedMotion: reduced }),
      stackFrames(animation, "pop", platform, { duration, reducedMotion: reduced }),
    ));
  return key;
}

// ---- Web Animations ---------------------------------------------------------------------

/** The part of an element the runner animates. */
export interface Animatable {
  animate?(
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
  ): { finished: Promise<unknown>; cancel(): void };
}

/**
 * Play `frames` on `el` with the Web Animations API, holding the end state (`fill: "both"`)
 * until the caller cancels it. Resolves `null` where the API is missing or there is nothing to
 * play, so the caller simply skips to the end state.
 */
export function playFrames(
  el: Animatable | null | undefined,
  frames: readonly StackKeyframe[],
  timing: { duration: number; easing: string },
): { finished: Promise<unknown>; cancel(): void } | null {
  if (!el || typeof el.animate !== "function" || frames.length === 0 || timing.duration <= 0) {
    return null;
  }
  try {
    return el.animate(frames as Keyframe[], { ...timing, fill: "both" });
  } catch {
    return null;
  }
}
