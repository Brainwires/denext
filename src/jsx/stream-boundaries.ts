// Inline-or-stream decisions for the Suspense boundaries of a streaming render, as React makes
// them.
//
// A streaming renderer starts each boundary's content rendering on its own and leaves an
// opaque token in the shell where the boundary sits. Each token is decided only when the HTML
// holding it flushes: a boundary whose content has finished by then is written inline between
// React's `<!--$-->` / `<!--/$-->` markers (no fallback, no wrapper, no template, no script —
// readable with JavaScript off); one still rendering is written as its fallback in a
// `<div data-dnx-b="id">` placeholder, and its content streams later as a
// `<template data-dnx-r="id">` the swap runtime moves into place.
//
// What "finished by then" means follows React's renderer:
//
// - Content that never suspends (plain components, `use()` of a promise React or denext already
//   saw settle) finishes in the shell pass: the shell waits for it ({@link quiet}).
// - Content that suspends — throws a thenable (`use()` of a promise not known to be settled,
//   `React.lazy`) or awaits an async component — is retried after the shell, so it streams,
//   even when its promise was already resolved: its completion becomes visible only a macrotask
//   after it settles, as React retries suspended work in a later task.
// - Whatever has finished when the shell is actually written is inline: a consumer that awaits
//   `allReady` (or simply reads late) gets every boundary inline, as with React.

import { nextMacrotask, withinMacrotask } from "../runtime/next-macrotask.ts";
import type { HeadCollector } from "./render-to-string.ts";

/**
 * Thrown out of a page's shell render when a boundary decided inline threw a control signal
 * (`notFound()`, `redirect()`, …): nothing has been sent, so the page renders buffered instead,
 * where the signal reaches the boundary that catches it and sets the response's status (or
 * redirects), as a signal thrown in the shell does.
 */
export class InlineBoundarySignal extends Error {
  /** @param signal The control signal the boundary's content threw. */
  constructor(readonly signal: unknown) {
    super("denext: a Suspense boundary decided inline threw a control signal");
    this.name = "InlineBoundarySignal";
  }
}

/** A boundary's settled content: `ok: false` when its render failed (its fallback stays). */
export interface SettledBoundary {
  /** The boundary id (`dnxN`), shared by the placeholder and its streamed template. */
  id: string;
  /** The content HTML, still holding the tokens of its own nested boundaries. */
  html: string;
  /** False when the content failed to render: the placeholder keeps its fallback. */
  ok: boolean;
  /**
   * The control signal (`notFound()`, `redirect()`, …) the content threw, when `html` is its
   * replacement. Decided inline in the shell, the signal is the whole response's instead.
   */
  signal?: unknown;
  /**
   * The `<title>` / `<meta>` / `<link>` the content hoisted (null: none collected). Inline in
   * the shell they join the document head; streamed, they go out just before the template.
   */
  head?: HeadCollector | null;
  /** Streamed only: the content's hoisted head tags, written before its template. */
  headHtml?: string;
}

/** Fold `from`'s hoisted tags into `into` (a later `<title>` wins, as in tree order). */
function mergeHead(into: HeadCollector, from: HeadCollector): void {
  if (from.title !== undefined) into.title = from.title;
  into.tags.push(...from.tags);
}

/** A collector's tags as markup (written in the body for a streamed boundary). */
function headMarkup(head: HeadCollector | null | undefined): string {
  if (!head) return "";
  const title = head.title === undefined ? "" : `<title>${head.title}</title>`;
  return title + head.tags.map((t) => t.html).join("");
}

/** One tracked boundary. */
interface Slot<S extends SettledBoundary> {
  /** Settles (never rejects) once the content's completion is visible. */
  done: Promise<S>;
  /** The fallback HTML (holding the tokens of boundaries nested in it). */
  fallback: string;
  /** The settled content once its completion is visible, else null. */
  settled: S | null;
  /** The content suspended at least once: its completion shows a macrotask late. */
  suspended: boolean;
  /** Still rendering without having suspended: the shell waits for it. */
  busy: boolean;
}

/** The provider-scope key naming the boundary a subtree renders in. */
const BOUNDARY: unique symbol = /* @__PURE__ */ Symbol("denext.streamBoundary");

/** A random 16-digit hex string, so content can never forge a boundary token. */
function randomNonce(): string {
  const [a, b] = crypto.getRandomValues(new Uint32Array(2));
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** A boundary token found in some HTML: where it starts and ends, and the boundary id. */
type FoundToken = [start: number, end: number, id: string];

/**
 * The first token at or after `from` in `html`: `prefix` (`\0dnx-sb:<nonce>:`), a non-empty id
 * and a closing `\0` — what the regular expression `\0dnx-sb:<nonce>:([^\0]+)\0` would match
 * there. Scanned with `indexOf`, as a pattern holding a per-render nonce would be compiled again
 * for every render (a cost every streamed page paid per request).
 */
function findToken(html: string, prefix: string, from: number): FoundToken | null {
  for (
    let start = html.indexOf(prefix, from);
    start !== -1;
    start = html.indexOf(prefix, start + 1)
  ) {
    const idStart = start + prefix.length;
    const close = html.indexOf("\u0000", idStart);
    if (close === -1) return null;
    if (close > idStart) return [start, close + 1, html.slice(idStart, close)];
  }
  return null;
}

/**
 * The Suspense boundaries of one streaming render, written into the HTML as tokens and
 * decided (inline or streamed) when the HTML holding them flushes.
 */
export class StreamBoundaries<S extends SettledBoundary> {
  private readonly slots = new Map<string, Slot<S>>();
  private readonly nonce = randomNonce();
  /** What every token of this render starts with. */
  private readonly prefix = `\u0000dnx-sb:${this.nonce}:`;
  /** Boundaries rendering without having suspended. */
  private busy = 0;
  private readonly waiters: Array<() => void> = [];
  /** Ids of the boundaries written inline so far (a Flight render fills their holes). */
  readonly inlined = new Set<string>();

  /**
   * Open boundary `id` before its content starts rendering: returns the provider scopes the
   * content renders in, which name the boundary (so a suspension inside it is attributed).
   */
  open(id: string, scopes: Map<symbol, unknown>[]): Map<symbol, unknown>[] {
    const slot = { fallback: "", settled: null, suspended: false, busy: true } as Slot<S>;
    this.busy++;
    this.slots.set(id, slot);
    return [...scopes, new Map([[BOUNDARY, id]])];
  }

  /**
   * Track boundary `id`'s content render, which settles (never rejects) with `render`.
   * Returns the promise of its visible completion: at once for content that never suspended,
   * a macrotask after it settles for content that did.
   */
  track(id: string, render: Promise<S>): Promise<S> {
    const slot = this.slots.get(id)!;
    slot.done = render.then(async (settled) => {
      this.idle(slot);
      if (slot.suspended) await nextMacrotask();
      slot.settled = settled;
      return settled;
    });
    return slot.done;
  }

  /** The content of the innermost boundary on the `scopes` path suspended. */
  suspendedIn(scopes: Map<symbol, unknown>[]): void {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const id = scopes[i].get(BOUNDARY) as string | undefined;
      if (id === undefined) continue;
      const slot = this.slots.get(id);
      if (slot && !slot.suspended) {
        slot.suspended = true;
        this.idle(slot);
      }
      return;
    }
  }

  /**
   * Resolves once every boundary has finished or suspended — the end of React's shell pass.
   * Capped at one macrotask: a wait that is neither (none is expected) streams, never holds
   * the shell back.
   */
  async quiet(): Promise<void> {
    if (this.busy === 0) return;
    await withinMacrotask(new Promise<void>((resolve) => this.waiters.push(resolve)));
  }

  /** The token standing for boundary `id` in its parent's HTML, its fallback recorded. */
  token(id: string, fallback: string): string {
    this.slots.get(id)!.fallback = fallback;
    return `${this.prefix}${id}\u0000`;
  }

  /**
   * Decide every boundary token in `html`. A boundary that has finished is written inline
   * (recursively deciding its own nested boundaries); one still rendering becomes its
   * fallback in a `data-dnx-b` placeholder and joins `streamed` — as a promise of its
   * content with its own tokens decided at the moment it settles — for the caller to stream.
   * A failed boundary keeps its fallback (its placeholder marked `data-dnx-failed`) and streams
   * nothing.
   */
  expand(html: string, streamed: Set<Promise<S>>, head: HeadCollector | null = null): string {
    let token = findToken(html, this.prefix, 0);
    if (!token) return html;
    let out = "";
    let last = 0;
    for (; token; token = findToken(html, this.prefix, last)) {
      out += html.slice(last, token[0]) + this.decide(token[2], streamed, head);
      last = token[1];
    }
    return out + html.slice(last);
  }

  /** Boundary `id`'s markup where its token stood: inline content, or its fallback placeholder. */
  private decide(id: string, streamed: Set<Promise<S>>, head: HeadCollector | null): string {
    const slot = this.slots.get(id)!;
    const settled = slot.settled;
    if (settled?.ok) {
      this.inlined.add(id);
      // Its hoisted tags join the enclosing head (the document's, or a streamed parent's).
      const own = settled.head && !head ? headMarkup(settled.head) : "";
      if (settled.head && head) mergeHead(head, settled.head);
      return `<!--$-->${own}${this.expand(settled.html, streamed, head)}<!--/$-->`;
    }
    if (!settled) streamed.add(this.flushed(slot, streamed));
    // A boundary that already failed keeps its fallback for good: marked, so `denext
    // doctor` finds it stuck in a document that streams nothing.
    const failed = settled ? " data-dnx-failed" : "";
    return `<div data-dnx-b="${id}"${failed}>${this.expand(slot.fallback, streamed)}</div>`;
  }

  /**
   * The control signal an inline boundary of `html` threw (searched through the boundaries
   * that would be written inline with it), or undefined. Call it right before {@link expand}
   * decides the same HTML: such a boundary is decided before anything is sent, so its signal
   * sets the whole response, as a signal thrown in the shell does.
   */
  inlineSignal(html: string): unknown {
    for (
      let token = findToken(html, this.prefix, 0);
      token;
      token = findToken(html, this.prefix, token[1])
    ) {
      const settled = this.slots.get(token[2])!.settled;
      if (!settled?.ok) continue;
      if (settled.signal !== undefined) return settled.signal;
      const nested = this.inlineSignal(settled.html);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  /**
   * A streamed boundary's content, its nested tokens decided once it settles, and its hoisted
   * head tags (its own and its inline descendants') as `headHtml`.
   */
  private flushed(slot: Slot<S>, streamed: Set<Promise<S>>): Promise<S> {
    return slot.done.then((s) => {
      if (!s.ok) return s;
      const html = this.expand(s.html, streamed, s.head ?? null);
      return { ...s, html, headHtml: headMarkup(s.head) };
    });
  }

  /** `slot` no longer holds the shell back (it finished or suspended). */
  private idle(slot: Slot<S>): void {
    if (!slot.busy) return;
    slot.busy = false;
    if (--this.busy === 0) { for (const wake of this.waiters.splice(0)) wake(); }
  }
}
