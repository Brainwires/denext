// The docs site rendered against the REAL repo-root guides: every published root document must
// come out of the renderer with no dangling relative link, with its tables intact, with no raw
// HTML leaking as text, and with every in-page anchor pointing at a heading that exists.

import { assert, assertEquals } from "@std/assert";
import { renderDoc } from "../apps/web/lib/markdown.ts";
import { DOC_URLS } from "../apps/web/lib/docs-map.ts";

/** The root docs the site publishes, rendered exactly as the site renders them. */
function renderRootDocs(): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of Object.keys(DOC_URLS)) {
    let src: string;
    try {
      src = Deno.readTextFileSync(new URL(`../${path}`, import.meta.url));
    } catch {
      continue; // a guide that hasn't landed (or has moved) yet
    }
    out.set(path, renderDoc(src, { sourcePath: path }).html);
  }
  return out;
}

const DOCS = renderRootDocs();

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

Deno.test("docs site: every rendered root doc leaves no relative href", () => {
  for (const [path, html] of DOCS) {
    assert(!html.includes('href="./'), `${path} still has a "./" href`);
    assert(!html.includes('href="../'), `${path} still has a "../" href`);
  }
});

Deno.test("docs site: table-bearing docs render tables", () => {
  // `<tr>` counts are header + body rows (GFM's `| --- |` delimiter is not a row).
  const rows: Record<string, [tables: number, rows: number]> = {
    "CONTRIBUTING.md": [2, 19],
    "DATABASE.md": [1, 6],
    "CVE-DEFENSE-GUIDE.md": [16, 107],
    "README-NEXT-MIGRATION.md": [2, 37],
    "README-REMIX-MIGRATION.md": [5, 54],
  };
  for (const [path, [tables, min]] of Object.entries(rows)) {
    const html = DOCS.get(path);
    if (html === undefined) continue;
    assert(count(html, "<table") >= tables, `${path} rendered fewer than ${tables} tables`);
    const tr = count(html, "<tr");
    assert(tr >= min, `${path} rendered ${tr} <tr>, expected at least ${min}`);
  }
});

Deno.test("docs site: no root doc leaks raw HTML as text", () => {
  for (const [path, html] of DOCS) {
    assertEquals(html.includes("&lt;p align="), false, `${path} leaks a raw HTML banner`);
  }
});

Deno.test("docs site: every in-page anchor resolves to a heading id", () => {
  let anchors = 0;
  for (const [path, html] of DOCS) {
    for (const m of html.matchAll(/href="#([^"]+)"/g)) {
      anchors++;
      assert(html.includes(`id="${m[1]}"`), `${path}: #${m[1]} has no heading`);
    }
  }
  assert(anchors >= 7, `expected in-page anchors to check, found ${anchors}`);
});
