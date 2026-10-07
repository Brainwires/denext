/**
 * React Native's `AppRegistry` for React Native mode: react-native-web's `AppRegistry` with the
 * statics it lacks, added by {@linkcode withAppRegistry} (react-native-web's module is passed
 * through it at build time, src/build/react-native-patches.ts):
 *
 * - sections: `registerSection`, `registerComponent(appKey, provider, section)` and
 *   `registerConfig`'s `section`, `getSectionKeys`, `getSections`;
 * - `getRunnable` / `getRegistry`, each runnable running the app as `runApplication` does;
 * - `setSurfaceProps`, which re-renders a running app with new `initialProps` and keeps its
 *   state (a runnable registered with `registerRunnable` is run again, as in React Native);
 * - `setRootViewStyleProvider`, whose style the app's root view takes;
 * - the headless-task registry: `registerHeadlessTask`, `registerCancellableHeadlessTask`,
 *   `startHeadlessTask` and `cancelHeadlessTask`, with React Native's JavaScript semantics.
 *   Nothing native starts a task here (React Native's Android starts one from a native
 *   service); the app may start one itself, and `denext/mobile`'s `defineBackgroundTask` is
 *   the way to run work in the background.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren, VNodeType } from "../jsx/types.ts";
import { useEffect, useState } from "../runtime/hooks.ts";

/** What React Native's `registerComponent` takes: a function returning the root component. */
type ComponentProvider = () => VNodeType;

/** A runnable: runs the app with `appParameters` (React Native's `Runnable`). */
type Runnable = (appParameters: AppParameters, displayMode?: number) => void;

/** A headless task: called with the task's data, settles when the task is done. */
type Task = (data: unknown) => Promise<void>;

/** What `registerHeadlessTask` takes: a function returning the task. */
type TaskProvider = () => Task;

/** What `registerCancellableHeadlessTask` takes: a function returning the canceller. */
type TaskCancelProvider = () => () => void;

/** The parameters `runApplication` and `setSurfaceProps` take. */
interface AppParameters {
  /** The root component's props. */
  initialProps?: Record<string, unknown>;
  /** The element the app renders into. */
  rootTag?: unknown;
  /** Any other parameter (passed through). */
  [key: string]: unknown;
}

/** One entry of `registerConfig`. */
interface AppConfig {
  /** The app's key. */
  appKey: string;
  /** Its root component's provider (or `run`). */
  component?: ComponentProvider;
  /** A runnable to register instead of a component. */
  run?: Runnable;
  /** Register the component as a section too. */
  section?: boolean;
}

/** What `getRegistry` returns. */
interface Registry {
  /** The section keys. */
  sections: string[];
  /** Every app's runnable, by key. */
  runnables: Record<string, Runnable>;
}

/** react-native-web's `AppRegistry` statics that {@linkcode withAppRegistry} builds on. */
interface WebAppRegistry {
  getAppKeys(): string[];
  registerComponent(appKey: string, provider: ComponentProvider, section?: boolean): string;
  registerRunnable(appKey: string, run: (appParameters: AppParameters) => unknown): string;
  registerConfig(config: AppConfig[]): void;
  runApplication(appKey: string, appParameters: AppParameters): unknown;
  setWrapperComponentProvider(provider: (appParameters: AppParameters) => VNodeType): void;
  [key: string]: unknown;
}

/** The root view's base style, as react-native-web's `AppContainer` draws it. */
const ROOT_STYLE = { flex: 1, pointerEvents: "box-none" };

/** The message React Native throws for an app key nobody registered. */
function notRegistered(appKey: string): Error {
  return new Error(
    `"${appKey}" has not been registered. This can happen if a module failed to load due to ` +
      "an error and `AppRegistry.registerComponent` wasn't called.",
  );
}

/**
 * React Native mode's patch of react-native-web's `AppRegistry` (see the module docs).
 *
 * @param AppRegistry react-native-web's `AppRegistry` class (its statics are added in place).
 * @param View react-native-web's `View`, which draws the root view style.
 * @returns The same `AppRegistry`.
 */
// fallow-ignore-next-line complexity -- one closure per React Native static, each small
export function withAppRegistry<T>(AppRegistry: T, View?: VNodeType): T {
  const reg = AppRegistry as unknown as WebAppRegistry;
  if (
    typeof (AppRegistry as unknown) !== "function" || typeof reg.registerComponent !== "function"
  ) {
    return AppRegistry;
  }
  if (typeof reg.getRunnable === "function") return AppRegistry;

  const webRegisterComponent = reg.registerComponent.bind(reg);
  const webRegisterRunnable = reg.registerRunnable.bind(reg);
  const webRun = reg.runApplication.bind(reg);
  const webSetWrapper = reg.setWrapperComponentProvider.bind(reg);

  const sections = new Set<string>();
  const components = new Set<string>();
  /** Per app: the props `setSurfaceProps` set and the mounted roots listening for them. */
  const surfaces = new Map<
    string,
    { props?: Record<string, unknown>; listeners: Set<() => void> }
  >();
  const runParams = new Map<string, AppParameters>();
  const taskProviders = new Map<string, TaskProvider>();
  const taskCancelProviders = new Map<string, TaskCancelProvider>();
  let wrapperProvider: ((p: AppParameters) => VNodeType) | null = null;
  let rootViewStyleProvider: ((p: AppParameters) => unknown) | null = null;

  const surface = (appKey: string) => {
    let s = surfaces.get(appKey);
    if (!s) surfaces.set(appKey, s = { listeners: new Set() });
    return s;
  };

  /** The root component, reading the props `setSurfaceProps` sets. */
  const surfaceRoot = (appKey: string, Root: VNodeType): VNodeType => {
    const SurfaceRoot = (props: Record<string, unknown>): VNode => {
      const s = surface(appKey);
      const [, rerender] = useState(0);
      useEffect(() => {
        const listener = () => rerender((n) => n + 1);
        s.listeners.add(listener);
        return () => void s.listeners.delete(listener);
      }, [s]);
      return h(Root, s.props ?? props);
    };
    return Object.assign(SurfaceRoot, {
      displayName: (Root as { displayName?: string; name?: string }).displayName ??
        (Root as { name?: string }).name ?? "SurfaceRoot",
    }) as unknown as VNodeType;
  };

  /** The wrapper react-native-web renders around the app: the app's own, in the root style. */
  const wrapper = (appParameters: AppParameters): VNodeType | undefined => {
    const own = wrapperProvider?.(appParameters);
    const style = rootViewStyleProvider?.(appParameters);
    if (style == null || !View) return own;
    const RootView = ({ children }: { children?: VNodeChildren }): VNode =>
      h(View, { style: [ROOT_STYLE, style] }, own ? h(own, null, children) : children);
    return RootView as unknown as VNodeType;
  };
  webSetWrapper(wrapper as (p: AppParameters) => VNodeType);

  const statics: Record<string, unknown> = {
    registerComponent(appKey: string, provider: ComponentProvider, section?: boolean): string {
      components.add(appKey);
      if (section) sections.add(appKey);
      return webRegisterComponent(appKey, () => surfaceRoot(appKey, provider()));
    },
    registerRunnable(appKey: string, run: Runnable): string {
      components.delete(appKey);
      return webRegisterRunnable(appKey, run as (p: AppParameters) => unknown);
    },
    registerSection(appKey: string, provider: ComponentProvider): void {
      (reg.registerComponent as (k: string, p: ComponentProvider, s: boolean) => string)(
        appKey,
        provider,
        true,
      );
    },
    registerConfig(config: AppConfig[]): void {
      for (const app of config) {
        if (app.run) reg.registerRunnable(app.appKey, app.run as (p: AppParameters) => unknown);
        else if (app.component) reg.registerComponent(app.appKey, app.component, app.section);
        else {
          throw new Error(
            "AppRegistry.registerConfig(...): Every config is expected to set either `run` or " +
              `\`component\`, but \`${app.appKey}\` has neither.`,
          );
        }
      }
    },
    runApplication(appKey: string, appParameters: AppParameters): unknown {
      const s = surfaces.get(appKey);
      if (s) s.props = undefined;
      runParams.set(appKey, appParameters);
      return webRun(appKey, appParameters);
    },
    setWrapperComponentProvider(provider: (p: AppParameters) => VNodeType): void {
      wrapperProvider = provider;
    },
    setRootViewStyleProvider(provider: (p: AppParameters) => unknown): void {
      rootViewStyleProvider = provider;
    },
    getSectionKeys(): string[] {
      return [...sections];
    },
    getSections(): Record<string, Runnable> {
      return Object.fromEntries([...sections].map((k) => [k, runnable(k)]));
    },
    getRunnable(appKey: string): Runnable | undefined {
      return reg.getAppKeys().includes(appKey) ? runnable(appKey) : undefined;
    },
    getRegistry(): Registry {
      return {
        sections: [...sections],
        runnables: Object.fromEntries(reg.getAppKeys().map((k) => [k, runnable(k)])),
      };
    },
    setSurfaceProps(appKey: string, appParameters: AppParameters, _displayMode?: number): void {
      if (!reg.getAppKeys().includes(appKey)) throw notRegistered(appKey);
      const ran = runParams.get(appKey);
      const s = surface(appKey);
      // A mounted component app re-renders in place, keeping its state; anything else runs
      // (again), as React Native's runnable does.
      if (components.has(appKey) && ran && s.listeners.size > 0) {
        s.props = appParameters.initialProps ?? {};
        runParams.set(appKey, { ...ran, ...appParameters });
        for (const listener of [...s.listeners]) listener();
        return;
      }
      (reg.runApplication as (k: string, p: AppParameters) => unknown)(appKey, {
        ...ran,
        ...appParameters,
      });
    },
    registerHeadlessTask(taskKey: string, taskProvider: TaskProvider): void {
      (statics.registerCancellableHeadlessTask as (
        k: string,
        p: TaskProvider,
        c: TaskCancelProvider,
      ) => void)(taskKey, taskProvider, () => () => {});
    },
    registerCancellableHeadlessTask(
      taskKey: string,
      taskProvider: TaskProvider,
      taskCancelProvider: TaskCancelProvider,
    ): void {
      if (taskProviders.has(taskKey)) {
        console.warn(
          "registerHeadlessTask or registerCancellableHeadlessTask called multiple times for " +
            `same key '${taskKey}'`,
        );
      }
      taskProviders.set(taskKey, taskProvider);
      taskCancelProviders.set(taskKey, taskCancelProvider);
    },
    startHeadlessTask(_taskId: number, taskKey: string, data: unknown): void {
      const provider = taskProviders.get(taskKey);
      if (!provider) {
        console.warn(`No task registered for key ${taskKey}`);
        return;
      }
      // As in React Native: the task starts now; a rejection is logged.
      Promise.resolve(provider()(data)).catch((reason) => console.error(reason));
    },
    cancelHeadlessTask(_taskId: number, taskKey: string): void {
      const cancel = taskCancelProviders.get(taskKey);
      if (!cancel) throw new Error(`No task canceller registered for key '${taskKey}'`);
      cancel()();
    },
  };

  /** `appKey`'s runnable: `runApplication` with the given parameters. */
  function runnable(appKey: string): Runnable {
    return (appParameters) =>
      void (reg.runApplication as (k: string, p: AppParameters) => unknown)(appKey, appParameters);
  }

  Object.assign(reg, statics);
  return AppRegistry;
}
