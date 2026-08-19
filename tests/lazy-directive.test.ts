// The client:* hydration directive parser — precedence (prop > module default >
// none), marker stripping, and validation.

import { assertEquals } from "@std/assert";
import {
  parseStrategy,
  readStampedStrategy,
  STRATEGY_PROP,
} from "../src/runtime/lazy-directive.ts";

Deno.test("extracts a client:<strategy> prop and strips it", () => {
  const { strategy, rest } = parseStrategy({ "client:visible": true, id: "c" });
  assertEquals(strategy, "visible");
  assertEquals(rest, { id: "c" });
});

Deno.test('accepts the value form client="idle"', () => {
  const { strategy, rest } = parseStrategy({ "client:x": "idle", id: "c" });
  assertEquals(strategy, "idle");
  assertEquals(rest, { id: "c" });
});

Deno.test("ignores an invalid strategy name but still strips the marker", () => {
  const { strategy, rest } = parseStrategy({ "client:whenever": true, id: "c" });
  assertEquals(strategy, null);
  assertEquals(rest, { id: "c" });
});

Deno.test("a false-valued directive is stripped and does not activate", () => {
  const { strategy, rest } = parseStrategy({ "client:visible": false, id: "c" });
  assertEquals(strategy, null);
  assertEquals(rest, { id: "c" });
});

Deno.test("usage-site prop wins over the module default", () => {
  const { strategy } = parseStrategy({ "client:interaction": true }, "idle");
  assertEquals(strategy, "interaction");
});

Deno.test("module default fills in when no usage-site prop is present", () => {
  const { strategy, rest } = parseStrategy({ id: "c" }, "visible");
  assertEquals(strategy, "visible");
  assertEquals(rest, { id: "c" });
});

Deno.test("no directive and no default → eager (null)", () => {
  const { strategy, rest } = parseStrategy({ id: "c" });
  assertEquals(strategy, null);
  assertEquals(rest, { id: "c" });
});

Deno.test("readStampedStrategy round-trips a stamped strategy", () => {
  assertEquals(readStampedStrategy({ [STRATEGY_PROP]: "idle" }), "idle");
  assertEquals(readStampedStrategy({ [STRATEGY_PROP]: "bogus" }), null);
  assertEquals(readStampedStrategy({}), null);
});
