// A soft navigation's deferred values, streamed after its Flight payload — what a document load
// does per Suspense boundary (`data-dnx-v` chunks), for a client navigation. The render leaves a
// `{$:"vh"}` value hole for each deferred value (a Remix `defer()` field, promise data) instead of
// awaiting it, the payload goes out at once, and each value follows as its own line the moment it
// settles, so an early `<Await>` resolves before a slow one. Only a browser navigation asks for it
// (`x-denext-defer: 1`); any other soft-nav request (a prefetch, Live's re-render) gets the
// complete payload, values resolved, as before.

import type { DeferredValueSink } from "../jsx/render-to-html-flight.ts";
import type { FlightValue } from "../jsx/render-to-flight.ts";
import { type Serialized, SKIP } from "../jsx/render-shared.ts";
import { serializeThenable } from "../jsx/flight-scalar.ts";

/** One settled deferred value: its value-hole id and serialized value. */
type Settled = [id: string, value: FlightValue];

/** The deferred values of one streamed soft navigation (see the module comment). */
export class NavDeferredValues implements DeferredValueSink {
  #next = 0;
  /** The values still settling (one settling may register more: a value holding a promise). */
  readonly pending: Set<Promise<Settled>> = new Set();

  /** Leave a value hole for `promise`; a rejection settles to `<Await>`'s error marker. */
  hole(
    promise: PromiseLike<unknown>,
    serialize: (value: unknown) => Promise<Serialized>,
  ): FlightValue {
    const id = `dnxv${this.#next++}`;
    this.pending.add(
      serializeThenable(promise, serialize).then((v): Settled => [id, v === SKIP ? null : v]),
    );
    return { $: "vh", r: id } as unknown as FlightValue;
  }

  /** Each value as it settles, until none is left. */
  async *settled(): AsyncGenerator<Settled> {
    while (this.pending.size > 0) {
      const [p, value] = await Promise.race(
        [...this.pending].map((p) => p.then((v) => [p, v] as const)),
      );
      this.pending.delete(p);
      yield value;
    }
  }
}

/** Whether a request is a browser soft navigation that streams its deferred values. */
export function wantsNavDeferred(request: Request): boolean {
  return request.method === "GET" && request.headers.get("x-denext-nav") === "1" &&
    request.headers.get("x-denext-defer") === "1";
}

/**
 * The response body: the payload line, then one `{"v":id,"x":value}` line per deferred value as
 * it settles. Ends early when the request is aborted.
 */
export function navDeferredBody(
  payload: string,
  values: NavDeferredValues,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const settled = values.settled();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
    },
    async pull(controller) {
      const next = signal?.aborted ? undefined : await settled.next();
      if (!next || next.done) return controller.close();
      const [v, x] = next.value;
      controller.enqueue(encoder.encode("\n" + JSON.stringify({ v, x }).replace(/</g, "\\u003c")));
    },
    cancel() {
      void settled.return(undefined);
    },
  });
}
