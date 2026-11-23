/**
 * The `react-reconciler` host config that renders React into a window's native tree, the way
 * React Native Skia, react-three-fiber and react-konva render into theirs: the app passes
 * `react-reconciler`'s factory, which loads against denext's React core (`denext/react`'s shared
 * internals, src/compat/react-internals.ts), so the hooks a component imports from `react` run
 * on this renderer's fibers. denext itself imports no npm package for it.
 *
 * Mutations map onto the NTB1 ops: a new instance is CREATE plus its initial SET_STYLE / SET_PROP
 * / LISTEN, a text string is a RawText node with SET_TEXT, append and insert-before are INSERT,
 * a removal is REMOVE then DESTROY (the host frees the subtree; JS forgets it), and an update
 * diffs the props. Every op of a commit goes to the host in one `nativeTree.commit`, from
 * `resetAfterCommit`. Written for `react-reconciler` 0.31 (React 19); 0.29's `commitUpdate`
 * signature is accepted too.
 *
 * @module
 */

import { applyProps, releaseSubtree, setHidden } from "./apply.ts";
import { type ContainerOptions, GpuiContainer, type NativeTreeWindow } from "./container.ts";
import { GpuiNode, kindOf } from "./node.ts";
import { KIND } from "./props.generated.ts";
import {
  currentUpdatePriority,
  resolveUpdatePriority,
  setCurrentUpdatePriority,
} from "./priority.ts";

/** Props as React passes them. */
type Props = Record<string, unknown>;

/** Whether a text string may be rendered here (inside a Text or TextInput). */
interface HostContext {
  readonly inText: boolean;
}

const OUTSIDE_TEXT: HostContext = Object.freeze({ inText: false });
const INSIDE_TEXT: HostContext = Object.freeze({ inText: true });

/** The root view's style: it fills the window. */
const ROOT_STYLE = { style: { flex: 1 } };

/** A node of `kind`, with its CREATE in the pending batch. */
function createNode(container: GpuiContainer, kind: number): GpuiNode {
  const node = new GpuiNode(container, kind);
  container.writer.create(node.id, kind);
  return node;
}

/**
 * A window's tree with its root view created and set (sent with the first commit).
 *
 * @param window The window.
 * @param options The root's options.
 * @returns The container.
 */
export function createGpuiContainer(
  window: NativeTreeWindow,
  options: ContainerOptions = {},
): GpuiContainer {
  const container = new GpuiContainer(window, options);
  const root = createNode(container, KIND.View);
  applyProps(root, ROOT_STYLE);
  container.writer.setRoot(root.id);
  container.root = root;
  return container;
}

/** Attach (or move) `child` under `parent`, before `before`: INSERT. */
function attach(parent: GpuiNode, child: GpuiNode, before: GpuiNode | null): void {
  const from = child.parent?.children;
  if (from) from.splice(from.indexOf(child), 1);
  child.parent = parent;
  const at = before ? parent.children.indexOf(before) : -1;
  if (at < 0) parent.children.push(child);
  else parent.children.splice(at, 0, child);
  parent.container.writer.insert(parent.id, child.id, before?.id ?? 0);
}

/** Delete `child` from under `parent`: REMOVE, DESTROY, and forget the subtree. */
function detach(parent: GpuiNode, child: GpuiNode): void {
  const at = parent.children.indexOf(child);
  if (at >= 0) parent.children.splice(at, 1);
  child.parent = null;
  const writer = parent.container.writer;
  writer.remove(parent.id, child.id);
  writer.destroy(child.id);
  releaseSubtree(child);
}

/** The root view of `container`. */
function rootOf(container: GpuiContainer): GpuiNode {
  const root = container.root;
  if (!root) throw new Error("denext/gpui: the container has no root view");
  return root;
}

/** React's context object for `useFormStatus` (no forms here; never provided). */
const HOST_TRANSITION_CONTEXT = {
  $$typeof: Symbol.for("react.context"),
  _currentValue: null,
  _currentValue2: null,
  _threadCount: 0,
  Provider: null,
  Consumer: null,
};

/** The mutation methods. */
const mutation = {
  appendInitialChild: (parent: GpuiNode, child: GpuiNode) => attach(parent, child, null),
  appendChild: (parent: GpuiNode, child: GpuiNode) => attach(parent, child, null),
  appendChildToContainer: (c: GpuiContainer, child: GpuiNode) => attach(rootOf(c), child, null),
  insertBefore: (parent: GpuiNode, child: GpuiNode, before: GpuiNode) =>
    attach(parent, child, before),
  insertInContainerBefore: (c: GpuiContainer, child: GpuiNode, before: GpuiNode) =>
    attach(rootOf(c), child, before),
  removeChild: (parent: GpuiNode, child: GpuiNode) => detach(parent, child),
  removeChildFromContainer: (c: GpuiContainer, child: GpuiNode) => detach(rootOf(c), child),
  clearContainer(c: GpuiContainer): void {
    const root = rootOf(c);
    for (const child of [...root.children]) detach(root, child);
  },
  commitTextUpdate(node: GpuiNode, _old: string, text: string): void {
    node.text = text;
    node.container.writer.setText(node.id, text);
  },
  /** React 19: `(instance, type, oldProps, newProps)`; React 18: `(instance, payload, type, …)`. */
  commitUpdate(node: GpuiNode, ...args: unknown[]): void {
    const newProps = (typeof args[0] === "string" ? args[2] : args[3]) as Props;
    applyProps(node, newProps);
  },
  /** React 18's update payload: always diff in `commitUpdate`. */
  prepareUpdate: () => true,
  hideInstance: (node: GpuiNode) => setHidden(node, true),
  unhideInstance: (node: GpuiNode) => setHidden(node, false),
  hideTextInstance(node: GpuiNode): void {
    node.container.writer.setText(node.id, "");
  },
  unhideTextInstance(node: GpuiNode, text: string): void {
    node.text = text;
    node.container.writer.setText(node.id, text);
  },
  resetTextContent(): void {},
  commitMount(): void {},
};

/** Creating instances. */
const creation = {
  createInstance(type: string, props: Props, container: GpuiContainer): GpuiNode {
    const node = createNode(container, kindOf(type));
    applyProps(node, props);
    return node;
  },
  createTextInstance(text: string, container: GpuiContainer, context: HostContext): GpuiNode {
    if (!context.inText) {
      throw new Error(
        `denext/gpui: text strings must be rendered within a <Text> component ("${text}")`,
      );
    }
    const node = createNode(container, KIND.RawText);
    node.text = text;
    container.writer.setText(node.id, text);
    return node;
  },
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  getRootHostContext: () => OUTSIDE_TEXT,
  getChildHostContext: (_parent: HostContext, type: string) =>
    type === "Text" || type === "TextInput" ? INSIDE_TEXT : OUTSIDE_TEXT,
  getPublicInstance: (node: GpuiNode) => node,
};

/** Committing, scheduling and React 19's suspense / form hooks. */
const lifecycle = {
  prepareForCommit: () => null,
  resetAfterCommit: (container: GpuiContainer) => container.commit(),
  preparePortalMount(): void {},
  scheduleTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
  cancelTimeout: (id: number) => clearTimeout(id),
  noTimeout: -1,
  supportsMicrotasks: true,
  scheduleMicrotask: (fn: () => void) => queueMicrotask(fn),
  getCurrentEventPriority: resolveUpdatePriority,
  getCurrentUpdatePriority: currentUpdatePriority,
  setCurrentUpdatePriority,
  resolveUpdatePriority,
  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur(): void {},
  afterActiveInstanceBlur(): void {},
  prepareScopeUpdate(): void {},
  getInstanceFromScope: () => null,
  detachDeletedInstance(): void {},
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit(): void {},
  suspendInstance(): void {},
  waitForCommitToBeReady: () => null,
  NotPendingTransition: null,
  HostTransitionContext: HOST_TRANSITION_CONTEXT,
  resetFormInstance(): void {},
  requestPostPaintCallback(): void {},
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent(): void {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
};

/** The host config's shape: what `react-reconciler`'s factory is given. */
export type GpuiHostConfig =
  & typeof mutation
  & typeof creation
  & typeof lifecycle
  & {
    /** Mutation mode (the native tree is mutated in place). */
    readonly supportsMutation: true;
    /** No persistent mode. */
    readonly supportsPersistence: false;
    /** Nothing to hydrate. */
    readonly supportsHydration: false;
    /** A secondary renderer: context values live in `_currentValue2` (react-internals.ts). */
    readonly isPrimaryRenderer: false;
    /** No `act()` warnings. */
    readonly warnsIfNotActing: false;
    /** React DevTools' renderer name. */
    readonly rendererPackageName: string;
    /** React DevTools' renderer version. */
    readonly rendererVersion: string;
  };

/** The host config (one for every window: each call names its container). */
export const hostConfig: GpuiHostConfig = {
  ...mutation,
  ...creation,
  ...lifecycle,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: false,
  warnsIfNotActing: false,
  rendererPackageName: "denext/gpui",
  rendererVersion: "1",
};
