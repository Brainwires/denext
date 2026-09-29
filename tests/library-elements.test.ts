// Elements third-party code creates keep React's re-render semantics (src/runtime/library-elements.ts):
// denext's implicit memo (skip a component whose props are shallow-equal) applies to the app's own
// elements; an element from `react-lib` / `jsx-runtime-lib` (what a compat build resolves `react`
// and the JSX runtime to inside node_modules) re-renders whenever its parent does, and is skipped
// only when its parent did not re-render, or when it is a memo().

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { jsx as libJsx } from "../src/jsx/jsx-runtime-lib.ts";
import { cloneElement as libClone, createElement as libCreate } from "../src/compat/react-lib.ts";
import { isLibraryElement } from "../src/runtime/library-elements.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useState } from "../src/runtime/hooks.ts";
import { memo } from "../src/runtime/memo.ts";
import type { VNode, VNodeType } from "../src/jsx/types.ts";
import { type FakeDocument, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asAny = (v: unknown): any => v;

Deno.test("library elements: jsx / createElement / cloneElement record component elements only", () => {
  function C(): VNode {
    return h("i", null);
  }
  assertEquals(isLibraryElement(libJsx(C, { a: 1 })), true);
  assertEquals(isLibraryElement(libCreate(C, { a: 1 })), true);
  assertEquals(isLibraryElement(libClone(h(C, { a: 1 }), { a: 2 })), true);
  assertEquals(isLibraryElement(libJsx("div", {})), false, "host elements are not recorded");
  assertEquals(isLibraryElement(h(C, { a: 1 })), false, "the app's elements are not");
});

/**
 * A parent with state rendering `child` (a factory, so each render makes a new element, as JSX
 * does) next to a sibling with its own state; returns the render counts and the two setters.
 */
function mount(make: (type: VNodeType) => VNode, type: VNodeType) {
  const { doc, container } = makeDom();
  setDocument(asAny(doc as FakeDocument));
  let bumpParent = () => {};
  let bumpSibling = () => {};
  function Sibling(): VNode {
    const [n, setN] = useState(0);
    bumpSibling = () => setN(n + 1);
    return h("b", null, String(n));
  }
  function Parent(): VNode {
    const [n, setN] = useState(0);
    bumpParent = () => setN(n + 1);
    return h("div", null, h("u", null, String(n)), make(type), h(Sibling, null));
  }
  const root = createRoot(asAny(container));
  root.render(h(Parent, null));
  return {
    root,
    parent: () => (bumpParent(), flushSync()),
    sibling: () => (bumpSibling(), flushSync()),
  };
}

Deno.test("library elements: re-render with their parent; skipped when it did not render", () => {
  let renders = 0;
  function Child(): VNode {
    renders++;
    return h("span", null, "child");
  }
  // The app's element: implicit memo, the parent's re-render skips it.
  const app = mount((t) => h(t, { label: "x" }), Child);
  app.parent();
  assertEquals(renders, 1, "an app element with the same props is skipped");
  app.root.unmount();

  renders = 0;
  const lib = mount((t) => libJsx(t, { label: "x" }), Child);
  lib.parent();
  lib.parent();
  assertEquals(renders, 3, "a library element re-renders with its parent, as in React");
  lib.sibling();
  assertEquals(renders, 3, "…and not when only a sibling updated (its parent did not render)");
  lib.root.unmount();

  // A memo() stays a memo: shallow-equal props skip it even as a library element.
  renders = 0;
  const memoed = mount((t) => libJsx(t, { label: "x" }), memo(Child));
  memoed.parent();
  assertEquals(renders, 1, "a library memo() keeps its comparator");
  memoed.root.unmount();
});

/** expo-router 57's `build/ui/useComponent.js` (React Navigation's pattern), verbatim. */
const USE_COMPONENT = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useComponent = useComponent;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const NavigationContent = ({ render, children }) => {
    return render(children);
};
function useComponent(render) {
    const renderRef = (0, react_1.useRef)(render);
    renderRef.current = render;
    (0, react_1.useEffect)(() => {
        renderRef.current = null;
    });
    return (0, react_1.useRef)((0, react_1.forwardRef)(({ children }, _ref) => {
        const render = renderRef.current;
        if (render === null) {
            throw new Error('The returned component must be rendered in the same render phase as the hook.');
        }
        return (0, jsx_runtime_1.jsx)(NavigationContent, { render: render, children: children });
    })).current;
}
`;

type UseComponent = (render: (children: unknown) => VNode) => VNodeType;

Deno.test("library elements: React Navigation's useComponent follows its navigator (expo-router/ui tabs)", async () => {
  // As the compat build resolves them for a module inside node_modules.
  const react = await import("../src/compat/react-lib.ts");
  const jsxRuntime = await import("../src/jsx/jsx-runtime-lib.ts");
  const exports: Record<string, unknown> = {};
  const require = (id: string) => id === "react" ? react : jsxRuntime;
  new Function("exports", "require", USE_COMPONENT)(exports, require);
  const useComponent = exports.useComponent as UseComponent;

  const { doc, container } = makeDom();
  setDocument(asAny(doc as FakeDocument));
  let select = (_n: number) => {};
  // expo-router/ui's <Tabs>: its own state, and the content rendered with the `children` its
  // parent passed (the same elements when only the navigator re-renders). The navigator's
  // element comes from the library too (react.createElement).
  function Navigator(props: { children?: unknown }): VNode {
    const [tab, setTab] = useState(0);
    select = setTab;
    const Content = useComponent((children) => h("p", null, `tab ${tab}`, children as VNode));
    return react.createElement(Content, null, props.children as VNode);
  }
  const root = createRoot(asAny(container));
  root.render(h(Navigator, null, h("span", null, "!")));
  select(1);
  flushSync();
  assertEquals(asAny(container).textContent, "tab 1!", "the new state reaches the content");
  root.unmount();
});
