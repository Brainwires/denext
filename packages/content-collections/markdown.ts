/**
 * `@denext/content-collections/markdown` — a small, first-party, zero-dependency Markdown
 * renderer: the `.md` half of {@link "./runtime.ts" | `renderContent`}.
 *
 * Deliberately NOT a full CommonMark engine — it covers the block and inline constructs typical
 * content uses (headings with ids, paragraphs, ordered/unordered lists with lazy continuation and
 * nesting, fenced and indented code, blockquotes and GitHub-style `> [!NOTE]` callouts, GFM pipe
 * tables, inline and reference-style links and images, GFM footnotes, emphasis, code spans of any
 * backtick-run length, rules). Owning these few hundred lines keeps the zero-npm runtime intact
 * (no marked/remark stack at request time); a document that needs components is an `.mdx` entry,
 * compiled at build. Every text run is HTML-escaped before any markup is emitted and raw HTML in
 * the source is escaped, not passed through; link and image targets are attribute-escaped and
 * `javascript:`/`vbscript:`/`data:` URLs are dropped (an image keeps its alt text).
 *
 * Opt-in raw HTML: `renderMarkdown(body, { html: "sanitize" })` keeps raw HTML that passes a
 * first-party allowlist sanitizer ({@linkcode sanitizeHtml}): the HTML is parsed into a tree and
 * re-serialized from it (never passed through), so only allowlisted elements and attributes,
 * scheme-checked URLs and escaped text come out. A block container (`<details>`, `<div>`, …) an
 * HTML block leaves open wraps the Markdown blocks after it until a later HTML block closes it;
 * every other element is closed inside the block it was written in.
 *
 * @module
 */

import {
  closeCarried,
  type MarkdownHtmlMode,
  mergeRawInline,
  rawMarker,
  resolveSanitizePolicy,
  sanitizeBlock,
  SanitizeDocument,
  type SanitizeOptions,
  scanInlineHtml,
  ScanMemo,
} from "./html-sanitize.ts";

export { sanitizeHtml } from "./html-sanitize.ts";
export type { MarkdownHtmlMode, SanitizeOptions } from "./html-sanitize.ts";

/** Options for {@linkcode renderMarkdown}. */
export interface MarkdownOptions {
  /**
   * Raw HTML in the source: `"escape"` (the default) shows it as text; `"sanitize"` keeps what
   * the allowlist sanitizer allows (see {@linkcode sanitizeHtml}) and drops the rest.
   */
  readonly html?: MarkdownHtmlMode;
  /** With `html: "sanitize"`: additions to the sanitizer's built-in allowlist. */
  readonly sanitize?: SanitizeOptions;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Attribute-safe: `escapeHtml` plus quotes. */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Schemes that run script when navigated to; a link carrying one is emitted as plain text. */
const SCRIPT_URL = /^\s*(?:javascript|vbscript|livescript|data):/i;

/** A link's `href`, attribute-escaped — or `null` when its scheme could run script. */
function safeHref(raw: string): string | null {
  // A destination with whitespace is not a link in CommonMark — and it is also how a code-span
  // placeholder (see `renderInline`) could be smuggled into the attribute and restored there
  // as raw markup after escaping. Refuse both.
  // deno-lint-ignore no-control-regex -- the NUL placeholder delimiter
  if (/[\s\u0000\u0002]/.test(raw)) return null;
  // The inline pass already HTML-escaped `raw`; undo that before the scheme test so an
  // `&#106;avascript:` style entity can't hide the scheme, then re-escape for the attribute.
  const decoded = raw.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  // deno-lint-ignore no-control-regex -- browsers ignore control chars inside a scheme
  if (SCRIPT_URL.test(decoded.replace(/[\u0000-\u0020]+/g, ""))) return null;
  return escapeAttr(decoded);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    // One hyphen per space, not one per run: GitHub does not collapse runs, so
    // `## Known Gaps & Residual Risk` anchors as `known-gaps--residual-risk`.
    .replace(/\s/g, "-");
}

/** GFM footnotes: the definitions, and the labels in first-reference order with their counts. */
interface Footnotes {
  /** `[^label]: text` definitions, keyed by lower-cased label (raw Markdown text). */
  defs: Map<string, string>;
  /** Referenced labels, in the order of their first reference (the footnote numbers). */
  order: string[];
  /** How many times each label has been referenced so far (one back-link each). */
  uses: Map<string, number>;
}

/** What the inline pass resolves against: reference-link definitions and footnotes. */
interface LinkRefs {
  /** Reference-link definitions (`[label]: url`), keyed by lower-cased label. */
  links: Map<string, string>;
  /** The document's footnotes. */
  notes: Footnotes;
  /** The document's raw-HTML sanitizing state with `html: "sanitize"`; null when escaped. */
  raw: SanitizeDocument | null;
}

/** An `<a>` for an (already-escaped) label and raw href, or the bare label for a script URL. */
function renderLink(label: string, href: string): string {
  const safe = safeHref(href);
  if (safe === null) return label; // a script-bearing URL: keep the text, drop the link
  const external = /^https?:\/\//.test(safe);
  const rel = external ? ` rel="noopener noreferrer" target="_blank"` : "";
  return `<a href="${safe}"${rel}>${label}</a>`;
}

/** `renderLink`, with the `<a ...>` and `</a>` tags held out so the label alone stays inline. */
function holdAnchor(label: string, href: string, hold: (html: string) => string): string {
  const html = renderLink("\u0001", href);
  const at = html.indexOf("\u0001");
  return at < 0 ? label : hold(html.slice(0, at)) + label + hold(html.slice(at + 1));
}

/** The start of the backtick run of exactly `len` at or after `from`, or -1. */
function findBacktickRun(s: string, from: number, len: number): number {
  let k = s.indexOf("`", from);
  while (k >= 0) {
    let end = k;
    while (s[end] === "`") end++;
    if (end - k === len) return k;
    k = s.indexOf("`", end);
  }
  return -1;
}

/** A code span's text: CommonMark strips one space from each side when both sides have one. */
function codeSpanText(raw: string): string {
  const both = raw.length >= 2 && raw.startsWith(" ") && raw.endsWith(" ");
  return both && raw.trim() !== "" ? raw.slice(1, -1) : raw;
}

/**
 * Pull the code spans out of escaped text: a backtick run opens a span that the next run of the
 * same length closes (`` `` a ` b `` ``); an unmatched run stays literal. Each span goes through
 * `hold`, so its contents aren't re-interpreted as emphasis, links or images.
 */
function extractCodeSpans(s: string, hold: (html: string, text: string) => string): string {
  let out = "";
  let i = 0;
  for (let open = s.indexOf("`"); open >= 0; open = s.indexOf("`", i)) {
    let n = open;
    while (s[n] === "`") n++;
    const close = findBacktickRun(s, n, n - open);
    if (close < 0) {
      out += s.slice(i, n);
      i = n;
      continue;
    }
    const code = codeSpanText(s.slice(n, close));
    out += s.slice(i, open) + hold(`<code>${code}</code>`, code);
    i = close + (n - open);
  }
  return out + s.slice(i);
}

/** Escaped text made safe inside a double-quoted attribute (the quotes `escapeHtml` leaves). */
function quoteAttr(escaped: string): string {
  return escaped.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** An `<img>` for an escaped alt and raw src/title, or the bare alt for a script URL. */
function renderImage(alt: string, src: string, title?: string): string {
  const safe = safeHref(src);
  if (safe === null) return alt; // refused exactly as a link target is: keep the text
  const t = title === undefined ? "" : ` title="${quoteAttr(title)}"`;
  return `<img src="${safe}" alt="${quoteAttr(alt)}"${t} />`;
}

/** A footnote reference's `<sup>`, numbered by first reference — or null for an undefined label. */
function footnoteRef(label: string, notes: Footnotes): string | null {
  const key = label.toLowerCase();
  if (!notes.defs.has(key)) return null;
  let index = notes.order.indexOf(key);
  if (index < 0) index = notes.order.push(key) - 1;
  const use = (notes.uses.get(key) ?? 0) + 1;
  notes.uses.set(key, use);
  const n = index + 1;
  const id = use === 1 ? `fnref-${n}` : `fnref-${n}-${use}`;
  return `<sup class="footnote-ref"><a href="#fn-${n}" id="${id}">${n}</a></sup>`;
}

/**
 * Images: inline `![alt](src "title")`, then reference `![alt][label]` / `![alt][]` / `![alt]`.
 * `plain` turns a held code span inside the alt or title back into its text BEFORE the attribute
 * escaping, so neither can carry markup (or a quote) into the attribute.
 */
function replaceImages(
  s: string,
  refs: LinkRefs,
  hold: (html: string) => string,
  plain: (text: string) => string,
): string {
  const out = s.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)/g,
    (_m, alt, src, t1, t2) => {
      const title = t1 ?? t2;
      return hold(renderImage(plain(alt), src, title === undefined ? undefined : plain(title)));
    },
  );
  if (refs.links.size === 0) return out;
  return out.replace(/!\[([^\]]*)\](?:\[([^\]]*)\])?(?!\()/g, (m, alt, label) => {
    const src = refs.links.get((label || alt).toLowerCase());
    return src === undefined ? m : hold(renderImage(plain(alt), src));
  });
}

// Inline: operate on already-escaped text. Code spans, footnote references and images are pulled
// out first (into `held`) so their contents and attributes aren't re-interpreted as emphasis or
// links, then restored. The placeholder is NUL-delimited: `renderMarkdown` strips NUL from the
// source, so it cannot collide with text (a bare ` 1 ` placeholder once swallowed every digit
// run in a paragraph).
function renderInline(text: string, refs: LinkRefs): string {
  const held: string[] = [];
  const plain: string[] = [];
  const hold = (html: string, alt = ""): string => {
    plain.push(alt);
    return `\u0000${held.push(html) - 1}\u0000`;
  };
  // deno-lint-ignore no-control-regex -- the NUL placeholder
  const PLACEHOLDER = /\u0000(\d+)\u0000/g;
  const raws: string[] = [];
  const source = refs.raw === null ? text : holdRawHtml(text, raws);
  let out = extractCodeSpans(escapeHtml(source), hold);
  out = out.replace(/\[\^([^\]\s]+)\]/g, (m, label) => {
    const ref = footnoteRef(label, refs.notes);
    return ref === null ? m : hold(ref);
  });
  // An image's alt is plain text: a held code span inside it contributes its text, not markup.
  out = replaceImages(out, refs, hold, (t) => t.replace(PLACEHOLDER, (_m, i) => plain[Number(i)]));

  // A link's opening tag (and so its href) is held out BEFORE emphasis runs, so `_x_` / `*x*` in
  // a URL is never turned into `<em>`; the label stays in place and still takes emphasis.
  const holdLink = (label: string, href: string): string => holdAnchor(label, href, hold);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => holdLink(label, href));
  // Reference links: `[text][label]`, `[label][]`, and the shortcut `[label]` — only when the
  // label was defined (an undefined `[thing]` stays literal text, as in CommonMark).
  if (refs.links.size > 0) {
    out = out.replace(/\[([^\]]+)\](?:\[([^\]]*)\])?(?!\()/g, (m, text, label) => {
      const key = (label || text).toLowerCase();
      const href = refs.links.get(key);
      return href === undefined ? m : holdLink(text, href);
    });
  }
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1<em>$2</em>");

  out = out.replace(PLACEHOLDER, (_m, i) => held[Number(i)]);
  return refs.raw === null ? out : mergeRawInline(out, raws, refs.raw);
}

/**
 * With `html: "sanitize"`: replace each raw-HTML token of an inline run (outside its code spans,
 * which stay literal) with a marker, holding the token's source in `raws` for
 * {@linkcode mergeRawInline} to sanitize once the Markdown markup is in place.
 */
function holdRawHtml(text: string, raws: string[]): string {
  const memo = new ScanMemo();
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "`") {
      let n = i;
      while (text[n] === "`") n++;
      const close = findBacktickRun(text, n, n - i);
      const end = close < 0 ? n : close + (n - i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    const end = c === "<" ? scanInlineHtml(text, i, memo) : -1;
    if (end < 0) {
      out += c;
      i++;
      continue;
    }
    out += rawMarker(raws.push(text.slice(i, end)) - 1);
    i = end;
  }
  return out;
}

const CALLOUT_KINDS: Record<string, "note" | "warn"> = {
  NOTE: "note",
  TIP: "note",
  IMPORTANT: "note",
  WARNING: "warn",
  WARN: "warn",
  CAUTION: "warn",
};

/** One rendered block plus the line index to resume parsing from. */
interface Block {
  html: string;
  next: number;
}

/** A GFM column alignment, from the delimiter row; `""` when the row leaves it unset. */
type Align = "" | "left" | "center" | "right";

/** A `|` that isn't backslash-escaped — the only kind that splits a table row. */
const UNESCAPED_PIPE = /(^|[^\\])\|/;

/**
 * One table row's cells: the optional outer pipes are dropped, an unescaped `|` closes a cell,
 * and a `\|` escape becomes a literal pipe HERE — before the inline pass, so a code span such as
 * `` `redirect(url, "push"\|"replace")` `` stays one cell with a real pipe inside the code.
 */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (/(^|[^\\])\|$/.test(s)) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (s[k] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += s[k];
    }
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * The per-column alignments of a GFM delimiter row (`| :-- | :-: | --: |`), or null when `line`
 * is not one. A pipe is required, which is what keeps a `---` rule from reading as a delimiter.
 */
function parseAlign(line: string): Align[] | null {
  if (!line.includes("|")) return null;
  const aligns: Align[] = [];
  for (const cell of splitRow(line)) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    aligns.push(left && right ? "center" : right ? "right" : left ? "left" : "");
  }
  return aligns;
}

/**
 * Does a table start at `i`? A header line with an unescaped pipe, a delimiter row under it, and
 * the same number of columns in both — the two-line, equal-width guard that keeps prose
 * containing a pipe from being swallowed as a table.
 */
function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i];
  if (head === undefined || !UNESCAPED_PIPE.test(head)) return false;
  const aligns = parseAlign(lines[i + 1] ?? "");
  return aligns !== null && aligns.length === splitRow(head).length;
}

/** Does `line` end the table body? (end of input, blank, no pipe, or another block's start) */
function endsTableBody(line: string | undefined): boolean {
  if (line === undefined || line.trim() === "" || !UNESCAPED_PIPE.test(line)) return true;
  return /^```/.test(line) || /^#{1,6}\s/.test(line) || line.startsWith(">");
}

/** One cell, with the delimiter row's alignment as a class (a class, not `style=`: CSP). */
function tableCell(tag: "th" | "td", text: string, align: Align, refs: LinkRefs): string {
  const cls = align === "" ? "" : ` class="align-${align}"`;
  return `<${tag}${cls}>${renderInline(text, refs)}</${tag}>`;
}

/** A GFM pipe table starting at `i` (short rows padded, long rows truncated, as in GFM). */
function parseTable(lines: string[], i: number, refs: LinkRefs): Block {
  const aligns = parseAlign(lines[i + 1] ?? "") ?? [];
  const header = splitRow(lines[i]);
  const head = header.map((c, k) => tableCell("th", c, aligns[k] ?? "", refs)).join("");
  const rows: string[] = [];
  let j = i + 2;
  while (!endsTableBody(lines[j])) {
    const cells = splitRow(lines[j]).slice(0, header.length);
    while (cells.length < header.length) cells.push("");
    rows.push(
      `<tr>${cells.map((c, k) => tableCell("td", c, aligns[k] ?? "", refs)).join("")}</tr>`,
    );
    j++;
  }
  const body = `<tbody>${rows.join("")}</tbody>`;
  return {
    html: `<div class="table-wrap"><table><thead><tr>${head}</tr></thead>${body}</table></div>`,
    next: j,
  };
}

/**
 * Does the line at `i` begin a new block (a list item, fence, heading, quote, rule, or table — or,
 * with `html: "sanitize"`, an HTML block that may interrupt a paragraph)?
 */
function startsBlock(lines: string[], i: number, refs: LinkRefs): boolean {
  const l = lines[i];
  return /^\s*(\d+\.|[-*])\s+/.test(l) || /^```/.test(l) ||
    /^#{1,6}\s/.test(l) ||
    l.startsWith(">") || /^(-{3,}|\*{3,})\s*$/.test(l) || isTableStart(lines, i) ||
    (refs.raw !== null && htmlBlockKind(l, true) !== null);
}

/** CommonMark HTML block kinds 6's tag names: a block-level tag opens a block on its own. */
const HTML_BLOCK_TAGS = new Set(
  ("address article aside base basefont blockquote body caption center col colgroup dd details " +
    "dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 " +
    "head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option " +
    "p param search section summary table tbody td tfoot th thead title tr track ul").split(" "),
);

/** A whole open or closing tag alone on its line (CommonMark HTML block kind 7). */
const HTML_LONE_TAG =
  /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/;

/**
 * The CommonMark HTML block a line opens: the pattern of the line that ends it (inclusive), or
 * `"blank"` when the block runs to the next blank line; null when it opens none. Kind 7 (a lone
 * tag) can't interrupt a paragraph, so `interrupting` leaves it out.
 */
function htmlBlockKind(line: string, interrupting: boolean): RegExp | "blank" | null {
  const m = line.match(/^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)?/);
  if (m === null) return null;
  for (const [open, close] of HTML_BLOCK_ENDS) if (open.test(line)) return close;
  const blockTag = m[1] !== undefined && HTML_BLOCK_TAGS.has(m[1].toLowerCase()) &&
    /^(?:$|\s|\/?>)/.test(line.slice(m[0].length));
  return blockTag || (!interrupting && HTML_LONE_TAG.test(line)) ? "blank" : null;
}

/** CommonMark HTML block kinds 1–5: the opening line's pattern and the closing line's. */
const HTML_BLOCK_ENDS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?:[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [/^ {0,3}<![A-Za-z]/, />/],
];

/**
 * An HTML block at `i` (with `html: "sanitize"`), sanitized as one fragment of the document, or
 * null when none opens. A container it leaves open (`<details>`, `<div>`, …) stays open around
 * the Markdown blocks after it until a later HTML block closes it, or the document ends.
 */
function parseHtmlBlock(lines: string[], i: number, doc: SanitizeDocument): Block | null {
  const kind = htmlBlockKind(lines[i], false);
  if (kind === null) return null;
  let j = i;
  if (kind === "blank") {
    while (j < lines.length && lines[j].trim() !== "") j++;
  } else {
    while (j < lines.length && !kind.test(lines[j])) j++;
    j = Math.min(j + 1, lines.length); // the closing line belongs to the block
  }
  return { html: sanitizeBlock(lines.slice(i, j).join("\n"), doc), next: j };
}

/** A fenced code block starting at `i`, or null when `i` isn't a fence. */
function parseFence(lines: string[], i: number): Block | null {
  const fence = lines[i].match(/^```(\w*)\s*$/);
  if (!fence) return null;
  const buf: string[] = [];
  let j = i + 1;
  while (j < lines.length && !/^```\s*$/.test(lines[j])) {
    buf.push(lines[j]);
    j++;
  }
  const langAttr = fence[1] ? ` data-lang="${fence[1]}"` : "";
  return {
    html: `<pre class="code"${langAttr}><code>${escapeHtml(buf.join("\n"))}</code></pre>`,
    next: j + 1, // past the closing fence
  };
}

/**
 * A quote body as HTML: a blank `>` line separates paragraphs, each wrapped in a `<p>`. A single
 * paragraph is emitted bare — exactly the pre-tables output, which the site CSS expects.
 */
function quoteParagraphs(buf: string[], refs: LinkRefs): string {
  const paras: string[] = [];
  let cur: string[] = [];
  for (const line of buf) {
    if (line.trim() === "") {
      if (cur.length > 0) paras.push(cur.join(" ").trim());
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) paras.push(cur.join(" ").trim());
  const rendered = paras.filter((p) => p !== "").map((p) => renderInline(p, refs));
  if (rendered.length <= 1) return rendered[0] ?? "";
  return rendered.map((p) => `<p>${p}</p>`).join("");
}

/** A blockquote or GitHub-style callout (`> [!NOTE]`) starting at `i`. */
function parseBlockquote(lines: string[], i: number, refs: LinkRefs): Block {
  const buf: string[] = [];
  let j = i;
  while (j < lines.length && lines[j].startsWith(">")) {
    buf.push(lines[j].replace(/^>\s?/, ""));
    j++;
  }
  const alert = buf[0]?.match(/^\[!(\w+)\]\s*$/);
  if (alert) {
    const kind = CALLOUT_KINDS[alert[1].toUpperCase()] ?? "note";
    const inner = quoteParagraphs(buf.slice(1), refs);
    return { html: `<aside class="callout ${kind}">${inner}</aside>`, next: j };
  }
  return {
    html: `<blockquote>${quoteParagraphs(buf, refs)}</blockquote>`,
    next: j,
  };
}

/** A list marker line: its indent (columns) and kind. */
interface ListMarker {
  indent: number;
  ordered: boolean;
}

/** A list item's marker (`- `, `* `, `1. `) with any indent. */
const LIST_MARKER = /^(\s*)(\d+\.|[-*])\s+/;

/** The width of leading whitespace, a tab counting as four columns. */
function indentWidth(ws: string): number {
  let w = 0;
  for (const c of ws) w += c === "\t" ? 4 - (w % 4) : 1;
  return w;
}

/** The list marker on `line`, or null when it isn't a list item. */
function listMarker(line: string | undefined): ListMarker | null {
  const m = line?.match(LIST_MARKER);
  return m ? { indent: indentWidth(m[1]), ordered: /\d/.test(m[2]) } : null;
}

/**
 * One list item's text: its first line (marker-stripped) plus any lazy-continuation lines —
 * a wrapped, non-marker line belongs to the current item (CommonMark lazy continuation),
 * without which a wrapped bullet would close the list and render its tail as a stray paragraph.
 */
function collectItem(
  lines: string[],
  i: number,
  refs: LinkRefs,
): { text: string; next: number } {
  const parts = [lines[i].replace(LIST_MARKER, "").trim()];
  let j = i + 1;
  while (j < lines.length && lines[j].trim() !== "" && !startsBlock(lines, j, refs)) {
    parts.push(lines[j].trim());
    j++;
  }
  return { text: parts.join(" "), next: j };
}

/**
 * Where a list nested in an item whose marker sits at `indent` starts — at `j`, or past one
 * blank line — or -1. A marker indented two or more columns past the item's own nests.
 */
function nestedListAt(lines: string[], j: number, indent: number): number {
  const at = lines[j]?.trim() === "" ? j + 1 : j;
  const m = listMarker(lines[at]);
  return m !== null && m.indent >= indent + 2 ? at : -1;
}

/**
 * Where a further paragraph of an item whose marker sits at `indent` starts — past one blank
 * line, a line indented two or more columns past the marker (CommonMark) — or -1.
 */
function itemParagraphAt(lines: string[], j: number, indent: number, refs: LinkRefs): number {
  if (lines[j]?.trim() !== "" || lines[j + 1] === undefined) return -1;
  const line = lines[j + 1];
  const ws = line.match(/^\s*/)![0];
  return line.trim() !== "" && indentWidth(ws) >= indent + 2 && !startsBlock(lines, j + 1, refs)
    ? j + 1
    : -1;
}

/** What follows an item's first paragraph: a nested list or another paragraph, or null. */
function itemContinuation(
  lines: string[],
  j: number,
  indent: number,
  refs: LinkRefs,
): Block | null {
  const nested = nestedListAt(lines, j, indent);
  if (nested >= 0) return parseList(lines, nested, refs);
  const para = itemParagraphAt(lines, j, indent, refs);
  return para >= 0 ? parseParagraph(lines, para, refs) : null;
}

/** One list item at `i` (marker at `indent`): its text, then its nested lists and paragraphs. */
function parseItem(lines: string[], i: number, indent: number, refs: LinkRefs): Block {
  const item = collectItem(lines, i, refs);
  let html = renderInline(item.text, refs);
  let j = item.next;
  for (let more = itemContinuation(lines, j, indent, refs); more !== null;) {
    html += more.html;
    j = more.next;
    more = itemContinuation(lines, j, indent, refs);
  }
  return { html: `<li>${html}</li>`, next: j };
}

/** Is `m` another item of the list whose first marker is `first`? */
function isSibling(m: ListMarker | null, first: ListMarker): boolean {
  return m !== null && m.ordered === first.ordered && m.indent >= first.indent &&
    m.indent < first.indent + 2;
}

/**
 * A list starting at `i` (a single blank line between items keeps them in one list). An item
 * indented two or more columns past its parent's marker opens a nested list inside that item.
 */
function parseList(lines: string[], i: number, refs: LinkRefs): Block {
  const first = listMarker(lines[i])!;
  const items: string[] = [];
  let j = i;
  while (j < lines.length && isSibling(listMarker(lines[j]), first)) {
    const item = parseItem(lines, j, listMarker(lines[j])!.indent, refs);
    items.push(item.html);
    j = item.next;
    if (lines[j]?.trim() === "" && isSibling(listMarker(lines[j + 1]), first)) j++;
  }
  const tag = first.ordered ? "ol" : "ul";
  return { html: `<${tag}>${items.join("")}</${tag}>`, next: j };
}

/** An indented code line: four spaces or a tab (stripped from the code). */
const CODE_INDENT = /^(?: {4}|\t)/;

/**
 * An indented code block starting at `i` (CommonMark): indented and blank lines, the indent
 * stripped, trailing blank lines dropped. It never interrupts a paragraph — a paragraph takes an
 * indented line as a continuation before this is reached.
 */
function parseIndentedCode(lines: string[], i: number): Block {
  const buf: string[] = [];
  let j = i;
  while (j < lines.length && (CODE_INDENT.test(lines[j]) || lines[j].trim() === "")) {
    buf.push(lines[j].trim() === "" ? "" : lines[j].replace(CODE_INDENT, ""));
    j++;
  }
  while (buf.at(-1) === "") buf.pop();
  return {
    html: `<pre class="code"><code>${escapeHtml(buf.join("\n"))}</code></pre>`,
    next: j,
  };
}

/** A paragraph (consecutive non-block lines) starting at `i`. */
function parseParagraph(lines: string[], i: number, refs: LinkRefs): Block {
  // The first line belongs to the paragraph whatever it looks like: no other block took it (a
  // run of four backticks, or three followed by prose, opens no fence), and a paragraph that
  // consumed nothing would leave the renderer at the same line forever.
  const para: string[] = [lines[i].trim()];
  let j = i + 1;
  while (j < lines.length && lines[j].trim() !== "" && !startsBlock(lines, j, refs)) {
    para.push(lines[j].trim());
    j++;
  }
  return { html: `<p>${renderInline(para.join(" "), refs)}</p>`, next: j };
}

/** A footnote definition's first line: `[^label]: text`. */
const FOOTNOTE_DEF = /^\s{0,3}\[\^([^\]\s]+)\]:\s*(.*)$/;

/** A reference-link definition: `[label]: url "title"`. */
const LINK_DEF = /^\s{0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*$/;

/**
 * A footnote definition at `i` — its first line plus the indented lines that continue it — or
 * null when `i` isn't one. The first definition of a label wins.
 */
function takeFootnote(lines: string[], i: number, notes: Footnotes): number | null {
  const def = lines[i].match(FOOTNOTE_DEF);
  if (!def) return null;
  const parts = [def[2].trim()];
  let j = i + 1;
  while (j < lines.length && /^\s+\S/.test(lines[j])) parts.push(lines[j++].trim());
  const key = def[1].toLowerCase();
  if (!notes.defs.has(key)) notes.defs.set(key, parts.join(" "));
  return j;
}

/**
 * Pull the reference-link definitions (`[label]: url`, one per line) and footnote definitions
 * (`[^label]: text`) — anywhere in the document outside fenced code — out of `lines`: they
 * render nothing in place and resolve `[text][label]` / `[label]` / `![alt][label]` / `[^label]`
 * in the inline pass. The first definition of a label wins (CommonMark).
 */
function collectLinkRefs(
  source: string[],
  raw: SanitizeDocument | null,
): { lines: string[]; refs: LinkRefs } {
  const refs: LinkRefs = {
    links: new Map(),
    notes: { defs: new Map(), order: [], uses: new Map() },
    raw,
  };
  const kept: string[] = [];
  let inFence = false;
  for (let i = 0; i < source.length;) {
    const line = source[i];
    if (/^```/.test(line)) inFence = !inFence;
    const next = inFence ? null : takeFootnote(source, i, refs.notes);
    if (next !== null) {
      i = next;
      continue;
    }
    const def = inFence ? null : line.match(LINK_DEF);
    if (def) {
      const key = def[1].toLowerCase();
      if (!refs.links.has(key)) refs.links.set(key, def[2]);
    } else {
      kept.push(line);
    }
    i++;
  }
  return { lines: kept, refs };
}

/**
 * The footnotes section: each referenced definition in first-reference order, with one back-link
 * per reference. A definition may reference another footnote, which joins the end of the list.
 */
function renderFootnotes(refs: LinkRefs): string {
  const { notes } = refs;
  const items: string[] = [];
  for (let k = 0; k < notes.order.length; k++) {
    const key = notes.order[k];
    const text = renderInline(notes.defs.get(key)!, refs);
    const n = k + 1;
    const back: string[] = [];
    for (let use = 1; use <= (notes.uses.get(key) ?? 0); use++) {
      const id = use === 1 ? `fnref-${n}` : `fnref-${n}-${use}`;
      back.push(`<a href="#${id}" class="footnote-backref">↩</a>`);
    }
    items.push(`<li id="fn-${n}">${text} ${back.join(" ")}</li>`);
  }
  return `<section class="footnotes"><ol>${items.join("")}</ol></section>`;
}

/**
 * May an indented line at `i` open a code block? Only after a blank line, a heading or a rule (or
 * at the start): straight after a list or table it is that block's indented content, which this
 * renderer lays out at the top level as before (a table under a list item stays a table).
 */
function opensIndentedCode(lines: string[], i: number): boolean {
  const prev = lines[i - 1];
  return prev === undefined || prev.trim() === "" || /^#{1,6}\s/.test(prev) ||
    /^(-{3,}|\*{3,})\s*$/.test(prev);
}

/** An HTML block (with `html: "sanitize"`) or a fenced code block at `i`, or null. */
function parseRawOrFence(lines: string[], i: number, refs: LinkRefs): Block | null {
  return (refs.raw === null ? null : parseHtmlBlock(lines, i, refs.raw)) ?? parseFence(lines, i);
}

/** The block at `i` (a non-blank line), rendered. */
function parseBlock(lines: string[], i: number, refs: LinkRefs): Block {
  const line = lines[i];
  if (/^(-{3,}|\*{3,})\s*$/.test(line)) return { html: "<hr />", next: i + 1 };
  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    const level = heading[1].length;
    const text = heading[2].trim();
    return {
      html: `<h${level} id="${slugify(text)}">${renderInline(text, refs)}</h${level}>`,
      next: i + 1,
    };
  }
  if (CODE_INDENT.test(line) && opensIndentedCode(lines, i)) return parseIndentedCode(lines, i);
  const leaf = parseRawOrFence(lines, i, refs);
  if (leaf) return leaf;
  if (isTableStart(lines, i)) return parseTable(lines, i, refs);
  if (line.startsWith(">")) return parseBlockquote(lines, i, refs);
  if (LIST_MARKER.test(line)) return parseList(lines, i, refs);
  return parseParagraph(lines, i, refs);
}

/**
 * Render a Markdown body (frontmatter already stripped) to an HTML string.
 *
 * Raw HTML is escaped unless `options.html` is `"sanitize"`, which keeps the HTML the allowlist
 * sanitizer allows ({@linkcode sanitizeHtml}): an HTML block (a line opening with a block-level
 * tag, a comment, or a lone tag) is sanitized as one fragment, inline tags together with the
 * paragraph, heading, cell or item they sit in. Every element is closed inside that block, except
 * a block container (`details`, `div`, `blockquote`, `figure`, and `section` / `aside` when
 * allowlisted) an HTML block leaves open: it wraps the Markdown blocks that follow until a later
 * HTML block closes it, or the document ends. Raw HTML never closes the renderer's own markup, a
 * `#fragment` link follows the `user-content-` prefix only to an id the raw HTML defines, and code
 * spans and code blocks stay literal.
 *
 * ```ts
 * renderMarkdown("Press <kbd>Ctrl</kbd>+<kbd>C</kbd> <img src=x onerror=alert(1)>", {
 *   html: "sanitize",
 * }); // → '<p>Press <kbd>Ctrl</kbd>+<kbd>C</kbd> <img src="x" /></p>'
 * ```
 *
 * @param body The Markdown source, without frontmatter.
 * @param options How raw HTML is treated (escaped by default).
 * @returns HTML: one block element per Markdown block, joined by newlines (the footnotes
 *   section, when a footnote is referenced, last).
 */
export function renderMarkdown(body: string, options: MarkdownOptions = {}): string {
  const raw = options.html === "sanitize"
    ? new SanitizeDocument(resolveSanitizePolicy(options.sanitize))
    : null;
  // deno-lint-ignore no-control-regex -- NUL delimits the inline placeholders
  let source = body.replace(/\r\n/g, "\n").replace(/\u0000/g, "");
  // deno-lint-ignore no-control-regex -- U+0002 / U+0003 delimit the raw-HTML and link markers
  if (raw !== null) source = source.replace(/[\u0002\u0003]/g, "");
  const { lines, refs } = collectLinkRefs(source.split("\n"), raw);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      i++;
      continue;
    }
    const block = parseBlock(lines, i, refs);
    if (block.html !== "") out.push(block.html); // a sanitized HTML block may come out empty
    i = block.next;
  }
  if (raw === null) return finishDocument(out, refs);
  const closing = closeCarried(raw); // raw containers still open at the end of the document
  if (closing !== "") out.push(closing);
  return raw.resolve(finishDocument(out, refs));
}

/** The rendered blocks joined, with the footnotes section (when one is referenced) last. */
function finishDocument(out: string[], refs: LinkRefs): string {
  if (refs.notes.order.length > 0) out.push(renderFootnotes(refs));
  return out.join("\n");
}
