/**
 * `@denext/content-collections/markdown` — a small, first-party, zero-dependency Markdown
 * renderer: the `.md` half of {@link "./runtime.ts" | `renderContent`}.
 *
 * Deliberately NOT a full CommonMark engine — it covers the block and inline constructs typical
 * content uses (headings with ids, paragraphs, ordered/unordered lists with lazy continuation,
 * fenced code with a `data-lang`, blockquotes and GitHub-style `> [!NOTE]` callouts, links,
 * emphasis, inline code, rules). Owning these ~200 lines keeps the zero-npm runtime intact
 * (no marked/remark stack at request time); a document that needs more (tables, footnotes,
 * components) is an `.mdx` entry, compiled at build. Every text run is HTML-escaped before any
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
    .replace(/\s+/g, "-");
}

// Inline: operate on already-escaped text. Code spans are pulled out first so
// their contents aren't re-interpreted as emphasis/links, then restored.
function renderInline(text: string): string {
  const escaped = escapeHtml(text);
  const codes: string[] = [];
  let out = escaped.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(`<code>${code}</code>`);
    return ` ${codes.length - 1} `;
  });

  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    const safe = safeHref(href);
    if (safe === null) return label; // a script-bearing URL: keep the text, drop the link
    const external = /^https?:\/\//.test(safe);
    const rel = external ? ` rel="noopener noreferrer" target="_blank"` : "";
    return `<a href="${safe}"${rel}>${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1<em>$2</em>");

  return out.replace(/ (\d+) /g, (_m, i) => codes[Number(i)]);
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

/** Does a line begin a new block (a list item, fence, heading, quote, or rule)? */
function startsBlock(l: string): boolean {
  return /^\s*(\d+\.|[-*])\s+/.test(l) || /^```/.test(l) ||
    /^#{1,6}\s/.test(l) ||
    l.startsWith(">") || /^(-{3,}|\*{3,})\s*$/.test(l);
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

/** A blockquote or GitHub-style callout (`> [!NOTE]`) starting at `i`. */
function parseBlockquote(lines: string[], i: number): Block {
  const buf: string[] = [];
  let j = i;
  while (j < lines.length && lines[j].startsWith(">")) {
    buf.push(lines[j].replace(/^>\s?/, ""));
    j++;
  }
  const alert = buf[0]?.match(/^\[!(\w+)\]\s*$/);
  if (alert) {
    const kind = CALLOUT_KINDS[alert[1].toUpperCase()] ?? "note";
    const inner = renderInline(buf.slice(1).join(" ").trim());
    return { html: `<aside class="callout ${kind}">${inner}</aside>`, next: j };
  }
  return {
    html: `<blockquote>${renderInline(buf.join(" ").trim())}</blockquote>`,
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
  while (j < lines.length && lines[j].trim() !== "" && !startsBlock(lines[j])) {
    parts.push(lines[j].trim());
    j++;
  }
  return { text: parts.join(" "), next: j };
}

/** A list starting at `i` (a single blank line between items keeps them in one list). */
function parseList(lines: string[], i: number, ordered: boolean): Block {
  const tag = ordered ? "ol" : "ul";
  const marker = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
  const items: string[] = [];
  let j = i;
  while (j < lines.length && marker.test(lines[j])) {
    const item = collectItem(lines, j, marker);
    items.push(renderInline(item.text));
    j = item.next;
    if (lines[j]?.trim() === "" && marker.test(lines[j + 1] ?? "")) j++;
  }
  return {
    html: `<${tag}>${items.map((it) => `<li>${it}</li>`).join("")}</${tag}>`,
    next: j,
  };
}

/** A paragraph (consecutive non-block lines) starting at `i`. */
function parseParagraph(lines: string[], i: number): Block {
  const para: string[] = [];
  let j = i;
  while (j < lines.length && lines[j].trim() !== "" && !startsBlock(lines[j])) {
    para.push(lines[j].trim());
    j++;
  }
  return { html: `<p>${renderInline(para.join(" "))}</p>`, next: j };
}

/**
 * Render a Markdown body (frontmatter already stripped) to an HTML string.
 *
 * @param body The Markdown source, without frontmatter.
 * @returns HTML: one block element per Markdown block, joined by newlines.
 */
export function renderMarkdown(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
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
        `<h${level} id="${slugify(text)}">${renderInline(text)}</h${level}>`,
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
    if (line.startsWith(">")) {
      const bq = parseBlockquote(lines, i);
      out.push(bq.html);
      i = bq.next;
      continue;
    }
    if (/^\s*(\d+\.|[-*])\s+/.test(line)) {
      const list = parseList(lines, i, /^\s*\d+\.\s+/.test(line));
      out.push(list.html);
      i = list.next;
      continue;
    }
    const p = parseParagraph(lines, i);
    out.push(p.html);
    i = p.next;
  }

  return out.join("\n");
}
