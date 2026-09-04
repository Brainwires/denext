// Post-export SEO + "markdown for agents", run over out/ after `deno task export`.
//
//   deno task seo        # (invoked by the root `docs:build` task)
//
// For every exported page it:
//   1. Injects <link rel="canonical"> + per-page og:/twitter: title/description/url into
//      <head> (denext emits the static og:image/type/site_name from the layout; the
//      per-page bits are derived here from the page's own <title>/<meta description>).
//   2. Writes a Markdown sibling (index.md) — YAML frontmatter + body markdown + any
//      JSON-LD in fenced blocks — so AI agents get clean markdown at the SAME URL via
//      `Accept: text/markdown` (served by nginx, see deploy/nginx-markdown.conf). This is
//      Cloudflare "markdown for agents" convention, provided from our own origin.
//   3. Collects URLs for sitemap.xml, and writes robots.txt.
//
// This file lives under apps/web (outside the framework test/lint gate) so it can be a
// straightforward build tool.

import { DOMParser, type Element, type Node } from "deno-dom";

// The canonical production origin (keep in sync with app/layout.tsx SITE_ORIGIN).
const ORIGIN = "https://denext.dev";
const OUT = new URL("../out", import.meta.url).pathname;
const OG_IMAGE = `${ORIGIN}/og.png`;

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

// ---------- small helpers ----------

const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(
    /"/g,
    "&quot;",
  );
const collapseWs = (s: string) => s.replace(/\s+/g, " ");

/** out/ file path → the site path it is served at (out/docs/x/index.html → /docs/x). */
function urlPathFor(fileAbs: string): string {
  let rel = fileAbs.slice(OUT.length).replace(/\\/g, "/"); // "/docs/x/index.html"
  rel = rel.replace(/\/index\.html$/, "").replace(/\.html$/, "");
  return rel === "" ? "/" : rel;
}

async function* walkHtml(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walkHtml(p);
    else if (entry.isFile && entry.name.endsWith(".html")) yield p;
  }
}

// ---------- HTML → Markdown (our known, small tag vocabulary) ----------

// The content root is scoped to `.article`/`main`, so the layout's topbar/footer never
// appear here — no need to skip `header`/`footer` (and the article's own <header> carries
// the page title + lead, which we DO want).
const SKIP_TAGS = new Set([
  "NAV",
  "ASIDE",
  "SCRIPT",
  "STYLE",
  "SVG",
  "FORM",
  "BUTTON",
  "INPUT",
  "LABEL",
]);
const CONTAINERS = new Set([
  "DIV",
  "SECTION",
  "ARTICLE",
  "MAIN",
  "SPAN",
  "HEADER",
  "FOOTER",
]);

const childNodes = (n: Node): Node[] => Array.from(n.childNodes as unknown as Node[]);
const isEl = (n: Node): n is Element => n.nodeType === ELEMENT_NODE;
const tag = (n: Element) => n.tagName.toUpperCase();

/** Inline markdown for a node's content (text, code, links, emphasis). */
function inline(node: Node): string {
  if (node.nodeType === TEXT_NODE) return collapseWs(node.nodeValue ?? "");
  if (!isEl(node)) return "";
  const el = node;
  const inner = () => childNodes(el).map(inline).join("");
  // Class-aware tidy-ups for the API pages, whose inline chips carry no whitespace between
  // them (they're laid out with flex gaps): drop the kind/denext-only chips, and give the
  // list summary an em-dash separator so a row reads "[name](url) — summary".
  const cls = el.getAttribute?.("class") ?? "";
  if (/\bapi-(kind|only)\b/.test(cls)) return "";
  if (/\bapi-list-doc\b/.test(cls)) return ` — ${inner().trim()}`;
  switch (tag(el)) {
    case "CODE":
      return `\`${(el.textContent ?? "").trim()}\``;
    case "A": {
      const href = el.getAttribute("href") ?? "";
      const abs = href.startsWith("/") ? ORIGIN + href : href;
      return `[${inner().trim()}](${abs})`;
    }
    case "STRONG":
    case "B":
      return `**${inner().trim()}**`;
    case "EM":
    case "I":
      return `*${inner().trim()}*`;
    case "BR":
      return "\n";
    default:
      return inner();
  }
}

/** A `<ul>`/`<ol>` → a markdown list (nested lists indented two spaces). */
function list(el: Element, ordered: boolean): string {
  const lines: string[] = [];
  let i = 1;
  for (const li of childNodes(el)) {
    if (!isEl(li) || tag(li) !== "LI") continue;
    const marker = ordered ? `${i++}. ` : "- ";
    const nested: string[] = [];
    const inlineParts: string[] = [];
    for (const c of childNodes(li)) {
      if (isEl(c) && (tag(c) === "UL" || tag(c) === "OL")) {
        nested.push(list(c, tag(c) === "OL"));
      } else {
        inlineParts.push(inline(c));
      }
    }
    lines.push(marker + collapseWs(inlineParts.join("")).trim());
    for (const nest of nested) {
      lines.push(nest.split("\n").map((l) => "  " + l).join("\n"));
    }
  }
  return lines.join("\n");
}

/** A `<dl>` (API params/returns) → bolded term + its definition. */
function defList(el: Element): string {
  const out: string[] = [];
  let term = "";
  for (const c of childNodes(el)) {
    if (!isEl(c)) continue;
    if (tag(c) === "DT") term = inline(c).trim();
    else if (tag(c) === "DD") {
      out.push(`- **${term}** — ${collapseWs(inline(c)).trim()}`);
    } else if (tag(c) === "DIV") out.push(defList(c)); // rows wrapped in a div
  }
  return out.filter(Boolean).join("\n");
}

/** Block-level markdown for a container's children, as separate blocks. */
function blocks(node: Node): string[] {
  const out: string[] = [];
  for (const c of childNodes(node)) {
    if (c.nodeType === TEXT_NODE) {
      const t = collapseWs(c.nodeValue ?? "").trim();
      if (t) out.push(t);
      continue;
    }
    if (!isEl(c)) continue;
    const t = tag(c);
    if (SKIP_TAGS.has(t)) continue;
    if (/^H[1-6]$/.test(t)) {
      out.push("#".repeat(Number(t[1])) + " " + inline(c).trim());
    } else if (t === "P") {
      const s = collapseWs(inline(c)).trim();
      if (s) out.push(s);
    } else if (t === "PRE") {
      const code = c.querySelector("code") ?? c;
      const lang = c.getAttribute("data-lang") ??
        code.getAttribute?.("data-lang") ?? "";
      out.push(
        "```" + lang + "\n" + (code.textContent ?? "").replace(/\n$/, "") +
          "\n```",
      );
    } else if (t === "UL" || t === "OL") {
      out.push(list(c, t === "OL"));
    } else if (t === "DL") {
      out.push(defList(c));
    } else if (t === "BLOCKQUOTE") {
      out.push(
        blocks(c).join("\n\n").split("\n").map((l) => "> " + l).join("\n"),
      );
    } else if (t === "HR") {
      out.push("---");
    } else if (CONTAINERS.has(t)) {
      out.push(...blocks(c)); // recurse into wrappers
    } else {
      const s = collapseWs(inline(c)).trim();
      if (s) out.push(s);
    }
  }
  return out;
}

// ---------- per-page processing ----------

interface PageInfo {
  url: string;
  title: string;
}

function headInjection(url: string, title: string, desc: string): string {
  const t = escAttr(title);
  const d = escAttr(desc);
  return [
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:title" content="${t}">`,
    desc ? `<meta property="og:description" content="${d}">` : "",
    `<meta property="og:url" content="${url}">`,
    `<meta name="twitter:title" content="${t}">`,
    desc ? `<meta name="twitter:description" content="${d}">` : "",
  ].filter(Boolean).join("\n");
}

function toMarkdown(doc: ReturnType<DOMParser["parseFromString"]>, meta: {
  title: string;
  description: string;
  url: string;
}): string {
  const root = doc!.querySelector(".article") ?? doc!.querySelector("main") ??
    doc!.body;
  const body = blocks(root as unknown as Node).filter(Boolean).join("\n\n");
  const jsonLd = Array.from(
    doc!.querySelectorAll('script[type="application/ld+json"]'),
  )
    .map((s) => (s.textContent ?? "").trim())
    .filter(Boolean);

  const fm = [
    "---",
    `title: ${JSON.stringify(meta.title)}`,
    `description: ${JSON.stringify(meta.description)}`,
    `url: ${meta.url}`,
    `image: ${OG_IMAGE}`,
    "---",
  ].join("\n");

  let out = `${fm}\n\n${body}\n`;
  if (jsonLd.length) {
    out += "\n" + jsonLd.map((j) => "```json\n" + j + "\n```").join("\n\n") +
      "\n";
  }
  return out;
}

async function processPage(fileAbs: string): Promise<PageInfo | null> {
  const html = await Deno.readTextFile(fileAbs);
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return null;

  const url = ORIGIN + urlPathFor(fileAbs);
  const title = (doc.querySelector("title")?.textContent ?? "").trim();
  const description = (doc.querySelector('meta[name="description"]')?.getAttribute("content") ??
    "")
    .trim();

  // 1) inject canonical + per-page og/twitter (idempotent).
  if (!html.includes('rel="canonical"')) {
    const injected = html.replace(
      /<\/head>/i,
      `${headInjection(url, title, description)}\n</head>`,
    );
    await Deno.writeTextFile(fileAbs, injected);
  }

  // 2) markdown, written two ways so agents can reach it however they ask:
  //    - `<dir>/index.md`  — served at the SAME url via `Accept: text/markdown` (nginx).
  //    - `<dir>.md`        — the append-`.md` convention (e.g. /docs/routing.md), a plain
  //                          static file that needs no server config.
  const md = toMarkdown(doc, { title, description, url });
  await Deno.writeTextFile(fileAbs.replace(/\.html$/, ".md"), md);
  const path = urlPathFor(fileAbs);
  if (path !== "/") {
    const flat = fileAbs.replace(/\/index\.html$/, ".md");
    if (flat !== fileAbs) await Deno.writeTextFile(flat, md);
  }

  return { url, title };
}

// ---------- sitemap + robots ----------

function serializeSitemap(pages: PageInfo[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const urls = pages
    .map((p) => p.url)
    .sort()
    .map((u) => {
      const priority = u === `${ORIGIN}/` ? "1.0" : u.includes("/docs/api/") ? "0.6" : "0.8";
      return `  <url><loc>${escAttr(u)}</loc><lastmod>${today}</lastmod>` +
        `<changefreq>weekly</changefreq><priority>${priority}</priority></url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

const ROBOTS = `# denext.dev
User-agent: *
Allow: /

Sitemap: ${ORIGIN}/sitemap.xml
`;

// ---------- run ----------

const pages: PageInfo[] = [];
for await (const file of walkHtml(OUT)) {
  const info = await processPage(file);
  if (info) pages.push(info);
}
await Deno.writeTextFile(`${OUT}/sitemap.xml`, serializeSitemap(pages));
await Deno.writeTextFile(`${OUT}/robots.txt`, ROBOTS);

console.log(
  `seo: ${pages.length} pages — canonical+og injected, .md emitted, sitemap.xml + robots.txt written`,
);
