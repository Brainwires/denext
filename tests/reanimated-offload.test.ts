// The compositor pass for Reanimated in React Native mode: the build's splices into
// Reanimated 4's web modules (src/build/reanimated-offload.ts, checked against the anchors
// react-native-reanimated 4.7.0 ships, as they read after the worklets pass), and the runtime
// (src/react-native/animation/offload.ts) against small stand-ins for Reanimated's animation
// factories, shared values, mappers and DOM elements. The real library in a browser, with a
// main-thread block the compositor animation runs through, is tests/e2e/reanimated.e2e.test.ts.

import { assert, assertAlmostEquals, assertEquals, assertStringIncludes } from "@std/assert";
import { patchForOffload, runtimeSource } from "../src/build/reanimated-offload.ts";
import {
  type AnimationObject,
  beforeMapperRun,
  interruptStyle,
  interruptValue,
  type Mapper,
  mapperStarted,
  mapperStopped,
  noteAnimationStart,
  offloadStyle,
  offloadValue,
  readValue,
  setStyleConverter,
  simulate,
  styleMapper,
  type StyleState,
  tagAnimation,
  trackMutable,
  valueAt,
} from "../src/react-native/animation/offload.ts";

const RA = "/app/node_modules/react-native-reanimated/lib/module/";

// ---------------------------------------------------------------------------------------------
// The splices.

/** Lines of `code` before its appended part (the splices never add a line break). */
const lineCount = (code: string) => code.split("\n").length;

Deno.test("offload patch: animation factories are re-exported through tagAnimation", () => {
  const timing = `'use strict';

import { __denextWorklet } from "denext-worklets-runtime";import { Easing } from "../Easing.js";
export const withTiming = __denextWorklet(function (toValue, userConfig, callback) {
  return 1;
}, 0, 1);
`;
  const out = patchForOffload(RA + "animation/timing.js", timing)!;
  assert(
    out.startsWith(`'use strict';import * as __denextOffload from "denext-reanimated-offload";`),
  );
  assertStringIncludes(out, "\nconst withTiming = __denextWorklet(");
  assertStringIncludes(
    out,
    `const __denextTagged_withTiming = __denextOffload.tagAnimation(withTiming, "timing");\n` +
      `export { __denextTagged_withTiming as withTiming };`,
  );
  const seq = `'use strict';
__denextWorklet(withSequence, 0, 2);export function withSequence(_a, ..._animations) {
}
`;
  const s = patchForOffload(RA + "animation/sequence.js", seq)!;
  assertStringIncludes(s, "__denextWorklet(withSequence, 0, 2);function withSequence(");
  assertStringIncludes(s, `tagAnimation(withSequence, "sequence")`);
});

Deno.test("offload patch: shared values, valueSetter, mappers, styles, converter", () => {
  const cases: [string, string, string[]][] = [
    [
      "mutables.js",
      `export function makeMutable(initial) {
  let value = initial;
  const listeners = new Map();
  const mutable = {
    get value() {
      checkInvalidReadDuringRender();
      return value;
    },
  };
  Object.defineProperties(mutable, {
  });
}`,
      [
        "return __denextOffload.readValue(mutable, value);",
        "__denextOffload.trackMutable(mutable, listeners);Object.defineProperties(mutable, {",
      ],
    ],
    [
      "valueSetter.js",
      `export function valueSetter(mutable, value, forceUpdate = false) {
  const previousAnimation = mutable._animation;
    mutable._animation = animation;
    step(currentTimestamp);
}`,
      [
        "__denextOffload.interruptValue(mutable);const previousAnimation",
        "if (!__denextOffload.offloadValue(mutable, animation, previousAnimation, " +
        "currentTimestamp, step)) step(currentTimestamp);",
      ],
    ],
    [
      "mappers.js",
      `      mappers.set(mapper.id, mapper);
        mappers.delete(mapper.id);
            mapper.dirty = false;
            mapper.worklet();`,
      [
        "mappers.set(mapper.id, mapper);__denextOffload.mapperStarted(mapper);",
        "mappers.delete(mapper.id);__denextOffload.mapperStopped(mapper);",
        "__denextOffload.beforeMapperRun(mapper);mapper.worklet();",
      ],
    ],
    [
      "hook/useAnimatedStyle.js",
      `    const mapperId = startMapper(fun, inputs);`,
      [
        "__denextOffload.styleMapper(fun, shareableViewDescriptors, updaterFn, isAnimatedProps, " +
        "IS_JEST);const mapperId",
      ],
    ],
    [
      "hook/useAnimatedStyleCommon.js",
      `    animation.callStart = timestamp => {
      animation.onStart(animation, value, timestamp, lastAnimation);
    };
  const animations = state.animations ?? {};
  const newValues = updater() ?? {};
  if (hasAnimations) {
    const frame = timestamp => {`,
      [
        "__denextOffload.noteAnimationStart(animation, value, lastAnimation);animation.callStart",
        "__denextOffload.interruptStyle(state);const animations = state.animations ?? {};",
        "if (hasAnimations && __denextOffload.offloadStyle({",
        "{ state.last = newValues; return; } if (hasAnimations) {\n    const frame = ",
      ],
    ],
    [
      "ReanimatedModule/js-reanimated/index.js",
      `'use strict';

import { createReactDOMStyle, createTextShadowValue, createTransformValue } from './webUtils';
`,
      ["__denextOffload.setStyleConverter(createReactDOMStyle, createTransformValue);"],
    ],
  ];
  for (const [file, code, expected] of cases) {
    const out = patchForOffload(RA + file, code);
    assert(out, `${file} patched`);
    for (const e of expected) assertStringIncludes(out, e, file);
    if (!file.endsWith("index.js")) assertEquals(lineCount(out), lineCount(code), file);
  }
});

Deno.test("offload patch: a file whose anchors moved is left alone; others untouched", () => {
  // valueSetter without the frame-loop anchor (another Reanimated version): unpatched.
  assertEquals(
    patchForOffload(
      RA + "valueSetter.js",
      "const previousAnimation = mutable._animation;\nrunLoop(animation);",
    ),
    null,
  );
  assertEquals(patchForOffload(RA + "Colors.js", "export const x = 1;"), null);
  assertEquals(patchForOffload("/app/src/timing.js", "export const withTiming = 1;"), null);
});

Deno.test("offload patch: react-native-web's UIManager routes configureNextLayoutAnimation", () => {
  const esm = `import getBoundingClientRect from '../../modules/getBoundingClientRect';
var UIManager = {
  configureNextLayoutAnimation(config, onAnimationDidEnd) {
    onAnimationDidEnd();
  },
};`;
  const out = patchForOffload(
    "/a/node_modules/react-native-web/dist/exports/UIManager/index.js",
    esm,
  )!;
  assert(out.startsWith(`import * as __denextLayoutAnimation from "denext-layout-animation";`));
  assertStringIncludes(
    out,
    "return __denextLayoutAnimation.configureNext(config, onAnimationDidEnd);",
  );
  const cjs =
    `"use strict";\nvar x = {\n  configureNextLayoutAnimation(config, onAnimationDidEnd) {\n  }\n};`;
  const c = patchForOffload(
    "/a/node_modules/react-native-web/dist/cjs/exports/UIManager/index.js",
    cjs,
  )!;
  assert(
    c.startsWith(`"use strict";var __denextLayoutAnimation = require("denext-layout-animation");`),
  );
});

Deno.test("offload runtime sources are served for both specifiers", async () => {
  assertStringIncludes(
    await runtimeSource("denext-reanimated-offload"),
    "export function offloadValue",
  );
  assertStringIncludes(
    await runtimeSource("denext-layout-animation"),
    "export function configureNext",
  );
});

// ---------------------------------------------------------------------------------------------
// Stand-ins: Reanimated's factories (the same state fields and stepping), shared values,
// mappers and DOM elements.

const FRAME = 1000 / 60;

type Cb = ((finished: boolean) => void) | undefined;

const withTiming = tagAnimation(
  (toValue: number, config?: { duration?: number }, callback?: Cb): AnimationObject => {
    const duration = config?.duration ?? 300;
    return {
      toValue,
      current: toValue,
      callback,
      startTime: 0,
      startValue: 0,
      onStart(a, value, now) {
        a.startTime = now;
        a.startValue = value;
        a.current = value;
      },
      onFrame(a, now) {
        const runtime = now - (a.startTime as number);
        if (runtime >= duration) {
          a.current = a.toValue;
          return true;
        }
        const s = a.startValue as number;
        a.current = s + ((a.toValue as number) - s) * (runtime / duration);
        return false;
      },
    };
  },
  "timing",
);

const withRepeat = tagAnimation(
  (next: AnimationObject, reps = 2, reverse = false, callback?: Cb): AnimationObject => ({
    current: next.current,
    reps: 0,
    startValue: 0,
    callback,
    isHigherOrder: true,
    onStart(a, value, now, prev) {
      a.startValue = value;
      a.reps = 0;
      next.onStart(next, value, now, prev);
    },
    onFrame(a, now) {
      const done = next.onFrame(next, now);
      a.current = next.current;
      if (!done) return false;
      a.reps = (a.reps as number) + 1;
      if (reps > 0 && (a.reps as number) >= reps) return true;
      const start = reverse ? next.current : a.startValue;
      if (reverse) {
        next.toValue = a.startValue;
        a.startValue = start;
      }
      next.onStart(next, start, now, undefined);
      return false;
    },
  }),
  "repeat",
);

const withDelay = tagAnimation((ms: number, next: AnimationObject): AnimationObject => ({
  current: next.current,
  started: false,
  startTime: 0,
  isHigherOrder: true,
  onStart(a, value, now) {
    a.startTime = now;
    a.started = false;
    a.current = value;
  },
  onFrame(a, now) {
    if (now - (a.startTime as number) < ms) return false;
    if (!a.started) {
      next.onStart(next, a.current, now, undefined);
      a.started = true;
    }
    const done = next.onFrame(next, now);
    a.current = next.current;
    return done;
  },
}), "delay");

/** A fake Web Animation: records its keyframes and timing; `finish()` fires `onfinish`. */
class FakeAnimation {
  startTime: number | null = null;
  onfinish: (() => void) | null = null;
  committed = false;
  cancelled = false;
  constructor(readonly keyframes: Keyframe[], readonly options: KeyframeAnimationOptions) {}
  commitStyles() {
    this.committed = true;
  }
  cancel() {
    this.cancelled = true;
  }
  finish() {
    this.onfinish?.();
  }
}

/** A fake DOM element. */
class FakeElement {
  style: Record<string, string> = {};
  anims: FakeAnimation[] = [];
  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const a = new FakeAnimation(keyframes, options);
    this.anims.push(a);
    return a;
  }
}

/** A shared value the way the patched `makeMutable` wires it. */
function makeMutable(initial: unknown) {
  let value = initial;
  const listeners = new Map<unknown, (v: unknown) => void>();
  const m = {
    get value(): unknown {
      return readValue(m, value);
    },
    get _value() {
      return value;
    },
    set _value(v: unknown) {
      value = v;
      listeners.forEach((l) => l(v));
    },
    _animation: null as AnimationObject | null,
    listeners,
  };
  trackMutable(m, listeners);
  return m;
}

let mapperId = 1;

/** A `useAnimatedStyle` mapper over `inputs`, drawing `updater` on one fake element. */
function styleOf(inputs: ReturnType<typeof makeMutable>[], updater: () => Record<string, unknown>) {
  const el = new FakeElement();
  const views = { value: [{ tag: el }] };
  const runs: Record<string, unknown>[] = [];
  const worklet = () => runs.push(updater());
  styleMapper(worklet, views, updater, false, false);
  const mapper: Mapper = { id: mapperId++, dirty: false, worklet, inputs };
  mapperStarted(mapper);
  for (const sv of inputs) sv.listeners.set(mapper.id, () => (mapper.dirty = true));
  return { el, views, mapper, runs };
}

/** Run `fn` with the DOM globals the runtime checks for, a fixed clock and a rAF queue. */
async function withDom(fn: (clock: { t: number; raf: ((t: number) => void)[] }) => unknown) {
  const g = globalThis as Record<string, unknown>;
  const saved = { Element: g.Element, raf: g.requestAnimationFrame };
  const clock = { t: 1000, raf: [] as ((t: number) => void)[] };
  const now = performance.now;
  g.Element = FakeElement;
  g.requestAnimationFrame = (cb: (t: number) => void) => clock.raf.push(cb);
  Object.defineProperty(performance, "now", { value: () => clock.t, configurable: true });
  setStyleConverter(
    (s) => ({ ...s }),
    (t) =>
      (t as Record<string, number>[]).map((o) => {
        const [k, v] = Object.entries(o)[0];
        return `${k}(${v}px)`;
      }).join(" "),
  );
  try {
    await fn(clock);
  } finally {
    g.Element = saved.Element;
    g.requestAnimationFrame = saved.raf;
    Object.defineProperty(performance, "now", { value: now, configurable: true });
  }
}

/** `sv.value = animation` the way the patched valueSetter runs it. */
function assign(
  sv: ReturnType<typeof makeMutable>,
  animation: AnimationObject,
  t0: number,
  steps: number[] = [],
) {
  interruptValue(sv);
  const previous = sv._animation;
  animation.onStart(animation, sv.value, t0, previous);
  const step = (t: number) => {
    steps.push(t);
    const done = animation.onFrame(animation, t);
    sv._value = animation.current;
    if (done) animation.callback?.(true);
  };
  sv._animation = animation;
  return offloadValue(sv, animation, previous, t0, step) || (step(t0), false);
}

// ---------------------------------------------------------------------------------------------
// The runtime.

Deno.test("offload: sv = withTiming → one WAAPI animation of transform + opacity", async () => {
  await withDom((clock) => {
    const x = makeMutable(0);
    const { el, runs } = styleOf([x], () => ({
      transform: [{ translateX: x.value as number }],
      opacity: 1 - (x.value as number) / 200,
      width: 10, // constant: fine
    }));
    let finished: boolean | undefined;
    const anim = withTiming(100, { duration: 300 }, (f) => (finished = f));
    assert(assign(x, anim, 1000));
    assertEquals(el.anims.length, 1);
    const a = el.anims[0];
    assertEquals(a.options.duration, 18 * FRAME);
    assertEquals(a.options.iterations, 1);
    assertEquals(a.startTime, 1000);
    assertEquals(a.keyframes[0], { offset: 0, transform: "translateX(0px)", opacity: "1" });
    assertEquals(a.keyframes.at(-1), { offset: 1, transform: "translateX(100px)", opacity: "0.5" });
    // Nobody's inline style was touched and the updater only ran for the sampling.
    assertEquals(runs.length, 0);
    // A read while the compositor runs is the interpolated value.
    clock.t = 1150;
    assertAlmostEquals(x.value as number, 50, 1e-9);
    a.finish();
    assertEquals(x._value, 100);
    assertEquals(finished, true);
    assert(a.committed && a.cancelled);
    assertEquals(x.value, 100);
  });
});

Deno.test("offload: a reader already due runs first (mount), then the animation is taken", async () => {
  await withDom(() => {
    const x = makeMutable(0);
    const s = styleOf([x], () => ({ opacity: x.value }));
    s.mapper.dirty = true; // just started: its first run is queued
    assert(assign(x, withTiming(1), 1000));
    assertEquals(s.mapper.dirty, false);
    assertEquals(s.runs, [{ opacity: 0 }]); // the start value, inline, as the queued run would
    assertEquals(s.el.anims.length, 1);
  });
});

Deno.test("offload: another reader kind, a layout key or a nested callback stay on the loop", async () => {
  await withDom(() => {
    // A reader that is not a style mapper (useDerivedValue / useAnimatedReaction).
    const a = makeMutable(0);
    a.listeners.set("reaction", () => {});
    assertEquals(assign(a, withTiming(1), 1000), false);

    // A style that animates width.
    const b = makeMutable(0);
    const s = styleOf([b], () => ({ width: b.value }));
    assertEquals(assign(b, withTiming(1), 1000), false);
    assertEquals(s.el.anims.length, 0);

    // A nested animation with its own callback.
    const c = makeMutable(0);
    styleOf([c], () => ({ opacity: c.value }));
    assertEquals(assign(c, withRepeat(withTiming(1, {}, () => {}), 2), 1000), false);

    // An animation factory the pass does not know (withDecay, a custom defineAnimation).
    const d = makeMutable(0);
    styleOf([d], () => ({ opacity: d.value }));
    const custom = { ...withTiming(1) };
    assertEquals(assign(d, custom, 1000), false);
  });
});

Deno.test("offload: sv reassigned mid-flight stops at the current value, then re-offloads", async () => {
  await withDom((clock) => {
    const x = makeMutable(0);
    const { el } = styleOf([x], () => ({ opacity: x.value }));
    let first: boolean | undefined;
    assert(assign(x, withTiming(1, { duration: 300 }, (f) => (first = f)), 1000));
    clock.t = 1000 + 9 * FRAME;
    // The second assignment: interrupted where the real animation (fast-forwarded) is.
    const second = withTiming(0, { duration: 300 });
    assert(assign(x, second, clock.t));
    assert(el.anims[0].committed && el.anims[0].cancelled);
    assertEquals(first, undefined); // Reanimated's valueSetter reports the cancel itself
    assertAlmostEquals(x._value as number, 0.5, 1e-9);
    assertEquals(el.anims.length, 2);
    assertEquals(el.anims[1].keyframes[0].opacity, "0.5");
  });
});

Deno.test("offload: another input of a held style changes → handed back to the loop", async () => {
  await withDom((clock) => {
    const x = makeMutable(0);
    const k = makeMutable(1);
    const { el, mapper } = styleOf(
      [x, k],
      () => ({ opacity: (x.value as number) * (k.value as number) }),
    );
    const steps: number[] = [];
    assert(assign(x, withTiming(1, { duration: 300 }), 1000, steps));
    clock.t = 1000 + 6 * FRAME;
    beforeMapperRun(mapper); // the mapper is about to run because `k` changed
    assert(el.anims[0].cancelled);
    assertAlmostEquals(x._value as number, 6 / 18, 1e-9);
    assertEquals(clock.raf.length, 1); // Reanimated's own frame step resumes
    clock.raf[0](1000 + 7 * FRAME);
    assertAlmostEquals(x._value as number, 7 / 18, 1e-9);
    // A second hand-back is a no-op.
    beforeMapperRun(mapper);
    assertEquals(clock.raf.length, 1);
  });
});

Deno.test("offload: a style mapper stopping or starting on the value hands it back", async () => {
  await withDom(() => {
    const x = makeMutable(0);
    const s = styleOf([x], () => ({ opacity: x.value }));
    assert(assign(x, withTiming(1), 1000));
    mapperStopped(s.mapper);
    assert(s.el.anims[0].cancelled);

    const y = makeMutable(0);
    const t = styleOf([y], () => ({ opacity: y.value }));
    assert(assign(y, withTiming(1), 1000));
    styleOf([y], () => ({ opacity: y.value })); // a new reader
    assert(t.el.anims[0].cancelled);
  });
});

Deno.test("offload: assigned before its style mapper registers (mount) → taken over after", async () => {
  await withDom(async (clock) => {
    const x = makeMutable(0);
    // `useEffect(() => { x.value = withRepeat(…) })`: the style's mapper is not registered yet.
    const anim = withRepeat(withTiming(360, { duration: 1000 }), -1);
    assertEquals(assign(x, anim, 1000), false); // Reanimated's loop starts
    clock.t = 1100;
    const s = styleOf([x], () => ({ transform: [{ rotate: `${x.value}deg` }] }));
    await Promise.resolve(); // the take-over waits for the mapper's registration
    assertEquals(s.el.anims.length, 1);
    const a = s.el.anims[0];
    assertEquals([a.startTime, a.options.iterations], [1000, Infinity]);
    assertEquals(anim.cancelled, true); // Reanimated's loop is paused
    assertEquals(clock.raf.length, 1); // … and noted once its pending step has run
    // The mapper stops (unmount): the loop resumes. Its step was still pending: no new one.
    mapperStopped(s.mapper);
    assertEquals(anim.cancelled, false);
    assertEquals(clock.raf.length, 1);
  });
});

Deno.test("offload: withRepeat(-1, reverse) loops forever; withDelay over it delays", async () => {
  await withDom((clock) => {
    const x = makeMutable(0);
    const { el } = styleOf([x], () => ({ opacity: x.value }));
    assert(assign(x, withRepeat(withTiming(1, { duration: 300 }), -1, true), 1000));
    const a = el.anims[0];
    assertEquals(a.options.iterations, Infinity);
    assertEquals(a.options.duration, 36 * FRAME); // there and back
    assertEquals(a.keyframes[0].opacity, "0");
    assertEquals(a.keyframes.at(-1)!.opacity, "0");
    assertEquals(a.onfinish, null);
    // Reads keep looping: one and a half periods in, the value is at the far end.
    clock.t = 1000 + 54 * FRAME;
    assertAlmostEquals(x.value as number, 1, 1e-9);

    const y = makeMutable(0);
    const s = styleOf([y], () => ({ opacity: y.value }));
    assert(assign(y, withDelay(500, withRepeat(withTiming(1, { duration: 300 }), -1)), 1000));
    const b = s.el.anims[0];
    assertEquals(b.options.iterations, Infinity);
    assertEquals(b.options.delay, 30 * FRAME);
    assertEquals(b.options.duration, 18 * FRAME);
  });
});

Deno.test("offload: a forever-repeat inside a sequence-like tree is not looped", async () => {
  await withDom(() => {
    const x = makeMutable(0);
    styleOf([x], () => ({ opacity: x.value }));
    // withRepeat(withRepeat(…, -1), 2): the inner loop is not the whole tree.
    assertEquals(assign(x, withRepeat(withRepeat(withTiming(1), -1), 2), 1000), false);
  });
});

Deno.test("offload: simulate / valueAt follow the frame grid", () => {
  const track = simulate(withTiming(10, { duration: 100 }), 0, undefined, 0)!;
  assertEquals(track.samples.length, 7);
  assertEquals(track.samples[0], 0);
  assertEquals(track.samples.at(-1), 10);
  assertAlmostEquals(valueAt(track, 1.5) as number, 2.5, 1e-9);
  assertEquals(valueAt(track, 99), 10);
  assertEquals(valueAt(track, -3), 0);
  assertEquals(valueAt({ samples: ["0deg", "90deg"], loopFrom: -1, loopTo: -1 }, 0.5), "0deg");
});

Deno.test("offload: an animation returned from a style runs on the compositor", async () => {
  await withDom((clock) => {
    const el = new FakeElement();
    const views = { value: [{ tag: el }] };
    const state: StyleState = { animations: {}, last: { opacity: 1 }, isAnimationRunning: false };
    const updates: Record<string, unknown>[] = [];
    const updateProps = (_v: unknown, u: Record<string, unknown>) => void updates.push(u);
    let done: boolean | undefined;
    const anim = withTiming(0.2, { duration: 300 }, (f) => (done = f));
    noteAnimationStart(anim, 1, undefined);
    anim.onStart(anim, 1, 1000, undefined);
    const input = {
      viewDescriptors: views,
      state,
      animations: { opacity: anim } as Record<string, unknown>,
      nonAnimated: { height: 10 },
      hasNonAnimated: true,
      isAnimatedProps: false,
      t0: 1000,
      animationsActive: { value: true },
      updateProps,
    };
    assert(offloadStyle(input));
    assertEquals(updates, [{ height: 10 }]); // the static keys go inline at once
    assertEquals(el.anims[0].keyframes[0].opacity, "1");
    assertEquals(el.anims[0].keyframes.at(-1)!.opacity, "0.2");
    el.anims[0].finish();
    assertEquals(done, true);
    assertEquals(state.last.opacity, 0.2);
    assertEquals(state.animations, {});
    assertEquals(updates.at(-1), { opacity: 0.2 });

    // Interrupted by the updater running again: the real animation stands where it was.
    const second = withTiming(1, { duration: 300 });
    noteAnimationStart(second, 0.2, undefined);
    second.onStart(second, 0.2, 2000, undefined);
    state.animations = { opacity: second };
    assert(offloadStyle({ ...input, animations: state.animations, t0: 2000 }));
    clock.t = 2000 + 9 * FRAME;
    interruptStyle(state);
    assert(el.anims[1].committed && el.anims[1].cancelled);
    assertAlmostEquals(second.current as number, 0.6, 1e-9);

    // A width animation, or one already on the loop, is not taken.
    const w = withTiming(5);
    noteAnimationStart(w, 0, undefined);
    assertEquals(offloadStyle({ ...input, animations: { width: w } }), false);
    assertEquals(
      offloadStyle({ ...input, state: { ...state, isAnimationRunning: true } }),
      false,
    );
  });
});

Deno.test("offload: off without Element.animate, a converter or with the global opt-out", async () => {
  const x = makeMutable(0);
  styleOf([x], () => ({ opacity: x.value }));
  assertEquals(assign(x, withTiming(1), 1000), false); // no DOM here
  await withDom(() => {
    (globalThis as Record<string, unknown>).__DENEXT_REANIMATED_WAAPI = false;
    try {
      const y = makeMutable(0);
      styleOf([y], () => ({ opacity: y.value }));
      assertEquals(assign(y, withTiming(1), 1000), false);
    } finally {
      delete (globalThis as Record<string, unknown>).__DENEXT_REANIMATED_WAAPI;
    }
  });
});
