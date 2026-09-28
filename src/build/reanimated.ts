// React Native mode: Reanimated / react-native-worklets on the web without their Babel plugin.
//
// Reanimated 4 runs worklets on the web as plain JavaScript on the main thread, but its web
// runtime still reads two properties the Babel plugin (`react-native-worklets/plugin`) stamps
// on every worklet function:
//
//   - `__closure`: an ARRAY of the values the worklet captures from enclosing scopes.
//     `useAnimatedStyle` / `useDerivedValue` / `useAnimatedProps` / `useAnimatedReaction`
//     spread it into their effect dependencies (`[...updater.__closure, updater.__workletHash]`),
//     and `useHandler` (`useAnimatedScrollHandler`, `useEvent`) compares handler closures
//     element-wise to decide whether to rebuild.
//   - `__workletHash`: a number identifying the worklet's source. `isWorkletFunction()` is
//     `!!fn.__workletHash`; without it `useAnimatedStyle` with no dependency array throws in
//     dev (reanimated 4.x `hook/useAnimatedStyle.js`), `useHandler` falls back to "no plugin"
//     mode, and gesture-handler treats every callback as a JS-thread callback.
//
// Everything else the plugin emits (`__initData` with the stringified code and source map,
// `__stackDetails`, `__pluginVersion`, the worklet factory function) is read only by the
// native runtimes (`*.native.js` in react-native-worklets 0.13) and is not emitted here.
//
// This module is that plugin's web half as an esbuild `onLoad` pass over an swc AST (the same
// byte-splice approach as the auto-memo compiler, swc-ast.ts). It finds worklets the way the
// plugin does — a `'worklet'` directive, a file-level `'worklet'` directive, and
// autoworkletization of the arguments of Reanimated's hooks / animation callbacks / scheduling
// functions, gesture-handler builder callbacks (`Gesture.Pan().onUpdate(fn)`) and hooks, and
// layout-animation `.withCallback(fn)` — including an identifier that names a function or
// object declared in the module — computes each one's closure with a scope analysis
// (worklet-scope.ts), and wraps it:
//
//   useAnimatedStyle(() => ({ opacity: sv.value }))
//   → useAnimatedStyle(__denextWorklet(() => ({ opacity: sv.value }), [sv], 4031987112))
//
// A worklet function DECLARATION keeps its hoisting: a statement at the top of its scope
// stamps it, with the closure read lazily through a getter (`() => [sv]`), so a use before
// the declaration line, or captured bindings declared below it, never hit the TDZ. An
// expression worklet whose closure names a `let` / `const` / `class` declared further down
// gets the same lazy getter; every other closure is evaluated where the function is — the
// Babel plugin's semantics. Edits never add a line break, so line numbers are unchanged.
//
// The pass runs only on modules whose text names react-native-reanimated,
// react-native-worklets or react-native-gesture-handler, or contains a `'worklet'` directive
// — app source and node_modules alike (Metro runs the plugin over both: libraries built on
// Reanimated ship untransformed worklets, and gesture-handler probes the plugin with a
// worklet of its own). A module it cannot parse is left exactly as written.
//
// The plugin imports the helper from a virtual module (`denext-worklets-runtime`; `require`
// in a CommonJS module), so a bundle carries one copy. esbuild honours the first `onLoad`
// that returns contents, and React Native mode's plugins run ahead of the SPA transforms, so a
// module this pass claims skips them: in dev the plugin adds the Fast Refresh registrations
// itself; the production auto-memo compiler and feature-flag fold do not run on it (the
// Babel plugin marks worklets "use no memo" anyway, and an unfolded `feature()` call still
// works through the runtime shim).
//
// The same plugin applies the compositor pass (reanimated-offload.ts): after the worklets pass,
// Reanimated 4's own web modules get the splices that move `transform` / `opacity` animations
// to Web Animations, and react-native-web's UIManager routes `LayoutAnimation.configureNext`
// to a FLIP runtime. Both runtimes load from their own namespace.

import { basename, dirname, extname, SEPARATOR, toFileUrl } from "@std/path";
import type * as esbuild from "esbuild";
import {
  applyEdits,
  type Ctx,
  type Edit,
  encoder,
  type Node,
  parseModule,
  txt,
} from "./swc-ast.ts";
import { parseModuleForPath } from "./swc-parse.ts";
import {
  analyzeScopes,
  type Binding,
  directivesOf,
  type FunctionSite,
  prologueEnd,
  type Scope,
  type ScopeAnalysis,
  scopeWithin,
} from "./worklet-scope.ts";
import { collectComponents, refreshFooter } from "./spa-refresh-plugin.ts";
import {
  OFFLOAD_MODULE_FILTER,
  patchForOffload,
  RUNTIME_FILTER as OFFLOAD_RUNTIME_FILTER,
  runtimeSource,
} from "./reanimated-offload.ts";

/** A module the pass looks at: it names a worklet-using package or has a worklet directive. */
export const WORKLETS_GATE = /react-native-(?:reanimated|worklets|gesture-handler)|["']worklet["']/;

/** The helper that stamps a worklet (every transformed module calls it). */
const HELPER = "__denextWorklet";

/**
 * The helper: stamp `__closure` (an array, a getter over a thunk, or — `0`, an empty closure —
 * nothing, as the Babel plugin omits it) and `__workletHash` on the function and return it.
 */
const HELPER_FUNCTION = `function ${HELPER}(f, c, h) {` +
  ` if (typeof c === "function") Object.defineProperty(f, "__closure", { get: c, configurable: true });` +
  ` else if (c) f.__closure = c; f.__workletHash = h; return f; }`;

/**
 * The module the plugin's transformed modules import the helper from (one copy per bundle
 * instead of one per module).
 */
const WORKLETS_RUNTIME = "denext-worklets-runtime";

/** {@linkcode WORKLETS_RUNTIME}'s source. */
const RUNTIME_SOURCE = `export ${HELPER_FUNCTION}\n`;

/**
 * Reanimated / worklets functions whose arguments are worklets, and which argument positions
 * (react-native-worklets 0.13 `plugin/index.js`, `lib/autoworkletization.js`).
 */
const FUNCTION_HOOKS: ReadonlyMap<string, readonly number[]> = new Map(
  Object.entries({
    useFrameCallback: [0],
    useAnimatedStyle: [0],
    useAnimatedProps: [0],
    createAnimatedPropAdapter: [0],
    useDerivedValue: [0],
    useAnimatedScrollHandler: [0],
    useAnimatedReaction: [0, 1],
    withTiming: [2, 3],
    withSpring: [2, 3],
    withDecay: [1],
    withRepeat: [3],
    runOnUI: [0],
    executeOnUIRuntimeSync: [0],
    scheduleOnUI: [0],
    runOnUISync: [0],
    runOnUIAsync: [0],
    runOnRuntime: [1],
    runOnRuntimeSync: [1],
    runOnRuntimeAsync: [1],
    scheduleOnRuntime: [1],
    runOnRuntimeSyncWithId: [1],
    scheduleOnRuntimeWithId: [1],
  }),
);

/** Gesture-handler v3's object hooks (`usePanGesture({ onUpdate })`). */
const GESTURE_OBJECT_HOOKS = [
  "useTapGesture",
  "usePanGesture",
  "usePinchGesture",
  "useRotationGesture",
  "useFlingGesture",
  "useLongPressGesture",
  "useNativeGesture",
  "useManualGesture",
  "useHoverGesture",
];

/** Hooks whose argument is an object of worklets. */
const OBJECT_HOOKS = new Set([
  "useAnimatedScrollHandler",
  ...GESTURE_OBJECT_HOOKS,
]);

/** `Gesture.<X>()` factories. */
const GESTURE_OBJECTS = new Set([
  "Tap",
  "Pan",
  "Pinch",
  "Rotation",
  "Fling",
  "LongPress",
  "ForceTouch",
  "Native",
  "Manual",
  "Race",
  "Simultaneous",
  "Exclusive",
  "Hover",
]);

/** Gesture builder methods whose callbacks are worklets. */
const GESTURE_CALLBACKS = new Set([
  "onBegin",
  "onStart",
  "onEnd",
  "onFinalize",
  "onUpdate",
  "onChange",
  "onTouchesDown",
  "onTouchesMove",
  "onTouchesUp",
  "onTouchesCancelled",
]);

/** Layout animations whose `.withCallback(fn)` takes a worklet (entering/exiting/layout). */
const LAYOUT_ANIMATION =
  /^(?:(?:Bounce|Fade|Flip|LightSpeed|Pinwheel|Roll|Rotate|Slide|Stretch|Zoom)(?:In|Out)\w*|Layout|LinearTransition|SequencedTransition|FadingTransition|JumpingTransition|CurvedTransition|EntryExitTransition)$/;

/** Chainable layout-animation builder methods (`FadeIn.duration(300).withCallback(fn)`). */
const LAYOUT_CHAIN = new Set([
  "build",
  "duration",
  "delay",
  "getDuration",
  "randomDelay",
  "getDelay",
  "getDelayFunction",
  "easing",
  "rotate",
  "springify",
  "damping",
  "mass",
  "stiffness",
  "overshootClamping",
  "energyThreshold",
  "restDisplacementThreshold",
  "restSpeedThreshold",
  "withInitialValues",
  "getAnimationAndConfig",
  "easingX",
  "easingY",
  "easingWidth",
  "easingHeight",
  "entering",
  "exiting",
  "reverse",
]);

/**
 * The hooks that read a worklet's closure as their dependencies, and the position of their
 * explicit dependency-array argument (the web fallback when there is no closure).
 */
const DEPENDENCY_HOOKS: ReadonlyMap<string, number> = new Map(Object.entries({
  useAnimatedStyle: 1,
  useDerivedValue: 1,
  useAnimatedProps: 1,
  useAnimatedReaction: 2,
  useAnimatedScrollHandler: 1,
}));

/** A build diagnostic: a pattern the pass could not turn into a worklet. */
export interface WorkletDiagnostic {
  /** 1-based line. */
  line: number;
  /** 0-based column (in UTF-16 code units of the line). */
  column: number;
  /** The line's text. */
  lineText: string;
  /** What is wrong and how to fix it. */
  text: string;
}

/** What {@linkcode transformWorklets} did to a module. */
export interface WorkletsTransformResult {
  /** The transformed source (the input when nothing changed). */
  code: string;
  /** Whether any worklet was stamped. */
  changed: boolean;
  /** How many worklets were stamped. */
  worklets: number;
  /** Patterns that could not be handled (only when `diagnostics` was requested). */
  diagnostics: WorkletDiagnostic[];
}

/** Options for {@linkcode transformWorklets}. */
export interface WorkletsTransformOptions {
  /** Report patterns the pass can't handle (app source; off for node_modules). */
  diagnostics?: boolean;
  /**
   * Where the helper comes from: `"inline"` (default) appends it to the module; `"import"`
   * imports it from {@linkcode WORKLETS_RUNTIME} (`require` in a CommonJS module), which the
   * esbuild plugin resolves.
   */
  helper?: "inline" | "import";
}

/** A worklet to stamp. */
interface Worklet {
  site: FunctionSite;
}

/** Parse `source` for `path`'s dialect; null when it does not parse. */
const parseFor = (path: string, source: string) => parseModuleForPath(path, source);

/** Strip parentheses: `((fn))` → `fn` (Babel's AST has no parenthesis nodes). */
function unparen(node: Node): Node {
  let n = node;
  while (n?.type === "ParenthesisExpression") n = n.expression;
  return n;
}

/** The name a call's callee ends in: `f(…)`, `a.b.f(…)`, `(0, a.f)(…)`. */
function calleeName(callee: Node): string | undefined {
  let c = unparen(callee);
  if (c?.type === "SequenceExpression") {
    c = unparen(c.expressions[c.expressions.length - 1]);
  }
  if (c?.type === "Identifier") return c.value;
  if (c?.type === "MemberExpression" && c.property?.type === "Identifier") {
    return c.property.value;
  }
  return undefined;
}

/** Whether `node` is a function node the plugin workletizes. */
function isFunctionNode(node: Node): boolean {
  return node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionDeclaration";
}

/** The node kinds this pass stamps (class methods and accessors are left alone). */
function isStampable(node: Node): boolean {
  return isFunctionNode(node) || node?.type === "MethodProperty";
}

/** A member call `x.<name>(…)`'s object, when the callee is non-computed `x.name`. */
function memberCall(
  node: Node,
  names: (name: string) => boolean,
): Node | undefined {
  const callee = node?.type === "CallExpression" ? unparen(node.callee) : null;
  if (
    callee?.type !== "MemberExpression" ||
    callee.property?.type !== "Identifier"
  ) return;
  return names(callee.property.value) ? callee.object : undefined;
}

/** `Gesture.Pan()` or a builder chain on one (`Gesture.Pan().minDistance(1)`). */
function isGestureChain(node: Node): boolean {
  const n = unparen(node);
  if (n?.type !== "CallExpression") return false;
  const callee = unparen(n.callee);
  if (
    callee?.type !== "MemberExpression" ||
    callee.property?.type !== "Identifier"
  ) return false;
  const object = unparen(callee.object);
  if (object?.type === "Identifier" && object.value === "Gesture") {
    return GESTURE_OBJECTS.has(callee.property.value);
  }
  return isGestureChain(object);
}

/** A layout animation, `new` one, or builder chain on one (`FadeIn.duration(300)`). */
function isLayoutAnimationChain(node: Node): boolean {
  const n = unparen(node);
  if (n?.type === "Identifier") return LAYOUT_ANIMATION.test(n.value);
  if (n?.type === "NewExpression") {
    return n.callee?.type === "Identifier" &&
      LAYOUT_ANIMATION.test(n.callee.value);
  }
  const object = memberCall(n, (name) => LAYOUT_CHAIN.has(name));
  return object !== undefined && isLayoutAnimationChain(object);
}

/** 53-bit FNV-1a: a stable, non-zero number for a worklet's identity. */
function workletHash(text: string): number {
  let h = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(text)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return Number(h & 0x1fffffffffffffn) || 1;
}

/** The per-module transform state. */
class ModuleTransform {
  readonly worklets = new Map<Node, Worklet>();
  readonly diagnostics: WorkletDiagnostic[] = [];
  readonly lineStarts: number[];

  constructor(
    readonly path: string,
    readonly source: string,
    readonly ctx: Ctx,
    readonly scopes: ScopeAnalysis,
    readonly report: boolean,
  ) {
    this.lineStarts = [0];
    for (let i = 0; i < ctx.bytes.length; i++) {
      if (ctx.bytes[i] === 10) this.lineStarts.push(i + 1);
    }
  }

  /** Mark a function node as a worklet. */
  mark(node: Node): void {
    if (!isStampable(node)) return;
    const site = this.scopes.functions.get(node);
    if (site && !this.worklets.has(node)) this.worklets.set(node, { site });
  }

  /** Report `text` at `node` (when diagnostics are on). */
  diagnose(node: Node, text: string): void {
    if (!this.report) return;
    const offset = node.span.start - this.ctx.base;
    let line = 0;
    while (
      line + 1 < this.lineStarts.length && this.lineStarts[line + 1] <= offset
    ) line++;
    const start = this.lineStarts[line];
    const end = line + 1 < this.lineStarts.length
      ? this.lineStarts[line + 1] - 1
      : this.ctx.bytes.length;
    const decode = (a: number, b: number) =>
      new TextDecoder().decode(this.ctx.bytes.subarray(a, b));
    this.diagnostics.push({
      line: line + 1,
      column: decode(start, offset).length,
      lineText: decode(start, end).replace(/\r$/, ""),
      text,
    });
  }

  /**
   * Mark what `arg` names: a function (when `fns`), each function of an object literal (when
   * `objects`), or the declaration an identifier resolves to. Returns whether it found one.
   */
  findWorklet(
    arg: Node,
    scope: Scope,
    fns: boolean,
    objects: boolean,
  ): boolean {
    const n = unparen(arg);
    if (fns && isFunctionNode(n)) {
      this.mark(n);
      return true;
    }
    if (objects && n?.type === "ObjectExpression") {
      this.objectWorklets(n, scope);
      return true;
    }
    if (n?.type === "Identifier") {
      const binding = this.scopes.resolve(n.value, scope);
      return binding ? this.referencedWorklet(binding, fns, objects, new Set()) : false;
    }
    return false;
  }

  /** The declaration a referenced worklet's binding names (Babel `findReferencedWorklet`). */
  referencedWorklet(
    binding: Binding,
    fns: boolean,
    objects: boolean,
    seen: Set<Binding>,
  ): boolean {
    if (seen.has(binding)) return false;
    seen.add(binding);
    // A function declaration (its name is bound outside its own scope; a named function
    // expression's name is bound inside it).
    if (fns && binding.kind === "function" && this.isDeclaration(binding)) {
      this.mark(binding.node);
      return true;
    }
    const accept = (r: Node) =>
      (fns && isFunctionNode(unparen(r))) ||
      (objects && unparen(r)?.type === "ObjectExpression");
    // Reassigned: the last assignment of a function / object (the initializer is ignored).
    const definition = binding.assignments.length > 0
      ? binding.assignments.findLast(accept)
      : binding.init;
    const def = unparen(definition);
    if (!def) return false;
    if (def.type === "Identifier") {
      const next = this.scopes.resolve(def.value, binding.scope);
      return next ? this.referencedWorklet(next, fns, objects, seen) : false;
    }
    return this.findWorklet(def, binding.scope, fns, objects);
  }

  /** Whether a `function` binding is a declaration (not a function expression's own name). */
  isDeclaration(binding: Binding): boolean {
    const site = this.scopes.functions.get(binding.node);
    return site !== undefined && site.scope !== binding.scope;
  }

  /** Every function of an object of worklets (`useAnimatedScrollHandler({ onScroll })`). */
  objectWorklets(object: Node, scope: Scope): void {
    for (const p of object.properties) {
      if (p.type === "MethodProperty") this.mark(p);
      else if (p.type === "KeyValueProperty") {
        this.findWorklet(p.value, scope, true, false);
      } else if (p.type === "Identifier") {
        this.findWorklet(p, scope, true, false);
      } else {
        this.diagnose(
          p,
          `a ${p.type === "SpreadElement" ? "spread" : "getter / setter"} in an object of ` +
            `worklet handlers can't be made a worklet at build time — write each handler as ` +
            `a property (\`onScroll: (e) => { … }\`) or a method.`,
        );
      }
    }
  }

  /** Autoworkletize one call's arguments (Babel `handleWorkletizableCallback`). */
  call(node: Node, scope: Scope): void {
    const name = calleeName(node.callee);
    const args: Node[] = node.arguments.map((a: Node) => a.expression);
    if (name && (FUNCTION_HOOKS.has(name) || OBJECT_HOOKS.has(name))) {
      const fns = FUNCTION_HOOKS.has(name);
      const objects = OBJECT_HOOKS.has(name);
      const indices = FUNCTION_HOOKS.get(name) ?? [0];
      const found = indices.map((i) =>
        args[i] ? this.findWorklet(args[i], scope, fns, objects) : true
      );
      this.checkDependencies(name, args, found, scope);
      return;
    }
    const gesture = memberCall(node, (n) => GESTURE_CALLBACKS.has(n));
    if (gesture !== undefined && isGestureChain(gesture)) {
      for (const a of args) this.findWorklet(a, scope, true, true);
      return;
    }
    const layout = memberCall(node, (n) => n === "withCallback");
    if (layout !== undefined && isLayoutAnimationChain(layout)) {
      for (const a of args) {
        if (isFunctionNode(unparen(a))) this.mark(unparen(a));
      }
    }
  }

  /**
   * A dependency-reading hook whose worklet this build can't see and that has no explicit
   * dependency array: on the web it throws in dev (`useAnimatedStyle`) or never re-runs when
   * the values it reads change. Report it with the fix.
   */
  checkDependencies(
    name: string,
    args: Node[],
    found: boolean[],
    scope: Scope,
  ): void {
    const depsAt = DEPENDENCY_HOOKS.get(name);
    if (depsAt === undefined || args.length > depsAt || found.every(Boolean)) {
      return;
    }
    const missing = args.find((a, i) => !found[i] && a && this.definitelyNotWorklet(a, scope));
    if (!missing) return;
    this.diagnose(
      missing,
      `\`${name}\`'s worklet is not a function this build can see (it is ${
        describe(unparen(missing))
      }), so its closure — the values the web runtime re-runs it on — can't be derived. ` +
        `Pass it inline (\`${name}(() => { … })\`), give the function a 'worklet' directive, ` +
        `or add an explicit dependency array: \`${name}(fn, [dep1, dep2])\`.`,
    );
  }

  /**
   * Whether an unresolved hook argument certainly is not a worklet: a call result or a local
   * binding initialized with one — not a parameter, import or member, which may carry a
   * worklet made elsewhere, and not a call that wraps a function with a `'worklet'` directive.
   */
  definitelyNotWorklet(arg: Node, scope: Scope): boolean {
    let n = unparen(arg);
    if (n?.type === "Identifier") {
      const b = this.scopes.resolve(n.value, scope);
      if (
        !b || b.kind === "param" || b.kind === "import" || b.kind === "function"
      ) return false;
      n = b.assignments.length > 0 ? null : unparen(b.init);
    }
    if (!n) return false;
    if (n.type === "CallExpression" || n.type === "NewExpression") {
      return !n.arguments?.some((a: Node) =>
        isFunctionNode(unparen(a.expression)) &&
        directivesOf(unparen(a.expression).body).includes("worklet")
      );
    }
    return n.type !== "MemberExpression" && n.type !== "Identifier" &&
      n.type !== "ConditionalExpression" &&
      n.type !== "OptionalChainingExpression";
  }

  /** A file-level `'worklet'` directive: every top-level function / object of functions. */
  fileWorklets(body: Node[]): void {
    const entity = (n: Node | null | undefined): void => {
      const node = unparen(n);
      if (!node) return;
      if (isFunctionNode(node)) this.mark(node);
      else if (node.type === "ObjectExpression") {
        for (const p of node.properties) {
          if (p.type === "MethodProperty") this.mark(p);
          else if (p.type === "KeyValueProperty") entity(p.value);
        }
      } else if (node.type === "VariableDeclaration") {
        for (const d of node.declarations) entity(d.init);
      }
    };
    for (const stmt of body) {
      if (stmt.type === "ExportDeclaration") entity(stmt.declaration);
      else if (stmt.type === "ExportDefaultDeclaration") entity(stmt.decl);
      else if (stmt.type === "ExportDefaultExpression") entity(stmt.expression);
      else entity(stmt);
    }
  }

  /** Find every worklet in the module. */
  collect(body: Node[]): void {
    if (
      directivesOf({ type: "BlockStatement", stmts: body }).includes("worklet")
    ) {
      this.fileWorklets(body);
    }
    for (const [node] of this.scopes.functions) {
      if (directivesOf(node.body).includes("worklet")) this.mark(node);
    }
    for (const c of this.scopes.calls) this.call(c.node, c.scope);
  }

  /** A worklet's closure: the names it reads that are bound outside it, in first-read order. */
  closure(w: Worklet): { names: string[]; lazy: boolean } {
    const { node, scope } = w.site;
    if (directivesOf(node.body).includes("no-worklet-closure")) {
      return { names: [], lazy: false };
    }
    const names: string[] = [];
    let lazy = false;
    const seen = new Set<string>();
    const start = node.span.start;
    for (const ref of this.scopes.refs) {
      if (seen.has(ref.name) || !scopeWithin(ref.scope, scope)) continue;
      const b = this.scopes.resolve(ref.name, ref.scope);
      // A global (Babel keeps any not on its allow-list; on the web a missing one would throw
      // where it is read), a name bound inside the worklet, or the worklet's own name.
      if (
        !b || scopeWithin(b.scope, scope) || b.node === node || b.init === node
      ) continue;
      seen.add(ref.name);
      names.push(ref.name);
      if (isTdzKind(b) && b.node.span.start > start) lazy = true;
    }
    return { names, lazy };
  }

  /** The splices that stamp every worklet, and the helper. */
  edits(): Edit[] {
    const edits: Edit[] = [];
    for (const w of this.worklets.values()) edits.push(...this.stamp(w));
    return edits;
  }

  stamp(w: Worklet): Edit[] {
    const { node, container } = w.site;
    const { names, lazy } = this.closure(w);
    const start = node.span.start - this.ctx.base;
    const end = node.span.end - this.ctx.base;
    // From the file name, offset and code, not the absolute path: the same build on another
    // machine emits the same bundle.
    const hash = workletHash(`${basename(this.path)}:${start}:${txt(this.ctx, node)}`);
    const list = `[${names.join(", ")}]`;
    const empty = names.length === 0;
    const depth = w.site.scope.depth;
    if (container && node.identifier) {
      const first = prologueEnd(container)!;
      const at = first.span.start - this.ctx.base;
      return [{
        start: at,
        end: at,
        text: `${HELPER}(${node.identifier.value}, ${empty ? "0" : `() => ${list}`}, ${hash});`,
        order: -1000,
      }];
    }
    const closure = empty ? "0" : lazy ? `() => ${list}` : list;
    if (node.type === "MethodProperty") {
      const keyEnd = node.key.span.end - this.ctx.base;
      const head = `${txt(this.ctx, node.key)}: ${HELPER}(${node.async ? "async " : ""}function${
        node.generator ? "*" : ""
      } `;
      return [
        { start, end: keyEnd, text: head },
        { start: end, end, text: `, ${closure}, ${hash})`, order: -depth },
      ];
    }
    return [
      { start, end: start, text: `${HELPER}(`, order: depth },
      { start: end, end, text: `, ${closure}, ${hash})`, order: -depth },
    ];
  }
}

/** A binding in its temporal dead zone until its declaration runs. */
function isTdzKind(b: Binding): boolean {
  return b.kind === "let" || b.kind === "const" || b.kind === "class" ||
    b.kind === "using";
}

/** How a diagnostic names an argument. */
function describe(n: Node): string {
  if (n.type === "CallExpression") return "the result of a call";
  if (n.type === "Identifier") return `\`${n.value}\``;
  return `a ${n.type.replace(/Expression$/, "").toLowerCase()} expression`;
}

/**
 * Stamp the worklets of one module with the `__closure` / `__workletHash` Reanimated's web
 * runtime reads (see the module header). A module that does not parse, or has no worklet,
 * comes back unchanged.
 *
 * @param source The module source.
 * @param path Its path (picks the parser dialect by extension; part of each worklet's hash).
 * @param options `diagnostics` reports patterns the pass can't handle.
 * @returns The new source and what changed.
 */
export async function transformWorklets(
  source: string,
  path: string,
  options: WorkletsTransformOptions = {},
): Promise<WorkletsTransformResult> {
  const unchanged = {
    code: source,
    changed: false,
    worklets: 0,
    diagnostics: [],
  };
  const parsed = await parseFor(path, source);
  if (!parsed) return unchanged;
  const scopes = analyzeScopes(parsed.body);
  const t = new ModuleTransform(
    path,
    source,
    parsed.ctx,
    scopes,
    options.diagnostics === true,
  );
  t.collect(parsed.body);
  if (t.worklets.size === 0) {
    return { ...unchanged, diagnostics: t.diagnostics };
  }
  const edits = t.edits();
  if (options.helper === "import") edits.push(helperImport(parsed));
  const code = applyEdits(parsed.ctx.bytes, edits) +
    (options.helper === "import" ? "" : `\n;${HELPER_FUNCTION}\n`);
  return {
    code,
    changed: true,
    worklets: t.worklets.size,
    diagnostics: t.diagnostics,
  };
}

/** Module syntax: the helper is imported; otherwise (CommonJS) it is required. */
const MODULE_DECLARATIONS = /^(?:Import|Export)/;

/**
 * The splice that brings the helper in, after the module's directive prologue and ahead of
 * the declaration stamps placed there.
 */
function helperImport(parsed: { ctx: Ctx; body: Node[] }): Edit {
  const at = prologueEnd(parsed.body)!.span.start - parsed.ctx.base;
  const esm = parsed.body.some((s) => MODULE_DECLARATIONS.test(s.type));
  const spec = JSON.stringify(WORKLETS_RUNTIME);
  return {
    start: at,
    end: at,
    text: esm
      ? `import { ${HELPER} } from ${spec};`
      : `var ${HELPER} = require(${spec}).${HELPER};`,
    order: -2000,
  };
}

/** The esbuild loader a transformed module is returned under (`.js` is JSX in RN mode). */
function loaderFor(path: string): esbuild.Loader {
  const ext = extname(path);
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return "ts";
  if (ext === ".tsx") return "tsx";
  if (ext === ".mjs" || ext === ".cjs") return "js";
  return "jsx";
}

/** The helper module's specifier, and the esbuild namespace it loads in. */
const RUNTIME_FILTER = new RegExp(`^${WORKLETS_RUNTIME}$`);
const RUNTIME_NAMESPACE = "denext-worklets";

/** The namespace the compositor pass's runtime modules load in. */
const OFFLOAD_NAMESPACE = "denext-rn-offload";

/** The modules the pass may claim. */
const MODULE_FILTER = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** App modules SPA dev instruments for Fast Refresh (spa-refresh-plugin.ts). */
const REFRESH_FILTER = /\.(tsx|jsx|ts)$/;

/** Options for {@linkcode reanimatedWorkletsPlugin}. */
export interface ReanimatedWorkletsPluginOptions {
  /**
   * A dev build: a transformed app module also gets its Fast Refresh registrations, which
   * the SPA refresh plugin (whose `onLoad` this one front-runs) would otherwise add.
   */
  dev?: boolean;
}

/** Whether `path` lies inside `dir`. */
function inside(path: string, dir: string): boolean {
  const root = dir.endsWith(SEPARATOR) ? dir : dir + SEPARATOR;
  return path.startsWith(root);
}

/**
 * The esbuild plugin that runs {@linkcode transformWorklets} over the modules that use
 * worklets ({@linkcode WORKLETS_GATE}): app source and node_modules. A module it leaves
 * unchanged falls through to the later loaders. Patterns it can't handle in app source are
 * build warnings at their file:line. It also applies the compositor pass
 * ({@linkcode patchForOffload}) to Reanimated 4's web modules and react-native-web's UIManager.
 *
 * @param projectDir The project root (app source = under it, outside node_modules).
 * @param options `dev` adds Fast Refresh registrations to transformed app modules.
 */
export function reanimatedWorkletsPlugin(
  projectDir: string,
  options: ReanimatedWorkletsPluginOptions = {},
): esbuild.Plugin {
  return {
    name: "denext-reanimated-worklets",
    setup(build) {
      build.onResolve({ filter: RUNTIME_FILTER }, () => ({
        path: WORKLETS_RUNTIME,
        namespace: RUNTIME_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: RUNTIME_NAMESPACE }, () => ({
        contents: RUNTIME_SOURCE,
        loader: "js",
      }));
      build.onResolve({ filter: OFFLOAD_RUNTIME_FILTER }, (args) => ({
        path: args.path,
        namespace: OFFLOAD_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: OFFLOAD_NAMESPACE }, async (args) => ({
        contents: await runtimeSource(args.path),
        loader: "ts",
      }));
      build.onLoad(
        { filter: MODULE_FILTER, namespace: "file" },
        async (args) => {
          if (args.path.includes("/.entries/")) return undefined;
          let source: string;
          try {
            source = await Deno.readTextFile(args.path);
          } catch {
            return undefined;
          }
          const gated = WORKLETS_GATE.test(source);
          if (!gated && !OFFLOAD_MODULE_FILTER.test(args.path)) return undefined;
          const app = !args.path.includes("/node_modules/") &&
            inside(args.path, projectDir);
          const result = gated
            ? await transformWorklets(source, args.path, { diagnostics: app, helper: "import" })
            : { code: source, changed: false, worklets: 0, diagnostics: [] };
          const patched = patchForOffload(args.path, result.code);
          if (
            !result.changed && patched === null && result.diagnostics.length === 0
          ) return undefined;
          let contents = patched ?? result.code;
          if (options.dev && app && REFRESH_FILTER.test(args.path)) {
            contents += await refreshRegistrations(contents, args.path);
          }
          return {
            contents,
            loader: loaderFor(args.path),
            resolveDir: dirname(args.path),
            warnings: result.diagnostics.map((d) => ({
              text: d.text,
              location: {
                file: args.path,
                line: d.line,
                column: d.column,
                lineText: d.lineText,
              },
            })),
          };
        },
      );
    },
  };
}

/** The Fast Refresh footer spa-refresh-plugin.ts would append ("" when none or unparseable). */
async function refreshRegistrations(
  source: string,
  path: string,
): Promise<string> {
  try {
    const parsed = await parseModule(source);
    if (!parsed) return "";
    const url = toFileUrl(path).href;
    const { names, metas } = collectComponents(parsed, url);
    return refreshFooter(url, names, metas);
  } catch {
    return "";
  }
}
