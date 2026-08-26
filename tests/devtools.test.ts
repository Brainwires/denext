// React DevTools bridge: renderer registration with a mock global hook and the
// shape of the fiber tree reported on commit. (The live extension UI can't run
// in a headless test; this covers the registration + fiber-mapping logic.)

import { assert, assertEquals } from "@std/assert";
import {
  _resetDevTools,
  commitToDevTools,
  type DevNode,
  injectDevTools,
  setInspectorBridge,
} from "../src/client/devtools.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useState } from "../src/runtime/hooks.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function withMockHook(
  run: (calls: { commits: Any[]; injected: Any[] }) => void,
  opts: { inject?: boolean } = {},
) {
  const g = globalThis as Any;
  const prev = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const commits: Any[] = [];
  const injected: Any[] = [];
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    inject: opts.inject === false ? undefined : (r: unknown) => {
      injected.push(r);
      return 1;
    },
    onCommitFiberRoot: (_id: number, root: Any) => commits.push(root),
  };
  _resetDevTools();
  try {
    run({ commits, injected });
  } finally {
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = prev;
    _resetDevTools();
  }
}

const app: DevNode = {
  id: 1,
  kind: "component",
  name: "App",
  key: null,
  props: {},
  dom: null,
  children: [
    {
      id: 2,
      kind: "host",
      name: "div",
      key: null,
      props: { class: "wrap" },
      dom: { nodeName: "DIV" },
      children: [
        {
          id: 3,
          kind: "text",
          name: "text",
          key: null,
          props: {},
          text: "hi",
          dom: {},
          children: [],
        },
      ],
    },
  ],
};

Deno.test("injectDevTools registers a renderer when the hook is present", () => {
  withMockHook(() => {
    assertEquals(injectDevTools(), true);
    assertEquals(injectDevTools(), true); // idempotent
  });
});

Deno.test("injectDevTools reports bundleType honestly (prod=0, dev=1)", () => {
  const g = globalThis as Any;
  // Production build (no __denextDev): bundleType 0.
  const prevDev = g.__denextDev;
  delete g.__denextDev;
  try {
    withMockHook(({ injected }) => {
      injectDevTools();
      assertEquals(injected.length, 1);
      assertEquals(injected[0].bundleType, 0);
    });
    // Dev build: bundleType 1.
    g.__denextDev = true;
    withMockHook(({ injected }) => {
      injectDevTools();
      assertEquals(injected[0].bundleType, 1);
    });
  } finally {
    if (prevDev === undefined) delete g.__denextDev;
    else g.__denextDev = prevDev;
  }
});

Deno.test("injectDevTools no-ops (false) when the extension is absent", () => {
  const g = globalThis as Any;
  const prev = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  _resetDevTools();
  try {
    assertEquals(injectDevTools(), false);
  } finally {
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = prev;
    _resetDevTools();
  }
});

Deno.test("commitToDevTools reports a walkable HostRoot fiber tree", () => {
  withMockHook(({ commits }) => {
    injectDevTools();
    commitToDevTools(app);
    assertEquals(commits.length, 1);
    const root = commits[0];
    // FiberRoot → HostRoot (tag 3) → App (FunctionComponent, tag 0).
    assertEquals(root.current.tag, 3);
    const appFiber = root.current.child;
    assertEquals(appFiber.tag, 0);
    assertEquals(appFiber.type.name, "App");
    // App → div (HostComponent, tag 5) with its DOM as stateNode.
    const div = appFiber.child;
    assertEquals(div.tag, 5);
    assertEquals(div.type, "div");
    assertEquals((div.stateNode as Any).nodeName, "DIV");
    // div → text (HostText, tag 6); memoizedProps is the string.
    assertEquals(div.child.tag, 6);
    assertEquals(div.child.memoizedProps, "hi");
    // Each synthetic fiber carries the inspector id (threaded for RD edits).
    assertEquals(appFiber.__dnxId, 1);
    assertEquals(div.__dnxId, 2);
  });
});

Deno.test("bridge: findFiberByHostInstance resolves a host DOM to its synthetic fiber", () => {
  withMockHook(({ injected }) => {
    injectDevTools();
    commitToDevTools(app); // builds the host→fiber map for this commit
    const r = injected[0];
    const divNode = app.children[0];
    const fiber = r.findFiberByHostInstance(divNode.dom);
    assert(fiber, "resolved a fiber for the host DOM");
    assertEquals(fiber.type, "div");
    assertEquals(fiber.__dnxId, divNode.id);
    assertEquals(r.findFiberByHostInstance(null), null);
    assertEquals(r.findFiberByHostInstance({ notMapped: true }), null);
  });
});

Deno.test("bridge: RD prop/state edits route through the injected inspector bridge", () => {
  withMockHook(({ injected }) => {
    injectDevTools();
    const calls: string[] = [];
    setInspectorBridge({
      setHookState: (id, i, v) => {
        calls.push(`hook:${id}:${i}:${v}`);
        return true;
      },
      setPropOverride: (id, k, v) => {
        calls.push(`prop:${id}:${k}:${v}`);
        return true;
      },
    });
    const r = injected[0];
    r.overrideProps({ __dnxId: 7 }, ["name"], "x"); // top-level prop → routed
    r.overrideHookState({ __dnxId: 7 }, 0, [], 42); // top-level state → routed
    // Ignored: nested path, and an unresolved (-1) id.
    r.overrideProps({ __dnxId: 7 }, ["a", "b"], "y");
    r.overrideProps({ __dnxId: -1 }, ["name"], "z");
    r.overrideHookState({ __dnxId: 7 }, 1, ["deep"], 9);
    assertEquals(calls, ["prop:7:name:x", "hook:7:0:42"]);
    setInspectorBridge(null); // a cleared bridge makes the stubs inert again
    r.overrideProps({ __dnxId: 7 }, ["name"], "x2");
    assertEquals(calls.length, 2);
  });
});

Deno.test("commitToDevTools(null) reports an empty root without throwing", () => {
  withMockHook(({ commits }) => {
    injectDevTools();
    commitToDevTools(null);
    assertEquals(commits.length, 1);
    assertEquals(commits[0].current.child, null);
  });
});

Deno.test("commitToDevTools no-ops before injection", () => {
  withMockHook(({ commits }) => {
    commitToDevTools(app); // not injected yet
    assertEquals(commits.length, 0);
  });
});

Deno.test("the reconciler reports commits to DevTools end-to-end", () => {
  withMockHook(({ commits }) => {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    function Counter(): Any {
      const [n, setN] = useState(0);
      return h("button", { onClick: () => setN(n + 1) }, String(n));
    }
    const root = createRoot(container as Any);
    root.render(h(Counter, null));

    // Initial mount reported a tree: HostRoot → Counter → button → "0".
    assert(commits.length >= 1, "a commit should be reported on mount");
    const counter = commits.at(-1).current.child;
    assertEquals(counter.type.name, "Counter");
    assertEquals(counter.child.type, "button");
    assertEquals(counter.child.child.memoizedProps, "0");

    // A state update flushes a new commit reflecting the new text.
    (container.childNodes[0] as Any).dispatch("click");
    flushSync();
    assertEquals(commits.at(-1).current.child.child.child.memoizedProps, "1");
    root.unmount();
  });
});

Deno.test("a throwing DevTools hook never propagates to the caller", () => {
  const g = globalThis as Any;
  const prev = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    inject: () => 1,
    onCommitFiberRoot: () => {
      throw new Error("boom");
    },
  };
  _resetDevTools();
  try {
    injectDevTools();
    commitToDevTools(app); // must not throw
    assert(true);
  } finally {
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = prev;
    _resetDevTools();
  }
});
