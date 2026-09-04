/// <reference path="../globals.d.ts" />
// Server-side rendering: turn a VNode tree into an HTML string.
//
// Supports function components (sync or async), fragments, context providers,
// intrinsic elements, and correct HTML escaping. Hooks resolve through a
// read-only SSR dispatcher (state is initial-only; effects don't run).

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
import { actionEndpoint, isServerAction } from "../runtime/server-action.ts";
import { DNX_H_ATTR, isQrl } from "../runtime/qrl.ts";
import "../runtime/class-flag.ts";
import { classComponentsDisabledError, isClassComponent } from "../compat/class-detect.ts";
import { renderClassToVNode } from "../compat/class-component.ts";
import { invokeComponent, isComponentType, resolveComponentType } from "../runtime/react-brands.ts";
import { enterScope, type IdHolder, type IdScope, nextId, rootScope } from "./tree-id.ts";
export type { IdHolder } from "./tree-id.ts";

/** HTML void elements that must not have a closing tag. */
export const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Attributes that are booleans in HTML (rendered bare when truthy). */
const BOOLEAN_ATTRS = new Set([
  "checked",
  "selected",
  "disabled",
  "readonly",
  "multiple",
  "required",
  "autofocus",
  "hidden",
  "async",
  "defer",
  "open",
  "novalidate",
]);

const ESCAPE_RE = /[&<>"']/g;
// Non-global twin of ESCAPE_RE for the fast-path membership test — `.test` on a
// `/g` regex advances `lastIndex` and would desync across calls.
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape `&`, `<`, `>`, `"`, and `'` so a string is safe as HTML text or attribute content. */
export function escapeHtml(value: string): string {
  // Fast path: the overwhelming majority of text/attribute values contain no
  // special char, so skip the `.replace` callback machinery entirely.
  if (!ESCAPE_TEST.test(value)) return value;
  return value.replace(ESCAPE_RE, (c) => ESCAPE_MAP[c]);
}

// Event-handler prop matcher, hoisted to a module constant (was re-created inline
// per attribute in the hot serialization loop). Non-global, so `.test` is safe.
const ON_ATTR_RE = /^on/i;

// The prop key providers stash their context payload under (the PROVIDER symbol
// coerced to a string). Hoisted so serializeAttributes doesn't recompute
// `PROVIDER.toString()` on every attribute.
const PROVIDER_KEY = PROVIDER.toString();

// Characters that must never appear in an HTML attribute name. An attacker who
// controls a prop name (e.g. a component spreading untrusted keys) could
// otherwise inject `foo><script>` and break out of the tag. Mirrors the set
// React rejects.
// deno-lint-ignore no-control-regex
const ILLEGAL_ATTR_NAME = /[\s"'>/=<\u0000-\u001F\u007F]/;

/**
 * Is `name` a safe HTML attribute name to emit or set from (possibly untrusted)
 * props? Rejects names that could break out of the tag/attribute context, and any
 * `on*` name (case-insensitive): event handlers are wired up as real listeners,
 * never as raw attributes, so an `on*` attribute reaching the DOM — e.g. a
 * lowercase `onmouseover` from `<div {...untrusted}>` — is only ever an injection
 * sink. This is the shared chokepoint for both SSR serialization and the client
 * reconciler's `setAttribute`.
 */
export function isValidAttrName(name: string): boolean {
  return name.length > 0 && !ILLEGAL_ATTR_NAME.test(name) && !ON_ATTR_RE.test(name);
}

// URL-bearing attributes: the browser navigates to or loads a resource from the
// value, so a `javascript:`/`vbscript:` (or executable `data:`) scheme here is a
// script-execution sink. React only warns in dev; denext neutralizes the value.
const URL_ATTRS = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "xlink:href",
  "cite",
  "background",
  "ping",
  "data",
]);

// Attributes the browser treats as a navigation/submission target, where a
// `data:` URL executes (a `data:text/html` document runs its own scripts).
const NAV_URL_ATTRS = new Set(["href", "xlink:href", "action", "formaction", "cite", "ping"]);

// Tags that execute or embed a `src`/`data` URL as a document or script.
const SCRIPTY_TAGS = new Set(["script", "iframe", "frame", "embed", "object"]);

// Schemes that run script when the URL is navigated to or loaded.
const SCRIPT_URL_SCHEME = /^(?:javascript|vbscript|livescript|mocha|data):/;

/**
 * Neutralize a dangerous URL scheme in a URL-bearing attribute value. Returns the
 * value unchanged when safe, or `null` when it must be dropped.
 *
 * `javascript:`, `vbscript:`, `livescript:` and `mocha:` are refused in any URL
 * attribute; `data:` is refused only where it executes — a navigation/submission
 * target (`href`, `action`, …) or the `src`/`data` of a
 * `<script>`/`<iframe>`/`<embed>`/`<object>` — so a `data:image/*` in `<img src>`
 * keeps working. Leading ASCII control/whitespace chars are stripped before the
 * scheme test because browsers ignore them inside a scheme (`java\tscript:` still
 * runs). Shared by SSR serialization and the client reconciler's `setAttribute`.
 */
export function sanitizeUrlAttr(
  tag: string | undefined,
  attr: string,
  value: string,
): string | null {
  // HTML attribute names are case-insensitive; the React prop may be camelCase
  // (`formAction` -> `formaction`), so compare on a lowercased name.
  const a = attr.toLowerCase();
  if (!URL_ATTRS.has(a)) return value;
  // Strip ASCII control chars + whitespace before the scheme test; browsers
  // ignore them inside a scheme, so `java\tscript:` would otherwise slip through.
  // deno-lint-ignore no-control-regex
  const scheme = value.replace(/[\u0000-\u0020\u007F-\u009F]+/g, "").toLowerCase();
  if (!SCRIPT_URL_SCHEME.test(scheme)) return value;
  if (scheme.startsWith("data:")) {
    const executes = NAV_URL_ATTRS.has(a) ||
      (tag !== undefined && SCRIPTY_TAGS.has(tag) && (a === "src" || a === "data"));
    if (!executes) return value; // e.g. data:image/* in <img src> — safe
  }
  if ((globalThis as { __denextDev?: boolean }).__denextDev === true) {
    console.warn(
      `denext: refused a dangerous URL in ${attr}="${value.slice(0, 40)}" — ` +
        `javascript:/vbscript:/executable data: URLs are dropped to prevent XSS.`,
    );
  }
  return null;
}

/**
 * Warn (dev only) that `dangerouslySetInnerHTML` was used — the most common React
 * XSS sink. denext emits the HTML raw for React parity, so untrusted input must be
 * sanitized (e.g. with DOMPurify) before it reaches this prop. Gated on
 * `globalThis.__denextDev`, so production SSR and client bundles pay nothing.
 */
export function warnDangerousHtml(tag: string): void {
  if ((globalThis as { __denextDev?: boolean }).__denextDev !== true) return;
  console.warn(
    `denext: dangerouslySetInnerHTML on <${tag}> emits raw HTML — sanitize ` +
      `untrusted input (e.g. with DOMPurify) to avoid XSS. (dev-only warning)`,
  );
}

/**
 * Warn (dev only) that an `<iframe srcdoc>` was rendered. `escapeHtml` makes the
 * value a well-formed *attribute*, but the browser then parses it back into a full
 * HTML document that runs its own scripts — so untrusted `srcdoc` content is an XSS
 * sink exactly like `dangerouslySetInnerHTML`, not something attribute-escaping
 * protects. Gated on `globalThis.__denextDev`, so production pays nothing.
 */
function warnSrcdoc(): void {
  if ((globalThis as { __denextDev?: boolean }).__denextDev !== true) return;
  console.warn(
    `denext: <iframe srcdoc> renders an HTML document that runs its own scripts — ` +
      `attribute escaping does NOT sanitize it. Sanitize untrusted srcdoc content ` +
      `(or sandbox the iframe) to avoid XSS. (dev-only warning)`,
  );
}

/** A provider frame active during rendering: context id -> value. */
export type ProviderScope = Map<symbol, unknown>;

/**
 * Build the read-only dispatcher used during a single SSR pass. This is the ONE
 * server dispatcher — every server renderer (string, stream, Flight, PPR, and
 * their Flight variants) uses it instead of hand-rolling its own.
 *
 * @param scopes The active provider scopes (outermost first). Pass a **getter**
 *   (`() => this.activeScopes`) when the caller reassigns its scopes array
 *   between renders — the streaming/PPR renderers do — so `useContext` always
 *   reads the live array rather than a stale reference captured at construction.
 * @param ids The id holder read by `useId` (mutated in place, never reassigned).
 * @param effects When provided, effect hooks (`useEffect`/`useLayoutEffect`/
 *   `useInsertionEffect`, and a subscribing `useSyncExternalStore`) bump
 *   `effects.count` so a Flight renderer can auto-pick an island's hydration
 *   strategy (an island that runs an effect must hydrate). Omit it — the string
 *   and non-Flight PPR passes do — to make every effect hook a pure no-op.
 */
export function createSSRDispatcher(
  scopes: ProviderScope[] | (() => ProviderScope[]),
  ids: IdHolder,
  effects?: { count: number },
): Dispatcher {
  const readScopes = typeof scopes === "function" ? scopes : () => scopes;
  // Effects never run on the server; a Flight renderer only counts them (so it knows
  // the component needs hydration).
  const countEffect = () => {
    if (effects) effects.count++;
  };
  return {
    useState<S>(initial: S | (() => S)) {
      const value = typeof initial === "function" ? (initial as () => S)() : initial;
      // Server state is immutable within a render; updater is a no-op.
      return [value, () => {}];
    },
    useReducer<S, A, I>(_reducer: (s: S, a: A) => S, initialArg: I, init?: (arg: I) => S) {
      return [init ? init(initialArg) : (initialArg as unknown as S), () => {}];
    },
    useEffect: countEffect,
    useMemo<T>(factory: () => T) {
      return factory();
    },
    useRef<T>(initial: T) {
      return { current: initial };
    },
    useContext<T>(context: Context<T>): T {
      return readContext(readScopes(), context);
    },
    useId(): string {
      return nextId(ids.scope);
    },
    useSyncExternalStore<T>(
      _subscribe: (onChange: () => void) => () => void,
      getSnapshot: () => T,
      getServerSnapshot?: () => T,
    ): T {
      if (effects) effects.count++; // subscribes on mount → needs hydration
      return (getServerSnapshot ?? getSnapshot)();
    },
    useLayoutEffect: countEffect,
    useInsertionEffect: countEffect,
    useMemoCache(size: number): unknown[] {
      // One-shot render: a fresh cache each time. Generated code still recomputes
      // correctly (every slot reads as the sentinel), it just never reuses across
      // renders — which the server never does anyway.
      return new Array(size).fill(MEMO_CACHE_SENTINEL);
    },
  };
}

/** The nearest provider's value for `context` (innermost scope wins), else its default. */
function readContext<T>(scopes: ProviderScope[], context: Context<T>): T {
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i].has(context._id)) return scopes[i].get(context._id) as T;
  }
  return context._defaultValue;
}

/**
 * Resolve a class component's legacy `contextType` value from the active provider
 * scopes (nearest wins, else the context's default). Returns `undefined` when the
 * class declares no `contextType`. Used to give server-rendered class components
 * their `this.context`.
 *
 * @param type The class component (may carry a static `contextType`).
 * @param scopes The active provider scopes, outermost first.
 * @returns The resolved context value, or `undefined`.
 */
export function resolveContextType(type: unknown, scopes: ProviderScope[]): unknown {
  const ctxType = (type as { contextType?: Context<unknown> }).contextType;
  if (!ctxType || ctxType._id == null) return undefined;
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i].has(ctxType._id)) return scopes[i].get(ctxType._id);
  }
  return ctxType._defaultValue;
}

/**
 * Collects document metadata (`<title>`/`<meta>`/`<link>`) hoisted out of the
 * body during rendering (React 19 behavior). When passed to
 * {@link renderToString}, matching elements are gathered here instead of being
 * emitted inline, so the caller can place them in `<head>`.
 */
export interface HeadCollector {
  /** The last in-tree `<title>` text, if any (it wins over other titles). */
  title?: string;
  /**
   * Serialized `<meta>`/`<link>` tags gathered from the tree, in tree order. Entries that
   * share a `dedup` identity collapse to the LAST one when the head is emitted (see
   * {@link collapseHeadTags}) — `next/head`'s `key` de-duplication and its
   * `charSet`/`viewport` singletons.
   */
  tags: HeadTag[];
  /**
   * HTML fragments contributed by {@link useServerInsertedHTML} callbacks (e.g. a
   * CSS-in-JS registry's collected `<style>` tags), rendered after the tree and
   * placed in `<head>`. Populated by {@link renderToString} when callbacks register.
   */
  serverInserted?: string[];
}

/**
 * The active `useServerInsertedHTML` sink for the in-flight {@link renderToString}
 * pass, or null outside SSR (so the hook is a no-op on the client). Set/cleared by
 * `renderToString`; a module singleton keyed on globalThis so an inlined next-compat
 * runtime copy and the host share ONE sink (mirrors the hook dispatcher pattern).
 */
const INSERT_SINK_KEY = Symbol.for("denext.serverInsertSink");
interface SinkHolder {
  [INSERT_SINK_KEY]?: ((cb: () => VNodeChildren) => void) | null;
}

/**
 * Begin collecting {@link useServerInsertedHTML} callbacks for a render pass: install the
 * global sink and return the collector plus an `end()` that restores the previous sink.
 * Pair with {@link flushServerInsertedHTML} after the tree renders. Used by every SSR
 * entry that produces a document ({@link renderToString} and the HTML+Flight renderer).
 */
export function beginServerInsertCollection(): {
  inserted: Array<() => VNodeChildren>;
  end: () => void;
} {
  const inserted: Array<() => VNodeChildren> = [];
  const holder = globalThis as SinkHolder;
  const prev = holder[INSERT_SINK_KEY];
  holder[INSERT_SINK_KEY] = (cb) => inserted.push(cb);
  return { inserted, end: () => void (holder[INSERT_SINK_KEY] = prev) };
}

/**
 * Run the collected {@link useServerInsertedHTML} callbacks and place their rendered
 * markup into `head.serverInserted` (for the document `<head>`). No-op without callbacks
 * or a head collector.
 */
export function flushServerInsertedHTML(
  inserted: Array<() => VNodeChildren>,
  head: HeadCollector | null,
): void {
  if (inserted.length === 0 || !head) return;
  head.serverInserted ??= [];
  for (const cb of inserted) {
    const frag = renderToStringSync(cb(), {});
    if (frag) head.serverInserted.push(frag);
  }
}

/** Element tags hoisted into the document head when a collector is present. */
export const HOISTED_TAGS = new Set(["title", "meta", "link"]);

/** One hoisted `<meta>`/`<link>` in a {@link HeadCollector}. */
export interface HeadTag {
  /** The serialized (already escaped) tag, e.g. `<meta name="description" content="…">`. */
  html: string;
  /**
   * De-duplication identity, when the tag has one (see {@link headDedupKey}); tags with the
   * same identity collapse to the last one. Absent for ordinary keyless tags, which always
   * all survive.
   */
  dedup?: string;
}

/**
 * The de-duplication identity of a hoisted `<meta>`/`<link>` — `next/head`'s semantics,
 * captured BEFORE the element's props are serialized (the `key` never reaches the HTML):
 * - `<meta charSet>` (either casing) → `charset`: a document has one charset, so it is a
 *   singleton even when keyed.
 * - a user `key` → `k:<key>`: same key, last wins (how `next/head` lets a page override a
 *   layout's tag).
 * - an unkeyed `<meta name="viewport">` → `meta:viewport` (the other `next/head` singleton).
 * Anything else — including two keyless `<meta property="og:image">` or two stylesheet
 * `<link>`s — has no identity and is never collapsed.
 */
export function headDedupKey(tag: string, props: Record<string, unknown>): string | undefined {
  if (tag === "meta" && (props.charSet != null || props.charset != null)) return "charset";
  const key = props.key;
  if (key != null) return `k:${key}`;
  if (tag === "meta" && props.name === "viewport") return "meta:viewport";
  return undefined;
}

/**
 * Join a {@link HeadCollector}'s tags into head HTML, collapsing entries that share a
 * {@link HeadTag.dedup} identity to the LAST occurrence at its own position (the earlier
 * duplicate is dropped — `next/head`'s reverse-filter order). Tags without an identity pass
 * through in tree order. Operates on the already-serialized strings; nothing is re-escaped.
 */
export function collapseHeadTags(tags: HeadTag[]): string {
  const out: string[] = [];
  let seen: Map<string, number> | undefined;
  for (const t of tags) {
    if (t.dedup !== undefined) {
      seen ??= new Map();
      const prev = seen.get(t.dedup);
      if (prev !== undefined) out[prev] = "";
      seen.set(t.dedup, out.length);
    }
    out.push(t.html);
  }
  return out.join("");
}

/** Options for {@link renderToString}. */
export interface RenderOptions {
  /** Called for each async chunk if streaming; unused in string mode. */
  signal?: AbortSignal;
  /**
   * When provided, `<title>`/`<meta>`/`<link>` elements are hoisted into this
   * collector instead of the body (so they can be rendered in `<head>`).
   */
  head?: HeadCollector;
  /**
   * Seed for the root `useId` scope (React's `identifierPrefix`). Default `""` —
   * byte-identical to an unprefixed render. Match the client's `hydrateRoot`
   * `identifierPrefix` so ids align on hydration.
   */
  idPrefix?: string;
}

/**
 * Mutable render context threaded through the recursion — one object per render
 * pass, replacing the four positional args the old renderer carried through every
 * call. `out` is the single append-only buffer the whole tree writes into.
 */
interface RenderCtx {
  out: string[];
  scopes: ProviderScope[];
  dispatcher: Dispatcher;
  head: HeadCollector | null;
  /** The current id scope (shared with the dispatcher's `useId`). */
  ids: IdHolder;
  /**
   * Synchronous mode ({@link renderToStringSync}): the walk must never await. A Suspense
   * boundary whose children suspend (or return a promise) renders its **fallback** in place
   * — React's `renderToString` contract — instead of awaiting the data. A genuinely async
   * Server Component *outside* any boundary makes the top-level entry throw.
   */
  sync?: boolean;
}

/**
 * Render a VNode (or renderable child) to an HTML string.
 * This is the primary SSR entry point.
 *
 * The renderer appends into a single shared buffer and stays **fully synchronous**
 * for synchronous subtrees — a promise is only allocated when a child actually
 * returns one (an async server component, or a Suspense/error-boundary that must
 * await). This avoids one promise frame per node and the per-array `Promise.all`,
 * and building the HTML in one buffer (joined once) avoids the old bottom-up
 * O(n·depth) string re-copying. Output is byte-for-byte identical to before.
 */
export async function renderToString(
  node: VNodeChildren,
  options: RenderOptions = {},
): Promise<string> {
  const scopes: ProviderScope[] = [];
  const ids: IdHolder = { scope: rootScope(options.idPrefix) };
  const dispatcher = createSSRDispatcher(scopes, ids);
  const ctx: RenderCtx = { out: [], scopes, dispatcher, head: options.head ?? null, ids };
  const prev = setDispatcher(dispatcher);
  // Collect `useServerInsertedHTML` callbacks during this render pass; they run AFTER the
  // tree renders (returning e.g. a CSS-in-JS registry's `<style>` tags) → placed in <head>.
  const sink = beginServerInsertCollection();
  try {
    const pending = renderChildrenInto(node, ctx);
    if (isThenable(pending)) await pending;
    flushServerInsertedHTML(sink.inserted, ctx.head);
    return ctx.out.join("");
  } finally {
    setDispatcher(prev);
    sink.end();
  }
}

/**
 * Render a VNode to an HTML string **synchronously** — the engine behind the compat
 * `react-dom/server` `renderToString`/`renderToStaticMarkup`. It drives the same walker
 * with {@link RenderCtx.sync} set: a Suspense boundary whose children suspend renders its
 * fallback in place (React's contract — a sync render never awaits data). It throws a
 * guided error if the tree contains a genuinely async Server Component *outside* any
 * Suspense boundary (that needs `renderToReadableStream` or `await renderToString`).
 */
export function renderToStringSync(node: VNodeChildren, options: RenderOptions = {}): string {
  const scopes: ProviderScope[] = [];
  const ids: IdHolder = { scope: rootScope(options.idPrefix) };
  const dispatcher = createSSRDispatcher(scopes, ids);
  const ctx: RenderCtx = {
    out: [],
    scopes,
    dispatcher,
    head: options.head ?? null,
    ids,
    sync: true,
  };
  const prev = setDispatcher(dispatcher);
  try {
    const pending = renderChildrenInto(node, ctx);
    if (isThenable(pending)) {
      // Swallow the floating promise so it can't surface as an unhandled rejection.
      (pending as Promise<unknown>).catch(() => {});
      throw new Error(
        "denext: renderToStringSync() cannot render an async Server Component (or " +
          "async data outside a <Suspense> boundary) — the render suspended. Use " +
          '`renderToReadableStream`, or `await renderToString` from "denext".',
      );
    }
    return ctx.out.join("");
  } finally {
    setDispatcher(prev);
  }
}

/**
 * Render a subtree to its own string in an isolated buffer, so a thrown
 * thenable/error discards the partial output (needed for Suspense retries,
 * error-boundary catches, and hoisted `<title>` text). Shares the caller's
 * scopes/dispatcher/head.
 */
function renderToStr(children: VNodeChildren, ctx: RenderCtx): string | Promise<string> {
  const sub: string[] = [];
  const pending = renderChildrenInto(children, {
    out: sub,
    scopes: ctx.scopes,
    dispatcher: ctx.dispatcher,
    head: ctx.head,
    ids: ctx.ids,
  });
  if (isThenable(pending)) return (pending as Promise<void>).then(() => sub.join(""));
  return sub.join("");
}

/** Push an isolated subtree's string result onto the buffer (sync or async). */
function appendResult(result: string | Promise<string>, ctx: RenderCtx): void | Promise<void> {
  if (isThenable(result)) {
    return (result as Promise<string>).then((s) => {
      ctx.out.push(s);
    });
  }
  ctx.out.push(result);
}

/** Restore the parent id scope once a component's subtree finishes (sync or async). */
function finishComponent(
  pending: void | Promise<void>,
  restore: () => void,
): void | Promise<void> {
  if (isThenable(pending)) {
    return (pending as Promise<void>).then(restore, (err) => {
      restore();
      throw err;
    });
  }
  restore();
}

/** Append the rendered children to `ctx.out`; returns a promise only when async. */
function renderChildrenInto(children: VNodeChildren, ctx: RenderCtx): void | Promise<void> {
  if (Array.isArray(children)) return renderList(children, ctx, 0);
  return renderChildInto(children, ctx);
}

/**
 * Render array items in order. Stays synchronous until an item returns a promise;
 * from there the tail continues after each awaited item, preserving output order
 * (a sibling can't be appended before an earlier async sibling resolves).
 */
function renderList(
  items: VNodeChild[],
  ctx: RenderCtx,
  start: number,
): void | Promise<void> {
  for (let i = start; i < items.length; i++) {
    const pending = renderChildInto(items[i], ctx);
    if (isThenable(pending)) {
      return (pending as Promise<void>).then(() => renderList(items, ctx, i + 1));
    }
  }
}

function renderChildInto(child: VNodeChild, ctx: RenderCtx): void | Promise<void> {
  if (child == null || child === false || child === true) return;
  // React flattens arbitrarily-nested children arrays; some libraries (recharts)
  // pass a nested array as a single child, so recurse instead of treating it as a node.
  if (Array.isArray(child)) return renderChildrenInto(child as VNodeChildren, ctx);
  if (typeof child === "string") {
    ctx.out.push(escapeHtml(child));
    return;
  }
  if (typeof child === "number") {
    ctx.out.push(escapeHtml(String(child)));
    return;
  }
  return renderVNodeInto(child as VNode, ctx);
}

function renderVNodeInto(node: VNode, ctx: RenderCtx): void | Promise<void> {
  const { type } = node;
  // Some npm libraries (e.g. recharts) construct elements with a null `props`;
  // React treats an element's props as `{}` in that case, so normalize here.
  const props = node.props ?? {};
  if (type === FRAGMENT) return renderFragmentInto(props, ctx);
  // Portal: its children target a client DOM node that doesn't exist during SSR,
  // so — like React's server renderer — a portal emits nothing.
  if ((type as unknown) === PORTAL) return;
  if ((type as unknown) === SUSPENSE) return appendResult(renderSuspenseToStr(props, ctx), ctx);
  if ((type as unknown) === ERROR_BOUNDARY) {
    return appendResult(renderErrorBoundaryToStr(props, ctx), ctx);
  }
  if (isComponentType(type)) return renderComponentInto(type, props, ctx);
  return renderHostInto(type as string, props, ctx);
}

/** A VNode's props (null-normalized). */
type Props = VNode["props"];

/** Fragment (also the shape used by context providers). */
function renderFragmentInto(props: Props, ctx: RenderCtx): void | Promise<void> {
  const providerInfo = props[PROVIDER as unknown as string] as
    | { id: symbol; value: unknown }
    | undefined;
  if (!providerInfo) return renderChildrenInto(props.children, ctx);
  ctx.scopes.push(new Map([[providerInfo.id, providerInfo.value]]));
  const pending = renderChildrenInto(props.children, ctx);
  if (isThenable(pending)) {
    return (pending as Promise<void>).finally(() => {
      ctx.scopes.pop();
    });
  }
  ctx.scopes.pop();
}

/** A Suspense boundary mid-render: its props, the render context, and its two id scopes. */
interface BoundaryRender {
  props: Props;
  ctx: RenderCtx;
  parentScope: IdScope;
  boundaryScope: IdScope;
}

/**
 * Suspense boundary: fully resolve children, retrying on suspension. The async string
 * render always awaits the data (so the fallback isn't shown); the SYNCHRONOUS render
 * (`ctx.sync`, {@link renderToStringSync}) can't await, so it shows the fallback in
 * place — matching React's real `renderToString`.
 *
 * A Suspense boundary is its own id scope: it consumes exactly ONE slot in its parent (so
 * content after it aligns regardless of how many ids are inside), and its children's ids
 * are rooted at the boundary's position — which is what lets a streamed/isolated hole
 * render reproduce them.
 */
function renderSuspenseToStr(props: Props, ctx: RenderCtx): string | Promise<string> {
  const parentScope = ctx.ids.scope;
  const boundaryScope = enterScope(parentScope);
  return attemptBoundary({ props, ctx, parentScope, boundaryScope });
}

/** Enter the boundary scope with its own counters reset (its parent slot is already fixed). */
function enterBoundary(b: BoundaryRender): void {
  b.boundaryScope.count = 0;
  b.boundaryScope.local = 0;
  b.ctx.ids.scope = b.boundaryScope;
}

function restoreBoundary(b: BoundaryRender): void {
  b.ctx.ids.scope = b.parentScope;
}

/**
 * Sync mode only: render the boundary's fallback in its place (scope reset so the
 * fallback's ids start where the children's would). Throws if the fallback is async.
 */
function renderFallbackSync(b: BoundaryRender): string {
  enterBoundary(b);
  const fb = renderToStr(b.props.fallback as VNodeChildren, b.ctx);
  restoreBoundary(b);
  if (isThenable(fb)) {
    (fb as Promise<unknown>).catch(() => {});
    throw new Error(
      "denext: renderToStringSync() — a <Suspense> fallback is itself asynchronous; " +
        "a fallback must render synchronously.",
    );
  }
  return fb;
}

/** In sync mode a suspension can't be awaited: swallow the promise and show the fallback. */
function suspendedSync(b: BoundaryRender, pending: unknown): string | null {
  if (!b.ctx.sync) return null;
  (pending as Promise<unknown>).catch(() => {});
  return renderFallbackSync(b);
}

/** Retry after a suspension settles: reset the boundary's counters and render again. */
function retryBoundary(b: BoundaryRender): string | Promise<string> {
  enterBoundary(b);
  return attemptBoundary(b);
}

function attemptBoundary(b: BoundaryRender): string | Promise<string> {
  b.ctx.ids.scope = b.boundaryScope;
  let r: string | Promise<string>;
  try {
    r = renderToStr(b.props.children, b.ctx);
  } catch (err) {
    if (!isThenable(err)) throw err;
    return suspendedSync(b, err) ?? (err as Promise<unknown>).then(() => retryBoundary(b));
  }
  if (isThenable(r)) {
    return suspendedSync(b, r) ??
      (r as Promise<string>).then((s) => (restoreBoundary(b), s), (err) => {
        if (isThenable(err)) return (err as Promise<unknown>).then(() => retryBoundary(b));
        restoreBoundary(b);
        throw err;
      });
  }
  restoreBoundary(b);
  return r;
}

/**
 * Error boundary: render children; on a (non-suspension) throw, render fallback. The
 * fallback replaces the children, so rewind the active scope to its pre-children state —
 * the fallback's ids then start where the children's did (matching a client that renders
 * the fallback from that same position).
 */
function renderErrorBoundaryToStr(props: Props, ctx: RenderCtx): string | Promise<string> {
  const idScope = ctx.ids.scope;
  const savedCount = idScope.count;
  const savedLocal = idScope.local;
  const onError = (err: unknown): string | Promise<string> => {
    // Suspensions go to <Suspense>; notFound()/forbidden()/unauthorized()
    // bubble to the page handler for status-code rendering.
    if (isThenable(err) || isControlSignal(err)) throw err;
    ctx.ids.scope = idScope;
    idScope.count = savedCount;
    idScope.local = savedLocal;
    return renderFallbackToStr(props, err, ctx);
  };
  let r: string | Promise<string>;
  try {
    r = renderToStr(props.children, ctx);
  } catch (err) {
    r = onError(err);
  }
  return isThenable(r) ? (r as Promise<string>).catch(onError) : r;
}

/** Invoke the boundary's fallback for `err` (reported first) and render what it returns. */
function renderFallbackToStr(props: Props, err: unknown, ctx: RenderCtx): string | Promise<string> {
  const Fallback = props.fallback as (
    p: { error: Error; reset: () => void },
  ) => VNode | Promise<VNode>;
  setDispatcher(ctx.dispatcher);
  reportBoundaryError(props, err);
  const fb = Fallback({ error: toClientError(err), reset: () => {} });
  if (isThenable(fb)) {
    return (fb as Promise<VNode>).then((n) => renderToStr(n as VNodeChildren, ctx));
  }
  return renderToStr(fb as VNodeChildren, ctx);
}

/**
 * Function component (or a memo/forwardRef object wrapper). Each component opens
 * a fresh id scope (consuming a slot in its parent's scope) so its `useId` and
 * its descendants' ids are derived from its tree position; the scope is restored
 * once its subtree finishes (or unwinds, so a suspension leaves the parent clean).
 */
function renderComponentInto(type: unknown, props: Props, ctx: RenderCtx): void | Promise<void> {
  setDispatcher(ctx.dispatcher);
  const parentScope = ctx.ids.scope;
  ctx.ids.scope = enterScope(parentScope);
  const restore = () => {
    ctx.ids.scope = parentScope;
  };
  let result: VNodeChild | Promise<VNodeChild>;
  try {
    result = invokeSync(type, props, ctx);
  } catch (err) {
    restore();
    throw err;
  }
  if (isThenable(result)) {
    return (result as Promise<VNodeChild>).then(
      (r) => finishComponent(renderChildInto(r, ctx), restore),
      (err) => {
        restore();
        throw err;
      },
    );
  }
  return finishComponent(renderChildInto(result as VNodeChild, ctx), restore);
}

/**
 * Invoke a component without awaiting. Class components: cheap always-on detection; the
 * runtime is gated (folds out when classComponents is off), and using a class off throws
 * a guided error. Otherwise resolve memo/forwardRef wrappers, then invoke: sync components
 * (the common case) return a VNode and never allocate a promise; async server components
 * return one and are awaited by the caller.
 */
function invokeSync(type: unknown, props: Props, ctx: RenderCtx): VNodeChild | Promise<VNodeChild> {
  if (isClassComponent(type)) {
    if (__DENEXT_CLASS_COMPONENTS__) {
      return renderClassToVNode(type, props, resolveContextType(type, ctx.scopes)) as VNodeChild;
    }
    throw classComponentsDisabledError();
  }
  return invokeComponent(resolveComponentType(type), props) as VNodeChild | Promise<VNodeChild>;
}

/** Intrinsic element. */
function renderHostInto(tag: string, props: Props, ctx: RenderCtx): void | Promise<void> {
  let attrs = serializeAttributes(props, tag);
  // A <form> posting to a server action needs method=post for the no-JS path.
  if (tag === "form" && isServerAction(props.action) && props.method == null) {
    attrs += ` method="post"`;
  }
  // React 19 document metadata: hoist <title>/<meta>/<link> into the head
  // collector (when one is active) instead of emitting them inline.
  if (ctx.head && HOISTED_TAGS.has(tag)) return hoistInto(ctx.head, tag, attrs, props, ctx);
  if (VOID_ELEMENTS.has(tag)) {
    ctx.out.push(`<${tag}${attrs}>`);
    return;
  }
  // dangerouslySetInnerHTML support (raw HTML injection).
  const dangerous = props.dangerouslySetInnerHTML as { __html: string } | undefined;
  if (dangerous && typeof dangerous.__html === "string") {
    warnDangerousHtml(tag);
    ctx.out.push(`<${tag}${attrs}>${dangerous.__html}</${tag}>`);
    return;
  }
  // Open tag, children appended in place, then close tag — the whole tree shares
  // one buffer, so no per-element intermediate string is built.
  ctx.out.push(`<${tag}${attrs}>`);
  const pending = renderChildrenInto(props.children, ctx);
  if (isThenable(pending)) {
    return (pending as Promise<void>).then(() => {
      ctx.out.push(`</${tag}>`);
    });
  }
  ctx.out.push(`</${tag}>`);
}

/** Hoist a `<title>` (rendered to text, without the collector) or a `<meta>`/`<link>` tag. */
function hoistInto(
  head: HeadCollector,
  tag: string,
  attrs: string,
  props: Props,
  ctx: RenderCtx,
): void | Promise<void> {
  if (tag !== "title") {
    head.tags.push({ html: `<${tag}${attrs}>`, dedup: headDedupKey(tag, props) });
    return;
  }
  const t = renderToStr(props.children, { ...ctx, head: null });
  if (isThenable(t)) {
    return (t as Promise<string>).then((s) => {
      head.title = s;
    });
  }
  head.title = t;
}

/**
 * Serialize a props object into an attribute string (leading space per attr).
 * `tag` (the host element name, when known) lets URL-attribute sanitization tell a
 * navigable/scripty context apart from a safe media `src`.
 */
export function serializeAttributes(
  props: Record<string, unknown>,
  tag?: string,
  resumable = false,
): string {
  let out = "";
  // Collects `eventType:qrlId` pairs for any qrl handler, emitted as data-dnx-h so
  // the client can dispatch the handler without running the component (stage 4).
  let dnxH = "";
  // Object.keys + index avoids the [key, value] tuple array Object.entries
  // allocates per element (a real cost on prop-heavy nodes).
  const keys = Object.keys(props);
  for (let i = 0; i < keys.length; i++) {
    const rawName = keys[i];
    if (STRUCTURAL_PROPS.has(rawName)) continue;
    const value = props[rawName];
    // Event handlers are client-only; skip during SSR. Match case-INsensitively:
    // React-style `onClick` AND lowercase HTML-native names (`onmouseover`,
    // `onerror`, …). The lowercase forms would otherwise pass `isValidAttrName`
    // and emit a live handler attribute — an XSS sink for `<div {...untrusted}>`.
    if (ON_ATTR_RE.test(rawName)) {
      const mark = handlerMark(rawName, value, resumable);
      if (mark) dnxH += (dnxH ? " " : "") + mark;
      continue;
    }
    out += attributeFor(rawName, value, tag);
  }
  if (dnxH) out += ` ${DNX_H_ATTR}="${escapeHtml(dnxH)}"`;
  return out;
}

/** Props that are never attributes: children render separately; the rest are structural. */
const STRUCTURAL_PROPS = new Set([
  "children",
  "key",
  "ref",
  "dangerouslySetInnerHTML",
  PROVIDER_KEY,
]);

/**
 * The `data-dnx-h` entry for an event prop. A qrl dispatches without mounting (`evt:id`).
 * In resumable mode a plain function handler is marked (`evt`) so the client hydrates its
 * island and replays the event to the resumed handler; so is a qrl that captures
 * component-local state — it can't run without its LIVE captures (which exist only once
 * the component mounts), and dispatching `evt:id` would run the segment with no scope and
 * throw in `capturedScope()`. Null for a client-only handler.
 */
function handlerMark(rawName: string, handler: unknown, resumable: boolean): string | null {
  if (isQrl(handler)) {
    const noMount = !(resumable && handler.denextCapture);
    return domEventType(rawName) + (noMount ? ":" + handler.denextQrlId : "");
  }
  if (resumable && typeof handler === "function") return domEventType(rawName);
  return null;
}

/**
 * A form `action`/`formAction` URL for a no-JS submit: a server action's endpoint
 * (progressive enhancement), or the permalink a `useActionState` dispatch carries (its
 * React 19 3rd arg) so a pre-hydration submit navigates there. Null when neither.
 */
function formActionUrl(value: unknown): string | null {
  if (isServerAction(value)) return actionEndpoint(value.denextActionId);
  if (typeof value !== "function") return null;
  const permalink = (value as { denextPermalink?: unknown }).denextPermalink;
  return typeof permalink === "string" ? permalink : null;
}

/** One prop's attribute text (leading space), or "" when it is dropped. */
function attributeFor(rawName: string, value: unknown, tag: string | undefined): string {
  if (rawName === "action" || rawName === "formAction") {
    const url = formActionUrl(value);
    if (url !== null) return ` ${rawName.toLowerCase()}="${escapeHtml(url)}"`;
  }
  // Function-valued props (e.g. a client-only form `action={fn}`) are skipped.
  if (typeof value === "function" || value == null || value === false) return "";
  const name = normalizeAttrName(rawName);
  // Drop attribute names that could break out of the tag (defends against a
  // component spreading untrusted keys, e.g. `<div {...untrusted}>`).
  if (!isValidAttrName(name)) return "";
  // `<iframe srcdoc>` embeds a full HTML document that runs scripts — an XSS
  // sink attribute-escaping can't neutralize. Nudge in dev (no-op in prod).
  if (name === "srcdoc" && tag === "iframe") warnSrcdoc();
  return valueAttribute(name, value, tag);
}

/** A kept prop's attribute: boolean presence, a style object, or an (URL-sanitized) value. */
function valueAttribute(name: string, value: unknown, tag: string | undefined): string {
  if (BOOLEAN_ATTRS.has(name) || value === true) return value ? ` ${name}` : "";
  if (name === "style" && typeof value === "object") {
    return ` style="${escapeHtml(serializeStyle(value as Record<string, unknown>))}"`;
  }
  // Drop a dangerous URL scheme (javascript:/vbscript:/executable data:) in a
  // URL-bearing attribute; a no-op for every other attribute.
  const safe = sanitizeUrlAttr(tag, name, String(value));
  return safe === null ? "" : ` ${name}="${escapeHtml(safe)}"`;
}

/** The DOM event type a React `on*` prop maps to (matches dom-props `parseEvent`). */
function domEventType(onProp: string): string {
  let n = onProp.slice(2); // strip "on"
  if (n.endsWith("Capture")) n = n.slice(0, -"Capture".length);
  const l = n.toLowerCase();
  return l === "change" ? "input" : l === "doubleclick" ? "dblclick" : l;
}

/** Map JSX prop names to HTML attribute names. */
function normalizeAttrName(name: string): string {
  if (name === "className") return "class";
  if (name === "htmlFor") return "for";
  return name;
}

/** Serialize a style object ({ marginTop: 4 }) to CSS text. */
export function serializeStyle(style: Record<string, unknown>): string {
  let css = "";
  const keys = Object.keys(style);
  for (let i = 0; i < keys.length; i++) {
    const prop = keys[i];
    const value = style[prop];
    if (value == null || value === false) continue;
    const kebab = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    const unit = typeof value === "number" && !UNITLESS.has(kebab) ? "px" : "";
    css += `${kebab}:${value}${unit};`;
  }
  return css;
}

/** CSS properties that take unitless numbers. */
const UNITLESS = new Set([
  "opacity",
  "z-index",
  "font-weight",
  "line-height",
  "flex",
  "flex-grow",
  "flex-shrink",
  "order",
  "grid-row",
  "grid-column",
  "columns",
]);
