/**
 * Mounting React into a window's native tree: {@linkcode gpuiSupport} probes the runtime,
 * {@linkcode render} creates (or updates) a window's root, and {@linkcode AppRegistry} is React
 * Native's entry point over the same.
 *
 * The native tree needs denext's Deno Desktop runtime on the `gpui` backend: `Deno.desktop`
 * present, `Deno.desktop.windowCapabilities().nativeTree` reporting `{ version }` of this
 * format, and the window's `nativeTree.commit`. Anywhere else (stock Deno, a web view backend, an
 * older runtime) {@linkcode render} throws a {@linkcode GpuiUnsupportedError} saying which part is
 * missing.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNodeType } from "../jsx/types.ts";
import type { ContainerOptions, GpuiContainer, NativeTreeWindow } from "./container.ts";
import { dispatchNativeTreeEvent, NATIVE_TREE_EVENT, parseNativeTreeEvent } from "./events.ts";
import { createGpuiContainer, hostConfig } from "./host-config.ts";
import { NTB_VERSION } from "./props.generated.ts";

/** The slice of a `react-reconciler` renderer `denext/gpui` drives. */
export interface ReactReconcilerInstance {
  /** `createContainer(containerInfo, tag, …)`: a new fiber root. */
  createContainer(...args: unknown[]): unknown;
  /** Render `element` into the root (`null` unmounts). */
  updateContainer(
    element: unknown,
    root: unknown,
    parentComponent: unknown,
    callback: (() => void) | null,
  ): unknown;
  /** React 19: render synchronously. */
  updateContainerSync?(
    element: unknown,
    root: unknown,
    parentComponent: unknown,
    callback: (() => void) | null,
  ): unknown;
  /** React 19: flush the synchronous work queued. */
  flushSyncWork?(): unknown;
}

/**
 * `react-reconciler`'s default export: builds a renderer from a host config (`any`: the app's
 * `react-reconciler` types its own `HostConfig`).
 */
// deno-lint-ignore no-explicit-any
export type ReactReconcilerFactory = (hostConfig: any) => ReactReconcilerInstance;

/** The slice of `Deno.desktop` the probe reads. */
export interface GpuiDesktopApi {
  /** What window features this backend supports (`nativeTree: { version }` on `gpui`). */
  windowCapabilities?(): Record<string, unknown>;
}

/** What {@linkcode gpuiSupport} found. */
export type GpuiSupport =
  | {
    /** The native tree is there. */
    readonly supported: true;
    /** The batch format version the backend reports. */
    readonly version: number;
  }
  | {
    /** It is not. */
    readonly supported: false;
    /** Which part is missing, and what to do. */
    readonly reason: string;
  };

/** The runtime or window has no native tree (`code: "unsupported"`). */
export class GpuiUnsupportedError extends Error {
  /** Always `"unsupported"`. */
  readonly code = "unsupported" as const;

  /**
   * An error saying the native tree is unsupported, and why.
   *
   * @param reason Which part is missing.
   */
  constructor(reason: string) {
    super(`denext/gpui: unsupported: ${reason}`);
    this.name = "GpuiUnsupportedError";
  }
}

/** `Deno.desktop`, when the runtime has it. */
function runtimeDesktop(): GpuiDesktopApi | undefined {
  return (globalThis.Deno as unknown as { desktop?: GpuiDesktopApi } | undefined)?.desktop;
}

/** The native tree version `windowCapabilities()` reports, or why there is none. */
function reportedVersion(desktop: GpuiDesktopApi): number | string {
  if (typeof desktop.windowCapabilities !== "function") {
    return "Deno.desktop.windowCapabilities() is missing (the runtime predates the native tree)";
  }
  let caps: Record<string, unknown> | undefined;
  try {
    caps = desktop.windowCapabilities();
  } catch (error) {
    return `Deno.desktop.windowCapabilities() threw: ${error}`;
  }
  const version = (caps?.nativeTree as { version?: unknown } | undefined)?.version;
  if (typeof version === "number") return version;
  return 'this backend has no native tree (windowCapabilities().nativeTree is unset): set desktop.backend to "gpui"';
}

/**
 * Whether this runtime (and `window`, when given) can host a native tree.
 *
 * @param window The window to render into.
 * @param desktop `Deno.desktop` (default: the runtime's).
 * @returns `{ supported: true, version }`, or `{ supported: false, reason }`.
 *
 * @example
 * ```ts
 * import { gpuiSupport } from "denext/gpui";
 *
 * const support = gpuiSupport();
 * if (!support.supported) console.log(support.reason);
 * ```
 */
export function gpuiSupport(
  window?: NativeTreeWindow,
  desktop: GpuiDesktopApi | undefined = runtimeDesktop(),
): GpuiSupport {
  if (!desktop) {
    return {
      supported: false,
      reason: "Deno.desktop is missing: run the app on denext's Deno Desktop runtime " +
        '(`denext desktop run`, desktop.backend "gpui")',
    };
  }
  const version = reportedVersion(desktop);
  if (typeof version === "string") return { supported: false, reason: version };
  if (version < NTB_VERSION) {
    return {
      supported: false,
      reason: `the backend's native tree is version ${version}; denext/gpui needs ${NTB_VERSION}`,
    };
  }
  if (window && typeof window.nativeTree?.commit !== "function") {
    return { supported: false, reason: "the window has no nativeTree.commit" };
  }
  return { supported: true, version };
}

/** What {@linkcode render} takes. */
export interface GpuiRenderOptions extends ContainerOptions {
  /** The Deno Desktop window to render into. */
  readonly window: NativeTreeWindow;
  /**
   * `react-reconciler`'s default export (0.31, for React 19), loaded against denext's `react`
   * (map `react` to `denext/react` in the app's import map).
   */
  readonly reconciler: ReactReconcilerFactory;
  /** `Deno.desktop` (default: the runtime's; tests pass a fake). */
  readonly desktop?: GpuiDesktopApi;
}

/** A window's mounted React root. */
export interface GpuiRoot {
  /** The window. */
  readonly window: NativeTreeWindow;
  /** Render `element` in place of what the root shows. */
  render(element: unknown): void;
  /** Unmount the tree, clear the window's root view and stop listening for its events. */
  unmount(): void;
}

/** React's `ConcurrentRoot` tag. */
const CONCURRENT_ROOT = 1;

/** One renderer per factory. */
const renderers = new WeakMap<ReactReconcilerFactory, ReactReconcilerInstance>();
/** The mounted root of each window. */
const roots = new Map<NativeTreeWindow, GpuiRoot>();

/** The global flag `Platform.constants.denextShell` reads (src/react-native/platform.ts). */
const GPUI_SHELL: unique symbol = Symbol.for("denext.gpuiShell");

/** Raise or drop the `"gpui"` shell flag as roots come and go. */
function markShell(): void {
  (globalThis as { [GPUI_SHELL]?: boolean })[GPUI_SHELL] = roots.size > 0;
}

/** The renderer `factory` builds over denext's host config (built once). */
function rendererFor(factory: ReactReconcilerFactory): ReactReconcilerInstance {
  let renderer = renderers.get(factory);
  if (!renderer) renderers.set(factory, renderer = factory(hostConfig));
  return renderer;
}

/** Render synchronously where the reconciler can (React 19), else schedule. */
function update(
  renderer: ReactReconcilerInstance,
  element: unknown,
  fiberRoot: unknown,
  done: (() => void) | null = null,
): void {
  if (renderer.updateContainerSync && renderer.flushSyncWork) {
    renderer.updateContainerSync(element, fiberRoot, null, done);
    renderer.flushSyncWork();
  } else renderer.updateContainer(element, fiberRoot, null, done);
}

/** Subscribe `container` to its window's native tree events; returns the unsubscribe. */
function listen(container: GpuiContainer): () => void {
  const listener = (event: Event) => {
    const parsed = parseNativeTreeEvent(event);
    if (parsed) dispatchNativeTreeEvent(container, parsed);
  };
  container.window.addEventListener(NATIVE_TREE_EVENT, listener);
  return () => container.window.removeEventListener?.(NATIVE_TREE_EVENT, listener);
}

/** A new root for `options.window`. */
function createRoot(options: GpuiRenderOptions): GpuiRoot {
  const container = createGpuiContainer(options.window, options);
  const renderer = rendererFor(options.reconciler);
  const report = (error: unknown) => container.reportError(error);
  const fiberRoot = renderer.createContainer(
    container,
    CONCURRENT_ROOT,
    null,
    false,
    null,
    "",
    report,
    report,
    report,
    null,
  );
  const unlisten = listen(container);
  const root: GpuiRoot = {
    window: options.window,
    render: (element) => update(renderer, element, fiberRoot),
    unmount() {
      if (roots.get(options.window) !== root) return;
      roots.delete(options.window);
      markShell();
      unlisten();
      const rootId = container.root?.id ?? 0;
      update(renderer, null, fiberRoot, () =>
        container.commitAside((w) => {
          w.setRoot(0);
          w.destroy(rootId);
        }));
    },
  };
  return root;
}

/**
 * Render `element` into `options.window`'s native tree, or update the root already there (as
 * React DOM's `root.render`). Ops of each React commit go to the host in one batch.
 *
 * @param element The element (made with `h` / JSX).
 * @param options The window and `react-reconciler`.
 * @returns The window's root.
 * @throws {GpuiUnsupportedError} When the runtime or window has no native tree.
 *
 * @example
 * ```ts ignore
 * import createReconciler from "react-reconciler";
 * import { h } from "denext";
 * import { render, Text, View } from "denext/gpui";
 *
 * const win = new Deno.BrowserWindow({ title: "Hello" });
 * render(h(View, { style: { padding: 16 } }, h(Text, null, "Hello")), {
 *   window: win,
 *   reconciler: createReconciler,
 * });
 * ```
 */
export function render(element: unknown, options: GpuiRenderOptions): GpuiRoot {
  const desktop = "desktop" in options ? options.desktop : runtimeDesktop();
  const support = gpuiSupport(options.window, desktop);
  if (!support.supported) throw new GpuiUnsupportedError(support.reason);
  let root = roots.get(options.window);
  if (!root) {
    root = createRoot(options);
    roots.set(options.window, root);
    markShell();
  }
  root.render(element);
  return root;
}

/** What `registerComponent` takes: a function returning the root component. */
export type GpuiComponentProvider = () => VNodeType;

/** What {@linkcode AppRegistry.runApplication} takes. */
export interface GpuiAppParameters extends Omit<GpuiRenderOptions, "window"> {
  /** The window to run the app in (React Native's root tag). */
  readonly rootTag: NativeTreeWindow;
  /** The root component's props. */
  readonly initialProps?: Record<string, unknown>;
}

/** React Native's `AppRegistry`, over native tree windows. */
export interface GpuiAppRegistry {
  /** Register an app's root component under `appKey`. */
  registerComponent(appKey: string, provider: GpuiComponentProvider): string;
  /** The registered app keys. */
  getAppKeys(): string[];
  /** Render the app `appKey` into `parameters.rootTag`. */
  runApplication(appKey: string, parameters: GpuiAppParameters): GpuiRoot;
  /** Unmount whatever runs in `rootTag`. */
  unmountApplicationComponentAtRootTag(rootTag: NativeTreeWindow): void;
}

const apps = new Map<string, GpuiComponentProvider>();

/**
 * React Native's `AppRegistry` for the native tree: `registerComponent` in the app's entry,
 * `runApplication` with the window as the root tag.
 *
 * @example
 * ```ts ignore
 * import createReconciler from "react-reconciler";
 * import { AppRegistry } from "denext/gpui";
 * import App from "./App.ts";
 *
 * AppRegistry.registerComponent("main", () => App);
 * AppRegistry.runApplication("main", {
 *   rootTag: new Deno.BrowserWindow({ title: "App" }),
 *   reconciler: createReconciler,
 * });
 * ```
 */
export const AppRegistry: GpuiAppRegistry = {
  registerComponent(appKey, provider) {
    apps.set(appKey, provider);
    return appKey;
  },
  getAppKeys: () => [...apps.keys()],
  runApplication(appKey, parameters) {
    const provider = apps.get(appKey);
    if (!provider) throw new Error(`denext/gpui: "${appKey}" has not been registered`);
    const { rootTag, initialProps, ...options } = parameters;
    return render(h(provider(), initialProps ?? {}), { ...options, window: rootTag });
  },
  unmountApplicationComponentAtRootTag(rootTag) {
    roots.get(rootTag)?.unmount();
  },
};
