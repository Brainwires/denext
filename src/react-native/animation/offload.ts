/**
 * Reanimated off the main thread: the runtime half of React Native mode's compositor pass.
 *
 * Reanimated's web build runs every animation as a `requestAnimationFrame` loop on the page's
 * main thread: each frame advances the animation object, re-runs the `useAnimatedStyle`
 * updaters that read it, and writes inline styles. A busy main thread (a long React render, a
 * big JSON parse) stops the motion. This module moves the common declarative patterns to the
 * Web Animations API, which the browser runs on its compositor thread when only `transform`
 * and `opacity` change:
 *
 *   - a shared value assigned an animation (`sv.value = withTiming(1)`) whose every reader is
 *     a `useAnimatedStyle` that maps it to `transform` / `opacity` (other keys constant);
 *   - an animation returned from the style itself
 *     (`useAnimatedStyle(() => ({ opacity: withTiming(on ? 1 : 0) }))`) on those two keys;
 *
 * for `withTiming`, `withSpring`, `withDelay`, `withSequence` and `withRepeat` (infinite too)
 * trees. The animation is simulated ahead of time on a fresh copy (built again from the
 * factory arguments recorded by {@linkcode tagAnimation}), the style updaters are sampled at
 * every 60 Hz frame of it, and the samples become one keyframe list per view. The real
 * animation object is left started but idle, so whenever the pass lets go early (the shared
 * value is assigned again, another input of a held style changes, a style mapper starts or
 * stops) it is fast-forwarded through the same frames and handed back to Reanimated's own
 * loop, or interrupted exactly where the compositor had it (`commitStyles()` first, so there
 * is no flash). Reading `sv.value` while the compositor runs returns the interpolated value.
 *
 * Anything else falls back to Reanimated's loop, unchanged: another reader of the shared value
 * (`useDerivedValue`, `useAnimatedReaction`, `useAnimatedProps`), a style key other than
 * `transform` / `opacity`, an animation factory the pass does not know (`withDecay`,
 * `withClamp`, a custom `defineAnimation`), a callback on a nested animation, a
 * `withDelay` over a still-running animation, a view that is not a DOM element, or a browser
 * without `Element.animate`. `globalThis.__DENEXT_REANIMATED_WAAPI = false` turns the pass off.
 *
 * The build (src/build/reanimated-offload.ts) patches Reanimated 4's web modules to call the
 * functions exported here; each patched file imports this module as `denext-reanimated-offload`.
 * It has no imports of its own: it is loaded as source into the app bundle.
 *
 * @module
 */

// deno-lint-ignore-file no-explicit-any

/** The frame length the simulation steps by (Reanimated's web loop at 60 Hz). */
const FRAME = 1000 / 60;

/** The longest finite animation simulated (30 s); a longer one stays on the main thread. */
const MAX_FRAMES = 60 * 30;

/** The only style keys the compositor animates. */
const COMPOSITOR_KEYS = new Set(["opacity", "transform"]);

/** A Reanimated animation object (the fields this module reads and writes). */
export interface AnimationObject {
  onFrame: (animation: AnimationObject, now: number) => boolean;
  onStart: (animation: AnimationObject, value: unknown, now: number, previous: unknown) => void;
  current: unknown;
  callback?: ((finished: boolean) => void) | null;
  finished?: boolean;
  timestamp?: number;
  [key: string]: unknown;
}

/** A Reanimated shared value on the web (`makeMutable`). */
export interface SharedValue {
  value: unknown;
  _value: unknown;
  _animation?: AnimationObject | null;
}

/** A Reanimated mapper (`mappers.js`). */
export interface Mapper {
  id: unknown;
  dirty: boolean;
  worklet: (...args: any[]) => void;
  inputs: SharedValue[];
}

/** The animation factories the pass knows, and their callback argument (-1: none). */
const CALLBACK_ARG = { timing: 2, spring: 2, repeat: 3, sequence: -1, delay: -1 } as const;

/** An animation factory's name. */
export type AnimationKind = keyof typeof CALLBACK_ARG;

/** How an animation was made: its factory (untagged) and the arguments. */
interface Spec {
  base: (...args: unknown[]) => unknown;
  args: unknown[];
  kind: AnimationKind;
}

/** What a `useAnimatedStyle` mapper animates. */
interface StyleMeta {
  viewDescriptors: { value?: { tag: unknown }[] | null };
  updater: () => Record<string, unknown> | undefined;
  isAnimatedProps: boolean;
}

/** One infinite `withRepeat` found in a tree, and the `withDelay` above it (if any). */
interface Loop {
  repeat: AnimationObject;
  reverse: boolean;
  delay?: AnimationObject;
}

/** A tree's copy for simulation, and what the copy revealed. */
interface Copy {
  clone: AnimationObject;
  hasDelay: boolean;
  loop?: Loop;
}

/** A simulated trajectory: one sample per frame; `loopTo >= 0` when it repeats forever. */
export interface Track {
  samples: unknown[];
  loopFrom: number;
  loopTo: number;
}

/** The WAAPI timing of a set of tracks. */
interface Timing {
  indices: number[];
  duration: number;
  delay: number;
  infinite: boolean;
}

/** A real animation the compositor stands in for, and how far it has been fast-forwarded. */
interface Driven {
  real: AnimationObject;
  track: Track;
  ran: number;
}

/** A shared-value animation on the compositor. */
interface ValueOffload {
  mutable: SharedValue;
  origin: Origin;
  driven: Driven;
  t0: number;
  mappers: Mapper[];
  anims: Animation[];
  /** Taken from Reanimated's running loop: whether that loop's frame step is still pending. */
  loop?: { pending: boolean };
}

/** A style-returned animation on the compositor. */
interface StyleOffload {
  state: StyleState;
  viewDescriptors: StyleMeta["viewDescriptors"];
  leaves: Map<AnimationObject, Driven>;
  keys: string[];
  t0: number;
  anims: Animation[];
  isAnimatedProps: boolean;
  updateProps: UpdateProps;
}

/** `useAnimatedStyle`'s remote state (`useAnimatedStyleCommon.js`). */
export interface StyleState {
  animations: Record<string, unknown>;
  last: Record<string, unknown>;
  isAnimationRunning: boolean;
  isAnimationCancelled?: boolean;
}

/** Reanimated's `updateProps(viewDescriptors, updates, isAnimatedProps)`. */
export type UpdateProps = (
  viewDescriptors: StyleMeta["viewDescriptors"],
  updates: Record<string, unknown>,
  isAnimatedProps: boolean,
) => void;

const specs = new WeakMap<object, Spec>();
const listenersOf = new WeakMap<object, Map<unknown, unknown>>();
const mappers = new Map<unknown, Mapper>();
const styleMetas = new WeakMap<object, StyleMeta>();
const starts = new WeakMap<object, { value: unknown; previous: unknown }>();
const activeValues = new WeakMap<object, ValueOffload>();
const heldBy = new WeakMap<Mapper, ValueOffload>();
const activeStyles = new WeakMap<object, StyleOffload>();
let sampling: { mutable: object; value: unknown } | null = null;
let toDomStyle: ((style: Record<string, unknown>) => Record<string, unknown>) | null = null;

/** Whether the pass can run here. */
function enabled(): boolean {
  return toDomStyle !== null && sampling === null &&
    (globalThis as any).__DENEXT_REANIMATED_WAAPI !== false &&
    typeof Element !== "undefined" && typeof Element.prototype.animate === "function";
}

/** The clock Reanimated's web loop and the document timeline share. */
function now(): number {
  return performance.now();
}

// ---------------------------------------------------------------------------------------------
// Hooks the patched Reanimated modules call.

/**
 * Wrap an animation factory (`withTiming`, …) so each animation it returns remembers its
 * factory and arguments, which is how the pass builds an independent copy to simulate.
 *
 * @param base The factory.
 * @param kind Which factory it is.
 * @returns The wrapped factory (it carries the worklet stamps of `base`).
 */
export function tagAnimation<F extends (...args: any[]) => unknown>(
  base: F,
  kind: AnimationKind,
): F {
  const tagged = function (this: unknown, ...args: unknown[]) {
    const animation = base.apply(this, args);
    if (animation !== null && typeof animation === "object") {
      specs.set(animation, { base, args, kind });
    }
    return animation;
  };
  for (const key of ["__closure", "__workletHash", "__initData"]) {
    const d = Object.getOwnPropertyDescriptor(base, key);
    if (d) Object.defineProperty(tagged, key, d);
  }
  return tagged as unknown as F;
}

/** A shared value was made: remember its listener map (`makeMutable`). */
export function trackMutable(mutable: object, listeners: Map<unknown, unknown>): void {
  listenersOf.set(mutable, listeners);
}

/**
 * A shared value's `.value` read: the sampled value while the pass samples the style
 * updaters, the interpolated value while the compositor runs its animation, else `raw`.
 */
export function readValue(mutable: object, raw: unknown): unknown {
  if (sampling !== null && sampling.mutable === mutable) return sampling.value;
  const o = activeValues.get(mutable);
  return o ? valueAt(o.driven.track, (now() - o.t0) / FRAME) : raw;
}

/**
 * A mapper started: a held shared value it reads goes back to Reanimated's loop, and a shared
 * value whose animation that loop runs is offered to the compositor again.
 */
export function mapperStarted(mapper: Mapper): void {
  mappers.set(mapper.id, mapper);
  for (const input of mapper.inputs ?? []) {
    const o = activeValues.get(input);
    if (o) handBack(o);
    // Once the mapper is registered (its listeners are added after this hook), the running
    // animation may be taken again with the new reader sampled too.
    if (candidates.has(input)) queueMicrotask(() => adopt(input));
  }
}

/** A mapper stopped: the animation holding it goes back to Reanimated's loop. */
export function mapperStopped(mapper: Mapper): void {
  mappers.delete(mapper.id);
  const o = heldBy.get(mapper);
  if (o) handBack(o);
}

/** A mapper is about to run (another input changed): its held animation goes back. */
export function beforeMapperRun(mapper: Mapper): void {
  const o = heldBy.get(mapper);
  if (o) handBack(o);
}

/** A `useAnimatedStyle` mapper worklet and what it animates. */
export function styleMapper(
  worklet: object,
  viewDescriptors: StyleMeta["viewDescriptors"],
  updater: StyleMeta["updater"],
  isAnimatedProps: boolean,
  isJest: boolean,
): void {
  if (!isJest) styleMetas.set(worklet, { viewDescriptors, updater, isAnimatedProps });
}

/** `prepareAnimation` is about to start a style animation from `value`. */
export function noteAnimationStart(animation: object, value: unknown, previous: unknown): void {
  starts.set(animation, { value, previous });
}

/**
 * The React Native Web style → DOM style converters (`createReactDOMStyle`,
 * `createTransformValue`) Reanimated writes inline styles with; the keyframes use them too.
 */
export function setStyleConverter(
  createReactDOMStyle: ((style: Record<string, unknown>) => Record<string, unknown>) | undefined,
  createTransformValue: ((transform: unknown[]) => string) | undefined,
): void {
  if (typeof createReactDOMStyle !== "function") return;
  toDomStyle = (style) => {
    const dom = { ...createReactDOMStyle(style) };
    if (Array.isArray(dom.transform) && typeof createTransformValue === "function") {
      dom.transform = createTransformValue(dom.transform);
    }
    return dom;
  };
}

// ---------------------------------------------------------------------------------------------
// Simulation.

/** An animation object (not a plain value or a style object). */
function isAnimation(value: unknown): value is AnimationObject {
  return value !== null && typeof value === "object" &&
    typeof (value as AnimationObject).onFrame === "function";
}

/** A copy of one factory argument; `undefined` means the tree can't be copied. */
function copyArg(
  arg: unknown,
  i: number,
  spec: Spec,
  top: boolean,
  depth: number,
  out: Copy,
): unknown {
  const callback = CALLBACK_ARG[spec.kind];
  if (i === callback) {
    // The top animation's callback is called by Reanimated (valueSetter / runAnimations) on
    // the real object; a nested one would fire from inside the simulation.
    return typeof arg === "function" && !top ? undefined : null;
  }
  if (isAnimation(arg)) return copyTree(arg, depth, out)?.clone;
  return typeof arg === "function" ? undefined : arg;
}

/**
 * Copy an animation tree from its recorded factories; null when some part is unknown or a
 * forever-repeat sits where the pass can't loop it (anywhere but the whole tree or the one
 * child of a top `withDelay`).
 */
function copyTree(animation: AnimationObject, depth: number, out: Copy): Copy | null {
  const spec = specs.get(animation);
  const args = spec && copyArgs(spec, depth, out);
  const clone = args && spec!.base(...args);
  if (!isAnimation(clone) || !noteKind(spec!, args!, clone, depth, out)) return null;
  out.clone = clone;
  return out;
}

/** The copies of a factory's arguments; null when one can't be copied. */
function copyArgs(spec: Spec, depth: number, out: Copy): unknown[] | null {
  const args: unknown[] = [];
  for (let i = 0; i < spec.args.length; i++) {
    const copy = copyArg(spec.args[i], i, spec, depth === 0, depth + 1, out);
    if (copy === undefined) return null;
    args.push(copy === null ? undefined : copy);
  }
  return args;
}

/** Record what a copied node reveals (a delay, a forever-repeat); false when it can't loop. */
function noteKind(
  spec: Spec,
  args: unknown[],
  clone: AnimationObject,
  depth: number,
  out: Copy,
): boolean {
  if (spec.kind === "delay") out.hasDelay = true;
  const forever = spec.kind === "repeat" && !(((args[1] as number | undefined) ?? 2) > 0);
  if (!forever) return true;
  if (out.loop !== undefined || depth > 1) return false;
  out.loop = { repeat: clone, reverse: args[2] === true };
  return true;
}

/** The copy of `animation` to simulate. */
function copyFor(animation: AnimationObject): Copy | null {
  const copy = copyTree(animation, 0, { hasDelay: false } as Copy);
  if (!copy?.loop || copy.loop.repeat === copy.clone) return copy;
  // The loop is one level down: only under a top `withDelay`.
  if (specs.get(animation)!.kind !== "delay") return null;
  copy.loop.delay = copy.clone;
  return copy;
}

/**
 * Simulate an animation on an independent copy from `value` at `t0`, one sample per frame,
 * the way Reanimated's web loop steps it.
 *
 * @returns The trajectory, or null when the tree can't be copied, runs longer than 30 s, or
 *   repeats forever in a place the pass can't loop.
 */
export function simulate(
  animation: AnimationObject,
  value: unknown,
  previous: unknown,
  t0: number,
): Track | null {
  const copy = startedCopy(animation, value, previous, t0);
  return copy && runCopy(copy, t0);
}

/** The copy of `animation`, started like the real one; null when it can't be simulated. */
function startedCopy(
  animation: AnimationObject,
  value: unknown,
  previous: unknown,
  t0: number,
): Copy | null {
  const copy = copyFor(animation);
  const prev = previous as AnimationObject | null | undefined;
  // A `withDelay` steps the animation it replaces: the copy would advance the real one.
  if (!copy || (copy.hasDelay && prev && !prev.finished)) return null;
  copy.clone.onStart(copy.clone, value, t0, previous);
  return copy;
}

/** Step a started copy on the frame grid until it ends or its loop closes. */
function runCopy({ clone, loop }: Copy, t0: number): Track | null {
  const samples: unknown[] = [];
  const cycle = { loopFrom: -1 };
  for (let k = 0; k <= MAX_FRAMES; k++) {
    const done = clone.onFrame(clone, t0 + k * FRAME);
    samples.push(clone.current);
    if (done) return loop ? null : { samples, loopFrom: -1, loopTo: -1 };
    const end = loop && loopEnd(loop, k, cycle);
    if (end !== undefined) return end ? { samples, loopFrom: cycle.loopFrom, loopTo: k } : null;
  }
  return null;
}

/**
 * Track a forever-repeat's first cycle at frame `k`: `cycle.loopFrom` is set when the repeat
 * starts. Returns undefined while the cycle runs, then whether it is a usable loop.
 */
function loopEnd(loop: Loop, k: number, cycle: { loopFrom: number }): boolean | undefined {
  if (cycle.loopFrom < 0 && (loop.delay === undefined || loop.delay.started === true)) {
    cycle.loopFrom = k;
  }
  if ((loop.repeat.reps as number) < (loop.reverse ? 2 : 1)) return undefined;
  return cycle.loopFrom >= 0 && k > cycle.loopFrom;
}

/** A track's value at fractional frame `f` (linear between numeric samples). */
export function valueAt(track: Track, f: number): unknown {
  const { samples, loopFrom, loopTo } = track;
  let x = Math.max(0, f);
  if (loopTo >= 0 && x > loopFrom) x = loopFrom + ((x - loopFrom) % (loopTo - loopFrom));
  x = Math.min(x, samples.length - 1);
  const i = Math.floor(x);
  const a = samples[i];
  const b = samples[Math.min(i + 1, samples.length - 1)];
  return typeof a === "number" && typeof b === "number" ? a + (b - a) * (x - i) : a;
}

/** A track's sample at frame `k` (the last one once it has ended). */
function sampleAt(track: Track, k: number): unknown {
  return track.samples[Math.min(k, track.samples.length - 1)];
}

/** The WAAPI timing of `tracks` played together; null when they can't share one. */
function timingOf(tracks: Track[]): Timing | null {
  const loops = tracks.filter((t) => t.loopTo >= 0);
  if (loops.length > 0) {
    if (tracks.length !== 1) return null;
    const { loopFrom, loopTo } = loops[0];
    const indices: number[] = [];
    for (let k = loopFrom; k <= loopTo; k++) indices.push(k);
    return {
      indices,
      duration: (loopTo - loopFrom) * FRAME,
      delay: loopFrom * FRAME,
      infinite: true,
    };
  }
  const n = Math.max(...tracks.map((t) => t.samples.length));
  if (n < 2) return null;
  return { indices: [...Array(n).keys()], duration: (n - 1) * FRAME, delay: 0, infinite: false };
}

/** Advance a real animation through the simulation's frames up to `until`; true when done. */
function advance(d: Driven, t0: number, until: number): boolean {
  const limit = d.track.loopTo >= 0 ? Number.MAX_SAFE_INTEGER : d.track.samples.length + 1;
  while (d.ran <= limit && t0 + d.ran * FRAME <= until) {
    const t = t0 + d.ran * FRAME;
    d.ran++;
    const done = d.real.onFrame(d.real, t);
    d.real.timestamp = t;
    if (done) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Keyframes.

/** A view's DOM element (Reanimated's `_updatePropsJS` path); null when not animatable. */
function elementOf(tag: unknown): HTMLElement | null {
  const ref = tag as { getAnimatableRef?: () => unknown } | null;
  const el = (ref && typeof ref.getAnimatableRef === "function" ? ref.getAnimatableRef() : ref) as
    | (HTMLElement & { setNativeProps?: unknown })
    | null;
  if (!el || typeof el.setNativeProps === "function" || el.style === undefined) return null;
  return typeof el.animate === "function" ? el : null;
}

/** The DOM elements of a view set; null when one of them can't be animated. */
function elementsOf(viewDescriptors: StyleMeta["viewDescriptors"]): HTMLElement[] | null {
  const out: HTMLElement[] = [];
  for (const d of viewDescriptors.value ?? []) {
    const el = elementOf(d.tag);
    if (!el) return null;
    out.push(el);
  }
  return out;
}

/** Keyframes for `styles` (one per sampled frame) over `keys`, constant runs collapsed. */
function keyframesOf(styles: Record<string, unknown>[], keys: string[]): Keyframe[] {
  const n = styles.length;
  const frames = styles.map((style, i) => {
    const picked: Record<string, unknown> = {};
    for (const key of keys) picked[key] = style[key];
    const dom = toDomStyle!(picked);
    const frame: Keyframe = { offset: n === 1 ? 0 : i / (n - 1) };
    for (const key of keys) frame[key] = String(dom[key]);
    return frame;
  });
  const same = (a: Keyframe, b: Keyframe) => keys.every((k) => a[k] === b[k]);
  return frames.filter((f, i) =>
    i === 0 || i === n - 1 || !same(f, frames[i - 1]) || !same(f, frames[i + 1])
  );
}

/** Start the compositor animations; their start is pinned to the simulation's `t0`. */
function play(elements: HTMLElement[], keyframes: Keyframe[], timing: Timing, t0: number) {
  return elements.map((el) => {
    const a = el.animate(keyframes, {
      duration: timing.duration,
      delay: timing.delay,
      iterations: timing.infinite ? Infinity : 1,
      fill: "both",
      easing: "linear",
    });
    try {
      a.startTime = t0;
    } catch { /* a timeline without that clock: the animation starts now */ }
    return a;
  });
}

/** Leave the current visual inline and stop the compositor animations. */
function stop(anims: Animation[]): void {
  for (const a of anims) {
    try {
      a.commitStyles();
    } catch { /* not rendered: nothing to keep */ }
    a.cancel();
  }
}

// ---------------------------------------------------------------------------------------------
// A shared value's animation.

/** A plan for one held style mapper: its elements and keyframes (none when constant). */
interface MapperPlan {
  mapper: Mapper;
  elements: HTMLElement[];
  keyframes: Keyframe[] | null;
}

/** The style mappers reading `mutable`; null when another kind of reader exists. */
function styleReaders(mutable: object): { mapper: Mapper; meta: StyleMeta }[] | null {
  const listeners = listenersOf.get(mutable);
  if (!listeners || listeners.size === 0) return null;
  const out: { mapper: Mapper; meta: StyleMeta }[] = [];
  for (const id of listeners.keys()) {
    const mapper = mappers.get(id);
    const meta = mapper && styleMetas.get(mapper.worklet);
    // A style another offloaded shared value already drives stays with Reanimated's loop.
    if (!mapper || !meta || meta.isAnimatedProps || heldBy.has(mapper)) return null;
    out.push({ mapper, meta });
  }
  return out;
}

/**
 * Run the readers that are already due (a mapper that just started, or whose other input
 * changed this tick) now, the way the next mapper run would: their inline style is then the
 * start of the animation, and their pending run does not hand the animation straight back.
 */
function flushDue(readers: { mapper: Mapper }[]): void {
  for (const { mapper } of readers) {
    if (!mapper.dirty) continue;
    mapper.dirty = false;
    mapper.worklet();
  }
}

/** A style value with no animation object inside. */
function isStatic(value: unknown): boolean {
  if (isAnimation(value)) return false;
  if (Array.isArray(value)) return value.every(isStatic);
  if (value !== null && typeof value === "object") return Object.values(value).every(isStatic);
  return true;
}

/** The keys of `styles` whose value changes across samples; null when a sample is unusable. */
function varyingKeys(styles: Record<string, unknown>[]): string[] | null {
  const keys = Object.keys(styles[0]);
  const first = keys.map((k) => JSON.stringify(styles[0][k]));
  const varying = new Set<string>();
  for (const style of styles) {
    const own = Object.keys(style);
    if (own.length !== keys.length || !own.every(isStaticKey(style))) return null;
    keys.forEach((k, i) => {
      if (JSON.stringify(style[k]) !== first[i]) varying.add(k);
    });
  }
  return [...varying];
}

/** A predicate: `key` is in `style` and its value holds no animation. */
function isStaticKey(style: Record<string, unknown>) {
  return (key: string) => key in style && isStatic(style[key]);
}

/** Sample a style mapper's updater at each frame of the shared value's track. */
function sampleUpdater(
  mutable: object,
  meta: StyleMeta,
  track: Track,
  indices: number[],
): Record<string, unknown>[] | null {
  const styles: Record<string, unknown>[] = [];
  try {
    for (const k of indices) {
      sampling = { mutable, value: track.samples[k] };
      const style = meta.updater();
      if (!style || typeof style !== "object") return null;
      styles.push(style);
    }
  } catch {
    return null;
  } finally {
    sampling = null;
  }
  return styles;
}

/** The plan for one reader; null when it animates something the compositor can't. */
function planFor(
  mutable: object,
  reader: { mapper: Mapper; meta: StyleMeta },
  track: Track,
  timing: Timing,
): MapperPlan | null {
  const elements = elementsOf(reader.meta.viewDescriptors);
  const styles = elements && sampleUpdater(mutable, reader.meta, track, timing.indices);
  const keys = styles && varyingKeys(styles);
  if (!keys || keys.some((k) => !COMPOSITOR_KEYS.has(k))) return null;
  const keyframes = keys.length > 0 && elements!.length > 0 ? keyframesOf(styles!, keys) : null;
  return { mapper: reader.mapper, elements: elements!, keyframes };
}

/** How a shared value's animation started: what a later take-over simulates from. */
interface Origin {
  animation: AnimationObject;
  start: unknown;
  previous: unknown;
  t0: number;
  step: (timestamp: number) => void;
}

/**
 * The shared values whose animation Reanimated's loop runs and the pass may still take over
 * once their style mappers start (the mount idiom: `useEffect(() => { sv.value = withRepeat(…) })`
 * runs before the style's mapper is registered).
 */
const candidates = new WeakMap<object, Origin>();

/**
 * `sv.value = <animation>` (valueSetter, after the animation's `onStart`): run it on the
 * compositor when every reader of the shared value is a `transform` / `opacity` style.
 *
 * @param mutable The shared value.
 * @param animation The started animation (Reanimated's object; it is left idle).
 * @param previous The animation it replaced.
 * @param t0 The start timestamp.
 * @param step Reanimated's frame step for `animation`, resumed on hand-back.
 * @returns Whether the compositor took it (else Reanimated's loop runs as usual).
 */
export function offloadValue(
  mutable: SharedValue,
  animation: AnimationObject,
  previous: unknown,
  t0: number,
  step: (timestamp: number) => void,
): boolean {
  if (!enabled()) return false;
  const origin = { animation, start: mutable._value, previous, t0, step };
  if (takeOver(mutable, origin, false)) return true;
  candidates.set(mutable, origin);
  return false;
}

/**
 * Put `origin`'s animation on the compositor: simulate it, sample every reader, play.
 * `running` is an animation Reanimated's loop already steps: its loop is paused (the
 * animation's `cancelled` flag, which its frame step checks) until the hand-back.
 */
function takeOver(mutable: SharedValue, origin: Origin, running: boolean): boolean {
  const readers = styleReaders(mutable);
  const { animation, t0 } = origin;
  const track = readers && simulate(animation, origin.start, origin.previous, t0);
  const timing = track && timingOf([track]);
  const plans = timing && planAll(mutable, readers!, track!, timing);
  if (!plans) return false;
  const anims = plans.flatMap((p) => p.keyframes ? play(p.elements, p.keyframes, timing!, t0) : []);
  if (anims.length === 0) return false;
  const o: ValueOffload = {
    mutable,
    origin,
    driven: { real: animation, track: track!, ran: running ? framesUntil(t0, now()) : 0 },
    t0,
    mappers: plans.map((p) => p.mapper),
    anims,
    loop: running ? pauseLoop(animation) : undefined,
  };
  hold(o, timing!.infinite);
  return true;
}

/** Register `o` as the shared value's compositor animation. */
function hold(o: ValueOffload, infinite: boolean): void {
  candidates.delete(o.mutable);
  activeValues.set(o.mutable, o);
  for (const mapper of o.mappers) heldBy.set(mapper, o);
  if (!infinite) o.anims[0].onfinish = () => finishValue(o);
}

/** Every reader's plan (the due ones run first); null when one can't go on the compositor. */
function planAll(
  mutable: SharedValue,
  readers: { mapper: Mapper; meta: StyleMeta }[],
  track: Track,
  timing: Timing,
): MapperPlan[] | null {
  flushDue(readers);
  const plans: MapperPlan[] = [];
  for (const reader of readers) {
    const plan = planFor(mutable, reader, track, timing);
    if (!plan) return null;
    plans.push(plan);
  }
  return plans;
}

/**
 * Pause Reanimated's running loop for `animation` (its frame step checks `cancelled`). Its next
 * step, already requested, runs before this frame callback and stops on the flag.
 */
function pauseLoop(animation: AnimationObject): { pending: boolean } {
  const loop = { pending: true };
  animation.cancelled = true;
  requestAnimationFrame(() => (loop.pending = false));
  return loop;
}

/** How many grid frames from `t0` lie at or before `t`. */
function framesUntil(t0: number, t: number): number {
  return Math.max(0, Math.floor((t - t0) / FRAME) + 1);
}

/** A shared value with a candidate animation got a new style mapper: try again. */
function adopt(mutable: SharedValue): void {
  const origin = candidates.get(mutable);
  if (!origin || !enabled()) return;
  const real = origin.animation;
  if (mutable._animation !== real || real.finished || real.cancelled) {
    candidates.delete(mutable);
    return;
  }
  takeOver(mutable, origin, true);
}

/** Stop holding `o`'s shared value and mappers. */
function releaseValue(o: ValueOffload): boolean {
  if (activeValues.get(o.mutable) !== o) return false;
  activeValues.delete(o.mutable);
  for (const mapper of o.mappers) heldBy.delete(mapper);
  return true;
}

/** Write the real animation's value back to the shared value and stop the compositor. */
function settleValue(o: ValueOffload, done: boolean): void {
  const real = o.driven.real;
  if (done) real.finished = true;
  o.mutable._value = real.current;
  stop(o.anims);
  if (done) real.callback?.(true);
}

/** The compositor finished: the shared value lands on its final value. */
function finishValue(o: ValueOffload): void {
  if (!releaseValue(o)) return;
  settleValue(o, advance(o.driven, o.t0, Infinity));
}

/** Give the animation back to Reanimated's loop at the current frame. */
function handBack(o: ValueOffload): void {
  if (!releaseValue(o)) return;
  const done = advance(o.driven, o.t0, now());
  settleValue(o, done);
  if (done) return;
  if (o.loop) o.driven.real.cancelled = false;
  // A paused loop whose frame step is still pending resumes by itself.
  if (!o.loop?.pending) requestAnimationFrame(o.origin.step);
  candidates.set(o.mutable, o.origin);
}

/**
 * `sv.value = …` while the compositor runs `sv`'s animation (valueSetter, first): stop it
 * where it is, so the new value or animation starts from there.
 */
export function interruptValue(mutable: object): void {
  candidates.delete(mutable);
  const o = activeValues.get(mutable);
  if (!o || !releaseValue(o)) return;
  settleValue(o, advance(o.driven, o.t0, now()));
}

// ---------------------------------------------------------------------------------------------
// Animations returned from a style updater.

/** What `styleUpdater` passes when its updater returned animations. */
export interface StyleOffloadInput {
  viewDescriptors: StyleMeta["viewDescriptors"];
  state: StyleState;
  animations: Record<string, unknown>;
  nonAnimated: Record<string, unknown>;
  hasNonAnimated: boolean;
  isAnimatedProps: boolean;
  t0: number;
  animationsActive: { value: unknown };
  updateProps: UpdateProps;
}

/** Every animation object inside a style value. */
function leavesOf(value: unknown, out: AnimationObject[] = []): AnimationObject[] {
  if (isAnimation(value)) out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => leavesOf(v, out));
  else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((v) => leavesOf(v, out));
  }
  return out;
}

/** A style value with each animation replaced by `pick(animation)`. */
function rebuild(value: unknown, pick: (a: AnimationObject) => unknown): unknown {
  if (isAnimation(value)) return pick(value);
  if (Array.isArray(value)) return value.map((v) => rebuild(v, pick));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rebuild(v, pick);
    return out;
  }
  return value;
}

/** Simulate every animation of a style; null when one can't be. */
function driveLeaves(
  keys: string[],
  input: StyleOffloadInput,
): Map<AnimationObject, Driven> | null {
  const leaves = new Map<AnimationObject, Driven>();
  for (const real of keys.flatMap((k) => leavesOf(input.animations[k]))) {
    const start = starts.get(real);
    const track = start && simulate(real, start.value, start.previous, input.t0);
    if (!track) return null;
    leaves.set(real, { real, track, ran: 0 });
  }
  return leaves;
}

/**
 * `styleUpdater` with animated values (after `prepareAnimation` started them): run them on the
 * compositor when they animate only `transform` / `opacity`.
 *
 * @returns Whether the compositor took them (else Reanimated's frame loop runs as usual).
 */
export function offloadStyle(input: StyleOffloadInput): boolean {
  const { state, animations } = input;
  if (!enabled() || input.isAnimatedProps || !input.animationsActive.value) return false;
  if (state.isAnimationRunning) return false;
  const keys = Object.keys(animations);
  if (keys.length === 0 || keys.some((k) => !COMPOSITOR_KEYS.has(k))) return false;
  const elements = elementsOf(input.viewDescriptors);
  const leaves = elements && elements.length > 0 && driveLeaves(keys, input);
  const timing = leaves && timingOf([...leaves.values()].map((d) => d.track));
  if (!timing) return false;
  const styles = timing.indices.map((k) => {
    const style: Record<string, unknown> = {};
    for (const key of keys) {
      style[key] = rebuild(animations[key], (a) => sampleAt(leaves!.get(a)!.track, k));
    }
    return style;
  });
  if (input.hasNonAnimated) input.updateProps(input.viewDescriptors, input.nonAnimated, false);
  const o: StyleOffload = {
    state,
    viewDescriptors: input.viewDescriptors,
    leaves: leaves!,
    keys,
    t0: input.t0,
    anims: play(elements!, keyframesOf(styles, keys), timing, input.t0),
    isAnimatedProps: input.isAnimatedProps,
    updateProps: input.updateProps,
  };
  state.animations = animations;
  state.isAnimationRunning = false;
  activeStyles.set(state, o);
  if (!timing.infinite) o.anims[0].onfinish = () => finishStyle(o);
  return true;
}

/** Fast-forward every animation of `o` to `until`; true when all of them are done. */
function advanceLeaves(o: StyleOffload, until: number): boolean {
  let all = true;
  for (const d of o.leaves.values()) {
    if (d.real.finished) continue;
    if (advance(d, o.t0, until)) {
      d.real.finished = true;
      d.real.callback?.(true);
    } else all = false;
  }
  return all;
}

/** The compositor finished: the final values go inline and into the style's last state. */
function finishStyle(o: StyleOffload): void {
  if (activeStyles.get(o.state) !== o) return;
  activeStyles.delete(o.state);
  advanceLeaves(o, Infinity);
  const updates: Record<string, unknown> = {};
  for (const key of o.keys) {
    updates[key] = rebuild(o.state.animations[key], (a) => a.current);
    o.state.last[key] = updates[key];
    delete o.state.animations[key];
  }
  o.updateProps(o.viewDescriptors, updates, o.isAnimatedProps);
  stop(o.anims);
}

/**
 * The style updater runs again while the compositor runs its animations: stop them where they
 * are (the real animations fast-forwarded to now), so what follows starts from there.
 */
export function interruptStyle(state: object): void {
  const o = activeStyles.get(state);
  if (!o) return;
  if (advanceLeaves(o, now())) {
    finishStyle(o);
    return;
  }
  activeStyles.delete(state);
  stop(o.anims);
}
