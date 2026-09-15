// `denext ui`'s subprocess runner: a child that never prints a newline (a `\r` progress bar,
// one huge blob) is streamed in bounded pieces instead of being held whole until it exits.

import { assert, assertEquals } from "@std/assert";
import { runDeno } from "../src/ui/proc.ts";

Deno.test("runDeno: output with no newline arrives in bounded pieces", async () => {
  const lines: string[] = [];
  const cwd = await Deno.makeTempDir({ prefix: "denext-proc-" });
  try {
    const program = "await new Blob(['x'.repeat(300000)]).stream().pipeTo(Deno.stdout.writable)";
    const result = await runDeno(["eval", program], {
      cwd,
      onLine: (line) => void lines.push(line),
    });
    assertEquals(result.code, 0);
    assertEquals(lines.join("").length, 300_000, "every byte arrives");
    assert(lines.length > 1, "split into several pieces");
    assert(lines.every((line) => line.length <= 128 * 1024), "each piece is bounded");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});
