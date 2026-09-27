// Shared fakes for the denext/mobile UI-capability tests (keyboard, back, system bars, safe
// areas): globals installed for one test and restored, a faked Capacitor shell with plugins
// whose listeners the test can fire, a manual requestAnimationFrame queue, and a component
// mounted on the in-memory DOM.

import { createRoot, flushSync, setDocument } from "../../src/client/reconciler.ts";
import { h } from "../../src/jsx/jsx-runtime.ts";
import { makeDom } from "./dom.ts";

// deno-lint-ignore no-explicit-any
export type Any = any;
const g = globalThis as Any;

/** A minimal event target that records listeners and fires plain-object events. */
export class Target {
  private listeners = new Map<string, Set<(event: Any) => void>>();
  addEventListener(type: string, fn: (event: Any) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (event: Any) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  // Reached through `Any`-typed fakes (Object.assign(new Target(), …)), which fallow cannot see.
  // fallow-ignore-next-line unused-class-member
  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, ...event });
  }
  /** Total registered listeners across every event type. */
  // fallow-ignore-next-line unused-class-member
  count(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

/** Install `values` on globalThis for the duration of `fn`, then restore the originals. */
export async function withGlobals(
  values: Record<string, unknown>,
  fn: () => unknown | Promise<unknown>,
): Promise<void> {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(g, key));
    Object.defineProperty(g, key, { configurable: true, writable: true, value });
  }
  try {
    await fn();
  } finally {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(g, key, desc);
      else delete g[key];
    }
  }
}

/** A fake Capacitor plugin: `calls` records method calls; `fire` runs a listener. */
export interface FakePlugin {
  readonly plugin: Record<string, (arg?: unknown, fn?: unknown) => unknown>;
  readonly calls: Array<[string, unknown]>;
  /** Run every listener registered for `event` with `payload`. */
  fire(event: string, payload?: unknown): void;
  /** How many listeners are registered (all events). */
  listening(): number;
}

/**
 * A plugin with `methods` (each resolving `results[method]`) plus `addListener`, whose handles
 * arrive in a promise as `@capacitor/core` returns them.
 */
export function fakePlugin(methods: string[], results: Record<string, unknown> = {}): FakePlugin {
  const calls: Array<[string, unknown]> = [];
  const listeners = new Map<string, Set<(payload?: unknown) => void>>();
  const plugin: FakePlugin["plugin"] = {};
  for (const m of methods) {
    plugin[m] = (arg?: unknown) => {
      calls.push([m, arg]);
      const r = results[m];
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    };
  }
  plugin.addListener = (event: unknown, fn: unknown) => {
    const set = listeners.get(event as string) ?? new Set();
    listeners.set(event as string, set);
    set.add(fn as (payload?: unknown) => void);
    return Promise.resolve({ remove: () => void set.delete(fn as (payload?: unknown) => void) });
  };
  return {
    plugin,
    calls,
    fire: (event, payload) => {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(payload);
    },
    listening: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

/** Run `fn` inside a native `platform` shell whose `Plugins` are `plugins`. */
export function inShell(
  platform: "ios" | "android",
  plugins: Record<string, unknown>,
  fn: () => unknown | Promise<unknown>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const Capacitor = { isNativePlatform: () => true, getPlatform: () => platform, Plugins: plugins };
  return withGlobals({ Capacitor, ...extra }, fn);
}

/** Let pending promise callbacks (listener handles, plugin results) run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** A manually flushed requestAnimationFrame queue. */
export function frameQueue() {
  const queue = new Map<number, () => void>();
  let next = 0;
  return {
    queue,
    request: (cb: () => void) => (queue.set(++next, cb), next),
    cancel: (id: number) => void queue.delete(id),
    flush() {
      const cbs = [...queue.values()];
      queue.clear();
      for (const cb of cbs) cb();
    },
  };
}

/** A visual viewport of `height` px that fires `resize` / `scroll` on demand. */
export function fakeViewport(height: number, offsetTop = 0): Any {
  return Object.assign(new Target(), { height, offsetTop });
}

/** Mount a component on a fake DOM; `rerender` re-renders it, `container` holds the output. */
export function mount(render: () => unknown) {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  function Probe(_props: { n: number }) {
    return render();
  }
  const root = createRoot(container as Any);
  let n = 0;
  const rerender = () => {
    root.render(h(Probe as Any, { n: ++n }));
    flushSync();
  };
  rerender();
  return { root, rerender, container: container as Any, doc: doc as Any };
}
