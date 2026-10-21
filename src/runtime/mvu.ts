// Model–View–Update core, shared by `useMvu` (`denext/mvu`, in the browser) and the server-held
// `defineLiveView` (`denext/live`). Isomorphic and dependency-free: a program is three plain
// functions — `init`, `update(msg, model) → [model, effects]` and `view(model, send)` — plus an
// optional `subscriptions(model)`. Effects and subscriptions are DATA the runtime executes (a
// fetch, a timer, a task, a channel), so `update` stays a pure function you can unit-test with
// `assertEquals`.
//
// The engine here owns one program instance: it processes messages in order (a dispatch from
// inside an effect or a subscription is queued behind the current one), runs the effects each
// update returns, keeps the subscriptions in step with the model (keyed: an unchanged one keeps
// running, a dropped one stops) and tears all of it down on `stop()`. The host decides where a
// channel subscription goes (the Live socket in the browser, the channel transport on the
// server) and in what context an effect runs (the server runs them as the connection's viewer).

import type { SyntheticEvent } from "../compat/react-types.ts";
import type { VNodeChildren } from "../jsx/types.ts";

/** What an `update` (or `init`) returns: the next model, and the effects to run. */
export type Next<Model, Msg> = readonly [Model, ReadonlyArray<Effect<Msg>>?];

/** The update function: a message and the current model in, the next model and effects out. */
export type Update<Model, Msg> = (msg: Msg, model: Model) => Next<Model, Msg>;

/** The model's active subscriptions; falsy entries are skipped (`cond && subs.interval(…)`). */
export type Subscriptions<Model, Msg> = (
  model: Model,
) => ReadonlyArray<Subscription<Msg> | null | false | undefined>;

/** Fetch `url` and turn the response into a message. */
export interface FetchEffect<Msg> {
  /** Discriminant. */
  readonly kind: "fetch";
  /** The URL to fetch. */
  readonly url: string;
  /** `fetch` options (the runtime adds its own abort signal). */
  readonly init?: RequestInit;
  /** How to read a 2xx body: `"json"` (default) or `"text"`. */
  readonly as?: "json" | "text";
  /** The message for a 2xx response, given its body. */
  // deno-lint-ignore no-explicit-any
  readonly ok: (data: any) => Msg;
  /** The message for a network error or a non-2xx response (`{ status }` on the latter). */
  readonly err?: (error: unknown) => Msg;
}

/** Dispatch `msg` after `ms` milliseconds (cancelled when the program stops). */
export interface DelayEffect<Msg> {
  /** Discriminant. */
  readonly kind: "delay";
  /** The delay in milliseconds. */
  readonly ms: number;
  /** The message to dispatch. */
  readonly msg: Msg;
}

/** Run an async function and turn its result into a message. */
export interface TaskEffect<Msg> {
  /** Discriminant. */
  readonly kind: "task";
  /** The work; `signal` aborts when the program stops. */
  readonly run: (signal: AbortSignal) => unknown;
  /** The message for the resolved value (none: the result is dropped). */
  // deno-lint-ignore no-explicit-any
  readonly ok?: (value: any) => Msg;
  /** The message for a rejection (none: the error is logged). */
  readonly err?: (error: unknown) => Msg;
}

/** Dispatch `msg` right after the current update (a follow-up message). */
export interface DispatchEffect<Msg> {
  /** Discriminant. */
  readonly kind: "dispatch";
  /** The message to dispatch. */
  readonly msg: Msg;
}

/** Work an update asks the runtime to do. Plain data: compare it in tests. */
export type Effect<Msg> =
  | FetchEffect<Msg>
  | DelayEffect<Msg>
  | TaskEffect<Msg>
  | DispatchEffect<Msg>;

/** Dispatch `msg` every `ms` milliseconds while the subscription is active. */
export interface IntervalSubscription<Msg> {
  /** Discriminant. */
  readonly kind: "interval";
  /** The period in milliseconds. */
  readonly ms: number;
  /** The message to dispatch on each tick. */
  readonly msg: Msg;
  /** Tells apart two intervals with the same period. */
  readonly key?: string;
}

/** A channel reference as `createChannel` exports it (server) or its browser stub. */
export interface ChannelLike {
  /** The channel's id. */
  readonly denextChannelId?: string;
  /** The `"use server"` stub's id. */
  readonly denextActionId?: string;
}

/** Turn each payload a `createChannel` channel publishes for `key` into a message. */
export interface ChannelSubscription<Msg> {
  /** Discriminant. */
  readonly kind: "channel";
  /** The channel. */
  readonly channel: ChannelLike;
  /** The key within the channel. */
  readonly key: string;
  /** The message for one payload. */
  // deno-lint-ignore no-explicit-any
  readonly msg: (payload: any) => Msg;
}

/** A source of messages the runtime keeps open while the model asks for it. */
export type Subscription<Msg> = IntervalSubscription<Msg> | ChannelSubscription<Msg>;

/** The parts of a DOM event a message can be built from (and the server validates). */
export interface EventPayload {
  /** The target's `value` (an input, a select, a textarea). */
  value?: string;
  /** The target's `checked` (a checkbox or a radio). */
  checked?: boolean;
  /** The pressed key (a keyboard event). */
  key?: string;
  /** A submitted form's text fields (a `submit` event; files are left out). */
  form?: Record<string, string>;
}

/** A message, or a function building one from the event (`null` dispatches nothing). */
export type MsgSource<Msg> = Msg | ((payload: EventPayload) => Msg | null | undefined);

/**
 * What `send(…)` returns: an event handler for any `on*` prop. It takes the synthetic event a
 * JSX handler receives (`onClick`, `onSubmit`, `onInput`, …) or a DOM `Event`
 * (`addEventListener`), and reads only its target, `key` and type.
 */
// deno-lint-ignore no-explicit-any -- any element / native event, as each `on*` prop narrows it
export type EventBinding = (event: Event | SyntheticEvent<any, any>) => void;

/**
 * Bind a message to an event: `onClick={send({ type: "inc" })}`, or with the event's payload
 * `onInput={send((e) => ({ type: "typed", text: e.value ?? "" }))}`.
 */
export type Send<Msg> = (msg: MsgSource<Msg>) => EventBinding;

/** Render the model; bind events with `send`. */
export type View<Model, Msg> = (model: Model, send: Send<Msg>) => VNodeChildren;

/** A whole program: runs in the browser with `useMvu` / `MvuView`, or on the server as a live view. */
export interface MvuProgram<Model, Msg, Props = void> {
  /** The first model (and effects), from the props it is mounted with. */
  init: (props: Props) => Next<Model, Msg>;
  /** The update function. */
  update: Update<Model, Msg>;
  /** The view. */
  view: View<Model, Msg>;
  /** The model's subscriptions. */
  subscriptions?: Subscriptions<Model, Msg>;
}

/** The effect constructors ({@link fx}). Each returns plain data the runtime runs after the update. */
export interface EffectConstructors {
  /**
   * Fetch `url`; `ok` gets the body of a 2xx response (`as: "json"` by default), `err` a network
   * error or `{ status }` for any other status.
   */
  fetch<Msg>(
    url: string,
    opts: {
      init?: RequestInit;
      as?: "json" | "text";
      // deno-lint-ignore no-explicit-any
      ok: (data: any) => Msg;
      err?: (error: unknown) => Msg;
    },
  ): FetchEffect<Msg>;
  /** Dispatch `msg` after `ms` milliseconds. */
  delay<Msg>(ms: number, msg: Msg): DelayEffect<Msg>;
  /** Run `run(signal)`; `ok` / `err` turn its outcome into a message. */
  task<Msg, T = unknown>(
    run: (signal: AbortSignal) => T | Promise<T>,
    ok?: (value: T) => Msg,
    err?: (error: unknown) => Msg,
  ): TaskEffect<Msg>;
  /** Dispatch `msg` right after the current update. */
  dispatch<Msg>(msg: Msg): DispatchEffect<Msg>;
}

/** Effect constructors. Each returns plain data; the runtime runs it after the update. */
export const fx: EffectConstructors = {
  fetch(url, opts) {
    return { kind: "fetch", url, ...opts };
  },
  delay(ms, msg) {
    return { kind: "delay", ms, msg };
  },
  task(run, ok, err) {
    return {
      kind: "task",
      run,
      ...(ok ? { ok: ok as (value: unknown) => never } : {}),
      ...(err ? { err } : {}),
    };
  },
  dispatch(msg) {
    return { kind: "dispatch", msg };
  },
};

/** The subscription constructors ({@link subs}). */
export interface SubscriptionConstructors {
  /** Dispatch `msg` every `ms` milliseconds (`key` tells apart two with the same period). */
  interval<Msg>(ms: number, msg: Msg, key?: string): IntervalSubscription<Msg>;
  /** Turn each payload `channel` publishes for `key` into a message. */
  channel<T, Msg>(
    channel: ChannelLike & { readonly __channel?: { payload: T } },
    key: string,
    msg: (payload: T) => Msg,
  ): ChannelSubscription<Msg>;
}

/** Subscription constructors. */
export const subs: SubscriptionConstructors = {
  interval(ms, msg, key) {
    return { kind: "interval", ms, msg, ...(key !== undefined ? { key } : {}) };
  },
  channel(channel, key, msg) {
    return { kind: "channel", channel, key, msg: msg as (payload: unknown) => never };
  },
};

/**
 * Identity, for inference: write the program once and run it with `useMvu` / `MvuView` in the
 * browser or `defineLiveView` on the server.
 *
 * @param program The program.
 * @returns The same program.
 */
export function defineMvu<Model, Msg, Props = void>(
  program: MvuProgram<Model, Msg, Props>,
): MvuProgram<Model, Msg, Props> {
  return program;
}

/** The id a channel subscription subscribes by, or `undefined` when the ref carries none. */
function channelIdOf(channel: ChannelLike): string | undefined {
  return channel.denextChannelId ?? channel.denextActionId;
}

/** Where the engine runs its effects and subscriptions. */
export interface MvuHost {
  /**
   * Open a channel subscription; returns its stop. `onError` ends it (a refusal). Absent: a
   * channel subscription reports an error.
   */
  channel?(
    channelId: string,
    key: string,
    onPayload: (payload: unknown) => void,
    onError: (error: unknown) => void,
  ): () => void;
  /** Run an effect's async work (the server runs it as the connection's viewer). */
  run?<T>(work: () => Promise<T>): Promise<T>;
  /** Resolve a fetch effect's URL (the server resolves a relative one against the page origin). */
  resolveUrl?(url: string): string;
  /** A failure no message handles (an effect without `err`, a refused subscription). */
  onError?(error: unknown): void;
  /** Shortest interval, in ms (default 16). */
  minIntervalMs?: number;
  /** Effects (fetches, tasks, delays) that may be pending at once (default unlimited). */
  maxPending?: number;
  /** Subscriptions that may be active at once (default unlimited). */
  maxSubscriptions?: number;
}

/** A running program. */
export interface MvuEngine<Model, Msg> {
  /** The current model. */
  readonly model: Model;
  /** Queue a message; processed in order, synchronously unless one is already being processed. */
  dispatch(msg: Msg): void;
  /** Run the initial effects and open the subscriptions. Repeatable after `stop()`. */
  start(): void;
  /** Cancel pending effects and close every subscription; dispatches are ignored until `start`. */
  stop(): void;
  /** Replace the model (time travel); the subscriptions follow it. */
  setModel(model: Model): void;
}

/** Engine options. */
export interface MvuEngineOptions<Model, Msg> {
  /** What `init` returned. */
  init: Next<Model, Msg>;
  /** The update function (read on every message, so a newer one takes over). */
  update: () => Update<Model, Msg>;
  /** The subscriptions function (read on every sync). */
  subscriptions?: () => Subscriptions<Model, Msg> | undefined;
  /** Where effects and subscriptions run. */
  host?: MvuHost;
  /** Called once per processed batch with the new model and the messages that produced it. */
  onChange?: (model: Model, msgs: readonly Msg[]) => void;
  /** Called when `update` throws (the message is dropped and the model kept). */
  onUpdateError?: (error: unknown, msg: Msg) => void;
}

interface ActiveSub<Msg> {
  latest: Subscription<Msg>;
  stop: () => void;
}

/** The identity two renders of the same subscription share. */
function subKey<Msg>(s: Subscription<Msg>): string {
  return s.kind === "interval"
    ? `i:${s.ms}:${s.key ?? ""}`
    : `c:${channelIdOf(s.channel) ?? ""}:${s.key}`;
}

/**
 * Create an engine for one program instance.
 *
 * @param opts The initial `[model, effects]`, the update function and the host.
 * @returns The engine (not started).
 */
export function createMvuEngine<Model, Msg>(
  opts: MvuEngineOptions<Model, Msg>,
): MvuEngine<Model, Msg> {
  const host = opts.host ?? {};
  let model = opts.init[0];
  const initEffects = opts.init[1] ?? [];
  let running = false;
  let ctrl = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const active = new Map<string, ActiveSub<Msg>>();
  /** Keys refused by `maxSubscriptions`, reported once until they fit or leave. */
  const refused = new Set<string>();
  const queue: Msg[] = [];
  let draining = false;
  let pending = 0;

  const fail = (error: unknown): void => {
    if (host.onError) host.onError(error);
    else console.error("denext mvu:", error);
  };

  const dispatch = (msg: Msg): void => {
    if (!running) return;
    queue.push(msg);
    if (draining) return;
    draining = true;
    const effects: Effect<Msg>[] = [];
    const processed: Msg[] = [];
    try {
      while (queue.length > 0) {
        const next = queue.shift() as Msg;
        let result: Next<Model, Msg>;
        try {
          result = opts.update()(next, model);
        } catch (err) {
          if (opts.onUpdateError) opts.onUpdateError(err, next);
          else fail(err);
          continue;
        }
        model = result[0];
        processed.push(next);
        if (result[1]) effects.push(...result[1]);
      }
    } finally {
      draining = false;
    }
    if (processed.length === 0) return;
    opts.onChange?.(model, processed);
    syncSubscriptions();
    runEffects(effects);
  };

  /** Turn an effect outcome into a dispatch, or report it when no message handles it. */
  const settle = (toMsg: ((v: never) => Msg) | undefined, value: unknown, isError: boolean) => {
    if (!running) return;
    if (toMsg) {
      let msg: Msg;
      try {
        msg = (toMsg as (v: unknown) => Msg)(value);
      } catch (err) {
        return fail(err);
      }
      dispatch(msg);
    } else if (isError) fail(value);
  };

  const track = (
    work: () => Promise<unknown>,
    ok: ((v: never) => Msg) | undefined,
    err: ((e: never) => Msg) | undefined,
  ): void => {
    if (host.maxPending !== undefined && pending >= host.maxPending) {
      return settle(err, new Error("too many pending effects"), true);
    }
    pending++;
    const runWork = host.run ? () => host.run!(work) : work;
    let started: Promise<unknown>;
    try {
      started = Promise.resolve(runWork());
    } catch (e) {
      started = Promise.reject(e);
    }
    started.then(
      (v) => settle(ok, v, false),
      (e) => settle(err, e, true),
    ).finally(() => pending--);
  };

  const runFetch = (e: FetchEffect<Msg>, signal: AbortSignal): void => {
    track(
      async () => {
        const url = host.resolveUrl ? host.resolveUrl(e.url) : e.url;
        const res = await fetch(url, { ...e.init, signal });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw { status: res.status };
        }
        return e.as === "text" ? await res.text() : await res.json();
      },
      e.ok,
      e.err,
    );
  };

  const runDelay = (e: DelayEffect<Msg>): void => {
    if (host.maxPending !== undefined && timers.size >= host.maxPending) {
      return fail(new Error("too many pending effects"));
    }
    const t = setTimeout(() => {
      timers.delete(t);
      dispatch(e.msg);
    }, Math.max(0, Number(e.ms) || 0));
    timers.add(t);
  };

  /** Each effect kind's runner. */
  const runners: { [K in Effect<Msg>["kind"]]: (e: Extract<Effect<Msg>, { kind: K }>) => void } = {
    dispatch: (e) => queueMicrotask(() => dispatch(e.msg)),
    delay: runDelay,
    fetch: (e) => runFetch(e, ctrl.signal),
    task: (e) => {
      const signal = ctrl.signal;
      track(async () => await e.run(signal), e.ok, e.err);
    },
  };

  const runEffect = (e: Effect<Msg>): void => {
    const kind = (e as { kind?: unknown } | null)?.kind;
    if (typeof kind === "string" && Object.hasOwn(runners, kind)) {
      return (runners[kind as Effect<Msg>["kind"]] as (e: Effect<Msg>) => void)(e);
    }
    fail(new TypeError(`unknown effect ${JSON.stringify(kind)}`));
  };

  const runEffects = (effects: ReadonlyArray<Effect<Msg>>): void => {
    for (const e of effects) runEffect(e);
  };

  const startSub = (s: Subscription<Msg>, entry: ActiveSub<Msg>): () => void => {
    if (s.kind === "interval") {
      const ms = Math.max(host.minIntervalMs ?? 16, Number(s.ms) || 0);
      const t = setInterval(() => dispatch((entry.latest as IntervalSubscription<Msg>).msg), ms);
      return () => clearInterval(t);
    }
    const id = channelIdOf(s.channel);
    if (!id || !host.channel) {
      fail(new Error(id ? "channel subscriptions are not available here" : "channel has no id"));
      return () => {};
    }
    return host.channel(id, s.key, (payload) => {
      const latest = entry.latest as ChannelSubscription<Msg>;
      settle(latest.msg as (v: never) => Msg, payload, false);
    }, fail);
  };

  /** The model's subscriptions, deduplicated by key (`null` when `subscriptions` threw). */
  const wantedSubs = (): Map<string, Subscription<Msg>> | null => {
    const fn = opts.subscriptions?.();
    const wanted = new Map<string, Subscription<Msg>>();
    try {
      for (const s of fn ? fn(model) : []) {
        if (s && !wanted.has(subKey(s))) wanted.set(subKey(s), s);
      }
    } catch (err) {
      fail(err);
      return null;
    }
    return wanted;
  };

  /** Open `s` under `key`, unless the host's cap is reached (reported once per key). */
  const open = (key: string, s: Subscription<Msg>): void => {
    if (host.maxSubscriptions !== undefined && active.size >= host.maxSubscriptions) {
      if (!refused.has(key)) fail(new Error("too many subscriptions"));
      refused.add(key);
      return;
    }
    refused.delete(key);
    const entry: ActiveSub<Msg> = { latest: s, stop: () => {} };
    active.set(key, entry);
    entry.stop = startSub(s, entry);
  };

  const syncSubscriptions = (): void => {
    if (!running) return;
    const wanted = wantedSubs();
    if (!wanted) return;
    for (const [key, s] of wanted) {
      const existing = active.get(key);
      if (existing) existing.latest = s;
      else open(key, s);
    }
    for (const key of refused) if (!wanted.has(key)) refused.delete(key);
    for (const [key, entry] of active) {
      if (wanted.has(key)) continue;
      active.delete(key);
      entry.stop();
    }
  };

  return {
    get model() {
      return model;
    },
    dispatch,
    start() {
      if (running) return;
      running = true;
      ctrl = new AbortController();
      syncSubscriptions();
      runEffects(initEffects);
    },
    stop() {
      if (!running) return;
      running = false;
      queue.length = 0;
      ctrl.abort(new DOMException("program stopped", "AbortError"));
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const entry of active.values()) entry.stop();
      active.clear();
      refused.clear();
    },
    setModel(next) {
      model = next;
      opts.onChange?.(model, []);
      syncSubscriptions();
    },
  };
}

/** The elements whose `value` / `checked` an event payload carries. */
const FORM_CONTROLS = new Set(["INPUT", "SELECT", "TEXTAREA"]);

/** Field caps on a submitted form's payload (the server enforces its own as well). */
const MAX_FORM_FIELDS = 64;

/**
 * The {@link EventPayload} of a DOM event: a form control target's `value` / `checked` (an
 * input, a select, a textarea), a keyboard event's `key`, and a submit's text fields. A `submit` is `preventDefault`ed (the program handles it).
 *
 * @param event The DOM event (anything else yields `{}`).
 * @returns The payload.
 */
export function eventPayload(event: unknown): EventPayload {
  const out: EventPayload = {};
  if (!event || typeof event !== "object") return out;
  const ev = event as Event & { key?: unknown };
  const target = ev.target as
    | (EventTarget & { value?: unknown; checked?: unknown; type?: unknown })
    | null;
  if (ev.type === "submit") {
    ev.preventDefault?.();
    const form = formFields(target);
    if (form) out.form = form;
    return out;
  }
  if (target && FORM_CONTROLS.has(String((target as { tagName?: unknown }).tagName))) {
    if (typeof target.value === "string") out.value = target.value;
    if (target.type === "checkbox" || target.type === "radio") {
      out.checked = target.checked === true;
    }
  }
  if (typeof ev.key === "string") out.key = ev.key;
  return out;
}

/** A form's string fields (files dropped), or `undefined` when `target` is not a form. */
function formFields(target: unknown): Record<string, string> | undefined {
  if (typeof FormData === "undefined" || typeof HTMLFormElement === "undefined") return undefined;
  if (!(target instanceof HTMLFormElement)) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [name, value] of new FormData(target)) {
    if (typeof value !== "string" || n >= MAX_FORM_FIELDS) continue;
    out[name] = value;
    n++;
  }
  return out;
}

/**
 * Resolve a {@link MsgSource} against an event payload.
 *
 * @param source The message, or the function building one.
 * @param payload The event's payload.
 * @returns The message, or `null` when the function declined.
 */
export function resolveMsg<Msg>(source: MsgSource<Msg>, payload: EventPayload): Msg | null {
  const msg = typeof source === "function"
    ? (source as (p: EventPayload) => Msg | null | undefined)(payload)
    : source;
  return msg ?? null;
}
