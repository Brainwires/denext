// tests/helpers/heap-flags.ts: a child that must hit a small heap limit drops the heap sizes
// DENO_V8_FLAGS would hand it, and keeps the rest.

import { assertEquals } from "@std/assert";
import { withoutHeapSize } from "./helpers/heap-flags.ts";

Deno.test("withoutHeapSize: the heap sizes go, other flags and variables stay", () => {
  // The Windows test pass's own value: nothing left, so the variable goes (an empty one is a flag
  // V8 refuses).
  assertEquals(withoutHeapSize({ DENO_V8_FLAGS: "--max-old-space-size=6144", A: "1" }), { A: "1" });
  assertEquals(
    withoutHeapSize({
      DENO_V8_FLAGS: "--stack-size=2000, --max_old_space_size=8192,--max-heap-size=64,--expose-gc",
    }),
    { DENO_V8_FLAGS: "--stack-size=2000,--expose-gc" },
  );
  // A look-alike flag is not a heap size; no variable, nothing to do.
  assertEquals(withoutHeapSize({ DENO_V8_FLAGS: "--max-old-space-size-x=1" }), {
    DENO_V8_FLAGS: "--max-old-space-size-x=1",
  });
  assertEquals(withoutHeapSize({ PATH: "/bin" }), { PATH: "/bin" });
  // The input is left as it was.
  const env = { DENO_V8_FLAGS: "--max-old-space-size=1" };
  withoutHeapSize(env);
  assertEquals(env, { DENO_V8_FLAGS: "--max-old-space-size=1" });
});
