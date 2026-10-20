// @denext/content-collections/markdown — C0 control characters in the source. The renderer uses
// control characters as internal markers (held-markup placeholders, raw-HTML and link markers);
// one reaching a link destination once split the anchor inside its own `href`, so a quote in the
// label opened new attributes (`autofocus onfocus=…`). These pin the regression and fuzz every
// control character through link labels, destinations, titles and reference definitions, in both
// the escape and the sanitize modes, checking the parsed output carries no attribute the renderer
// does not emit.

import { assert, assertEquals } from "@std/assert";
import { DOMParser, type Element } from "@b-fuze/deno-dom";
import { type MarkdownOptions, renderMarkdown } from "../packages/content-collections/markdown.ts";

/** A control character the renderer strips from the source (its markers are among them). */
// deno-lint-ignore no-control-regex -- the point of the test
const MARKER = /[\u0000-\u0008\u000e-\u001f]/;

const MODES: readonly MarkdownOptions[] = [{}, { html: "sanitize" }];

/** The attributes the renderer's own markup may carry, per element. */
const RENDERER_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "rel", "target", "id", "class"]),
  img: new Set(["src", "alt", "title"]),
};

/** Every element's attributes the renderer would never emit for this input (an empty list = safe). */
function strayAttributes(html: string): string[] {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html")!;
  const stray: string[] = [];
  for (const el of doc.querySelectorAll("*") as Iterable<Element>) {
    const tag = el.tagName.toLowerCase();
    const allowed = RENDERER_ATTRS[tag];
    for (const name of el.getAttributeNames()) {
      if (allowed === undefined || !allowed.has(name)) {
        if (tag === "html" || tag === "head" || tag === "body") continue;
        stray.push(`${tag}[${name}]`);
      }
    }
  }
  return stray;
}

Deno.test("a U+0001 in a link destination can't split the anchor and inject attributes", () => {
  const payload = `[" autofocus onfocus="alert(1)](x\u0001y)`;
  for (const options of MODES) {
    const html = renderMarkdown(payload, options);
    assertEquals(strayAttributes(html), [], `${options.html ?? "escape"}: ${html}`);
    assert(!html.includes("\u0001"), html);
  }
});

Deno.test("a U+0001 in a reference definition or an https destination is refused too", () => {
  for (const options of MODES) {
    for (
      const src of [
        `[" autofocus onfocus="alert(1)][l]\n\n[l]: x\u0001y`,
        `[" autofocus onfocus="alert(1)](https://e.test/\u0001y)`,
        `![" onerror="alert(1)](x\u0001y)`,
      ]
    ) {
      const html = renderMarkdown(src, options);
      assertEquals(strayAttributes(html), [], html);
    }
  }
});

Deno.test("the renderer's internal markers can't be forged from the source", () => {
  // U+0000 (held markup), U+0002 (raw HTML) and U+0003 (fragment links) in both modes.
  for (const options of MODES) {
    for (const c of ["\u0000", "\u0002", "\u0003"]) {
      const html = renderMarkdown(`a ${c}0${c} [x](#${c}0${c}) \`c\` ${c}1${c}`, options);
      assert(!MARKER.test(html), JSON.stringify(html));
    }
  }
});

/** A small deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

Deno.test("fuzz: control characters in labels, hrefs and titles never yield stray attributes", () => {
  const next = rng(0xc0c0);
  const controls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).concat("\u007f");
  const pieces = [
    '"',
    "'",
    " onfocus=alert(1) ",
    " autofocus ",
    "x",
    "https://e.test/",
    "<",
    ">",
    "`",
    "*",
    "_",
    "&",
    "=",
  ];
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  const part = (): string => {
    let s = "";
    const n = 1 + Math.floor(next() * 6);
    for (let i = 0; i < n; i++) s += next() < 0.4 ? pick(controls) : pick(pieces);
    return s.replace(/[\n\r\]\)\[\(]/g, "");
  };
  for (let round = 0; round < 1500; round++) {
    const label = part();
    const href = part().replace(/\s/g, "") || "x";
    const title = part().replace(/"/g, "");
    const shapes = [
      `[${label}](${href})`,
      `[${label}](${href} "${title}")`,
      `![${label}](${href} "${title}")`,
      `[${label}][r]\n\n[r]: ${href}`,
      `![${label}][r]\n\n[r]: ${href}`,
      `**[${label}](${href})** _[${label}](${href})_`,
    ];
    for (const options of MODES) {
      const src = pick(shapes);
      const html = renderMarkdown(src, options);
      assertEquals(strayAttributes(html), [], `${JSON.stringify(src)} → ${html}`);
      assert(!MARKER.test(html), JSON.stringify(src));
    }
  }
});
