/**
 * `@denext/content-collections/markdown` — a small, first-party, zero-dependency Markdown
 * renderer: the `.md` half of {@link "./runtime.ts" | `renderContent`}.
 *
 * Deliberately NOT a full CommonMark engine — it covers the block and inline constructs typical
 * content uses (headings with ids, paragraphs, ordered/unordered lists with lazy continuation,
 * fenced code with a `data-lang`, blockquotes and GitHub-style `> [!NOTE]` callouts, GFM pipe
 * tables, inline and reference-style links, emphasis, inline code, rules). Owning these ~350 lines
 * keeps the zero-npm runtime intact (no marked/remark stack at request time); a document that
 * needs more (nested lists, footnotes, images, components) is an `.mdx` entry, compiled at build.
 * Every text run is HTML-escaped before any
 * markup is emitted and raw HTML in the source is escaped, not passed through; link targets
 * are attribute-escaped and `javascript:`/`vbscript:`/`data:` URLs are dropped.
 *
 * @module
 */

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
  if (/[\s\u0000]/.test(raw)) return null;
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

/** Reference-link definitions (`[label]: url`), keyed by lower-cased label. */
type LinkRefs = Map<string, string>;

/** An `<a>` for an (already-escaped) label and raw href, or the bare label for a script URL. */
function renderLink(label: string, href: string): string {
  const safe = safeHref(href);
  if (safe === null) return label; // a script-bearing URL: keep the text, drop the link
  const external = /^https?:\/\//.test(safe);
  const rel = external ? ` rel="noopener noreferrer" target="_blank"` : "";
  return `<a href="${safe}"${rel}>${label}</a>`;
}

// Inline: operate on already-escaped text. Code spans are pulled out first so
// their contents aren't re-interpreted as emphasis/links, then restored. The placeholder is
// NUL-delimited: `renderMarkdown` strips NUL from the source, so it cannot collide with text
// (a bare ` 1 ` placeholder once swallowed every digit run in a paragraph).
function renderInline(text: string, refs: LinkRefs): string {
  const escaped = escapeHtml(text);
  const codes: string[] = [];
  let out = escaped.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => renderLink(label, href));
  // Reference links: `[text][label]`, `[label][]`, and the shortcut `[label]` — only when the
  // label was defined (an undefined `[thing]` stays literal text, as in CommonMark).
  if (refs.size > 0) {
    out = out.replace(/\[([^\]]+)\](?:\[([^\]]*)\])?(?!\()/g, (m, text, label) => {
      const key = (label || text).toLowerCase();
      const href = refs.get(key);
      return href === undefined ? m : renderLink(text, href);
    });
  }
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1<em>$2</em>");

  // deno-lint-ignore no-control-regex -- the NUL placeholder above
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)]);
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

/** Does the line at `i` begin a new block (a list item, fence, heading, quote, rule, or table)? */
function startsBlock(lines: string[], i: number): boolean {
  const l = lines[i];
  return /^\s*(\d+\.|[-*])\s+/.test(l) || /^```/.test(l) ||
    /^#{1,6}\s/.test(l) ||
    l.startsWith(">") || /^(-{3,}|\*{3,})\s*$/.test(l) || isTableStart(lines, i);
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

/**
 * One list item's text: its first line (marker-stripped) plus any lazy-continuation lines —
 * a wrapped, non-marker line belongs to the current item (CommonMark lazy continuation),
 * without which a wrapped bullet would close the list and render its tail as a stray paragraph.
 */
function collectItem(
  lines: string[],
  i: number,
  marker: RegExp,
): { text: string; next: number } {
  const parts = [lines[i].replace(marker, "").trim()];
  let j = i + 1;
  while (j < lines.length && lines[j].trim() !== "" && !startsBlock(lines, j)) {
    parts.push(lines[j].trim());
    j++;
  }
  return { text: parts.join(" "), next: j };
}

/** A list starting at `i` (a single blank line between items keeps them in one list). */
function parseList(lines: string[], i: number, ordered: boolean, refs: LinkRefs): Block {
  const tag = ordered ? "ol" : "ul";
  const marker = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
  const items: string[] = [];
  let j = i;
  while (j < lines.length && marker.test(lines[j])) {
    const item = collectItem(lines, j, marker);
    items.push(renderInline(item.text, refs));
    j = item.next;
    if (lines[j]?.trim() === "" && marker.test(lines[j + 1] ?? "")) j++;
  }
  return {
    html: `<${tag}>${items.map((it) => `<li>${it}</li>`).join("")}</${tag}>`,
    next: j,
  };
}

/** A paragraph (consecutive non-block lines) starting at `i`. */
function parseParagraph(lines: string[], i: number, refs: LinkRefs): Block {
  const para: string[] = [];
  let j = i;
  while (j < lines.length && lines[j].trim() !== "" && !startsBlock(lines, j)) {
    para.push(lines[j].trim());
    j++;
  }
  return { html: `<p>${renderInline(para.join(" "), refs)}</p>`, next: j };
}

/**
 * Pull the reference-link definitions (`[label]: url`, one per line, anywhere in the
 * document outside fenced code) out of `lines`: they render nothing themselves and resolve
 * `[text][label]` / `[label]` in the inline pass. The first definition of a label wins
 * (CommonMark).
 */
function collectLinkRefs(lines: string[]): { lines: string[]; refs: LinkRefs } {
  const refs: LinkRefs = new Map();
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const def = inFence
      ? null
      : line.match(/^\s{0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*$/);
    if (def) {
      const key = def[1].toLowerCase();
      if (!refs.has(key)) refs.set(key, def[2]);
      continue;
    }
    kept.push(line);
  }
  return { lines: kept, refs };
}

/**
 * Render a Markdown body (frontmatter already stripped) to an HTML string.
 *
 * @param body The Markdown source, without frontmatter.
 * @returns HTML: one block element per Markdown block, joined by newlines.
 */
export function renderMarkdown(body: string): string {
  // deno-lint-ignore no-control-regex -- NUL delimits the code-span placeholder
  const source = body.replace(/\r\n/g, "\n").replace(/\u0000/g, "");
  const { lines, refs } = collectLinkRefs(source.split("\n"));
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      out.push(
        `<h${level} id="${slugify(text)}">${renderInline(text, refs)}</h${level}>`,
      );
      i++;
      continue;
    }
    const fence = parseFence(lines, i);
    if (fence) {
      out.push(fence.html);
      i = fence.next;
      continue;
    }
    if (isTableStart(lines, i)) {
      const table = parseTable(lines, i, refs);
      out.push(table.html);
      i = table.next;
      continue;
    }
    if (line.startsWith(">")) {
      const bq = parseBlockquote(lines, i, refs);
      out.push(bq.html);
      i = bq.next;
      continue;
    }
    if (/^\s*(\d+\.|[-*])\s+/.test(line)) {
      const list = parseList(lines, i, /^\s*\d+\.\s+/.test(line), refs);
      out.push(list.html);
      i = list.next;
      continue;
    }
    const p = parseParagraph(lines, i, refs);
    out.push(p.html);
    i = p.next;
  }

  return out.join("\n");
}
