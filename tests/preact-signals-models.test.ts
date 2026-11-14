// `denext/signals`: the parts of @preact/signals that came after the core — `createModel` /
// `useModel`, `useSignalRef` (`@preact/signals/utils`) and the options argument of `signal`,
// `computed`, `effect` and their hooks (`name`, `watched`, `unwatched`). The expectations follow
// @preact/signals-core 1.14 and @preact/signals 2.11's source (packages/core/src/index.ts:
// `createModel`, `untracked`'s capture suppression, `Signal.prototype._subscribe`).

import { assertEquals, assertThrows } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { render } from "../src/testing/mod.ts";
import {
  computed,
  createModel,
  effect,
  type Signal,
  signal,
  untracked,
  useModel,
  useSignalRef,
} from "../src/compat/preact/signals.ts";

Deno.test("createModel: new and call build a model; its functions are actions; dispose stops its effects", () => {
  const seen: number[] = [];
  const Counter = createModel((start: number) => {
    const count = signal(start);
    const double = computed(() => count.value * 2);
    effect(() => {
      seen.push(double.value);
    });
    return {
      count,
      double,
      inc() {
        count.value++;
        count.value++; // batched: the effect sees one change
      },
      nested: { reset: () => (count.value = 0) },
    };
  });
  const model = new Counter(1);
  const called = (Counter as unknown as (n: number) => typeof model)(10);
  assertEquals(model.count.value, 1);
  assertEquals(called.count.value, 10);
  model.inc();
  model.nested.reset();
  assertEquals(seen, [2, 20, 6, 0]);
  model[Symbol.dispose]();
  model.count.value = 7; // its effect is gone
  called.count.value = 11; // the other instance's effect still runs
  assertEquals(seen, [2, 20, 6, 0, 22]);
});

Deno.test("createModel: effects inside untracked() are not the model's; a nested model's are its parent's", () => {
  const seen: string[] = [];
  const s = signal(0);
  let loose: () => void = () => {};
  const Inner = createModel(() => {
    effect(() => {
      seen.push(`inner ${s.value}`);
    });
    return {};
  });
  const Outer = createModel(() => {
    const inner = new Inner();
    untracked(() => {
      loose = effect(() => {
        seen.push(`loose ${s.value}`);
      });
    });
    return { inner };
  });
  const outer = new Outer();
  outer[Symbol.dispose]();
  s.value = 1; // the inner model's effect went with the outer model; the untracked one did not
  assertEquals(seen, ["inner 0", "loose 0", "loose 1"]);
  loose();
});

Deno.test("createModel: a factory that throws disposes the effects it made, and the error is rethrown", () => {
  const s = signal(0);
  let runs = 0;
  const Broken = createModel(() => {
    effect(() => {
      s.value;
      runs++;
    });
    throw new Error("factory failed");
  });
  assertThrows(() => new Broken(), Error, "factory failed");
  s.value = 1;
  assertEquals(runs, 1);
});

Deno.test("useModel: one model per component, disposed on unmount", async () => {
  const seen: number[] = [];
  const s = signal(0);
  const Model = createModel(() => {
    effect(() => {
      seen.push(s.value);
    });
    return { s };
  });
  let builds = 0;
  function View() {
    const m = useModel(() => {
      builds++;
      return new Model();
    });
    return h("p", null, `v${m.s.value}`);
  }
  const screen = await render(h(View, null));
  await screen.act(() => {
    s.value = 1;
  });
  assertEquals(screen.html(), "<p>v1</p>");
  assertEquals(builds, 1);
  await screen.unmount();
  s.value = 2;
  assertEquals(seen, [0, 1]);
});

Deno.test("useSignalRef: a signal whose current is its value, set by a ref", async () => {
  let ref: (Signal<unknown> & { current: unknown }) | null = null;
  function View() {
    const r = useSignalRef<unknown>(null);
    ref = r;
    return h("div", { ref: r, id: "box" });
  }
  const screen = await render(h(View, null));
  const node = ref!.current as { getAttribute(n: string): string } | null;
  assertEquals(node?.getAttribute("id"), "box");
  assertEquals(ref!.value, ref!.current);
  ref!.current = "set";
  assertEquals(ref!.value, "set");
  await screen.unmount();
});

Deno.test("signal options: name, and watched / unwatched around the first and last subscriber", () => {
  const log: string[] = [];
  const s = signal(1, {
    name: "count",
    watched() {
      log.push(`watched ${this.peek()}`);
    },
    unwatched() {
      log.push("unwatched");
    },
  });
  assertEquals(s.name, "count");
  const a = effect(() => {
    s.value;
  }, { name: "first" });
  const b = effect(() => {
    s.value;
  });
  assertEquals(log, ["watched 1"]);
  a();
  assertEquals(log, ["watched 1"]);
  b();
  assertEquals(log, ["watched 1", "unwatched"]);
  const c = computed(() => s.value + 1, { name: "plus" });
  assertEquals(c.name, "plus");
  const d = effect(() => {
    c.value;
  });
  assertEquals(log, ["watched 1", "unwatched", "watched 1"]);
  d();
});
