// The progress line of denext's pinned downloads (the Deno toolchain, the Deno Desktop runtime,
// Gleam, fastlane's Ruby): bytes and percent, redrawn at most every 100 ms on a terminal, cleared
// at the end, and nothing at all when stderr is not a terminal.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { downloadProgress, streamHashed } from "../src/build/verified-download.ts";

function recorder(terminal: boolean) {
  const out: string[] = [];
  let t = 0;
  const p = (total?: number) =>
    downloadProgress("Deno toolchain deno.zip", total, {
      isTerminal: () => terminal,
      write: (s) => void out.push(s),
      now: () => t,
    });
  return { out, p, tick: (ms: number) => void (t += ms) };
}

Deno.test("downloadProgress: bytes and percent, throttled, the last one always drawn, then cleared", () => {
  const { out, p, tick } = recorder(true);
  const line = p(70_000_000);
  line.update(1_000_000);
  tick(50);
  line.update(2_000_000); // within 100 ms: skipped
  tick(60);
  line.update(35_000_000);
  tick(1);
  line.update(70_000_000); // finished: drawn at once
  line.done();
  assertEquals(out, [
    "\r\x1b[2K  Deno toolchain deno.zip: 1.0 MB / 70.0 MB (1%)",
    "\r\x1b[2K  Deno toolchain deno.zip: 35.0 MB / 70.0 MB (50%)",
    "\r\x1b[2K  Deno toolchain deno.zip: 70.0 MB / 70.0 MB (100%)",
    "\r\x1b[2K",
  ]);
});

Deno.test("downloadProgress: an unknown total shows bytes only; nothing drawn, nothing cleared", () => {
  const { out, p } = recorder(true);
  const line = p();
  line.update(1_500_000);
  line.done();
  line.done();
  assertEquals(out, ["\r\x1b[2K  Deno toolchain deno.zip: 1.5 MB", "\r\x1b[2K"]);
  const quiet = recorder(true);
  quiet.p(10).done();
  assertEquals(quiet.out, [], "never drawn: nothing to clear");
});

Deno.test("downloadProgress: silent when stderr is not a terminal (logs, CI)", () => {
  const { out, p } = recorder(false);
  const line = p(100);
  line.update(50);
  line.update(100);
  line.done();
  assertEquals(out, []);
});

Deno.test("streamHashed reports the running byte count after each chunk", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const seen: number[] = [];
    const body = ReadableStream.from([new Uint8Array(3), new Uint8Array(4)]);
    const got = await streamHashed(body, join(dir, "f"), 100, {
      tooLarge: () => new Error("big"),
      interrupted: () => new Error("cut"),
    }, (n) => seen.push(n));
    assertEquals(got.size, 7);
    assertEquals(seen, [3, 7]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
