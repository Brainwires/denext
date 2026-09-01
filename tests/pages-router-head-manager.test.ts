// Coverage for @denext/pages-router's client head manager (`applyHead`), which is
// browser-only (it mutates `document.head`). We drive it against a minimal in-memory
// DOM shim so the pure extraction/keying/restore logic runs under `deno test` (the full
// path is also exercised by the pages-router browser e2e). One test with ordered steps:
// `applyHead`'s `applied`/`seeded` registries are module-level, so a single sequence
// keeps the state deterministic.

import { assert, assertEquals } from "@std/assert";
// Same module identity `head-manager.ts` sees for `Fragment` (it compares `c.type === Fragment`).
import { Fragment, h } from "../src/jsx/jsx-runtime.ts";
import { applyHead } from "../packages/pages-router/src/head-manager.ts";

// ── Minimal DOM shim ────────────────────────────────────────────────────────
class FakeEl {
  tagName: string;
  attributes: { name: string; value: string }[] = [];
  children: FakeEl[] = [];
  textContent = "";
  parent: FakeEl | null = null;
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(k: string, v: string) {
    const a = this.attributes.find((x) => x.name === k);
    if (a) a.value = v;
    else this.attributes.push({ name: k, value: v });
  }
  getAttribute(k: string): string | null {
    return this.attributes.find((x) => x.name === k)?.value ?? null;
  }
  appendChild(el: FakeEl): FakeEl {
    el.remove();
    this.children.push(el);
    el.parent = this;
    return el;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  querySelectorAll(sel: string): FakeEl[] {
    const want = new Set(sel.split(",").map((s) => s.trim().toUpperCase()));
    return this.children.filter((c) => want.has(c.tagName));
  }
}
class FakeDoc {
  head = new FakeEl("head");
  title = "";
  createElement(tag: string) {
    return new FakeEl(tag);
  }
}

/** Text of the single head child matching `tag` (+ optional attr match). */
function headEls(doc: FakeDoc, tag: string): FakeEl[] {
  return doc.head.children.filter((c) => c.tagName === tag.toUpperCase());
}

Deno.test("pages-router applyHead: extracts, keys, applies, and restores head tags", async (t) => {
  const doc = new FakeDoc();
  const g = globalThis as { document?: unknown };
  const orig = g.document;
  g.document = doc;
  try {
    // An SSR-rendered tag already in <head> — the first applyHead must *adopt* it (seed),
    // so a later render with the same key replaces rather than duplicates it.
    const ssrViewport = new FakeEl("meta");
    ssrViewport.setAttribute("name", "viewport");
    ssrViewport.setAttribute("content", "width=device-width");
    doc.head.appendChild(ssrViewport);

    let cleanup1: () => void = () => {};

    await t.step(
      "applies a mixed <Head> (title, metas, link, script JSON-LD, style, fragment)",
      () => {
        cleanup1 = applyHead([
          h("title", null, "Home"),
          h("meta", { name: "description", content: "the home page" }),
          h("meta", { property: "og:title", content: "Home" }),
          h("meta", { charset: "utf-8" }),
          h("meta", { "http-equiv": "content-type", content: "text/html" }),
          h("link", { rel: "stylesheet", href: "/a.css" }),
          // JSON-LD via dangerouslySetInnerHTML — its __html is the tag's text/identity.
          h("script", {
            type: "application/ld+json",
            dangerouslySetInnerHTML: { __html: '{"@type":"WebSite"}' },
          }),
          h("style", null, ".x{color:red}"),
          h("base", { href: "/" }),
          // A fragment is descended into; non-hoisted + nullish children are ignored.
          h(Fragment, null, h("meta", { name: "author", content: "ada" })),
          h("div", null, "ignored"),
          null,
          false,
        ]);

        assertEquals(doc.title, "Home");
        // description meta present with the right content.
        const desc = headEls(doc, "meta").find((m) => m.getAttribute("name") === "description");
        assert(desc, "description meta applied");
        assertEquals(desc!.getAttribute("content"), "the home page");
        // boolean/false-attr handling: charset meta applied by key.
        assert(headEls(doc, "meta").some((m) => m.getAttribute("charset") === "utf-8"));
        // link, script, style, base, and the fragment's author meta all applied.
        assert(headEls(doc, "link").some((l) => l.getAttribute("href") === "/a.css"));
        assert(headEls(doc, "script").some((s) => s.textContent.includes("WebSite")));
        assert(headEls(doc, "style").some((s) => s.textContent.includes("color:red")));
        assert(headEls(doc, "base").length === 1);
        assert(headEls(doc, "meta").some((m) => m.getAttribute("name") === "author"));
        // The non-hoisted <div> was NOT added to head.
        assert(!doc.head.children.some((c) => c.tagName === "DIV"));
      },
    );

    await t.step("a re-render with the same key replaces (no duplicate)", () => {
      const cleanup2 = applyHead([
        h("meta", { name: "description", content: "updated" }),
      ]);
      const descs = headEls(doc, "meta").filter((m) => m.getAttribute("name") === "description");
      assertEquals(descs.length, 1, "keyed meta replaced, not duplicated");
      assertEquals(descs[0].getAttribute("content"), "updated");
      // Cleanup restores the previous description element.
      cleanup2();
      const after = headEls(doc, "meta").filter((m) => m.getAttribute("name") === "description");
      assertEquals(after.length, 1);
      assertEquals(after[0].getAttribute("content"), "the home page");
    });

    await t.step("explicit key prop and a title-only head", () => {
      const cleanup3 = applyHead([
        h("meta", { key: "custom", name: "robots", content: "noindex" }),
        h("title", null, "Other"),
      ]);
      assertEquals(doc.title, "Other");
      assert(headEls(doc, "meta").some((m) => m.getAttribute("content") === "noindex"));
      cleanup3();
      // Title reverts to what it was before this call.
      assertEquals(doc.title, "Home");
    });

    await t.step("full cleanup of the first render reverts title and removes its tags", () => {
      cleanup1();
      // Title restored down the chain to the value before the very first applyHead ("").
      assertEquals(doc.title, "");
      // The adopted SSR viewport meta survives (it was seeded, not added by us).
      assert(
        headEls(doc, "meta").some((m) => m.getAttribute("name") === "viewport"),
        "seeded SSR viewport meta is preserved after cleanup",
      );
    });
  } finally {
    if (orig === undefined) delete g.document;
    else g.document = orig;
  }
});
