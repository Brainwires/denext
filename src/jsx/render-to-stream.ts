/// <reference path="../globals.d.ts" />
// Streaming server rendering with Suspense.
//
// The shell (with a placeholder <div> per Suspense boundary showing its
// fallback) is flushed first; each boundary's real content streams in as it
// resolves, followed by an inline script that swaps it into place.
//
// Concurrency note: async boundary renders interleave, but the global hook
// dispatcher is only read during a component's *synchronous* execution, so we
// bind the active provider scopes immediately before each component call.

import type { VNode, VNodeChild, VNodeChildren } from "./types.ts";
import {
  beginServerInsertCollection,
  escapeHtml,
  flushServerInsertedHTML,
  type HeadCollector,
} from "./render-to-string.ts";
import { hostAttrs, renderHostHtml } from "./render-shared.ts";
import { VNodeRenderer } from "./renderer-base.ts";
export type { HeadCollector };
import { enterScope, rootScope, scopePrefix } from "./tree-id.ts";
import { SWAP_RUNTIME } from "../server/swap-runtime.ts";

type ProviderScope = Map<symbol, unknown>;

/**
 * A pending streamed Suspense hole. It **resolves, never rejects**: on success
 * `{ id, html, ok: true }`; on a render error `{ id, html: "", ok: false }` (the
 * error is logged and the hole's shell fallback is left in place). Consumed by the
 * document stream assemblers, so one failing hole never tears down the response.
 */
export type PendingHole = Promise<
  { id: string; html: string; ok: boolean; ms?: number }
>;

class StreamRenderer extends VNodeRenderer<string> {
  private id = 0;
  /** Dev-only: record each boundary's server resolve duration (see StreamOptions). */
  collectTiming = false;
  /**
   * In-flight boundary renders. Each **resolves, never rejects**, to its id + html
   * + an `ok` flag: a boundary whose render throws is logged and resolves `ok:false`
   * (its shell fallback stays) so ONE failing hole can't reject the race and tear
   * down the whole streamed document.
   */
  readonly active = new Set<PendingHole>();

  // Path-based useId state: each Suspense boundary's content is rooted at the boundary's
  // position. Sibling subtrees render concurrently (Promise.all), so — as with the
  // pre-existing counter — the interior useId ordering of concurrently rendering
  // siblings/boundaries keeps the documented streaming caveat. No `effects` ⇒ effect
  // hooks no-op.

  async renderChildren(
    children: VNodeChildren,
    scopes: ProviderScope[],
    head: HeadCollector | null = null,
  ): Promise<string> {
    if (Array.isArray(children)) {
      const parts = await Promise.all(
        children.map((c) => this.renderChild(c, scopes, head)),
      );
      return parts.join("");
    }
    return this.renderChild(children as VNodeChild, scopes, head);
  }

  protected empty(): string {
    return "";
  }

  protected text(value: string | number): string {
    return escapeHtml(String(value));
  }

  /**
   * Suspense boundary: emit fallback now; stream real content later. The boundary is its own
   * id scope (one slot in its parent); its streamed content is rooted at that position so it
   * reproduces the client's ids.
   */
  protected async renderSuspense(
    props: Record<string, unknown>,
    scopes: ProviderScope[],
  ): Promise<string> {
    const id = `dnx${this.id++}`;
    const parentScope = this.ids.scope;
    const boundaryScope = enterScope(parentScope);
    // Dev-only: time how long this boundary takes to resolve on the server.
    const t0 = this.collectTiming ? performance.now() : 0;
    const elapsed = () => (this.collectTiming ? performance.now() - t0 : 0);
    // The hole's own render (and the fallback) do NOT hoist into `head`: they resolve after
    // the head has already flushed, so their head tags stay inline. The id is captured here,
    // so even a rejected render still reports it (ok:false) — the hole's fallback stays and
    // the rest of the document streams unaffected.
    this.active.add(
      this.resolve(
        props.children as VNodeChildren,
        scopes,
        rootScope(scopePrefix(boundaryScope)),
        null,
      )
        .then((html) => ({ id, html, ok: true, ms: elapsed() }))
        .catch((err) => {
          console.error("denext: streamed Suspense boundary failed to resolve:", id, err);
          return { id, html: "", ok: false, ms: elapsed() };
        }),
    );
    this.ids.scope = boundaryScope;
    try {
      const fallback = await this.renderChildren(props.fallback as VNodeChildren, scopes, null);
      return `<div data-dnx-b="${id}">${fallback}</div>`;
    } finally {
      this.ids.scope = parentScope;
    }
  }

  /**
   * Host element. React 19 document metadata: in-tree <title>/<meta>/<link> hoist into the
   * head collector (shell render only) instead of emitting inline.
   */
  protected renderHost(
    node: VNode,
    scopes: ProviderScope[],
    head: HeadCollector | null,
  ): Promise<string> {
    const props = node.props ?? {};
    const tag = node.type as string;
    return renderHostHtml(tag, props, hostAttrs(props, tag), head, {
      renderChildren: (c) => this.renderChildren(c, scopes, head),
      renderTitle: (c) => this.renderChildren(c, scopes, null),
    });
  }
}

/** Options for {@link renderToReadableStream}. */
export interface StreamOptions {
  /** Aborts streaming when signaled; pending boundaries stop being flushed. */
  signal?: AbortSignal;
  /** Prepended to the very first chunk (e.g. "<!DOCTYPE html>..."). */
  shellPrefix?: string;
  /** Appended after all boundaries resolve (e.g. "</body></html>"). */
  shellSuffix?: string;
  /**
   * Dev-only: record each Suspense boundary's server resolve duration and emit a
   * `#__denext_boundary_timing` JSON island (a CSP-safe data block, not executed) at
   * the end of the stream for the DevTools per-boundary timeline. Off in production.
   */
  collectBoundaryTiming?: boolean;
}

/**
 * Render a VNode tree to a streaming HTML `ReadableStream<Uint8Array>`,
 * resolving Suspense boundaries progressively.
 */
export function renderToReadableStream(
  node: VNodeChildren,
  options: StreamOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const renderer = new StreamRenderer();
  renderer.collectTiming = options.collectBoundaryTiming === true;
  const timings: Array<{ id: string; ms: number }> = [];

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const shell = await renderer.resolve(node, []);
        const head = (options.shellPrefix ?? "") + SWAP_RUNTIME + shell;
        controller.enqueue(encoder.encode(head));

        while (renderer.active.size > 0) {
          if (options.signal?.aborted) break;
          // Race the pending boundaries; identify and remove the settled one.
          const settled = await Promise.race(
            [...renderer.active].map((p) => p.then((v) => ({ p, v }))),
          );
          renderer.active.delete(settled.p);
          const { id, html, ok, ms } = settled.v;
          const roundedMs = Math.round((ms ?? 0) * 100) / 100;
          if (renderer.collectTiming) timings.push({ id, ms: roundedMs });
          if (!ok) continue; // failed hole: leave its shell fallback
          // In dev, stamp the server resolve time on the template so the swap runtime can
          // surface a real-time reveal timeline (client reveal + server resolve) as holes
          // land — attributes don't affect the swap-runtime script's fixed CSP hash.
          const msAttr = renderer.collectTiming ? ` data-dnx-ms="${roundedMs}"` : "";
          controller.enqueue(
            encoder.encode(
              `<template data-dnx-r="${id}"${msAttr}>${html}</template>`,
            ),
          );
        }

        // Dev-only per-boundary timeline: a CSP-safe JSON data block (not executed).
        if (renderer.collectTiming && timings.length > 0) {
          const json = JSON.stringify(timings).replace(/</g, "\\u003c");
          controller.enqueue(
            encoder.encode(
              `<script type="application/json" id="__denext_boundary_timing">${json}</script>`,
            ),
          );
        }

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

/** A rendered shell plus its still-pending Suspense holes. */
export interface ShellRender {
  /** The shell HTML (each Suspense boundary a `data-dnx-b` placeholder). */
  shell: string;
  /**
   * The pending Suspense holes. Each {@link PendingHole} resolves (never rejects)
   * to its id + html + `ok` flag, so a document assembler can stream them via the
   * shared `streamHoles` helper: a failed hole (`ok:false`) is skipped (its shell
   * fallback stays) without tearing down the rest of the response.
   */
  holes: Set<PendingHole>;
}

/**
 * Two-phase streaming render: render the **shell** eagerly (awaitable, so a
 * control signal — `notFound()`/`redirect()`/… — thrown during it can be caught
 * and turned into a buffered response BEFORE any bytes flush), then expose the
 * pending Suspense holes for a document assembler to stream and frame.
 *
 * @param node The tree to render.
 * @param head Collector for in-tree `<title>`/`<meta>`/`<link>` (shell only), or null.
 * @returns The shell HTML and the pending {@link PendingHole holes}.
 */
export async function renderShell(
  node: VNodeChildren,
  head: HeadCollector | null,
  collectTiming = false,
): Promise<ShellRender> {
  const renderer = new StreamRenderer();
  renderer.collectTiming = collectTiming;
  // Collect `useServerInsertedHTML` callbacks (CSS-in-JS registries) fired during the
  // shell render and hoist their <style> markup into `head.serverInserted` BEFORE the
  // head flushes. Without this, styled-components/emotion styles are dropped on the
  // default streaming path (holes resolve after the head, so only shell callbacks hoist).
  const sink = beginServerInsertCollection();
  try {
    const shell = await renderer.resolve(node, [], undefined, head);
    flushServerInsertedHTML(sink.inserted, head);
    return { shell, holes: renderer.active };
  } finally {
    sink.end();
  }
}

/** Collect a render stream into a single string (useful for tests/SSR-to-string). */
export async function streamToString(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) out += decoder.decode(chunk);
  return out;
}
