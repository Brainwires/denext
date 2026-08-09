// React DevTools bridge: renderer registration with a mock global hook and the
// shape of the fiber tree reported on commit. (The live extension UI can't run
// in a headless test; this covers the registration + fiber-mapping logic.)

import { assert, assertEquals } from "@std/assert";
import {
  _resetDevTools,
  commitToDevTools,
  type DevNode,
  injectDevTools,
} from "../src/client/devtools.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useState } from "../src/runtime/hooks.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function withMockHook(run: (calls: { commits: Any[] }) => void, opts: { inject?: boolean } = {}) {
  const g = globalThis as Any;
  const prev = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const commits: Any[] = [];
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    inject: opts.inject === false ? undefined : (_r: unknown) => 1,
    onCommitFiberRoot: (_id: number, root: Any) => commits.push(root),
  };
  _resetDevTools();
  try {
    run({ commits });
  } finally {
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = prev;
    _resetDevTools();
  }
}

const app: DevNode = {
  kind: "component",
  name: "App",
  key: null,
  props: {},
  dom: null,
  children: [
    {
      kind: "host",
      name: "div",
      key: null,
      props: { class: "wrap" },
      dom: { nodeName: "DIV" },
      children: [
        { kind: "text", name: "text", key: null, props: {}, text: "hi", dom: {}, children: [] },
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
