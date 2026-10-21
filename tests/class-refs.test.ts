// A `ref` on a class component reaches the class INSTANCE, as in React: an object ref's
// `.current` is the instance and a callback ref is called with it, at commit (after
// `componentDidMount`), detached (`null`, or a React-19 cleanup) before `componentWillUnmount`,
// and swapped when the ref changes — even when `shouldComponentUpdate` / PureComponent bails.
// The class's own `this.props` never carries `ref` (React 19 strips it), on the client and on the
// server, and the server renderer never attaches one. `memo(Class)` passes the ref through to the
// instance, a hidden `<Activity>` detaches it while hidden, and hydration attaches it like a mount.

import "./helpers/class-runtime.ts";
import "./helpers/activity-runtime.ts";
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { Component, forwardRef, memo, PureComponent } from "../src/compat/react.ts";
import { createRoot, flushSync, hydrateRoot, setDocument } from "../src/client/reconciler.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Activity } from "../src/runtime/react-extras.ts";
import { useImperativeHandle, useState } from "../src/runtime/hooks.ts";
import { render } from "../src/testing/mod.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function mount() {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  return { container, root: createRoot(container as Any) };
}

/** A class that records its instance, the props it saw and its lifecycle into `log`. */
function makeClass(log: unknown[]) {
  const seen: { inst: unknown; props: Any } = { inst: null, props: null };
  class C extends Component<{ label?: string }> {
    constructor(p: { label?: string }) {
      super(p);
      seen.inst = this;
    }
    componentDidMount() {
      log.push("didMount");
    }
    componentWillUnmount() {
      log.push("willUnmount");
    }
    override render() {
      seen.props = this.props;
      return h("p", null, this.props.label ?? "x");
    }
  }
  return { C, seen };
}

Deno.test("class ref: an object ref is the instance after mount and null after unmount", () => {
  const { root } = mount();
  const { C, seen } = makeClass([]);
  const ref = { current: null as unknown };
  root.render(h(C as Any, { ref, label: "a" }));
  assertStrictEquals(ref.current, seen.inst, "ref.current is the class instance");
  assertEquals(Object.keys(seen.props), ["label"], "this.props carries no ref (React 19)");
  root.unmount();
  assertEquals(ref.current, null, "detached on unmount");
});

Deno.test("class ref: a callback ref fires after componentDidMount and detaches before componentWillUnmount", () => {
  const { root } = mount();
  const log: unknown[] = [];
  const { C, seen } = makeClass(log);
  const ref = (v: unknown) => {
    log.push(v === null ? "ref:null" : v === seen.inst ? "ref:inst" : v);
  };
  root.render(h(C as Any, { ref }));
  assertEquals(log, ["didMount", "ref:inst"]);
  root.render(h(C as Any, { ref, label: "b" }));
  assertEquals(log.length, 2, "an unchanged ref is not re-attached on update");
  root.unmount();
  assertEquals(log, ["didMount", "ref:inst", "ref:null", "willUnmount"]);
});

Deno.test("class ref: a callback ref's React-19 cleanup runs instead of a null call", () => {
  const { root } = mount();
  const calls: unknown[] = [];
  const { C, seen } = makeClass([]);
  const ref = (v: unknown) => {
    calls.push(v);
    return () => calls.push("cleanup");
  };
  root.render(h(C as Any, { ref }));
  root.unmount();
  assertEquals(calls, [seen.inst, "cleanup"]);
});

Deno.test("class ref: changing the ref detaches the old one and attaches the new one", () => {
  const { root } = mount();
  const { C, seen } = makeClass([]);
  const a = { current: null as unknown };
  const b = { current: null as unknown };
  root.render(h(C as Any, { ref: a }));
  assertStrictEquals(a.current, seen.inst);
  root.render(h(C as Any, { ref: b }));
  assertEquals(a.current, null, "the old ref is detached");
  assertStrictEquals(b.current, seen.inst, "the new ref is attached");
  root.render(h(C as Any, {}));
  assertEquals(b.current, null, "removing the ref detaches it");
});

Deno.test("class ref: a PureComponent that bails out still swaps an inline callback ref", () => {
  const { root } = mount();
  let renders = 0;
  let inst: unknown = null;
  class P extends PureComponent<{ n: number }> {
    constructor(p: { n: number }) {
      super(p);
      inst = this;
    }
    override render() {
      renders++;
      return h("i", null, String(this.props.n));
    }
  }
  const calls: unknown[] = [];
  root.render(h(P as Any, { n: 1, ref: (v: unknown) => calls.push(["r1", v]) }));
  root.render(h(P as Any, { n: 1, ref: (v: unknown) => calls.push(["r2", v]) }));
  assertEquals(renders, 1, "shallow-equal props (ref excluded) bail the render");
  assertEquals(calls, [["r1", inst], ["r1", null], ["r2", inst]]);
});

Deno.test("class ref: memo(Class) passes the ref through to the instance", () => {
  const { root } = mount();
  const { C, seen } = makeClass([]);
  const M = memo(C as Any);
  const ref = { current: null as unknown };
  root.render(h(M as Any, { ref, label: "m" }));
  assertStrictEquals(ref.current, seen.inst);
  assertEquals(Object.keys(seen.props), ["label"]);
  root.unmount();
  assertEquals(ref.current, null);
});

Deno.test("class ref: the server ignores it and hydration attaches it to the instance", async () => {
  const { C, seen } = makeClass([]);
  const serverRef = { current: "untouched" };
  const html = await renderToString(h(C as Any, { ref: serverRef, label: "h" }));
  assertEquals(html, "<p>h</p>", "the server renders no ref");
  assertEquals(serverRef.current, "untouched", "the server attaches nothing");
  assertEquals(Object.keys(seen.props), ["label"], "the server's this.props carries no ref");
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  container.innerHTML = html;
  const p = container.childNodes[0];
  const ref = { current: null as unknown };
  hydrateRoot(container as Any, h(C as Any, { ref, label: "h" }));
  flushSync();
  assertStrictEquals(container.childNodes[0], p, "the server node is adopted");
  assertStrictEquals(ref.current, seen.inst);
});

Deno.test("class ref: a hidden Activity detaches the ref and a reveal attaches it again", async () => {
  const { C, seen } = makeClass([]);
  const ref = { current: null as unknown };
  let setMode: (m: "visible" | "hidden") => void = () => {};
  function App() {
    const [mode, set] = useState<"visible" | "hidden">("hidden");
    setMode = set;
    return h(Activity, { mode, children: h(C as Any, { ref }) });
  }
  const screen = await render(h(App as Any, {}));
  await screen.act(() => {});
  assertEquals(ref.current, null, "a class mounted hidden attaches no ref");
  await screen.act(() => setMode("visible"));
  assertStrictEquals(ref.current, seen.inst, "the reveal attaches it");
  await screen.act(() => setMode("hidden"));
  assertEquals(ref.current, null, "hiding detaches it");
  await screen.act(() => setMode("visible"));
  assertStrictEquals(ref.current, seen.inst);
  screen.unmount();
  assertEquals(ref.current, null);
});

Deno.test("class ref: forwardRef + useImperativeHandle inside a class still reach their handle", () => {
  const { root } = mount();
  function InnerImpl(_p: Record<string, never>, r: unknown) {
    useImperativeHandle(r as never, () => ({ ping: () => "pong" }), []);
    return h("b", null);
  }
  const Inner = forwardRef<{ ping(): string }, Record<string, never>>(InnerImpl as never);
  const handle = { current: null as null | { ping(): string } };
  const outer = { current: null as unknown };
  let inst: unknown = null;
  class Outer extends Component {
    constructor(p: Record<string, never>) {
      super(p);
      inst = this;
    }
    override render() {
      return h(Inner as Any, { ref: handle });
    }
  }
  root.render(h(Outer as Any, { ref: outer }));
  assert(handle.current !== null);
  assertEquals(handle.current.ping(), "pong");
  assertStrictEquals(outer.current, inst);
  root.unmount();
  assertEquals(handle.current, null);
  assertEquals(outer.current, null);
});
