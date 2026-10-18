// @denext/content-collections/markdown — opt-in sanitized raw HTML (`html: "sanitize"`). A
// table-driven XSS suite (OWASP cheat-sheet vectors, mXSS / namespace-confusion vectors), round
// trips of the allowed markup, the Markdown integration (HTML blocks, inline tags, code staying
// literal), idempotence, and a seeded fuzz whose output a real HTML parser (deno-dom) must find
// free of denied elements, event handlers and non-allowlisted URL schemes.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { DOMParser, type Element } from "@b-fuze/deno-dom";
import {
  type MarkdownOptions,
  renderMarkdown,
  sanitizeHtml,
} from "../packages/content-collections/markdown.ts";

const S: MarkdownOptions = { html: "sanitize" };

/** The elements the sanitizer may emit by default. */
const ALLOWED = new Set(
  ("a abbr b bdi bdo blockquote br caption cite code col colgroup dd del details dfn div dl dt " +
    "em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p picture pre q rp rt " +
    "ruby s samp small source span strike strong sub summary sup table tbody td tfoot th thead " +
    "time tr tt u ul var wbr").split(" "),
);
/** What the Markdown renderer emits itself, on top of the sanitizer's elements. */
const RENDERER = new Set([...ALLOWED, "aside", "section"]);
const URL_ATTRS = new Set(["href", "src", "cite", "action", "formaction", "poster", "background"]);

/** The scheme a browser would see for a URL attribute value, or null for a relative URL. */
function schemeOf(value: string): string | null {
  // deno-lint-ignore no-control-regex -- what browsers strip before reading the scheme
  const v = value.replace(/[\u0000- \u007f-\u009f]/g, "");
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  return m ? m[1].toLowerCase() : null;
}

/** The URLs an attribute carries (srcset candidates split), or none for a non-URL attribute. */
function urlsOf(name: string, value: string): string[] {
  if (name === "srcset") return value.split(",").map((c) => c.trim().split(/\s+/)[0]);
  return URL_ATTRS.has(name) ? [value] : [];
}

/** Assert one attribute of `tag` is neither executable nor denied. */
function assertSafeAttribute(
  tag: string,
  name: string,
  value: string,
  context: { html: string; renderer: boolean; dataImages: boolean },
): void {
  const { html } = context;
  assert(!name.startsWith("on"), `event handler ${name} in ${html}`);
  assert(!["style", "srcdoc", "formaction"].includes(name), `${name} in ${html}`);
  assert(!name.includes(":"), `namespaced attribute ${name} in ${html}`);
  assert(name !== "class" || context.renderer, `class in ${html}`);
  for (const url of urlsOf(name, value)) {
    const scheme = schemeOf(url);
    const dataOk = context.dataImages && tag === "img" && name === "src" &&
      /^data:image\/(png|gif|jpeg|webp);base64,/i.test(url);
    assert(
      scheme === null || ["http", "https", "mailto"].includes(scheme) || dataOk,
      `scheme ${scheme} in ${name} of ${html}`,
    );
  }
}

/** Parse `html` with deno-dom and assert nothing executable or denied survived. */
function assertSafe(html: string, allowed: Set<string> = ALLOWED, dataImages = false): void {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const context = { html, renderer: allowed === RENDERER, dataImages };
  for (const el of doc.body.querySelectorAll("*") as Iterable<Element>) {
    const tag = el.tagName.toLowerCase();
    assert(allowed.has(tag), `denied element <${tag}> in ${html}`);
    for (const attr of el.attributes) {
      assertSafeAttribute(tag, attr.name.toLowerCase(), attr.value, context);
    }
  }
}

/** [vector, the exact sanitized output]. */
const XSS: Array<[string, string]> = [
  // OWASP XSS filter evasion cheat sheet
  [`<IMG SRC="javascript:alert('XSS');">`, `<img />`],
  [`<IMG SRC=javascript:alert('XSS')>`, `<img />`],
  [`<IMG SRC=JaVaScRiPt:alert('XSS')>`, `<img />`],
  ["<IMG SRC=`javascript:alert(\"RSnake says, 'XSS'\")`>", `<img />`],
  [`<IMG """><SCRIPT>alert("XSS")</SCRIPT>"\\>`, `<img />"\\&gt;`],
  [`<IMG SRC=# onmouseover="alert('xxs')">`, `<img src="#" />`],
  [
    `<IMG SRC= onmouseover="alert('xxs')">`,
    `<img src="onmouseover=&quot;alert(&#39;xxs&#39;)&quot;" />`,
  ],
  [`<IMG onmouseover="alert('xxs')">`, `<img />`],
  [`<img src=x onerror="&#0000106&#0000097&#0000118&#0000097">`, `<img src="x" />`],
  [
    `<IMG SRC=&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;&#97;&#108;&#101;&#114;&#116;&#40;&#39;&#88;&#83;&#83;&#39;&#41;>`,
    `<img />`,
  ],
  [
    `<IMG SRC=&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058&#0000097>`,
    `<img />`,
  ],
  [`<IMG SRC=&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A&#x61>`, `<img />`],
  [`<IMG SRC="jav\tascript:alert('XSS');">`, `<img />`],
  [`<IMG SRC="jav&#x09;ascript:alert('XSS');">`, `<img />`],
  [`<IMG SRC="jav&#x0A;ascript:alert('XSS');">`, `<img />`],
  [`<IMG SRC="jav&#x0D;ascript:alert('XSS');">`, `<img />`],
  [`<IMG SRC=" &#14;  javascript:alert('XSS');">`, `<img />`],
  [`<IMG SRC="java\0script:alert('XSS');">`, `<img />`],
  [`<SCRIPT/XSS SRC="http://xss.rocks/xss.js"></SCRIPT>`, ``],
  [`<BODY onload!#$%&()*~+-_.,:;?@[/|\\]^\`=alert("XSS")>`, ``],
  [`<<SCRIPT>alert("XSS");//\\<</SCRIPT>`, `&lt;`],
  [`<SCRIPT SRC=http://xss.rocks/xss.js?< B >`, ``],
  [`<IFRAME SRC="javascript:alert('XSS');"></IFRAME>`, ``],
  [`<svg/onload=alert('XSS')>`, ``],
  [`<STYLE>@import'http://xss.rocks/xss.css';</STYLE>`, ``],
  [`<META HTTP-EQUIV="refresh" CONTENT="0;url=javascript:alert('XSS');">`, ``],
  [`<TABLE BACKGROUND="javascript:alert('XSS')">`, `<table></table>`],
  [`<DIV STYLE="background-image: url(javascript:alert('XSS'))">x`, `<div>x</div>`],
  [`<BASE HREF="javascript:alert('XSS');//">`, ``],
  [`<OBJECT TYPE="text/x-scriptlet" DATA="http://xss.rocks/scriptlet.html"></OBJECT>`, ``],
  [`<EMBED SRC="data:image/svg+xml;base64,PHN2Zz4=" AllowScriptAccess="always">`, ``],
  [`<LINK REL="stylesheet" HREF="javascript:alert('XSS');">`, ``],
  [`<FRAMESET><FRAME SRC="javascript:alert('XSS');"></FRAMESET>`, ``],
  [`<XSS STYLE="behavior: url(xss.htc);">x`, `x`],
  [`<a href="javas&#99;ript:alert(1)">x</a>`, `<a>x</a>`],
  [`<a href="&#x01;javascript:alert(1)">x</a>`, `<a>x</a>`],
  [`<a href=javascript&colon;alert(1)>x</a>`, `<a>x</a>`],
  [`<a href="jav&Tab;ascript:alert(1)">x</a>`, `<a>x</a>`],
  [`<a href="vbscript:msgbox(1)">x</a>`, `<a>x</a>`],
  [`<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>`, `<a>x</a>`],
  [`<a href="  JAVASCRIPT:alert(1)">x</a>`, `<a>x</a>`],
  [`<a href="java&#x0;script:alert(1)">x</a>`, `<a>x</a>`],
  [`<form action=javascript:alert(1)><input type=submit>go</form>`, `go`],
  [`<button formaction=javascript:alert(1)>go</button>`, `go`],
  [`<details open ontoggle=alert(1)>x</details>`, `<details open="">x</details>`],
  [`<img srcset="javascript:alert(1) 1x">`, `<img />`],
  [
    `<picture><source srcset="javascript:alert(1)"><img src="a.png"></picture>`,
    `<picture><source /><img src="a.png" /></picture>`,
  ],
  [`<isindex action=javascript:alert(1) type=image>`, ``],
  [`<a xlink:href="javascript:alert(1)">x</a>`, `<a>x</a>`],
  [`<iframe srcdoc="<script>alert(1)</script>"></iframe>`, ``],
  // mXSS / namespace confusion
  [`<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>`, ``],
  [`<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`, ``],
  [
    `<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>`,
    ``,
  ],
  [`<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">`, ``],
  [
    `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>`,
    `<img src="x" />"&gt;`,
  ],
  [`<template><img src=x onerror=alert(1)></template>after`, `after`],
  [
    `<textarea><b title="</textarea><img src=x onerror=alert(1)>">`,
    `&lt;b title="<img src="x" />"&gt;`,
  ],
  [`</textarea><img src=x onerror=alert(1)>`, `<img src="x" />`],
  [`<title><img src=x onerror=alert(1)></title>`, ``],
  [`<xmp><img src=x onerror=alert(1)></xmp>`, ``],
  [`<plaintext><img src=x onerror=alert(1)>`, ``],
  [
    `<noembed><img title="</noembed><img src=x onerror=alert(1)>"></noembed>`,
    `<img src="x" />"&gt;`,
  ],
  [`<svg:script>alert(1)</svg:script>`, `alert(1)`],
  [`<x-widget onclick=alert(1)>hi</x-widget>`, `hi`],
  [`<!--><img src=x onerror=alert(1)>-->`, `<img src="x" />--&gt;`],
  [`<!-- <img src=x onerror=alert(1)> -->`, ``],
  [`<![CDATA[<img src=x onerror=alert(1)>]]>`, `]]&gt;`],
  [`<?xml version="1.0"?><b>x</b>`, `<b>x</b>`],
  [`<!DOCTYPE html><b>x</b>`, `<b>x</b>`],
  // attribute-quote and backtick breakouts
  [`<a title='x" onclick="alert(1)'>x</a>`, `<a title="x&quot; onclick=&quot;alert(1)">x</a>`],
  [`<img alt="x&quot; onerror=&quot;alert(1)">`, `<img alt="x&quot; onerror=&quot;alert(1)" />`],
  ["<img src=`x` onerror=`alert(1)`>", `<img src="&#96;x&#96;" />`],
  ["<img alt=``onerror=alert(1)>", `<img alt="&#96;&#96;onerror=alert(1)" />`],
  [`<a title="a"onclick="alert(1)">x</a>`, `<a title="a">x</a>`],
  [`<img src="x"/onerror="alert(1)">`, `<img src="x" />`],
  [`<b title=">"><img src=x onerror=alert(1)>">`, `<b title="&gt;"><img src="x" />"&gt;</b>`],
  // clobbering + links
  [`<img name="getElementById" id="cookie">`, `<img id="user-content-cookie" />`],
  [`<a name="x" href="#x">x</a>`, `<a name="user-content-x" href="#user-content-x">x</a>`],
  [`<a href="https://e.x" target="_top">x</a>`, `<a href="https://e.x">x</a>`],
  [
    `<a href="https://e.x" rel="opener" target="_BLANK">x</a>`,
    `<a href="https://e.x" target="_blank" rel="noopener noreferrer nofollow">x</a>`,
  ],
  [`<p class="evil" id="a" id="b">x</p>`, `<p id="user-content-a">x</p>`],
  [`<img src="data:image/png;base64,iVBORw0KGgo=">`, `<img />`],
];

Deno.test("sanitizeHtml: XSS vectors (OWASP cheat sheet, mXSS, namespace confusion) come out inert", () => {
  const wrong: string[] = [];
  for (const [vector, expected] of XSS) {
    const out = sanitizeHtml(vector);
    if (out !== expected) wrong.push(`${JSON.stringify(vector)}\n  → ${JSON.stringify(out)}`);
    assertSafe(out);
    assertEquals(sanitizeHtml(out), out, `idempotent: ${vector}`);
    // The same vector inline in a paragraph, and as a block, is just as inert.
    assertSafe(renderMarkdown(`text ${vector} text`, S), RENDERER);
    assertSafe(renderMarkdown(vector, S), RENDERER);
  }
  assertEquals(wrong, [], wrong.join("\n"));
});

Deno.test("sanitizeHtml: the allowed markup round-trips", () => {
  const cases: Array<[string, string]> = [
    [`<kbd>Ctrl</kbd>+<kbd>C</kbd>`, `<kbd>Ctrl</kbd>+<kbd>C</kbd>`],
    [
      `<details open><summary>More</summary><p>Body &amp; more</p></details>`,
      `<details open=""><summary>More</summary><p>Body &amp; more</p></details>`,
    ],
    [
      `<table><thead><tr><th colspan="2" align="left">H</th></tr></thead><tbody><tr><td rowspan=1>a</td><td>b</td></tr></tbody></table>`,
      `<table><thead><tr><th colspan="2" align="left">H</th></tr></thead><tbody><tr><td rowspan="1">a</td><td>b</td></tr></tbody></table>`,
    ],
    [
      `<p align="center"><img src="logo.png" alt="Logo" width="120" height=40></p>`,
      `<p align="center"><img src="logo.png" alt="Logo" width="120" height="40" /></p>`,
    ],
    [`<ol start="3" type="a"><li>x</li></ol>`, `<ol start="3" type="a"><li>x</li></ol>`],
    [
      `<time datetime="2026-10-17">today</time> <abbr title="HyperText">HTML</abbr>`,
      `<time datetime="2026-10-17">today</time> <abbr title="HyperText">HTML</abbr>`,
    ],
    [
      `<picture><source srcset="a.webp 1x, https://x.example/b.webp 2x" type="image/webp"><img src="a.png"></picture>`,
      `<picture><source srcset="a.webp 1x, https://x.example/b.webp 2x" type="image/webp" /><img src="a.png" /></picture>`,
    ],
    [
      `<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>`,
      `<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>`,
    ],
    [`<a href="mailto:a@b.c">mail</a>`, `<a href="mailto:a@b.c">mail</a>`],
    [`<a href="/docs?a=1&amp;b=2">rel</a>`, `<a href="/docs?a=1&amp;b=2">rel</a>`],
    [`x<br>y<hr/>z<wbr>`, `x<br />y<hr />z<wbr />`],
    [
      `<sub>2</sub><sup>3</sup><mark>m</mark><del>d</del><ins>i</ins>`,
      `<sub>2</sub><sup>3</sup><mark>m</mark><del>d</del><ins>i</ins>`,
    ],
    [`&copy; &#169; &unknown; 1 < 2`, `© © &amp;unknown; 1 &lt; 2`],
    // unbalanced: closed or ignored, never left open
    [`<b><i>x</b>y</i>`, `<b><i>x</i></b>y`],
    [`<div><span>open`, `<div><span>open</span></div>`],
    [`</div>stray</p>`, `stray`],
    [`<center>c</center>`, `c`],
  ];
  for (const [input, expected] of cases) {
    const out = sanitizeHtml(input);
    assertEquals(out, expected, input);
    assertEquals(sanitizeHtml(out), out, `idempotent: ${input}`);
  }
});

Deno.test("sanitizeHtml options extend the allowlist but never reach the hard-denied set", () => {
  const opts = {
    allowElements: ["center", "script", "svg", "x-el", "svg:a", "IFRAME"],
    allowAttributes: {
      "*": ["class", "onclick", "style", "is", "xmlns"],
      a: ["rel", "xlink:href", "ping", "formaction", "srcdoc"],
    },
    allowDataImages: true,
  };
  assertEquals(
    sanitizeHtml(
      `<center class="c" onclick="x()" style="color:red">c</center><script>1</script><svg></svg><x-el>e</x-el><iframe></iframe>`,
      opts,
    ),
    `<center class="c">c</center>e`,
  );
  assertEquals(
    sanitizeHtml(
      `<a rel="me" ping="javascript:1" is="x-a" formaction="/f" srcdoc="x" href="/x">x</a>`,
      opts,
    ),
    `<a rel="me" href="/x">x</a>`,
  );
  // data: images only with allowDataImages, only raster types, only on <img src>.
  const png = "data:image/png;base64,iVBORw0KGgo=";
  assertEquals(sanitizeHtml(`<img src="${png}">`, opts), `<img src="${png}" />`);
  assertEquals(sanitizeHtml(`<img src="${png}">`), `<img />`);
  assertEquals(sanitizeHtml(`<img src="data:image/svg+xml;base64,PHN2Zz4=">`, opts), `<img />`);
  assertEquals(sanitizeHtml(`<a href="${png}">x</a>`, opts), `<a>x</a>`);
  assertEquals(sanitizeHtml(`<img src="data:image/png,<svg>">`, opts), `<img />`);
});

Deno.test('renderMarkdown keeps raw HTML escaped by default and with html: "escape"', () => {
  const md = `Raw <b>x</b> <img src=x onerror=alert(1)>\n\n<div>block</div>`;
  const escaped = `<p>Raw &lt;b&gt;x&lt;/b&gt; &lt;img src=x onerror=alert(1)&gt;</p>\n` +
    `<p>&lt;div&gt;block&lt;/div&gt;</p>`;
  assertEquals(renderMarkdown(md), escaped);
  assertEquals(renderMarkdown(md, { html: "escape" }), escaped);
  // An unknown mode fails safe (escaped).
  assertEquals(renderMarkdown(md, { html: "raw" as never }), escaped);
});

Deno.test("renderMarkdown html: sanitize — inline tags mix with Markdown, code stays literal", () => {
  assertEquals(
    renderMarkdown("Press <kbd>Ctrl</kbd>+<kbd>C</kbd> <img src=x onerror=alert(1)>", S),
    `<p>Press <kbd>Ctrl</kbd>+<kbd>C</kbd> <img src="x" /></p>`,
  );
  assertEquals(
    renderMarkdown("<b>**bold**</b> and `<i>code</i>` and <sub>[l](/x)</sub>", S),
    `<p><b><strong>bold</strong></b> and <code>&lt;i&gt;code&lt;/i&gt;</code> and ` +
      `<sub><a href="/x">l</a></sub></p>`,
  );
  // An autolink-looking `<https://…>` and a bare `<` stay text.
  assertEquals(
    renderMarkdown("a <https://e.x> b < c <3", S),
    `<p>a &lt;https://e.x&gt; b &lt; c &lt;3</p>`,
  );
  // Fenced and indented code keep raw HTML as text.
  assertEquals(
    renderMarkdown("```html\n<b>x</b>\n```\n\n    <i>y</i>", S),
    `<pre class="code" data-lang="html"><code>&lt;b&gt;x&lt;/b&gt;</code></pre>\n` +
      `<pre class="code"><code>&lt;i&gt;y&lt;/i&gt;</code></pre>`,
  );
  // A heading, a table cell, a list item and a footnote take inline HTML too.
  const html = renderMarkdown(
    "## <em>Big</em> news\n\n| a | b |\n|---|---|\n| <kbd>k</kbd> | <script>x</script>y |\n\n" +
      "- <mark>m</mark>\n\nNote[^1]\n\n[^1]: <s>old</s>",
    S,
  );
  assertStringIncludes(html, `<h2 id="big-news"><em>Big</em> news</h2>`);
  assertStringIncludes(html, `<td><kbd>k</kbd></td><td>y</td>`);
  assertStringIncludes(html, `<li><mark>m</mark></li>`);
  assertStringIncludes(html, `<li id="fn-1"><s>old</s> <a href="#fnref-1"`);
  // The renderer's own links keep their attributes; raw ones are rewritten.
  assertEquals(
    renderMarkdown(`[ext](https://e.x) <a href="#top" target="_blank">t</a>`, S),
    `<p><a href="https://e.x" rel="noopener noreferrer" target="_blank">ext</a> ` +
      `<a href="#user-content-top" target="_blank" rel="noopener noreferrer nofollow">t</a></p>`,
  );
});

Deno.test("renderMarkdown html: sanitize — raw HTML can't escape the block it is written in", () => {
  // An inline tag left open is closed at the end of its paragraph; a stray end tag is ignored.
  assertEquals(renderMarkdown("x <b>open\n\ny</b> z", S), `<p>x <b>open</b></p>\n<p>y z</p>`);
  // A raw end tag never closes the renderer's own markup.
  assertEquals(renderMarkdown("**a </strong></p> b**", S), `<p><strong>a  b</strong></p>`);
  // A raw tag crossing Markdown emphasis is closed inside the run.
  assertEquals(renderMarkdown("*a <b>b* c</b>", S), `<p><em>a <b>b</b></em> c</p>`);
  // An HTML block is sanitized on its own and ends at a blank line.
  assertEquals(
    renderMarkdown(`<div align="center">\n  <img src="logo.png" alt="L">\n</div>\n\nafter`, S),
    `<div align="center">\n  <img src="logo.png" alt="L" />\n</div>\n<p>after</p>`,
  );
  assertEquals(
    renderMarkdown("<details>\n<summary>Hi</summary>\n\n**md**\n\n</details>", S),
    `<details>\n<summary>Hi</summary></details>\n<p><strong>md</strong></p>`,
  );
  // Kinds 1–5 run to their end marker across blank lines; comments vanish.
  assertEquals(
    renderMarkdown("<pre>\n<b>a</b>\n\nb\n</pre>\n\n<!-- note\n\nstill -->\n\ntext", S),
    `<pre>\n<b>a</b>\n\nb\n</pre>\n<p>text</p>`,
  );
  assertEquals(renderMarkdown("<script>\nalert(1)\n\n</script>\n\nok", S), `<p>ok</p>`);
  // A block-level tag interrupts a paragraph; a lone inline tag does not.
  assertEquals(
    renderMarkdown("para\n<div>d</div>\n\npara\n<span>s</span>", S),
    `<p>para</p>\n<div>d</div>\n<p>para <span>s</span></p>`,
  );
  assertEquals(renderMarkdown("<span>\nlone\n</span>", S), `<span>\nlone\n</span>`);
});

/** A small seeded PRNG (mulberry32), so a failing fuzz case reproduces. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAGS = [
  "a",
  "img",
  "b",
  "div",
  "p",
  "table",
  "td",
  "details",
  "source",
  "picture",
  "script",
  "SCRIPT",
  "style",
  "svg",
  "math",
  "mtext",
  "mglyph",
  "foreignObject",
  "template",
  "noscript",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "select",
  "option",
  "link",
  "meta",
  "base",
  "svg:script",
  "x-el",
  "noembed",
  "plaintext",
];
const ATTRS = [
  "href",
  "src",
  "srcset",
  "onerror",
  "ONCLICK",
  "onload",
  "style",
  "id",
  "name",
  "class",
  "target",
  "title",
  "xlink:href",
  "formaction",
  "srcdoc",
  "action",
  "cite",
  "alt",
];
const VALUES = [
  "javascript:alert(1)",
  "jav&#x09;ascript:alert(1)",
  "&#106;avascript:alert(1)",
  "java\u0000script:1",
  " JaVaScRiPt:1",
  "javascript&colon;1",
  "vbscript:1",
  "data:text/html,<script>1</script>",
  "data:image/png;base64,AAAA",
  "data:image/svg+xml;base64,AAAA",
  "https://ok.example/a",
  "/rel",
  "#frag",
  'x" onerror="alert(1)',
  "</textarea><img src=x onerror=1>",
  "</noscript><img src=x onerror=1>",
  "_blank",
  "a b, javascript:1 2x",
];
const JUNK = [
  "<",
  ">",
  "/",
  '"',
  "'",
  "`",
  "=",
  "&",
  "&#",
  ";",
  " ",
  "\n",
  "<!--",
  "-->",
  "<![CDATA[",
  "]]>",
  "<?",
  "</",
  "**",
  "`",
  "|",
  "\n\n",
];

function soup(rand: () => number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  let out = "";
  const n = 1 + Math.floor(rand() * 12);
  for (let k = 0; k < n; k++) {
    const r = rand();
    if (r < 0.45) {
      let tag = `<${pick(TAGS)}`;
      const attrs = Math.floor(rand() * 4);
      for (let a = 0; a < attrs; a++) {
        const q = pick(['"', "'", "`", ""]);
        tag += `${pick([" ", "/", "\t", "\n"])}${pick(ATTRS)}=${q}${pick(VALUES)}${q}`;
      }
      out += tag + pick([">", "/>", " >", ""]);
    } else if (r < 0.7) {
      out += `</${pick(TAGS)}>`;
    } else if (r < 0.85) {
      out += pick(JUNK);
    } else {
      out += pick(["text", "x y", "&amp;", "&lt;b&gt;", "**em**", "`code`", "[l](javascript:1)"]);
    }
  }
  return out;
}

Deno.test("sanitizeHtml fuzz: tag/attribute soup parses (deno-dom) with nothing executable", () => {
  const rand = prng(0x5eed);
  for (let k = 0; k < 600; k++) {
    const input = soup(rand);
    const dataImages = k % 3 === 0;
    const out = sanitizeHtml(input, { allowDataImages: dataImages });
    assertSafe(out, ALLOWED, dataImages);
    assertEquals(sanitizeHtml(out, { allowDataImages: dataImages }), out, `idempotent: ${input}`);
    assertSafe(renderMarkdown(input, S), RENDERER);
  }
});

Deno.test("sanitize mode stays linear on pathological input", () => {
  const big = "<a ".repeat(20_000) + " ".repeat(20_000) + "<b>".repeat(20_000) +
    "</i>".repeat(20_000);
  const t0 = performance.now();
  sanitizeHtml(big);
  renderMarkdown(big, S);
  renderMarkdown("<div " + "a ".repeat(20_000), S);
  assert(performance.now() - t0 < 5_000, "sanitizing stays fast");
});
