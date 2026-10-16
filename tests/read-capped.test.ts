// The shared capped body reader (src/utils/read-capped.ts) behind the dev server's DevTools sink
// and the Deno Desktop bridge's RPC: text up to the cap, `null` past it, counted as it streams.

import { assertEquals } from "@std/assert";
import { readCapped } from "../src/utils/read-capped.ts";

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
