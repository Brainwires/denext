// denext/markdown — the public Markdown module: `renderMarkdown` (HTML string) and `<Markdown>`
// (denext elements with swappable components). The renderer is the one content collections use;
// these pin the public options (headingIds, allowDataImages, urlPolicy), the component path's
// equivalence with the HTML path, and the XSS vectors — the GHSA-3q88-358h-83j3 link-label
// attribute injection included — through the public entry, in both raw-HTML modes and both
// render paths.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { DOMParser, type Element } from "@b-fuze/deno-dom";
import {
  Markdown,
  type MarkdownCodeProps,
  type MarkdownElementProps,
  type MarkdownOptions,
  renderMarkdown,
  sanitizeHtml,
} from "../src/markdown/mod.ts";
import * as contentMarkdown from "../packages/content-collections/markdown.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { render } from "../src/testing/mod.ts";

const MODES: readonly MarkdownOptions[] = [{}, { html: "sanitize" }];

/** Server-render `<Markdown>` to its HTML. */
function md(source: string, props: Record<string, unknown> = {}): Promise<string> {
  return renderToString(h(Markdown, { source, ...props }));
}

/** The parsed body of an HTML fragment. */
function body(html: string): Element {
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html")!.body as Element;
}

/** The same fragment as a canonical DOM serialization, with whitespace between blocks dropped. */
function canonical(html: string): string {
  return body(html).innerHTML.replace(/>\n</g, "><");
}

/** Everything in the parsed output that could run script: elements, handlers, URL schemes. */
function scriptVectors(html: string): string[] {
  const found: string[] = [];
  for (const el of body(html).querySelectorAll("*") as Iterable<Element>) {
    const tag = el.tagName.toLowerCase();
    if (["script", "iframe", "object", "embed", "svg", "math", "style", "form"].includes(tag)) {
      found.push(`<${tag}>`);
    }
    for (const name of el.getAttributeNames()) {
      const value = el.getAttribute(name) ?? "";
      if (/^on/i.test(name) || name === "style" || name === "srcdoc") found.push(`${tag}[${name}]`);
      // deno-lint-ignore no-control-regex -- browsers ignore C0 controls inside a scheme
      if (/^\s*(?:javascript|vbscript|data):/i.test(value.replace(/[\u0000- ]+/g, ""))) {
        found.push(`${tag}[${name}=${value}]`);
      }
    }
  }
  return found;
}

/** Attacker-written Markdown: raw HTML, handlers, script URLs, entity tricks, label breakouts. */
const XSS_VECTORS: readonly string[] = [
  `<script>alert(1)</script>`,
  `<img src=x onerror=alert(1)>`,
  `<a href="javascript:alert(1)">x</a>`,
  `<div style="background:url(javascript:alert(1))" onclick="alert(1)">x</div>`,
  `<svg onload=alert(1)><circle /></svg>`,
  `<iframe srcdoc="<script>alert(1)</script>"></iframe>`,
  `<math><mi xlink:href="javascript:alert(1)">x</mi></math>`,
  `[x](javascript:alert(1))`,
  `[x](JaVaScRiPt:alert(1))`,
  `[x](vbscript:msgbox(1))`,
  `[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)`,
  `[x](&#106;avascript:alert(1))`,
  `[x](&#x6A;avascript:alert(1))`,
  `[x](&#0000106;avascript:alert(1))`,
  `[x](java&#09;script:alert(1))`,
  `[x](java\tscript:alert(1))`,
  `[x]( javascript:alert(1))`,
  `![x](javascript:alert(1))`,
  `![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)`,
  `![x" onerror="alert(1)](https://e.test/a.png)`,
  `![x](https://e.test/a.png "t\\" onerror=\\"alert(1)")`,
  `[" onmouseover="alert(1)](https://e.test/)`,
  `[" autofocus onfocus="alert(1)](x\u0001y)`,
  `[" autofocus onfocus="alert(1)][l]\n\n[l]: x\u0001y`,
  `[x][l]\n\n[l]: javascript:alert(1)`,
  `[*a](https://e.test/*" onclick="alert(1))`,
  `**[a**](javascript:alert(1))`,
  `*[a*](https://e.test/" onclick="alert(1))`,
  `[\`"\` onclick="alert(1)](https://e.test/)`,
  `[[nested](javascript:alert(1))](https://e.test/)`,
  `[a](https://e.test/_x_" onclick="alert(1))`,
  `# <img src=x onerror=alert(1)>`,
  `| <img src=x onerror=alert(1)> |\n|-|\n| [x](javascript:alert(1)) |`,
  `> [!NOTE]\n> <script>alert(1)</script>`,
  `[^1]\n\n[^1]: [x](javascript:alert(1))`,
  "```\n</code></pre><script>alert(1)</script>\n```",
  "`</code><script>alert(1)</script>`",
  `&lt;script&gt;alert(1)&lt;/script&gt;`,
];

Deno.test("renderMarkdown escapes raw HTML by default and sanitizes it when asked", () => {
  assertEquals(
    renderMarkdown("# Hi <b>there</b>"),
    '<h1 id="hi-there">Hi &lt;b&gt;there&lt;/b&gt;</h1>',
  );
  assertEquals(
    renderMarkdown("Press <kbd>Ctrl</kbd> <img src=x onerror=alert(1)>", { html: "sanitize" }),
    '<p>Press <kbd>Ctrl</kbd> <img src="x" /></p>',
  );
  assertEquals(sanitizeHtml("<b onclick=x>hi</b><script>x</script>"), "<b>hi</b>");
});

Deno.test("the content-collections renderer is denext/markdown's own", () => {
  assert(contentMarkdown.renderMarkdown === renderMarkdown);
  assert(contentMarkdown.sanitizeHtml === sanitizeHtml);
});

Deno.test("headingIds: false leaves headings without ids", () => {
  assertEquals(
    renderMarkdown("## Known Gaps & Risk"),
    '<h2 id="known-gaps--risk">Known Gaps &amp; Risk</h2>',
  );
  assertEquals(renderMarkdown("## Known Gaps", { headingIds: false }), "<h2>Known Gaps</h2>");
});

Deno.test("allowDataImages keeps raster data: images only, never on links or as SVG", () => {
  const png = "![dot](data:image/png;base64,iVBORw0KGgo=)";
  assertEquals(renderMarkdown(png), "<p>dot</p>");
  assertEquals(
    renderMarkdown(png, { allowDataImages: true }),
    '<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="dot" /></p>',
  );
  const svg = "![x](data:image/svg+xml;base64,PHN2Zz4=)";
  assertEquals(renderMarkdown(svg, { allowDataImages: true }), "<p>x</p>");
  const link = "[x](data:image/png;base64,iVBORw0KGgo=)";
  assertEquals(renderMarkdown(link, { allowDataImages: true }), "<p>x</p>");
  const notBase64 = "![x](data:image/png,<svg>)";
  assertEquals(renderMarkdown(notBase64, { allowDataImages: true }), "<p>x</p>");
});

Deno.test("urlPolicy refuses more links and images, and cannot allow a script URL", () => {
  const seen: string[] = [];
  const sameSite = (url: string, kind: string) => {
    seen.push(`${kind}:${url}`);
    return url.startsWith("/");
  };
  const html = renderMarkdown(
    "[in](/docs) [out](https://evil.test/?a=1&b=2) ![i](/a.png) ![o](https://evil.test/o.png)",
    { urlPolicy: sameSite },
  );
  assertEquals(html, '<p><a href="/docs">in</a> out <img src="/a.png" alt="i" /> o</p>');
  assertEquals(seen, [
    "image:/a.png",
    "image:https://evil.test/o.png",
    "link:/docs",
    "link:https://evil.test/?a=1&b=2",
  ]);
  assertEquals(renderMarkdown("[x](javascript:void)", { urlPolicy: () => true }), "<p>x</p>");
});

for (const options of MODES) {
  const mode = options.html ?? "escape";
  Deno.test(`XSS vectors (${mode}): renderMarkdown emits nothing that runs script`, () => {
    for (const src of XSS_VECTORS) {
      const html = renderMarkdown(src, options);
      assertEquals(scriptVectors(html), [], `${JSON.stringify(src)} → ${html}`);
    }
  });
  Deno.test(`XSS vectors (${mode}): <Markdown> emits nothing that runs script`, async () => {
    for (const src of XSS_VECTORS) {
      const html = await md(src, options as Record<string, unknown>);
      assertEquals(scriptVectors(html), [], `${JSON.stringify(src)} → ${html}`);
    }
  });
}

Deno.test("GHSA-3q88-358h-83j3: a link label can't break out of the anchor into attributes", async () => {
  for (const options of MODES) {
    for (
      const src of [
        `[" autofocus onfocus="alert(1)](x\u0001y)`,
        `[" autofocus onfocus="alert(1)](https://e.test/\u0001y)`,
        `[" autofocus onfocus="alert(1)][l]\n\n[l]: x\u0001y`,
        `[" autofocus onfocus="alert(1)](https://e.test/)`,
      ]
    ) {
      for (const html of [renderMarkdown(src, options), await md(src, { ...options })]) {
        for (const el of body(html).querySelectorAll("*") as Iterable<Element>) {
          for (const name of el.getAttributeNames()) {
            assert(["href", "rel", "target"].includes(name), `${name} in ${html}`);
          }
        }
        assert(!html.includes("\u0001"), html);
      }
    }
  }
  // The label stays text inside the anchor; the quotes are escaped, never attribute syntax.
  const html = renderMarkdown(`[" onfocus="x](https://e.test/)`);
  assertEquals(
    html,
    '<p><a href="https://e.test/" rel="noopener noreferrer" target="_blank">" onfocus="x</a></p>',
  );
});

/** Markdown covering every construct, rendered both ways for the equivalence test. */
const CORPUS: readonly string[] = [
  '# Title\n\nSome *em*, **strong**, `code`, a [link](/x) and ![img](/a.png "t").',
  "- one\n- two\n  - nested\n\n1. a\n2. b",
  "```ts\nconst x = 1 < 2 && 3 > 2;\n```\n\n    indented code",
  "> quote\n>\n> second\n\n> [!WARNING]\n> careful",
  "| a | b |\n|:-:|--:|\n| `x\\|y` | [l](https://e.test) |",
  "text[^n] again[^n]\n\n[^n]: the note",
  "[ref][r] and [r]\n\n[r]: https://e.test/r",
  "**a *b** c* and *[a*](https://e.test)", // misnested inline output
  "<details open><summary>More</summary>\n\nBody *md*\n\n</details>",
  "Entities: &amp; &copy; &#169; < > \" '",
  "---\n\nend",
];

Deno.test("<Markdown> renders the same document as renderMarkdown", async () => {
  for (const options of MODES) {
    for (const src of CORPUS) {
      const expected = canonical(renderMarkdown(src, options));
      const actual = canonical(await md(src, { ...options }));
      assertEquals(actual, expected, JSON.stringify(src));
    }
  }
});

Deno.test("<Markdown> components replace elements and receive their attributes", async () => {
  const H1 = (p: MarkdownElementProps): VNode =>
    h("h1", { className: "title", id: p.id }, p.children);
  const A = (p: MarkdownElementProps): VNode =>
    h("a", { href: p.href, "data-ext": String(p.target === "_blank") }, p.children);
  const Code = (p: MarkdownCodeProps): VNode =>
    h("code", { "data-kind": p.inline ? "inline" : `block-${p.lang ?? "none"}` }, p.children);
  const html = await md(
    "# Hi *there*\n\nSee [docs](https://e.test/d) and `x`.\n\n```ts\nlet a = 1;\n```\n\n    plain",
    { components: { h1: H1, a: A, code: Code, em: "i" } },
  );
  assertEquals(
    html,
    '<h1 class="title" id="hi-there">Hi <i>there</i></h1>' +
      '<p>See <a href="https://e.test/d" data-ext="true">docs</a> and <code data-kind="inline">x</code>.</p>' +
      '<pre class="code" data-lang="ts"><code data-kind="block-ts">let a = 1;</code></pre>' +
      '<pre class="code"><code data-kind="block-none">plain</code></pre>',
  );
});

Deno.test("<Markdown> passes text as text: escaped source stays escaped, entities decode once", async () => {
  const html = await md("<b>x</b> &amp; 1 < 2");
  assertEquals(html, "<p>&lt;b&gt;x&lt;/b&gt; &amp;amp; 1 &lt; 2</p>");
  // The text a component receives is the decoded text the browser would show.
  let text = "";
  const P = (p: MarkdownElementProps): VNode => {
    text = String(p.children);
    return h("p", null, p.children);
  };
  await md(`a "q" 'b' & <c>`, { components: { p: P } });
  assertEquals(text, `a "q" 'b' & <c>`);
});

Deno.test("<Markdown> maps attributes to React props (className, boolean open)", async () => {
  const seen: MarkdownElementProps[] = [];
  const spy = (tag: string) => (p: MarkdownElementProps): VNode => {
    seen.push(p);
    return h(tag, null, p.children);
  };
  await md("<details open><summary>S</summary>\n\nx\n\n</details>\n\n> [!NOTE]\n> n", {
    html: "sanitize",
    components: { details: spy("details"), aside: spy("aside") },
  });
  assertEquals(seen[0].open, true);
  assertEquals(seen[1].className, "callout note");
  assert(!("class" in seen[1]));
});

Deno.test("<Markdown> ignores a components key that isn't an own property", async () => {
  const components = Object.create({ p: () => h("blink", null) });
  assertEquals(await md("hi", { components }), "<p>hi</p>");
});

Deno.test("<Markdown> mounts in the client renderer too", async () => {
  const Link = (p: MarkdownElementProps): VNode =>
    h("a", { href: p.href, "data-testid": "link" }, p.children);
  const screen = await render(
    h(Markdown, { source: "## Hello\n\n[go](/go) <i>raw</i>", components: { a: Link } }),
  );
  const html = screen.html();
  assertStringIncludes(html, '<h2 id="hello">Hello</h2>');
  assertStringIncludes(html, "&lt;i&gt;raw&lt;/i&gt;");
  assertEquals(screen.getByTestId("link").getAttribute("href"), "/go");
  await screen.unmount();
});
