import { assertEquals } from "@std/assert";
import { makeItems } from "./data.ts";
import {
  expandImpls,
  findSsrImpl,
  itemText,
  parseSsrQuery,
  probeText,
  SSR_IMPLS,
  SSR_MAX_N,
  ssrCellPath,
} from "./ssr-cells.ts";

Deno.test("parseSsrQuery: defaults, clamping, unknown kinds", () => {
  assertEquals(parseSsrQuery(new URLSearchParams("")), { kind: "fixed", n: 1000, seed: 1 });
  assertEquals(
    parseSsrQuery(new URLSearchParams("kind=chat&n=5000.7&seed=3")),
    { kind: "chat", n: 5000, seed: 3 },
  );
  assertEquals(parseSsrQuery(new URLSearchParams("kind=nope&n=abc&seed=x")), {
    kind: "fixed",
    n: 1000,
    seed: 1,
  });
  assertEquals(parseSsrQuery(new URLSearchParams("n=0")).n, 1);
  assertEquals(parseSsrQuery(new URLSearchParams("n=99999999")).n, SSR_MAX_N);
});

Deno.test("ssrCellPath: ssr routes, and the SPA's own query for virtual-spa", () => {
  assertEquals(ssrCellPath("static-cv", "chat", 500), "/list/static-cv?kind=chat&n=500&seed=1");
  assertEquals(ssrCellPath("virtual-spa", "fixed", 10), "/?list=denext&kind=fixed&n=10&seed=1");
  assertEquals(findSsrImpl("virtual-island-visible")?.belowFold, true);
  assertEquals(findSsrImpl("nope"), undefined);
  assertEquals(new Set(SSR_IMPLS.map((d) => d.id)).size, SSR_IMPLS.length);
});

Deno.test("probeText: a phrase of the item's own text, inside one text run", () => {
  for (const kind of ["fixed", "chat", "images", "sections"] as const) {
    const list = makeItems(kind, 300, 1);
    for (let i = 0; i < 300; i++) {
      const item = list.getItem(i);
      const probe = probeText(item);
      if (item.type === "chat" && probe === "") continue; // a message with no plain run
      assertEquals(probe.length > 0, true, `${kind} ${i}`);
      assertEquals(itemText(item).includes(probe), true, `${kind} ${i}: ${probe}`);
      assertEquals(probe.split(" ").length <= 6, true);
    }
  }
});

Deno.test("itemText: every block of a chat message", () => {
  const item = makeItems("chat", 2, 1).getItem(1);
  if (item.type !== "chat") throw new Error("expected a chat item");
  const text = itemText(item);
  for (const b of item.blocks) {
    assertEquals(text.includes(b.type === "p" ? b.spans[0].text : b.lines[0]), true);
  }
});

Deno.test("expandImpls: group names expand to their impls, ids pass through", () => {
  assertEquals(expandImpls(["islands", "static"]), [
    "static-cv-islands",
    "static-cv-resumable",
    "static-cv-delegated",
    "static",
    "static-cv",
    "static-cv-script",
  ]);
  assertEquals(expandImpls(["virtual-island", "virtual"]).length, 5);
  assertEquals(SSR_IMPLS.every((d) => d.group), true);
});
