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
const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape `&`, `<`, `>`, `"`, and `'` so a string is safe as HTML text or attribute content. */
export function escapeHtml(value: string): string {
  return value.replace(ESCAPE_RE, (c) => ESCAPE_MAP[c]);
}

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
  return name.length > 0 && !ILLEGAL_ATTR_NAME.test(name) && !/^on/i.test(name);
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
 * Render a VNode (or renderable child) to an HTML string.
 * This is the primary SSR entry point.
 */
export async function renderToString(
  node: VNodeChildren,
  options: RenderOptions = {},
): Promise<string> {
  const scopes: ProviderScope[] = [];
  const dispatcher = createSSRDispatcher(scopes);
  const head = options.head ?? null;
  const prev = setDispatcher(dispatcher);
  try {
    return await renderChildren(node, scopes, dispatcher, head);
  } finally {
    setDispatcher(prev);
  }
}

async function renderChildren(
  children: VNodeChildren,
  scopes: ProviderScope[],
  dispatcher: Dispatcher,
  head: HeadCollector | null,
): Promise<string> {
  if (Array.isArray(children)) {
    const parts = await Promise.all(
      children.map((c) => renderChild(c, scopes, dispatcher, head)),
    );
    return parts.join("");
  }
  return renderChild(children, scopes, dispatcher, head);
}

function renderChild(
  child: VNodeChild,
  scopes: ProviderScope[],
  dispatcher: Dispatcher,
  head: HeadCollector | null,
): string | Promise<string> {
  if (child == null || child === false || child === true) return "";
  // React flattens arbitrarily-nested children arrays; some libraries (recharts)
  // pass a nested array as a single child, so recurse instead of treating it as a node.
  if (Array.isArray(child)) {
    return renderChildren(child as VNodeChildren, scopes, dispatcher, head);
  }
  if (typeof child === "string") return escapeHtml(child);
  if (typeof child === "number") return escapeHtml(String(child));
  return renderVNode(child as VNode, scopes, dispatcher, head);
}

async function renderVNode(
  node: VNode,
  scopes: ProviderScope[],
  dispatcher: Dispatcher,
  head: HeadCollector | null,
): Promise<string> {
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
      scopes.push(scope);
      try {
        return await renderChildren(props.children, scopes, dispatcher, head);
      } finally {
        scopes.pop();
      }
    }
    return renderChildren(props.children, scopes, dispatcher, head);
  }

  // Portal: its children target a client DOM node that doesn't exist during SSR,
  // so — like React's server renderer — a portal emits nothing.
  if ((type as unknown) === PORTAL) return "";

  // Suspense boundary: fully resolve children, retrying on suspension.
  // (String rendering has no streaming, so the fallback is never shown.)
  if ((type as unknown) === SUSPENSE) {
    for (;;) {
      try {
        return await renderChildren(props.children, scopes, dispatcher, head);
      } catch (err) {
        if (isThenable(err)) {
          await err;
          continue;
        }
        throw err;
      }
    }
  }

  // Error boundary: render children; on a (non-suspension) throw, render fallback.
  if ((type as unknown) === ERROR_BOUNDARY) {
    try {
      return await renderChildren(props.children, scopes, dispatcher, head);
    } catch (err) {
      // Suspensions go to <Suspense>; notFound()/forbidden()/unauthorized()
      // bubble to the page handler for status-code rendering.
      if (isThenable(err) || isControlSignal(err)) throw err;
      const Fallback = props.fallback as (
        p: { error: Error; reset: () => void },
      ) => VNode;
      setDispatcher(dispatcher);
      const node = await Fallback({ error: toError(err), reset: () => {} });
      return renderChild(node as VNodeChild, scopes, dispatcher, head);
    }
  }

  // Function component.
  if (typeof type === "function") {
    setDispatcher(dispatcher);
    // Class components: cheap always-on detection; the runtime is gated (folds out
    // when classComponents is off), and using a class off throws a guided error.
    if (isClassComponent(type)) {
      if (__DENEXT_CLASS_COMPONENTS__) {
        const result = renderClassToVNode(type, props, resolveContextType(type, scopes));
        return renderChild(result as VNodeChild, scopes, dispatcher, head);
      }
      throw classComponentsDisabledError();
    }
    const result = await type(props as never);
    return renderChild(result as VNodeChild, scopes, dispatcher, head);
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
  if (head && HOISTED_TAGS.has(tag)) {
    if (tag === "title") {
      head.title = await renderChildren(props.children, scopes, dispatcher, null);
    } else {
      head.tags.push(`<${tag}${attrs}>`);
    }
    return "";
  }

  if (VOID_ELEMENTS.has(tag)) {
    return `<${tag}${attrs}>`;
  }

  // dangerouslySetInnerHTML support (raw HTML injection).
  const dangerous = props.dangerouslySetInnerHTML as
    | { __html: string }
    | undefined;
  if (dangerous && typeof dangerous.__html === "string") {
    warnDangerousHtml(tag);
    return `<${tag}${attrs}>${dangerous.__html}</${tag}>`;
  }

  const inner = await renderChildren(props.children, scopes, dispatcher, head);
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/**
 * Serialize a props object into an attribute string (leading space per attr).
 * `tag` (the host element name, when known) lets URL-attribute sanitization tell a
 * navigable/scripty context apart from a safe media `src`.
 */
export function serializeAttributes(props: Record<string, unknown>, tag?: string): string {
  let out = "";
  for (const [rawName, value] of Object.entries(props)) {
    if (
      rawName === "children" ||
      rawName === "key" ||
      rawName === "ref" ||
      rawName === "dangerouslySetInnerHTML" ||
      rawName === PROVIDER.toString()
    ) continue;
    // Event handlers are client-only; skip during SSR. Match case-INsensitively:
    // React-style `onClick` AND lowercase HTML-native names (`onmouseover`,
    // `onerror`, …). The lowercase forms would otherwise pass `isValidAttrName`
    // and emit a live handler attribute — an XSS sink for `<div {...untrusted}>`.
    if (/^on/i.test(rawName)) continue;
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
  for (const [prop, value] of Object.entries(style)) {
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
