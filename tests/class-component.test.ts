// React class-component runtime (gated by classComponents; default-on un-bundled
// so these run in-process). Covers setState batching, getDerivedStateFromProps,
// shouldComponentUpdate / PureComponent bailout, lifecycle ordering, forceUpdate,
// and SSR.

import { assert, assertEquals } from "@std/assert";
import { Component, PureComponent } from "../src/compat/react.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("class: stateful component renders and setState updates the DOM", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  class Counter extends Component<Record<string, never>, { n: number }> {
    override state = { n: 0 };
    override render() {
      return h(
        "button",
        { onClick: () => this.setState({ n: this.state.n + 1 }) },
        `Count: ${this.state.n}`,
      );
    }
  }
  createRoot(container as Any).render(h(Counter as Any, null));
  assertEquals(container.innerHTML, "<button>Count: 0</button>");
  (container.childNodes[0] as Any).dispatch("click");
  flushSync();
  assertEquals(container.innerHTML, "<button>Count: 1</button>");
});

Deno.test("class: setState batches multiple calls into one render", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let renders = 0;
  let bump = () => {};
  class C extends Component<Record<string, never>, { n: number }> {
    override state = { n: 0 };
    override render() {
      renders++;
      bump = () => {
        this.setState({ n: this.state.n + 1 });
        this.setState((s) => ({ n: s.n + 1 })); // updater form sees prior queued state
      };
      return h("p", null, String(this.state.n));
    }
  }
  createRoot(container as Any).render(h(C as Any, null));
  assertEquals(renders, 1);
  bump();
  flushSync();
  assertEquals(container.innerHTML, "<p>2</p>", "both setStates applied");
  assertEquals(renders, 2, "coalesced into one re-render");
});

Deno.test("class: getDerivedStateFromProps merges into state each render", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  class C extends Component<{ label: string }, { text: string }> {
    static getDerivedStateFromProps(props: { label: string }) {
      return { text: props.label.toUpperCase() };
    }
    override render() {
      return h("span", null, this.state.text);
    }
  }
  const root = createRoot(container as Any);
  root.render(h(C as Any, { label: "hi" }));
  assertEquals(container.innerHTML, "<span>HI</span>");
  root.render(h(C as Any, { label: "bye" }));
  assertEquals(container.innerHTML, "<span>BYE</span>");
});

Deno.test("class: PureComponent skips re-render on shallow-equal props+state", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let childRenders = 0;
  class Child extends PureComponent<{ label: string }> {
    override render() {
      childRenders++;
      return h("i", null, this.props.label);
    }
  }
  let rerender = () => {};
  class Parent extends Component<Record<string, never>, { tick: number }> {
    override state = { tick: 0 };
    override render() {
      rerender = () => this.setState({ tick: this.state.tick + 1 });
      return h(Child as Any, { label: "same" });
    }
  }
  createRoot(container as Any).render(h(Parent as Any, null));
  assertEquals(childRenders, 1);
  rerender(); // Parent re-renders; Child gets identical props
  flushSync();
  assertEquals(childRenders, 1, "PureComponent bailed on equal props");
});

Deno.test("class: lifecycle order (mount, update, unmount)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const log: string[] = [];
  class C extends Component<{ v: number }, Record<string, never>> {
    componentDidMount() {
      log.push("didMount");
    }
    getSnapshotBeforeUpdate() {
      log.push("snapshot");
      return "snap";
    }
    componentDidUpdate(_p: unknown, _s: unknown, snapshot: unknown) {
      log.push("didUpdate:" + snapshot);
    }
    componentWillUnmount() {
      log.push("willUnmount");
    }
    override render() {
      return h("p", null, String(this.props.v));
    }
  }
  const root = createRoot(container as Any);
  root.render(h(C as Any, { v: 1 }));
  root.render(h(C as Any, { v: 2 }));
  root.unmount();
  assertEquals(log, ["didMount", "snapshot", "didUpdate:snap", "willUnmount"]);
});

Deno.test("class: forceUpdate bypasses shouldComponentUpdate", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let renders = 0;
  let force = () => {};
  class C extends Component {
    shouldComponentUpdate() {
      return false; // would normally block all updates
    }
    override render() {
      renders++;
      force = () => this.forceUpdate();
      return h("p", null, "x");
    }
  }
  createRoot(container as Any).render(h(C as Any, null));
  assertEquals(renders, 1);
  force();
  flushSync();
  assertEquals(renders, 2, "forceUpdate re-rendered despite scu=false");
});

Deno.test("class: renders server-side (getDerivedStateFromProps + render, no effects)", async () => {
  let mounted = false;
  class C extends Component<{ name: string }, { text: string }> {
    static getDerivedStateFromProps(p: { name: string }) {
      return { text: `Hello ${p.name}` };
    }
    componentDidMount() {
      mounted = true; // must NOT run on the server
    }
    override render() {
      return h("h1", null, this.state.text);
    }
  }
  const html = await renderToString(h(C as Any, { name: "PDQ" }) as never);
  assertEquals(html, "<h1>Hello PDQ</h1>");
  assert(!mounted, "componentDidMount must not run during SSR");
});
