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
    useMemoCache(size: number): unknown[] {
      // One-shot render: a fresh cache each time. Generated code still recomputes
      // correctly (every slot reads as the sentinel), it just never reuses across
      // renders — which the server never does anyway.
      return new Array(size).fill(MEMO_CACHE_SENTINEL);
    },
  };
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
  const { type, props } = node;

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
    const result = await type(props as never);
    return renderChild(result as VNodeChild, scopes, dispatcher, head);
  }

  // Intrinsic element.
  const tag = type as string;
  let attrs = serializeAttributes(props);
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
    return `<${tag}${attrs}>${dangerous.__html}</${tag}>`;
  }

  const inner = await renderChildren(props.children, scopes, dispatcher, head);
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/** Serialize a props object into an attribute string (leading space per attr). */
export function serializeAttributes(props: Record<string, unknown>): string {
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

    out += ` ${name}="${escapeHtml(String(value))}"`;
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
