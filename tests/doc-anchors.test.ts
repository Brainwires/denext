import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  anchorLinks,
  brokenAnchors,
  relativeDocsLinks,
  renderedIds,
} from "../scripts/check-doc-anchors.ts";

Deno.test("doc anchors: ids come from id props, shell-slugged headings and rendered Markdown", () => {
  const tree = h("div", null, [
    h("h2", null, "Run history"),
    h("h3", { id: "history-store" }, "Where history is kept"),
    h("section", { id: "plain" }),
    h("div", { dangerouslySetInnerHTML: { __html: '<h2 id="from-md">From md</h2>' } }),
    h((_p: { html: string }) => h("div", null), { html: '<h3 id="from-prop">x</h3>' }),
  ]);
  assertEquals(
    [...renderedIds(tree)].sort(),
    ["from-md", "from-prop", "history-store", "plain", "run-history"],
  );
});

Deno.test("doc anchors: links in both forms, with their lines", () => {
  const text =
    "a [x](/docs/jobs#run-history)\nb https://denext.dev/docs/deploy#adapters and /docs/cli";
  assertEquals(anchorLinks(text).map((l) => [l.page, l.anchor, l.line]), [
    ["jobs", "run-history", 1],
    ["deploy", "adapters", 2],
  ]);
});

Deno.test("doc anchors: a missing id and a missing page are reported, a present id is not", () => {
  const ids = new Map([["jobs", new Set(["run-history"])]]);
  const broken = brokenAnchors(
    "X.md",
    "[a](/docs/jobs#run-history) [b](/docs/jobs#nope) [c](/docs/gone#x)",
    (p) => ids.get(p) ?? null,
  );
  assertEquals(broken.map((b) => b.reason), ['no id "nope" there', "no docs page /docs/gone"]);
});

Deno.test("doc anchors: a site-relative link in a root guide is flagged, an absolute one is not", () => {
  const broken = relativeDocsLinks(
    "CHANGELOG.md",
    "[a](/docs/updates)\n[b](https://denext.dev/docs/updates)",
  );
  assertEquals(broken.map((b) => [b.line, b.link]), [[1, "/docs/updates"]]);
});
