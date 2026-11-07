---
title: Markdown (denext/markdown)
slug: markdown
lead: denext/markdown renders Markdown with denext's own first-party renderer. renderMarkdown returns an HTML string, and <Markdown> renders elements an app can swap for its own components. Raw HTML is escaped by default, and script URLs are dropped.
---

`denext/markdown` is the renderer [Content collections](/docs/content-collections) use for `.md`
entries, available to any app. It is first-party and has no dependencies (no marked or remark at
request time), and an app that does not import it ships none of it. It has no hooks, so it renders
in a Server Component and in a `"use client"` component alike.

```ts
import { Markdown, renderMarkdown } from "denext/markdown";
```

## HTML: `renderMarkdown`

```ts
import { renderMarkdown } from "denext/markdown";

renderMarkdown("# Hello *world*\n\nSee [the docs](/docs).");
// '<h1 id="hello-world">Hello <em>world</em></h1>\n<p>See <a href="/docs">the docs</a>.</p>'
```

It covers the constructs content typically uses: headings with GitHub-style ids, paragraphs,
ordered and unordered lists (nested, with lazy continuation), fenced and indented code, code spans,
blockquotes and GitHub `> [!NOTE]` / `> [!WARNING]` callouts, GFM pipe tables with column
alignment, inline and reference-style links and images, GFM footnotes, emphasis and rules. It is
not a full CommonMark engine: GFM task lists, `~~strikethrough~~` and bare-URL autolinks are not
recognized (they render as written).

To put the string in a page, pass it to `dangerouslySetInnerHTML`, or use `<Markdown>` below,
which needs no HTML string at all.

## Elements: `<Markdown>`

`<Markdown>` renders the same document as denext elements. `components` swaps any element for
your own component, keyed by the tag the HTML renderer writes:

```tsx
// app/blog/[slug]/page.tsx
import { Link } from "denext";
import { Markdown, type MarkdownCodeProps, type MarkdownElementProps } from "denext/markdown";
import { Highlight } from "../../highlight.tsx";

function SiteLink({ href, children }: MarkdownElementProps) {
  return <Link href={String(href)}>{children}</Link>;
}

function Code({ inline, lang, children }: MarkdownCodeProps) {
  return inline ? <code>{children}</code> : <Highlight lang={lang}>{children}</Highlight>;
}

export default async function Post({ params }) {
  const post = await getPost((await params).slug);
  return <Markdown source={post.body} components={{ a: SiteLink, code: Code, h1: "h2" }} />;
}
```

- An override receives the element's attributes in React spelling (`className`, `htmlFor`,
  `href`, `id`, `src`, `alt`, a boolean `open`) and its rendered `children`.
- A `code` override also receives `inline` (`true` for a code span, `false` inside a `pre`) and
  `lang`, a fenced block's info string (`` ```ts `` → `"ts"`).
- A string renames the element (`{ h1: "h2" }`).
- Every option of `renderMarkdown` is a prop (`html`, `headingIds`, `allowDataImages`,
  `urlPolicy`, `sanitize`).

The document is rendered exactly as `renderMarkdown` renders it, with the same escaping and URL
rules, then built as elements: text is passed as text children, never injected as HTML. An
override only sees what the HTML would carry, so a component can't receive a URL the renderer
refused.

The elements to know: `h1`–`h6`, `p`, `a`, `img`, `em`, `strong`, `code`, `pre` (a fenced block
carries `className="code"` and `data-lang`), `ul`, `ol`, `li`, `blockquote`, `aside` (a callout:
`className="callout note"` or `"callout warn"`), `div` (`className="table-wrap"` around a table),
`table`, `thead`, `tbody`, `tr`, `th`, `td` (`className="align-left|center|right"`), `hr`, `sup`
(footnote references) and `section` (`className="footnotes"`).

## Safety

Markdown is often written by someone other than the app's author, so the defaults assume it is
untrusted:

- **Raw HTML is escaped.** `<b>hi</b>` in the source renders as the text `<b>hi</b>`.
- **Script URLs are dropped.** A link or image whose URL has a `javascript:`, `vbscript:`,
  `livescript:` or `data:` scheme renders as its label or alt text. The check runs after entity
  decoding and with control characters removed, so `&#106;avascript:` and `java&#09;script:` are
  caught too, and a destination containing whitespace or a control character is refused.
- **Attributes can't be forged.** A link's tags are built apart from its label, every attribute
  value is escaped, and the renderer's internal marker characters are stripped from the source, so
  a crafted label or destination can't add attributes such as `onfocus` (the fix for
  [GHSA-3q88-358h-83j3](https://github.com/Brainwires/denext/security/advisories/GHSA-3q88-358h-83j3)).
- **External links** (`http:` / `https:`) get `rel="noopener noreferrer" target="_blank"`.

### Raw HTML, sanitized (opt-in)

`html: "sanitize"` keeps the raw HTML that passes a first-party allowlist sanitizer instead of
escaping it. The HTML is parsed into a tree and re-serialized from it, never passed through:
GitHub's element set survives (`kbd`, `details` / `summary`, `sub` / `sup`, tables, `img`, …),
while `script`, `style`, `iframe`, `object`, form controls, `svg`, `math`, `on*` handlers,
`style`, `srcdoc` and `xlink:*` never do. `sanitize` adds to the allowlist (it can't allow a
denied element or attribute), and `sanitizeHtml(html, options)` runs the sanitizer on its own.
[Content collections](/docs/content-collections#raw-html-in-markdown-opt-in) describes the rules
in full.

```ts
renderMarkdown("Press <kbd>Ctrl</kbd> <img src=x onerror=alert(1)>", { html: "sanitize" });
// '<p>Press <kbd>Ctrl</kbd> <img src="x" /></p>'
```

### URL policy

`urlPolicy(url, kind)` is a further check on every link (`kind: "link"`) and image
(`kind: "image"`) URL, run after the built-in refusal. It can refuse more but can't allow a script
URL. Return `false` to drop the link (its label stays) or the image (its alt text stays):

```ts
// Only same-site links and images:
renderMarkdown(comment, { urlPolicy: (url) => url.startsWith("/") && !url.startsWith("//") });
```

`allowDataImages: true` keeps a Markdown image whose source is a base64 raster `data:` URL
(`data:image/png|gif|jpeg|webp;base64,…`). An SVG `data:` image, or a `data:` link, is still
refused. For raw `<img>` tags under `html: "sanitize"`, the same switch is
`sanitize: { allowDataImages: true }`.

## Options

| Option            | Default    | What it does                                                   |
| ----------------- | ---------- | -------------------------------------------------------------- |
| `html`            | `"escape"` | `"sanitize"` keeps allowlisted raw HTML instead of escaping it |
| `sanitize`        | —          | With `html: "sanitize"`: additions to the allowlist            |
| `headingIds`      | `true`     | `false` leaves headings without the slugged `id`               |
| `allowDataImages` | `false`    | Keep base64 raster `data:` images (never SVG, never on links)  |
| `urlPolicy`       | —          | `(url, kind) => boolean`: refuse more links and images         |
