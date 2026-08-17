/// <reference path="../globals.d.ts" />
// Streaming server rendering with Suspense.
//
// The shell (with a placeholder <div> per Suspense boundary showing its
// fallback) is flushed first; each boundary's real content streams in as it
// resolves, followed by an inline script that swaps it into place.
//
// Concurrency note: async boundary renders interleave, but the global hook
// dispatcher is only read during a component's *synchronous* execution, so we
// bind the active provider scopes immediately before each component call.

import { FRAGMENT, PORTAL, type VNode, type VNodeChild, type VNodeChildren } from "./types.ts";
import {
  type Context,
  type Dispatcher,
  MEMO_CACHE_SENTINEL,
  setDispatcher,
} from "../runtime/hooks.ts";
import { PROVIDER } from "../runtime/context.ts";
import { isThenable, SUSPENSE } from "../runtime/suspense.ts";
import { ERROR_BOUNDARY, isControlSignal, toError } from "../runtime/error-boundary.ts";
import {
  escapeHtml,
  resolveContextType,
  serializeAttributes,
  VOID_ELEMENTS,
  warnDangerousHtml,
} from "./render-to-string.ts";
import "../runtime/class-flag.ts";
import { classComponentsDisabledError, isClassComponent } from "../compat/class-detect.ts";
import { renderClassToVNode } from "../compat/class-component.ts";
import { invokeComponent, isComponentType, resolveComponentType } from "../runtime/react-brands.ts";
import { enterScope, type IdHolder, nextId, rootScope, scopePrefix } from "./tree-id.ts";

type ProviderScope = Map<symbol, unknown>;

/** Inline runtime that swaps a resolved boundary's content into its placeholder. */
export const SWAP_RUNTIME =
  `<script>window.__dnxSwap=function(i){var t=document.querySelector('template[data-dnx-r="'+i+'"]'),s=document.querySelector('[data-dnx-b="'+i+'"]');if(t&&s){s.innerHTML='';s.appendChild(t.content.cloneNode(true));t.remove();}};</script>`;

class StreamRenderer {
  private id = 0;
  /**
   * Path-based useId state. Each Suspense boundary's content is rooted at the
   * boundary's position. Sibling subtrees render concurrently (Promise.all), so —
   * as with the pre-existing counter — the interior useId ordering of concurrently
   * rendering siblings/boundaries keeps the documented streaming caveat.
   */
  readonly ids: IdHolder = { scope: rootScope() };
  /** In-flight boundary renders, each resolving to its id + html. */
  readonly active = new Set<Promise<{ id: string; html: string }>>();
  private activeScopes: ProviderScope[] = [];
  private readonly dispatcher: Dispatcher;

  constructor() {
    this.dispatcher = this.makeDispatcher();
  }

  private makeDispatcher(): Dispatcher {
    // deno-lint-ignore no-this-alias -- captured for the plain-method closures below.
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
        return nextId(self.ids.scope);
      },
      useSyncExternalStore<T>(
        _subscribe: (onChange: () => void) => () => void,
        getSnapshot: () => T,
        getServerSnapshot?: () => T,
      ): T {
        return (getServerSnapshot ?? getSnapshot)();
      },
      useLayoutEffect() {},
      useInsertionEffect() {},
      useMemoCache(size: number): unknown[] {
        return new Array(size).fill(MEMO_CACHE_SENTINEL);
      },
    };
  }

  /** Render children, retrying whenever a descendant suspends. */
  async resolve(
    children: VNodeChildren,
    scopes: ProviderScope[],
    idRoot?: IdHolder["scope"],
  ): Promise<string> {
    for (;;) {
      if (idRoot) {
        idRoot.count = 0;
        idRoot.local = 0;
        this.ids.scope = idRoot;
      }
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

  async renderChildren(
    children: VNodeChildren,
    scopes: ProviderScope[],
  ): Promise<string> {
    if (Array.isArray(children)) {
      const parts = await Promise.all(
        children.map((c) => this.renderChild(c, scopes)),
      );
      return parts.join("");
    }
    return this.renderChild(children as VNodeChild, scopes);
  }

  renderChild(child: VNodeChild, scopes: ProviderScope[]): string | Promise<string> {
    if (child == null || child === false || child === true) return "";
    // React flattens arbitrarily-nested children arrays (parity with the other renderers).
    if (Array.isArray(child)) return this.renderChildren(child as VNodeChildren, scopes);
    if (typeof child === "string") return escapeHtml(child);
    if (typeof child === "number") return escapeHtml(String(child));
    return this.renderVNode(child as VNode, scopes);
  }

  async renderVNode(node: VNode, scopes: ProviderScope[]): Promise<string> {
    const { type } = node;
    // Some npm libraries construct elements with a null `props`; React treats it as {}.
    const props = node.props ?? {};

    // Portal: targets a client DOM node absent during SSR — emit nothing.
    if ((type as unknown) === PORTAL) return "";

    // Suspense boundary: emit fallback now; stream real content later. The boundary
    // is its own id scope (one slot in its parent); its streamed content is rooted
    // at that position so it reproduces the client's ids.
    if ((type as unknown) === SUSPENSE) {
      const id = `dnx${this.id++}`;
      const parentScope = this.ids.scope;
      const boundaryScope = enterScope(parentScope);
      this.active.add(
        this.resolve(props.children, scopes, rootScope(scopePrefix(boundaryScope)))
          .then((html) => ({ id, html })),
      );
      this.ids.scope = boundaryScope;
      let fallbackHtml: string;
      try {
        fallbackHtml = await this.renderChildren(props.fallback as VNodeChildren, scopes);
      } finally {
        this.ids.scope = parentScope;
      }
      return `<div data-dnx-b="${id}">${fallbackHtml}</div>`;
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

    // Error boundary (id-transparent; the fallback renders from the pre-children
    // scope state so its ids line up with the client's).
    if ((type as unknown) === ERROR_BOUNDARY) {
      const idScope = this.ids.scope;
      const savedCount = idScope.count;
      const savedLocal = idScope.local;
      try {
        return await this.renderChildren(props.children, scopes);
      } catch (err) {
        if (isThenable(err) || isControlSignal(err)) throw err;
        this.ids.scope = idScope;
        idScope.count = savedCount;
        idScope.local = savedLocal;
        const Fallback = props.fallback as (
          p: { error: Error; reset: () => void },
        ) => VNode;
        setDispatcher(this.dispatcher);
        this.activeScopes = scopes;
        const node = Fallback({ error: toError(err), reset: () => {} });
        const resolved = node instanceof Promise ? await node : node;
        return this.renderChild(resolved as VNodeChild, scopes);
      }
    }

    // Function component (or a memo/forwardRef object wrapper). Each opens a fresh
    // id scope (one slot in its parent) so its ids derive from its tree position.
    if (isComponentType(type)) {
      setDispatcher(this.dispatcher);
      this.activeScopes = scopes;
      const parentScope = this.ids.scope;
      this.ids.scope = enterScope(parentScope);
      try {
        if (isClassComponent(type)) {
          if (__DENEXT_CLASS_COMPONENTS__) {
            return await this.renderChild(
              renderClassToVNode(type, props, resolveContextType(type, scopes)) as VNodeChild,
              scopes,
            );
          }
          throw classComponentsDisabledError();
        }
        const result = invokeComponent(resolveComponentType(type), props);
        const resolved = result instanceof Promise ? await result : result;
        return await this.renderChild(resolved as VNodeChild, scopes);
      } finally {
        this.ids.scope = parentScope;
      }
    }

    // Host element.
    const tag = type as string;
    const attrs = serializeAttributes(props, tag);
    if (VOID_ELEMENTS.has(tag)) return `<${tag}${attrs}>`;

    const dangerous = props.dangerouslySetInnerHTML as
      | { __html: string }
      | undefined;
    if (dangerous && typeof dangerous.__html === "string") {
      warnDangerousHtml(tag);
      return `<${tag}${attrs}>${dangerous.__html}</${tag}>`;
    }

    const inner = await this.renderChildren(props.children, scopes);
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }
}

/** Options for {@link renderToReadableStream}. */
export interface StreamOptions {
  /** Aborts streaming when signaled; pending boundaries stop being flushed. */
  signal?: AbortSignal;
  /** Prepended to the very first chunk (e.g. "<!DOCTYPE html>..."). */
  shellPrefix?: string;
  /** Appended after all boundaries resolve (e.g. "</body></html>"). */
  shellSuffix?: string;
}

/**
 * Render a VNode tree to a streaming HTML `ReadableStream<Uint8Array>`,
 * resolving Suspense boundaries progressively.
 */
export function renderToReadableStream(
  node: VNodeChildren,
  options: StreamOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const renderer = new StreamRenderer();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const shell = await renderer.resolve(node, []);
        const head = (options.shellPrefix ?? "") + SWAP_RUNTIME + shell;
        controller.enqueue(encoder.encode(head));

        while (renderer.active.size > 0) {
          if (options.signal?.aborted) break;
          // Race the pending boundaries; identify and remove the settled one.
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

        if (options.shellSuffix) {
          controller.enqueue(encoder.encode(options.shellSuffix));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/** Collect a render stream into a single string (useful for tests/SSR-to-string). */
export async function streamToString(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) out += decoder.decode(chunk);
  return out;
}
