/// <reference path="../globals.d.ts" />
// Partial Prerendering (PPR) renderer for Cache Components.
//
// Two passes over the same tree (see src/runtime/prerender.ts for the model):
//
//   prerenderToShell()  — the static shell. Each Suspense boundary whose subtree
//     performs a dynamic read (which postpones) becomes a *hole*: its fallback is
//     emitted into the shell as `<div data-dnx-b="ID">fallback</div>` and its id
//     recorded. Every other boundary resolves inline (static content). If a
//     dynamic read escapes the root (no Suspense above it), the page is fully
//     dynamic and there is no static shell (`dynamic: true`).
//
//   resumeShellHoles()  — per request: re-walk the same tree with the real
//     request context (no postponing) and render only the recorded holes to
//     strings, streamed into the cached shell via the swap protocol.
//
// Boundary ids are assigned in deterministic depth-first order (the traversal is
// sequential, like renderToString), and a hole is treated *atomically* in both
// passes (its nested boundaries never advance the top-level counter), so the ids
// a resume pass computes line up with the shell the prerender pass produced —
// regardless of how async timing differs between the two passes. This alignment
// holds because the static shell is request-independent by construction: anything
// that varies per request is, by definition, behind a postpone and thus a hole.

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
  type HeadCollector,
  HOISTED_TAGS,
  type IdHolder,
  type ProviderScope,
  resolveContextType,
  serializeAttributes,
  VOID_ELEMENTS,
  warnDangerousHtml,
} from "./render-to-string.ts";
import { enterScope, nextId, rootScope, scopePrefix } from "./tree-id.ts";
import "../runtime/class-flag.ts";
import { classComponentsDisabledError, isClassComponent } from "../compat/class-detect.ts";
import { renderClassToVNode } from "../compat/class-component.ts";
import { invokeComponent, isComponentType, resolveComponentType } from "../runtime/react-brands.ts";
import { isPostpone } from "../runtime/prerender.ts";

/** How a {@link PPRRenderer} treats Suspense boundaries. */
type Mode =
  | "prerender" // detect postpone → hole; else resolve inline
  | "resume" // hole ids render atomically (recorded); others traverse (discarded)
  | "buffered"; // always resolve inline (hole/fallback contents, shared scopes)

/** A dynamic hole discovered during a resume pass: its id and (pending) content. */
export interface ResumedHole {
  /** The boundary id — matches a `data-dnx-b` placeholder in the cached shell. */
  id: string;
  /** The hole's rendered HTML (a promise while it is still resolving). */
  html: string | Promise<string>;
}

class PPRRenderer {
  /** Deterministic depth-first Suspense-boundary counter. */
  nextId = 0;
  /** Boundary ids postponed during a prerender pass, in encounter order. */
  readonly postponedIds: string[] = [];
  /** Holes discovered during a resume pass. */
  readonly holes: ResumedHole[] = [];
  /** Path-based useId state (rooted at `idPrefix` for a buffered sub-render). */
  private readonly ids: IdHolder;
  private activeScopes: ProviderScope[] = [];
  /** The read-only SSR dispatcher for this pass (installed around the render). */
  readonly dispatcher: Dispatcher;

  constructor(
    private readonly mode: Mode,
    private readonly head: HeadCollector | null,
    /** Resume only: which boundary ids are dynamic holes. */
    private readonly holeIds: Set<string> = new Set(),
    /** Root path prefix (a buffered hole/fallback render is rooted at its position). */
    idPrefix = "",
  ) {
    this.ids = { scope: rootScope(idPrefix) };
    this.dispatcher = this.makeDispatcher();
  }

  private makeDispatcher(): Dispatcher {
    // deno-lint-ignore no-this-alias -- captured for the plain-method closures.
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

  /** Render children, retrying on suspension; Postpone and real errors propagate. */
  async resolveChildren(children: VNodeChildren, scopes: ProviderScope[]): Promise<string> {
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
  private async renderChildren(children: VNodeChildren, scopes: ProviderScope[]): Promise<string> {
    if (Array.isArray(children)) {
      let out = "";
      for (const child of children) out += await this.renderChild(child, scopes);
      return out;
    }
    return await this.renderChild(children as VNodeChild, scopes);
  }

  private renderChild(child: VNodeChild, scopes: ProviderScope[]): string | Promise<string> {
    if (child == null || child === false || child === true) return "";
    if (Array.isArray(child)) return this.renderChildren(child as VNodeChildren, scopes);
    if (typeof child === "string") return escapeHtml(child);
    if (typeof child === "number") return escapeHtml(String(child));
    return this.renderVNode(child as VNode, scopes);
  }

  /**
   * Render a subtree to a self-contained string (fresh boundary counter, shared
   * scopes). `idPrefix` roots its ids at the boundary's tree position so a hole or
   * fallback reproduces exactly the ids the client computes over the merged document.
   */
  private renderBuffered(
    children: VNodeChildren,
    scopes: ProviderScope[],
    idPrefix = "",
  ): Promise<string> {
    const sub = new PPRRenderer("buffered", null, new Set(), idPrefix);
    return sub.resolveChildren(children, scopes);
  }

  private async renderVNode(node: VNode, scopes: ProviderScope[]): Promise<string> {
    const { type } = node;
    const props = node.props ?? {};

    if ((type as unknown) === PORTAL) return "";

    if ((type as unknown) === SUSPENSE) return await this.renderSuspense(props, scopes);

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
        // Suspensions are handled by resolveChildren; Postpone must reach the
        // nearest Suspense (a dynamic hole), and control signals bubble to the
        // page handler — none of these is an error to catch here.
        if (isThenable(err) || isPostpone(err) || isControlSignal(err)) throw err;
        this.ids.scope = idScope;
        idScope.count = savedCount;
        idScope.local = savedLocal;
        const Fallback = props.fallback as (p: { error: Error; reset: () => void }) => VNode;
        setDispatcher(this.dispatcher);
        this.activeScopes = scopes;
        const fb = Fallback({ error: toError(err), reset: () => {} });
        const resolved = fb instanceof Promise ? await fb : fb;
        return await this.renderChild(resolved as VNodeChild, scopes);
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

    // React 19 document metadata: hoist <title>/<meta>/<link> into the head
    // collector (shell only; holes stream after <head> is sent, so they emit inline).
    if (this.head && HOISTED_TAGS.has(tag)) {
      if (tag === "title") {
        this.head.title = await this.renderBuffered(props.children, scopes);
        return "";
      }
      this.head.tags.push(`<${tag}${attrs}>`);
      return "";
    }

    if (VOID_ELEMENTS.has(tag)) return `<${tag}${attrs}>`;

    const dangerous = props.dangerouslySetInnerHTML as { __html: string } | undefined;
    if (dangerous && typeof dangerous.__html === "string") {
      warnDangerousHtml(tag);
      return `<${tag}${attrs}>${dangerous.__html}</${tag}>`;
    }

    const inner = await this.renderChildren(props.children, scopes);
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }

  private async renderSuspense(
    props: Record<string, unknown>,
    scopes: ProviderScope[],
  ): Promise<string> {
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
    const inScope = async (): Promise<string> => {
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
        // A dynamic hole: render its real content atomically in a buffered
        // sub-renderer rooted at this boundary's position, and record it to stream.
        // Its nested boundaries do not advance this pass's boundary counter.
        this.ids.scope = parentScope;
        this.holes.push({
          id,
          html: this.renderBuffered(children, scopes, scopePrefix(boundaryScope)),
        });
        return `<div data-dnx-b="${id}"></div>`;
      }
      // Static shell content: traverse (in the boundary scope) so nested holes are
      // discovered and their positions stay aligned; the string is discarded.
      return await inScope();
    }

    // Prerender: resolve inline unless the subtree postpones (→ dynamic hole).
    const snapshot = this.nextId;
    try {
      return await inScope();
    } catch (err) {
      if (!isPostpone(err)) throw err;
      // Discard any nested-boundary counting from the failed attempt so this hole
      // consumes exactly one boundary id — its interior is rendered atomically on
      // resume. The parent id slot for this boundary is already taken (above).
      this.nextId = snapshot;
      this.postponedIds.push(id);
      const fallback = await this.renderBuffered(
        props.fallback as VNodeChildren,
        scopes,
        scopePrefix(boundaryScope),
      );
      // The fallback is wrapped in comment markers so a resume pass can splice the
      // real hole content in by exact substring (no fragile balanced-tag matching);
      // the `data-dnx-b` div preserves the streaming swap protocol for later.
      return `<div data-dnx-b="${id}">${holeOpen(id)}${fallback}${holeClose(id)}</div>`;
    }
  }
}

/** Comment marker opening a hole's replaceable region in the shell. */
function holeOpen(id: string): string {
  return `<!--dnx-h:${id}-->`;
}

/** Comment marker closing a hole's replaceable region in the shell. */
function holeClose(id: string): string {
  return `<!--/dnx-h:${id}-->`;
}

/**
 * Splice resolved hole HTML into a cached shell, replacing each hole's
 * marker-delimited region (its fallback) with the real content. Ids with no
 * resolved html keep their fallback. Pure string work — no re-render.
 */
export function spliceShellHoles(shell: string, holes: Map<string, string>): string {
  let out = shell;
  for (const [id, html] of holes) {
    const open = holeOpen(id);
    const close = holeClose(id);
    const start = out.indexOf(open);
    if (start === -1) continue;
    const end = out.indexOf(close, start);
    if (end === -1) continue;
    out = out.slice(0, start) + html + out.slice(end + close.length);
  }
  return out;
}

/** The result of a prerender pass. */
export interface PrerenderResult {
  /** The static shell HTML (dynamic holes shown as fallbacks in `data-dnx-b` divs). */
  shell: string;
  /** Ids of the dynamic holes, in encounter order. Empty ⇒ a fully static page. */
  postponedIds: string[];
  /** True when a dynamic read escaped the root: the page is fully dynamic (no shell). */
  dynamic: boolean;
}

/**
 * Prerender a tree to a static shell plus the set of dynamic holes. A dynamic
 * read inside a Suspense boundary makes that boundary a hole; a dynamic read with
 * no Suspense above it makes the whole page dynamic (`dynamic: true`, no shell).
 */
export async function prerenderToShell(
  node: VNodeChildren,
  options: { head?: HeadCollector } = {},
): Promise<PrerenderResult> {
  const renderer = new PPRRenderer("prerender", options.head ?? null);
  const prev = setDispatcher(renderer.dispatcher);
  try {
    const shell = await renderer.resolveChildren(node, []);
    return { shell, postponedIds: renderer.postponedIds, dynamic: false };
  } catch (err) {
    if (isPostpone(err)) return { shell: "", postponedIds: [], dynamic: true };
    throw err;
  } finally {
    setDispatcher(prev);
  }
}

/** The result of a resume pass: the dynamic holes to stream into the cached shell. */
export interface ResumeResult {
  /** Each dynamic hole's id and (pending) rendered HTML. */
  holes: ResumedHole[];
}

/**
 * Re-walk `node` with the real request context and render only the recorded
 * `holeIds` to strings (each streamable as it resolves). The shell output is
 * discarded — it is already served from cache.
 */
export async function resumeShellHoles(
  node: VNodeChildren,
  holeIds: Set<string>,
  _options: Record<never, never> = {},
): Promise<ResumeResult> {
  const renderer = new PPRRenderer("resume", null, holeIds);
  const prev = setDispatcher(renderer.dispatcher);
  try {
    await renderer.resolveChildren(node, []);
    return { holes: renderer.holes };
  } finally {
    setDispatcher(prev);
  }
}
