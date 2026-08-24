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
import {
  ERROR_BOUNDARY,
  isControlSignal,
  reportBoundaryError,
  toClientError,
} from "../runtime/error-boundary.ts";
import {
  escapeHtml,
  type HeadCollector,
  HOISTED_TAGS,
  resolveContextType,
  serializeAttributes,
  VOID_ELEMENTS,
  warnDangerousHtml,
} from "./render-to-string.ts";
export type { HeadCollector };
import "../runtime/class-flag.ts";
import { isServerAction } from "../runtime/server-action.ts";
import { classComponentsDisabledError, isClassComponent } from "../compat/class-detect.ts";
import { renderClassToVNode } from "../compat/class-component.ts";
import { invokeComponent, isComponentType, resolveComponentType } from "../runtime/react-brands.ts";
import { enterScope, type IdHolder, nextId, rootScope, scopePrefix } from "./tree-id.ts";
import { SWAP_RUNTIME } from "../server/swap-runtime.ts";

type ProviderScope = Map<symbol, unknown>;

/**
 * A pending streamed Suspense hole. It **resolves, never rejects**: on success
 * `{ id, html, ok: true }`; on a render error `{ id, html: "", ok: false }` (the
 * error is logged and the hole's shell fallback is left in place). Consumed by the
 * document stream assemblers, so one failing hole never tears down the response.
 */
export type PendingHole = Promise<{ id: string; html: string; ok: boolean }>;

class StreamRenderer {
  private id = 0;
  /**
   * Path-based useId state. Each Suspense boundary's content is rooted at the
   * boundary's position. Sibling subtrees render concurrently (Promise.all), so —
   * as with the pre-existing counter — the interior useId ordering of concurrently
   * rendering siblings/boundaries keeps the documented streaming caveat.
   */
  readonly ids: IdHolder = { scope: rootScope() };
  /**
   * In-flight boundary renders. Each **resolves, never rejects**, to its id + html
   * + an `ok` flag: a boundary whose render throws is logged and resolves `ok:false`
   * (its shell fallback stays) so ONE failing hole can't reject the race and tear
   * down the whole streamed document.
   */
  readonly active = new Set<PendingHole>();
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

  /**
   * Render children, retrying whenever a descendant suspends. `head`, when
   * present, collects in-tree `<title>`/`<meta>`/`<link>` for hoisting into the
   * document `<head>` — passed only for the shell render (it resolves before the
   * head flushes); a Suspense hole's own render gets `null` (its head, resolving
   * after the flush, stays inline).
   */
  async resolve(
    children: VNodeChildren,
    scopes: ProviderScope[],
    idRoot?: IdHolder["scope"],
    head: HeadCollector | null = null,
  ): Promise<string> {
    for (;;) {
      if (idRoot) {
        idRoot.count = 0;
        idRoot.local = 0;
        this.ids.scope = idRoot;
      }
      try {
        return await this.renderChildren(children, scopes, head);
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
    head: HeadCollector | null = null,
  ): Promise<string> {
    if (Array.isArray(children)) {
      const parts = await Promise.all(
        children.map((c) => this.renderChild(c, scopes, head)),
      );
      return parts.join("");
    }
    return this.renderChild(children as VNodeChild, scopes, head);
  }

  renderChild(
    child: VNodeChild,
    scopes: ProviderScope[],
    head: HeadCollector | null = null,
  ): string | Promise<string> {
    if (child == null || child === false || child === true) return "";
    // React flattens arbitrarily-nested children arrays (parity with the other renderers).
    if (Array.isArray(child)) return this.renderChildren(child as VNodeChildren, scopes, head);
    if (typeof child === "string") return escapeHtml(child);
    if (typeof child === "number") return escapeHtml(String(child));
    return this.renderVNode(child as VNode, scopes, head);
  }

  async renderVNode(
    node: VNode,
    scopes: ProviderScope[],
    head: HeadCollector | null = null,
  ): Promise<string> {
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
      // The hole's own render (and the fallback) do NOT hoist into `head`: they
      // resolve after the head has already flushed, so their head tags stay inline.
      // The id is captured here, so even a rejected render still reports it (ok:false)
      // — the hole's fallback stays and the rest of the document streams unaffected.
      this.active.add(
        this.resolve(props.children, scopes, rootScope(scopePrefix(boundaryScope)), null)
          .then((html) => ({ id, html, ok: true }))
          .catch((err) => {
            console.error("denext: streamed Suspense boundary failed to resolve:", id, err);
            return { id, html: "", ok: false };
          }),
      );
      this.ids.scope = boundaryScope;
      let fallbackHtml: string;
      try {
        fallbackHtml = await this.renderChildren(props.fallback as VNodeChildren, scopes, null);
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
        return this.renderChildren(props.children, [...scopes, scope], head);
      }
      return this.renderChildren(props.children, scopes, head);
    }

    // Error boundary (id-transparent; the fallback renders from the pre-children
    // scope state so its ids line up with the client's).
    if ((type as unknown) === ERROR_BOUNDARY) {
      const idScope = this.ids.scope;
      const savedCount = idScope.count;
      const savedLocal = idScope.local;
      try {
        return await this.renderChildren(props.children, scopes, head);
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
        reportBoundaryError(props, err);
        const node = Fallback({ error: toClientError(err), reset: () => {} });
        const resolved = node instanceof Promise ? await node : node;
        return this.renderChild(resolved as VNodeChild, scopes, head);
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
        return await this.renderChild(resolved as VNodeChild, scopes, head);
      } finally {
        this.ids.scope = parentScope;
      }
    }

    // Host element.
    const tag = type as string;
    let attrs = serializeAttributes(props, tag);
    // A <form> posting to a server action needs method=post for the no-JS path
    // (parity with render-to-string / render-to-html-flight — the shell must emit
    // a working action form, not one that defaults to GET).
    if (tag === "form" && isServerAction(props.action) && props.method == null) {
      attrs += ` method="post"`;
    }

    // React 19 document metadata: hoist in-tree <title>/<meta>/<link> into the head
    // collector (shell render only) instead of emitting them inline.
    if (head && HOISTED_TAGS.has(tag)) {
      if (tag === "title") {
        head.title = await this.renderChildren(props.children, scopes, null);
      } else {
        head.tags.push(`<${tag}${attrs}>`);
      }
      return "";
    }

    if (VOID_ELEMENTS.has(tag)) return `<${tag}${attrs}>`;

    const dangerous = props.dangerouslySetInnerHTML as
      | { __html: string }
      | undefined;
    if (dangerous && typeof dangerous.__html === "string") {
      warnDangerousHtml(tag);
      return `<${tag}${attrs}>${dangerous.__html}</${tag}>`;
    }

    const inner = await this.renderChildren(props.children, scopes, head);
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
          const { id, html, ok } = settled.v;
          if (!ok) continue; // failed hole: leave its shell fallback
          controller.enqueue(
            encoder.encode(`<template data-dnx-r="${id}">${html}</template>`),
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

/** A rendered shell plus its still-pending Suspense holes. */
export interface ShellRender {
  /** The shell HTML (each Suspense boundary a `data-dnx-b` placeholder). */
  shell: string;
  /**
   * The pending Suspense holes. Each {@link PendingHole} resolves (never rejects)
   * to its id + html + `ok` flag, so a document assembler can stream them via the
   * shared `streamHoles` helper: a failed hole (`ok:false`) is skipped (its shell
   * fallback stays) without tearing down the rest of the response.
   */
  holes: Set<PendingHole>;
}

/**
 * Two-phase streaming render: render the **shell** eagerly (awaitable, so a
 * control signal — `notFound()`/`redirect()`/… — thrown during it can be caught
 * and turned into a buffered response BEFORE any bytes flush), then expose the
 * pending Suspense holes for a document assembler to stream and frame.
 *
 * @param node The tree to render.
 * @param head Collector for in-tree `<title>`/`<meta>`/`<link>` (shell only), or null.
 * @returns The shell HTML and the pending {@link PendingHole holes}.
 */
export async function renderShell(
  node: VNodeChildren,
  head: HeadCollector | null,
): Promise<ShellRender> {
  const renderer = new StreamRenderer();
  const shell = await renderer.resolve(node, [], undefined, head);
  return { shell, holes: renderer.active };
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
