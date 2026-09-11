// The font-metrics generator (scripts/gen-font-metrics.ts): Capsize entries → the compact,
// sorted tuple table `next/font`'s fallback math reads. Pure function; no network.

import { assertEquals } from "@std/assert";
import { toTuples } from "../scripts/gen-font-metrics.ts";

const entry = (familyName: string, extra: Record<string, unknown> = {}) => ({
  familyName,
  category: "sans-serif",
  ascent: 900,
  descent: -300,
  lineGap: 0,
  unitsPerEm: 1000,
  xWidthAvg: 500,
  ...extra,
});

Deno.test("toTuples keeps the seven fields, sorts by family, and drops unusable entries", () => {
  const rows = toTuples({
    zeta: entry("Zeta", { category: "serif", lineGap: 12 }),
    alpha: entry("Alpha"),
    broken: { familyName: "Broken", unitsPerEm: 0 } as never,
    nameless: { unitsPerEm: 1000 } as never,
  });
  assertEquals(rows, [
    ["Alpha", "sans-serif", 1000, 900, -300, 0, 500],
    ["Zeta", "serif", 1000, 900, -300, 12, 500],
  ]);
});

Deno.test("toTuples is deterministic (same input → identical output)", () => {
  const data = { b: entry("B"), a: entry("A") };
  assertEquals(toTuples(data), toTuples({ ...data }));
});
