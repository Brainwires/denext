import { assertEquals } from "@std/assert";
import { markdownTable, wrapProse } from "../src/build/scaffold-markdown.ts";

Deno.test("wrapProse: wraps greedily at 80 columns with the list prefixes", () => {
  const text = "word ".repeat(30).trim();
  const out = wrapProse(text, "- ", "  ");
  const lines = out.trimEnd().split("\n");
  assertEquals(lines[0].startsWith("- word"), true);
  for (const line of lines) assertEquals(line.length <= 80, true);
  assertEquals(lines.slice(1).every((l) => l.startsWith("  word")), true);
  assertEquals(out.replace(/\n {2}/g, " ").replace(/^- /, "").trim(), text);
});

Deno.test("wrapProse: never breaks inside a code span or a link", () => {
  const span = "`deno task <name> --with spaces`";
  const link = "[`denext` command](https://denext.dev/docs/getting-started)";
  const out = wrapProse(`${"x".repeat(60)} ${span} and ${link} end`);
  assertEquals(out.split("\n").some((l) => l === span + " and"), true);
  assertEquals(out.includes(link), true);
});

Deno.test("wrapProse: a short paragraph stays on one line", () => {
  assertEquals(wrapProse("one two"), "one two\n");
});

Deno.test("markdownTable: pads every column to its widest cell", () => {
  assertEquals(
    markdownTable(["A", "Bee"], [["long cell", "x"], ["s", "yy"]]),
    "| A         | Bee |\n" +
      "| --------- | --- |\n" +
      "| long cell | x   |\n" +
      "| s         | yy  |\n",
  );
});
