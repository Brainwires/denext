// React DevTools bridge. Registers denext as a "renderer" with the React
// DevTools extension's global hook (`__REACT_DEVTOOLS_GLOBAL_HOOK__`) and reports
// each commit as a React-fiber-shaped tree, so the extension recognizes a denext
// app and shows its component tree — as if it were React.
//
// SAFETY: the extension's backend is version-sensitive and outside our control,
// so every interaction with it is wrapped so a DevTools error can NEVER affect the
// app. When the extension isn't installed, everything here is a cheap no-op.

/** A denext-tree node, decoupled from the reconciler's internal `Instance`. */
export interface DevNode {
  /** Maps to a React fiber tag: component/host/text/fragment. */
  kind: "component" | "host" | "text" | "fragment";
  /** Display name: component name, host tag, or "Fragment". */
  name: string;
  /** React key, if any. */
  key: string | null;
  /** Props to show in the DevTools inspector. */
  props: unknown;
  /** Text content (text nodes only). */
  text?: string;
  /** The host DOM node (host nodes only; used for element selection). */
  dom: unknown;
  /** Child nodes, in order. */
  children: DevNode[];
}

// React fiber tags DevTools understands.
const FunctionComponent = 0;
const HostRoot = 3;
const HostComponent = 5;
const HostText = 6;
const Fragment = 7;

interface DevToolsHook {
  supportsFiber?: boolean;
  inject(renderer: unknown): number;
  onCommitFiberRoot(id: number, root: unknown, priority?: unknown, mount?: boolean): void;
  onCommitFiberUnmount?(id: number, fiber: unknown): void;
}

let rendererId: number | null = null;
let hook: DevToolsHook | null = null;

function getHook(): DevToolsHook | null {
  try {
    const g = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook };
    const h = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    return h && typeof h.inject === "function" ? h : null;
  } catch {
    return null;
  }
}

/** Whether this is a denext dev build (set by the dev server). */
function isDevBuild(): boolean {
  try {
    return (globalThis as { __denextDev?: boolean }).__denextDev === true;
  } catch {
    return false;
  }
}

/**
 * Register denext with the React DevTools hook (once). Returns `true` when the
 * extension is present and accepted the registration — the caller can then report
 * commits with {@linkcode commitToDevTools}. A no-op returning `false` when the
 * extension isn't installed.
 */
export function injectDevTools(): boolean {
  if (rendererId !== null) return true;
  const h = getHook();
  if (!h) return false;
  try {
    rendererId = h.inject({
      // Report as a React DOM renderer so DevTools uses its standard fiber walk.
      rendererPackageName: "react-dom",
      version: "19.0.0",
      reconcilerVersion: "19.0.0",
      // Report the build type honestly: 1 (development) only in a dev build, else
      // 0 (production). Advertising `1` in production made DevTools surface dev-only
      // affordances/warnings that don't apply to a shipped denext bundle.
      bundleType: isDevBuild() ? 1 : 0,
      // DevTools calls into these; read-only stubs are sufficient for a tree view.
      findFiberByHostInstance: () => null,
      findHostInstanceByFiber: (f: { stateNode?: unknown }) => f?.stateNode ?? null,
      findHostInstancesForRefresh: () => [],
      scheduleRefresh: () => {},
      scheduleRoot: () => {},
      setRefreshHandler: () => {},
      overrideProps: () => {},
      overridePropsDeletePath: () => {},
      overridePropsRenamePath: () => {},
      overrideHookState: () => {},
      overrideHookStateDeletePath: () => {},
      overrideHookStateRenamePath: () => {},
      setSuspenseHandler: () => {},
      scheduleUpdate: () => {},
      getCurrentFiber: () => null,
    });
    hook = h;
    return true;
  } catch {
    rendererId = null;
    return false;
  }
}

/** A named function whose `.name` is what DevTools shows for a component. */
function namedType(name: string): () => null {
  const fn = () => null;
  try {
    Object.defineProperty(fn, "name", { value: name || "Anonymous" });
  } catch { /* name is read-only on some engines */ }
  return fn;
}

function tagFor(kind: DevNode["kind"]): number {
  switch (kind) {
    case "component":
      return FunctionComponent;
    case "text":
      return HostText;
    case "fragment":
      return Fragment;
    default:
      return HostComponent;
  }
}

/** Build a minimal React fiber for `node`, linking children as child/sibling. */
// deno-lint-ignore no-explicit-any
function toFiber(node: DevNode, ret: any): any {
  // deno-lint-ignore no-explicit-any
  const fiber: any = {
    tag: tagFor(node.kind),
    key: node.key,
    elementType: node.kind === "component" ? namedType(node.name) : node.name,
    type: node.kind === "component" ? namedType(node.name) : node.name,
    stateNode: node.kind === "host" ? node.dom ?? null : null,
    // For a host-text fiber DevTools reads memoizedProps as the string itself.
    memoizedProps: node.kind === "text" ? node.text ?? "" : node.props,
    memoizedState: null,
    return: ret,
    child: null,
    sibling: null,
    index: 0,
    flags: 0,
    alternate: null,
  };
  // deno-lint-ignore no-explicit-any
  let prev: any = null;
  node.children.forEach((child, i) => {
    const cf = toFiber(child, fiber);
    cf.index = i;
    if (i === 0) fiber.child = cf;
    else prev.sibling = cf;
    prev = cf;
  });
  return fiber;
}

/**
 * Report the current tree to DevTools as a commit. `rootChild` is the app's root
 * node (or `null` when unmounted). Safe to call unconditionally — it no-ops
 * unless {@linkcode injectDevTools} has succeeded, and swallows any DevTools error.
 *
 * @param rootChild The root {@linkcode DevNode}, or `null`.
 */
export function commitToDevTools(rootChild: DevNode | null): void {
  if (rendererId === null || hook === null) return;
  try {
    // A HostRoot fiber whose `child` is the app tree; wrapped in a FiberRoot.
    // deno-lint-ignore no-explicit-any
    const hostRoot: any = {
      tag: HostRoot,
      key: null,
      elementType: null,
      type: null,
      stateNode: null,
      memoizedState: { element: null, isDehydrated: false },
      memoizedProps: null,
      return: null,
      child: null,
      sibling: null,
      index: 0,
      flags: 0,
      alternate: null,
    };
    if (rootChild) hostRoot.child = toFiber(rootChild, hostRoot);
    const fiberRoot = { current: hostRoot, containerInfo: rootChild?.dom ?? null };
    hostRoot.stateNode = fiberRoot;
    hook.onCommitFiberRoot(rendererId, fiberRoot);
  } catch {
    // DevTools backend rejected our tree — never let that surface to the app.
  }
}

/** Reset registration (tests only). */
export function _resetDevTools(): void {
  rendererId = null;
  hook = null;
}
