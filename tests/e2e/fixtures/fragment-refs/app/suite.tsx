"use client";
// React's Fragment-ref cases that need a real DOM — focus, layout, events, document position,
// scrolling — ported from ReactDOMFragmentRefs-test.js (React 19.3.1, MIT, Copyright (c) Meta
// Platforms, Inc. and affiliates). Each case mounts its own root; `runSuite` reports which passed.
import { createRef, Fragment } from "denext";
import type { FragmentInstance } from "denext";
import { createPortal, createRoot, flushSync } from "denext/client";

type Ref<T> = { current: T | null };
// deno-lint-ignore no-explicit-any
type Any = any;

function Wrapper({ children }: { children?: unknown }) {
  return children as never;
}

/** The mounts a case has not unmounted yet (torn down after it, pass or fail). */
const live = new Set<() => void>();

/** Mount `el` in a fresh container on the page; `render` re-renders, `unmount` tears down. */
function mount(el: unknown) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(el as never));
  const unmount = () => {
    if (!live.delete(unmount)) return;
    flushSync(() => root.unmount());
    container.remove();
  };
  live.add(unmount);
  return {
    container,
    render(next: unknown) {
      flushSync(() => root.render(next as never));
    },
    unmount,
  };
}

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

/** A click logger: `[type, target id, currentTarget id]` per call. */
function clickLog() {
  const logs: unknown[][] = [];
  const onClick = (e: Any) => void logs.push([e.type, e.target.id, e.currentTarget.id]);
  return { logs, onClick };
}

const active = () => (document.activeElement as HTMLElement | null)?.id ?? null;

/** The DOCUMENT_POSITION_* flags of `position`, by name (React's `expectPosition`). */
function position(p: number) {
  return {
    preceding: (p & Node.DOCUMENT_POSITION_PRECEDING) !== 0,
    following: (p & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    contains: (p & Node.DOCUMENT_POSITION_CONTAINS) !== 0,
    containedBy: (p & Node.DOCUMENT_POSITION_CONTAINED_BY) !== 0,
    disconnected: (p & Node.DOCUMENT_POSITION_DISCONNECTED) !== 0,
    implementationSpecific: (p & Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC) !== 0,
  };
}
const pos = (flags: string) => ({
  preceding: flags.includes("P"),
  following: flags.includes("F"),
  contains: flags.includes("C"),
  containedBy: flags.includes("B"),
  disconnected: flags.includes("D"),
  implementationSpecific: flags.includes("I"),
});

const cases: Record<string, () => void> = {
  "focus(): focuses the first focusable child"() {
    const ref = createRef<FragmentInstance>();
    const m = mount(
      <div>
        <Fragment ref={ref}>
          <div id="child-a" />
          <style>{`#child-c {}`}</style>
          <a id="child-b" href="/">B</a>
          <a id="child-c" href="/">C</a>
        </Fragment>
      </div>,
    );
    ref.current!.focus();
    eq(active(), "child-b", "active element");
    (document.activeElement as HTMLElement).blur();
    m.unmount();
  },

  "focus(): focuses deeply nested focusable children, depth first"() {
    const ref = createRef<FragmentInstance>();
    const m = mount(
      <Fragment ref={ref}>
        <div id="child-a">
          <div tabIndex={0} id="grandchild-a">
            <a id="greatgrandchild-a" href="/" />
          </div>
        </div>
        <a id="child-b" href="/" />
      </Fragment>,
    );
    ref.current!.focus();
    eq(active(), "grandchild-a", "active element");
    m.unmount();
  },

  "focus(): preserves document order when adding and removing children"() {
    const ref = createRef<FragmentInstance>();
    const Test = ({ showA, showB }: { showA: boolean; showB: boolean }) => (
      <Fragment ref={ref}>
        {showA && <a href="/" id="child-a" />}
        {showB && <a href="/" id="child-b" />}
      </Fragment>
    );
    const m = mount(<Test showA showB={false} />);
    ref.current!.focus();
    eq(active(), "child-a", "A only");
    m.render(<Test showA showB />);
    ref.current!.focus();
    eq(active(), "child-a", "A and B");
    m.render(<Test showA={false} showB />);
    ref.current!.focus();
    eq(active(), "child-b", "B only");
    m.unmount();
  },

  "focus(): keeps focus on the first focusable child if already focused"() {
    const ref = createRef<FragmentInstance>();
    const m = mount(
      <Fragment ref={ref}>
        <a id="child-a" href="/">A</a>
        <a id="child-b" href="/">B</a>
      </Fragment>,
    );
    document.getElementById("child-a")!.focus();
    ref.current!.focus();
    eq(active(), "child-a", "child-a keeps focus");
    m.unmount();
  },

  "focus(): keeps focus on a nested child if already focused"() {
    const ref = createRef<FragmentInstance>();
    const m = mount(
      <Fragment ref={ref}>
        <div>
          <input id="nested-input" />
        </div>
        <a id="sibling-link" href="/">Link</a>
      </Fragment>,
    );
    document.getElementById("nested-input")!.focus();
    ref.current!.focus();
    eq(active(), "nested-input", "nested-input keeps focus");
    m.unmount();
  },

  "focus(): focuses the first focusable child in a fieldset"() {
    const ref = createRef<FragmentInstance>();
    const m = mount(
      <Fragment ref={ref}>
        <fieldset>
          <legend>Shipping</legend>
          <input id="street" name="street" />
          <input id="city" name="city" />
        </fieldset>
      </Fragment>,
    );
    ref.current!.focus();
    eq(active(), "street", "active element");
    m.unmount();
  },

  "focusLast(): focuses the last focusable child, depth first"() {
    const ref = createRef<FragmentInstance>();
    const m = mount(
      <div>
        <Fragment ref={ref}>
          <a id="child-a" href="/">A</a>
          <a id="child-b" href="/">B</a>
          <Wrapper>
            <a id="child-c" href="/">C</a>
          </Wrapper>
          <div id="child-d" />
          <style id="child-e">{`#child-d {}`}</style>
        </Fragment>
      </div>,
    );
    ref.current!.focusLast();
    eq(active(), "child-c", "last focusable");
    m.unmount();
    const nested = createRef<FragmentInstance>();
    const n = mount(
      <Fragment ref={nested}>
        <div id="x-a">
          <a id="x-grandchild-a" href="/" />
        </div>
        <div tabIndex={0} id="x-b">
          <a id="x-grandchild-b" href="/" />
        </div>
      </Fragment>,
    );
    nested.current!.focusLast();
    eq(active(), "x-grandchild-b", "deepest last");
    n.unmount();
  },

  "blur(): removes focus from inside (nested, portaled), not from outside"() {
    const ref = createRef<FragmentInstance>();
    const inner = createRef<FragmentInstance>();
    const portalRef = createRef<FragmentInstance>();
    const m = mount(
      <div>
        <Fragment ref={ref}>
          <a id="child-a" href="/">A</a>
          <div>
            <input id="nested-input" />
          </div>
          <Fragment ref={inner}>
            <a id="child-b" href="/">B</a>
          </Fragment>
        </Fragment>
        <Fragment ref={portalRef}>
          {createPortal(
            <div>
              <input id="portaled-input" />
            </div>,
            document.body,
          )}
        </Fragment>
      </div>,
    );
    ref.current!.focus();
    eq(active(), "child-a", "focused");
    inner.current!.blur();
    eq(active(), "child-a", "a sibling fragment leaves it");
    ref.current!.blur();
    eq(document.activeElement === document.body, true, "blurred");
    document.getElementById("nested-input")!.focus();
    ref.current!.blur();
    eq(document.activeElement === document.body, true, "nested blurred");
    portalRef.current!.focus();
    eq(active(), "portaled-input", "portaled focus");
    portalRef.current!.blur();
    eq(document.activeElement === document.body, true, "portaled blurred");
    m.unmount();
  },

  "dispatchEvent(): fires on the host parent when bubbling, and nowhere once unmounted"() {
    const ref = createRef<FragmentInstance>();
    const { logs, onClick } = clickLog();
    const Test = ({ mounted }: { mounted: boolean }) => (
      <div onClick={onClick} id="grandparent">
        <div onClick={onClick} id="parent">
          {mounted && (
            <Fragment ref={ref}>
              <div onClick={onClick} id="child">Hi</div>
            </Fragment>
          )}
        </div>
      </div>
    );
    const m = mount(<Test mounted />);
    let cancelled = !ref.current!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    eq(logs, [["click", "parent", "parent"], [
      "click",
      "parent",
      "grandparent",
    ]], "bubbled");
    eq(cancelled, false, "not cancelled");
    const handle = ref.current!;
    m.render(<Test mounted={false} />);
    logs.length = 0;
    cancelled = !handle.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    eq(logs, [], "unmounted: nothing fires");
    eq(cancelled, false, "unmounted: not cancelled");
    m.unmount();
  },

  "dispatchEvent(): fires on itself, and only itself when not bubbling"() {
    const ref = createRef<FragmentInstance>();
    const { logs, onClick } = clickLog();
    const m = mount(
      <div id="parent" onClick={onClick}>
        <Fragment ref={ref} />
      </div>,
    );
    ref.current!.addEventListener("click", onClick as EventListener);
    ref.current!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // (React's synthetic event retargets a text-node target to its parent; the parent's handler
    // is what matters here, so only its currentTarget is compared.)
    eq(
      logs.map((l, i) => i === 0 ? l : [l[0], l[2]]),
      [["click", null, null], ["click", "parent"]],
      "self, then the parent",
    );
    logs.length = 0;
    ref.current!.dispatchEvent(new MouseEvent("click", { bubbles: false }));
    eq(logs, [["click", null, null]], "self only");
    m.unmount();
  },

  "events: listeners reach text children, and leave a deleted one"() {
    const ref = createRef<FragmentInstance>();
    const Test = ({ text }: { text: boolean }) => (
      <div id="parent">
        <Fragment ref={ref}>
          {text && "hello"}
          <span id="el">x</span>
        </Fragment>
      </div>
    );
    const m = mount(<Test text />);
    let calls = 0;
    ref.current!.addEventListener("custom", () => void calls++);
    const textNode = m.container.querySelector("#parent")!.firstChild!;
    eq(textNode.nodeType, 3, "a text child");
    textNode.dispatchEvent(new Event("custom"));
    eq(calls, 1, "the text child carries the listener");
    m.render(<Test text={false} />);
    textNode.dispatchEvent(new Event("custom"));
    eq(calls, 1, "the deleted text child lost it");
    m.unmount();
  },

  "events: a once listener fires once; a signal removes it"() {
    const ref = createRef<FragmentInstance>();
    const m = mount(
      <Fragment ref={ref}>
        <div id="o-a" />
        <div id="o-b" />
      </Fragment>,
    );
    let once = 0;
    ref.current!.addEventListener("ping", () => void once++, { once: true });
    document.getElementById("o-a")!.dispatchEvent(new Event("ping"));
    document.getElementById("o-b")!.dispatchEvent(new Event("ping"));
    eq(once, 1, "once across children");
    const ac = new AbortController();
    let signalled = 0;
    ref.current!.addEventListener("pong", () => void signalled++, {
      signal: ac.signal,
    });
    document.getElementById("o-b")!.dispatchEvent(new Event("pong"));
    ac.abort();
    document.getElementById("o-b")!.dispatchEvent(new Event("pong"));
    eq(signalled, 1, "aborted");
    m.unmount();
  },

  "getClientRects(): returns the rects of every child, text included"() {
    const ref = createRef<FragmentInstance>();
    const m = mount(
      <div>
        <Fragment ref={ref}>
          <div id="r-a" style={{ width: "30px", height: "40px" }} />
          {"text"}
          <div id="r-b" style={{ width: "11px", height: "12px" }} />
        </Fragment>
      </div>,
    );
    const rects = ref.current!.getClientRects();
    eq(rects.length, 3, "three rects");
    const a = document.getElementById("r-a")!.getBoundingClientRect();
    const b = document.getElementById("r-b")!.getBoundingClientRect();
    eq([rects[0].width, rects[0].height, rects[0].top], [
      a.width,
      a.height,
      a.top,
    ], "first");
    eq([rects[2].width, rects[2].height, rects[2].top], [
      b.width,
      b.height,
      b.top,
    ], "last");
    eq(rects[1].width > 0, true, "the text's rect");
    m.unmount();
  },

  "getRootNode(): the parent's root; itself once unmounted"() {
    const ref = createRef<FragmentInstance>();
    const Test = ({ mounted }: { mounted: boolean }) => (
      <div id="gr-parent">
        {mounted && (
          <Fragment ref={ref}>
            <div />
          </Fragment>
        )}
      </div>
    );
    const m = mount(<Test mounted />);
    eq(ref.current!.getRootNode() === document, true, "document");
    const handle = ref.current!;
    m.render(<Test mounted={false} />);
    eq(handle.getRootNode() === handle, true, "itself");
    m.unmount();
  },

  "compareDocumentPosition(): the fragment against nodes around and inside it"() {
    const ref = createRef<FragmentInstance>();
    const r: Record<string, Ref<HTMLDivElement>> = {};
    for (
      const k of ["before", "after", "first", "middle", "last", "container"]
    ) r[k] = createRef();
    const m = mount(
      <div ref={r.container} id="container">
        <div ref={r.before} id="before" />
        <Fragment ref={ref}>
          <div ref={r.first} id="first" />
          <div ref={r.middle} id="middle" />
          <div ref={r.last} id="last" />
        </Fragment>
        <div ref={r.after} id="after" />
      </div>,
    );
    const cmp = (n: Node) => position(ref.current!.compareDocumentPosition(n));
    eq(cmp(document.body), pos("PC"), "body");
    eq(cmp(r.before.current!), pos("P"), "before");
    eq(cmp(r.after.current!), pos("F"), "after");
    eq(cmp(r.first.current!), pos("B"), "first");
    eq(cmp(r.middle.current!), pos("B"), "middle");
    eq(cmp(r.last.current!), pos("B"), "last");
    eq(cmp(r.container.current!), pos("PC"), "container");
    eq(cmp(document.createElement("div")).disconnected, true, "disconnected");
    m.unmount();
  },

  "compareDocumentPosition(): an empty fragment sits between its siblings"() {
    const ref = createRef<FragmentInstance>();
    const r: Record<string, Ref<HTMLDivElement>> = {};
    for (
      const k of ["beforeParent", "before", "after", "afterParent", "container"]
    ) {
      r[k] = createRef();
    }
    const m = mount(
      <>
        <div id="before-container" ref={r.beforeParent} />
        <div id="container" ref={r.container}>
          <div id="before" ref={r.before} />
          <Fragment ref={ref} />
          <div id="after" ref={r.after} />
        </div>
        <div id="after-container" ref={r.afterParent} />
      </>,
    );
    const cmp = (n: Node) => position(ref.current!.compareDocumentPosition(n));
    eq(cmp(document.body), pos("PCI"), "body");
    eq(cmp(r.before.current!), pos("PI"), "before");
    eq(cmp(r.beforeParent.current!), pos("PI"), "before-container");
    eq(cmp(r.after.current!), pos("FI"), "after");
    eq(cmp(r.afterParent.current!), pos("FI"), "after-container");
    eq(cmp(r.container.current!), pos("CI"), "container");
    m.unmount();
  },

  "compareDocumentPosition(): disconnected once the fragment unmounts"() {
    const ref = createRef<FragmentInstance>();
    const container = createRef<HTMLDivElement>();
    const Test = ({ show }: { show: boolean }) => (
      <div ref={container}>
        {show && (
          <Fragment ref={ref}>
            <div />
          </Fragment>
        )}
      </div>
    );
    const m = mount(<Test show />);
    const handle = ref.current!;
    eq(
      position(handle.compareDocumentPosition(container.current!)),
      pos("PC"),
      "mounted",
    );
    m.render(<Test show={false} />);
    eq(
      position(handle.compareDocumentPosition(container.current!)),
      pos("D"),
      "unmounted",
    );
    m.unmount();
  },

  "compareDocumentPosition(): a node portaled into the fragment's range is not inside it"() {
    const ref = createRef<FragmentInstance>();
    const host = document.createElement("div");
    host.id = "portal-host";
    const m = mount(
      <div id="pp">
        <Fragment ref={ref}>
          <div id="p-first" />
          <div id="p-last" />
        </Fragment>
      </div>,
    );
    // A foreign node placed between the children by hand: the DOM says contained, React's tree no.
    const foreign = document.createElement("div");
    document.getElementById("p-last")!.before(foreign);
    eq(
      position(ref.current!.compareDocumentPosition(foreign)),
      pos("I"),
      "foreign node",
    );
    m.unmount();
  },

  "scrollIntoView(): options throw; children settle on the first (or last) child"() {
    const empty = createRef<FragmentInstance>();
    const e = mount(<Fragment ref={empty} />);
    let threw = "";
    try {
      empty.current!.scrollIntoView({ block: "start" } as Any);
    } catch (err) {
      threw = (err as Error).message;
    }
    eq(
      threw.includes("does not support scrollIntoViewOptions"),
      true,
      "options throw",
    );
    e.unmount();
    const ref = createRef<FragmentInstance>();
    const a = createRef<HTMLDivElement>();
    const b = createRef<HTMLDivElement>();
    const m = mount(
      <Fragment ref={ref}>
        <div ref={a}>A</div>
        <div ref={b}>B</div>
      </Fragment>,
    );
    let logs: string[] = [];
    a.current!.scrollIntoView = () => void logs.push("childA");
    b.current!.scrollIntoView = () => void logs.push("childB");
    ref.current!.scrollIntoView();
    eq(logs.at(-1), "childA", "default");
    logs = [];
    ref.current!.scrollIntoView(false);
    eq(logs.at(-1), "childB", "alignToTop=false");
    m.unmount();
  },

  "scrollIntoView(): an empty fragment scrolls its next / previous sibling, else its parent"() {
    const ref = createRef<FragmentInstance>();
    const before = createRef<HTMLDivElement>();
    const after = createRef<HTMLDivElement>();
    const m = mount(
      <div>
        <div ref={before} id="s-before" />
        <Wrapper>
          <Fragment ref={ref} />
        </Wrapper>
        <div ref={after} id="s-after" />
      </div>,
    );
    const logs: string[] = [];
    before.current!.scrollIntoView = () => void logs.push("before");
    after.current!.scrollIntoView = () => void logs.push("after");
    ref.current!.scrollIntoView();
    ref.current!.scrollIntoView(false);
    eq(logs, ["after", "before"], "siblings");
    m.unmount();
    const lone = createRef<FragmentInstance>();
    const parent = createRef<HTMLDivElement>();
    const p = mount(
      <div ref={parent}>
        <Wrapper>
          <Fragment ref={lone} />
        </Wrapper>
      </div>,
    );
    let parentCalls = 0;
    parent.current!.scrollIntoView = () => void parentCalls++;
    lone.current!.scrollIntoView();
    eq(parentCalls, 1, "the parent");
    p.unmount();
  },

  "observeUsing(): a real ResizeObserver sees a child added later"() {
    const ref = createRef<FragmentInstance>();
    const Test = ({ two }: { two: boolean }) => (
      <Fragment ref={ref}>
        <div id="ro-a" />
        {two && <div id="ro-b" />}
      </Fragment>
    );
    const m = mount(<Test two={false} />);
    const seen = new Set<string>();
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) seen.add((e.target as Element).id);
    });
    ref.current!.observeUsing(ro);
    m.render(<Test two />);
    // Resolved asynchronously: the e2e test reads globalThis.__roSeen after a frame.
    (globalThis as Any).__roSeen = seen;
    (globalThis as Any).__roCleanup = () => {
      ref.current!.unobserveUsing(ro);
      m.unmount();
    };
  },
};

/** Run one case, recording whether it passed (and why not). */
function runCase(
  name: string,
  run: () => void,
  passed: string[],
  failures: string[],
): void {
  try {
    run();
    passed.push(name);
  } catch (err) {
    failures.push(`${name}: ${(err as Error).stack}`);
  }
}

/** Tear down what a case left mounted, and drop focus. */
function tearDown(): void {
  for (const unmount of [...live]) unmount();
  (document.activeElement as HTMLElement).blur();
}

/** Run every case; returns which passed and which failed (with the reason). */
export function runSuite(): {
  done: boolean;
  passed: string[];
  failures: string[];
} {
  const passed: string[] = [];
  const failures: string[] = [];
  for (const [name, run] of Object.entries(cases)) {
    runCase(name, run, passed, failures);
    // The observer case's mount stays: the e2e test reads its results after a frame.
    if (!name.startsWith("observeUsing")) tearDown();
  }
  return { done: true, passed, failures };
}
