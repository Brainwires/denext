// A soft navigation's streamed deferred values (the server half is src/server/nav-deferred.ts).
// The response is the Flight payload's line, then one `{"v":id,"x":value}` line per deferred
// value — a Remix `defer()` field, promise data — as it settles on the server. The tree is
// committed as soon as the payload line arrives, each `{$:"vh"}` value hole becoming a promise
// that the matching line resolves, so `<Await>` / `use()` suspend to the nearest Suspense
// boundary and each reveals the moment its own value arrives, as on a document load. Loaded on
// demand: only a navigation whose response streams values imports it.

import type { VNode, VNodeChild } from "../jsx/types.ts";

/** One value hole's promise and its settlers. */
interface Slot {
  promise: Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** The opened stream: the payload's line, and the substitution of its value holes. */
export interface NavStream {
  /** The Flight navigation payload (JSON). */
  body: string;
  /** `flight` with every value hole replaced by the promise of its value. */
  fill(flight: unknown): unknown;
}

/**
 * Read a streamed navigation response's payload line and keep reading its deferred values in
 * the background, each parsed through `parse` (so a value holding elements or client references
 * revives as on the payload). A value that never arrives (the stream ended or failed) rejects.
 *
 * @param res The navigation's response (`x-denext-defer: 1`).
 * @param parse The app's Flight parser.
 * @returns The payload line and the value-hole substitution.
 */
export async function openNavStream(
  res: Response,
  parse: (flight: unknown) => VNodeChild | Promise<VNodeChild>,
): Promise<NavStream> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const slots = new Map<string, Slot>();
  const slot = (id: string): Slot => {
    let s = slots.get(id);
    if (!s) {
      let resolve!: (v: unknown) => void, reject!: (e: unknown) => void;
      const promise = new Promise<unknown>((a, b) => (resolve = a, reject = b));
      promise.catch(() => {}); // a value nothing reads must not be an unhandled rejection
      slots.set(id, s = { promise, resolve, reject });
    }
    return s;
  };
  const fill = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(fill);
    if (v === null || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    // The serializer escapes a user object's `$` keys, so an unescaped `{$:"vh"}` is a hole.
    if (o.$ === "vh" && typeof o.r === "string") return slot(o.r).promise;
    const out: Record<string, unknown> = {};
    for (const k in o) if (k !== "__proto__") out[k] = fill(o[k]); // (the parser drops it too)
    return out;
  };
  const settle = async (line: string): Promise<void> => {
    if (line.trim() === "") return;
    const { v, x } = JSON.parse(line) as { v: string; x: unknown };
    // Revive the value through the app's parser, as a prop of a throwaway element.
    const el = await parse({ $: "h", t: "i", p: { v: fill(x) }, c: [] }) as VNode;
    const value = (el.props as { v?: unknown }).v as { __dnxAwaitError?: true; message?: string };
    // A rejected deferred value arrives as `<Await>`'s error marker: reject with it.
    if (value?.__dnxAwaitError === true) slot(v).reject(new Error(value.message));
    else slot(v).resolve(value);
  };
  let buf = "";
  let ended = false;
  const more = async (): Promise<void> => {
    const r = await reader.read();
    if (r.done) ended = true;
    else buf += r.value;
  };
  while (!ended && !buf.includes("\n")) await more();
  const nl = buf.indexOf("\n");
  const body = nl < 0 ? buf : buf.slice(0, nl);
  buf = nl < 0 ? "" : buf.slice(nl + 1);
  void (async () => {
    try {
      for (;;) {
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          await settle(line);
        }
        if (ended) break;
        await more();
      }
      await settle(buf);
    } catch { /* a broken stream: the values not yet settled reject below */ }
    for (const s of slots.values()) {
      s.reject(new Error("denext: a deferred value of this navigation never arrived"));
    }
  })();
  return { body, fill };
}
