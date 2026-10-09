// Run with --v8-flags=--expose-gc (tests/fiber-retention.test.ts does). Mounts and unmounts
// subtrees through the real reconciler over the in-memory DOM and reports, per scenario, how
// many "payload" objects (held only in the unmounted components' hook state) are still alive
// after a forced GC. Prints one JSON line.
import { h } from "../../../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../../../src/client/reconciler.ts";
import { useState } from "../../../src/runtime/hooks.ts";
import { makeDom } from "../../helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --v8-flags=--expose-gc");

async function collect(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    gc!();
    await new Promise((r) => setTimeout(r, 0));
  }
}

const refs: WeakRef<object>[] = [];
const alive = () => refs.filter((r) => r.deref() !== undefined).length;

/** A component whose state holds a payload only it references. */
function Holder({ tag }: { tag: string }) {
  const [payload] = useState(() => {
    const p = { tag, big: new Array(1000).fill(tag) };
    refs.push(new WeakRef(p));
    return p;
  });
  const [n, setN] = useState(0);
  (globalThis as Any).__lastSetN = setN; // the app keeps the latest setter (a store does)
  return h(
    "div",
    { className: "row", onClick: () => setN(n + 1) },
    h("span", null, payload.tag),
    String(n),
  );
}

function App({ ids }: { ids: string[] }) {
  return h("main", null, ...ids.map((id) => h(Holder, { key: id, tag: id })));
}

async function scenario(name: string, keepNode: boolean, setStateBeforeUnmount: boolean) {
  refs.length = 0;
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  let kept: unknown = null;
  for (let round = 0; round < 5; round++) {
    const ids = [0, 1, 2].map((i) => `r${round}-${i}`);
    root.render(h(App, { ids }));
    flushSync();
    // A second render, so every fiber has an alternate (the double buffer).
    root.render(h(App, { ids }));
    flushSync();
    if (setStateBeforeUnmount) {
      (globalThis as Any).__lastSetN(1);
      flushSync();
    }
    // Something outside the tree keeps one DOM node of this round (a library cache,
    // a focus-return target, an event's target): the last round's row.
    if (keepNode) kept = (container as Any).childNodes[0].childNodes[0];
  }
  root.render(h(App, { ids: [] }));
  flushSync();
  (globalThis as Any).__lastSetN = null;
  await collect();
  const tags = refs.map((r) => (r.deref() as { tag?: string } | undefined)?.tag).filter(Boolean);
  const result = { name, payloads: refs.length, alive: alive(), tags };
  root.unmount();
  void kept;
  return result;
}

const out = [
  await scenario("mount-unmount", false, false),
  await scenario("kept-detached-node", true, false),
  await scenario("setstate-then-unmount", false, true),
];
console.log(JSON.stringify(out));
