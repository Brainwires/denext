// The shared skeleton of the class-based server renderers — streaming HTML, PPR, streaming
// Flight and PPR+Flight. Per-node-kind dispatch, hook-dispatcher activation, error
// boundaries, component invocation and the suspend-and-retry loop live here once; a subclass
// supplies what it produces (`T` is an HTML string or a {@link Dual}) for children, Suspense
// boundaries, host elements and portals, and a dual renderer adds client islands. The PPR
// pair share a second layer: mode-driven Suspense handling (prerender → dynamic holes;
// resume → atomic hole renders).

import { FRAGMENT, PORTAL, type VNode, type VNodeChild, type VNodeChildren } from "./types.ts";
import { type Dispatcher, setDispatcher } from "../runtime/hooks.ts";
import { isThenable, SUSPENSE } from "../runtime/suspense.ts";
import { ERROR_BOUNDARY } from "../runtime/error-boundary.ts";
import { isComponentType } from "../runtime/react-brands.ts";
import { type ClientRefInfo, clientRefOf } from "../runtime/client-reference.ts";
import { isPostpone } from "../runtime/prerender.ts";
import {
  createSSRDispatcher,
  type HeadCollector,
  type IdHolder,
  type ProviderScope,
} from "./render-to-string.ts";
import { enterScope, type IdScope, rootScope, scopePrefix } from "./tree-id.ts";
import {
  checkpointScope,
  invokeServerComponent,
  passesThroughBoundary,
  pushScope,
  renderBoundaryFallback,
  scopesWithProvider,
} from "./render-shared.ts";

/** A VNode's props with the null-props normalization applied. */
type Props = Record<string, unknown>;

export abstract class VNodeRenderer<T> {
  /** Path-based useId state (rooted at `idPrefix` for a buffered sub-render). */
  readonly ids: IdHolder;
  /** The hook dispatcher's live context; reassigned per boundary and component. */
  protected activeScopes: ProviderScope[] = [];
  /** The one shared read-only SSR dispatcher (installed around the render). */
  readonly dispatcher: Dispatcher;

  /**
   * @param idPrefix Root path prefix (a buffered hole/fallback render is rooted at its position).
   * @param effects When given, effect hooks bump the counter so an island that runs an effect
   *   is picked for hydration; without it effect hooks no-op.
   */
  constructor(idPrefix = "", effects?: { count: number }) {
    this.ids = { scope: rootScope(idPrefix) };
    // A getter keeps `useContext` reading the live `activeScopes`.
    this.dispatcher = createSSRDispatcher(() => this.activeScopes, this.ids, effects);
  }

  /** Install this renderer's hook dispatcher with `scopes` as the live context. */
  protected activate(scopes: ProviderScope[]): void {
    setDispatcher(this.dispatcher);
    this.activeScopes = scopes;
  }

  /** Render children in order (a subclass decides sequential vs concurrent). */
  abstract renderChildren(
    children: VNodeChildren,
    scopes: ProviderScope[],
    head?: HeadCollector | null,
  ): Promise<T>;

  /** The output for nothing (a Portal targets a client DOM node absent during SSR). */
  protected abstract empty(): T;

  /** The output for a text child (escaped HTML; a Flight tree keeps the raw value). */
  protected abstract text(value: string | number): T;

  /** Render one child: nothing, text, an array, or a VNode (via {@link renderVNode}). */
  renderChild(
    child: VNodeChild,
    scopes: ProviderScope[],
    head: HeadCollector | null = null,
  ): T | Promise<T> {
    if (child == null || child === false || child === true) return this.empty();
    if (typeof child === "string" || typeof child === "number") return this.text(child);
    // React flattens arbitrarily-nested children arrays (parity with the other renderers).
    if (Array.isArray(child)) return this.renderChildren(child as VNodeChildren, scopes, head);
    return this.renderVNode(child as VNode, scopes, head);
  }

  /** A Suspense boundary: what it emits now, and how its real content is scheduled. */
  protected abstract renderSuspense(
    props: Props,
    scopes: ProviderScope[],
    head: HeadCollector | null,
  ): Promise<T>;

  /** An intrinsic host element. */
  protected abstract renderHost(
    node: VNode,
    scopes: ProviderScope[],
    head: HeadCollector | null,
  ): Promise<T>;

  /**
   * Render children, retrying whenever a descendant suspends. `idRoot` re-roots the id scope
   * for a boundary rendered in isolation (its counters reset on each retry); `head` collects
   * hoisted document metadata for a shell render only (a hole resolves after the head has
   * flushed, so its head tags stay inline).
   */
  async resolve(
    children: VNodeChildren,
    scopes: ProviderScope[],
    idRoot?: IdScope,
    head: HeadCollector | null = null,
  ): Promise<T> {
    for (;;) {
      if (idRoot) {
        idRoot.count = 0;
        idRoot.local = 0;
        this.ids.scope = idRoot;
      }
      try {
        return await this.renderChildren(children, scopes, head);
      } catch (err) {
        if (!isThenable(err)) throw err;
        await err;
      }
    }
  }

  /** Dispatch one VNode by kind. */
  renderVNode(node: VNode, scopes: ProviderScope[], head: HeadCollector | null = null): Promise<T> {
    const { type } = node;
    // Some npm libraries construct elements with a null `props`; React treats it as {}.
    const props = node.props ?? {};
    if ((type as unknown) === PORTAL) return Promise.resolve(this.empty());
    if ((type as unknown) === SUSPENSE) return this.renderSuspense(props, scopes, head);
    if (type === FRAGMENT) {
      return this.renderChildren(props.children, scopesWithProvider(scopes, props), head);
    }
    if ((type as unknown) === ERROR_BOUNDARY) return this.renderErrorBoundary(props, scopes, head);
    if (isComponentType(type)) return this.renderComponent(node, type, props, scopes, head);
    return this.renderHost(node, scopes, head);
  }

  /** Render an error boundary's children (a PPR pass retries suspensions here). */
  protected resolveBoundaryChildren(
    children: VNodeChildren,
    scopes: ProviderScope[],
    head: HeadCollector | null,
  ): Promise<T> {
    return this.renderChildren(children, scopes, head);
  }

  /** Renderer-specific errors an error boundary must let through (PPR's Postpone). */
  protected boundaryPassthrough(_err: unknown): boolean {
    return false;
  }

  /**
   * Error boundary (id-transparent; the fallback renders from the pre-children scope state
   * so its ids line up with the client's). Suspensions, control signals and pass-through
   * errors propagate — none of them is an error to catch here.
   */
  private async renderErrorBoundary(
    props: Props,
    scopes: ProviderScope[],
    head: HeadCollector | null,
  ): Promise<T> {
    const checkpoint = checkpointScope(this.ids);
    try {
      return await this.resolveBoundaryChildren(props.children as VNodeChildren, scopes, head);
    } catch (err) {
      if (passesThroughBoundary(err, (e) => this.boundaryPassthrough(e))) throw err;
      const activate = () => this.activate(scopes);
      const fallback = await renderBoundaryFallback(props, err, this.ids, checkpoint, activate);
      return await this.renderChild(fallback, scopes, head);
    }
  }

  /**
   * Function component (or a memo/forwardRef object wrapper). Each opens a fresh id scope
   * (one slot in its parent) so its ids derive from its tree position.
   */
  private async renderComponent(
    node: VNode,
    type: unknown,
    props: Props,
    scopes: ProviderScope[],
    head: HeadCollector | null,
  ): Promise<T> {
    const { parent, scope } = pushScope(this.ids);
    try {
      this.activate(scopes);
      const ref = clientRefOf(type);
      if (ref) {
        return await this.renderClientRef(node, type, ref, props, scopePrefix(scope), scopes, head);
      }
      return await this.renderServerComponent(type, props, scopes, head);
    } finally {
      this.ids.scope = parent;
    }
  }

  /**
   * A `"use client"` component. An HTML-only renderer simply renders it on the server like
   * any component; a dual renderer overrides this to emit a client island (a reference in
   * the Flight tree, tagged with `prefix` — the component's tree-path id).
   */
  protected async renderClientRef(
    _node: VNode,
    type: unknown,
    _ref: ClientRefInfo,
    props: Props,
    _prefix: string,
    scopes: ProviderScope[],
    head: HeadCollector | null,
  ): Promise<T> {
    return await this.renderServerComponent(type, props, scopes, head);
  }

  /** Invoke and expand a server component; a sync component never allocates a promise. */
  private async renderServerComponent(
    type: unknown,
    props: Props,
    scopes: ProviderScope[],
    head: HeadCollector | null,
  ): Promise<T> {
    const out = invokeServerComponent(type, props, scopes);
    const rendered = out instanceof Promise ? await out : out;
    return await this.renderChild(rendered, scopes, head);
  }
}

/** How a PPR renderer treats Suspense boundaries. */
export type PprMode =
  | "prerender" // detect postpone → hole; else resolve inline (kept in the shell)
  | "resume" // hole ids render atomically (kept); others traverse (discarded)
  | "buffered"; // always resolve inline (hole/fallback contents, shared scopes)

/**
 * The PPR pair's shared layer: a deterministic depth-first boundary counter, and Suspense
 * handling per {@link PprMode} — a prerender resolves a boundary inline unless its subtree
 * postpones (then it becomes a dynamic hole, shown as its fallback); a resume pass renders
 * each hole atomically and merely traverses the rest to keep positions aligned.
 */
export abstract class PprVNodeRenderer<T> extends VNodeRenderer<T> {
  /** Deterministic depth-first Suspense-boundary counter. */
  nextId = 0;
  /** Boundary ids postponed during a prerender pass, in encounter order. */
  readonly postponedIds: string[] = [];

  constructor(
    protected readonly mode: PprMode,
    /** Resume only: which boundary ids are dynamic holes. */
    protected readonly holeIds: Set<string>,
    idPrefix: string,
    effects?: { count: number },
  ) {
    super(idPrefix, effects);
  }

  /** Render children, retrying on suspension; Postpone and real errors propagate. */
  resolveChildren(children: VNodeChildren, scopes: ProviderScope[]): Promise<T> {
    return this.resolve(children, scopes);
  }

  protected override resolveBoundaryChildren(
    children: VNodeChildren,
    scopes: ProviderScope[],
  ): Promise<T> {
    return this.resolveChildren(children, scopes);
  }

  /** Postpone must reach the nearest Suspense (a dynamic hole). */
  protected override boundaryPassthrough(err: unknown): boolean {
    return isPostpone(err);
  }

  /** A dynamic hole on resume: its real content renders atomically, recorded to stream. */
  protected abstract resumeHole(
    id: string,
    children: VNodeChildren,
    scopes: ProviderScope[],
    boundaryScope: IdScope,
  ): T;

  /** A postponed boundary's shell output: its fallback, marked for the resume splice. */
  protected abstract postponedFallback(
    id: string,
    props: Props,
    scopes: ProviderScope[],
    boundaryScope: IdScope,
  ): Promise<T>;

  /**
   * Capture pass state before a prerender attempt; the returned thunk rewinds it when the
   * attempt postpones, so the hole consumes exactly one boundary id (its interior renders
   * atomically on resume). A subclass extends the snapshot with its own pass state.
   */
  protected snapshotPass(): () => void {
    const nextId = this.nextId;
    return () => {
      this.nextId = nextId;
    };
  }

  protected override async renderSuspense(props: Props, scopes: ProviderScope[]): Promise<T> {
    const children = props.children as VNodeChildren;
    const id = `dnx${this.nextId++}`;
    // The boundary is its own id scope: it consumes exactly one slot in its parent (so
    // content after it aligns), and its interior is rooted at this position — which is what
    // lets a hole/fallback, rendered in isolation, reproduce the ids the client computes
    // over the merged document.
    const parentScope = this.ids.scope;
    const boundaryScope = enterScope(parentScope);
    // Render this boundary's real content inline in its own scope, restoring the parent
    // scope afterward (the boundary already took its parent slot).
    const inScope = async (): Promise<T> => {
      this.ids.scope = boundaryScope;
      try {
        return await this.resolveChildren(children, scopes);
      } finally {
        this.ids.scope = parentScope;
      }
    };
    if (this.mode === "buffered") return await inScope();
    if (this.mode === "resume") {
      if (this.holeIds.has(id)) return this.resumeHole(id, children, scopes, boundaryScope);
      // Static shell content: traverse (in the boundary scope) so nested holes are
      // discovered and their positions stay aligned; the output is discarded.
      return await inScope();
    }
    return await this.prerenderBoundary(id, props, scopes, boundaryScope, inScope);
  }

  /** Prerender: resolve inline unless the subtree postpones (→ dynamic hole). */
  private async prerenderBoundary(
    id: string,
    props: Props,
    scopes: ProviderScope[],
    boundaryScope: IdScope,
    inScope: () => Promise<T>,
  ): Promise<T> {
    const restore = this.snapshotPass();
    try {
      return await inScope();
    } catch (err) {
      if (!isPostpone(err)) throw err;
      restore();
      this.postponedIds.push(id);
      return await this.postponedFallback(id, props, scopes, boundaryScope);
    }
  }
}
