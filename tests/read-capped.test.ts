// The shared capped body reader (src/utils/read-capped.ts) behind the dev server's DevTools sink
// and the Deno Desktop bridge's RPC: text up to the cap, `null` past it, counted as it streams,
// and `TIMED_OUT` for a body that stalls, trickles past the total deadline or is aborted.

import { assert, assertEquals } from "@std/assert";
import {
  READ_CAPPED_IDLE_MS,
  READ_CAPPED_TOTAL_MS,
  readCapped,
  TIMED_OUT,
} from "../src/utils/read-capped.ts";

/** A POST whose body arrives as `chunks`, with no `content-length`. */
function streamed(chunks: Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Request("http://localhost/", { method: "POST", body });
}

Deno.test("readCapped: a body under the cap reads whole, a character split across chunks too", async () => {
  const bytes = new TextEncoder().encode('{"n":"é"}');
  const at = bytes.indexOf(0xc3) + 1; // split the two bytes of "é"
  assertEquals(await readCapped(streamed([bytes.slice(0, at), bytes.slice(at)]), 64), '{"n":"é"}');
});

Deno.test("readCapped: no body is an empty string; past the cap is null", async () => {
  assertEquals(await readCapped(new Request("http://localhost/"), 8), "");
  const big = new Uint8Array(6).fill(0x61);
  assertEquals(await readCapped(streamed([big, big]), 8), null);
});

/** A POST whose body sends `first` and then never sends another byte nor closes. */
function stalled(first: Uint8Array): { request: Request; cancelled: Promise<void> } {
  let onCancel!: () => void;
  const cancelled = new Promise<void>((resolve) => onCancel = resolve);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
    },
    cancel() {
      onCancel();
    },
  });
  return { request: new Request("http://localhost/", { method: "POST", body }), cancelled };
}

/** A POST that trickles one byte every `everyMs`, forever, until cancelled. */
function trickled(everyMs: number): Request {
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => controller.enqueue(new Uint8Array([0x61])), everyMs);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Request("http://localhost/", { method: "POST", body });
}

Deno.test("readCapped: a body that stops sending times out (idle) and is cancelled", async () => {
  const { request, cancelled } = stalled(new Uint8Array([0x7b]));
  assertEquals(await readCapped(request, 64, { idleMs: 20 }), TIMED_OUT);
  await cancelled;
});

Deno.test("readCapped: a body trickled under the idle timeout still hits the total deadline", async () => {
  const started = Date.now();
  assertEquals(await readCapped(trickled(5), 1 << 20, { idleMs: 1_000, totalMs: 60 }), TIMED_OUT);
  assert(Date.now() - started < 1_000, "the total deadline, not the idle one, ended the read");
});

Deno.test("readCapped: an aborted signal stops the read", async () => {
  const { request, cancelled } = stalled(new Uint8Array([0x7b]));
  const controller = new AbortController();
  const read = readCapped(request, 64, { signal: controller.signal, idleMs: 60_000 });
  controller.abort();
  assertEquals(await read, TIMED_OUT);
  await cancelled;
  const pre = AbortSignal.abort();
  assertEquals(
    await readCapped(stalled(new Uint8Array([1])).request, 64, { signal: pre }),
    TIMED_OUT,
  );
});

Deno.test("readCapped: the defaults bound a read (idle and total)", () => {
  assert(READ_CAPPED_IDLE_MS > 0 && READ_CAPPED_IDLE_MS <= 30_000);
  assert(READ_CAPPED_TOTAL_MS >= READ_CAPPED_IDLE_MS && READ_CAPPED_TOTAL_MS <= 120_000);
});
