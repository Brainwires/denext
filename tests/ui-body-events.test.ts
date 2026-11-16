// Two small guards every `denext ui` mutation passes through: the bounded body read
// (src/ui/body.ts) and the event channels (src/ui/events.ts) — a chunked body past the ceiling is
// refused mid-read, a page that stopped reading its run's stream is dropped instead of buffered,
// and shutting down closes every open broadcast stream even when one is already gone.

import { assert, assertEquals } from "@std/assert";
import type { SseClients } from "../src/build/sse.ts";
import { boundedRequest } from "../src/ui/body.ts";
import { broadcast, closeAll, sseProcess } from "../src/ui/events.ts";

/** A body that arrives in chunks with no Content-Length (as a chunked upload does). */
function chunked(chunks: string[]): Request {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
  return new Request("http://127.0.0.1/x", { method: "POST", body });
}

Deno.test("boundedRequest: a body-less request passes as is; a chunked one is read whole under the ceiling", async () => {
  const get = new Request("http://127.0.0.1/x");
  assertEquals(await boundedRequest(get, 10), get);
  const read = await boundedRequest(chunked(["a=1&", "b=2"]), 16);
  assertEquals(await read?.text(), "a=1&b=2");
  assertEquals(read?.method, "POST");
});

Deno.test("boundedRequest: a declared or a streamed size past the ceiling is refused", async () => {
  const declared = new Request("http://127.0.0.1/x", {
    method: "POST",
    body: "0123456789",
    headers: { "content-length": "10" },
  });
  assertEquals(await boundedRequest(declared, 4), null, "refused before a byte is read");
  // No Content-Length to refuse up front: the read stops at the first chunk over the ceiling.
  let pulled = 0;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(enc.encode("x".repeat(8)));
    },
  });
  const endless = new Request("http://127.0.0.1/x", { method: "POST", body });
  assertEquals(await boundedRequest(endless, 20), null);
  assert(pulled <= 4, `the read stopped (${pulled} chunks pulled)`);
});

Deno.test("closeAll: every subscriber is closed and forgotten, even one that is already gone", () => {
  const closed: string[] = [];
  const live = { close: () => closed.push("live") } as unknown as ReadableStreamDefaultController<
    Uint8Array
  >;
  const gone = {
    close: () => {
      throw new TypeError("already closed");
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  const clients: SseClients = new Set([gone, live]);
  closeAll(clients);
  assertEquals(closed, ["live"]);
  assertEquals(clients.size, 0);
  broadcast(clients, { type: "nobody" }); // nothing left to write to: no throw
});

Deno.test("sseProcess: a reader that stops reading is dropped once its queue is full, and the run is told", async () => {
  let signal: AbortSignal | undefined;
  let settled: number | null | undefined;
  const { promise: done, resolve } = Promise.withResolvers<void>();
  const res = sseProcess((line, s) => {
    signal = s;
    // A chatty child: far more lines than one unread stream may queue.
    for (let i = 0; i < 1000; i++) line(`line ${i}`);
    return Promise.resolve(0);
  }, {
    settled: (code) => {
      settled = code;
      resolve();
    },
  });
  await done;
  assertEquals(settled, 0);
  assert(signal?.aborted, "the run's signal aborted when the reader was dropped");
  await res.body?.cancel().catch(() => {});
});

Deno.test("sseProcess: a run that throws closes its stream with the reason", async () => {
  const res = sseProcess(() => Promise.reject(new Error("spawn failed")), {
    prelude: ["$ deno task build"],
  });
  const text = await res.text();
  assertEquals(text, "data: $ deno task build\n\ndata: — failed: spawn failed\n\n");
});
