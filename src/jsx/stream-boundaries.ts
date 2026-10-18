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

/** A boundary's settled content: `ok: false` when its render failed (its fallback stays). */
export interface SettledBoundary {
  /** The boundary id (`dnxN`), shared by the placeholder and its streamed template. */
  id: string;
  /** The content HTML, still holding the tokens of its own nested boundaries. */
  html: string;
  /** False when the content failed to render: the placeholder keeps its fallback. */
  ok: boolean;
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

/** A random hex string, so content can never forge a boundary token. */
function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The Suspense boundaries of one streaming render, written into the HTML as tokens and
 * decided (inline or streamed) when the HTML holding them flushes.
 */
export class StreamBoundaries<S extends SettledBoundary> {
  private readonly slots = new Map<string, Slot<S>>();
  private readonly nonce = randomNonce();
  private readonly tokenRe = new RegExp(`\u0000dnx-sb:${this.nonce}:([^\u0000]+)\u0000`, "g");
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
    return `\u0000dnx-sb:${this.nonce}:${id}\u0000`;
  }

  /**
   * Decide every boundary token in `html`. A boundary that has finished is written inline
   * (recursively deciding its own nested boundaries); one still rendering becomes its
   * fallback in a `data-dnx-b` placeholder and joins `streamed` — as a promise of its
   * content with its own tokens decided at the moment it settles — for the caller to stream.
   * A failed boundary keeps its fallback (its placeholder marked `data-dnx-failed`) and streams
   * nothing.
   */
  expand(html: string, streamed: Set<Promise<S>>): string {
    if (!html.includes("\u0000")) return html;
    return html.replace(this.tokenRe, (_token, id: string) => {
      const slot = this.slots.get(id)!;
      const settled = slot.settled;
      if (settled?.ok) {
        this.inlined.add(id);
        return `<!--$-->${this.expand(settled.html, streamed)}<!--/$-->`;
      }
      if (!settled) streamed.add(this.flushed(slot, streamed));
      // A boundary that already failed keeps its fallback for good: marked, so `denext
      // doctor` finds it stuck in a document that streams nothing.
      const failed = settled ? " data-dnx-failed" : "";
      return `<div data-dnx-b="${id}"${failed}>${this.expand(slot.fallback, streamed)}</div>`;
    });
  }

  /** A streamed boundary's content, its nested tokens decided once it settles. */
  private flushed(slot: Slot<S>, streamed: Set<Promise<S>>): Promise<S> {
    return slot.done.then((s) => (s.ok ? { ...s, html: this.expand(s.html, streamed) } : s));
  }

  /** `slot` no longer holds the shell back (it finished or suspended). */
  private idle(slot: Slot<S>): void {
    if (!slot.busy) return;
    slot.busy = false;
    if (--this.busy === 0) { for (const wake of this.waiters.splice(0)) wake(); }
  }
}
