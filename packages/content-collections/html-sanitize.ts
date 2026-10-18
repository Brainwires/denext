/**
 * The allowlist HTML sanitizer behind `renderMarkdown(body, { html: "sanitize" })` (internal;
 * its public surface is re-exported from `./markdown.ts`).
 *
 * Raw HTML is tokenized with a tolerant, HTML-spec-shaped tokenizer, built into a tree of open
 * elements, and **re-serialized from that tree**: no byte of the original markup is passed
 * through. Every text run and attribute value is entity-decoded once on the way in and escaped on
 * the way out, so what the browser parses is exactly what was checked. Elements and attributes
 * outside the allowlist are dropped (a disallowed element keeps its escaped text; script-like and
 * foreign-content elements lose their content too); URLs are checked after entity decoding and
 * control-character stripping; `id` / `name` are prefixed with `user-content-` (with same-document
 * `#fragment` links rewritten to match); every element left open is closed at the end, so the
 * output is well formed and can't leak out of the block it was written in.
 *
 * @module
 */

/** How `renderMarkdown` treats raw HTML in the source: escape it (the default) or sanitize it. */
export type MarkdownHtmlMode = "escape" | "sanitize";

/**
 * Extensions to the sanitizer's built-in allowlist. They can only ADD to it: the hard-denied
 * elements (`script`, `style`, `iframe`, `form`, `svg`, `math`, … and any namespaced or custom
 * element) and attributes (`on*`, `style`, `srcdoc`, `formaction`, `xlink:*`, any namespaced
 * name) are refused whatever is listed here.
 */
export interface SanitizeOptions {
  /** More element names to keep (lower-case HTML names such as `"center"`). */
  readonly allowElements?: readonly string[];
  /**
   * More attributes to keep, keyed by element name, or `"*"` for every element — for example
   * `{ "*": ["class"] }` keeps `class` (stripped by default) everywhere. A URL-bearing attribute
   * (`href`, `src`, `cite`, `poster`, …) is still scheme-checked.
   */
  readonly allowAttributes?: Readonly<Record<string, readonly string[]>>;
  /**
   * Keep `data:image/(png|gif|jpeg|webp);base64,…` URLs, on `<img src>` only (never SVG).
   * Default `false`.
   */
  readonly allowDataImages?: boolean;
}

/** The elements kept by default (GitHub's set, roughly). */
const ALLOWED_ELEMENTS = [
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "picture",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "small",
  "source",
  "span",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "tt",
  "u",
  "ul",
  "var",
  "wbr",
];

/** Hard-denied elements dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "xmp",
  "plaintext",
  "noembed",
  "noframes",
  "title",
  "svg",
  "math",
]);

/** Every hard-denied element: no option can allow these. */
const HARD_DENIED = new Set([
  ...DROP_WITH_CONTENT,
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "optgroup",
  "link",
  "meta",
  "base",
  "html",
  "head",
  "body",
]);

/** Elements with no content or end tag. */
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content the HTML tokenizer reads as text up to the matching end tag. */
const RAW_TEXT = new Set([
  "plaintext",
  "script",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "textarea",
  "title",
]);

/** Attributes kept by default, per element (`*` = on every element). */
const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  "*": ["title", "lang", "dir", "id"],
  a: ["href", "name", "target"],
  img: ["src", "alt", "width", "height", "align"],
  div: ["align"],
  p: ["align"],
  h1: ["align"],
  h2: ["align"],
  h3: ["align"],
  h4: ["align"],
  h5: ["align"],
  h6: ["align"],
  table: ["align"],
  tr: ["align"],
  td: ["colspan", "rowspan", "align"],
  th: ["colspan", "rowspan", "align", "scope"],
  ol: ["start", "type"],
  li: ["value"],
  col: ["span"],
  colgroup: ["span"],
  time: ["datetime"],
  source: ["srcset", "media", "type"],
  details: ["open"],
  blockquote: ["cite"],
  q: ["cite"],
  del: ["cite", "datetime"],
  ins: ["cite", "datetime"],
};

/** Attributes whose value is one URL, scheme-checked before it is kept. */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "cite",
  "longdesc",
  "poster",
  "background",
  "action",
  "data",
  "codebase",
  "dynsrc",
  "lowsrc",
  "usemap",
  "ping",
  "manifest",
  "icon",
  "itemtype",
]);

/** Attributes whose value is a list of URLs with descriptors. */
const SRCSET_ATTRIBUTES = new Set(["srcset", "imagesrcset"]);

/**
 * A safe attribute name: no event handler, `style`, `srcdoc`, `formaction`, namespaced name
 * (`xlink:*`, `xmlns*`) or `is` (a customized built-in element).
 */
function attributeNameAllowed(name: string): boolean {
  return /^[a-z][a-z0-9_.-]*$/.test(name) && !name.startsWith("on") && name !== "style" &&
    name !== "srcdoc" && name !== "formaction" && !name.startsWith("xmlns") && name !== "is";
}

/** A plain HTML element name (no namespace prefix, no custom-element hyphen). */
function plainElementName(name: string): boolean {
  return /^[a-z][a-z0-9]*$/.test(name);
}

/** The resolved allowlist for one render. */
export interface SanitizePolicy {
  readonly elements: ReadonlySet<string>;
  readonly attributes: ReadonlyMap<string, ReadonlySet<string>>;
  readonly dataImages: boolean;
}

/** The built-in allowlist plus `options`' safe additions. */
export function resolveSanitizePolicy(options: SanitizeOptions = {}): SanitizePolicy {
  const elements = new Set(ALLOWED_ELEMENTS);
  for (const raw of options.allowElements ?? []) {
    const name = String(raw).toLowerCase();
    if (plainElementName(name) && !HARD_DENIED.has(name)) elements.add(name);
  }
  const attributes = new Map<string, Set<string>>();
  const add = (element: string, names: readonly string[]): void => {
    const key = String(element).toLowerCase();
    if (key !== "*" && !plainElementName(key)) return;
    const set = attributes.get(key) ?? new Set<string>();
    for (const n of names) {
      const name = String(n).toLowerCase();
      if (attributeNameAllowed(name)) set.add(name);
    }
    attributes.set(key, set);
  };
  for (const [element, names] of Object.entries(ALLOWED_ATTRIBUTES)) add(element, names);
  for (const [element, names] of Object.entries(options.allowAttributes ?? {})) {
    if (Array.isArray(names)) add(element, names);
  }
  return { elements, attributes, dataImages: options.allowDataImages === true };
}

// ---------------------------------------------------------------------------------------------
// Entities

/** Named entities decoded in text and attribute values (an unknown one stays literal text). */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  para: "¶",
  sect: "§",
  cent: "¢",
  pound: "£",
  yen: "¥",
  euro: "€",
  iexcl: "¡",
  iquest: "¿",
  shy: "\u00ad",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  zwnj: "\u200c",
  zwj: "\u200d",
  // ASCII punctuation, so an obfuscated `javascript&colon;` decodes as the browser decodes it.
  Tab: "\t",
  NewLine: "\n",
  excl: "!",
  num: "#",
  dollar: "$",
  percnt: "%",
  lpar: "(",
  rpar: ")",
  ast: "*",
  plus: "+",
  comma: ",",
  period: ".",
  sol: "/",
  colon: ":",
  semi: ";",
  equals: "=",
  quest: "?",
  commat: "@",
  lsqb: "[",
  bsol: "\\",
  rsqb: "]",
  Hat: "^",
  lowbar: "_",
  grave: "`",
  lcub: "{",
  verbar: "|",
  rcub: "}",
};

/** A numeric character reference's character (U+FFFD for NUL, surrogates and out of range). */
function codePointChar(cp: number): string {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || Number.isNaN(cp)) {
    return "�";
  }
  return String.fromCodePoint(cp);
}

/** Decode character references once (numeric with or without `;`, named with `;`). */
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(
    /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]*);)/g,
    (m, hex, dec, name) => {
      if (hex !== undefined) return codePointChar(parseInt(hex.slice(0, 8), 16));
      if (dec !== undefined) return codePointChar(parseInt(dec.slice(0, 8), 10));
      return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m;
    },
  );
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/`/g, "&#96;");
}

// ---------------------------------------------------------------------------------------------
// Tokenizer

/** One token of raw HTML. Text and attribute values are already entity-decoded. */
type HtmlToken =
  | { readonly type: "text"; readonly text: string }
  | {
    readonly type: "start";
    readonly name: string;
    readonly attrs: ReadonlyArray<readonly [string, string]>;
  }
  | { readonly type: "end"; readonly name: string }
  | { readonly type: "ignored" };

const WS = /[\t\n\f\r ]/;

/**
 * What the scans over one string have learned, so a run of `<`s that never close (`<a <a <a…`,
 * `<!<!<!…`) costs linear time, not one scan to the end of the input per `<`.
 */
export class ScanMemo {
  /** Attribute positions from which a tag was already found never to close. */
  readonly dead = new Set<number>();
  /** The last tag-name run: any name starting inside `[nameFrom, nameEnd)` ends at `nameEnd`. */
  nameFrom = -1;
  nameEnd = -1;
  #found = new Map<string, { from: number; at: number }>();

  /** `s.indexOf(needle, from)`, answered from the last search when it already covers `from`. */
  indexOf(s: string, needle: string, from: number): number {
    const last = this.#found.get(needle);
    if (last && from >= last.from && (last.at < 0 || last.at >= from)) return last.at;
    const at = s.indexOf(needle, from);
    this.#found.set(needle, { from, at });
    return at;
  }

  /** The end of the tag name starting at `k`. */
  nameEndFrom(s: string, k: number): number {
    if (k >= this.nameFrom && k < this.nameEnd) return this.nameEnd;
    let e = k;
    while (e < s.length && !WS.test(s[e]) && s[e] !== "/" && s[e] !== ">") e++;
    this.nameFrom = k;
    this.nameEnd = e;
    return e;
  }
}

/** Is `c` a character that ends an attribute name (or an unquoted value, without `=`)? */
function endsName(c: string): boolean {
  return WS.test(c) || c === "/" || c === ">" || c === "=";
}

/** The index of the first character at or after `i` that is not whitespace. */
function skipWhitespace(s: string, i: number): number {
  while (i < s.length && WS.test(s[i])) i++;
  return i;
}

/**
 * One attribute's value starting at `j` (just past `=` and any whitespace): the decoded value and
 * where it ends, or null when a quoted value never closes.
 */
function scanAttributeValue(
  s: string,
  j: number,
  memo: ScanMemo,
): { value: string; end: number } | null {
  const quote = s[j];
  if (quote === '"' || quote === "'") {
    const close = memo.indexOf(s, quote, j + 1);
    return close < 0 ? null : { value: decodeEntities(s.slice(j + 1, close)), end: close + 1 };
  }
  let k = j;
  while (k < s.length && !WS.test(s[k]) && s[k] !== ">") k++;
  return { value: decodeEntities(s.slice(j, k)), end: k };
}

/**
 * One attribute starting at `i` (its first character, which even when `=` belongs to the name):
 * `[name, value]` and where it ends, or null when its value runs off the end of the input.
 */
function scanAttribute(
  s: string,
  i: number,
  memo: ScanMemo,
): { attr: [string, string]; end: number } | null {
  let e = i + 1;
  while (e < s.length && !endsName(s[e])) e++;
  const name = s.slice(i, e).toLowerCase();
  const eq = skipWhitespace(s, e);
  if (s[eq] !== "=") return { attr: [name, ""], end: e };
  const value = scanAttributeValue(s, skipWhitespace(s, eq + 1), memo);
  return value === null ? null : { attr: [name, value.value], end: value.end };
}

/** Past the whitespace and `/`s between a tag's attributes. */
function skipToAttribute(s: string, i: number): number {
  while (i < s.length && (WS.test(s[i]) || s[i] === "/")) i++;
  return i;
}

/** The attributes of a tag starting at `i` (just past its name), and where the tag ends. */
function scanAttributes(
  s: string,
  i: number,
  memo: ScanMemo,
): { attrs: Array<[string, string]>; end: number } | null {
  const attrs: Array<[string, string]> = [];
  const visited: number[] = [];
  for (;;) {
    i = skipToAttribute(s, i);
    if (s[i] === ">") return { attrs, end: i + 1 };
    const attr = i >= s.length || memo.dead.has(i) ? null : scanAttribute(s, i, memo);
    if (attr === null) {
      // Never closes: remember every attribute start on the way, where later scans can stop.
      for (const p of [...visited, i]) memo.dead.add(p);
      return null;
    }
    visited.push(i);
    attrs.push(attr.attr);
    i = attr.end;
  }
}

/** A comment at `i` (`<!--`): where it ends — past `-->` / `--!>`, or at the end of the input. */
function scanComment(s: string, i: number, memo: ScanMemo): number {
  if (s.startsWith("<!-->", i)) return i + 5;
  if (s.startsWith("<!--->", i)) return i + 6;
  // The first `--` run that a `>` (or `!>`) follows.
  for (let k = memo.indexOf(s, "--", i + 4); k >= 0; k = memo.indexOf(s, "--", k + 1)) {
    let e = k + 2;
    while (s[e] === "-") e++;
    if (s[e] === ">") return e + 1;
    if (s.startsWith("!>", e)) return e + 2;
  }
  return s.length;
}

/** A comment, processing instruction, CDATA section or declaration at `i`: where it ends. */
function scanIgnored(s: string, i: number, memo: ScanMemo): number {
  if (s.startsWith("<!--", i)) return scanComment(s, i, memo);
  const gt = memo.indexOf(s, ">", i + 2);
  return gt < 0 ? s.length : gt + 1;
}

/** An end tag at `i` (`</`): the token and its end, or null when it never closes. */
function scanEndTag(
  s: string,
  i: number,
  memo: ScanMemo,
): { token: HtmlToken; end: number } | null {
  if (s[i + 2] === ">") return { token: { type: "ignored" }, end: i + 3 };
  if (!/[A-Za-z]/.test(s[i + 2] ?? "")) {
    return { token: { type: "ignored" }, end: scanIgnored(s, i, memo) };
  }
  const k = memo.nameEndFrom(s, i + 2);
  const rest = scanAttributes(s, k, memo);
  if (rest === null) return null;
  return { token: { type: "end", name: s.slice(i + 2, k).toLowerCase() }, end: rest.end };
}

/**
 * The single tag-like token starting at `s[i] === "<"`, or null when that `<` is plain text (no
 * tag name follows, or the tag never closes before the end of the input).
 */
function scanTag(
  s: string,
  i: number,
  memo: ScanMemo = new ScanMemo(),
): { token: HtmlToken; end: number } | null {
  const next = s[i + 1];
  if (next === "!" || next === "?") {
    return { token: { type: "ignored" }, end: scanIgnored(s, i, memo) };
  }
  if (next === "/") return scanEndTag(s, i, memo);
  if (!/[A-Za-z]/.test(next ?? "")) return null;
  const k = memo.nameEndFrom(s, i + 1);
  const rest = scanAttributes(s, k, memo);
  if (rest === null) return null;
  const name = s.slice(i + 1, k).toLowerCase();
  return { token: { type: "start", name, attrs: rest.attrs }, end: rest.end };
}

/** A CommonMark tag name directly followed by whitespace, `/` or `>`. */
const INLINE_TAG = /^<\/?[A-Za-z][A-Za-z0-9-]*(?=[\t\n\f\r />])/;

/**
 * The raw-HTML token an inline Markdown run holds at `s[i] === "<"` — a tag with a plain name, or
 * a CLOSED comment, processing instruction, CDATA section or declaration — as its end index, or
 * -1 when the `<` is text (an autolink such as `<https://x>`, `a < b`, an unclosed construct).
 */
export function scanInlineHtml(s: string, i: number, memo: ScanMemo): number {
  const next = s[i + 1];
  if (next === "!" || next === "?") {
    const end = scanIgnored(s, i, memo);
    // Unclosed, it ran to the end of the input: as text, not a comment eating the paragraph.
    const closed = s.startsWith("<!--", i) ? /--!?>$/.test(s.slice(i, end)) : s[end - 1] === ">";
    return closed ? end : -1;
  }
  if (!INLINE_TAG.test(s.slice(i, i + 64))) return -1;
  return scanTag(s, i, memo)?.end ?? -1;
}

/**
 * The raw text after a `name` start tag ending at `i`, up to its `</name` end tag (or the end of
 * the input) — as browsers read `script`, `style`, `textarea`, … — and where it ends.
 */
function rawText(s: string, i: number, name: string): { text: string; end: number } {
  if (name === "plaintext") return { text: s.slice(i), end: s.length }; // the rest is its text
  const re = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "ig");
  re.lastIndex = i;
  const end = re.exec(s)?.index ?? s.length;
  const body = s.slice(i, end);
  // Only RCDATA (textarea, title) decodes references; the rest is literal.
  return { text: name === "textarea" || name === "title" ? decodeEntities(body) : body, end };
}

/** Tokenize a whole HTML fragment (raw-text elements read up to their end tag, as browsers do). */
function tokenizeHtml(s: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let text = "";
  const flush = (): void => {
    if (text !== "") tokens.push({ type: "text", text: decodeEntities(text) });
    text = "";
  };
  const memo = new ScanMemo();
  for (let i = 0; i < s.length;) {
    const lt = s.indexOf("<", i);
    const tag = lt < 0 ? null : scanTag(s, lt, memo);
    if (tag === null) {
      const upTo = lt < 0 ? s.length : lt + 1; // a `<` that opens no tag is text
      text += s.slice(i, upTo);
      i = upTo;
      continue;
    }
    text += s.slice(i, lt);
    flush();
    tokens.push(tag.token);
    i = tag.end;
    if (tag.token.type === "start" && RAW_TEXT.has(tag.token.name)) {
      const raw = rawText(s, i, tag.token.name);
      if (raw.text !== "") tokens.push({ type: "text", text: raw.text });
      i = raw.end;
    }
  }
  flush();
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// URLs

/** Whitespace and invisible characters ignored when finding a URL's scheme. */
const URL_IGNORED =
  // deno-lint-ignore no-control-regex -- control characters are exactly what is being stripped
  /[\u0000-\u0020\u007f-\u00a0\u00ad\u1680\u180e\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g;

const DATA_IMAGE = /^data:image\/(?:png|gif|jpeg|webp);base64,[a-z0-9+/=]*$/i;

/** A URL value as it will be emitted, or null when its scheme isn't allowed. */
function sanitizeUrl(value: string, allowDataImage = false): string | null {
  // What the browser drops itself: leading/trailing C0 + space, and tab / newline anywhere.
  // deno-lint-ignore no-control-regex -- C0 controls
  const emitted = value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "")
    // deno-lint-ignore no-control-regex -- C0 controls
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  const check = emitted.replace(URL_IGNORED, "");
  const scheme = /^([^/?#]*?):/.exec(check);
  if (scheme === null) return emitted; // relative (path, query, fragment, protocol-relative)
  const name = scheme[1].toLowerCase();
  if (name === "http" || name === "https" || name === "mailto") return emitted;
  if (allowDataImage && DATA_IMAGE.test(check)) return check;
  return null;
}

/** A `srcset` with every candidate URL allowed, or null when any candidate is refused. */
function sanitizeSrcset(value: string): string | null {
  const out: string[] = [];
  for (const part of value.split(",")) {
    const candidate = part.trim();
    if (candidate === "") continue;
    const [url, ...descriptors] = candidate.split(/\s+/);
    const safe = sanitizeUrl(url);
    if (safe === null || /[\s,]/.test(safe)) return null;
    out.push([safe, ...descriptors.filter((d) => /^[0-9.]+[wx]$/i.test(d))].join(" "));
  }
  return out.length === 0 ? null : out.join(", ");
}

// ---------------------------------------------------------------------------------------------
// Tree building + serialization

/** The `user-content-` prefix GitHub puts on user ids and names, so they can't clobber globals. */
const USER_CONTENT = "user-content-";

function prefixed(v: string): string {
  return v.startsWith(USER_CONTENT) ? v : USER_CONTENT + v;
}

/** Does the policy keep attribute `name` on `element`? */
function attributeAllowed(element: string, name: string, policy: SanitizePolicy): boolean {
  const listed = policy.attributes.get(element)?.has(name) ||
    policy.attributes.get("*")?.has(name);
  return listed === true && attributeNameAllowed(name);
}

/** A URL attribute's value, or null to drop it; `#fragment` links follow the id rewrite. */
function urlAttribute(
  element: string,
  name: string,
  value: string,
  policy: SanitizePolicy,
): string | null {
  const url = sanitizeUrl(value, policy.dataImages && element === "img" && name === "src");
  const fragment = url !== null && name === "href" && url.length > 1 && url.startsWith("#");
  return fragment ? `#${prefixed(url.slice(1))}` : url;
}

/** One attribute after the allowlist and value rules, or null to drop it. */
function sanitizeAttribute(
  element: string,
  name: string,
  value: string,
  policy: SanitizePolicy,
): string | null {
  if (!attributeAllowed(element, name, policy)) return null;
  if (name === "id" || name === "name") return value === "" ? null : prefixed(value);
  if (name === "target") return value.toLowerCase() === "_blank" ? "_blank" : null;
  if (SRCSET_ATTRIBUTES.has(name)) return sanitizeSrcset(value);
  return URL_ATTRIBUTES.has(name) ? urlAttribute(element, name, value, policy) : value;
}

/** An allowed start tag, serialized from its parsed (and sanitized) attributes. */
function serializeStart(
  name: string,
  attrs: ReadonlyArray<readonly [string, string]>,
  policy: SanitizePolicy,
): string {
  const seen = new Set<string>();
  const kept: Array<[string, string]> = [];
  for (const [n, v] of attrs) {
    if (seen.has(n)) continue; // the first of a duplicated attribute wins, as in browsers
    seen.add(n);
    const safe = sanitizeAttribute(name, n, v, policy);
    if (safe !== null) kept.push([n, safe]);
  }
  // A kept `target` is `_blank`: it only ever goes out with our rel, never the author's.
  const out = kept.some(([n]) => n === "target")
    ? [...kept.filter(([n]) => n !== "rel"), ["rel", "noopener noreferrer nofollow"]]
    : kept;
  const serialized = out.map(([n, v]) => ` ${n}="${escapeAttribute(v)}"`).join("");
  return `<${name}${serialized}${VOID.has(name) ? " /" : ""}>`;
}

/** An open element on the builder's stack. */
interface Open {
  readonly name: string;
  /** Emitted by the Markdown renderer itself (never matched by an untrusted end tag). */
  readonly trusted: boolean;
  /** Was its start tag written (and so must its end tag be)? */
  readonly emitted: boolean;
  /** Dropped together with its content. */
  readonly drop: boolean;
}

/**
 * The tree builder: a stack of open elements, serializing as it goes. Untrusted tags go through
 * the policy; trusted ones (the Markdown renderer's own markup) are kept as written. An end tag
 * closes the nearest open element of its name and kind (an untrusted end tag never closes the
 * renderer's markup); one with no such element open is ignored; whatever is still open at the end
 * is closed.
 */
class HtmlWriter {
  #out: string[] = [];
  #stack: Open[] = [];
  /** How many elements of each `trusted:name` are open, so a stray end tag costs no scan. */
  #open = new Map<string, number>();
  #dropping = 0;
  constructor(readonly policy: SanitizePolicy) {}

  text(text: string): void {
    if (this.#dropping === 0 && text !== "") this.#out.push(escapeText(text));
  }

  start(name: string, attrs: ReadonlyArray<readonly [string, string]>, trusted: boolean): void {
    const drop = !trusted && DROP_WITH_CONTENT.has(name);
    const emit = this.#emitStart(name, attrs, trusted, drop);
    if (VOID.has(name)) return;
    // A stripped element (neither emitted nor dropped) is transparent: its end tag is ignored.
    if (!emit && !drop && this.#dropping === 0) return;
    this.#push({ name, trusted, emitted: emit, drop });
  }

  /** Write the start tag when it is allowed and not inside dropped content; was it written? */
  #emitStart(
    name: string,
    attrs: ReadonlyArray<readonly [string, string]>,
    trusted: boolean,
    drop: boolean,
  ): boolean {
    if (this.#dropping > 0 || drop) return false;
    if (trusted) this.#out.push(trustedStart(name, attrs));
    else if (this.policy.elements.has(name)) {
      this.#out.push(serializeStart(name, attrs, this.policy));
    } else return false;
    return true;
  }

  #push(open: Open): void {
    const { name, trusted, drop } = open;
    this.#stack.push(open);
    const key = `${trusted}:${name}`;
    this.#open.set(key, (this.#open.get(key) ?? 0) + 1);
    if (drop) this.#dropping++;
  }

  end(name: string, trusted: boolean): void {
    if (!this.#open.get(`${trusted}:${name}`)) return;
    for (let k = this.#stack.length - 1; k >= 0; k--) {
      const open = this.#stack[k];
      if (open.name !== name || open.trusted !== trusted) continue;
      while (this.#stack.length > k) this.#pop();
      return;
    }
  }

  #pop(): void {
    const open = this.#stack.pop()!;
    const key = `${open.trusted}:${open.name}`;
    this.#open.set(key, this.#open.get(key)! - 1);
    if (open.drop) this.#dropping--;
    if (open.emitted) this.#out.push(`</${open.name}>`);
  }

  finish(): string {
    while (this.#stack.length > 0) this.#pop();
    return this.#out.join("");
  }
}

/** A trusted (renderer-emitted) start tag, re-serialized with its attributes as they were. */
function trustedStart(name: string, attrs: ReadonlyArray<readonly [string, string]>): string {
  const out = attrs.map(([n, v]) => ` ${n}="${escapeAttribute(v.replace(RAW_MARK, ""))}"`);
  return `<${name}${out.join("")}${VOID.has(name) ? " /" : ""}>`;
}

function feed(writer: HtmlWriter, token: HtmlToken, trusted: boolean): void {
  if (token.type === "text") writer.text(token.text);
  else if (token.type === "start") writer.start(token.name, token.attrs, trusted);
  else if (token.type === "end") writer.end(token.name, trusted);
}

/**
 * Sanitize an HTML fragment against the allowlist: parse it into a tree and re-serialize it, so
 * only allowed elements and attributes, checked URLs and escaped text come out, every element is
 * closed, and comments, processing instructions, CDATA and doctypes are gone. Idempotent.
 *
 * ```ts
 * import { sanitizeHtml } from "@denext/content-collections/markdown";
 * sanitizeHtml(`<a href="javascript:alert(1)" onclick="x()">hi</a><script>x()</script>`);
 * // → "<a>hi</a>"
 * ```
 *
 * @param html The untrusted HTML.
 * @param options Additions to the built-in allowlist.
 * @returns Well-formed, allowlisted HTML.
 */
export function sanitizeHtml(html: string, options: SanitizeOptions = {}): string {
  return sanitizeWithPolicy(html, resolveSanitizePolicy(options));
}

/** {@linkcode sanitizeHtml} with an already-resolved policy. */
export function sanitizeWithPolicy(html: string, policy: SanitizePolicy): string {
  const writer = new HtmlWriter(policy);
  for (const token of tokenizeHtml(html)) feed(writer, token, false);
  return writer.finish();
}

/**
 * The marker the Markdown renderer leaves where it held one raw-HTML token out of an inline run:
 * `\u0002<index>\u0002` (the renderer strips U+0002 from the source, so it can't be forged).
 */
// deno-lint-ignore no-control-regex -- U+0002 delimits the marker
const RAW_MARK = /\u0002(\d+)\u0002/g;

/** Hold one raw-HTML token out of an inline run, returning its marker. */
export function rawMarker(index: number): string {
  return `\u0002${index}\u0002`;
}

/**
 * Merge an inline run the Markdown renderer produced (its own, trusted markup, with raw-HTML
 * tokens held out as markers) with those raw tokens, sanitized: one tree, so a raw tag is closed
 * inside the run it was written in and can never close the renderer's own elements.
 */
export function mergeRawInline(
  html: string,
  raws: readonly string[],
  policy: SanitizePolicy,
): string {
  const writer = new HtmlWriter(policy);
  for (const token of tokenizeHtml(html)) {
    if (token.type !== "text") {
      feed(writer, token, true);
      continue;
    }
    let last = 0;
    for (const m of token.text.matchAll(RAW_MARK)) {
      writer.text(token.text.slice(last, m.index));
      const raw = raws[Number(m[1])];
      const tag = raw === undefined ? null : scanTag(raw, 0);
      if (tag !== null) feed(writer, tag.token, false);
      last = m.index + m[0].length;
    }
    writer.text(token.text.slice(last));
  }
  return writer.finish();
}
