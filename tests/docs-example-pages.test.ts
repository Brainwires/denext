// The per-example docs pages (/docs/examples/<name>, site/app/docs/examples/[name]/page.tsx):
// every example's README renders as the site renders it — no relative href left over, no raw
// HTML leaking as text, every in-page anchor landing on a heading — and the page module
// pre-renders exactly one page per indexed example, each with its "Run it" block, GitHub link and
// a link back into its category on the index.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderDoc } from "../site/lib/markdown.ts";
import {
  byCategory,
  CATEGORIES,
  EXAMPLES,
  examplesNav,
  indexOrder,
  neighbours,
  readmePath,
  runBlock,
} from "../site/lib/examples.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import type { PageProps } from "../src/server/mod.ts";

const REPO = new URL("../", import.meta.url);

/** The props the router passes a page: `params` readable directly (sync) — all the page uses. */
const pageProps = (name: string) => ({ params: { name } }) as unknown as PageProps;

const README_HTML = new Map(
  EXAMPLES.filter((e) => e.hasReadme).map((e) => {
    const sourcePath = readmePath(e.name);
    const src = Deno.readTextFileSync(new URL(sourcePath, REPO));
    return [e.name, renderDoc(src, { sourcePath }).html] as const;
  }),
);

Deno.test("example pages: every README renders with no relative href", () => {
  assert(README_HTML.size > 40, `expected 40+ example READMEs, rendered ${README_HTML.size}`);
  for (const [name, html] of README_HTML) {
    for (const m of html.matchAll(/href="([^"]*)"/g)) {
      assert(
        /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(m[1]),
        `examples/${name}: href="${m[1]}" is relative — it would resolve against /docs/examples/`,
      );
    }
  }
});

Deno.test("example pages: a link to another example points at its docs page", () => {
  // postgres-load links `../notes`; effect-runtime links `../effect`.
  assertStringIncludes(README_HTML.get("postgres-load")!, 'href="/docs/examples/notes"');
  assertStringIncludes(README_HTML.get("effect-runtime")!, 'href="/docs/examples/effect"');
  const names = new Set(EXAMPLES.map((e) => e.name));
  for (const [name, html] of README_HTML) {
    for (const m of html.matchAll(/href="\/docs\/examples\/([^"#]+)/g)) {
      assert(names.has(m[1]), `examples/${name} links /docs/examples/${m[1]}, which has no page`);
    }
  }
});

Deno.test("example pages: no README leaks raw HTML as text, and in-page anchors resolve", () => {
  for (const [name, html] of README_HTML) {
    assertEquals(html.includes("&lt;p align="), false, `examples/${name} leaks a raw HTML banner`);
    for (const m of html.matchAll(/href="#([^"]+)"/g)) {
      assert(html.includes(`id="${m[1]}"`), `examples/${name}: #${m[1]} has no heading`);
    }
  }
});

Deno.test("example pages: one static page per indexed example", async () => {
  const mod = await import("../site/app/docs/examples/[name]/page.tsx");
  assertEquals(
    mod.generateStaticParams().map((p: { name: string }) => p.name),
    EXAMPLES.map((e) => e.name),
  );
});

Deno.test("example pages: a page carries the run block, the source link and its README", async () => {
  const mod = await import("../site/app/docs/examples/[name]/page.tsx");
  const html = await renderToString(await mod.default(pageProps("notes")));
  assertStringIncludes(html, "git clone https://github.com/Brainwires/denext");
  assertStringIncludes(html, "cd denext/examples/notes");
  assertStringIncludes(
    html,
    'href="https://github.com/Brainwires/denext/tree/main/examples/notes"',
  );
  assertStringIncludes(html, 'href="/docs/examples#cat-start"');
  assertStringIncludes(html, 'id="related-examples"');
  // The README's own sections are on the page.
  assertStringIncludes(html, 'id="run-it"');
  // The sidebar nests this example under Examples, marked as the page being shown.
  assert(/<a href="\/docs\/examples\/notes" class="active" aria-current="page"/.test(html), html);
  const unknown = await renderToString(await mod.default(pageProps("nope")));
  assertStringIncludes(unknown, "Unknown example.");
});

Deno.test("examples lib: categories, index order and neighbours", () => {
  const grouped = byCategory();
  assertEquals(
    grouped.reduce((n, g) => n + g.examples.length, 0),
    EXAMPLES.length,
    "every example is in exactly one category",
  );
  assertEquals(grouped.map((g) => g.category.id), CATEGORIES.map((c) => c.id));
  const order = indexOrder();
  assertEquals(neighbours(order[0].name).prev, undefined);
  assertEquals(neighbours(order[1].name).prev?.name, order[0].name);
  assertEquals(neighbours(order[order.length - 1].name).next, undefined);
  assertEquals(neighbours("nope"), {});
});

Deno.test("examples lib: the sidebar opens only the current example's category", () => {
  const nav = examplesNav("drizzle");
  assertEquals(nav.length, CATEGORIES.length);
  const open = nav.filter((c) => c.children);
  assertEquals(open.length, 1);
  assert(open[0].children!.some((c) => c.href === "/docs/examples/drizzle" && c.current));
  assert(examplesNav().every((c) => !c.children));
});

Deno.test("examples lib: the run block changes into the directory the commands are for", () => {
  const byName = new Map(EXAMPLES.map((e) => [e.name, e]));
  assertStringIncludes(runBlock(byName.get("hello")!), "\ncd denext/examples/hello\n");
  // `deno task example:animation` is a repo-root task.
  assertStringIncludes(runBlock(byName.get("animation")!), "\ncd denext\ndeno task example:");
});
