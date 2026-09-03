/// <reference path="../globals.d.ts" />
// Partial Prerendering (PPR) for Flight ("use client") routes — the postpone-aware
// two-pass renderer that produces BOTH the SSR HTML and the Flight payload.
//
// This is the union of two existing renderers:
//
//   - render-to-ppr.ts   — the postpone/hole model: a dynamic read (outside a
//     `use cache` scope) postpones during the prerender pass, turning the nearest
//     Suspense boundary into a per-request hole; the resume pass re-walks the same
//     tree with the real request context and renders only those holes. Boundary ids
//     are assigned in deterministic depth-first order and a hole is atomic in both
//     passes, so the ids a resume computes line up with the shell the prerender
//     produced (see that file's header for the full argument).
//
//   - render-to-html-flight.ts — the single-pass dual renderer: emit HTML and Flight
//     from ONE traversal so `useId` stays aligned across the client boundary, with
//     `client:*` island carve-out (foreign-host wrapper + the island's own Flight)
//     and `useSignal`/`useStore` state collection.
//
// Merging them makes PPR work on client-island routes: the prerender pass caches a
// static shell that carries its Flight tree (holes as `{$:"$",r:id}` placeholders),
// its shell islands, and its shell signal state; the resume pass produces, per hole,
// `{ html, flight }` plus any islands/signals discovered inside it. The request
// pipeline fills the shell Flight's holes with the resume subtrees and merges the
// islands/signal-state, emitting the SAME trailing #__denext_flight / #__denext_islands
// / #__denext_state payload a non-PPR streamed Flight route emits — so the client is
// unchanged (it never learns the shell was cached).

import { FRAGMENT, PORTAL, type VNode, type VNodeChild, type VNodeChildren } from "./types.ts";
import { type Dispatcher, setDispatcher } from "../runtime/hooks.ts";
import { PROVIDER } from "../runtime/context.ts";
import { isThenable, SUSPENSE } from "../runtime/suspense.ts";
import {
  ERROR_BOUNDARY,
  isControlSignal,
  reportBoundaryError,
  toClientError,
} from "../runtime/error-boundary.ts";
import { isServerAction } from "../runtime/server-action.ts";
import { DNX_H_ATTR } from "../runtime/qrl.ts";
import { serializeScalar } from "./flight-scalar.ts";
import { beginSignalCollection, endSignalCollection } from "../runtime/signal-state.ts";
import { clientRefOf } from "../runtime/client-reference.ts";
import { type HydrationStrategy, parseStrategy } from "../runtime/lazy-directive.ts";
import { islandWrapper, warnClientOnlySeoContent } from "./island-wrapper.ts";
import "../runtime/class-flag.ts";
import { classComponentsDisabledError, isClassComponent } from "../compat/class-detect.ts";
import { renderClassToVNode } from "../compat/class-component.ts";
import { invokeComponent, isComponentType, resolveComponentType } from "../runtime/react-brands.ts";
import { isPostpone } from "../runtime/prerender.ts";
import {
  beginServerInsertCollection,
  createSSRDispatcher,
  escapeHtml,
  flushServerInsertedHTML,
  type HeadCollector,
  HOISTED_TAGS,
  type IdHolder,
  type ProviderScope,
  resolveContextType,
  serializeAttributes,
  VOID_ELEMENTS,
  warnDangerousHtml,
} from "./render-to-string.ts";
import type { IslandPayload } from "./render-to-html-flight.ts";
import type { FlightNode, FlightProps, FlightValue } from "./render-to-flight.ts";
import { fillFlightHoles, type ResumedFlightHole } from "./flight-holes.ts";
import { enterScope, ID_PATH_PROP, rootScope, scopePrefix } from "./tree-id.ts";

export { fillFlightHoles, type ResumedFlightHole };

/** How a {@link PPRFlightRenderer} treats Suspense boundaries (see render-to-ppr.ts). */
type Mode =
  | "prerender" // detect postpone → hole; else resolve inline (kept in the shell)
  | "resume" // hole ids render atomically (kept); others traverse (discarded)
  | "buffered"; // always resolve inline (hole/fallback contents, shared scopes)

/** A rendered node's dual output: its HTML string and its Flight node. */
interface Dual {
  html: string;
  flight: FlightNode;
}

const SKIP = Symbol("skip");

class PPRFlightRenderer {
  /** Deterministic depth-first Suspense-boundary counter. */
  nextId = 0;
  /** Boundary ids postponed during a prerender pass, in encounter order. */
  readonly postponedIds: string[] = [];
  /** Holes discovered during a resume pass. */
  readonly holes: ResumedFlightHole[] = [];
  /** `client:*` islands carved out (kept passes only) for deferred hydration. */
  readonly islands: IslandPayload[] = [];
  /** Count of effect hooks invoked so far (for per-island strategy selection). */
  readonly effects = { count: 0 };
  /** Path-based useId state (rooted at `idPrefix` for a buffered sub-render). */
  private readonly ids: IdHolder;
  /** True while rendering inside a client island's subtree — see render-to-html-flight. */
  private insideIsland = false;
  /**
   * Nested islands carved during a parent island's dual render, keyed by the child
   * VNode. The parent renders its children into HTML (pass 1) before serializing its
   * Flight children (pass 2, a re-walk that re-enters scope with an advanced counter);
   * this pins each nested island's foreign host to the *same* id its HTML wrapper got,
   * so the two passes agree. See render-to-html-flight for the contract.
   */
  private carvedNested = new WeakMap<
    VNode,
    { id: string; strategy: HydrationStrategy; param?: string }
  >();
  private activeScopes: ProviderScope[] = [];
  readonly dispatcher: Dispatcher;

  constructor(
    private readonly mode: Mode,
    private readonly head: HeadCollector | null,
    /** Resume only: which boundary ids are dynamic holes. */
    private readonly holeIds: Set<string> = new Set(),
    /** Resumable mode: auto-defer islands + stamp handler hosts. */
    private readonly resumable = false,
    /** Root path prefix (a buffered hole/fallback render is rooted at its position). */
    idPrefix = "",
  ) {
    this.ids = { scope: rootScope(idPrefix) };
    // The one shared SSR dispatcher; a getter keeps `useContext` reading the live
    // `activeScopes` (reassigned per boundary); `effects` makes effect hooks bump
    // the counter so an island that runs an effect is picked for hydration.
    this.dispatcher = createSSRDispatcher(() => this.activeScopes, this.ids, this.effects);
  }

  /** Render children, retrying on suspension; Postpone and real errors propagate. */
  async resolveChildren(
    children: VNodeChildren,
    scopes: ProviderScope[],
  ): Promise<Dual> {
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

  /** Render children **sequentially** (deterministic DFS order for stable ids). */
  private async renderChildren(
    children: VNodeChildren,
    scopes: ProviderScope[],
  ): Promise<Dual> {
    const arr = Array.isArray(children) ? children : children == null ? [] : [children];
    let html = "";
    const flight: FlightNode[] = [];
    for (const child of arr) {
      const d = await this.renderChild(child, scopes);
      html += d.html;
      flight.push(d.flight);
    }
    return { html, flight };
  }

  private renderChild(
    child: VNodeChild,
    scopes: ProviderScope[],
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
    if (Array.isArray(child)) {
      return this.renderChildren(child as VNodeChildren, scopes);
    }
    return this.renderVNode(child as VNode, scopes);
  }

  /**
   * Render a subtree to a self-contained dual output (fresh boundary counter,
   * shared scopes), rooted at `idPrefix` so a hole or fallback reproduces exactly
   * the ids the client computes over the merged document. Its own islands are
   * returned alongside so a resume caller can attribute a hole's islands to it.
   */
  private async renderBuffered(
    children: VNodeChildren,
    scopes: ProviderScope[],
    idPrefix = "",
  ): Promise<{ dual: Dual; islands: IslandPayload[] }> {
    const sub = new PPRFlightRenderer(
      "buffered",
      null,
      new Set(),
      this.resumable,
      idPrefix,
    );
    const dual = await sub.resolveChildren(children, scopes);
    return { dual, islands: sub.islands };
  }

  private async renderVNode(
    node: VNode,
    scopes: ProviderScope[],
  ): Promise<Dual> {
    const { type } = node;
    const props = node.props ?? {};

    if ((type as unknown) === PORTAL) return { html: "", flight: null };

    if ((type as unknown) === SUSPENSE) {
      return await this.renderSuspense(props, scopes);
    }

    // Fragment / context provider.
    if (type === FRAGMENT) {
      const info = props[PROVIDER as unknown as string] as
        | { id: symbol; value: unknown }
        | undefined;
      if (info) {
        const scope: ProviderScope = new Map([[info.id, info.value]]);
        return await this.renderChildren(props.children, [...scopes, scope]);
      }
      return await this.renderChildren(props.children, scopes);
    }

    // Error boundary (id-transparent; the fallback renders from the pre-children
    // scope state so its ids line up with the client's).
    if ((type as unknown) === ERROR_BOUNDARY) {
      const idScope = this.ids.scope;
      const savedCount = idScope.count;
      const savedLocal = idScope.local;
      try {
        return await this.resolveChildren(props.children, scopes);
      } catch (err) {
        // Suspensions are handled by resolveChildren; Postpone must reach the nearest
        // Suspense (a dynamic hole), and control signals bubble to the page handler.
        if (isThenable(err) || isPostpone(err) || isControlSignal(err)) {
          throw err;
        }
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
        return await this.renderChild(resolved as VNodeChild, scopes);
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
          return await this.renderClientIsland(
            node,
            type,
            ref,
            props,
            scope,
            scopes,
          );
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

    return await this.renderHost(node, scopes);
  }

  /**
   * A client island: render its HTML for first paint, emit only a REFERENCE in the
   * Flight tree (tagged with its tree-path prefix so the client roots the island's
   * id scope there). A `client:*` directive (or resumable mode) carves it into a
   * foreign-host wrapper + its own island Flight. Mirrors render-to-html-flight so
   * the shell/hole Flight agrees with a non-PPR route. Islands are recorded only in
   * a *kept* pass — the top-level resume re-walk discards its HTML, so its islands
   * (already cached in the shell, or captured by a hole's buffered sub-render) must
   * not be double-collected here.
   */
  private async renderClientIsland(
    node: VNode,
    type: unknown,
    ref: { id: string; moduleHydrate?: unknown },
    props: Record<string, unknown>,
    scope: ReturnType<typeof enterScope>,
    scopes: ProviderScope[],
  ): Promise<Dual> {
    // Already carved on the HTML pass (this is the Flight-children re-walk): emit the
    // matching foreign host with the SAME id, without re-carving under a new prefix.
    const already = this.carvedNested.get(node);
    if (already) {
      return {
        html: "",
        flight: islandWrapper(already.id, already.strategy, already.param, "").flight,
      };
    }
    setDispatcher(this.dispatcher);
    this.activeScopes = scopes;
    const parsed = parseStrategy(props, ref.moduleHydrate);
    const rest = parsed.rest;
    const prefix = scopePrefix(scope);
    const recordNested = (
      strategy: HydrationStrategy,
      param?: string,
    ): void => {
      if (this.insideIsland) {
        this.carvedNested.set(node, { id: prefix, strategy, param });
      }
    };
    // A nested `client:*` island carves independently (its own wrapper + strategy).
    // The Flight-children re-walk (pass 2) re-enters scope with an advanced counter, so
    // it would assign a different prefix; the `carvedNested` guard above pins it to the
    // HTML pass's id instead. `wasInside` marks that this island is nested (record it).
    const wasInside = this.insideIsland;

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
      const islandFlight: FlightNode = { $: "c", i: ref.id, p, c: childFlight };
      if (this.mode !== "resume") {
        this.islands.push({
          id: prefix,
          strategy: "only",
          flight: islandFlight,
        });
      }
      recordNested("only");
      warnClientOnlySeoContent(rest.children as VNodeChildren, prefix);
      return islandWrapper(prefix, "only", undefined, "");
    }

    const effectsBefore = this.effects.count;
    const rendered = invokeComponent(resolveComponentType(type), rest);
    const out = rendered instanceof Promise ? await rendered : rendered;
    const ranEffect = this.effects.count > effectsBefore;
    this.insideIsland = true; // this island's subtree + children are "inside" it
    const htmlDual = await this.renderChild(out as VNodeChild, scopes);
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
    const islandFlight: FlightNode = { $: "c", i: ref.id, p, c: childFlight };
    if (strategy) {
      // A kept pass records the island (a discarded resume re-walk does not).
      if (this.mode !== "resume") {
        this.islands.push({
          id: prefix,
          strategy,
          param: parsed.param,
          flight: islandFlight,
        });
      }
      recordNested(strategy, parsed.param);
      return islandWrapper(prefix, strategy, parsed.param, htmlDual.html);
    }
    return { html: htmlDual.html, flight: islandFlight };
  }

  private async renderHost(
    node: VNode,
    scopes: ProviderScope[],
  ): Promise<Dual> {
    const props = node.props ?? {};
    const tag = node.type as string;
    let attrs = serializeAttributes(props, tag, this.resumable);
    if (
      tag === "form" && isServerAction(props.action) && props.method == null
    ) {
      attrs += ` method="post"`;
    }

    // React 19 document metadata: hoist <title>/<meta>/<link> into the head collector
    // (shell only; holes stream after <head> is sent, so they emit inline).
    if (this.head && HOISTED_TAGS.has(tag)) {
      if (tag === "title") {
        this.head.title = (await this.renderChildren(props.children, scopes)).html;
        return { html: "", flight: null };
      }
      this.head.tags.push(`<${tag}${attrs}>`);
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

    const inner = await this.renderChildren(props.children, scopes);
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

  private async renderSuspense(
    props: Record<string, unknown>,
    scopes: ProviderScope[],
  ): Promise<Dual> {
    const children = props.children as VNodeChildren;
    const id = `dnx${this.nextId++}`;

    // The boundary is its own id scope: it consumes exactly one slot in its parent
    // (so content after it aligns), and its interior is rooted at this position —
    // which is what lets a hole/fallback, rendered in isolation, reproduce the ids
    // the client computes over the merged document.
    const parentScope = this.ids.scope;
    const boundaryScope = enterScope(parentScope);

    // Render this boundary's real content inline in its own scope, restoring the
    // parent scope afterward (the boundary already took its parent slot).
    const inScope = async (): Promise<Dual> => {
      this.ids.scope = boundaryScope;
      try {
        return await this.resolveChildren(children, scopes);
      } finally {
        this.ids.scope = parentScope;
      }
    };

    if (this.mode === "buffered") {
      return await inScope();
    }

    if (this.mode === "resume") {
      if (this.holeIds.has(id)) {
        // A dynamic hole: render its real content atomically in a buffered sub-render
        // rooted at this boundary's position, recording it (html + Flight subtree) to
        // stream. Its nested boundaries do not advance this pass's boundary counter,
        // and its islands (captured by the sub-render) belong to this hole.
        this.ids.scope = parentScope;
        const built = this.renderBuffered(
          children,
          scopes,
          scopePrefix(boundaryScope),
        );
        this.holes.push({
          id,
          html: built.then((b) => b.dual.html),
          flight: built.then((b) => {
            for (const isl of b.islands) this.islands.push(isl);
            return b.dual.flight;
          }),
        });
        return {
          html: `<div data-dnx-b="${id}"></div>`,
          flight: { $: "$", r: id } as unknown as FlightNode,
        };
      }
      // Static shell content: traverse (in the boundary scope) so nested holes are
      // discovered and their positions stay aligned; the output is discarded.
      return await inScope();
    }

    // Prerender: resolve inline unless the subtree postpones (→ dynamic hole).
    const idSnapshot = this.nextId;
    const islandSnapshot = this.islands.length;
    try {
      return await inScope();
    } catch (err) {
      if (!isPostpone(err)) throw err;
      // Discard any nested-boundary counting AND any islands carved during the failed
      // attempt so this hole consumes exactly one boundary id and contributes no shell
      // island (its interior renders atomically on resume). The parent id slot is taken.
      this.nextId = idSnapshot;
      this.islands.length = islandSnapshot;
      this.postponedIds.push(id);
      const fallback = await this.renderBuffered(
        props.fallback as VNodeChildren,
        scopes,
        scopePrefix(boundaryScope),
      );
      // The fallback is wrapped in comment markers so a buffered (non-streaming) splice
      // can find it; the `data-dnx-b` div drives the streaming swap protocol. The Flight
      // side is a hole filled by the resume subtree before emit.
      return {
        html: `<div data-dnx-b="${id}">${holeOpen(id)}${fallback.dual.html}${holeClose(id)}</div>`,
        flight: { $: "$", r: id } as unknown as FlightNode,
      };
    }
  }

  // ---- Flight-only serialization (client-island children + props) -------------

  private async flightChildren(
    children: VNodeChildren,
    scopes: ProviderScope[],
  ): Promise<
    FlightNode[]
  > {
    const arr = Array.isArray(children) ? children : children == null ? [] : [children];
    const out: FlightNode[] = [];
    for (const c of arr) out.push((await this.renderChild(c, scopes)).flight);
    return out;
  }

  private async serializeProps(
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

  private async serializeValue(
    value: unknown,
    scopes: ProviderScope[],
  ): Promise<FlightValue | typeof SKIP> {
    // Shared leaf cascade (primitives, action/qrl refs, dropped functions, Date, thenables).
    const scalar = serializeScalar(value);
    if (scalar.kind === "value") return scalar.value;
    if (scalar.kind === "skip") return SKIP;
    // A Remix `defer()` field / promise data: resolve then re-serialize so deferred data
    // crosses the boundary (awaited, not streamed as a placeholder).
    if (scalar.kind === "thenable") return this.serializeValue(await scalar.promise, scopes);
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
    if (typeof value === "object") {
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
  return typeof value === "object" && value !== null && "type" in value &&
    "props" in value;
}

/** Comment marker opening a hole's replaceable region in the shell. */
function holeOpen(id: string): string {
  return `<!--dnx-h:${id}-->`;
}

/** Comment marker closing a hole's replaceable region in the shell. */
function holeClose(id: string): string {
  return `<!--/dnx-h:${id}-->`;
}

/** The result of a Flight prerender pass. */
export interface PrerenderFlightResult {
  /** The static shell HTML (dynamic holes shown as fallbacks in `data-dnx-b` divs). */
  shell: string;
  /** The shell Flight tree (holes as `{$:"$",r:id}`, filled per request on resume). */
  flight: FlightNode;
  /** `client:*` islands in the static shell, keyed by tree-path id. */
  islands: IslandPayload[];
  /** Signal state (`useId → value`) captured in the static shell. */
  signalState: Record<string, unknown>;
  /** Ids of the dynamic holes, in encounter order. Empty ⇒ a fully static page. */
  postponedIds: string[];
  /** True when a dynamic read escaped the root: the page is fully dynamic (no shell). */
  dynamic: boolean;
}

/**
 * Prerender a Flight tree to a static shell (HTML + Flight + islands + signal state)
 * plus its dynamic holes. The Flight analogue of {@link prerenderToShell}. A dynamic
 * read inside a Suspense boundary makes that boundary a hole; a dynamic read with no
 * Suspense above it makes the whole page dynamic (`dynamic: true`, no shell).
 *
 * @param node The tree to prerender.
 * @param options `head` collects hoisted `<title>`/`<meta>`/`<link>`; `resumable`
 *   auto-defers islands + stamps handler hosts.
 */
export async function prerenderToShellFlight(
  node: VNodeChildren,
  options: { head?: HeadCollector; resumable?: boolean } = {},
): Promise<PrerenderFlightResult> {
  const renderer = new PPRFlightRenderer(
    "prerender",
    options.head ?? null,
    new Set(),
    options.resumable ?? false,
  );
  const prev = setDispatcher(renderer.dispatcher);
  beginSignalCollection();
  // Hoist `useServerInsertedHTML` (CSS-in-JS) markup produced in the static shell into
  // <head> before it flushes, matching the streaming/buffered Flight paths.
  const sink = beginServerInsertCollection();
  const empty = (dynamic: boolean): PrerenderFlightResult => ({
    shell: "",
    flight: null,
    islands: [],
    signalState: {},
    postponedIds: [],
    dynamic,
  });
  try {
    const dual = await renderer.resolveChildren(node, []);
    flushServerInsertedHTML(sink.inserted, options.head ?? null);
    let flight = dual.flight;
    if (Array.isArray(flight) && flight.length === 1) flight = flight[0];
    return {
      shell: dual.html,
      flight,
      islands: renderer.islands,
      signalState: endSignalCollection(),
      postponedIds: renderer.postponedIds,
      dynamic: false,
    };
  } catch (err) {
    endSignalCollection(); // reset the module collector on any throw
    if (isPostpone(err)) return empty(true);
    throw err;
  } finally {
    setDispatcher(prev);
    sink.end();
  }
}

/** The result of a Flight resume pass: the holes to stream, plus live accumulators. */
export interface ResumeFlightResult {
  /**
   * Each dynamic hole's id and (pending) dual output (html + Flight subtree),
   * unawaited so the document assembler can stream each as it resolves.
   */
  holes: ResumedFlightHole[];
  /**
   * `client:*` islands discovered inside the resumed holes. **Live-appended**: each
   * hole's islands land when its `flight` promise resolves, so this is complete only
   * once every hole in {@link holes} has been awaited.
   */
  islands: IslandPayload[];
  /**
   * Close signal collection and return the map captured during the resume pass
   * (static re-walk + every hole). Call ONLY after awaiting every hole's `flight`,
   * so hole signals are captured. Idempotent per pass (the collector is nulled).
   */
  finishSignals(): Record<string, unknown>;
}

/**
 * Re-walk `node` with the real request context and render only the recorded
 * `holeIds`, producing each hole's HTML + Flight subtree (streamable as it resolves)
 * plus the islands/signal-state discovered inside them. The static shell output is
 * discarded — it is already served from the cached shell.
 *
 * The islands and signal state are complete only once every hole's `flight` promise
 * has resolved (each hole's islands are appended, and its signals recorded, as its
 * subtree settles), so the assembler must drain all holes before reading `islands`
 * or calling `finishSignals()`. The module-global signal collector means concurrent
 * Flight resumes can interleave — the same documented limitation as the streamed
 * Flight path, widened by the resume window.
 *
 * @param node The (same) tree to resume.
 * @param holeIds The dynamic-hole ids from the prerender pass.
 * @param options `resumable` must match the prerender pass so ids/strategies align.
 */
export async function resumeShellHolesFlight(
  node: VNodeChildren,
  holeIds: Set<string>,
  options: { resumable?: boolean } = {},
): Promise<ResumeFlightResult> {
  const renderer = new PPRFlightRenderer(
    "resume",
    null,
    holeIds,
    options.resumable ?? false,
  );
  const prev = setDispatcher(renderer.dispatcher);
  beginSignalCollection();
  try {
    // The static re-walk schedules each hole's buffered sub-render (unawaited); those
    // resolve independently and record their signals into the still-open collector.
    await renderer.resolveChildren(node, []);
  } catch (err) {
    endSignalCollection();
    throw err;
  } finally {
    setDispatcher(prev);
  }
  return {
    holes: renderer.holes,
    islands: renderer.islands,
    finishSignals: () => endSignalCollection(),
  };
}
