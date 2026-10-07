// Shared harness for the VirtualList feature tests (the same model as
// tests/virtual-list-dom.test.ts): denext/testing's in-memory DOM, a fake ResizeObserver, and a
// flow-layout simulator that places rendered rows at the window's margin plus their TRUE sizes.

import { act, type TestElement } from "../../src/testing/mod.ts";
import { h } from "../../src/jsx/jsx-runtime.ts";
import type { VNode } from "../../src/jsx/types.ts";
import { VirtualList } from "../../src/client/virtual/virtual-list.ts";
import type { VirtualListProps } from "../../src/client/virtual/types.ts";
import { type DomEl, fireEventOn, walkElements } from "../../src/testing/dom.ts";

export type Row = { id: string; text: string };
export const rows = (n: number, from = 0): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${from + i}`, text: `row ${from + i}` }));

/** A fake ResizeObserver: records observed elements; `measureAll` reports sizes. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets = new Set<DomEl>();
  readonly reported = new Map<DomEl, number>();
  constructor(readonly cb: (entries: unknown[]) => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: DomEl): void {
    this.targets.add(el);
  }
  unobserve(el: DomEl): void {
    this.targets.delete(el);
    this.reported.delete(el);
  }
  disconnect(): void {
    this.targets.clear();
  }
}

/** Install the fake RO for the duration of `fn`. */
export async function withRO<R>(fn: () => Promise<R>): Promise<R> {
  const g = globalThis as { ResizeObserver?: unknown };
  const prev = g.ResizeObserver;
  FakeResizeObserver.instances = [];
  g.ResizeObserver = class extends FakeResizeObserver {};
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete g.ResizeObserver;
    else g.ResizeObserver = prev;
  }
}

/** Report the true size of every observed row (by `attr`) whose size changed; repeat. */
export async function measureAll(
  truth: (index: number) => number,
  rounds = 12,
  attr = "data-index",
): Promise<void> {
  // The list's shared observer: the newest one watching rows (a component may add its own,
  // e.g. for `onLayout`, after the list's).
  const instances = FakeResizeObserver.instances;
  const ro =
    instances.findLast((r) => [...r.targets].some((el) => el.getAttribute(attr) !== null)) ??
      instances[instances.length - 1];
  for (let round = 0; round < rounds; round++) {
    const entries: unknown[] = [];
    for (const el of ro.targets) {
      const idx = el.getAttribute(attr);
      if (idx === null) continue;
      const size = truth(Number(idx));
      if (ro.reported.get(el) === size) continue;
      ro.reported.set(el, size);
      entries.push({ target: el, borderBoxSize: [{ blockSize: size, inlineSize: size }] });
    }
    if (entries.length === 0) return;
    await act(() => ro.cb(entries));
  }
}

export const all = (screen: { container: TestElement }): DomEl[] =>
  walkElements(screen.container as DomEl);
export const scrollerOf = (screen: { container: TestElement }): DomEl =>
  all(screen).find((e) => e.getAttribute("data-denext-virtual-list") !== null)!;
const listOf = (screen: { container: TestElement }): DomEl =>
  all(screen).find((e) => e.getAttribute("role") === "list")!;
const renderedRows = (screen: { container: TestElement }): DomEl[] =>
  all(screen).filter((e) => e.getAttribute("data-vl-row") !== null);
export const indices = (screen: { container: TestElement }): number[] =>
  renderedRows(screen).map((e) => Number(e.getAttribute("data-index")));
export const rowAt = (screen: { container: TestElement }, i: number): DomEl | undefined =>
  renderedRows(screen).find((e) => e.getAttribute("data-index") === String(i));

/** A CSS length out of an element's style attribute. */
export function styleLength(el: DomEl, name: string): number {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*(-?[\\d.]+)px`).exec(
    el.getAttribute("style") ?? "",
  );
  return m ? Number(m[1]) : 0;
}
export const styleHas = (el: DomEl, text: string): boolean =>
  (el.getAttribute("style") ?? "").includes(text);

/** Each rendered in-flow row's top relative to the viewport (the flow-layout simulator). */
export function visualTops(
  screen: { container: TestElement },
  truth: (i: number) => number,
): Map<number, number> {
  const list = listOf(screen);
  const scrollTop = Number((scrollerOf(screen) as unknown as { scrollTop?: number }).scrollTop) ||
    0;
  let y = styleLength(list, "margin-top");
  const tops = new Map<number, number>();
  for (const row of list.children) {
    if (styleHas(row, "position:absolute")) continue;
    const i = Number(row.getAttribute("data-index"));
    tops.set(i, y - scrollTop);
    y += truth(i) + styleLength(row, "margin-bottom");
  }
  return tops;
}

/** Scroll the list's own scroller to `top` (as the user) and dispatch `scroll`. */
export async function scrollTo(screen: { container: TestElement }, top: number): Promise<void> {
  const el = scrollerOf(screen) as unknown as { scrollTop: number };
  el.scrollTop = top;
  await act(() => fireEventOn(scrollerOf(screen), "scroll"));
}

/** A `VirtualList` element. */
export function list<T>(props: VirtualListProps<T>): VNode {
  return h(
    VirtualList as unknown as (p: Record<string, unknown>) => VNode,
    props as unknown as Record<string, unknown>,
  );
}

/** Wait `ms` real milliseconds inside `act`. */
export const wait = (ms: number): Promise<void> =>
  act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** Temporarily set globals (restored, or deleted when absent before). */
export async function withTempGlobals<R>(
  values: Record<string, unknown>,
  fn: () => Promise<R>,
): Promise<R> {
  const g = globalThis as unknown as Record<string, unknown>;
  const had = new Map<string, { present: boolean; value: unknown }>();
  for (const k of Object.keys(values)) {
    had.set(k, { present: k in g, value: g[k] });
    g[k] = values[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of had) {
      if (v.present) g[k] = v.value;
      else delete g[k];
    }
  }
}
