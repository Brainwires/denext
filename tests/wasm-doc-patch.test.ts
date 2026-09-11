// scripts/wasm-doc-patch.ts: adds JSDoc to the wasm-bindgen members wasmbuild emits undocumented
// (`free()`, `[Symbol.dispose]()`, `export enum` + members) and leaves documented ones alone.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { patchDts } from "../scripts/wasm-doc-patch.ts";

const INPUT = `export class Thing {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Documented already.
   */
  width(): number;
}

export enum SamplingFilter {
  Nearest = 1,
  Lanczos3 = 5,
}

export enum Other {
  A = 0,
}
`;

Deno.test("patchDts documents free/dispose/enum members and is idempotent", () => {
  const first = patchDts(INPUT);
  assertEquals(first.added, 7, "free, dispose, 2 enums, 3 members");
  assertStringIncludes(first.text, "/** Release the wasm memory behind this object.");
  assertStringIncludes(first.text, "/** `using` support:");
  assertStringIncludes(first.text, "/** The resampling filter `resize` uses");
  assertStringIncludes(
    first.text,
    "/** Nearest-neighbour: fastest, blocky (pixel art). */\n  Nearest = 1,",
  );
  assertStringIncludes(first.text, "/** The `Other` enumeration. */\nexport enum Other");
  assertStringIncludes(first.text, "/** `Other.A`. */\n  A = 0,");
  // The already-documented method gets nothing, and a second pass adds nothing.
  assert(!first.text.includes("*/\n  /** ") || !first.text.includes("width(): number;\n  /**"));
  const second = patchDts(first.text);
  assertEquals(second.added, 0);
  assertEquals(second.text, first.text);
});
