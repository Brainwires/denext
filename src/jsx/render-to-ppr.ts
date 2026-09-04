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

import type { VNode, VNodeChild, VNodeChildren } from "./types.ts";
import { setDispatcher } from "../runtime/hooks.ts";
import { isPostpone } from "../runtime/prerender.ts";
import {
  escapeHtml,
  type HeadCollector,
  type ProviderScope,
  serializeAttributes,
} from "./render-to-string.ts";
import { type IdScope, scopePrefix } from "./tree-id.ts";
import { holeClose, holeOpen, renderHostHtml } from "./render-shared.ts";
import { type PprMode, PprVNodeRenderer } from "./renderer-base.ts";

/** A dynamic hole discovered during a resume pass: its id and (pending) content. */
export interface ResumedHole {
  /** The boundary id — matches a `data-dnx-b` placeholder in the cached shell. */
  id: string;
  /** The hole's rendered HTML (a promise while it is still resolving). */
  html: string | Promise<string>;
}

class PPRRenderer extends PprVNodeRenderer<string> {
  /** Holes discovered during a resume pass. */
  readonly holes: ResumedHole[] = [];

  constructor(
    mode: PprMode,
    private readonly head: HeadCollector | null,
    /** Resume only: which boundary ids are dynamic holes. */
    holeIds: Set<string> = new Set(),
    /** Root path prefix (a buffered hole/fallback render is rooted at its position). */
    idPrefix = "",
  ) {
    super(mode, holeIds, idPrefix); // no `effects` ⇒ effect hooks no-op
  }

  /** Render children **sequentially** (deterministic DFS order for stable ids). */
  async renderChildren(children: VNodeChildren, scopes: ProviderScope[]): Promise<string> {
    if (Array.isArray(children)) {
      let out = "";
      for (const child of children) out += await this.renderChild(child, scopes);
      return out;
    }
    return await this.renderChild(children as VNodeChild, scopes);
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

  protected empty(): string {
    return "";
  }

  protected text(value: string | number): string {
    return escapeHtml(String(value));
  }

  /**
   * Host element. <title>/<meta>/<link> hoist into the head collector (shell only; holes
   * stream after <head> is sent, so they emit inline).
   */
  protected renderHost(node: VNode, scopes: ProviderScope[]): Promise<string> {
    const props = node.props ?? {};
    const tag = node.type as string;
    return renderHostHtml(tag, props, serializeAttributes(props, tag), this.head, {
      renderChildren: (c) => this.renderChildren(c, scopes),
      renderTitle: (c) => this.renderBuffered(c, scopes),
    });
  }

  /**
   * A dynamic hole on resume: render its real content atomically in a buffered sub-renderer
   * rooted at this boundary's position, and record it to stream. Its nested boundaries do
   * not advance this pass's boundary counter.
   */
  protected resumeHole(
    id: string,
    children: VNodeChildren,
    scopes: ProviderScope[],
    boundaryScope: IdScope,
  ): string {
    this.holes.push({
      id,
      html: this.renderBuffered(children, scopes, scopePrefix(boundaryScope)),
    });
    return `<div data-dnx-b="${id}"></div>`;
  }

  protected async postponedFallback(
    id: string,
    props: Record<string, unknown>,
    scopes: ProviderScope[],
    boundaryScope: IdScope,
  ): Promise<string> {
    const fallback = await this.renderBuffered(
      props.fallback as VNodeChildren,
      scopes,
      scopePrefix(boundaryScope),
    );
    // The fallback is wrapped in comment markers so a resume pass can splice the real hole
    // content in by exact substring (no fragile balanced-tag matching); the `data-dnx-b` div
    // preserves the streaming swap protocol for later.
    return `<div data-dnx-b="${id}">${holeOpen(id)}${fallback}${holeClose(id)}</div>`;
  }
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
