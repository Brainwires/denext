// React Native mode: Reanimated animations and `LayoutAnimation` off the main thread.
//
// Reanimated 4's web build animates on the page's main thread (a `requestAnimationFrame` loop
// that re-runs style updaters and writes inline styles). This pass patches that build so the
// declarative `transform` / `opacity` animations run as Web Animations on the compositor
// instead; the logic lives in the runtime module (src/react-native/animation/offload.ts, read
// here as source and served to the bundle as `denext-reanimated-offload`). The patches are
// small, anchored splices into Reanimated 4's `lib/module` files:
//
//   animation/{timing,spring/spring,repeat,sequence,delay}.js
//       the factory is re-exported wrapped in `tagAnimation`, which records its arguments
//   mutables.js           `.value` reads go through `readValue`; the listener map is tracked
//   valueSetter.js        `interruptValue` first; `offloadValue` before the frame loop starts
//   mappers.js            `mapperStarted` / `mapperStopped` / `beforeMapperRun`
//   hook/useAnimatedStyle.js         `styleMapper` records what a style mapper animates
//   hook/useAnimatedStyleCommon.js   `noteAnimationStart`; `interruptStyle`; `offloadStyle`
//   ReanimatedModule/js-reanimated/index.js   `setStyleConverter` (RNW's style compiler)
//
// Every file's anchors must all match or the file is left as it is: an unpatched file only
// makes the runtime decline (it needs the full set to take an animation), never breaks
// Reanimated. The splices never add a line break before existing code, so line numbers hold.
//
// `LayoutAnimation.configureNext` (react-native-web's `UIManager.configureNextLayoutAnimation`,
// a no-op there) is routed to src/react-native/animation/layout-animation.ts, served as
// `denext-layout-animation`: FLIP over the next DOM commit on the compositor.

import { fromFileUrl } from "@std/path";

/** The runtime module the patched Reanimated files import. */
const OFFLOAD_RUNTIME = "denext-reanimated-offload";

/** The `LayoutAnimation` runtime module react-native-web's UIManager imports. */
const LAYOUT_ANIMATION_RUNTIME = "denext-layout-animation";

/** The namespace binding the patched modules call the runtime through. */
const NS = "__denextOffload";

/** One anchored splice: every match of `find` is replaced (`find` must match at least once). */
interface Splice {
  find: RegExp;
  replace: string;
}

/** What to do to one file. */
interface FilePatch {
  splices: Splice[];
  /** Appended after the module's code. */
  append?: string;
}

/** A factory re-exported through `tagAnimation`. */
function tagged(name: string, kind: string, declaration: "const" | "function"): FilePatch {
  return {
    splices: [{
      find: new RegExp(`export ${declaration} ${name}\\b`),
      replace: `${declaration} ${name}`,
    }],
    append: `const __denextTagged_${name} = ${NS}.tagAnimation(${name}, "${kind}");\n` +
      `export { __denextTagged_${name} as ${name} };\n`,
  };
}

/** Reanimated 4's web modules (under `react-native-reanimated/lib/module/`) and their patches. */
const REANIMATED_PATCHES: Readonly<Record<string, FilePatch>> = {
  "animation/timing.js": tagged("withTiming", "timing", "const"),
  "animation/spring/spring.js": tagged("withSpring", "spring", "const"),
  "animation/repeat.js": tagged("withRepeat", "repeat", "const"),
  "animation/delay.js": tagged("withDelay", "delay", "const"),
  "animation/sequence.js": tagged("withSequence", "sequence", "function"),
  "mutables.js": {
    splices: [
      {
        find: /(get value\(\) \{[^}]*?)return value;/,
        replace: `$1return ${NS}.readValue(mutable, value);`,
      },
      {
        find: /Object\.defineProperties\(mutable, \{/,
        replace: `${NS}.trackMutable(mutable, listeners);Object.defineProperties(mutable, {`,
      },
    ],
  },
  "valueSetter.js": {
    splices: [
      {
        find: /const previousAnimation = mutable\._animation;/,
        replace: `${NS}.interruptValue(mutable);const previousAnimation = mutable._animation;`,
      },
      {
        find: /mutable\._animation = animation;(\s*)step\(currentTimestamp\);/,
        replace: `mutable._animation = animation;$1if (!${NS}.offloadValue(mutable, animation, ` +
          `previousAnimation, currentTimestamp, step)) step(currentTimestamp);`,
      },
    ],
  },
  "mappers.js": {
    splices: [
      {
        find: /mappers\.set\(mapper\.id, mapper\);/,
        replace: `mappers.set(mapper.id, mapper);${NS}.mapperStarted(mapper);`,
      },
      {
        find: /mappers\.delete\(mapper\.id\);/,
        replace: `mappers.delete(mapper.id);${NS}.mapperStopped(mapper);`,
      },
      {
        find: /mapper\.worklet\(\);/,
        replace: `${NS}.beforeMapperRun(mapper);mapper.worklet();`,
      },
    ],
  },
  "hook/useAnimatedStyle.js": {
    splices: [{
      find: /const mapperId = startMapper\(fun, inputs\);/,
      replace: `${NS}.styleMapper(fun, shareableViewDescriptors, updaterFn, isAnimatedProps, ` +
        `IS_JEST);const mapperId = startMapper(fun, inputs);`,
    }],
  },
  "hook/useAnimatedStyleCommon.js": {
    splices: [
      {
        find: /animation\.callStart = timestamp => \{/,
        replace: `${NS}.noteAnimationStart(animation, value, lastAnimation);` +
          `animation.callStart = timestamp => {`,
      },
      {
        find: /const animations = state\.animations \?\? \{\};(\s*const newValues = updater\(\))/,
        replace: `${NS}.interruptStyle(state);const animations = state.animations ?? {};$1`,
      },
      {
        find: /if \(hasAnimations\) \{(\s*const frame = )/,
        replace: `if (hasAnimations && ${NS}.offloadStyle({ viewDescriptors, state, animations, ` +
          `nonAnimated: nonAnimatedNewValues, hasNonAnimated: hasNonAnimatedValues, ` +
          `isAnimatedProps, t0: frameTimestamp, animationsActive, updateProps })) ` +
          `{ state.last = newValues; return; } if (hasAnimations) {$1`,
      },
    ],
  },
  "ReanimatedModule/js-reanimated/index.js": {
    splices: [{ find: /import \{[^}]*\bcreateTransformValue\b[^}]*\} from/, replace: "$&" }],
    append: `${NS}.setStyleConverter(createReactDOMStyle, createTransformValue);\n`,
  },
};

/** A Reanimated 4 web module the pass patches: the path relative to `lib/module/`. */
const REANIMATED_MODULE = /[\\/]react-native-reanimated[\\/]lib[\\/]module[\\/](.+\.js)$/;

/** react-native-web's UIManager (ES or CommonJS build). */
const UI_MANAGER =
  /[\\/]react-native-web[\\/]dist[\\/](cjs[\\/])?exports[\\/]UIManager[\\/]index\.js$/;

/** Every module this pass may patch (for an esbuild `onLoad` filter). */
export const OFFLOAD_MODULE_FILTER =
  /[\\/](?:react-native-reanimated[\\/]lib[\\/]module|react-native-web[\\/]dist)[\\/].+\.js$/;

/** Apply `patch` to `code`: null unless every anchor matches. */
function applyPatch(code: string, patch: FilePatch): string | null {
  let out = code;
  for (const { find, replace } of patch.splices) {
    if (!find.test(out)) return null;
    out = out.replace(find, replace);
  }
  return patch.append ? `${out}\n${patch.append}` : out;
}

/** Insert `line` after the module's `'use strict';` prologue, on the same line. */
function withImport(code: string, line: string): string {
  const prologue = /^(\s*(?:(['"])use strict\2;?))/.exec(code);
  const at = prologue ? prologue[1].length : 0;
  return code.slice(0, at) + line + code.slice(at);
}

/** The `LayoutAnimation` routing for react-native-web's UIManager (ES or CommonJS). */
function patchUIManager(code: string, cjs: boolean): string | null {
  const find = /configureNextLayoutAnimation\(config, onAnimationDidEnd\) \{/;
  if (!find.test(code)) return null;
  const spec = JSON.stringify(LAYOUT_ANIMATION_RUNTIME);
  const binding = cjs
    ? `var __denextLayoutAnimation = require(${spec});`
    : `import * as __denextLayoutAnimation from ${spec};`;
  return withImport(
    code.replace(
      find,
      "configureNextLayoutAnimation(config, onAnimationDidEnd) { " +
        "return __denextLayoutAnimation.configureNext(config, onAnimationDidEnd);",
    ),
    binding,
  );
}

/**
 * Patch one module for the compositor pass: a Reanimated 4 web module (after the worklets pass
 * ran over it) or react-native-web's UIManager.
 *
 * @param path The module's file path.
 * @param code Its code.
 * @returns The patched code, or null when the module is not one the pass patches or an
 *   anchor did not match (the module is then left as it is).
 */
export function patchForOffload(path: string, code: string): string | null {
  const ui = UI_MANAGER.exec(path);
  if (ui) return patchUIManager(code, ui[1] !== undefined);
  const match = REANIMATED_MODULE.exec(path);
  const patch = match && REANIMATED_PATCHES[match[1].replaceAll("\\", "/")];
  const out = patch ? applyPatch(code, patch) : null;
  return out === null
    ? null
    : withImport(out, `import * as ${NS} from ${JSON.stringify(OFFLOAD_RUNTIME)};`);
}

/** The runtime modules' sources, by specifier (read once per process). */
const runtimeSources = new Map<string, Promise<string>>();

/** Where each runtime module's source lives, next to this file's framework root. */
const RUNTIME_FILES: Readonly<Record<string, string>> = {
  [OFFLOAD_RUNTIME]: "../react-native/animation/offload.ts",
  [LAYOUT_ANIMATION_RUNTIME]: "../react-native/animation/layout-animation.ts",
};

/**
 * The TypeScript source of a runtime module (`denext-reanimated-offload`,
 * `denext-layout-animation`): read from disk in a checkout, fetched when denext runs from JSR.
 */
export function runtimeSource(specifier: string): Promise<string> {
  let source = runtimeSources.get(specifier);
  if (!source) {
    const url = new URL(RUNTIME_FILES[specifier], import.meta.url);
    source = url.protocol === "file:"
      ? Deno.readTextFile(fromFileUrl(url))
      : fetch(url).then((r) => {
        if (!r.ok) throw new Error(`could not fetch ${url} (${r.status})`);
        return r.text();
      });
    runtimeSources.set(specifier, source);
  }
  return source;
}

/** The runtime specifiers (for an esbuild `onResolve` filter). */
export const RUNTIME_FILTER = new RegExp(
  `^(?:${OFFLOAD_RUNTIME}|${LAYOUT_ANIMATION_RUNTIME})$`,
);
