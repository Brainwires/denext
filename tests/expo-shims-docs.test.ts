// /docs/react-native's "Expo APIs" table is the one scripts/gen-expo-shim-docs.ts generates from
// src/expo/manifest.ts (EXPO_SHIMS), so a shim added, re-statused or re-noted in the manifest
// cannot leave the docs behind.

import { assert, assertEquals } from "@std/assert";
import { EXPO_SHIMS } from "../src/expo/manifest.ts";
import {
  currentTable,
  DOCS_PAGE,
  expoShimsTable,
  tableCells,
} from "../scripts/gen-expo-shim-docs.ts";

Deno.test("expo shims: /docs/react-native's table is generated from the manifest", async () => {
  const page = await Deno.readTextFile(new URL(`../${DOCS_PAGE}`, import.meta.url));
  const current = currentTable(page);
  assert(current !== null, "the table's markers are in the page");
  assertEquals(
    tableCells(current),
    tableCells(expoShimsTable()),
    "stale: run `deno run -A scripts/gen-expo-shim-docs.ts`",
  );
});

Deno.test("expo shims: the table has one row per manifest key, with its status", () => {
  const rows = tableCells(expoShimsTable()).slice(1);
  assertEquals(rows.map((row) => row[0]), Object.keys(EXPO_SHIMS).map((pkg) => `\`${pkg}\``));
  for (const [i, shim] of Object.values(EXPO_SHIMS).entries()) {
    assertEquals(rows[i][1], shim.pinned);
    assertEquals(rows[i][2], shim.status);
  }
});
