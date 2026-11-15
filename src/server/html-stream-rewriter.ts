// A first-party streaming HTML rewriter: element and end-tag handlers over a streaming tokenizer.
//
// The response-time injections that act on a STREAMED document (the desktop dev proxy's
// `__denext` global, React Native mode's late style sheets) used to either hold the whole body
// (`await res.text()`, then a regex splice) or search each chunk on its own (`indexOf`), which
// delays the first byte and every streamed Suspense hole until the document ends, misses a tag
// split across two chunks, and matches a tag inside a script's string literal, a style or a
// comment. This rewrites the stream as it flows, in the shape of Cloudflare's `HTMLRewriter`
// (lol_html): a handler sees each start tag and end tag as the HTML tokenizer reads it and may add
// markup before or after it, or change an attribute. Everything up to the last complete token of a
// chunk goes out with that chunk; only an unfinished tag (or the few characters that could start
// one) waits for the next chunk.
//
// It is plain TypeScript with no dependency (zero runtime npm), and independent of the runtime's
// own `HTMLRewriter` (./html-rewriter.ts), which is opt-in and slower per transform today.
//
// What it tokenizes, after the HTML Standard's tokenizer: comments (`<!--…-->`, `--!>` too),
// doctypes and bogus comments (`<!…>`, `<?…>`, `</ …>`), start and end tags (a quoted attribute
// value may hold `>`), and the elements whose content is text to the parser (`script`, `style`,
// `textarea`, `title`, `xmp`, `iframe`, `noembed`, `noframes`, `noscript`), whose content runs to
// the matching end tag: no handler ever runs inside a comment or one of those. Character
// references are not decoded (an attribute value is read as written). The script data escape
// states (`<!--` … `<script>` inside a script) are not modelled: such a script ends at its first
// `</script>`, as it does in every page denext renders.

/** One attribute of a start tag, as written. */
export interface RawAttribute {
  /** Its name, lowercased. */
  name: string;
  /** Its text from the name to the end of the value (quotes included). */
  raw: string;
  /** Its value as written, without quotes (`undefined`: no value). */
  value?: string;
}

/** Whether `c` is HTML whitespace. */
function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
}

/** Where an attribute's value ends in `src` (it starts at `at`), and the value. */
function readValue(src: string, at: number): { end: number; value: string } {
  const quote = src[at];
  if (quote === '"' || quote === "'") {
    const close = src.indexOf(quote, at + 1);
    const end = close === -1 ? src.length : close + 1;
    return { end, value: src.slice(at + 1, close === -1 ? end : close) };
  }
  let end = at;
  while (end < src.length && !isSpace(src[end])) end++;
  return { end, value: src.slice(at, end) };
}

/** The first index from `i` on that is not whitespace. */
function skipSpace(src: string, i: number): number {
  while (i < src.length && isSpace(src[i])) i++;
  return i;
}

/** The attribute starting at `start` (its name's first character) and where it ends. */
function readAttribute(src: string, start: number): { attribute: RawAttribute; end: number } {
  let i = start + 1; // a name may start with `=`
  while (i < src.length && !isSpace(src[i]) && src[i] !== "/" && src[i] !== "=") i++;
  const name = src.slice(start, i).toLowerCase();
  const eq = skipSpace(src, i);
  if (src[eq] !== "=") return { attribute: { name, raw: src.slice(start, i) }, end: i };
  const { end, value } = readValue(src, skipSpace(src, eq + 1));
  return { attribute: { name, raw: src.slice(start, end), value }, end };
}

/**
 * A start tag's attributes as the HTML tokenizer reads them (the text between the tag name and
 * `>`), and whether the tag closes itself (`/` right before `>`).
 *
 * @param src The text between the tag name and `>`.
 * @returns The attributes in order, and whether the tag is self-closing.
 */
export function parseAttributes(src: string): { attributes: RawAttribute[]; selfClosing: boolean } {
  const attributes: RawAttribute[] = [];
  let selfClosing = false;
  let i = 0;
  while (i < src.length) {
    if (isSpace(src[i])) {
      i++;
    } else if (src[i] === "/") {
      selfClosing = ++i === src.length;
    } else {
      const { attribute, end } = readAttribute(src, i);
      attributes.push(attribute);
      i = end;
    }
  }
  return { attributes, selfClosing };
}

/** What every tag handler argument offers: markup around the tag. */
interface HtmlTagContent {
  /** The tag name, lowercased. */
  readonly name: string;
  /** Write `html` (as is) right before the tag. */
  before(html: string): void;
  /** Write `html` (as is) right after the tag. */
  after(html: string): void;
}

/** A start tag, as a {@linkcode HtmlStreamHandlers.startTag} handler sees it. */
export interface HtmlStartTag extends HtmlTagContent {
  /** Whether the tag ends with `/>`. */
  readonly selfClosing: boolean;
  /** Whether the tag has the attribute (`name` is matched case-insensitively). */
  hasAttribute(name: string): boolean;
  /** The attribute's value as written (no quotes; `""` for a bare one), or `null`. */
  getAttribute(name: string): string | null;
  /**
   * Set the attribute: a present one is rewritten in place as `name="value"` (`"` escaped), an
   * absent one is added last. The tag is then written as `HTMLRewriter` writes a tag it changed:
   * the attributes as written, one space apart.
   */
  setAttribute(name: string, value: string): void;
}

/** An end tag, as a {@linkcode HtmlStreamHandlers.endTag} handler sees it. */
export type HtmlEndTag = HtmlTagContent;

/** What a handler may do with the rest of the document. */
export interface HtmlStreamControl {
  /** Stop tokenizing: everything after the current tag passes through as it is. */
  stop(): void;
}

/** The handlers of {@linkcode rewriteHtmlStream}. */
export interface HtmlStreamHandlers {
  /** Called for each start tag outside comments and raw-text elements, in document order. */
  startTag?(tag: HtmlStartTag, control: HtmlStreamControl): void;
  /** Called for each end tag outside comments and raw-text elements, in document order. */
  endTag?(tag: HtmlEndTag, control: HtmlStreamControl): void;
  /** Called once at the end of the document: markup to append (or nothing). */
  end?(): string | void;
}

/** The elements whose content the HTML parser reads as text, to their end tag. */
const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
]);

/** Whether `c` is an ASCII letter (a tag name's first character). */
function isAlpha(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

/**
 * Where the tag whose name starts at `from` ends (the index of its `>`), or -1 when `s` ends
 * first. A `>` inside a quoted attribute value does not end it.
 */
function tagEnd(s: string, from: number): number {
  let k = from;
  while (k < s.length) {
    const c = s[k];
    if (c === ">") return k;
    if (c !== "=") {
      k++;
      continue;
    }
    k = skipSpace(s, k + 1);
    if (k === s.length) return -1;
    const quote = s[k];
    if (quote !== '"' && quote !== "'") continue;
    const close = s.indexOf(quote, k + 1);
    if (close === -1) return -1;
    k = close + 1;
  }
  return -1;
}

/** Where the comment content from `i` ends (after `-->` or `--!>`), or -1. */
function commentEnd(s: string, i: number): number {
  for (let k = s.indexOf("--", i); k >= 0; k = s.indexOf("--", k + 1)) {
    if (s[k + 2] === ">") return k + 3;
    if (s[k + 2] === "!" && s[k + 3] === ">") return k + 4;
  }
  return -1;
}

/** `k`, or one less when `k` would split a surrogate pair (the output is re-encoded). */
function cut(s: string, k: number): number {
  const c = s.charCodeAt(k - 1);
  return c >= 0xd800 && c <= 0xdbff ? k - 1 : k;
}

/** The tag name at `from` (to whitespace, `/` or `>`) and where it ends. */
function tagName(s: string, from: number, end: number): { name: string; nameEnd: number } {
  let k = from;
  while (k < end && !isSpace(s[k]) && s[k] !== "/") k++;
  return { name: s.slice(from, k).toLowerCase(), nameEnd: k };
}

/** A start tag handler argument over the tag `raw` (`<name …>`), recording what it is asked. */
class StartTag implements HtmlStartTag {
  readonly name: string;
  readonly selfClosing: boolean;
  #rawName: string;
  #attributes: RawAttribute[];
  #changed = false;
  #before = "";
  #after = "";

  constructor(raw: string, name: string, nameLength: number) {
    this.name = name;
    this.#rawName = raw.slice(1, 1 + nameLength);
    const parsed = parseAttributes(raw.slice(1 + nameLength, -1));
    this.#attributes = parsed.attributes;
    this.selfClosing = parsed.selfClosing;
  }

  #find(name: string): RawAttribute | undefined {
    const lower = name.toLowerCase();
    return this.#attributes.find((a) => a.name === lower);
  }

  hasAttribute(name: string): boolean {
    return this.#find(name) !== undefined;
  }

  getAttribute(name: string): string | null {
    const a = this.#find(name);
    return a === undefined ? null : a.value ?? "";
  }

  setAttribute(name: string, value: string): void {
    const raw = `${name}="${value.replace(/"/g, "&quot;")}"`;
    const a = this.#find(name);
    if (a) {
      a.raw = raw;
      a.value = value;
    } else this.#attributes.push({ name: name.toLowerCase(), raw, value });
    this.#changed = true;
  }

  before(html: string): void {
    this.#before += html;
  }

  after(html: string): void {
    this.#after += html;
  }

  /** The tag as it goes out: `raw` unless an attribute changed, with the added markup. */
  write(raw: string): string {
    const tag = this.#changed
      ? `<${this.#rawName}${this.#attributes.map((a) => " " + a.raw).join("")}${
        this.selfClosing ? " /" : ""
      }>`
      : raw;
    return this.#before + tag + this.#after;
  }
}

/** An end tag handler argument, recording the markup around it. */
class EndTag implements HtmlEndTag {
  readonly name: string;
  before_ = "";
  after_ = "";
  constructor(name: string) {
    this.name = name;
  }
  before(html: string): void {
    this.before_ += html;
  }
  after(html: string): void {
    this.after_ += html;
  }
}

/** The incremental tokenizer behind {@linkcode rewriteHtmlStream}. */
class HtmlStreamTokenizer {
  #handlers: HtmlStreamHandlers;
  #mode: "data" | "comment" | "raw" | "stopped" = "data";
  #rawEnd: RegExp | null = null;
  #rawTail = 0;
  /** Input not tokenized yet: an unfinished construct carried to the next chunk. */
  #carry = "";
  #out = "";
  #control: HtmlStreamControl = { stop: () => this.#mode = "stopped" };

  constructor(handlers: HtmlStreamHandlers) {
    this.#handlers = handlers;
  }

  /** Tokenize `text` (after what was carried) and return the output it completes. */
  push(text: string, final = false): string {
    const s = this.#carry + text;
    this.#carry = "";
    let i = 0;
    while (i < s.length) {
      const next = this.#step(s, i, final);
      if (next < 0) {
        this.#carry = s.slice(-next - 1);
        break;
      }
      i = next;
    }
    const out = this.#out;
    this.#out = "";
    return out;
  }

  /** The end of the document: what is still carried, then the `end` handler's markup. */
  finish(): string {
    const out = this.push("", true) + this.#carry;
    this.#carry = "";
    return out + (this.#handlers.end?.() ?? "");
  }

  /**
   * One step from `i`: the index to go on from, or `-(at + 1)` to carry `s` from `at` to the next
   * chunk.
   */
  #step(s: string, i: number, final: boolean): number {
    switch (this.#mode) {
      case "stopped":
        this.#out += s.slice(i);
        return s.length;
      case "comment":
        return this.#comment(s, i, final);
      case "raw":
        return this.#raw(s, i, final);
      default:
        return this.#data(s, i, final);
    }
  }

  /** In a comment: on to its end (`-->` or `--!>`), keeping a possible partial end. */
  #comment(s: string, i: number, final: boolean): number {
    const end = commentEnd(s, i);
    if (end < 0) {
      const keep = final ? s.length : Math.max(i, cut(s, s.length - 3));
      this.#out += s.slice(i, keep);
      return keep === s.length ? keep : -(keep + 1);
    }
    this.#out += s.slice(i, end);
    this.#mode = "data";
    return end;
  }

  /** In a raw-text element: on to its end tag, keeping a possible partial one. */
  #raw(s: string, i: number, final: boolean): number {
    const re = this.#rawEnd!;
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) {
      const keep = final ? s.length : Math.max(i, cut(s, s.length - this.#rawTail));
      this.#out += s.slice(i, keep);
      return keep === s.length ? keep : -(keep + 1);
    }
    this.#out += s.slice(i, m.index);
    this.#mode = "data";
    return m.index; // the end tag itself is tokenized in data
  }

  /** In data: text to the next `<`, then the construct it starts. */
  #data(s: string, i: number, final: boolean): number {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      this.#out += s.slice(i);
      return s.length;
    }
    this.#out += s.slice(i, lt);
    return this.#construct(s, lt, final);
  }

  /** The construct the `<` at `lt` starts. */
  #construct(s: string, lt: number, final: boolean): number {
    if (lt + 1 === s.length) return final ? this.#text(lt) : -(lt + 1);
    const c = s[lt + 1];
    if (c === "!") return this.#markup(s, lt, final);
    if (c === "?") return this.#bogus(s, lt, final);
    if (c === "/") return this.#endTag(s, lt, final);
    return isAlpha(c) ? this.#startTag(s, lt, final) : this.#text(lt);
  }

  /** A `<` that starts nothing: text. */
  #text(lt: number): number {
    this.#out += "<";
    return lt + 1;
  }

  /** `<!`: a comment, or a doctype / CDATA / bogus comment (to `>`). */
  #markup(s: string, lt: number, final: boolean): number {
    // The fewest characters that tell the construct apart: `<!--` plus an abrupt `>` / `->`.
    if (!final && s.length - lt < 6) return -(lt + 1);
    if (!s.startsWith("<!--", lt)) return this.#bogus(s, lt, final);
    const body = lt + 4;
    if (s.startsWith(">", body) || s.startsWith("->", body)) { // `<!-->`, `<!--->`
      const end = s.indexOf(">", body) + 1;
      this.#out += s.slice(lt, end);
      return end;
    }
    this.#out += "<!--";
    this.#mode = "comment";
    return body;
  }

  /** A bogus comment or doctype: to the next `>`. */
  #bogus(s: string, lt: number, final: boolean): number {
    const gt = s.indexOf(">", lt + 2);
    if (gt < 0) return this.#unfinished(s, lt, final);
    this.#out += s.slice(lt, gt + 1);
    return gt + 1;
  }

  /** A construct `s` ends inside of: carried, or (at the end of the document) written as is. */
  #unfinished(s: string, lt: number, final: boolean): number {
    if (!final) return -(lt + 1);
    this.#out += s.slice(lt);
    return s.length;
  }

  /** `</`: an end tag, `</>` (dropped by the parser; kept), or a bogus comment. */
  #endTag(s: string, lt: number, final: boolean): number {
    if (lt + 2 === s.length) return this.#unfinished(s, lt, final);
    if (!isAlpha(s[lt + 2])) return this.#bogus(s, lt, final);
    const gt = tagEnd(s, lt + 2);
    if (gt < 0) return this.#unfinished(s, lt, final);
    const raw = s.slice(lt, gt + 1);
    const handler = this.#handlers.endTag;
    if (!handler) {
      this.#out += raw;
      return gt + 1;
    }
    const tag = new EndTag(tagName(s, lt + 2, gt).name);
    handler(tag, this.#control);
    this.#out += tag.before_ + raw + tag.after_;
    return gt + 1;
  }

  /** A start tag: the handler, then raw-text mode for the elements that have it. */
  #startTag(s: string, lt: number, final: boolean): number {
    const gt = tagEnd(s, lt + 1);
    if (gt < 0) return this.#unfinished(s, lt, final);
    const raw = s.slice(lt, gt + 1);
    const { name, nameEnd } = tagName(s, lt + 1, gt);
    const handler = this.#handlers.startTag;
    if (handler) {
      const tag = new StartTag(raw, name, nameEnd - lt - 1);
      handler(tag, this.#control);
      this.#out += tag.write(raw);
    } else this.#out += raw;
    // A raw-text element's content is text to its end tag, `<script/>` included.
    if (this.#mode === "data" && RAW_TEXT.has(name)) {
      this.#mode = "raw";
      this.#rawEnd = new RegExp(`</${name}[\\t\\n\\f\\r />]`, "gi");
      this.#rawTail = name.length + 2;
    }
    return gt + 1;
  }
}

/**
 * `stream` (an HTML document) rewritten as it flows: each start and end tag outside comments and
 * raw-text elements goes through `handlers`. Each chunk's output goes out with it (only an
 * unfinished tag waits for the next chunk), so the first bytes and every streamed Suspense hole
 * are not held until the document ends. The document is read as UTF-8.
 *
 * @param stream The document's bytes.
 * @param handlers What to do at each tag, and at the end.
 * @returns The rewritten document's bytes.
 */
export function rewriteHtmlStream(
  stream: ReadableStream<Uint8Array>,
  handlers: HtmlStreamHandlers,
): ReadableStream<Uint8Array> {
  const tokenizer = new HtmlStreamTokenizer(handlers);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const enqueue = (c: TransformStreamDefaultController<Uint8Array>, text: string) => {
    if (text) c.enqueue(encoder.encode(text));
  };
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        enqueue(controller, tokenizer.push(decoder.decode(chunk, { stream: true })));
      },
      flush(controller) {
        enqueue(controller, tokenizer.push(decoder.decode()) + tokenizer.finish());
      },
    }),
  );
}

/**
 * {@linkcode rewriteHtmlStream} over a document held as a string (the same tokenizer and
 * handlers, in one pass).
 *
 * @param html The document.
 * @param handlers What to do at each tag, and at the end.
 * @returns The rewritten document.
 */
export function rewriteHtml(html: string, handlers: HtmlStreamHandlers): string {
  const tokenizer = new HtmlStreamTokenizer(handlers);
  return tokenizer.push(html) + tokenizer.finish();
}
