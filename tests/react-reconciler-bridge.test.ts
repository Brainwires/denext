// Context and class components across a `react-reconciler` renderer, against the REAL
// `react-reconciler` 0.31 (what react-konva 19, react-three-fiber 9 and React Native Skia build
// on) and its-fine 2 (the fiber walk react-three-fiber's <Canvas> and react-konva's <Stage> bridge
// contexts with), both loaded with their `require("react")` pointed at denext's `react`.
//
// The foreign renderer here is a minimal host config over plain objects, mounted the way
// react-konva's <Stage> mounts its root: `<FiberProvider>` around a component that calls
// `useContextBridge()` and, in a layout effect, renders `<Bridge>{children}</Bridge>` into its own
// container. Every scenario runs on both the production and the development build of the
// reconciler (`denext build` loads the first, `denext dev` the second).
//
// What each test pins:
//   - a provider in the denext tree above the root reaches `useContext` inside it, and a new
//     value re-renders the consumer there (its-fine walks denext's fiber tree from
//     `this._reactInternals` and re-provides each context's value in the foreign root);
//   - a provider inside the foreign tree, `use(context)` and `<Context.Consumer>` work there (a
//     denext context gets a React-shaped twin the foreign renderer provides and reads);
//   - its-fine's own fiber context is not carried into the root (`useFiber()` inside it finds the
//     foreign fiber, as on React);
//   - a class component inside mounts, updates through `setState` / `forceUpdate` and unmounts
//     with its lifecycles (its `setState` goes to the foreign renderer's updater);
//   - the same host component server-renders (no fiber there: `_reactInternals` is undefined).

import "./helpers/class-runtime.ts";
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import * as React from "../src/compat/react.ts";
import { jsx } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { render } from "../src/testing/mod.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any -- the loaded CommonJS modules are untyped.
type Any = any;

// The packages come from the npm registry as tarballs pinned by their published integrity, NOT
// through `npm:` imports: those would add them to the framework's lock and re-resolve the `react`
// peer the lock shares with react-native-web.
const PACKAGES = {
  "react-reconciler": {
    version: "0.31.0",
    integrity:
      "sha512-7Ob7Z+URmesIsIVRjnLoDGwBEG/tVitidU0nMsqX/eeJaLY89RISO/10ERe0MqmzuKUUB1rmY+h1itMbUHg9BQ==",
  },
  "its-fine": {
    version: "2.0.0",
    integrity:
      "sha512-KLViCmWx94zOvpLwSlsx6yOCeMhZYaxrJV87Po5k/FoZzcPSahvK5qJ7fYhS61sZi5ikmh2S3Hz55A2l3U69ng==",
  },
  scheduler: {
    version: "0.25.0",
    integrity:
      "sha512-xFVuu11jh+xcO7JOAGJNOXld8/TcEHK/4CituBUeUb5hqxJLj9YuemAEuvm9gQ/+pgXYfbQuqAkiYu+u7YEsNA==",
  },
} as const;

/** A package's files (`package/…` paths in the tarball, without that prefix), integrity-checked. */
async function fetchPackage(name: keyof typeof PACKAGES): Promise<Map<string, string>> {
  const { version, integrity } = PACKAGES[name];
  const url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const tgz = new Uint8Array(await res.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", tgz));
  assertEquals(`sha512-${encodeBase64(digest)}`, integrity, `${url}: integrity mismatch`);
  const tar = new Uint8Array(
    await new Response(new Blob([tgz]).stream().pipeThrough(new DecompressionStream("gzip")))
      .arrayBuffer(),
  );
  // ustar: a 512-byte header (name 0..100, size in octal at 124, prefix 345..500), then the data
  // padded to 512 bytes.
  const files = new Map<string, string>();
  const text = new TextDecoder();
  const field = (at: number, len: number) =>
    text.decode(tar.subarray(at, at + len)).replace(/\0.*$/s, "");
  for (let at = 0; at + 512 <= tar.length && tar[at] !== 0;) {
    const prefix = field(at + 345, 155);
    const path = (prefix ? `${prefix}/` : "") + field(at, 100);
    const size = parseInt(field(at + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(tar[at + 156]);
    if (type === "0" || type === "\0") {
      files.set(path.replace(/^[^/]+\//, ""), text.decode(tar.subarray(at + 512, at + 512 + size)));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const SOURCES = {
  reconciler: await fetchPackage("react-reconciler"),
  itsFine: await fetchPackage("its-fine"),
  scheduler: await fetchPackage("scheduler"),
};

/**
 * Evaluate one CommonJS file with `require("react")` as denext's `react` (an app's import map
 * does the same for npm code in a build).
 */
function loadCommonJs(
  source: string | undefined,
  env: "production" | "development",
  deps: Record<string, unknown> = {},
): Any {
  if (source === undefined) throw new Error("missing file in the package");
  const module = { exports: {} as Any };
  const require = (id: string): unknown => {
    if (id === "react") return React;
    if (id in deps) return deps[id];
    throw new Error(`unexpected require("${id}")`);
  };
  new Function("module", "exports", "require", "process", source)(
    module,
    module.exports,
    require,
    { env: { NODE_ENV: env } },
  );
  return module.exports;
}

/** A node of the foreign renderer's host tree. */
interface HostNode {
  type: string;
  props: Record<string, unknown>;
  children: HostNode[];
  text?: string;
}

/** The text a host tree shows. */
function textOf(node: HostNode): string {
  return node.text ?? node.children.map(textOf).join("");
}

/** A mutation host config over {@link HostNode}s (react-reconciler 0.31's required members). */
function hostConfig(): Record<string, unknown> {
  let priority = 0;
  const insert = (parent: HostNode, child: HostNode, before?: HostNode) => {
    const at = before ? parent.children.indexOf(before) : -1;
    if (at < 0) parent.children.push(child);
    else parent.children.splice(at, 0, child);
  };
  const remove = (parent: HostNode, child: HostNode) =>
    void parent.children.splice(parent.children.indexOf(child), 1);
  const none = () => {};
  return {
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    isPrimaryRenderer: false,
    warnsIfNotActing: false,
    noTimeout: -1,
    scheduleTimeout: setTimeout,
    cancelTimeout: clearTimeout,
    supportsMicrotasks: true,
    scheduleMicrotask: queueMicrotask,
    NotPendingTransition: null,
    createInstance: (type: string, props: HostNode["props"]): HostNode => ({
      type,
      props,
      children: [],
    }),
    createTextInstance: (text: string): HostNode => ({
      type: "#text",
      props: {},
      children: [],
      text,
    }),
    appendInitialChild: insert,
    appendChild: insert,
    appendChildToContainer: insert,
    insertBefore: insert,
    insertInContainerBefore: insert,
    removeChild: remove,
    removeChildFromContainer: remove,
    commitUpdate: (node: HostNode, _type: string, _old: unknown, props: HostNode["props"]) => {
      node.props = props;
    },
    commitTextUpdate: (node: HostNode, _old: string, text: string) => {
      node.text = text;
    },
    clearContainer: (node: HostNode) => void (node.children.length = 0),
    finalizeInitialChildren: () => false,
    shouldSetTextContent: () => false,
    getRootHostContext: () => ({}),
    getChildHostContext: (parent: unknown) => parent,
    getPublicInstance: (node: HostNode) => node,
    prepareForCommit: () => null,
    resetAfterCommit: none,
    preparePortalMount: none,
    detachDeletedInstance: none,
    getCurrentEventPriority: () => 32,
    setCurrentUpdatePriority: (p: number) => void (priority = p),
    getCurrentUpdatePriority: () => priority,
    resolveUpdatePriority: () => priority || 32,
    shouldAttemptEagerTransition: () => false,
    requestPostPaintCallback: none,
    maySuspendCommit: () => false,
    preloadInstance: () => true,
    startSuspendingCommit: none,
    suspendInstance: none,
    waitForCommitToBeReady: () => null,
    resetFormInstance: none,
    hideInstance: none,
    unhideInstance: none,
    hideTextInstance: none,
    unhideTextInstance: none,
    trackSchedulerEvent: none,
    resolveEventType: () => null,
    resolveEventTimeStamp: () => -1.1,
  };
}

/** One build of the renderer, its-fine, and a react-konva-style `<Stage>` over them. */
function setup(env: "production" | "development") {
  const scheduler = loadCommonJs(SOURCES.scheduler.get(`cjs/scheduler.${env}.js`), env);
  const createReconciler = loadCommonJs(
    SOURCES.reconciler.get(`cjs/react-reconciler.${env}.js`),
    env,
    { scheduler },
  );
  const itsFine = loadCommonJs(SOURCES.itsFine.get("dist/index.cjs"), env);
  const renderer = createReconciler(hostConfig());
  const errors: unknown[] = [];
  const onError = (error: unknown) => void errors.push(error);

  /** Render `element` into `root` synchronously. */
  const update = (element: unknown, root: unknown) => {
    renderer.updateContainerSync(element, root, null, null);
    renderer.flushSyncWork();
  };

  /** A root of the foreign renderer in `out` (React's ConcurrentRoot, as react-konva's). */
  const createRoot = (out: HostNode) =>
    renderer.createContainer(out, 1, null, false, null, "", onError, onError, onError, null);

  /** react-konva's StageWrap: bridge the contexts above into a root of its own. */
  function StageWrap(props: { out: HostNode; children?: unknown }): VNode {
    const Bridge = itsFine.useContextBridge();
    const root = React.useRef<unknown>(null);
    React.useLayoutEffect(() => {
      root.current = createRoot(props.out);
      return () => update(null, root.current);
    }, []);
    React.useLayoutEffect(() => {
      update(jsx(Bridge, { children: props.children as VNode }), root.current);
    });
    return jsx("canvas", {});
  }
  /** react-konva's Stage: `<FiberProvider>` around the bridging component. */
  const Stage = (props: { out: HostNode; children?: unknown }): VNode =>
    jsx(itsFine.FiberProvider, { children: jsx(StageWrap, props as never) });

  return { itsFine, errors, update, createRoot, Stage };
}

const ENVS = ["production", "development"] as const;

/** A fresh host container. */
const container = (): HostNode => ({ type: "root", props: {}, children: [] });

const Theme = React.createContext("light");

/** Reads `Theme` with `useContext` inside the foreign tree. */
function ThemeLabel(): VNode {
  return jsx("label", { children: `theme:${React.useContext(Theme)}` });
}

for (const env of ENVS) {
  Deno.test(`react-reconciler (${env}): a provider above the root reaches useContext inside it`, async () => {
    const { Stage, errors } = setup(env);
    const out = container();
    const screen = await render(
      jsx(Theme, { value: "dark", children: jsx(Stage, { out, children: jsx(ThemeLabel, {}) }) }),
    );
    assertEquals(textOf(out), "theme:dark");
    await screen.unmount();
    assertEquals(out.children, []);
    assertEquals(errors, []);
  });

  Deno.test(`react-reconciler (${env}): a new provider value re-renders the consumer inside`, async () => {
    const { Stage, errors } = setup(env);
    const out = container();
    let setTheme!: (theme: string) => void;
    // The Stage sits below a memoized component that never re-renders on its own: the update
    // reaches the root through the context the bridge reads.
    const Frame = React.memo(() => jsx(Stage, { out, children: jsx(ThemeLabel, {}) }));
    function App(): VNode {
      const [theme, set] = React.useState("dark");
      setTheme = set;
      return jsx(Theme, { value: theme, children: jsx(Frame, {}) });
    }
    const screen = await render(jsx(App, {}));
    assertEquals(textOf(out), "theme:dark");
    await screen.act(() => setTheme("contrast"));
    assertEquals(textOf(out), "theme:contrast");
    await screen.unmount();
    assertEquals(errors, []);
  });

  Deno.test(`react-reconciler (${env}): a provider, use() and a Consumer inside the tree`, () => {
    const { createRoot, update, errors } = setup(env);
    const out = container();
    const root = createRoot(out);
    const Size = React.createContext(0);
    function Reader(): VNode {
      return jsx("label", { children: `${React.useContext(Theme)}/${React.use(Size)}` });
    }
    const consumer = jsx(Size.Consumer, {
      children: ((size: number) => jsx("label", { children: `size:${size}` })) as Any,
    });
    const tree = (size: number) =>
      jsx(Theme, {
        value: "inner",
        children: jsx(Size.Provider, { value: size, children: [jsx(Reader, {}), consumer] }),
      });
    update(tree(2), root);
    assertEquals(textOf(out), "inner/2size:2");
    update(tree(3), root);
    assertEquals(textOf(out), "inner/3size:3");
    // No provider: the default, as before.
    update(jsx(Reader, {}), root);
    assertEquals(textOf(out), "light/0");
    update(null, root);
    assertEquals(errors, []);
  });

  Deno.test(`react-reconciler (${env}): its-fine's fiber context stays out of the root`, async () => {
    const { Stage, itsFine, errors } = setup(env);
    const out = container();
    let fiber: Any;
    function Inner(): VNode {
      fiber = itsFine.useFiber();
      return jsx("label", { children: "inner" });
    }
    const screen = await render(jsx(Stage, { out, children: jsx(Inner, {}) }));
    assertEquals(textOf(out), "inner");
    // The foreign renderer's own fiber (React's numeric tag), not the denext tree's view.
    assertEquals(typeof fiber?.tag, "number");
    await screen.unmount();
    assertEquals(errors, []);
  });

  Deno.test(`react-reconciler (${env}): a class component mounts, updates and unmounts inside`, async () => {
    const { Stage, errors } = setup(env);
    const out = container();
    const log: string[] = [];
    let counter!: Counter;
    class Counter extends React.Component<{ step: number }, { n: number }> {
      override state = { n: 0 };
      componentDidMount() {
        counter = this;
        log.push(`didMount ${this.state.n}`);
      }
      componentDidUpdate(prev: { step: number }, prevState: { n: number }) {
        log.push(`didUpdate ${prevState.n}->${this.state.n} step ${prev.step}->${this.props.step}`);
      }
      componentWillUnmount() {
        log.push("willUnmount");
      }
      override render(): VNode {
        return jsx("label", { children: `n:${this.state.n} step:${this.props.step}` });
      }
    }
    let setStep!: (step: number) => void;
    function App(): VNode {
      const [step, set] = React.useState(1);
      setStep = set;
      return jsx(Stage, { out, children: jsx(Counter as Any, { step }) });
    }
    const screen = await render(jsx(App, {}));
    assertEquals(textOf(out), "n:0 step:1");
    // setState from outside a render goes to the foreign renderer's updater.
    await screen.act(() => counter.setState(({ n }) => ({ n: n + 2 }), () => log.push("callback")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(textOf(out), "n:2 step:1");
    // New props from the denext tree.
    await screen.act(() => setStep(5));
    assertEquals(textOf(out), "n:2 step:5");
    await screen.act(() => counter.forceUpdate());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await screen.unmount();
    assertEquals(log, [
      "didMount 0",
      "didUpdate 0->2 step 1->1",
      "callback",
      "didUpdate 2->2 step 1->5",
      "didUpdate 2->2 step 5->5",
      "willUnmount",
    ]);
    assertEquals(errors, []);
  });
}

Deno.test("react-reconciler: a function component's view lists its hooks", async () => {
  let fiber: Any;
  class Root extends React.Component {
    override render(): VNode {
      fiber = (this as Any)._reactInternals;
      return jsx(Hooks, {});
    }
  }
  function Hooks(): VNode {
    React.useRef("first");
    const id = React.useId();
    return jsx("i", { children: id });
  }
  const screen = await render(jsx(Root as Any, {}));
  const hooks = fiber.child.memoizedState;
  assertEquals(hooks.memoizedState, { current: "first" });
  assertEquals(typeof hooks.next.memoizedState, "string"); // useId's id, what its-fine looks for
  assertEquals(hooks.next.next, null);
  await screen.unmount();
});

Deno.test("react-reconciler: setState on a class instance nothing mounted is dropped", () => {
  class Idle extends React.Component<Record<string, never>, { n: number }> {}
  const idle = new Idle({});
  idle.setState({ n: 1 });
  idle.forceUpdate();
  assertEquals(idle.state, undefined);
});

Deno.test("react-reconciler: the bridging host component server-renders", async () => {
  const { Stage } = setup("production");
  const html = await renderToString(
    jsx(Theme, { value: "dark", children: jsx(Stage, { out: container(), children: "x" }) }),
  );
  assertEquals(html, "<canvas></canvas>");
});

Deno.test("react-reconciler: a denext class instance shows React its fiber", async () => {
  let instance!: Any;
  class Probe extends React.Component {
    override render(): VNode {
      instance = this;
      return jsx(Theme, { value: "x", children: jsx("i", {}) });
    }
  }
  const screen = await render(jsx(Probe as Any, { key: "probe", n: 1 }));
  const fiber = instance._reactInternals;
  assertStrictEquals(fiber, instance._reactInternals); // one view per fiber
  assertStrictEquals(fiber.type, Probe);
  assertStrictEquals(fiber.elementType, Probe);
  assertEquals(fiber.key, "probe");
  assertEquals(fiber.memoizedProps.n, 1);
  assertStrictEquals(fiber.pendingProps, fiber.memoizedProps);
  assertStrictEquals(fiber.stateNode, instance);
  assertStrictEquals(fiber.memoizedState, instance.state); // a class's state
  assertEquals(fiber.sibling, null);
  // A provider's type is its context's React twin, a provider element type for the renderer.
  const provider = fiber.child;
  assertEquals(provider.type.$$typeof, Symbol.for("react.context"));
  assertStrictEquals(provider.type.Provider, provider.type);
  assertEquals(provider.type._currentValue2, "light");
  assertStrictEquals(provider.child.return, provider);
  assert(provider.return === fiber);
  // The root shows its container as React's does (its-fine's useContainer reads it).
  let root = fiber;
  while (root.return) root = root.return;
  assertStrictEquals(root.stateNode.containerInfo, screen.container);
  await screen.unmount();
});
