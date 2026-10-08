// The "Fixed in denext" catalog (catalog/fixed-in-denext.json) is a list of claims; this keeps
// them honest. Every entry must name evidence tests that exist and still carry the cited test
// name, link a docs page that exists, and say "upgrade first" when it cites a CVE. The public
// page (site/app/docs/fixed/content.md) must be the generator's output, and must carry each
// entry's error text verbatim so a search for the error finds it.

import { assert, assertEquals } from "@std/assert";
import {
  CATALOG_PATH,
  FIXED_OUT,
  generateFixedPage,
  headingId,
  readCatalog,
} from "../scripts/gen-fixed-page.ts";
import { renderDoc } from "../site/lib/markdown.ts";
import { NAV } from "../site/components/ui.tsx";

const ROOT = new URL("../", import.meta.url);
const catalog = readCatalog();

function readRepoFile(rel: string): string | null {
  try {
    return Deno.readTextFileSync(new URL(rel, ROOT));
  } catch {
    return null;
  }
}

/** A test name as it appears in source: a string literal, possibly with escaped quotes. */
function sourceContainsName(source: string, name: string): boolean {
  if (source.includes(name)) return true;
  // Names written with escaped quotes or as a JSON-ish literal.
  return source.includes(JSON.stringify(name).slice(1, -1));
}

Deno.test("catalog: every evidence test file exists and contains the cited test name", () => {
  const problems: string[] = [];
  for (const e of catalog.entries) {
    assert(e.evidence.length > 0, `${e.id}: no evidence`);
    for (const ev of e.evidence) {
      const source = readRepoFile(ev.test);
      if (source === null) {
        problems.push(`${e.id}: ${ev.test} does not exist`);
      } else if (!/\bDeno\.test\b/.test(source)) {
        problems.push(`${e.id}: ${ev.test} declares no Deno.test`);
      } else if (!sourceContainsName(source, ev.name)) {
        problems.push(`${e.id}: ${ev.test} has no test named "${ev.name}"`);
      }
    }
  }
  assertEquals(problems, [], `stale ${CATALOG_PATH} evidence — fix the entry or the test`);
});

Deno.test("catalog: entries are well-formed (unique ids, known kind/group, docs page exists)", () => {
  const ids = new Set<string>();
  for (const e of catalog.entries) {
    assert(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.id), `${e.id}: id must be kebab-case`);
    assert(!ids.has(e.id), `${e.id}: duplicate id`);
    ids.add(e.id);
    assert(e.kind in catalog.kinds, `${e.id}: unknown kind ${e.kind}`);
    assert(e.group in catalog.groups, `${e.id}: unknown group ${e.group}`);
    for (const field of ["title", "problem", "cause", "denext"] as const) {
      assert(e[field].trim().length > 0, `${e.id}: empty ${field}`);
    }
    assert(e.affects.stack && e.affects.versions, `${e.id}: affects needs stack + versions`);
    const slug = /^\/docs\/([a-z0-9-]+)$/.exec(e.docs)?.[1];
    assert(slug, `${e.id}: docs must be a /docs/<slug> path`);
    assert(
      readRepoFile(`site/app/docs/${slug}/page.tsx`) !== null,
      `${e.id}: ${e.docs} has no page`,
    );
  }
  assert(catalog.entries.length >= 20, "the catalog should keep at least 20 verified entries");
});

Deno.test("catalog: an entry citing a CVE tells the reader to upgrade first", () => {
  for (const e of catalog.entries) {
    const cites = /CVE-\d{4}-\d+/.test(e.title + e.errorText.join(" "));
    if (!cites) continue;
    assert(e.upstreamFirst, `${e.id}: a CVE entry must set upstreamFirst`);
    assert(/^Upgrade /.test(e.upstreamFirst!), `${e.id}: upstreamFirst must lead with the upgrade`);
  }
});

Deno.test("catalog: the wording keeps to the positioning (no replacement framing)", () => {
  const text = JSON.stringify(catalog) + generateFixedPage(catalog);
  for (const banned of [/replac(e|es|ing) Next/i, /Next\.js killer/i, /better than Next/i]) {
    assert(!banned.test(text), `the catalog or page matches ${banned}`);
  }
});

Deno.test("docs: site/app/docs/fixed/content.md is generated from the catalog", () => {
  assertEquals(
    Deno.readTextFileSync(FIXED_OUT),
    generateFixedPage(catalog),
    "site/app/docs/fixed/content.md is stale — run `deno task docs:fixed` and commit",
  );
});

Deno.test("docs: the fixed page renders every entry, its error text verbatim, and working anchors", () => {
  const { frontmatter, html } = renderDoc(Deno.readTextFileSync(FIXED_OUT), {
    sourcePath: "site/app/docs/fixed/content.md",
  });
  assertEquals(frontmatter.slug, "fixed");
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  for (const e of catalog.entries) {
    assert(html.includes(`id="${headingId(e.title)}"`), `${e.id}: no heading`);
    for (const t of e.errorText) {
      const found = html.includes(escape(t)) || html.includes(escape(t).replace(/"/g, "&quot;")) ||
        html.includes(escape(t).replace(/'/g, "&#39;"));
      assert(found, `${e.id}: error text not on the page verbatim: ${t}`);
    }
  }
  for (const m of html.matchAll(/href="#([^"]+)"/g)) {
    assert(html.includes(`id="${m[1]}"`), `#${m[1]} has no heading`);
  }
  assert(NAV.some((g) => g.items.some((i) => i.slug === "fixed")), "the page is in the docs nav");
});
