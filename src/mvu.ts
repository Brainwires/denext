/**
 * `denext/mvu` — Model–View–Update in the browser, opt-in.
 *
 * A program is plain functions: `init` gives the first model (and effects), `update(msg, model)`
 * returns the next model and the effects to run, `view(model, send)` renders it, and an optional
 * `subscriptions(model)` keeps timers and channels open while the model asks for them. Effects
 * are data ({@link fx}) — a fetch, a delay, a task — so `update` stays pure and testable:
 *
 * ```tsx
 * "use client";
 * import { fx, type Next, subs, useMvu } from "denext/mvu";
 *
 * type Model = { n: number; running: boolean };
 * type Msg = { type: "inc" } | { type: "toggle" } | { type: "saved" };
 *
 * function update(msg: Msg, m: Model): Next<Model, Msg> {
 *   switch (msg.type) {
 *     case "inc":
 *       return [{ ...m, n: m.n + 1 }, [fx.fetch("/api/save", { ok: () => ({ type: "saved" }) })]];
 *     case "toggle":
 *       return [{ ...m, running: !m.running }];
 *     case "saved":
 *       return [m];
 *   }
 * }
 *
 * export function Counter() {
 *   const [model, dispatch] = useMvu(
 *     () => [{ n: 0, running: false }],
 *     update,
 *     (m) => [m.running && subs.interval(1000, { type: "inc" })],
 *   );
 *   return <button type="button" onClick={() => dispatch({ type: "inc" })}>{model.n}</button>;
 * }
 * ```
 *
 * The same program — {@link defineMvu} with a `view` — renders in the browser with
 * {@link MvuView}, or on the server as a live view with `defineLiveView` from `denext/live`
 * (state held per connection, DOM events over the Live socket).
 *
 * In `denext dev` every running program records its messages and models for the DevTools MVU
 * tab, which can step back to any of them (time travel). An app that never imports this module
 * bundles none of it.
 *
 * @module
 */

import { h } from "./jsx/jsx-runtime.ts";
import type { VNode } from "./jsx/types.ts";
import { useEffect, useMemo, useRef, useState } from "./runtime/hooks.ts";
import {
  createMvuEngine,
  eventPayload,
  type MvuEngine,
  type MvuHost,
  type MvuProgram,
  type Next,
  resolveMsg,
  type Send,
  type Subscriptions,
  type Update,
} from "./runtime/mvu.ts";

export {
  defineMvu,
  eventPayload,
  fx,
  type MvuProgram,
  type Next,
  type Send,
  subs,
  type Subscriptions,
  type Update,
} from "./runtime/mvu.ts";
export type {
  ChannelLike,
  ChannelSubscription,
  DelayEffect,
  DispatchEffect,
  Effect,
  EffectConstructors,
  EventBinding,
  EventPayload,
  FetchEffect,
  IntervalSubscription,
  MsgSource,
  Subscription,
  SubscriptionConstructors,
  TaskEffect,
  View,
} from "./runtime/mvu.ts";

/** Options for {@link useMvu}. */
export interface UseMvuOptions {
  /** The name the DevTools MVU tab lists this program under (default `"mvu"`). */
  name?: string;
}

/** The browser host: channel subscriptions ride the Live socket (loaded on first use). */
const browserHost: MvuHost = {
  channel(channelId, key, onPayload, onError) {
    let stopped = false;
    let stop: (() => void) | null = null;
    import("./client/live-client.ts").then((m) => {
      if (stopped) return;
      stop = m.subscribeChannel(channelId, key, (value) => onPayload(value), (info) => {
        onError(new Error(`channel ${channelId}/${key}: ${info.reason ?? info.code}`));
      });
    }).catch(onError);
    return () => {
      stopped = true;
      stop?.();
    };
  },
};

/**
 * Run a Model–View–Update program in a component. `init` runs once (on the server too, for
 * the first HTML); its effects, every later update's effects and the subscriptions run in the
 * browser only, and stop when the component unmounts.
 *
 * @param init The first model, and the effects to run once mounted: `() => [model, effects?]`.
 * @param update `(msg, model) => [model, effects?]`. The latest one passed is used.
 * @param subscriptions `(model) => [...]` — the subscriptions to keep open for this model.
 * @param options A name for the DevTools MVU tab.
 * @returns The current model and a stable `dispatch`.
 */
export function useMvu<Model, Msg>(
  init: () => Next<Model, Msg>,
  update: Update<Model, Msg>,
  subscriptions?: Subscriptions<Model, Msg>,
  options?: UseMvuOptions,
): readonly [Model, (msg: Msg) => void] {
  const [, rerender] = useState(0);
  const latest = useRef({ update, subscriptions });
  latest.current = { update, subscriptions };
  const engine = useRef<MvuEngine<Model, Msg> | null>(null);
  const dev = useRef<DevRecord | null>(null);
  if (engine.current === null) {
    engine.current = createMvuEngine<Model, Msg>({
      init: init(),
      update: () => latest.current.update,
      subscriptions: () => latest.current.subscriptions,
      host: browserHost,
      onChange: (model, msgs) => {
        dev.current?.record(msgs, model);
        rerender((n) => n + 1);
      },
    });
  }
  const running = engine.current;
  useEffect(() => {
    running.start();
    dev.current = registerDev(options?.name ?? "mvu", running);
    return () => {
      dev.current?.dispose();
      dev.current = null;
      running.stop();
    };
  }, [running]);
  return [running.model, running.dispatch];
}

/** Props for {@link MvuView}. */
export interface MvuViewProps<Model, Msg, Props> {
  /** The program (its `view` renders the model). */
  program: MvuProgram<Model, Msg, Props>;
  /** What `program.init` is called with. */
  props?: Props;
  /** The DevTools name (default `"mvu"`). */
  name?: string;
}

/**
 * Render a whole program in the browser: `useMvu` over its `init` / `update` / `subscriptions`,
 * and its `view` with a `send` that dispatches locally. The server twin is `defineLiveView`.
 *
 * @param props The program and its init props.
 * @returns The program's view.
 */
export function MvuView<Model, Msg, Props = void>(
  props: MvuViewProps<Model, Msg, Props>,
): VNode {
  const { program } = props;
  const [model, dispatch] = useMvu<Model, Msg>(
    () => program.init(props.props as Props),
    program.update,
    program.subscriptions,
    { name: props.name },
  );
  const send = useMemo<Send<Msg>>(() => (source) => (event) => {
    const msg = resolveMsg(source, eventPayload(event));
    if (msg !== null) dispatch(msg);
  }, [dispatch]);
  return h("div", { "data-dnx-mvu": "" }, program.view(model, send));
}

// ── DevTools time travel (dev only) ──────────────────────────────────────────

/** One recorded step: the message and the model it produced. */
interface DevStep {
  msg: unknown;
  model: unknown;
  at: number;
}

/** What the DevTools MVU tab reads (`globalThis.__denextMvu`). */
interface DevRecord {
  id: number;
  name: string;
  steps: DevStep[];
  /** The step on screen (the last one unless the user travelled back). */
  cursor: number;
  record(msgs: readonly unknown[], model: unknown): void;
  jump(index: number): void;
  dispose(): void;
}

/** Steps kept per program. */
const MAX_STEPS = 200;

let nextDevId = 0;

/** Record a program for the DevTools when the dev server set `__denextDev`; `null` otherwise. */
function registerDev<Model, Msg>(name: string, engine: MvuEngine<Model, Msg>): DevRecord | null {
  const g = globalThis as { __denextDev?: boolean; __denextMvu?: Map<number, DevRecord> };
  if (g.__denextDev !== true) return null;
  const registry = g.__denextMvu ??= new Map();
  let travelling = false;
  const rec: DevRecord = {
    id: ++nextDevId,
    name,
    steps: [{ msg: "(init)", model: engine.model, at: Date.now() }],
    cursor: 0,
    record(msgs, model) {
      if (travelling || msgs.length === 0) return;
      // A message after a jump continues from the step on screen: the undone future is dropped.
      rec.steps.length = rec.cursor + 1;
      for (const msg of msgs) rec.steps.push({ msg, model, at: Date.now() });
      if (rec.steps.length > MAX_STEPS) rec.steps.splice(0, rec.steps.length - MAX_STEPS);
      rec.cursor = rec.steps.length - 1;
    },
    jump(index) {
      const step = rec.steps[index];
      if (!step) return;
      rec.cursor = index;
      travelling = true;
      try {
        engine.setModel(step.model as Model);
      } finally {
        travelling = false;
      }
    },
    dispose() {
      registry.delete(rec.id);
    },
  };
  registry.set(rec.id, rec);
  return rec;
}
