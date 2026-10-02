// Pure helpers behind `scripts/gen-docs-corpus.ts` (the `denext_search_docs` /
// `denext_read_docs` corpus): Markdown chunking by heading, a VNode → Markdown walker for the
// docs pages written in JSX, the CHANGELOG slice, and the source fingerprint the staleness test
// (tests/mcp-docs-corpus.test.ts) recomputes. Kept free of top-level side effects so the test
// can import it.

import { publicGuide } from "../../src/mcp/guide.ts";
import { DOC_URLS } from "../../apps/web/lib/docs-map.ts";
import {
  parseFrontmatter,
  splitLeadingH1,
  stripLeadingRawHtml,
} from "../../apps/web/lib/markdown.ts";

/** One docs-site page (or root guide) in the corpus. */
export interface CorpusPage {
  /** The route segment (`desktop` for /docs/desktop) or a pseudo-slug (`agents`, `readme`). */
  slug: string;
  title: string;
  lead?: string;
  /** Set only when the page is NOT served at `/docs/<slug>` (a GitHub URL). */
  url?: string;
}

/** One heading-delimited section of a page. */
export interface GuideChunk {
  /** `doc:<slug>` for the intro, `doc:<slug>#<anchor>` for a section (de-duplicated). */
  id: string;
  kind: "guide";
  /** The owning page's slug. */
  page: string;
  /** The section heading ("" for the intro, which takes the page title). */
  title: string;
  /** The site's heading anchor (the `id=` the renderer emits); "" for the intro. */
  anchor: string;
  /** 1 = intro, 2 = h2, 3 = h3. */
  level: number;
  /** The section body as Markdown (its heading included). */
  text: string;
}

/** A heading-delimited Markdown section before it is attached to a page. */
export interface MdSection {
  title: string;
  anchor: string;
  level: number;
  text: string;
}

/**
 * The docs renderer's heading anchor (packages/content-collections/markdown.ts `slugify`, which
 * the JSX TOC in apps/web/lib/toc.ts mirrors): lower-case, tags and punctuation dropped, one
 * hyphen per whitespace character (runs are NOT collapsed, matching GitHub).
 */
export function anchorOf(text: string): string {
  return text.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w\s-]/g, "").trim()
    .replace(/\s/g, "-");
}

/** An explicit `{#id}` suffix on a heading line (emitted by the JSX walker for `<h2 id>`). */
const EXPLICIT_ID = /\s*\{#([^}\s]+)\}\s*$/;

/** Parse one line as an h2/h3 heading, or `null` (h1 and h4+ stay in the body). */
function headingOf(line: string): { level: number; title: string; anchor: string } | null {
  const m = line.match(/^(#{2,3})\s+(.*)$/);
  if (!m) return null;
  const raw = m[2].trim();
  const explicit = raw.match(EXPLICIT_ID);
  const title = explicit ? raw.slice(0, explicit.index).trim() : raw;
  return { level: m[1].length, title, anchor: explicit ? explicit[1] : anchorOf(title) };
}

/** A fence opener/closer (``` or ~~~, any length ≥ 3) — headings inside fences are code. */
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Split Markdown into an intro (before the first h2/h3, `level` 1) plus one section per h2/h3.
 * Headings inside fenced code are ignored; an empty intro is dropped.
 */
export function chunkMarkdown(md: string): MdSection[] {
  const out: MdSection[] = [];
  let cur: MdSection = { title: "", anchor: "", level: 1, text: "" };
  const lines: string[] = [];
  let fence = "";
  const flush = () => {
    cur.text = lines.join("\n").trim();
    if (cur.text || cur.level > 1) out.push(cur);
    lines.length = 0;
  };
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    const f = line.match(FENCE);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = "";
    }
    const h = fence || f ? null : headingOf(line);
    if (h) {
      flush();
      cur = { ...h, text: "" };
      lines.push(`${"#".repeat(h.level)} ${h.title}`);
      continue;
    }
    lines.push(line);
  }
  flush();
  return out;
}

/** Attach a page's sections to it: ids, de-duplicated anchors (`-2`, `-3` … in the id only). */
export function pageChunks(slug: string, sections: MdSection[]): GuideChunk[] {
  const seen = new Map<string, number>();
  return sections.map((s) => {
    let key = s.anchor;
    if (key) {
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n > 1) key = `${key}-${n}`;
    }
    return {
      id: key ? `doc:${slug}#${key}` : `doc:${slug}`,
      kind: "guide" as const,
      page: slug,
      title: s.title,
      anchor: s.anchor,
      level: s.level,
      text: s.text,
    };
  });
}

// ---------- repo-relative links → docs routes ----------

const GITHUB_BLOB = "https://github.com/Brainwires/denext/blob/main";

/** Rewrite `](./KNOWN-LIMITATIONS.md#x)` links in a ROOT Markdown file to docs routes/GitHub. */
export function rewriteRootLinks(md: string): string {
  return md.replace(/\]\((?:\.\/)?([A-Za-z0-9_./-]+?\.md)(#[^)\s]*)?\)/g, (m, path, hash) => {
    if (/^[a-z]+:/i.test(path) || path.startsWith("/") || path.startsWith("..")) return m;
    const mapped = DOC_URLS[path];
    return `](${mapped ?? `${GITHUB_BLOB}/${path}`}${hash ?? ""})`;
  });
}

// ---------- Markdown sources ----------

/** A docs page authored in Markdown (`content.md`, frontmatter title/lead). */
export function contentMdPage(slug: string, src: string): { page: CorpusPage; md: string } {
  const { frontmatter, body } = parseFrontmatter(src);
  let md = stripLeadingRawHtml(body);
  let title = frontmatter.title;
  if (title === undefined) {
    const split = splitLeadingH1(md);
    title = split.title;
    md = split.body;
  }
  return { page: { slug, title: title ?? slug, lead: frontmatter.lead || undefined }, md };
}

/** A root guide (FEATURES.md, …) the site renders verbatim: its H1 is the title. */
export function rootMdPage(
  slug: string,
  src: string,
  opts: { title?: string; lead?: string; url?: string } = {},
): { page: CorpusPage; md: string } {
  const split = splitLeadingH1(stripLeadingRawHtml(src.replace(/\r\n/g, "\n")));
  const page: CorpusPage = { slug, title: opts.title ?? split.title ?? slug };
  if (opts.lead) page.lead = opts.lead;
  if (opts.url) page.url = opts.url;
  return { page, md: rewriteRootLinks(split.body) };
}

/** The AI-authoring guide (AGENTS.md minus its repo-process tail). */
export function agentsSource(agentsMd: string): string {
  return publicGuide(agentsMd);
}

/** Cap on the CHANGELOG slice kept in the corpus (released versions, newest first). */
export const CHANGELOG_BUDGET = 64 * 1024;

/**
 * The CHANGELOG slice the corpus keeps: the intro plus the newest RELEASED versions until
 * {@link CHANGELOG_BUDGET} is spent (always at least one). `[Unreleased]` is left out — it churns
 * on every commit and its features are documented on the guide pages.
 */
export function changelogSlice(src: string): string {
  const text = src.replace(/\r\n/g, "\n").replace(/^# Changelog\s*\n/, "");
  const parts = text.split(/\n(?=## )/);
  const intro = parts[0].startsWith("## ") ? "" : parts.shift()!;
  const kept: string[] = [];
  let size = 0;
  for (const p of parts) {
    if (/^## \[?Unreleased\]?/i.test(p)) continue;
    if (kept.length > 0 && size + p.length > CHANGELOG_BUDGET) break;
    kept.push(p.trimEnd());
    size += p.length;
  }
  return [intro.trim(), ...kept].filter(Boolean).join("\n\n") + "\n";
}

// ---------- VNode → Markdown (docs pages written in JSX) ----------

// deno-lint-ignore no-explicit-any
type Any = any;

const FRAGMENT = Symbol.for("denext.fragment");

/** Components the walker renders itself instead of calling (see `special`). */
export interface WalkHooks {
  /** `DocsShell`: its `title`/`lead` are captured and only its children are rendered. */
  shell?: unknown;
  /** `Code`: a fenced code block from its string child + `lang`. */
  code?: unknown;
  /** `Callout`: a blockquote. */
  callout?: unknown;
}

/** What the walk of one page produced. */
export interface WalkResult {
  title?: string;
  lead?: string;
  md: string;
}

const isVNode = (n: unknown): n is { type: Any; props: Any } =>
  typeof n === "object" && n !== null && "type" in n && "props" in n;

const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "figure",
  "figcaption",
  "details",
  "summary",
  "dl",
  "dt",
  "dd",
  "form",
  "nav",
]);

/** Interactive / embedded elements that carry no prose. */
const SKIP = new Set(["script", "style", "input", "button", "label", "svg", "video", "iframe"]);

/** Visible text of a subtree (for heading anchors and table cells). */
function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isVNode(node)) return textOf(node.props?.children);
  return "";
}

/** Inline code with a fence long enough for any backticks inside it. */
function inlineCode(s: string): string {
  const runs = s.match(/`+/g) ?? [];
  const n = runs.reduce((m, r) => Math.max(m, r.length), 0) + 1;
  const tick = "`".repeat(n);
  return n > 1 ? `${tick} ${s} ${tick}` : `${tick}${s}${tick}`;
}

/** Fenced code with a fence longer than any run of backticks inside it. */
function fenced(code: string, lang = ""): string {
  const runs = code.match(/`{3,}/g) ?? [];
  const n = Math.max(3, ...runs.map((r) => r.length + 1));
  const fence = "`".repeat(n);
  return `\n\n${fence}${lang}\n${code.replace(/\n+$/, "")}\n${fence}\n\n`;
}

/** Prefix every line of a block (list continuation indent, blockquote marker). */
function indent(s: string, first: string, rest: string): string {
  return s.split("\n").map((l, i) => (i === 0 ? first : l ? rest : rest.trimEnd()) + l).join("\n");
}

/** Collapse runs of blank lines and trim. */
function tidy(s: string): string {
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Walks a rendered docs page's VNode tree to Markdown. Function components are CALLED (awaited
 * when async) exactly as the server renderer would, so content computed at render time —
 * `.map()` over a JSON registry, shared constants, helper components — comes out as the page
 * shows it. The three docs-shell primitives are recognised by identity (see {@link WalkHooks}).
 */
export class VNodeMarkdown {
  title?: string;
  lead?: string;
  constructor(private hooks: WalkHooks) {}

  /** Render a page element tree to Markdown. */
  async page(node: unknown): Promise<WalkResult> {
    const md = tidy(await this.block(node));
    return { title: this.title, lead: this.lead, md };
  }

  private async block(node: unknown): Promise<string> {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) {
      let s = "";
      for (const c of node) s += await this.block(c);
      return s;
    }
    if (node instanceof Promise) return this.block(await node);
    if (!isVNode(node)) return "";
    return await this.element(node.type, node.props ?? {});
  }

  private children(props: Any): Promise<string> {
    return this.block(props.children);
  }

  private async element(type: Any, props: Any): Promise<string> {
    if (type === FRAGMENT) return this.children(props);
    if (typeof type === "function") return await this.component(type, props);
    if (typeof type !== "string") return this.children(props);
    return await this.intrinsic(type, props);
  }

  private async component(type: Any, props: Any): Promise<string> {
    if (type === this.hooks.shell) {
      this.title ??= typeof props.title === "string" ? props.title : undefined;
      this.lead ??= typeof props.lead === "string" ? props.lead : undefined;
      return this.children(props);
    }
    if (type === this.hooks.code) return fenced(textOf(props.children), props.lang ?? "");
    if (type === this.hooks.callout) {
      const body = tidy(await this.children(props));
      const label = props.kind === "warn" ? "**Warning:** " : "";
      return `\n\n${indent(label + body, "> ", "> ")}\n\n`;
    }
    // A class component (not used by the docs) or a plain function component.
    if (type.prototype?.render) return "";
    return this.block(await type(props));
  }

  /** Per-tag Markdown for the intrinsic elements that are not plain containers. */
  private readonly tags: Record<string, (tag: string, props: Any) => string | Promise<string>> = {
    h1: (t, p) => this.heading(t, p),
    h2: (t, p) => this.heading(t, p),
    h3: (t, p) => this.heading(t, p),
    h4: (t, p) => this.heading(t, p),
    h5: (t, p) => this.heading(t, p),
    h6: (t, p) => this.heading(t, p),
    code: (_t, p) => inlineCode(textOf(p.children)),
    kbd: (_t, p) => inlineCode(textOf(p.children)),
    samp: (_t, p) => inlineCode(textOf(p.children)),
    pre: (_t, p) => fenced(textOf(p.children), p["data-lang"] ?? ""),
    strong: (_t, p) => this.wrap("**", p),
    b: (_t, p) => this.wrap("**", p),
    em: (_t, p) => this.wrap("*", p),
    i: (_t, p) => this.wrap("*", p),
    a: (_t, p) => this.link(p),
    br: () => "  \n",
    hr: () => "\n\n---\n\n",
    img: (_t, p) => (p.alt ? `![${p.alt}](${p.src ?? ""})` : ""),
    ul: (_t, p) => this.list(false, p.children),
    ol: (_t, p) => this.list(true, p.children),
    table: (_t, p) => this.table(p),
  };

  private async intrinsic(tag: string, props: Any): Promise<string> {
    const handler = this.tags[tag];
    if (handler) return await handler(tag, props);
    if (SKIP.has(tag)) return "";
    const html = props.dangerouslySetInnerHTML?.__html;
    if (html) return `\n\n${String(html).replace(/<[^>]+>/g, "")}\n\n`;
    const inner = await this.children(props);
    return BLOCK.has(tag) ? `\n\n${inner}\n\n` : inner;
  }

  private async wrap(mark: string, props: Any): Promise<string> {
    return `${mark}${(await this.children(props)).trim()}${mark}`;
  }

  private async link(props: Any): Promise<string> {
    const text = (await this.children(props)).trim();
    const href = typeof props.href === "string" ? props.href : "";
    return href && text ? `[${text}](${href})` : text;
  }

  private async heading(tag: string, props: Any): Promise<string> {
    const level = Number(tag[1]);
    const text = (await this.children(props)).replace(/\s+/g, " ").trim();
    const plain = textOf(props.children).replace(/\s+/g, " ").trim();
    // h2/h3 carry the anchor the site emits: the explicit `id`, else the TOC's slug of the
    // visible text (apps/web/lib/toc.ts) — written as `{#id}` so the chunker keeps it exact.
    const id = typeof props.id === "string" && props.id ? props.id : anchorOf(plain);
    const suffix = level === 2 || level === 3 ? ` {#${id}}` : "";
    return `\n\n${"#".repeat(level)} ${text}${suffix}\n\n`;
  }

  private async list(ordered: boolean, children: unknown): Promise<string> {
    const items = await this.listItems(children);
    const lines: string[] = [];
    let n = 1;
    for (const li of items as { props: Any }[]) {
      const body = tidy(await this.children(li.props ?? {}));
      const marker = ordered ? `${n++}. ` : "- ";
      lines.push(indent(body, marker, " ".repeat(marker.length)));
    }
    return `\n\n${lines.join("\n")}\n\n`;
  }

  /** The `<li>`s under a list, through arrays, fragments, promises and helper components. */
  private async listItems(node: unknown): Promise<{ props: Any }[]> {
    if (node instanceof Promise) return this.listItems(await node);
    if (Array.isArray(node)) {
      const out: { props: Any }[] = [];
      for (const c of node) out.push(...await this.listItems(c));
      return out;
    }
    if (!isVNode(node)) return [];
    if (node.type === "li") return [node];
    if (node.type === FRAGMENT) return this.listItems(node.props?.children);
    if (typeof node.type === "function" && !node.type.prototype?.render) {
      return this.listItems(await node.type(node.props ?? {}));
    }
    return [];
  }

  private async table(props: Any): Promise<string> {
    const rows: { head: boolean; cells: string[] }[] = [];
    const visit = async (node: unknown, head: boolean): Promise<void> => {
      if (Array.isArray(node)) {
        for (const c of node) await visit(c, head);
        return;
      }
      if (!isVNode(node)) return;
      if (node.type === "thead") return visit(node.props?.children, true);
      if (node.type === "tr") {
        const cells: string[] = [];
        const kids = [node.props?.children].flat(Infinity).filter(isVNode);
        for (const td of kids) {
          const cell = tidy(await this.children(td.props ?? {}));
          cells.push(cell.replace(/\n+/g, " ").replace(/\|/g, "\\|"));
        }
        rows.push({ head: head || kids.some((k) => k.type === "th"), cells });
        return;
      }
      return visit(node.props?.children, head);
    };
    await visit(props.children, false);
    if (rows.length === 0) return "";
    const width = Math.max(...rows.map((r) => r.cells.length));
    const line = (c: string[]) => `| ${[...c, ...Array(width - c.length).fill("")].join(" | ")} |`;
    const head = rows[0].head ? rows.shift()!.cells : Array(width).fill("");
    const body = rows.map((r) => line(r.cells));
    return `\n\n${[line(head), line(Array(width).fill("---")), ...body].join("\n")}\n\n`;
  }
}

// ---------- the source fingerprint (staleness guard) ----------

/** One input file of the corpus, as hashed. */
export interface CorpusInput {
  path: string;
  text: string;
}

/** Hex SHA-256 over every input (path + newline-normalized text), in path order. */
export async function fingerprint(inputs: CorpusInput[]): Promise<string> {
  const sorted = [...inputs].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const enc = new TextEncoder();
  const parts = sorted.map((i) => `${i.path}\n${i.text.replace(/\r\n/g, "\n")}\n\0`);
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(parts.join("")));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
