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

import type { VNode, VNodeChildren } from "./types.ts";
import { setDispatcher } from "../runtime/hooks.ts";
import { isPostpone } from "../runtime/postpone.ts";
import { beginSignalCollection, endSignalCollection } from "../runtime/signal-state.ts";
import type { ClientRefInfo } from "../runtime/client-reference.ts";
import {
  beginServerInsertCollection,
  escapeHtml,
  flushServerInsertedHTML,
  type HeadCollector,
  type ProviderScope,
} from "./render-to-string.ts";
import {
  type CarvedIsland,
  type Dual,
  holeClose,
  holeOpen,
  type IslandPayload,
  type IslandRenderer,
  renderClientIsland,
  renderDualChildren,
  renderHostDual,
  type Serialized,
  serializeFlightValue,
} from "./render-shared.ts";
import { type PprMode, PprVNodeRenderer } from "./renderer-base.ts";
import type { FlightNode, FlightValue } from "./render-to-flight.ts";
import { fillFlightHoles, type ResumedFlightHole } from "./flight-holes.ts";
import { type IdScope, scopePrefix } from "./tree-id.ts";

export { fillFlightHoles, type ResumedFlightHole };

class PPRFlightRenderer extends PprVNodeRenderer<Dual> implements IslandRenderer {
  /** Holes discovered during a resume pass. */
  readonly holes: ResumedFlightHole[] = [];
  /** `client:*` islands carved out (kept passes only) for deferred hydration. */
  readonly islands: IslandPayload[] = [];
  /** Count of effect hooks invoked so far (for per-island strategy selection). */
  readonly effects: { count: number };
  /** True while rendering inside a client island's subtree — see render-to-html-flight. */
  insideIsland = false;
  /**
   * Nested islands carved during a parent island's dual render, keyed by the child
   * VNode. The parent renders its children into HTML (pass 1) before serializing its
   * Flight children (pass 2, a re-walk that re-enters scope with an advanced counter);
   * this pins each nested island's foreign host to the *same* id its HTML wrapper got,
   * so the two passes agree. See render-to-html-flight for the contract.
   */
  readonly carvedNested = new WeakMap<VNode, CarvedIsland>();

  constructor(
    mode: PprMode,
    private readonly head: HeadCollector | null,
    /** Resume only: which boundary ids are dynamic holes. */
    holeIds: Set<string> = new Set(),
    /** Resumable mode: auto-defer islands + stamp handler hosts. */
    readonly resumable = false,
    /** Root path prefix (a buffered hole/fallback render is rooted at its position). */
    idPrefix = "",
  ) {
    // `effects` makes effect hooks bump the counter so an island that runs an effect is
    // picked for hydration.
    const effects = { count: 0 };
    super(mode, holeIds, idPrefix, effects);
    this.effects = effects;
  }

  renderChildren(children: VNodeChildren, scopes: ProviderScope[]): Promise<Dual> {
    return renderDualChildren(children, (child) => this.renderChild(child, scopes));
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
    const sub = new PPRFlightRenderer("buffered", null, new Set(), this.resumable, idPrefix);
    const dual = await sub.resolveChildren(children, scopes);
    return { dual, islands: sub.islands };
  }

  protected empty(): Dual {
    return { html: "", flight: null };
  }

  protected text(value: string | number): Dual {
    return { html: escapeHtml(String(value)), flight: value };
  }

  /** <title>/<meta>/<link> hoist into the head collector (shell only; holes emit inline). */
  protected renderHost(node: VNode, scopes: ProviderScope[]): Promise<Dual> {
    return renderHostDual(this, node, this.resumable, scopes, this.head);
  }

  /**
   * A client island (mirrors render-to-html-flight so the shell/hole Flight agrees with a
   * non-PPR route).
   */
  protected override renderClientRef(
    node: VNode,
    type: unknown,
    ref: ClientRefInfo,
    props: Record<string, unknown>,
    prefix: string,
    scopes: ProviderScope[],
  ): Promise<Dual> {
    return renderClientIsland(this, node, type, ref, props, prefix, scopes, null);
  }

  /**
   * Islands are recorded only in a *kept* pass — the top-level resume re-walk discards its
   * HTML, so its islands (already cached in the shell, or captured by a hole's buffered
   * sub-render) must not be double-collected here.
   */
  recordIsland(island: IslandPayload): void {
    if (this.mode !== "resume") this.islands.push(island);
  }

  /**
   * A dynamic hole on resume: render its real content atomically in a buffered sub-render
   * rooted at this boundary's position, recording it (html + Flight subtree) to stream. Its
   * nested boundaries do not advance this pass's boundary counter, and its islands (captured
   * by the sub-render) belong to this hole.
   */
  protected resumeHole(
    id: string,
    children: VNodeChildren,
    scopes: ProviderScope[],
    boundaryScope: IdScope,
  ): Dual {
    const built = this.renderBuffered(children, scopes, scopePrefix(boundaryScope));
    built.catch(() => {}); // consumed later by the streamer — never an unhandled rejection
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

  /**
   * Also discard any islands carved during a failed prerender attempt, so the hole
   * contributes no shell island (its interior renders atomically on resume).
   */
  protected override snapshotPass(): () => void {
    const restore = super.snapshotPass();
    const islands = this.islands.length;
    return () => {
      restore();
      this.islands.length = islands;
    };
  }

  protected async postponedFallback(
    id: string,
    props: Record<string, unknown>,
    scopes: ProviderScope[],
    boundaryScope: IdScope,
  ): Promise<Dual> {
    const fallback = await this.renderBuffered(
      props.fallback as VNodeChildren,
      scopes,
      scopePrefix(boundaryScope),
    );
    // The fallback is wrapped in comment markers so a buffered (non-streaming) splice can
    // find it; the `data-dnx-b` div drives the streaming swap protocol. The Flight side is a
    // hole filled by the resume subtree before emit.
    return {
      html: `<div data-dnx-b="${id}">${holeOpen(id)}${fallback.dual.html}${holeClose(id)}</div>`,
      flight: { $: "$", r: id } as unknown as FlightNode,
    };
  }

  serializeValue(value: unknown, scopes: ProviderScope[]): Promise<Serialized> {
    return serializeFlightValue(value, {
      value: (v) => this.serializeValue(v, scopes),
      vnode: async (n) => (await this.renderChild(n, scopes)).flight as FlightValue,
    });
  }
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
 * or calling `finishSignals()`. The signal collector is per request (`render-scope.ts`),
 * so concurrent resumes for different requests never interleave; `finishSignals` is bound
 * to this request's scope even when called after the async context has ended.
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
  const finishSignals = beginSignalCollection();
  try {
    // The static re-walk schedules each hole's buffered sub-render (unawaited); those
    // resolve independently and record their signals into the still-open collector.
    await renderer.resolveChildren(node, []);
  } catch (err) {
    finishSignals();
    throw err;
  } finally {
    setDispatcher(prev);
  }
  return {
    holes: renderer.holes,
    islands: renderer.islands,
    finishSignals,
  };
}
