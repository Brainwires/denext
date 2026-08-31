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
import {
  ERROR_BOUNDARY,
  isControlSignal,
  reportBoundaryError,
  toClientError,
} from "../runtime/error-boundary.ts";
import {
  beginServerInsertCollection,
  escapeHtml,
  flushServerInsertedHTML,
  type HeadCollector,
  HOISTED_TAGS,
  resolveContextType,
  serializeAttributes,
  VOID_ELEMENTS,
  warnDangerousHtml,
} from "./render-to-string.ts";
import "../runtime/class-flag.ts";
import { classComponentsDisabledError, isClassComponent } from "../compat/class-detect.ts";
import { renderClassToVNode } from "../compat/class-component.ts";
import { invokeComponent, isComponentType, resolveComponentType } from "../runtime/react-brands.ts";
import { isServerAction } from "../runtime/server-action.ts";
import { DNX_H_ATTR, isQrl } from "../runtime/qrl.ts";
import { beginSignalCollection, endSignalCollection } from "../runtime/signal-state.ts";
import { clientRefOf } from "../runtime/client-reference.ts";
import { type HydrationStrategy, parseStrategy } from "../runtime/lazy-directive.ts";
import { islandWrapper, warnClientOnlySeoContent } from "./island-wrapper.ts";
import { type IslandPayload, serializeFlight } from "./render-to-html-flight.ts";
import type { FlightNode, FlightProps, FlightValue } from "./render-to-flight.ts";
import {
  enterScope,
  ID_PATH_PROP,
  type IdHolder,
  nextId,
  rootScope,
  scopePrefix,
} from "./tree-id.ts";

import { SWAP_RUNTIME } from "../server/swap-runtime.ts";

type ProviderScope = Map<symbol, unknown>;

/** A Suspense hole in the Flight tree, filled once the boundary resolves. */
interface FlightHole {
  /** Discriminant: streamed Suspense hole. */
  $: "$";
  /** Boundary id (matches the streamed HTML swap id). */
  r: string;
}

/**
 * A **value hole** in the Flight tree: the placeholder a deferred promise prop
 * (a Remix `defer()` field) leaves behind so the shell can flush WITHOUT awaiting
 * it. The promise settles as the deferred `<Await>`'s Suspense hole streams; the
 * resolved value is substituted into the tail Flight before it is emitted, so the
 * client hydrates with real data instead of the `{}` a bare `Object.entries(promise)`
 * would have produced. Ids are prefixed `dnxv` so a user data object shaped like a
 * value hole can't be mistaken for one during substitution.
 */
interface FlightValueHole {
  /** Discriminant: deferred value hole. */
  $: "vh";
  /** Value-hole id (a `dnxv<n>` key into the resolved-values map). */
  r: string;
}

interface Dual {
  html: string;
  flight: FlightNode;
}

const SKIP = Symbol("skip");

class StreamFlightRenderer {
  private id = 0;
  /**
   * Path-based useId state. The shell renders sequentially so its scopes are
   * deterministic; a streamed boundary's content is rooted at the boundary's
   * position. (Multiple boundaries streaming concurrently share this one holder,
   * so their interior useId ordering keeps the pre-existing streaming caveat — the
   * shell and any single boundary are correct.)
   */
  readonly ids: IdHolder = { scope: rootScope() };
  /**
   * In-flight boundary renders: each **resolves, never rejects**, to id + streamed
   * html + resolved flight + an `ok` flag (a failed boundary streams nothing extra,
   * leaving its shell fallback — see {@link streamFlightHoles}).
   */
  readonly active = new Set<
    Promise<{ id: string; html: string; flight: FlightNode; ok: boolean }>
  >();
  /** Resolved boundary flights, spliced into the shell flight at the end. */
  readonly holes = new Map<string, FlightNode>();
  /**
   * Deferred promise props (Remix `defer()` fields) encountered while serializing
   * props, keyed by value-hole id. The shell emits a `{$:"vh"}` placeholder for
   * each instead of awaiting it (so first paint isn't blocked); {@link resolveValueHoles}
   * drains them at tail time and their resolved values are substituted into the
   * final Flight. Each captures the provider scopes active at serialization so a
   * VNode-valued deferred result serializes in the right context.
   */
  readonly valueHoles = new Map<
    string,
    { promise: PromiseLike<unknown>; scopes: ProviderScope[] }
  >();
  private valueHoleId = 0;
  /**
   * Lazy (`client:*`/resumable) islands carved out during the shell AND hole renders
   * (holes append as they resolve), emitted as `#__denext_islands` in the tail.
   */
  readonly islands: IslandPayload[] = [];
  /** Effect-hook invocations so far (for per-island resumable strategy selection). */
  readonly effects = { count: 0 };
  /** Resumable mode: auto-defer islands + stamp handler hosts. */
  private readonly resumable: boolean;
  /** True while rendering inside a client island's subtree — see render-to-html-flight. */
  private insideIsland = false;
  /**
   * Nested islands carved during a parent island's dual render, keyed by the child
   * VNode. The Flight-children re-walk (pass 2) re-enters scope with an advanced
   * counter, so it would assign a different prefix; this pins each nested island's
   * foreign host to the id its HTML wrapper (pass 1) got. See render-to-html-flight.
   */
  private carvedNested = new WeakMap<
    VNode,
    { id: string; strategy: HydrationStrategy; param?: string }
  >();
  private activeScopes: ProviderScope[] = [];
  private readonly dispatcher: Dispatcher;

  constructor(resumable = false) {
    this.resumable = resumable;
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
      useReducer<S, A, I>(
        _r: (s: S, a: A) => S,
        initialArg: I,
        init?: (arg: I) => S,
      ) {
        return [
          init ? init(initialArg) : (initialArg as unknown as S),
          () => {},
        ] as [
          S,
          () => void,
        ];
      },
      useEffect() {
        self.effects.count++;
      },
      useMemo<T>(factory: () => T) {
        return factory();
      },
      useRef<T>(initial: T) {
        return { current: initial };
      },
      useContext<T>(context: Context<T>): T {
        const scopes = self.activeScopes;
        for (let i = scopes.length - 1; i >= 0; i--) {
          if (scopes[i].has(context._id)) {
            return scopes[i].get(context._id) as T;
          }
        }
        return context._defaultValue;
      },
      useId(): string {
        return nextId(self.ids.scope);
      },
      useSyncExternalStore<T>(
        _s: (o: () => void) => () => void,
        getSnapshot: () => T,
        getServerSnapshot?: () => T,
      ): T {
        self.effects.count++; // subscribes on mount → needs hydration
        return (getServerSnapshot ?? getSnapshot)();
      },
      useLayoutEffect() {
        self.effects.count++;
      },
      useInsertionEffect() {
        self.effects.count++;
      },
      useMemoCache(size: number): unknown[] {
        return new Array(size).fill(MEMO_CACHE_SENTINEL);
      },
    };
  }

  async resolve(
    children: VNodeChildren,
    scopes: ProviderScope[],
    idRoot?: IdHolder["scope"],
    head: HeadCollector | null = null,
  ): Promise<Dual> {
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
  ): Promise<Dual> {
    const arr = Array.isArray(children) ? children : children == null ? [] : [children];
    let html = "";
    const flight: FlightNode[] = [];
    for (const c of arr) {
      const d = await this.renderChild(c, scopes, head);
      html += d.html;
      flight.push(d.flight);
    }
    return { html, flight };
  }

  renderChild(
    child: VNodeChild,
    scopes: ProviderScope[],
    head: HeadCollector | null = null,
  ): Dual | Promise<Dual> {
    if (child == null || child === false || child === true) {
      return { html: "", flight: null };
    }
    if (typeof child === "string") {
      return { html: escapeHtml(child), flight: child };
    }
    if (typeof child === "number") {
      return { html: escapeHtml(String(child)), flight: child };
    }
    if (Array.isArray(child)) return this.renderChildren(child, scopes, head);
    return this.renderVNode(child as VNode, scopes, head);
  }

  async renderVNode(
    node: VNode,
    scopes: ProviderScope[],
    head: HeadCollector | null = null,
  ): Promise<Dual> {
    const { type } = node;
    // Null `props` (some npm libs) is treated as {} — parity with render-to-string.
    const props = node.props ?? {};

    // Suspense: stream the HTML; the Flight tree gets a hole filled on resolve. The
    // boundary is its own id scope (one slot in its parent); its streamed content is
    // rooted at that position so it reproduces the client's ids.
    if ((type as unknown) === SUSPENSE) {
      const id = `dnx${this.id++}`;
      const parentScope = this.ids.scope;
      const boundaryScope = enterScope(parentScope);
      // The id is captured in closure, so a rejected boundary still reports it
      // (ok:false): its shell fallback stays and the rest of the stream is unaffected.
      this.active.add(
        this.resolve(
          props.children,
          scopes,
          rootScope(scopePrefix(boundaryScope)),
        )
          .then((d) => {
            this.holes.set(id, d.flight);
            return { id, html: d.html, flight: d.flight, ok: true };
          })
          .catch((err) => {
            console.error(
              "denext: streamed Flight boundary failed to resolve:",
              id,
              err,
            );
            return { id, html: "", flight: null, ok: false };
          }),
      );
      this.ids.scope = boundaryScope;
      let fallback: Dual;
      try {
        fallback = await this.renderChildren(
          props.fallback as VNodeChildren,
          scopes,
        );
      } finally {
        this.ids.scope = parentScope;
      }
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
        const fb = Fallback({ error: toClientError(err), reset: () => {} });
        const resolved = fb instanceof Promise ? await fb : fb;
        return this.renderChild(resolved as VNodeChild, scopes, head);
      }
    }

    // Function component (or a memo/forwardRef object wrapper). Each opens a fresh
    // id scope (one slot in its parent) so its ids derive from its tree position.
    if (isComponentType(type)) {
      const ref = clientRefOf(type);
      const parentScope = this.ids.scope;
      const scope = enterScope(parentScope);
      this.ids.scope = scope;
      try {
        if (ref) {
          // Client island: render it to HTML for first paint, emit only a REFERENCE
          // in the Flight tree (tagged with its tree-path prefix so the client roots
          // the island's id scope there). A `client:*` directive (or resumable mode)
          // strips the island out for deferred per-island hydration. Mirrors
          // renderToHtmlFlight's carve-out so streamed + buffered Flight agree.
          // Already carved on the HTML pass (this is the Flight-children re-walk):
          // emit the matching foreign host with the SAME id, no re-carve/new prefix.
          const already = this.carvedNested.get(node);
          if (already) {
            return {
              html: "",
              flight: islandWrapper(already.id, already.strategy, already.param, "")
                .flight,
            };
          }
          setDispatcher(this.dispatcher);
          this.activeScopes = scopes;
          const parsed = parseStrategy(props, ref.moduleHydrate);
          const rest = parsed.rest;
          const prefix = scopePrefix(scope);
          // A nested `client:*` island carves independently (its own wrapper +
          // strategy). The Flight-children re-walk (pass 2) re-enters scope with an
          // advanced counter, so it would assign a different prefix; the `carvedNested`
          // guard above pins it to the HTML pass's id. `wasInside` marks it as nested.
          const wasInside = this.insideIsland;
          const recordNested = (
            strategy: HydrationStrategy,
            param?: string,
          ): void => {
            if (wasInside) {
              this.carvedNested.set(node, { id: prefix, strategy, param });
            }
          };

          // client:only — skip SSR: no island HTML, empty foreign wrapper + Flight.
          if (parsed.strategy === "only") {
            this.insideIsland = true;
            const p = await this.serializeProps(rest, scopes);
            p[ID_PATH_PROP] = prefix;
            const childFlight = await this.flightChildren(
              rest.children as VNodeChildren,
              scopes,
            );
            this.insideIsland = wasInside;
            const islandFlight: FlightNode = {
              $: "c",
              i: ref.id,
              p,
              c: childFlight,
            };
            this.islands.push({
              id: prefix,
              strategy: "only",
              flight: islandFlight,
            });
            recordNested("only");
            warnClientOnlySeoContent(rest.children as VNodeChildren, prefix);
            return islandWrapper(prefix, "only", undefined, "");
          }

          const effectsBefore = this.effects.count;
          const rendered = invokeComponent(resolveComponentType(type), rest);
          const out = rendered instanceof Promise ? await rendered : rendered;
          const ranEffect = this.effects.count > effectsBefore;
          this.insideIsland = true; // this island's subtree + children are "inside" it
          const htmlDual = await this.renderChild(
            out as VNodeChild,
            scopes,
            head,
          );
          const hasHandlers = htmlDual.html.includes(DNX_H_ATTR);
          const strategy = parsed.strategy ??
            (this.resumable ? (ranEffect || !hasHandlers ? "idle" : "interaction") : null);
          const p = await this.serializeProps(rest, scopes);
          p[ID_PATH_PROP] = prefix;
          const childFlight = await this.flightChildren(
            rest.children as VNodeChildren,
            scopes,
          );
          this.insideIsland = wasInside;
          const islandFlight: FlightNode = {
            $: "c",
            i: ref.id,
            p,
            c: childFlight,
          };
          if (strategy) {
            // Lazy island: nest its server HTML in a foreign-host wrapper the page
            // root adopts but doesn't own, and stash its Flight for a per-island
            // hydrateRoot when the strategy fires (emitted as #__denext_islands).
            this.islands.push({
              id: prefix,
              strategy,
              param: parsed.param,
              flight: islandFlight,
            });
            recordNested(strategy, parsed.param);
            return islandWrapper(prefix, strategy, parsed.param, htmlDual.html);
          }
          return { html: htmlDual.html, flight: islandFlight };
        }
        setDispatcher(this.dispatcher);
        this.activeScopes = scopes;
        if (isClassComponent(type)) {
          if (__DENEXT_CLASS_COMPONENTS__) {
            return await this.renderChild(
              renderClassToVNode(
                type,
                props,
                resolveContextType(type, scopes),
              ) as VNodeChild,
              scopes,
              head,
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
    let attrs = serializeAttributes(props, tag, this.resumable);
    // A <form> posting to a server action needs method=post for the no-JS path
    // (parity with render-to-html-flight / render-to-string / render-to-stream).
    if (
      tag === "form" && isServerAction(props.action) && props.method == null
    ) {
      attrs += ` method="post"`;
    }
    // React 19 document metadata: hoist in-tree <title>/<meta>/<link> into the head
    // collector (shell render only) instead of emitting them inline — parity with
    // render-to-html-flight and the HTML stream renderer.
    if (head && HOISTED_TAGS.has(tag)) {
      if (tag === "title") {
        head.title = (await this.renderChildren(props.children, scopes, null)).html;
      } else {
        head.tags.push(`<${tag}${attrs}>`);
      }
      return { html: "", flight: null };
    }
    const p = await this.serializeProps(props, scopes);
    if (VOID_ELEMENTS.has(tag)) {
      return { html: `<${tag}${attrs}>`, flight: { $: "h", t: tag, p, c: [] } };
    }
    const dangerous = props.dangerouslySetInnerHTML as
      | { __html: string }
      | undefined;
    if (dangerous && typeof dangerous.__html === "string") {
      warnDangerousHtml(tag);
      return {
        html: `<${tag}${attrs}>${dangerous.__html}</${tag}>`,
        flight: { $: "h", t: tag, p, c: [] },
      };
    }
    const inner = await this.renderChildren(props.children, scopes, head);
    return {
      html: `<${tag}${attrs}>${inner.html}</${tag}>`,
      flight: {
        $: "h",
        t: tag,
        p,
        c: Array.isArray(inner.flight) ? inner.flight : [inner.flight],
      },
    };
  }

  // Flight-only child serialization (for client-island holes).
  async flightChildren(
    children: VNodeChildren,
    scopes: ProviderScope[],
  ): Promise<FlightNode[]> {
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
      if (
        name === "children" || name === "key" || name === "ref" ||
        name === PROVIDER.toString()
      ) {
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
    if (t === "string" || t === "number" || t === "boolean") {
      return value as FlightValue;
    }
    if (isServerAction(value)) return { $: "a", i: value.denextActionId };
    if (isQrl(value)) return { $: "e", i: value.denextQrlId };
    if (t === "function") return SKIP;
    if (value instanceof Date) return { $: "D", v: value.toISOString() };
    // A thenable (a Remix `defer()` field / promise data): DON'T await it here —
    // that would block the shell. Leave a value hole; the promise settles as the
    // deferred `<Await>`'s Suspense hole streams, and its resolved value is
    // substituted into the tail Flight (see resolveValueHoles / substituteValueHoles).
    if (isThenable(value)) {
      const id = `dnxv${this.valueHoleId++}`;
      this.valueHoles.set(id, { promise: value, scopes });
      return { $: "vh", r: id } as unknown as FlightValue;
    }
    if (Array.isArray(value)) {
      const items: FlightValue[] = [];
      for (const el of value) {
        const sv = await this.serializeValue(el, scopes);
        if (sv !== SKIP) items.push(sv as FlightValue);
      }
      return items;
    }
    if (isVNode(value)) {
      return (await this.renderChild(value as VNode, scopes))
        .flight as FlightValue;
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

  /**
   * Await every deferred value hole and serialize its resolved value, returning
   * `id → serialized value`. Loops because serializing a resolved value can register
   * MORE holes (a `defer()` whose value itself contains a promise). A rejected
   * deferred value resolves to `null` — its `<Await>` streamed a fallback via its
   * Suspense boundary; the tail carries `null` rather than a live promise. By the time
   * this runs (after the Suspense holes drained) a hole consumed by `<Await>` is already
   * settled, so this only truly waits on a deferred field nothing rendered.
   */
  async resolveValueHoles(): Promise<Map<string, FlightValue>> {
    const resolved = new Map<string, FlightValue>();
    while (this.valueHoles.size > 0) {
      const batch = [...this.valueHoles];
      this.valueHoles.clear();
      await Promise.all(batch.map(async ([id, { promise, scopes }]) => {
        try {
          const sv = await this.serializeValue(await promise, scopes);
          resolved.set(id, sv === SKIP ? null : sv as FlightValue);
        } catch {
          resolved.set(id, null);
        }
      }));
    }
    return resolved;
  }
}

/** Serialized-leaf discriminants that carry no nested value holes to substitute. */
const LEAF_FLIGHT_TAGS = new Set(["a", "D", "e"]);

/** Resolve a `{$:"vh",r}` placeholder to its deferred value, or leave a look-alike as data. */
function fillValueHole(value: FlightValue, resolved: Map<string, FlightValue>): FlightValue {
  const r = (value as unknown as FlightValueHole).r;
  const filled = typeof r === "string" && r.startsWith("dnxv") ? resolved.get(r) : undefined;
  return filled === undefined ? value : substituteValueHoles(filled, resolved);
}

/**
 * Substitute resolved deferred values (`resolveValueHoles`) into a Flight tree,
 * replacing every `{$:"vh",r}` placeholder — in node children AND in props (where
 * a `defer()` field lives, e.g. the `loaderData` prop of a migrated Remix route).
 * A placeholder whose id isn't a resolved `dnxv` key is left as data (so a user
 * object shaped like a value hole is never corrupted).
 */
function substituteValueHoles(value: FlightValue, resolved: Map<string, FlightValue>): FlightValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => substituteValueHoles(v, resolved));
  const tag = (value as { $?: string }).$;
  if (tag === "vh") return fillValueHole(value, resolved);
  if (tag && LEAF_FLIGHT_TAGS.has(tag)) return value;
  if (tag === "h" || tag === "c") {
    const n = value as unknown as { p: FlightProps; c: FlightNode[] };
    const c = n.c.map((child) =>
      substituteValueHoles(child as FlightValue, resolved) as FlightNode
    );
    return { ...value, p: substitutePropsValueHoles(n.p, resolved), c } as unknown as FlightValue;
  }
  // A plain (data) object nested in a prop: recurse its values.
  return substitutePropsValueHoles(value as FlightProps, resolved);
}

/** Substitute value holes across a serialized props/object map. */
function substitutePropsValueHoles(
  props: FlightProps,
  resolved: Map<string, FlightValue>,
): FlightProps {
  const out: FlightProps = {};
  for (const [k, v] of Object.entries(props)) out[k] = substituteValueHoles(v, resolved);
  return out;
}

function isVNode(value: unknown): value is VNode {
  return typeof value === "object" && value !== null && "type" in value &&
    "props" in value;
}

/** Recursively fill `{$:"$",r}` Suspense holes with their resolved Flight. */
function fillHoles(
  node: FlightNode,
  holes: Map<string, FlightNode>,
): FlightNode {
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

/** The trailing Flight/islands/state payload of a streamed Flight document. */
export interface FlightStreamTail {
  /** The complete Flight tree (holes filled), for `#__denext_flight`. */
  flight: FlightNode;
  /** Lazy (`client:*`/resumable) islands, keyed by tree-path id, or undefined if none. */
  islands?: IslandPayload[];
  /** Serialized signal state (`useId → value`), or undefined if none. */
  signalState?: Record<string, unknown>;
}

/** Options for {@linkcode renderToFlightStream}. */
export interface FlightStreamOptions {
  /** Aborts streaming when signaled. */
  signal?: AbortSignal;
  /** Prepended to the first chunk (e.g. the document head + opening body). */
  shellPrefix?: string;
  /** Appended after the trailing islands (e.g. the client entry script + `</body>`). */
  shellSuffix?: string;
  /** Resumable mode: auto-defer islands + stamp handler hosts (see SegmentConfig). */
  resumable?: boolean;
}

/**
 * A rendered Flight shell plus its pending Suspense holes and payload accumulators.
 * The document assembler flushes {@link shellHtml}, streams the holes (each as a
 * `<template data-dnx-r>`), then emits the {@link tail} — Flight + islands + signal
 * state — so the client hydrates the complete tree with its islands wired up.
 */
export interface FlightShellRender {
  /** The shell HTML (Suspense boundaries as `data-dnx-b` placeholders). */
  shellHtml: string;
  /**
   * Whether the shell has any pending Suspense holes. When false there is nothing to
   * stream, so the caller can drain the tail (via {@link streamHoles} with a
   * discarding controller — nothing is enqueued) and serve a buffered document.
   */
  hasHoles: boolean;
  /** Drain the pending holes into `controller`, then return the tail payload. */
  streamHoles(
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
    signal?: AbortSignal,
  ): Promise<FlightStreamTail>;
}

/**
 * Render the Flight **shell** eagerly (so a control signal thrown before any flush
 * is catchable by the caller) and return it plus a `streamHoles` drainer. Signal
 * collection spans the whole render (shell + holes), so the tail's `signalState`
 * captures every island's `useSignal`/`useStore`. The shared module-global signal
 * collector means concurrent Flight renders can interleave — the same constraint as
 * the buffered Flight path, widened by the streaming window (documented limitation).
 *
 * @param node The tree to render.
 * @param resumable Auto-defer islands + stamp handler hosts.
 * @param head Collector for in-tree `<title>`/`<meta>`/`<link>` hoisted from the
 *   shell (holes resolve after the head flush, so their head tags stay inline).
 */
export async function renderFlightShell(
  node: VNodeChildren,
  resumable = false,
  head: HeadCollector | null = null,
): Promise<FlightShellRender> {
  const renderer = new StreamFlightRenderer(resumable);
  beginSignalCollection();
  // Hoist `useServerInsertedHTML` (CSS-in-JS) markup produced during the shell render
  // into <head> before it flushes — the client-boundary streaming counterpart of the
  // same collection in renderToHtmlFlight; otherwise styled-components/emotion styles
  // are dropped on the default streaming Flight path.
  const sink = beginServerInsertCollection();
  let shell: Dual;
  try {
    shell = await renderer.resolve(node, [], undefined, head);
    flushServerInsertedHTML(sink.inserted, head);
  } catch (err) {
    endSignalCollection(); // reset the module collector even if the shell throws
    throw err;
  } finally {
    sink.end();
  }
  return {
    shellHtml: shell.html,
    hasHoles: renderer.active.size > 0,
    async streamHoles(controller, encoder, signal) {
      try {
        while (renderer.active.size > 0) {
          if (signal?.aborted) break;
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
        // All Suspense holes resolved: build the complete Flight tree (holes filled)
        // and the islands/signal-state accumulated across the shell and every hole.
        let root = shell.flight;
        if (Array.isArray(root) && root.length === 1) root = root[0];
        let flight = fillHoles(root, renderer.holes);
        // Deferred `defer()` props left value-hole placeholders so the shell could
        // flush; their promises have settled as the holes streamed, so substitute the
        // resolved values into the tail Flight (the client hydrates with real data, not
        // the `{}` a bare promise would serialize to). Resolve BEFORE endSignalCollection
        // in case a resolved deferred VNode touched a signal.
        const resolvedValues = await renderer.resolveValueHoles();
        if (resolvedValues.size > 0) {
          flight = substituteValueHoles(flight, resolvedValues) as FlightNode;
        }
        const signalState = endSignalCollection();
        return {
          flight,
          islands: renderer.islands.length > 0 ? renderer.islands : undefined,
          signalState: Object.keys(signalState).length > 0 ? signalState : undefined,
        };
      } catch (err) {
        endSignalCollection();
        throw err;
      }
    },
  };
}

/**
 * Render a VNode tree to a self-contained streaming HTML `ReadableStream` carrying
 * the complete Flight payload (plus islands + signal state) as trailing islands.
 * Suspense boundaries stream progressively; the payload is emitted once all resolve.
 * A convenience wrapper over {@link renderFlightShell} (used by tests/tools); the
 * request pipeline composes {@link renderFlightShell} into a full document instead.
 *
 * @param node The tree to render.
 * @param options Shell prefix/suffix, resumable mode, and abort signal.
 */
export function renderToFlightStream(
  node: VNodeChildren,
  options: FlightStreamOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const shell = await renderFlightShell(node, options.resumable);
        controller.enqueue(
          encoder.encode(
            (options.shellPrefix ?? "") + SWAP_RUNTIME + shell.shellHtml,
          ),
        );
        const tail = await shell.streamHoles(
          controller,
          encoder,
          options.signal,
        );
        controller.enqueue(encoder.encode(flightTailScripts(tail)));
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

/**
 * Serialize a {@link FlightStreamTail} to the trailing `<script type="application/json">`
 * islands: `#__denext_flight` (always), then `#__denext_islands` and `#__denext_state`
 * when present. Exposed so the document assembler can emit the same tail.
 */
export function flightTailScripts(tail: FlightStreamTail): string {
  let out = `<script id="__denext_flight" type="application/json">${
    serializeFlight(tail.flight)
  }</script>`;
  if (tail.islands && tail.islands.length > 0) {
    const map: Record<string, unknown> = {};
    for (const island of tail.islands) map[island.id] = island.flight;
    out += `<script id="__denext_islands" type="application/json">${
      JSON.stringify(map).replace(/</g, "\\u003c")
    }</script>`;
  }
  if (tail.signalState && Object.keys(tail.signalState).length > 0) {
    out += `<script id="__denext_state" type="application/json">${
      JSON.stringify(tail.signalState).replace(/</g, "\\u003c")
    }</script>`;
  }
  return out;
}
