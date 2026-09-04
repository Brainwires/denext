// Building blocks shared by the server renderers (string, stream, PPR, Flight, HTML+Flight,
// Flight stream, PPR+Flight). Each walks the same VNode kinds — provider fragments, Suspense,
// error boundaries, components, client islands, host elements — and differs only in what it
// produces (HTML, Flight, or both) and in how Suspense boundaries are scheduled. The per-kind
// logic that is renderer-neutral lives here, so a fix lands once and cannot drift between
// renderers.

import "../runtime/class-flag.ts";
import { PROVIDER } from "../runtime/context.ts";
import { isThenable } from "../runtime/suspense.ts";
import { isControlSignal, reportBoundaryError, toClientError } from "../runtime/error-boundary.ts";
import { invokeComponent, resolveComponentType } from "../runtime/react-brands.ts";
import type { ClientRefInfo } from "../runtime/client-reference.ts";
import { isServerAction } from "../runtime/server-action.ts";
import { DNX_H_ATTR } from "../runtime/qrl.ts";
import { type HydrationStrategy, parseStrategy } from "../runtime/lazy-directive.ts";
import { classComponentsDisabledError, isClassComponent } from "../compat/class-detect.ts";
import { renderClassToVNode } from "../compat/class-component.ts";
import {
  type HeadCollector,
  HOISTED_TAGS,
  type ProviderScope,
  resolveContextType,
  serializeAttributes,
  VOID_ELEMENTS,
  warnDangerousHtml,
} from "./render-to-string.ts";
import { enterScope, ID_PATH_PROP, type IdHolder, type IdScope } from "./tree-id.ts";
import type { VNode, VNodeChild, VNodeChildren } from "./types.ts";
import { islandWrapper, warnClientOnlySeoContent } from "./island-wrapper.ts";
import type { FlightNode, FlightProps, FlightValue } from "./render-to-flight.ts";
import { serializeScalar, serializeThenable } from "./flight-scalar.ts";

/** A renderer output that carries both the SSR HTML and the Flight tree for the same subtree. */
export interface Dual {
  html: string;
  flight: FlightNode;
}

// ---- Provider fragments ------------------------------------------------------------

/**
 * The context scope a FRAGMENT vnode carries (`<Ctx.Provider>` renders as a fragment tagged
 * with the provider id + value), or null for a plain fragment.
 */
export function providerScopeOf(props: Record<string, unknown>): ProviderScope | null {
  const info = props[PROVIDER as unknown as string] as { id: symbol; value: unknown } | undefined;
  return info ? new Map([[info.id, info.value]]) : null;
}

/** `scopes` extended with the provider a fragment carries (the same array for a plain one). */
export function scopesWithProvider(
  scopes: ProviderScope[],
  props: Record<string, unknown>,
): ProviderScope[] {
  const scope = providerScopeOf(props);
  return scope ? [...scopes, scope] : scopes;
}

// ---- Id scopes ------------------------------------------------------------------------

/** Enter a fresh child id scope for `ids`, returning the parent so the caller can restore it. */
export function pushScope(ids: IdHolder): { parent: IdScope; scope: IdScope } {
  const parent = ids.scope;
  const scope = enterScope(parent);
  ids.scope = scope;
  return { parent, scope };
}

/** The id-scope state an error boundary restores before rendering its fallback. */
export interface ScopeCheckpoint {
  scope: IdScope;
  count: number;
  local: number;
}

/** Snapshot the current id scope (taken before an error boundary renders its children). */
export function checkpointScope(ids: IdHolder): ScopeCheckpoint {
  const scope = ids.scope;
  return { scope, count: scope.count, local: scope.local };
}

/**
 * Render a Suspense subtree in its own id scope (one slot in the parent; content rooted at the
 * boundary's position), retrying on suspension. Each retry resets the boundary scope's own
 * counters — the parent slot is already fixed — so the ids the client computes still line up.
 */
export async function resolveInBoundaryScope<T>(
  ids: IdHolder,
  render: () => Promise<T>,
): Promise<T> {
  const parentScope = ids.scope;
  const boundaryScope = enterScope(parentScope);
  try {
    for (;;) {
      boundaryScope.count = 0;
      boundaryScope.local = 0;
      ids.scope = boundaryScope;
      try {
        return await render();
      } catch (err) {
        if (!isThenable(err)) throw err;
        await err;
      }
    }
  } finally {
    ids.scope = parentScope;
  }
}

// ---- Error boundaries ----------------------------------------------------------------

/**
 * Whether an error caught at an error boundary must propagate instead: a suspension (the
 * enclosing Suspense retries), a control signal (redirect/notFound bubble to the page handler),
 * or a renderer-specific pass-through such as PPR's Postpone.
 */
export function passesThroughBoundary(
  err: unknown,
  alsoPasses?: (err: unknown) => boolean,
): boolean {
  return isThenable(err) || isControlSignal(err) || (alsoPasses?.(err) ?? false);
}

/**
 * An error boundary's fallback for `err`: rewind the id scope to its pre-children state (so the
 * fallback's ids line up with the client's), re-activate the renderer's hook dispatcher, report
 * the error, and invoke the fallback component. Returns the fallback's rendered child.
 */
export async function renderBoundaryFallback(
  props: Record<string, unknown>,
  err: unknown,
  ids: IdHolder,
  checkpoint: ScopeCheckpoint,
  activate: () => void,
): Promise<VNodeChild> {
  ids.scope = checkpoint.scope;
  checkpoint.scope.count = checkpoint.count;
  checkpoint.scope.local = checkpoint.local;
  activate();
  reportBoundaryError(props, err);
  const Fallback = props.fallback as (
    p: { error: Error; reset: () => void },
  ) => VNode | Promise<VNode>;
  return await Fallback({ error: toClientError(err), reset: () => {} }) as VNodeChild;
}

/** What {@link renderErrorBoundaryWith} composes from a function-style renderer. */
export interface ErrorBoundaryOps<T> {
  /** Render the boundary's children. */
  render(children: VNodeChildren): Promise<T>;
  /** Render what the fallback returned. */
  renderFallback(child: VNodeChild): T | Promise<T>;
  /** Re-install the renderer's hook dispatcher before the fallback runs. */
  activate(): void;
}

/**
 * Error boundary: render children; on a non-control throw, render the fallback from the
 * pre-children scope state (so its ids line up with the client's).
 */
export async function renderErrorBoundaryWith<T>(
  props: Record<string, unknown>,
  ids: IdHolder,
  ops: ErrorBoundaryOps<T>,
): Promise<T> {
  const checkpoint = checkpointScope(ids);
  try {
    return await ops.render(props.children as VNodeChildren);
  } catch (err) {
    if (passesThroughBoundary(err)) throw err;
    return await ops.renderFallback(
      await renderBoundaryFallback(props, err, ids, checkpoint, ops.activate),
    );
  }
}

// ---- Components -------------------------------------------------------------------------

/**
 * Invoke a server component — a function, a memo/forwardRef wrapper, or (when the class runtime
 * is compiled in) a class component — and return what it rendered. Sync components (the common
 * case) return a VNode and never allocate a promise; an async server component returns one.
 * The caller has already activated its hook dispatcher and entered the component's id scope.
 */
export function invokeServerComponent(
  type: unknown,
  props: Record<string, unknown>,
  scopes: ProviderScope[],
): VNodeChild | Promise<VNodeChild> {
  if (isClassComponent(type)) {
    if (__DENEXT_CLASS_COMPONENTS__) {
      return renderClassToVNode(type, props, resolveContextType(type, scopes)) as VNodeChild;
    }
    throw classComponentsDisabledError();
  }
  return invokeComponent(resolveComponentType(type), props) as VNodeChild | Promise<VNodeChild>;
}

// ---- Host elements ------------------------------------------------------------------------

/**
 * A host element's open-tag attributes. A `<form>` posting to a server action gets
 * `method="post"` so the no-JS path submits a working form instead of defaulting to GET.
 */
export function hostAttrs(props: Record<string, unknown>, tag: string, resumable = false): string {
  const attrs = serializeAttributes(props, tag, resumable);
  const postsAction = tag === "form" && isServerAction(props.action) && props.method == null;
  return postsAction ? attrs + ` method="post"` : attrs;
}

/** The verbatim inner HTML of a `dangerouslySetInnerHTML` prop (warned in dev), or null. */
function dangerousInnerHtml(props: Record<string, unknown>, tag: string): string | null {
  const dangerous = props.dangerouslySetInnerHTML as { __html: string } | undefined;
  if (!dangerous || typeof dangerous.__html !== "string") return null;
  warnDangerousHtml(tag);
  return dangerous.__html;
}

/**
 * React 19 document metadata: hoist an in-tree `<title>`/`<meta>`/`<link>` into the head
 * collector instead of emitting it inline. Callers check `hoistsToHead` synchronously first
 * — an `await` on a non-hoisted element would delay its children by a microtask.
 */
async function hoistIntoHead(
  head: HeadCollector,
  tag: string,
  attrs: string,
  renderTitle: () => Promise<string>,
): Promise<void> {
  if (tag === "title") head.title = await renderTitle();
  else head.tags.push(`<${tag}${attrs}>`);
}

/** Whether `tag` hoists into an active head collector. */
function hoistsToHead(head: HeadCollector | null, tag: string): head is HeadCollector {
  return head !== null && HOISTED_TAGS.has(tag);
}

/** `<tag attrs>` for a void element, else `<tag attrs>inner</tag>`. */
function hostHtml(tag: string, attrs: string, inner: string): string {
  return VOID_ELEMENTS.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${inner}</${tag}>`;
}

/** A Flight host node. */
export function flightHost(tag: string, p: FlightProps, c: FlightNode[]): FlightNode {
  return { $: "h", t: tag, p, c };
}

/** A children result's Flight as a host node's child list (children flights are arrays). */
function asFlightArray(flight: FlightNode): FlightNode[] {
  return Array.isArray(flight) ? flight : [flight];
}

/** The operations {@link renderHostHtml} composes, bound to the renderer's current scopes. */
export interface HostHtmlOps {
  renderChildren(children: VNodeChildren): Promise<string>;
  /** Render a hoisted `<title>`'s children to its text. */
  renderTitle(children: VNodeChildren): Promise<string>;
}

/**
 * Render an intrinsic host element to HTML. React 19 document metadata: an in-tree
 * `<title>`/`<meta>`/`<link>` hoists into `head` when a collector is active (the shell
 * render) instead of emitting inline.
 */
export async function renderHostHtml(
  tag: string,
  props: Record<string, unknown>,
  attrs: string,
  head: HeadCollector | null,
  ops: HostHtmlOps,
): Promise<string> {
  const children = props.children as VNodeChildren;
  if (hoistsToHead(head, tag)) {
    await hoistIntoHead(head, tag, attrs, () => ops.renderTitle(children));
    return "";
  }
  if (VOID_ELEMENTS.has(tag)) return hostHtml(tag, attrs, "");
  const dangerous = dangerousInnerHtml(props, tag);
  if (dangerous !== null) return hostHtml(tag, attrs, dangerous);
  return hostHtml(tag, attrs, await ops.renderChildren(children));
}

/** What {@link renderHostDual} needs from a dual renderer, bound to explicit scopes. */
export interface DualHost {
  /** Serialize one prop value for Flight. */
  serializeValue(value: unknown, scopes: ProviderScope[]): Promise<Serialized>;
  /** Render children into both outputs; `head` is null for a hoisted `<title>`'s text. */
  renderChildren(
    children: VNodeChildren,
    scopes: ProviderScope[],
    head: HeadCollector | null,
  ): Promise<Dual>;
}

/**
 * Render an intrinsic host element into both outputs (see {@link renderHostHtml} for the
 * head hoisting). A hoisted element contributes nothing to either output.
 */
export async function renderHostDual(
  r: DualHost,
  node: VNode,
  resumable: boolean,
  scopes: ProviderScope[],
  head: HeadCollector | null,
): Promise<Dual> {
  const props = node.props ?? {};
  const tag = node.type as string;
  const attrs = hostAttrs(props, tag, resumable);
  const children = props.children as VNodeChildren;
  if (hoistsToHead(head, tag)) {
    await hoistIntoHead(
      head,
      tag,
      attrs,
      async () => (await r.renderChildren(children, scopes, null)).html,
    );
    return { html: "", flight: null };
  }
  const p = await serializeFlightProps(props, (v) => r.serializeValue(v, scopes));
  if (VOID_ELEMENTS.has(tag)) {
    return { html: hostHtml(tag, attrs, ""), flight: flightHost(tag, p, []) };
  }
  const dangerous = dangerousInnerHtml(props, tag);
  if (dangerous !== null) {
    return { html: hostHtml(tag, attrs, dangerous), flight: flightHost(tag, p, []) };
  }
  const inner = await r.renderChildren(children, scopes, head);
  return {
    html: hostHtml(tag, attrs, inner.html),
    flight: flightHost(tag, p, asFlightArray(inner.flight)),
  };
}

// ---- PPR holes -------------------------------------------------------------------------------

/** Comment marker opening a hole's replaceable region in a PPR shell. */
export function holeOpen(id: string): string {
  return `<!--dnx-h:${id}-->`;
}

/** Comment marker closing a hole's replaceable region in a PPR shell. */
export function holeClose(id: string): string {
  return `<!--/dnx-h:${id}-->`;
}

// ---- Client islands ------------------------------------------------------------------------

/** A deferred-hydration island: its tree-path id, strategy, and own Flight tree. */
export interface IslandPayload {
  /** The island's tree-path prefix (client discovery key = `data-dnx-id`). */
  id: string;
  /** When to hydrate it. */
  strategy: HydrationStrategy;
  /** Strategy parameter (the media query, for a `media` island). */
  param?: string;
  /** The island's own Flight tree, hydrated on its wrapper when the strategy fires. */
  flight: FlightNode;
}

/**
 * A nested `client:*` island carved during its parent island's HTML pass. The parent's
 * Flight-children re-walk (pass 2) re-enters scope with an advanced counter, so it would assign
 * a different prefix; keying by the child VNode pins its foreign host to the id the HTML wrapper
 * got, so the two tree walks agree by object identity.
 */
export interface CarvedIsland {
  id: string;
  strategy: HydrationStrategy;
  param?: string;
}

/** The renderer state and operations {@link renderClientIsland} composes. */
export interface IslandRenderer {
  /** Resumable mode: auto-defer every island. */
  readonly resumable: boolean;
  /** Effect-hook invocations so far (an island that ran one must hydrate to run it). */
  readonly effects: { count: number };
  /** True while rendering inside a client island's subtree. */
  insideIsland: boolean;
  /** Nested islands carved on the HTML pass (see {@link CarvedIsland}). */
  readonly carvedNested: WeakMap<VNode, CarvedIsland>;
  /** Record a carved island for per-island hydration (a discarded pass may drop it). */
  recordIsland(island: IslandPayload): void;
  /** Render what the island returned (HTML + Flight), inside the island. */
  renderChild(
    child: VNodeChild,
    scopes: ProviderScope[],
    head: HeadCollector | null,
  ): Dual | Promise<Dual>;
  /** Serialize one prop value for the island's client reference. */
  serializeValue(value: unknown, scopes: ProviderScope[]): Promise<Serialized>;
  /**
   * Serialize the island's children (Flight only — the HTML came from the island's own
   * render). Defaults to a dual render of each child with the HTML discarded; a renderer
   * with a cheaper Flight-only walk supplies its own.
   */
  flightChildren?(children: VNodeChildren, scopes: ProviderScope[]): Promise<FlightNode[]>;
}

/**
 * Render children **sequentially** into both outputs (deterministic DFS order, so the shared
 * useId counter advances in tree order — matching how the browser re-runs the islands).
 */
export async function renderDualChildren(
  children: VNodeChildren,
  renderChild: (child: VNodeChild) => Dual | Promise<Dual>,
): Promise<Dual> {
  const arr = Array.isArray(children) ? children : children == null ? [] : [children];
  let html = "";
  const flight: FlightNode[] = [];
  for (const child of arr) {
    const d = await renderChild(child);
    html += d.html;
    flight.push(d.flight);
  }
  return { html, flight };
}

/** Each child's Flight from a dual render (the HTML side is discarded). */
async function flightChildrenOf(
  children: VNodeChildren,
  renderChild: (child: VNodeChild) => Dual | Promise<Dual>,
): Promise<FlightNode[]> {
  const arr = Array.isArray(children) ? children : children == null ? [] : [children];
  const out: FlightNode[] = [];
  for (const c of arr) out.push((await renderChild(c)).flight);
  return out;
}

/**
 * A client island: render its HTML for first paint but emit only a REFERENCE in the Flight
 * tree, tagged with its tree-path `prefix` so the client roots the island's id scope there.
 * A `client:*` directive (or resumable mode) carves it into a foreign-host wrapper plus its
 * own island Flight for deferred per-island hydration; `client:only` skips SSR entirely (no
 * first paint). A nested island already carved on the HTML pass re-emits its foreign host
 * under the same id.
 */
export async function renderClientIsland(
  r: IslandRenderer,
  node: VNode,
  type: unknown,
  ref: ClientRefInfo,
  props: Record<string, unknown>,
  prefix: string,
  scopes: ProviderScope[],
  head: HeadCollector | null,
): Promise<Dual> {
  const already = r.carvedNested.get(node);
  if (already) {
    return {
      html: "",
      flight: islandWrapper(already.id, already.strategy, already.param, "").flight,
    };
  }
  const parsed = parseStrategy(props, ref.moduleHydrate);
  const rest = parsed.rest;
  const wasInside = r.insideIsland;
  if (parsed.strategy === "only") {
    const flight = await islandFlightInside(r, ref.id, rest, prefix, scopes, wasInside);
    carveIsland(r, node, { id: prefix, strategy: "only", flight }, wasInside);
    warnClientOnlySeoContent(rest.children as VNodeChildren, prefix);
    return islandWrapper(prefix, "only", undefined, "");
  }
  const effectsBefore = r.effects.count;
  const out = invokeComponent(resolveComponentType(type), rest) as VNodeChild | Promise<VNodeChild>;
  const rendered = out instanceof Promise ? await out : out;
  const ranEffect = r.effects.count > effectsBefore;
  r.insideIsland = true; // this island's subtree + children are "inside" it
  const htmlDual = await r.renderChild(rendered, scopes, head);
  const strategy = pickIslandStrategy(parsed.strategy, r.resumable, ranEffect, htmlDual.html);
  const flight = await islandFlightInside(r, ref.id, rest, prefix, scopes, wasInside);
  if (!strategy) return { html: htmlDual.html, flight };
  carveIsland(r, node, { id: prefix, strategy, param: parsed.param, flight }, wasInside);
  return islandWrapper(prefix, strategy, parsed.param, htmlDual.html);
}

/** The island's client reference (props + Flight children), serialized inside the island. */
async function islandFlightInside(
  r: IslandRenderer,
  refId: string,
  rest: Record<string, unknown>,
  prefix: string,
  scopes: ProviderScope[],
  wasInside: boolean,
): Promise<FlightNode> {
  r.insideIsland = true;
  try {
    const p = await serializeFlightProps(rest, (v) => r.serializeValue(v, scopes));
    const children = rest.children as VNodeChildren;
    const c = r.flightChildren
      ? await r.flightChildren(children, scopes)
      : await flightChildrenOf(children, (child) => r.renderChild(child, scopes, null));
    return flightClientRef(refId, p, prefix, c);
  } finally {
    r.insideIsland = wasInside;
  }
}

/** Record a carved island; a nested one is also pinned for the parent's Flight-children re-walk. */
function carveIsland(r: IslandRenderer, node: VNode, island: IslandPayload, nested: boolean): void {
  r.recordIsland(island);
  if (nested) {
    r.carvedNested.set(node, { id: island.id, strategy: island.strategy, param: island.param });
  }
}

/** A client component reference node, tagged with the island's tree-path prefix. */
export function flightClientRef(
  id: string,
  p: FlightProps,
  prefix: string,
  c: FlightNode[],
): FlightNode {
  p[ID_PATH_PROP] = prefix;
  return { $: "c", i: id, p, c };
}

/**
 * The hydration strategy for a rendered island: its own `client:*` directive wins; otherwise
 * resumable mode defers every island — `interaction` when it only has handlers (maximal
 * laziness), `idle` when it ran an effect (it must hydrate to run) or has nothing to wait for;
 * null means hydrate with the page root.
 */
function pickIslandStrategy(
  declared: HydrationStrategy | null | undefined,
  resumable: boolean,
  ranEffect: boolean,
  html: string,
): HydrationStrategy | null {
  if (declared) return declared;
  if (!resumable) return null;
  return ranEffect || !html.includes(DNX_H_ATTR) ? "idle" : "interaction";
}

// ---- Flight value serialization -------------------------------------------------------------

/** Sentinel for a value that does not cross to the client (undefined, a function, a symbol…). */
export const SKIP: unique symbol = Symbol("skip");

/** The result of serializing one value: a Flight value, or {@link SKIP}. */
export type Serialized = FlightValue | typeof SKIP;

/** A prop that never serializes: children render separately; key/ref/provider are structural. */
function isStructuralProp(name: string): boolean {
  return name === "children" || name === "key" || name === "ref" || name === PROVIDER.toString();
}

/** Serialize a props record into Flight props, skipping structural props and dropped values. */
export async function serializeFlightProps(
  props: Record<string, unknown>,
  serialize: (value: unknown) => Promise<Serialized>,
): Promise<FlightProps> {
  const out: FlightProps = {};
  for (const [name, value] of Object.entries(props)) {
    if (isStructuralProp(name)) continue;
    const sv = await serialize(value);
    if (sv !== SKIP) out[name] = sv;
  }
  return out;
}

/** How a renderer serializes the compound cases (see {@link serializeFlightValue}). */
export interface ValueSerializer {
  /** Recursive entry: serialize one nested value (the renderer's own `serializeValue`). */
  value: (value: unknown) => Promise<Serialized>;
  /** A VNode-valued prop (`icon={<Icon/>}`) — rendered as a Flight node. */
  vnode: (node: VNode) => Promise<FlightValue>;
  /** Optional plain-object key escape (the HTML+Flight renderer escapes a leading `$`). */
  keyOf?: (key: string) => string;
}

/**
 * Serialize one value for Flight: the shared leaf cascade (primitives, action/qrl refs, dropped
 * functions, Date), an awaited thenable (a Remix `defer()` field — the resolved value is
 * re-serialized; a rejection becomes the error marker so `<Await>` renders its `errorElement`),
 * then the compound cases: arrays, VNodes and plain objects. Anything else (a symbol, a bigint)
 * is dropped.
 */
export async function serializeFlightValue(
  value: unknown,
  s: ValueSerializer,
): Promise<Serialized> {
  const scalar = serializeScalar(value);
  if (scalar.kind === "value") return scalar.value;
  if (scalar.kind === "skip") return SKIP;
  if (scalar.kind === "thenable") return await serializeThenable(scalar.promise, s.value);
  return await serializeCompound(value, s);
}

/** The compound half of {@link serializeFlightValue}: arrays, VNodes, plain objects. */
export async function serializeCompound(value: unknown, s: ValueSerializer): Promise<Serialized> {
  if (Array.isArray(value)) return await serializeArray(value, s);
  if (isVNode(value)) return await s.vnode(value);
  if (typeof value === "object" && value !== null) return await serializeObject(value, s);
  return SKIP;
}

/** An array prop: dropped entries are removed. */
async function serializeArray(value: unknown[], s: ValueSerializer): Promise<FlightValue[]> {
  const items: FlightValue[] = [];
  for (const el of value) {
    const sv = await s.value(el);
    if (sv !== SKIP) items.push(sv);
  }
  return items;
}

/** A plain data object: dropped fields are removed; keys pass through `keyOf`. */
async function serializeObject(value: object, s: ValueSerializer): Promise<FlightValue> {
  const obj: Record<string, FlightValue> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const sv = await s.value(v);
    if (sv !== SKIP) obj[s.keyOf ? s.keyOf(k) : k] = sv;
  }
  return obj;
}

/** Structural check for a VNode (has a `type` and `props`). */
function isVNode(value: unknown): value is VNode {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}
