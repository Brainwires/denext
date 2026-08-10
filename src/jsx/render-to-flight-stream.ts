/// <reference path="../globals.d.ts" />
// Streaming Flight rendering: stream the HTML shell (Suspense boundaries as
// placeholders that stream in as they resolve) while building the complete
// Flight payload in the SAME single pass, so `useId` stays aligned across the
// client boundary. The finished Flight payload is emitted as a `#__denext_flight`
// island at the end of the stream, its Suspense holes already filled — so the
// client hydrates the final tree without a row assembler.
//
// This mirrors `render-to-stream.ts` (HTML-only) for the Flight world. It is a
// capability module; the default request path renders non-streaming.

import { FRAGMENT, type VNode, type VNodeChild, type VNodeChildren } from "./types.ts";
import {
  type Context,
  type Dispatcher,
  MEMO_CACHE_SENTINEL,
  setDispatcher,
} from "../runtime/hooks.ts";
import { PROVIDER } from "../runtime/context.ts";
import { isThenable, SUSPENSE } from "../runtime/suspense.ts";
import { ERROR_BOUNDARY, isControlSignal, toError } from "../runtime/error-boundary.ts";
import { escapeHtml, serializeAttributes, VOID_ELEMENTS } from "./render-to-string.ts";
import "../runtime/class-flag.ts";
import { classComponentsDisabledError, isClassComponent } from "../compat/class-detect.ts";
import { renderClassToVNode } from "../compat/class-component.ts";
import { isServerAction } from "../runtime/server-action.ts";
import { clientRefOf } from "../runtime/client-reference.ts";
import { ID_BASE_PROP, serializeFlight } from "./render-to-html-flight.ts";
import type { FlightNode, FlightProps, FlightValue } from "./render-to-flight.ts";

type ProviderScope = Map<symbol, unknown>;

const SWAP_RUNTIME =
  `<script>window.__dnxSwap=function(i){var t=document.querySelector('template[data-dnx-r="'+i+'"]'),s=document.querySelector('[data-dnx-b="'+i+'"]');if(t&&s){s.innerHTML='';s.appendChild(t.content.cloneNode(true));t.remove();}};</script>`;

/** A Suspense hole in the Flight tree, filled once the boundary resolves. */
interface FlightHole {
  /** Discriminant: streamed Suspense hole. */
  $: "$";
  /** Boundary id (matches the streamed HTML swap id). */
  r: string;
}

interface Dual {
  html: string;
  flight: FlightNode;
}

const SKIP = Symbol("skip");

class StreamFlightRenderer {
  private id = 0;
  idCounter = 0;
  /** In-flight boundary renders: id + streamed html + resolved flight. */
  readonly active = new Set<Promise<{ id: string; html: string; flight: FlightNode }>>();
  /** Resolved boundary flights, spliced into the shell flight at the end. */
  readonly holes = new Map<string, FlightNode>();
  private activeScopes: ProviderScope[] = [];
  private readonly dispatcher: Dispatcher;

  constructor() {
    this.dispatcher = this.makeDispatcher();
  }

  private makeDispatcher(): Dispatcher {
    // deno-lint-ignore no-this-alias -- captured for the closures below.
    const self = this;
    return {
      useState<S>(initial: S | (() => S)) {
        const value = typeof initial === "function" ? (initial as () => S)() : initial;
        return [value, () => {}] as [S, () => void];
      },
      useReducer<S, A, I>(_r: (s: S, a: A) => S, initialArg: I, init?: (arg: I) => S) {
        return [init ? init(initialArg) : (initialArg as unknown as S), () => {}] as [
          S,
          () => void,
        ];
      },
      useEffect() {},
      useMemo<T>(factory: () => T) {
        return factory();
      },
      useRef<T>(initial: T) {
        return { current: initial };
      },
      useContext<T>(context: Context<T>): T {
        const scopes = self.activeScopes;
        for (let i = scopes.length - 1; i >= 0; i--) {
          if (scopes[i].has(context._id)) return scopes[i].get(context._id) as T;
        }
        return context._defaultValue;
      },
      useId(): string {
        return `:d${self.idCounter++}:`;
      },
      useSyncExternalStore<T>(
        _s: (o: () => void) => () => void,
        getSnapshot: () => T,
        getServerSnapshot?: () => T,
      ): T {
        return (getServerSnapshot ?? getSnapshot)();
      },
      useLayoutEffect() {},
      useMemoCache(size: number): unknown[] {
        return new Array(size).fill(MEMO_CACHE_SENTINEL);
      },
    };
  }

  async resolve(children: VNodeChildren, scopes: ProviderScope[]): Promise<Dual> {
    for (;;) {
      try {
        return await this.renderChildren(children, scopes);
      } catch (err) {
        if (isThenable(err)) {
          await err;
          continue;
        }
        throw err;
      }
    }
  }

  async renderChildren(children: VNodeChildren, scopes: ProviderScope[]): Promise<Dual> {
    const arr = Array.isArray(children) ? children : children == null ? [] : [children];
    let html = "";
    const flight: FlightNode[] = [];
    for (const c of arr) {
      const d = await this.renderChild(c, scopes);
      html += d.html;
      flight.push(d.flight);
    }
    return { html, flight };
  }

  renderChild(child: VNodeChild, scopes: ProviderScope[]): Dual | Promise<Dual> {
    if (child == null || child === false || child === true) return { html: "", flight: null };
    if (typeof child === "string") return { html: escapeHtml(child), flight: child };
    if (typeof child === "number") return { html: escapeHtml(String(child)), flight: child };
    if (Array.isArray(child)) return this.renderChildren(child, scopes);
    return this.renderVNode(child as VNode, scopes);
  }

  async renderVNode(node: VNode, scopes: ProviderScope[]): Promise<Dual> {
    const { type, props } = node;

    // Suspense: stream the HTML; the Flight tree gets a hole filled on resolve.
    if ((type as unknown) === SUSPENSE) {
      const id = `dnx${this.id++}`;
      this.active.add(
        this.resolve(props.children, scopes).then((d) => {
          this.holes.set(id, d.flight);
          return { id, html: d.html, flight: d.flight };
        }),
      );
      const fallback = await this.renderChildren(props.fallback as VNodeChildren, scopes);
      const hole = { $: "$", r: id } as FlightHole;
      return {
        html: `<div data-dnx-b="${id}">${fallback.html}</div>`,
        // The hole is a transient node type filled by fillHoles before emit.
        flight: hole as unknown as FlightNode,
      };
    }

    // Fragment / context provider.
    if (type === FRAGMENT) {
      const info = props[PROVIDER as unknown as string] as
        | { id: symbol; value: unknown }
        | undefined;
      if (info) {
        const scope: ProviderScope = new Map([[info.id, info.value]]);
        return this.renderChildren(props.children, [...scopes, scope]);
      }
      return this.renderChildren(props.children, scopes);
    }

    // Error boundary.
    if ((type as unknown) === ERROR_BOUNDARY) {
      try {
        return await this.renderChildren(props.children, scopes);
      } catch (err) {
        if (isThenable(err) || isControlSignal(err)) throw err;
        const Fallback = props.fallback as (p: { error: Error; reset: () => void }) => VNode;
        setDispatcher(this.dispatcher);
        this.activeScopes = scopes;
        const fb = Fallback({ error: toError(err), reset: () => {} });
        const resolved = fb instanceof Promise ? await fb : fb;
        return this.renderChild(resolved as VNodeChild, scopes);
      }
    }

    // Function component.
    if (typeof type === "function") {
      const ref = clientRefOf(type);
      if (ref) {
        const base = this.idCounter;
        setDispatcher(this.dispatcher);
        this.activeScopes = scopes;
        const rendered = (type as (p: unknown) => VNode | Promise<VNode>)(props as never);
        const out = rendered instanceof Promise ? await rendered : rendered;
        const htmlDual = await this.renderChild(out as VNodeChild, scopes);
        const p = await this.serializeProps(props, scopes);
        p[ID_BASE_PROP] = base;
        const childFlight = await this.flightChildren(props.children, scopes);
        return { html: htmlDual.html, flight: { $: "c", i: ref.id, p, c: childFlight } };
      }
      setDispatcher(this.dispatcher);
      this.activeScopes = scopes;
      if (isClassComponent(type)) {
        if (__DENEXT_CLASS_COMPONENTS__) {
          return this.renderChild(renderClassToVNode(type, props, undefined) as VNodeChild, scopes);
        }
        throw classComponentsDisabledError();
      }
      const result = type(props as never);
      const resolved = result instanceof Promise ? await result : result;
      return this.renderChild(resolved as VNodeChild, scopes);
    }

    // Host element.
    const tag = type as string;
    const attrs = serializeAttributes(props);
    const p = await this.serializeProps(props, scopes);
    if (VOID_ELEMENTS.has(tag)) {
      return { html: `<${tag}${attrs}>`, flight: { $: "h", t: tag, p, c: [] } };
    }
    const dangerous = props.dangerouslySetInnerHTML as { __html: string } | undefined;
    if (dangerous && typeof dangerous.__html === "string") {
      return {
        html: `<${tag}${attrs}>${dangerous.__html}</${tag}>`,
        flight: { $: "h", t: tag, p, c: [] },
      };
    }
    const inner = await this.renderChildren(props.children, scopes);
    return {
      html: `<${tag}${attrs}>${inner.html}</${tag}>`,
      flight: { $: "h", t: tag, p, c: Array.isArray(inner.flight) ? inner.flight : [inner.flight] },
    };
  }

  // Flight-only child serialization (for client-island holes).
  async flightChildren(children: VNodeChildren, scopes: ProviderScope[]): Promise<FlightNode[]> {
    const arr = Array.isArray(children) ? children : children == null ? [] : [children];
    const out: FlightNode[] = [];
    for (const c of arr) out.push((await this.renderChild(c, scopes)).flight);
    return out;
  }

  async serializeProps(
    props: Record<string, unknown>,
    scopes: ProviderScope[],
  ): Promise<FlightProps> {
    const out: FlightProps = {};
    for (const [name, value] of Object.entries(props)) {
      if (name === "children" || name === "key" || name === "ref" || name === PROVIDER.toString()) {
        continue;
      }
      const sv = await this.serializeValue(value, scopes);
      if (sv !== SKIP) out[name] = sv as FlightValue;
    }
    return out;
  }

  async serializeValue(
    value: unknown,
    scopes: ProviderScope[],
  ): Promise<FlightValue | typeof SKIP> {
    if (value === undefined) return SKIP;
    if (value === null) return null;
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean") return value as FlightValue;
    if (isServerAction(value)) return { $: "a", i: value.denextActionId };
    if (t === "function") return SKIP;
    if (value instanceof Date) return { $: "D", v: value.toISOString() };
    if (Array.isArray(value)) {
      const items: FlightValue[] = [];
      for (const el of value) {
        const sv = await this.serializeValue(el, scopes);
        if (sv !== SKIP) items.push(sv as FlightValue);
      }
      return items;
    }
    if (isVNode(value)) {
      return (await this.renderChild(value as VNode, scopes)).flight as FlightValue;
    }
    if (t === "object") {
      const obj: Record<string, FlightValue> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const sv = await this.serializeValue(v, scopes);
        if (sv !== SKIP) obj[k] = sv as FlightValue;
      }
      return obj;
    }
    return SKIP;
  }
}

function isVNode(value: unknown): value is VNode {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

/** Recursively fill `{$:"$",r}` Suspense holes with their resolved Flight. */
function fillHoles(node: FlightNode, holes: Map<string, FlightNode>): FlightNode {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => fillHoles(n, holes));
  const tag = (node as { $?: string }).$;
  if (tag === "$") {
    const filled = holes.get((node as unknown as FlightHole).r);
    return filled === undefined ? null : fillHoles(filled, holes);
  }
  if (tag === "h" || tag === "c") {
    const n = node as { c: FlightNode[] };
    return { ...node, c: n.c.map((c) => fillHoles(c, holes)) } as FlightNode;
  }
  return node;
}

/** Options for {@linkcode renderToFlightStream}. */
export interface FlightStreamOptions {
  /** Aborts streaming when signaled. */
  signal?: AbortSignal;
  /** Prepended to the first chunk (e.g. the document head + opening body). */
  shellPrefix?: string;
  /** Appended after the Flight island (e.g. the client entry script + `</body>`). */
  shellSuffix?: string;
}

/**
 * Render a VNode tree to a streaming HTML `ReadableStream<Uint8Array>` that also
 * carries the complete Flight payload as a trailing `#__denext_flight` island.
 * Suspense boundaries stream progressively; the Flight payload is emitted once
 * all boundaries resolve, with their holes filled.
 *
 * @param node The tree to render.
 * @param options Shell prefix/suffix and abort signal.
 */
export function renderToFlightStream(
  node: VNodeChildren,
  options: FlightStreamOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const renderer = new StreamFlightRenderer();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const shell = await renderer.resolve(node, []);
        controller.enqueue(encoder.encode((options.shellPrefix ?? "") + SWAP_RUNTIME + shell.html));

        while (renderer.active.size > 0) {
          if (options.signal?.aborted) break;
          const settled = await Promise.race(
            [...renderer.active].map((p) => p.then((v) => ({ p, v }))),
          );
          renderer.active.delete(settled.p);
          const { id, html } = settled.v;
          controller.enqueue(
            encoder.encode(
              `<template data-dnx-r="${id}">${html}</template>` +
                `<script>__dnxSwap('${id}')</script>`,
            ),
          );
        }

        // Emit the complete Flight payload (holes filled) as the trailing island.
        // Unwrap a single root node so the payload mirrors the non-streaming form.
        let root = shell.flight;
        if (Array.isArray(root) && root.length === 1) root = root[0];
        const flight = fillHoles(root, renderer.holes);
        controller.enqueue(
          encoder.encode(
            `<script id="__denext_flight" type="application/json">${
              serializeFlight(flight)
            }</script>`,
          ),
        );
        if (options.shellSuffix) controller.enqueue(encoder.encode(options.shellSuffix));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
