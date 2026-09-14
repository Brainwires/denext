// The docs site rendered against the REAL published guides: every document in `DOC_URLS` must
// come out of the renderer with no dangling relative link, with its tables intact, with no raw
// HTML leaking as text, and with every in-page anchor pointing at a heading that exists.
//
// A published guide's Markdown lives in one of two places, so the test looks in both: at the
// repo root (CONTRIBUTING.md, FEATURES.md, … — rendered by a wrapper page from the root), or in
// the route's own directory as `content.md` (the long-form guides that moved into the site).
// Neither present is a failure, not a skip — a mapped route with no source is a broken page.

import { assert, assertEquals } from "@std/assert";
import { renderDoc } from "../apps/web/lib/markdown.ts";
import { DOC_URLS } from "../apps/web/lib/docs-map.ts";

const REPO = new URL("../", import.meta.url);

function exists(url: URL): boolean {
  try {
    return Deno.statSync(url).isFile || Deno.statSync(url).isDirectory;
  } catch {
    return false;
  }
}

/** `/docs/migrating-remix` → `apps/web/app/docs/migrating-remix` (repo-relative). */
const pageDirFor = (route: string): string => `apps/web/app${route}`;

/** Where a published doc's Markdown actually lives: the repo root, else the route's content.md. */
function sourceFor(path: string, route: string): string {
  if (exists(new URL(path, REPO))) return path;
  const moved = `${pageDirFor(route)}/content.md`;
  assert(
    exists(new URL(moved, REPO)),
    `${path} is published at ${route} but exists neither at the repo root nor as ${moved}`,
  );
  return moved;
}

/** The published docs, rendered exactly as the site renders them, keyed by DOC_URLS key. */
function renderPublishedDocs(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, route] of Object.entries(DOC_URLS)) {
    const sourcePath = sourceFor(path, route);
    const src = Deno.readTextFileSync(new URL(sourcePath, REPO));
    out.set(path, renderDoc(src, { sourcePath }).html);
  }
  return out;
}

const DOCS = renderPublishedDocs();

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

Deno.test("docs site: every DOC_URLS route has a page directory", () => {
  for (const [path, route] of Object.entries(DOC_URLS)) {
    const page = `${pageDirFor(route)}/page.tsx`;
    assert(exists(new URL(page, REPO)), `${path} maps to ${route}, but ${page} does not exist`);
  }
});

Deno.test("docs site: every rendered doc leaves no relative href", () => {
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
    "POLICIES.md": [1, 4],
    "CVE-DEFENSE-GUIDE.md": [16, 107],
    "README-NEXT-MIGRATION.md": [2, 37],
    "README-REMIX-MIGRATION.md": [5, 54],
  };
  for (const [path, [tables, min]] of Object.entries(rows)) {
    const html = DOCS.get(path);
    assert(html !== undefined, `${path} is in DOC_URLS but was not rendered`);
    assert(count(html, "<table") >= tables, `${path} rendered fewer than ${tables} tables`);
    const tr = count(html, "<tr");
    assert(tr >= min, `${path} rendered ${tr} <tr>, expected at least ${min}`);
  }
});

Deno.test("docs site: no doc leaks raw HTML as text", () => {
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
