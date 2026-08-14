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
import { ERROR_BOUNDARY, isControlSignal, toError } from "../runtime/error-boundary.ts";
import { actionEndpoint, isServerAction } from "../runtime/server-action.ts";
import "../runtime/class-flag.ts";
import { classComponentsDisabledError, isClassComponent } from "../compat/class-detect.ts";
import { renderClassToVNode } from "../compat/class-component.ts";

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

/** A provider frame active during rendering: context id -> value. */
export type ProviderScope = Map<symbol, unknown>;

/** Build a read-only dispatcher used only during a single SSR pass. */
export function createSSRDispatcher(scopes: ProviderScope[]): Dispatcher {
  // Deterministic id counter — the client hydration pass assigns ids in the
  // same render order, so useId() values match.
  let idCounter = 0;
  return {
    useState<S>(initial: S | (() => S)) {
      const value = typeof initial === "function" ? (initial as () => S)() : initial;
      // Server state is immutable within a render; updater is a no-op.
      return [value, () => {}];
    },
    useReducer<S, A, I>(_reducer: (s: S, a: A) => S, initialArg: I, init?: (arg: I) => S) {
      return [init ? init(initialArg) : (initialArg as unknown as S), () => {}];
    },
    useEffect() {
      // Effects never run on the server.
    },
    useMemo<T>(factory: () => T) {
      return factory();
    },
    useRef<T>(initial: T) {
      return { current: initial };
    },
    useContext<T>(context: Context<T>): T {
      for (let i = scopes.length - 1; i >= 0; i--) {
        if (scopes[i].has(context._id)) {
          return scopes[i].get(context._id) as T;
        }
      }
      return context._defaultValue;
    },
    useId(): string {
      return `:d${idCounter++}:`;
    },
    useSyncExternalStore<T>(
      _subscribe: (onChange: () => void) => () => void,
      getSnapshot: () => T,
      getServerSnapshot?: () => T,
    ): T {
      return (getServerSnapshot ?? getSnapshot)();
    },
    useLayoutEffect() {
      // Layout effects never run on the server.
    },
    useInsertionEffect() {
      // Insertion effects never run on the server.
    },
    useMemoCache(size: number): unknown[] {
      // One-shot render: a fresh cache each time. Generated code still recomputes
      // correctly (every slot reads as the sentinel), it just never reuses across
      // renders — which the server never does anyway.
      return new Array(size).fill(MEMO_CACHE_SENTINEL);
    },
  };
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
  /** Serialized `<meta>`/`<link>` tags gathered from the tree. */
  tags: string[];
}

/** Element tags hoisted into the document head when a collector is present. */
export const HOISTED_TAGS = new Set(["title", "meta", "link"]);

/** Options for {@link renderToString}. */
export interface RenderOptions {
  /** Called for each async chunk if streaming; unused in string mode. */
  signal?: AbortSignal;
  /**
   * When provided, `<title>`/`<meta>`/`<link>` elements are hoisted into this
   * collector instead of the body (so they can be rendered in `<head>`).
   */
  head?: HeadCollector;
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
  const dispatcher = createSSRDispatcher(scopes);
  const ctx: RenderCtx = { out: [], scopes, dispatcher, head: options.head ?? null };
  const prev = setDispatcher(dispatcher);
  try {
    const pending = renderChildrenInto(node, ctx);
    if (isThenable(pending)) await pending;
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

  // Fragment (also the shape used by context providers).
  if (type === FRAGMENT) {
    const providerInfo = props[PROVIDER as unknown as string] as
      | { id: symbol; value: unknown }
      | undefined;
    if (providerInfo) {
      const scope: ProviderScope = new Map();
      scope.set(providerInfo.id, providerInfo.value);
      ctx.scopes.push(scope);
      const pending = renderChildrenInto(props.children, ctx);
      if (isThenable(pending)) {
        return (pending as Promise<void>).finally(() => {
          ctx.scopes.pop();
        });
      }
      ctx.scopes.pop();
      return;
    }
    return renderChildrenInto(props.children, ctx);
  }

  // Portal: its children target a client DOM node that doesn't exist during SSR,
  // so — like React's server renderer — a portal emits nothing.
  if ((type as unknown) === PORTAL) return;

  // Suspense boundary: fully resolve children, retrying on suspension.
  // (String rendering has no streaming, so the fallback is never shown.)
  if ((type as unknown) === SUSPENSE) {
    const attempt = (): string | Promise<string> => {
      let r: string | Promise<string>;
      try {
        r = renderToStr(props.children, ctx);
      } catch (err) {
        if (isThenable(err)) return (err as Promise<unknown>).then(attempt);
        throw err;
      }
      if (isThenable(r)) {
        return (r as Promise<string>).then((s) => s, (err) => {
          if (isThenable(err)) return (err as Promise<unknown>).then(attempt);
          throw err;
        });
      }
      return r;
    };
    return appendResult(attempt(), ctx);
  }

  // Error boundary: render children; on a (non-suspension) throw, render fallback.
  if ((type as unknown) === ERROR_BOUNDARY) {
    const onError = (err: unknown): string | Promise<string> => {
      // Suspensions go to <Suspense>; notFound()/forbidden()/unauthorized()
      // bubble to the page handler for status-code rendering.
      if (isThenable(err) || isControlSignal(err)) throw err;
      const Fallback = props.fallback as (
        p: { error: Error; reset: () => void },
      ) => VNode | Promise<VNode>;
      setDispatcher(ctx.dispatcher);
      const fb = Fallback({ error: toError(err), reset: () => {} });
      if (isThenable(fb)) {
        return (fb as Promise<VNode>).then((n) => renderToStr(n as VNodeChildren, ctx));
      }
      return renderToStr(fb as VNodeChildren, ctx);
    };
    let r: string | Promise<string>;
    try {
      r = renderToStr(props.children, ctx);
    } catch (err) {
      r = onError(err);
    }
    if (isThenable(r)) r = (r as Promise<string>).catch(onError);
    return appendResult(r, ctx);
  }

  // Function component.
  if (typeof type === "function") {
    setDispatcher(ctx.dispatcher);
    // Class components: cheap always-on detection; the runtime is gated (folds out
    // when classComponents is off), and using a class off throws a guided error.
    if (isClassComponent(type)) {
      if (__DENEXT_CLASS_COMPONENTS__) {
        const result = renderClassToVNode(type, props, resolveContextType(type, ctx.scopes));
        return renderChildInto(result as VNodeChild, ctx);
      }
      throw classComponentsDisabledError();
    }
    // Sync components (the common case) return a VNode and never allocate a
    // promise; async server components return one and are awaited.
    const result = (type as (p: never) => VNodeChild | Promise<VNodeChild>)(
      props as never,
    );
    if (isThenable(result)) {
      return (result as Promise<VNodeChild>).then((r) => renderChildInto(r, ctx));
    }
    return renderChildInto(result as VNodeChild, ctx);
  }

  // Intrinsic element.
  const tag = type as string;
  let attrs = serializeAttributes(props, tag);
  // A <form> posting to a server action needs method=post for the no-JS path.
  if (tag === "form" && isServerAction(props.action) && props.method == null) {
    attrs += ` method="post"`;
  }

  // React 19 document metadata: hoist <title>/<meta>/<link> into the head
  // collector (when one is active) instead of emitting them inline.
  if (ctx.head && HOISTED_TAGS.has(tag)) {
    const head = ctx.head;
    if (tag === "title") {
      const t = renderToStr(props.children, { ...ctx, head: null });
      if (isThenable(t)) {
        return (t as Promise<string>).then((s) => {
          head.title = s;
        });
      }
      head.title = t;
      return;
    }
    head.tags.push(`<${tag}${attrs}>`);
    return;
  }

  if (VOID_ELEMENTS.has(tag)) {
    ctx.out.push(`<${tag}${attrs}>`);
    return;
  }

  // dangerouslySetInnerHTML support (raw HTML injection).
  const dangerous = props.dangerouslySetInnerHTML as
    | { __html: string }
    | undefined;
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

/**
 * Serialize a props object into an attribute string (leading space per attr).
 * `tag` (the host element name, when known) lets URL-attribute sanitization tell a
 * navigable/scripty context apart from a safe media `src`.
 */
export function serializeAttributes(props: Record<string, unknown>, tag?: string): string {
  let out = "";
  // Object.keys + index avoids the [key, value] tuple array Object.entries
  // allocates per element (a real cost on prop-heavy nodes).
  const keys = Object.keys(props);
  for (let i = 0; i < keys.length; i++) {
    const rawName = keys[i];
    if (
      rawName === "children" ||
      rawName === "key" ||
      rawName === "ref" ||
      rawName === "dangerouslySetInnerHTML" ||
      rawName === PROVIDER_KEY
    ) continue;
    // Event handlers are client-only; skip during SSR. Match case-INsensitively:
    // React-style `onClick` AND lowercase HTML-native names (`onmouseover`,
    // `onerror`, …). The lowercase forms would otherwise pass `isValidAttrName`
    // and emit a live handler attribute — an XSS sink for `<div {...untrusted}>`.
    if (ON_ATTR_RE.test(rawName)) continue;
    const value = props[rawName];
    // A server action as a form `action`/`formAction`: render the endpoint URL
    // so the form works without JavaScript (progressive enhancement).
    if ((rawName === "action" || rawName === "formAction") && isServerAction(value)) {
      const attr = rawName === "action" ? "action" : "formaction";
      out += ` ${attr}="${escapeHtml(actionEndpoint(value.denextActionId))}"`;
      continue;
    }
    // Function-valued props (e.g. a client-only form `action={fn}`) are skipped.
    if (typeof value === "function") continue;
    if (value == null || value === false) continue;

    const name = normalizeAttrName(rawName);
    // Drop attribute names that could break out of the tag (defends against a
    // component spreading untrusted keys, e.g. `<div {...untrusted}>`).
    if (!isValidAttrName(name)) continue;

    if (BOOLEAN_ATTRS.has(name)) {
      if (value) out += ` ${name}`;
      continue;
    }
    if (value === true) {
      out += ` ${name}`;
      continue;
    }

    if (name === "style" && typeof value === "object") {
      out += ` style="${escapeHtml(serializeStyle(value as Record<string, unknown>))}"`;
      continue;
    }

    // Drop a dangerous URL scheme (javascript:/vbscript:/executable data:) in a
    // URL-bearing attribute; a no-op for every other attribute.
    const safe = sanitizeUrlAttr(tag, name, String(value));
    if (safe === null) continue;
    out += ` ${name}="${escapeHtml(safe)}"`;
  }
  return out;
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
