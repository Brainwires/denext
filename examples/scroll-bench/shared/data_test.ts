import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { type Item, makeItems, sectionOf, sectionStarts } from "./data.ts";
import { png } from "./gen-images.ts";
import { PACKAGES, parseLink, parseRunParams, SCHEMES } from "./scenarios.ts";
import { FIXED, HEADER } from "./theme.ts";

Deno.test("items are deterministic per (kind, seed, index) and differ by seed", () => {
  const a = makeItems("chat", 1000, 7),
    b = makeItems("chat", 1000, 7),
    c = makeItems("chat", 1000, 8);
  assertEquals(JSON.stringify(a.getItem(123)), JSON.stringify(b.getItem(123)));
  assertNotEquals(
    JSON.stringify(a.getItem(123)),
    JSON.stringify(c.getItem(123)),
  );
});

Deno.test("10M fixed rows are lazy: any index, no array built", () => {
  const l = makeItems("fixed", 10_000_000);
  assertEquals(l.count, 10_000_000);
  assertEquals(l.getItem(9_999_999).type, "row");
  assertEquals(l.fixedOffset(9_999_999), 9_999_999 * FIXED.height);
});

/** Per-message facts the chat test checks. */
function chatFacts(item: Item) {
  if (item.type !== "chat") throw new Error("not chat");
  const spans = item.blocks.flatMap((b) => (b.type === "p" ? b.spans : []));
  const codeLines = item.blocks.map((b) => (b.type === "code" ? b.lines.length : 0));
  return {
    user: item.role === "user",
    maxCode: Math.max(0, ...codeLines),
    words: spans.reduce((n, s) => n + s.text.split(" ").length, 0),
    long: spans.some((s) => s.text.startsWith("sha256:")),
  };
}

Deno.test("chat covers the height range: prose 1–40 lines, code blocks up to 60 lines, long tokens", () => {
  const l = makeItems("chat", 5000);
  const facts = Array.from({ length: l.count }, (_, i) => chatFacts(l.getItem(i)));
  const maxCode = Math.max(...facts.map((f) => f.maxCode));
  assertEquals(facts.filter((f) => f.user).length, 2500);
  assert(maxCode >= 40 && maxCode <= 60, `max code lines ${maxCode}`);
  assert(Math.max(...facts.map((f) => f.words)) > 200);
  assert(facts.some((f) => f.long));
});

Deno.test("sections: headers every 20–200 rows; fixed offsets agree with a running sum", () => {
  const starts = sectionStarts(1, 100_000);
  for (let s = 1; s < starts.length; s++) {
    const rows = starts[s] - starts[s - 1] - 1;
    assert(rows >= 20 && rows <= 200, `section ${s} has ${rows} rows`);
  }
  assertEquals(sectionOf(starts, starts[3] + 5), 3);
  const l = makeItems("sections", 5000);
  let offset = 0;
  for (let i = 0; i < l.count; i++) {
    assertEquals(l.fixedOffset(i), offset);
    offset += l.isHeader(i) ? HEADER.height : FIXED.height;
    assertEquals(l.getItem(i).type, l.isHeader(i) ? "header" : "row");
  }
  assertEquals(l.stickyIndices(), Array.from(sectionStarts(1, 5000)));
  assertEquals(makeItems("chat", 10).stickyIndices(), []);
  const secs = l.sections();
  assertEquals(secs.reduce((n, s) => n + 1 + s.data.length, 0), 5000);
});

Deno.test("append/prepend keep keys stable and share the generator", () => {
  const l = makeItems("chat", 100);
  const p = l.withPrepended(10).withAppended(5);
  assertEquals(p.count, 115);
  assertEquals(p.start, -10);
  assertEquals(p.keyOf(p.start + 10), l.keyOf(0));
  assertEquals(JSON.stringify(p.getItem(10)), JSON.stringify(l.getItem(0)));
  const s = makeItems("sections", 100);
  assertEquals(s.withAppended(5), s);
});

Deno.test("deep links parse for both schemes; bad ones are null", () => {
  assertEquals(parseLink("rnscrollbench://run?list=flash&kind=chat&n=10000"), {
    type: "run",
    params: { list: "flash", kind: "chat", n: 10000, seed: 1 },
  });
  assertEquals(parseLink("denextscrollbench://action?op=append&k=50"), {
    type: "action",
    params: { op: "append", k: 50, i: undefined, on: undefined },
  });
  assertEquals(
    parseLink("denextscrollbench://action?op=fps&on=1")?.type,
    "action",
  );
  assertEquals(parseLink("rnscrollbench://run?list=flash&kind=nope&n=1"), null);
  assertEquals(parseLink("rnscrollbench://other?x=1"), null);
  assertEquals(parseRunParams("?list=dom&kind=fixed&n=1_000&seed=3"), {
    list: "dom",
    kind: "fixed",
    n: 1000,
    seed: 3,
  });
});

Deno.test("gen-images: a valid PNG of the asked size", async () => {
  const bytes = await png(40, 30, 1);
  assertEquals([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  assertEquals(new TextDecoder().decode(bytes.subarray(12, 16)), "IHDR");
  assertEquals([dv.getUint32(16), dv.getUint32(20)], [40, 30]);
  assertEquals(
    new TextDecoder().decode(bytes.subarray(bytes.length - 8, bytes.length - 4)),
    "IEND",
  );
});

Deno.test("app ids map to their Android packages and URL schemes", () => {
  assertEquals(PACKAGES, {
    denext: "com.brainwires.denext.scrollbench",
    rn: "com.brainwires.rnscrollbench",
  });
  assertEquals(SCHEMES, { denext: "denextscrollbench", rn: "rnscrollbench" });
});
