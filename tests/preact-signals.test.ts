// `denext/signals`: Preact Signals' API — the reactive core (signal / computed / effect /
// batch / untracked), components re-rendering on the signals their render read, a signal as a
// JSX child, and the server → client hand-off of a signal prop.

import { assertEquals, assertThrows } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { render } from "../src/testing/mod.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import {
  action,
  batch,
  computed,
  effect,
  For,
  Show,
  Signal,
  signal,
  untracked,
  useComputed,
  useSignal,
  useSignalEffect,
} from "../src/compat/preact/signals.ts";
import { isSignal, reviveSignal, SIGNAL_BRAND } from "../src/runtime/signal-brand.ts";
import { serializeFlightValue } from "../src/jsx/render-shared.ts";
import { parseFlight } from "../src/client/flight-client.ts";

Deno.test("signal: value, peek, subscribe, toString/toJSON/valueOf, the Preact brand", () => {
  const s = signal(1);
  assertEquals(s.value, 1);
  assertEquals(s.peek(), 1);
  const seen: number[] = [];
  const stop = s.subscribe((v) => seen.push(v));
  s.value = 2;
  s.value = 2; // unchanged: no notification
  stop();
  s.value = 3;
  assertEquals(seen, [1, 2]);
  assertEquals(`${s}`, "3");
  assertEquals(JSON.stringify({ s }), '{"s":3}');
  assertEquals(+s + 1, 4);
  assertEquals((s as unknown as { brand: symbol }).brand, SIGNAL_BRAND);
  assertEquals(isSignal(s), true);
  assertEquals(s instanceof Signal, true);
  assertEquals(signal().value, undefined);
});

Deno.test("computed: lazy, cached, read-only, and skips effects when its value did not change", () => {
  const a = signal(2);
  let runs = 0;
  const parity = computed(() => {
    runs++;
    return a.value % 2;
  });
  assertEquals(runs, 0);
  assertEquals(parity.value, 0);
  assertEquals(parity.value, 0);
  assertEquals(runs, 1);
  const seen: number[] = [];
  effect(() => {
    seen.push(parity.value);
  });
  a.value = 4; // parity unchanged: the effect does not re-run
  a.value = 5;
  assertEquals(seen, [0, 1]);
  assertThrows(() => ((parity as unknown as Signal<number>).value = 1), Error, "read-only");
  const chained = computed(() => parity.value * 10);
  assertEquals(chained.peek(), 10);
});

Deno.test("effect: cleanup, dispose, batch, untracked, action", () => {
  const a = signal(1);
  const b = signal(1);
  const log: string[] = [];
  const dispose = effect(() => {
    log.push(`run ${a.value}+${untracked(() => b.value)}`);
    return () => log.push("cleanup");
  });
  b.value = 2; // untracked: no re-run
  batch(() => {
    a.value = 2;
    a.value = 3;
  });
  const inc = action((n: number) => (a.value += n));
  inc(1);
  dispose();
  a.value = 9;
  assertEquals(log, ["run 1+1", "cleanup", "run 3+2", "cleanup", "run 4+2", "cleanup"]);
  assertThrows(
    () => {
      const x = signal(0);
      effect(() => {
        x.value = x.value + 1;
      });
    },
    Error,
    "cycle",
  );
});

Deno.test("a component re-renders when a signal its render read changes", async () => {
  const count = signal(0);
  function Counter() {
    return h("p", null, `count ${count.value}`);
  }
  const screen = await render(h(Counter, null));
  assertEquals(screen.html(), "<p>count 0</p>");
  await screen.act(() => {
    count.value = 5;
  });
  assertEquals(screen.html(), "<p>count 5</p>");
  await screen.unmount();
  count.value = 6; // the unmounted component is dropped, not re-rendered
});

Deno.test("a signal as a JSX child renders its value and follows it", async () => {
  const count = signal(1);
  function View() {
    return h("span", null, count as never);
  }
  const screen = await render(h(View, null));
  assertEquals(screen.html(), "<span>1</span>");
  await screen.act(() => {
    count.value = 2;
  });
  assertEquals(screen.html(), "<span>2</span>");
  assertEquals(await renderToString(h("b", null, signal("x") as never)), "<b>x</b>");
});

Deno.test("useSignal / useComputed / useSignalEffect, Show and For", async () => {
  const log: number[] = [];
  let bump: () => void = () => {};
  function Widget() {
    const n = useSignal(1);
    const double = useComputed(() => n.value * 2);
    useSignalEffect(() => {
      log.push(n.value);
    });
    bump = () => n.value++;
    return h(
      "div",
      null,
      h(Show, { when: double, fallback: "none", children: (v: number) => `double ${v}` } as never),
      h(For, {
        each: computed(() => Array.from({ length: n.value }, (_, i) => i)),
        children: (i: number) => h("i", { key: i }, String(i)),
      } as never),
    );
  }
  const screen = await render(h(Widget, null));
  assertEquals(screen.html(), "<div>double 2<i>0</i></div>");
  await screen.act(() => bump());
  assertEquals(screen.html(), "<div>double 4<i>0</i><i>1</i></div>");
  assertEquals(log, [1, 2]);
});

Deno.test("a signal prop crosses the Flight boundary as one live signal per server signal", async () => {
  const shared = signal(7);
  const serialize = (v: unknown): Promise<unknown> =>
    serializeFlightValue(v, { value: serialize as never, vnode: () => Promise.resolve(null) });
  const wire = await serialize({ a: shared, b: shared, c: signal({ d: new Date(0) }) });
  const { a, b, c } = wire as Record<string, { $: string; i: number; v: unknown }>;
  assertEquals(a.$, "sg");
  assertEquals(a.i, b.i);
  assertEquals(a.v, 7);
  assertEquals(c.$, "sg");
  const Island = () => null;
  const registry = new Map([["island#default", Island]]) as never;
  const parsed = parseFlight(
    { $: "c", i: "island#default", p: wire, c: [] } as never,
    registry,
  ) as {
    props: Record<string, Signal<unknown>>;
  };
  assertEquals(parsed.props.a instanceof Signal, true);
  assertEquals(parsed.props.a === parsed.props.b, true);
  assertEquals((parsed.props.c.value as { d: Date }).d.getTime(), 0);
  assertEquals(reviveSignal(1, undefined) instanceof Signal, true);
});

Deno.test("a signal-valued DOM prop is bound: the owning component follows it", async () => {
  const text = signal("a");
  const off = signal(false);
  function Field() {
    return h("input", { value: text, disabled: off } as never);
  }
  const screen = await render(h(Field, null));
  const input = (screen.container as unknown as {
    childNodes: { value: string; hasAttribute(n: string): boolean }[];
  }).childNodes[0];
  assertEquals(input.value, "a");
  assertEquals(input.hasAttribute("disabled"), false);
  await screen.act(() => {
    batch(() => {
      text.value = "b";
      off.value = true;
    });
  });
  assertEquals(input.value, "b");
  assertEquals(input.hasAttribute("disabled"), true);
  assertEquals(await renderToString(h("i", { class: signal("c") } as never)), '<i class="c"></i>');
});
