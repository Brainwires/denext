// Client-side reconciler: a small virtual-DOM renderer with hooks, hydration of
// server markup, and in-place DOM patching on state updates.
//
// Instance kinds:
//   host      -> a real Element; owns the placement of its child instances
//   text      -> a real Text node
//   component -> a function component; holds hook state and one rendered child
//   fragment  -> groups children (also carries context providers)
//
// Only host instances (and the synthetic root) own a DOM parent and run
// `syncChildren`. Components and fragments produce ordered DOM node lists that
// their nearest host ancestor flattens and arranges.

import { FRAGMENT, PORTAL, type VNode, type VNodeChild, type VNodeChildren } from "../jsx/types.ts";
import {
  type Context,
  depsChanged,
  type Dispatcher,
  type ErrorBoundaryController,
  MEMO_CACHE_SENTINEL,
  setBoundaryControllerProvider,
  setDispatcher,
} from "../runtime/hooks.ts";
import { areEqualOf } from "../runtime/memo.ts";
import { PROVIDER } from "../runtime/context.ts";
import { isThenable, SUSPENSE } from "../runtime/suspense.ts";
import { ERROR_BOUNDARY, isControlSignal, isRedirect, toError } from "../runtime/error-boundary.ts";
import { isValidAttrName } from "../jsx/render-to-string.ts";
import { commitToDevTools, type DevNode, injectDevTools } from "./devtools.ts";
import { CLASS_COMPONENTS_ENABLED } from "../runtime/class-flag.ts";
import {
  captureSnapshot,
  isClassComponent,
  renderClassInstance,
  unmountClassInstance,
} from "../compat/class-component.ts";

type Kind =
  | "host"
  | "text"
  | "component"
  | "fragment"
  | "portal"
  | "suspense"
  | "errorboundary";

interface HookCell {
  value?: unknown;
  deps?: unknown[];
  cleanup?: (() => void) | void;
  inited?: boolean;
}

interface Instance {
  kind: Kind;
  vnode: VNode;
  dom: Element | Text | null;
  children: Instance[];
  // component only:
  hooks?: HookCell[];
  rendered?: Instance | null;
  // host/fragment/component: the nearest host DOM element owning placement.
  hostDom: Element;
  // nearest enclosing host instance (for re-sync after updates).
  host: Instance | null;
  // nearest enclosing error-boundary instance (for runtime error routing).
  boundary: Instance | null;
  // context values visible to this instance's subtree.
  contexts: Map<symbol, unknown>;
  // provider (fragment) only: the parent map + value the current `contexts` child
  // map was derived from, so an unchanged provider can reuse the same map
  // reference — which makes context-map identity a precise "did any context above
  // change" signal for the component bailout.
  provParent?: Map<symbol, unknown>;
  provValue?: unknown;
  // host only: attached event listeners, keyed by event type.
  listeners?: Map<string, EventListener>;
  // host only: the ref currently attached to this element, and the cleanup a
  // React-19 callback ref returned (so it can be detached on change/unmount).
  attachedRef?: unknown;
  refCleanup?: (() => void) | void;
  // effects queued this render (component only).
  pendingEffects?: Array<() => void>;
  dirty?: boolean;
  // suspense only: whether the fallback (vs. real children) is mounted.
  showingFallback?: boolean;
  // class component only (gated): the user's Component instance, the
  // getSnapshotBeforeUpdate value, and the prev props/state for lifecycle.
  classInstance?: unknown;
  __snapshot?: unknown;
  __prevProps?: unknown;
  __prevState?: unknown;
}

// ---- Text vnode helper -----------------------------------------------------

const TEXT_TYPE = "#text";

function textVNode(value: string): VNode {
  return { type: TEXT_TYPE, props: { nodeValue: value }, key: null };
}

/** Normalize JSX children into a flat list of renderable VNodes. */
function normalizeChildren(children: VNodeChildren): VNode[] {
  const out: VNode[] = [];
  const push = (c: VNodeChild) => {
    if (c == null || c === false || c === true) return;
    if (typeof c === "string") out.push(textVNode(c));
    else if (typeof c === "number") out.push(textVNode(String(c)));
    else out.push(c);
  };
  if (Array.isArray(children)) {
    for (const c of children) {
      if (Array.isArray(c)) c.forEach(push);
      else push(c);
    }
  } else {
    push(children as VNodeChild);
  }
  return out;
}

function sameType(a: VNode, b: VNode): boolean {
  return a.type === b.type;
}

// ---- Hook dispatcher -------------------------------------------------------

let currentInstance: Instance | null = null;
let hookIndex = 0;

function getHook(): HookCell {
  const inst = currentInstance!;
  const hooks = inst.hooks!;
  if (hookIndex >= hooks.length) hooks.push({});
  return hooks[hookIndex++];
}

const clientDispatcher: Dispatcher = {
  useState<S>(initial: S | (() => S)): [S, (v: S | ((p: S) => S)) => void] {
    const inst = currentInstance!;
    const cell = getHook();
    if (!cell.inited) {
      cell.value = typeof initial === "function" ? (initial as () => S)() : initial;
      cell.inited = true;
    }
    const setter = (v: S | ((p: S) => S)) => {
      const next = typeof v === "function" ? (v as (p: S) => S)(cell.value as S) : v;
      if (Object.is(next, cell.value)) return;
      cell.value = next;
      scheduleUpdate(inst);
    };
    return [cell.value as S, setter];
  },

  useReducer<S, A, I>(reducer: (s: S, a: A) => S, initialArg: I, init?: (arg: I) => S) {
    const inst = currentInstance!;
    const cell = getHook();
    if (!cell.inited) {
      cell.value = init ? init(initialArg) : initialArg;
      cell.inited = true;
    }
    const dispatch = (action: A) => {
      const next = reducer(cell.value as S, action);
      if (Object.is(next, cell.value)) return;
      cell.value = next;
      scheduleUpdate(inst);
    };
    return [cell.value as S, dispatch];
  },

  useEffect(effect, deps?: unknown[]) {
    const inst = currentInstance!;
    const cell = getHook();
    const changed = depsChanged(cell.deps, deps);
    if (changed) {
      inst.pendingEffects!.push(() => {
        if (typeof cell.cleanup === "function") cell.cleanup();
        cell.cleanup = effect();
      });
      cell.deps = deps ? [...deps] : undefined;
    }
  },

  useMemo<T>(factory: () => T, deps?: unknown[]): T {
    const cell = getHook();
    if (!("value" in cell) || depsChanged(cell.deps, deps)) {
      cell.value = factory();
      cell.deps = deps ? [...deps] : undefined;
    }
    return cell.value as T;
  },

  useRef<T>(initial: T) {
    const cell = getHook();
    if (!("value" in cell)) cell.value = { current: initial };
    return cell.value as { current: T };
  },

  useContext<T>(context: Context<T>): T {
    const inst = currentInstance!;
    if (inst.contexts.has(context._id)) {
      return inst.contexts.get(context._id) as T;
    }
    return context._defaultValue;
  },

  useId(): string {
    const cell = getHook();
    if (!cell.inited) {
      // Assigned in mount order; hydration mounts in the same order as SSR, so
      // the id matches the server-rendered value.
      cell.value = `:d${clientIdCounter++}:`;
      cell.inited = true;
    }
    return cell.value as string;
  },

  useSyncExternalStore<T>(
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => T,
    _getServerSnapshot?: () => T,
  ): T {
    const inst = currentInstance!;
    const cell = getHook();
    const value = getSnapshot();
    cell.value = value;
    if (depsChanged(cell.deps, [subscribe])) {
      inst.pendingEffects!.push(() => {
        if (typeof cell.cleanup === "function") cell.cleanup();
        cell.cleanup = subscribe(() => {
          // Re-render only when the snapshot actually changed.
          if (!Object.is(getSnapshot(), cell.value)) scheduleUpdate(inst);
        });
      });
      cell.deps = [subscribe];
    }
    return value;
  },

  useMemoCache(size: number): unknown[] {
    const cell = getHook();
    if (!cell.inited) {
      cell.value = new Array(size).fill(MEMO_CACHE_SENTINEL);
      cell.inited = true;
    }
    return cell.value as unknown[];
  },

  // In denext's synchronous commit model, layout and passive effects both run
  // right after commit; layout effects share the same queue mechanism.
  useLayoutEffect(effect, deps?: unknown[]) {
    const inst = currentInstance!;
    const cell = getHook();
    if (depsChanged(cell.deps, deps)) {
      inst.pendingEffects!.push(() => {
        if (typeof cell.cleanup === "function") cell.cleanup();
        cell.cleanup = effect();
      });
      cell.deps = deps ? [...deps] : undefined;
    }
  },
};

/** Deterministic id counter backing {@link clientDispatcher.useId}. */
let clientIdCounter = 0;

// ---- Update scheduling -----------------------------------------------------

let doc: Document = (globalThis as { document?: Document }).document!;

/** Override the document implementation (used by tests with a DOM shim). */
export function setDocument(d: Document): void {
  doc = d;
}

const dirtyQueue = new Set<Instance>();
let scheduled = false;

export function scheduleUpdate(inst: Instance): void {
  dirtyQueue.add(inst);
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(flush);
  }
}

/**
 * Run `fn` (if given) and then synchronously flush all pending state updates
 * before returning — matching React's `flushSync(fn)`. Called with no argument it
 * just flushes (also used by tests). Libraries like sonner rely on the callback
 * form to apply an update and see the DOM committed immediately.
 *
 * @param fn Optional callback whose state updates are flushed synchronously.
 * @returns Whatever `fn` returned (or `undefined`).
 */
export function flushSync<T>(fn?: () => T): T | undefined {
  const result = fn ? fn() : undefined;
  flush();
  return result;
}

function flush(): void {
  scheduled = false;
  const batch = [...dirtyQueue];
  dirtyQueue.clear();
  for (const inst of batch) updateComponent(inst);
  for (const rootHost of activeRoots) reportCommit(rootHost);
}

// ---- React DevTools bridge -------------------------------------------------

/** Root host instances currently mounted (reported to DevTools on each commit). */
const activeRoots = new Set<Instance>();
/** Tri-state: undefined = not yet probed, then whether the extension is present. */
let devToolsActive: boolean | undefined;

/** Report the current tree of `rootHost` to React DevTools (guarded, cheap no-op
 * when the extension is absent). */
function reportCommit(rootHost: Instance): void {
  try {
    if (devToolsActive === undefined) devToolsActive = injectDevTools();
    if (!devToolsActive) return;
    const child = rootHost.children[0];
    commitToDevTools(child ? instToDevNode(child) : null);
  } catch {
    // The DevTools bridge must never affect rendering.
  }
}

/** Convert a reconciler {@link Instance} into a DevTools {@link DevNode}. */
function instToDevNode(inst: Instance): DevNode {
  const vtype = inst.vnode.type;
  const key = inst.vnode.key == null ? null : String(inst.vnode.key);
  const props = inst.vnode.props;
  switch (inst.kind) {
    case "text":
      return {
        kind: "text",
        name: "text",
        key: null,
        props: {},
        text: String((props as { nodeValue?: unknown })?.nodeValue ?? ""),
        dom: inst.dom,
        children: [],
      };
    case "component": {
      const fn = vtype as { displayName?: string; name?: string };
      const name = (typeof vtype === "function" ? fn.displayName || fn.name : "Component") ||
        "Anonymous";
      return {
        kind: "component",
        name,
        key,
        props,
        dom: null,
        children: inst.rendered ? [instToDevNode(inst.rendered)] : [],
      };
    }
    case "suspense":
    case "errorboundary":
      return {
        kind: "component",
        name: inst.kind === "suspense" ? "Suspense" : "ErrorBoundary",
        key,
        props,
        dom: null,
        children: inst.children.map(instToDevNode),
      };
    case "fragment":
      return {
        kind: "fragment",
        name: "Fragment",
        key,
        props,
        dom: null,
        children: inst.children.map(instToDevNode),
      };
    case "portal":
      return {
        kind: "fragment",
        name: "Portal",
        key,
        props: {},
        dom: null,
        children: inst.children.map(instToDevNode),
      };
    default:
      return {
        kind: "host",
        name: typeof vtype === "string" ? vtype : "host",
        key,
        props,
        dom: inst.dom,
        children: inst.children.map(instToDevNode),
      };
  }
}

// ---- Component rendering ---------------------------------------------------

/** Internal prop carrying a Flight client island's `useId` base. */
const ID_BASE_PROP = "__dnxIdBase";

function renderComponent(inst: Instance): VNode {
  const prevInst = currentInstance;
  const prevIdx = hookIndex;
  currentInstance = inst;
  hookIndex = 0;
  inst.pendingEffects = [];
  const prevDispatcher = setDispatcher(clientDispatcher);
  try {
    // Class components (gated; folds out when classComponents is off).
    if (CLASS_COMPONENTS_ENABLED && isClassComponent(inst.vnode.type)) {
      const { vnode, bailed } = renderClassInstance(inst as never);
      if (bailed) return (inst.rendered?.vnode as VNode) ?? textVNode("");
      return (vnode as VNode) ?? textVNode("");
    }
    const type = inst.vnode.type as (props: unknown) => VNode;
    let props = inst.vnode.props;
    // Flight hydration: a client island seeds the shared useId counter to the
    // base the server recorded, so ids line up across the elided server
    // components between islands. Strip the marker before the component sees it.
    const base = (props as Record<string, unknown>)[ID_BASE_PROP];
    if (typeof base === "number") {
      clientIdCounter = base;
      const { [ID_BASE_PROP]: _drop, ...rest } = props as Record<string, unknown>;
      props = rest;
    }
    const result = type(props);
    if (result instanceof Promise) {
      throw new Error(
        "denext: async components are server-only; cannot render on the client.",
      );
    }
    return result ?? textVNode("");
  } finally {
    setDispatcher(prevDispatcher);
    currentInstance = prevInst;
    hookIndex = prevIdx;
  }
}

function runEffects(inst: Instance): void {
  const effects = inst.pendingEffects;
  inst.pendingEffects = [];
  if (effects) { for (const e of effects) e(); }
}

// ---- Mounting --------------------------------------------------------------

/**
 * A cursor over a parent's existing child DOM nodes, used during hydration to
 * adopt server-rendered nodes instead of creating new ones.
 */
interface Cursor {
  parent: Node;
  index: number;
}

function cursorPeek(cursor: Cursor | null): Node | null {
  if (!cursor) return null;
  return cursor.parent.childNodes[cursor.index] ?? null;
}

function cursorTake(cursor: Cursor): Node | null {
  const node = cursor.parent.childNodes[cursor.index] ?? null;
  if (node) cursor.index++;
  return node;
}

interface MountCtx {
  hostDom: Element;
  host: Instance | null;
  boundary: Instance | null;
  contexts: Map<symbol, unknown>;
  /** When present, adopt existing DOM nodes (hydration). */
  cursor: Cursor | null;
}

// Dev-only hydration diagnostics. The dev server sets `globalThis.__denextDev`
// (via its live-reload script, injected before the deferred hydration module
// runs); production never sets it, so these checks compile away to a cheap
// falsy read with zero output. A warning fires only while the hydration cursor
// is live — intentional server/client divergences (`dynamic({ssr:false})`,
// resolved Suspense, error fallbacks) enter their subtree with a null cursor,
// so they never trip it.
function devHydrationActive(): boolean {
  return (globalThis as { __denextDev?: boolean }).__denextDev === true;
}

/** Describe an unexpected DOM node found during hydration, for a warning. */
function describeNode(node: Node | null): string {
  if (!node) return "nothing (the server markup ended early)";
  if (node.nodeType === 3) return `text ${JSON.stringify(node.nodeValue ?? "")}`;
  if (node.nodeType === 1) return `<${(node as Element).tagName.toLowerCase()}>`;
  return `a node of type ${node.nodeType}`;
}

/** Warn about a server/client hydration mismatch (dev only). */
function warnHydrationMismatch(detail: string): void {
  console.warn(
    `denext: hydration mismatch — ${detail}. The client render is used; ` +
      `check for output that differs between server and client (Date.now(), ` +
      `Math.random(), locale/timezone, or invalid HTML nesting).`,
  );
}

function mount(vnode: VNode, ctx: MountCtx): Instance {
  const { type } = vnode;

  // Text node.
  if (type === TEXT_TYPE) {
    const value = String(vnode.props.nodeValue ?? "");
    let node: Text;
    const existing = ctx.cursor ? cursorPeek(ctx.cursor) : null;
    if (existing && existing.nodeType === 3) {
      node = existing as Text;
      const serverValue = node.nodeValue ?? "";
      if (serverValue !== value) {
        if (value !== "" && serverValue.length > value.length && serverValue.startsWith(value)) {
          // Adjacent-text coalescing: SSR merges sibling string/number children
          // into ONE text node (`Count: {n}` -> "Count: 5"), which the client
          // splits back into separate text vnodes. Adopt this vnode's slice and
          // split the remainder into a new node for the next text vnode to adopt.
          // This is a correct hydration, not a mismatch — no warning.
          node.nodeValue = value;
          const remainder = doc.createTextNode(serverValue.slice(value.length));
          const cursor = ctx.cursor!;
          cursor.parent.insertBefore(remainder, cursor.parent.childNodes[cursor.index + 1] ?? null);
        } else {
          if (devHydrationActive()) {
            warnHydrationMismatch(
              `server text ${JSON.stringify(serverValue)} became ${JSON.stringify(value)}`,
            );
          }
          node.nodeValue = value;
        }
      }
      cursorTake(ctx.cursor!);
    } else {
      if (ctx.cursor && devHydrationActive()) {
        warnHydrationMismatch(
          `expected text ${JSON.stringify(value)}, but the server rendered ${
            describeNode(existing)
          }`,
        );
      }
      node = doc.createTextNode(value);
    }
    return baseInstance("text", vnode, node, ctx);
  }

  // Suspense boundary.
  if ((type as unknown) === SUSPENSE) {
    const inst = baseInstance("suspense", vnode, null, ctx);
    inst.host = ctx.host;
    mountSuspenseContent(inst, ctx);
    return inst;
  }

  // Error boundary.
  if ((type as unknown) === ERROR_BOUNDARY) {
    const inst = baseInstance("errorboundary", vnode, null, ctx);
    inst.host = ctx.host;
    mountErrorContent(inst, ctx);
    return inst;
  }

  // Fragment (and context providers).
  if (type === FRAGMENT) {
    const inst = baseInstance("fragment", vnode, null, ctx);
    const childContexts = providerContexts(inst, vnode, ctx.contexts);
    inst.contexts = childContexts;
    inst.children = mountChildren(vnode.props.children, {
      ...ctx,
      contexts: childContexts,
      host: inst.host,
    });
    return inst;
  }

  // Portal: children mount into a separate DOM target, but keep their place in
  // the component/context tree (so context and error boundaries cross the portal,
  // unlike a fresh sub-root). The portal owns placement into `target` and
  // contributes no DOM to its in-place parent (see `collectDom`).
  if ((type as unknown) === PORTAL) {
    const inst = baseInstance("portal", vnode, null, ctx);
    const target = vnode.props.target as Element;
    inst.hostDom = target;
    inst.host = inst; // descendants sync into the portal target
    inst.children = mountChildren(vnode.props.children, {
      hostDom: target,
      host: inst,
      boundary: ctx.boundary,
      contexts: ctx.contexts,
      cursor: null, // portals render nothing on the server; never adopt DOM
    });
    syncChildren(target, flattenDom(inst.children));
    return inst;
  }

  // Function component.
  if (typeof type === "function") {
    const inst = baseInstance("component", vnode, null, ctx);
    inst.hooks = [];
    const rendered = renderComponent(inst);
    inst.rendered = mount(rendered, { ...ctx, host: inst.host });
    inst.children = [inst.rendered];
    // Effects run after the tree commits; queue them.
    pendingMountEffects.push(inst);
    return inst;
  }

  // Host element.
  const tag = type as string;
  let el: Element;
  const existing = ctx.cursor ? cursorPeek(ctx.cursor) : null;
  const matches = existing && existing.nodeType === 1 &&
    (existing as Element).tagName.toLowerCase() === tag.toLowerCase();
  if (matches) {
    el = existing as Element;
    cursorTake(ctx.cursor!);
  } else {
    if (ctx.cursor && devHydrationActive()) {
      warnHydrationMismatch(
        `expected <${tag.toLowerCase()}>, but the server rendered ${describeNode(existing)}`,
      );
    }
    el = doc.createElement(tag);
  }

  const inst = baseInstance("host", vnode, el, ctx);
  inst.hostDom = el;
  inst.host = inst;
  inst.listeners = new Map();
  applyProps(inst, {}, vnode.props);

  const childCursor: Cursor | null = matches ? { parent: el, index: 0 } : null;
  inst.children = mountChildren(vnode.props.children, {
    hostDom: el,
    host: inst,
    boundary: ctx.boundary,
    contexts: ctx.contexts,
    cursor: childCursor,
  });
  syncChildren(el, flattenDom(inst.children));
  return inst;
}

let pendingMountEffects: Instance[] = [];

function baseInstance(
  kind: Kind,
  vnode: VNode,
  dom: Element | Text | null,
  ctx: MountCtx,
): Instance {
  return {
    kind,
    vnode,
    dom,
    children: [],
    hostDom: ctx.hostDom,
    host: ctx.host,
    boundary: ctx.boundary,
    contexts: ctx.contexts,
  };
}

function mountChildren(children: VNodeChildren, ctx: MountCtx): Instance[] {
  const vnodes = normalizeChildren(children);
  return vnodes.map((v) => mount(v, ctx));
}

/**
 * Compute the context map visible to a fragment's children. When the fragment is
 * a context provider, derive a child map from `parent` + the provided value —
 * *reusing the previous child-map reference* when neither the parent map nor the
 * provided value changed. That reference stability is what lets the component
 * bailout treat context-map identity as an exact "no context above me changed"
 * signal (see {@link canBailComponent}). Non-provider fragments just pass `parent`
 * through.
 *
 * @param inst The fragment instance (stores the memo of its last derivation).
 * @param vnode The fragment vnode (carries the provider info, if any).
 * @param parent The context map inherited from above.
 */
function providerContexts(
  inst: Instance,
  vnode: VNode,
  parent: Map<symbol, unknown>,
): Map<symbol, unknown> {
  const info = vnode.props[PROVIDER as unknown as string] as
    | { id: symbol; value: unknown }
    | undefined;
  if (!info) return parent;
  if (
    inst.provParent === parent && Object.is(inst.provValue, info.value) &&
    inst.contexts.get(info.id) === info.value
  ) {
    return inst.contexts; // unchanged provider — reuse the same child-map reference
  }
  const next = new Map(parent);
  next.set(info.id, info.value);
  inst.provParent = parent;
  inst.provValue = info.value;
  return next;
}

// ---- Suspense --------------------------------------------------------------

function ctxForInstance(inst: Instance): MountCtx {
  return {
    hostDom: inst.hostDom,
    host: inst.host,
    boundary: inst.boundary,
    contexts: inst.contexts,
    cursor: null,
  };
}

/** Mount a Suspense boundary's real children, falling back on suspension. */
function mountSuspenseContent(inst: Instance, ctx: MountCtx): void {
  const childCtx = { ...ctx, host: inst.host };
  try {
    inst.children = mountChildren(inst.vnode.props.children, childCtx);
    inst.showingFallback = false;
  } catch (err) {
    if (!isThenable(err)) throw err;
    // The children suspended. During hydration the server streamed the RESOLVED
    // content, so the fallback must NOT try to adopt that DOM — mount it fresh
    // (cursor: null). retrySuspense later swaps in the real content, also fresh.
    // This both avoids corrupting hydration and prevents false mismatch warnings.
    inst.children = mountChildren(
      inst.vnode.props.fallback as VNodeChildren,
      { ...childCtx, cursor: null },
    );
    inst.showingFallback = true;
    err.then(() => retrySuspense(inst), () => retrySuspense(inst));
  }
}

/** Re-attempt a suspended boundary once its promise settles. */
function retrySuspense(inst: Instance): void {
  const savedEffects = pendingMountEffects;
  pendingMountEffects = [];
  try {
    const real = mountChildren(inst.vnode.props.children, ctxForInstance(inst));
    for (const c of inst.children) unmount(c);
    inst.children = real;
    inst.showingFallback = false;
    if (inst.host) syncChildren(inst.host.hostDom, flattenDom(inst.host.children));
    const drained = pendingMountEffects;
    pendingMountEffects = [];
    for (const e of drained) runEffects(e);
  } catch (err) {
    if (isThenable(err)) {
      err.then(() => retrySuspense(inst), () => retrySuspense(inst));
    } else {
      throw err;
    }
  } finally {
    pendingMountEffects = savedEffects;
  }
}

// ---- Error boundaries ------------------------------------------------------

/** Clear a boundary's error and re-attempt rendering its real children. */
function resetBoundary(inst: Instance): void {
  const saved = pendingMountEffects;
  pendingMountEffects = [];
  try {
    for (const c of inst.children) unmount(c);
    // Descendants re-established here again report to this boundary.
    inst.children = mountChildren(inst.vnode.props.children, {
      ...ctxForInstance(inst),
      boundary: inst,
    });
    const drained = pendingMountEffects;
    pendingMountEffects = [];
    for (const e of drained) runEffects(e);
    if (inst.host) syncChildren(inst.host.hostDom, flattenDom(inst.host.children));
  } catch (err) {
    if (isControlSignal(err)) throw err;
    renderFallback(inst, err, ctxForInstance(inst));
    if (inst.host) syncChildren(inst.host.hostDom, flattenDom(inst.host.children));
  } finally {
    pendingMountEffects = saved;
  }
}

function renderFallback(inst: Instance, error: unknown, ctx: MountCtx): void {
  const Fallback = inst.vnode.props.fallback as (
    p: { error: Error; reset: () => void },
  ) => VNode;
  const fallbackVNode: VNode = {
    type: Fallback as unknown as string,
    props: { error: toError(error), reset: () => resetBoundary(inst) },
    key: null,
  };
  // The fallback subtree reports to the PARENT boundary (inst.boundary), not to
  // this one — so an error inside the fallback doesn't loop back onto itself.
  inst.children = [
    mount(fallbackVNode, { ...ctx, host: inst.host, boundary: inst.boundary }),
  ];
}

/**
 * Show a boundary's fallback for a runtime `error` (from an event handler,
 * async callback, or `captureError`), replacing its current children.
 */
function triggerBoundary(inst: Instance, error: unknown): void {
  if (isControlSignal(error)) throw error;
  const saved = pendingMountEffects;
  pendingMountEffects = [];
  try {
    for (const c of inst.children) unmount(c);
    renderFallback(inst, error, ctxForInstance(inst));
    const drained = pendingMountEffects;
    pendingMountEffects = [];
    for (const e of drained) runEffects(e);
  } finally {
    pendingMountEffects = saved;
  }
  if (inst.host) syncChildren(inst.host.hostDom, flattenDom(inst.host.children));
}

/** Route a runtime error from `inst` to its nearest error boundary. */
function routeToBoundary(inst: Instance, error: unknown): void {
  const boundary = inst.boundary;
  if (!boundary) throw error; // no boundary above -> let it surface
  triggerBoundary(boundary, error);
}

/**
 * Handle an error thrown by a user event handler or form action: perform a
 * client redirect for `redirect()`, re-throw other control signals, and route
 * genuine errors to the nearest boundary.
 */
function handleEventError(inst: Instance, error: unknown): void {
  if (isRedirect(error)) {
    if (typeof location !== "undefined") location.href = error.url;
    return;
  }
  if (isControlSignal(error)) throw error;
  routeToBoundary(inst, error);
}

/** Build the controller {@link useErrorBoundary} returns for `inst`. */
function makeBoundaryController(inst: Instance | null): ErrorBoundaryController {
  const boundary = inst?.boundary ?? null;
  return {
    reset() {
      if (boundary) resetBoundary(boundary);
    },
    captureError(error: unknown) {
      if (boundary) triggerBoundary(boundary, error);
      else if (isControlSignal(error)) throw error;
    },
  };
}

// Let useErrorBoundary() resolve the controller for the component rendering now.
setBoundaryControllerProvider(() => makeBoundaryController(currentInstance));

/** Mount error-boundary children, showing the fallback on a render error. */
function mountErrorContent(inst: Instance, ctx: MountCtx): void {
  // Descendants report to this boundary.
  const childCtx = { ...ctx, host: inst.host, boundary: inst };
  try {
    inst.children = mountChildren(inst.vnode.props.children, childCtx);
  } catch (err) {
    if (isThenable(err)) throw err; // suspension bubbles to <Suspense>
    // Control signals (redirect/notFound/forbidden/unauthorized) are not errors:
    // they must bubble past the boundary, matching the server renderer.
    if (isControlSignal(err)) throw err;
    renderFallback(inst, err, childCtx);
  }
}

// ---- DOM node flattening + placement ---------------------------------------

/** Collect the ordered top-level DOM nodes produced by a list of instances. */
function flattenDom(instances: Instance[]): (Element | Text)[] {
  const out: (Element | Text)[] = [];
  for (const inst of instances) collectDom(inst, out);
  return out;
}

function collectDom(inst: Instance, out: (Element | Text)[]): void {
  // A portal's DOM lives in its target, not in the in-place parent — skip it.
  if (inst.kind === "portal") return;
  if (inst.dom) {
    out.push(inst.dom);
  } else {
    for (const child of inst.children) collectDom(child, out);
  }
}

/** Arrange `desired` nodes as the exact ordered children of `parent`. */
function syncChildren(parent: Element, desired: (Element | Text)[]): void {
  for (let i = 0; i < desired.length; i++) {
    const node = desired[i];
    const current = parent.childNodes[i] ?? null;
    if (current !== node) parent.insertBefore(node, current);
  }
  while (parent.childNodes.length > desired.length) {
    parent.removeChild(parent.childNodes[parent.childNodes.length - 1]);
  }
}

// ---- Props / attributes / events -------------------------------------------

function applyProps(
  inst: Instance,
  oldProps: Record<string, unknown>,
  newProps: Record<string, unknown>,
): void {
  const el = inst.dom as Element;

  // Remove props gone or changed.
  for (const name of Object.keys(oldProps)) {
    if (name === "children" || name === "key" || name === "ref") continue;
    if (name in newProps) continue;
    if (/^on[A-Z]/.test(name)) {
      removeListener(inst, name);
    } else {
      const attr = normalizeAttr(name);
      if (isValidAttrName(attr)) el.removeAttribute(attr);
    }
  }

  // Refs: attach/detach with React-19 semantics (support cleanup-returning
  // callback refs; detach the old ref when it changes). Handled outside the loop
  // so we can compare the previous and next ref.
  updateRef(inst, oldProps.ref, newProps.ref, el);

  for (const [name, value] of Object.entries(newProps)) {
    if (name === "children" || name === "key" || name === "ref") continue;
    if (/^on[A-Z]/.test(name)) {
      setListener(inst, name, value as EventListener | undefined);
      continue;
    }
    // A form `action={fn}` (React 19 form action / useActionState dispatch):
    // intercept submit and call the action with the form's FormData.
    if (
      (name === "action" || name === "formAction") && typeof value === "function"
    ) {
      setFormAction(inst, value as (payload: unknown) => void);
      continue;
    }
    if (typeof value === "function") continue; // non-event function props aren't attrs
    if (oldProps[name] === value) continue;
    setAttribute(el, name, value);
  }
}

/** Wire a function-valued form `action` to the form's submit event. */
function setFormAction(inst: Instance, action: (payload: unknown) => void): void {
  const el = inst.dom as Element;
  const existing = inst.listeners!.get("submit");
  if (existing) el.removeEventListener("submit", existing);
  const handler: EventListener = (event) => {
    event.preventDefault();
    const form = event.target;
    // Build FormData from the real form element when possible.
    const FormDataCtor = (globalThis as { FormData?: unknown }).FormData as
      | (new (form: unknown) => unknown)
      | undefined;
    let payload: unknown;
    try {
      payload = FormDataCtor && form ? new FormDataCtor(form) : undefined;
    } catch {
      payload = undefined; // non-form element (e.g. test shim)
    }
    // Route thrown/rejected action errors to the nearest boundary.
    try {
      const r = action(payload) as unknown;
      if (r && typeof (r as { then?: unknown }).then === "function") {
        (r as Promise<unknown>).then(undefined, (err) => handleEventError(inst, err));
      }
    } catch (err) {
      handleEventError(inst, err);
    }
  };
  el.addEventListener("submit", handler);
  inst.listeners!.set("submit", handler);
}

/**
 * Attach `newRef` to `el` and detach `oldRef`, following React 19 ref semantics:
 * a callback ref may return a cleanup function (invoked on detach instead of
 * calling the ref with `null`); object refs get `.current` set/cleared. No-ops
 * when the ref is unchanged, so the same ref stays attached across re-renders.
 */
function updateRef(inst: Instance, oldRef: unknown, newRef: unknown, el: Element): void {
  if (Object.is(oldRef, newRef)) return;
  detachRef(inst);
  if (newRef == null) return;
  if (typeof newRef === "function") {
    const cleanup = newRef(el);
    inst.refCleanup = typeof cleanup === "function" ? cleanup : undefined;
  } else if (typeof newRef === "object") {
    (newRef as { current: unknown }).current = el;
  }
  inst.attachedRef = newRef;
}

/** Detach the ref currently attached to `inst` (cleanup fn, or clear/null it). */
function detachRef(inst: Instance): void {
  const ref = inst.attachedRef;
  if (ref == null) return;
  if (typeof inst.refCleanup === "function") {
    inst.refCleanup();
  } else if (typeof ref === "function") {
    ref(null);
  } else if (typeof ref === "object") {
    (ref as { current: unknown }).current = null;
  }
  inst.refCleanup = undefined;
  inst.attachedRef = undefined;
}

/**
 * React's event-prop names don't always match DOM event types. Map the ones that
 * differ (keyed by the lowercased React name, minus `on`/`Capture`): React's
 * `onChange` is the DOM **`input`** event (fires per keystroke, not on blur), and
 * `onDoubleClick` is `dblclick`. Everything else lowercases directly.
 */
const REACT_EVENT_MAP: Record<string, string> = {
  change: "input",
  doubleclick: "dblclick",
};

interface ParsedEvent {
  /** The DOM event type to (un)register. */
  type: string;
  /** Whether this is a capture-phase handler (`on*Capture`). */
  capture: boolean;
}

/** Parse an `on*` prop into its DOM event type and capture flag. */
function parseEvent(prop: string): ParsedEvent {
  let name = prop.slice(2); // strip "on"
  let capture = false;
  if (name.endsWith("Capture")) {
    capture = true;
    name = name.slice(0, -"Capture".length);
  }
  const lower = name.toLowerCase();
  return { type: REACT_EVENT_MAP[lower] ?? lower, capture };
}

function setListener(
  inst: Instance,
  prop: string,
  handler: EventListener | undefined,
): void {
  const ev = parseEvent(prop);
  const key = prop; // key by React prop name so distinct props never collide
  const el = inst.dom as Element;
  const existing = inst.listeners!.get(key);
  if (existing) el.removeEventListener(ev.type, existing, ev.capture);
  if (typeof handler === "function") {
    // Wrap so a throw in the handler routes to the nearest error boundary
    // (React can't catch event-handler errors; denext can).
    const wrapped: EventListener = (event) => {
      try {
        const r = handler(event) as unknown;
        if (r && typeof (r as { then?: unknown }).then === "function") {
          (r as Promise<unknown>).then(undefined, (err) => handleEventError(inst, err));
        }
      } catch (err) {
        handleEventError(inst, err);
      }
    };
    el.addEventListener(ev.type, wrapped, ev.capture);
    inst.listeners!.set(key, wrapped);
  } else {
    inst.listeners!.delete(key);
  }
}

function removeListener(inst: Instance, prop: string): void {
  const ev = parseEvent(prop);
  const key = prop; // key by React prop name so distinct props never collide
  const el = inst.dom as Element;
  const existing = inst.listeners!.get(key);
  if (existing) {
    el.removeEventListener(ev.type, existing, ev.capture);
    inst.listeners!.delete(key);
  }
}

function normalizeAttr(name: string): string {
  if (name === "className") return "class";
  if (name === "htmlFor") return "for";
  return name;
}

function setAttribute(el: Element, name: string, value: unknown): void {
  const attr = normalizeAttr(name);
  // Skip unsafe names: the DOM throws on them, and they must not reach markup.
  if (!isValidAttrName(attr)) return;
  if (value == null || value === false) {
    el.removeAttribute(attr);
    return;
  }
  if (value === true) {
    el.setAttribute(attr, "");
    return;
  }
  if (attr === "style" && typeof value === "object") {
    el.setAttribute("style", serializeStyleObject(value as Record<string, unknown>));
    return;
  }
  // Reflect form values onto the property too so inputs stay controlled.
  if (attr === "value" && "value" in el) {
    (el as unknown as { value: unknown }).value = value;
  }
  el.setAttribute(attr, String(value));
}

function serializeStyleObject(style: Record<string, unknown>): string {
  let css = "";
  for (const [prop, value] of Object.entries(style)) {
    if (value == null || value === false) continue;
    const kebab = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    css += `${kebab}:${value};`;
  }
  return css;
}

// ---- Patching --------------------------------------------------------------

/** Reconcile an existing instance against a new vnode; returns the instance to use. */
function patch(inst: Instance, next: VNode, ctx: MountCtx): Instance {
  if (!sameType(inst.vnode, next)) {
    // Replace: mount fresh, unmount old.
    const replacement = mount(next, ctx);
    unmount(inst);
    return replacement;
  }

  const prevVNode = inst.vnode;
  inst.vnode = next;

  if (inst.kind === "text") {
    const value = String(next.props.nodeValue ?? "");
    if ((inst.dom as Text).nodeValue !== value) {
      (inst.dom as Text).nodeValue = value;
    }
    return inst;
  }

  if (inst.kind === "host") {
    // Propagate the incoming context map (a provider above may have changed it) so
    // consumers deeper in the tree re-read fresh values on update.
    inst.contexts = ctx.contexts;
    applyProps(inst, prevVNode.props, next.props);
    inst.children = reconcileChildren(inst.children, next.props.children, {
      hostDom: inst.dom as Element,
      host: inst,
      boundary: inst.boundary,
      contexts: inst.contexts,
      cursor: null,
    });
    syncChildren(inst.dom as Element, flattenDom(inst.children));
    return inst;
  }

  if (inst.kind === "fragment") {
    const childContexts = providerContexts(inst, next, ctx.contexts);
    inst.contexts = childContexts;
    inst.children = reconcileChildren(inst.children, next.props.children, {
      hostDom: inst.hostDom,
      host: inst.host,
      boundary: inst.boundary,
      contexts: childContexts,
      cursor: null,
    });
    return inst;
  }

  if (inst.kind === "portal") {
    const nextTarget = next.props.target as Element;
    inst.contexts = ctx.contexts;
    const portalCtx: MountCtx = {
      hostDom: nextTarget,
      host: inst,
      boundary: inst.boundary,
      contexts: ctx.contexts,
      cursor: null,
    };
    if ((prevVNode.props.target as Element) !== nextTarget) {
      // Target moved: tear down from the old container, mount into the new one.
      for (const c of inst.children) unmount(c);
      inst.hostDom = nextTarget;
      inst.children = mountChildren(next.props.children, portalCtx);
    } else {
      inst.children = reconcileChildren(inst.children, next.props.children, portalCtx);
    }
    syncChildren(nextTarget, flattenDom(inst.children));
    return inst;
  }

  if (inst.kind === "suspense") {
    const childCtx = ctxForInstance(inst);
    if (inst.showingFallback) {
      // Still waiting: keep the fallback reconciled to the latest fallback prop.
      inst.children = reconcileChildren(
        inst.children,
        next.props.fallback as VNodeChildren,
        childCtx,
      );
    } else {
      try {
        inst.children = reconcileChildren(inst.children, next.props.children, childCtx);
      } catch (err) {
        if (!isThenable(err)) throw err;
        for (const c of inst.children) unmount(c);
        inst.children = mountChildren(next.props.fallback as VNodeChildren, childCtx);
        inst.showingFallback = true;
        err.then(() => retrySuspense(inst), () => retrySuspense(inst));
      }
    }
    return inst;
  }

  if (inst.kind === "errorboundary") {
    const childCtx = { ...ctxForInstance(inst), boundary: inst };
    try {
      inst.children = reconcileChildren(inst.children, next.props.children, childCtx);
    } catch (err) {
      if (isThenable(err)) throw err;
      if (isControlSignal(err)) throw err; // bubble control signals past the boundary
      for (const c of inst.children) unmount(c);
      renderFallback(inst, err, childCtx);
    }
    return inst;
  }

  // component
  const prevContexts = inst.contexts;
  // Class components decide re-render via getDerivedStateFromProps + SCU inside the
  // class adapter (props-equality bailout is wrong for them — state can change with
  // equal props), so they always fall through to renderComponent.
  const isClass = CLASS_COMPONENTS_ENABLED && isClassComponent(inst.vnode.type);
  if (!isClass && canBailComponent(inst, prevVNode, next, prevContexts, ctx.contexts)) {
    // Props are shallow-equal and no context this subtree reads changed (the map
    // reference is identical), so re-rendering would produce the same tree — reuse
    // the existing rendered subtree untouched. Context reference stays the same, so
    // descendants are consistent without descending.
    return inst;
  }
  // A provider above may have changed the visible context map; adopt it so this
  // component (and everything it renders) reads fresh values.
  inst.contexts = ctx.contexts;
  const rendered = renderComponent(inst);
  const oldRendered = inst.rendered!;
  // getSnapshotBeforeUpdate: after render, before DOM mutation (patch).
  if (isClass) captureSnapshot(inst as never);
  inst.rendered = patch(oldRendered, rendered, {
    hostDom: inst.hostDom,
    host: inst.host,
    boundary: inst.boundary,
    contexts: inst.contexts,
    cursor: null,
  });
  inst.children = [inst.rendered];
  runEffects(inst);
  return inst;
}

/**
 * Decide whether patching a component can skip re-rendering it (and its whole
 * subtree). Safe only when:
 *   - the component is not itself scheduled for a state update (dirty), and
 *   - the visible context map is reference-identical (so no context above changed
 *     value — see {@link providerContexts} for why identity is exact), and
 *   - its props satisfy the bailout comparator (shallow-equal, or a custom
 *     `memo()` comparator).
 * Because denext components are pure, identical props + state + context yield an
 * identical subtree, so reusing it is correct.
 */
function canBailComponent(
  inst: Instance,
  prevVNode: VNode,
  next: VNode,
  prevContexts: Map<symbol, unknown>,
  nextContexts: Map<symbol, unknown>,
): boolean {
  if (dirtyQueue.has(inst)) return false;
  if (prevContexts !== nextContexts) return false;
  return areEqualOf(next.type)(prevVNode.props, next.props);
}

/** Re-render a single dirty component and re-sync its nearest host. */
function updateComponent(inst: Instance): void {
  if (inst.kind !== "component") return;
  const rendered = renderComponent(inst);
  // getSnapshotBeforeUpdate: after render, before DOM mutation (patch).
  if (CLASS_COMPONENTS_ENABLED && inst.classInstance) captureSnapshot(inst as never);
  inst.rendered = patch(inst.rendered!, rendered, {
    hostDom: inst.hostDom,
    host: inst.host,
    boundary: inst.boundary,
    contexts: inst.contexts,
    cursor: null,
  });
  inst.children = [inst.rendered];
  // Re-arrange the owning host's DOM in case node identities changed.
  const host = inst.host;
  if (host) syncChildren(host.hostDom, flattenDom(host.children));
  runEffects(inst);
}

function reconcileChildren(
  oldChildren: Instance[],
  newChildrenRaw: VNodeChildren,
  ctx: MountCtx,
): Instance[] {
  const newVNodes = normalizeChildren(newChildrenRaw);

  const keyed = new Map<unknown, Instance>();
  const unkeyed: Instance[] = [];
  for (const c of oldChildren) {
    if (c.vnode.key != null) keyed.set(c.vnode.key, c);
    else unkeyed.push(c);
  }

  const used = new Set<Instance>();
  let unkeyedIdx = 0;
  const result: Instance[] = [];

  for (const nv of newVNodes) {
    let match: Instance | undefined;
    if (nv.key != null) {
      match = keyed.get(nv.key);
    } else {
      while (unkeyedIdx < unkeyed.length) {
        const cand = unkeyed[unkeyedIdx++];
        if (sameType(cand.vnode, nv)) {
          match = cand;
          break;
        }
      }
    }
    if (match && !used.has(match) && sameType(match.vnode, nv)) {
      used.add(match);
      result.push(patch(match, nv, ctx));
    } else {
      result.push(mount(nv, ctx));
    }
  }

  for (const c of oldChildren) {
    if (!used.has(c)) unmount(c);
  }
  return result;
}

// ---- Unmounting ------------------------------------------------------------

function unmount(inst: Instance): void {
  if (inst.kind === "component") {
    // Class componentWillUnmount fires before its subtree is torn down (parent-first).
    if (CLASS_COMPONENTS_ENABLED && inst.classInstance) unmountClassInstance(inst as never);
    // Run cleanups for all effect hooks.
    if (inst.hooks) {
      for (const cell of inst.hooks) {
        if (typeof cell.cleanup === "function") cell.cleanup();
      }
    }
    if (inst.rendered) unmount(inst.rendered);
  } else {
    for (const child of inst.children) unmount(child);
  }
  // Detach any ref (React clears refs / runs their cleanup on unmount).
  if (inst.attachedRef != null) detachRef(inst);
  if (inst.dom && inst.dom.parentNode) {
    inst.dom.parentNode.removeChild(inst.dom);
  }
}

// ---- Public entry points ---------------------------------------------------

/**
 * Render `children` into a different DOM `container` while keeping their place in
 * the component and context tree (context providers and error boundaries above
 * the call remain visible to the portaled subtree). Placement into `container`
 * preserves its existing children; the subtree is removed on unmount. Renders
 * nothing during SSR. Backs `react-dom`'s `createPortal`.
 */
export function createPortal(children: VNodeChild, container: Element): VNode {
  return {
    type: PORTAL as unknown as VNode["type"],
    props: { target: container, children },
    key: null,
  };
}

/** A mounted (or hydrated) render root that can be re-rendered or torn down. */
export interface Root {
  /** Render (or re-render) `vnode` into this root's container. */
  render(vnode: VNode): void;
  /** Unmount the tree and remove its DOM nodes from the container. */
  unmount(): void;
}

/** Create a synthetic host instance representing the mount container. */
function makeRootHost(container: Element): Instance {
  const root: Instance = {
    kind: "host",
    vnode: { type: container.tagName.toLowerCase(), props: {}, key: null },
    dom: container,
    children: [],
    hostDom: container,
    host: null,
    boundary: null,
    contexts: new Map(),
    listeners: new Map(),
  };
  root.host = root;
  return root;
}

/** Mount `vnode` into `container`, creating fresh DOM. */
export function createRoot(container: Element): Root {
  const rootHost = makeRootHost(container);
  activeRoots.add(rootHost);
  let tree: Instance | null = null;
  return {
    render(vnode: VNode) {
      pendingMountEffects = [];
      if (tree === null) clientIdCounter = 0; // first mount: align useId with SSR
      const ctx = rootCtx(rootHost, null);
      tree = tree === null ? mount(vnode, ctx) : patch(tree, vnode, ctx);
      rootHost.children = [tree];
      syncChildren(container, flattenDom([tree]));
      drainMountEffects();
      reportCommit(rootHost);
    },
    unmount() {
      if (tree) unmount(tree);
      tree = null;
      rootHost.children = [];
      activeRoots.delete(rootHost);
      reportCommit(rootHost);
    },
  };
}

/** Hydrate `vnode` against server-rendered markup already in `container`. */
export function hydrateRoot(container: Element, vnode: VNode): Root {
  const rootHost = makeRootHost(container);
  activeRoots.add(rootHost);
  pendingMountEffects = [];
  clientIdCounter = 0; // align useId with the server render's id sequence
  const cursor: Cursor = { parent: container, index: 0 };
  let tree = mount(vnode, { ...rootCtx(rootHost, null), cursor });
  rootHost.children = [tree];
  syncChildren(container, flattenDom([tree]));
  drainMountEffects();
  reportCommit(rootHost);
  return {
    render(next: VNode) {
      pendingMountEffects = [];
      tree = patch(tree, next, rootCtx(rootHost, null));
      rootHost.children = [tree];
      syncChildren(container, flattenDom([tree]));
      drainMountEffects();
      reportCommit(rootHost);
    },
    unmount() {
      unmount(tree);
      rootHost.children = [];
      activeRoots.delete(rootHost);
      reportCommit(rootHost);
    },
  };
}

function rootCtx(rootHost: Instance, cursor: Cursor | null): MountCtx {
  return {
    hostDom: rootHost.hostDom,
    host: rootHost,
    boundary: null,
    contexts: new Map(),
    cursor,
  };
}

function drainMountEffects(): void {
  const effects = pendingMountEffects;
  pendingMountEffects = [];
  for (const inst of effects) runEffects(inst);
}
