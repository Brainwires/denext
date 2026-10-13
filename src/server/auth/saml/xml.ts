/**
 * A minimal, strict XML 1.0 + Namespaces parser for SAML messages.
 *
 * It builds a small DOM (elements, text, comments, processing instructions) and refuses
 * anything SAML never needs and attackers love: any DOCTYPE or markup declaration (so no
 * external entities and no entity expansion), undefined entity references, duplicate
 * attributes (by qualified and by expanded name), unbound prefixes, illegal characters,
 * unbalanced tags, inputs over {@link MAX_XML_BYTES} and nesting deeper than
 * {@link MAX_XML_DEPTH}. Line endings and attribute whitespace are normalized as the XML
 * spec requires, so canonicalization sees exactly what a conforming parser would.
 *
 * @module
 */

import { SamlError } from "./errors.ts";

/** The namespace the `xml:` prefix is permanently bound to. */
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

/** The largest document accepted, in UTF-8 bytes. */
export const MAX_XML_BYTES = 256 * 1024;
/** The deepest element nesting accepted. */
export const MAX_XML_DEPTH = 64;

/** An attribute (namespace declarations are kept apart, in {@link XmlElement.nsDecls}). */
export interface XmlAttr {
  /** The qualified name as written (`prefix:local` or `local`). */
  qname: string;
  /** The prefix, or `""` for an unprefixed attribute. */
  prefix: string;
  /** The local name. */
  local: string;
  /** The namespace URI; `""` for an unprefixed attribute. */
  ns: string;
  /** The normalized value (references resolved, literal whitespace folded to spaces). */
  value: string;
}

/** A text node (character data and CDATA sections, merged when adjacent). */
export interface XmlText {
  type: "text";
  value: string;
}

/** A comment node. */
export interface XmlComment {
  type: "comment";
  value: string;
}

/** A processing instruction. */
export interface XmlPi {
  type: "pi";
  target: string;
  data: string;
}

/** An element. */
export interface XmlElement {
  type: "element";
  /** The qualified name as written. */
  qname: string;
  /** The prefix, or `""`. */
  prefix: string;
  /** The local name. */
  local: string;
  /** The namespace URI (`""` when the element is in no namespace). */
  ns: string;
  /** Ordinary attributes, in document order. */
  attrs: XmlAttr[];
  /** Namespace declarations made on this element: `[prefix, uri]`, `""` = the default. */
  nsDecls: [string, string][];
  /** Child nodes, in document order. */
  children: XmlNode[];
  /** The parent element, or `null` for the document element. */
  parent: XmlElement | null;
}

/** Any node in an element's content. */
export type XmlNode = XmlElement | XmlText | XmlComment | XmlPi;

/** A parsed document. */
export interface XmlDocument {
  /** The document element. */
  root: XmlElement;
  /** Every element, in document order (the root first). */
  elements: XmlElement[];
}

function fail(message: string): never {
  throw new SamlError("malformed_xml", message);
}

// XML 1.0 (5th edition) Char, NameStartChar and NameChar.
const ILLEGAL_CHAR = /[^\t\n\x20-퟿-�\u{10000}-\u{10FFFF}]/u;
const NC_START =
  "A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}";
const NC_CHAR = NC_START + "\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040";
const NAME_RE = new RegExp(`[${NC_START}:][${NC_CHAR}:]*`, "uy");
const NCNAME_RE = new RegExp(`^[${NC_START}][${NC_CHAR}]*$`, "u");

/** Whether `s` is an XML NCName (a name with no colon) — the lexical space of `xs:ID`. */
export function isNcName(s: string): boolean {
  return NCNAME_RE.test(s);
}

const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function isValidCodePoint(cp: number): boolean {
  return cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
}

const DECLARATION = /^<!(DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)/i;

interface RawAttr {
  qname: string;
  value: string;
}

/** Split a qualified name into `[prefix, local]`, refusing empty parts and extra colons. */
function splitQName(qname: string): [string, string] {
  const i = qname.indexOf(":");
  if (i === -1) return ["", qname];
  const prefix = qname.slice(0, i);
  const local = qname.slice(i + 1);
  if (!prefix || !local || local.includes(":")) fail(`bad qualified name "${qname}"`);
  return [prefix, local];
}

class Parser {
  private pos = 0;
  private readonly elements: XmlElement[] = [];

  constructor(private readonly s: string) {}

  parse(): XmlDocument {
    const s = this.s;
    if (s.startsWith("<?xml") && /^<\?xml[\s?]/.test(s)) this.xmlDecl();
    this.misc();
    if (s[this.pos] !== "<") fail("missing document element");
    const root = this.element(null, 1);
    this.misc();
    if (this.pos !== s.length) fail("content after the document element");
    return { root, elements: this.elements };
  }

  private xmlDecl(): void {
    const end = this.s.indexOf("?>");
    if (end === -1) fail("unterminated XML declaration");
    const decl = this.s.slice(5, end);
    const m =
      /^\s+version\s*=\s*(["'])1\.0\1(\s+encoding\s*=\s*(["'])([A-Za-z][\w.-]*)\3)?(\s+standalone\s*=\s*(["'])(yes|no)\6)?\s*$/
        .exec(decl);
    if (!m) fail("bad XML declaration");
    if (m[4] && m[4].toLowerCase() !== "utf-8") fail(`unsupported encoding "${m[4]}"`);
    this.pos = end + 2;
  }

  /** Comments, PIs and whitespace outside the document element. */
  private misc(): void {
    const s = this.s;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === " " || c === "\t" || c === "\n") {
        this.pos++;
      } else if (s.startsWith("<!--", this.pos)) {
        this.comment();
      } else if (s.startsWith("<?", this.pos)) {
        this.pi();
      } else if (s.startsWith("<!", this.pos)) {
        this.declaration();
      } else {
        return;
      }
    }
  }

  private declaration(): never {
    if (DECLARATION.test(this.s.slice(this.pos, this.pos + 12))) {
      throw new SamlError("doctype_forbidden", "DOCTYPE and markup declarations are refused");
    }
    fail("unexpected markup declaration");
  }

  private name(): string {
    NAME_RE.lastIndex = this.pos;
    const m = NAME_RE.exec(this.s);
    if (!m) fail(`expected a name at offset ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }

  private skipSpace(): boolean {
    const start = this.pos;
    while (this.pos < this.s.length) {
      const c = this.s[this.pos];
      if (c !== " " && c !== "\t" && c !== "\n") break;
      this.pos++;
    }
    return this.pos > start;
  }

  private comment(): XmlComment {
    const start = this.pos + 4;
    const end = this.s.indexOf("--", start);
    if (end === -1) fail("unterminated comment");
    if (this.s[end + 2] !== ">") fail('"--" inside a comment');
    this.pos = end + 3;
    return { type: "comment", value: this.s.slice(start, end) };
  }

  private pi(): XmlPi {
    this.pos += 2;
    const target = this.name();
    if (target.includes(":")) fail("colon in a processing instruction target");
    if (target.toLowerCase() === "xml") fail("misplaced XML declaration");
    const end = this.s.indexOf("?>", this.pos);
    if (end === -1) fail("unterminated processing instruction");
    let data = "";
    if (end > this.pos) {
      if (!this.skipSpace()) fail("bad processing instruction");
      data = this.s.slice(this.pos, end);
    }
    this.pos = end + 2;
    return { type: "pi", target, data };
  }

  /** Resolve `&…;` references in `raw` (text or an attribute value). */
  private references(raw: string): string {
    if (!raw.includes("&")) return raw;
    return raw.replace(/&([^;]*);?/g, (whole, ref: string) => {
      if (!whole.endsWith(";")) fail("unterminated reference");
      if (Object.hasOwn(PREDEFINED, ref)) return PREDEFINED[ref];
      const m = /^#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}))$/.exec(ref);
      if (!m) fail(`undefined entity "&${ref};"`);
      const cp = m[1] ? parseInt(m[1], 16) : parseInt(m[2], 10);
      if (!isValidCodePoint(cp)) fail("character reference to an illegal character");
      return String.fromCodePoint(cp);
    });
  }

  private attrValue(): string {
    const q = this.s[this.pos];
    if (q !== '"' && q !== "'") fail("unquoted attribute value");
    const end = this.s.indexOf(q, this.pos + 1);
    if (end === -1) fail("unterminated attribute value");
    const raw = this.s.slice(this.pos + 1, end);
    if (raw.includes("<")) fail('"<" in an attribute value');
    this.pos = end + 1;
    // Literal whitespace folds to a space before references resolve (XML 1.0 §3.3.3).
    return this.references(raw.replace(/[\t\n]/g, " "));
  }

  /** The attributes of a start tag, up to (not including) its `>` or `/>`. */
  private startTagAttributes(): RawAttr[] {
    const raw: RawAttr[] = [];
    for (;;) {
      const spaced = this.skipSpace();
      const c = this.s[this.pos];
      if (c === ">" || c === "/") return raw;
      if (c === undefined) fail("unterminated start tag");
      if (!spaced) fail("attributes must be separated by whitespace");
      const name = this.name();
      this.skipSpace();
      if (this.s[this.pos] !== "=") fail("expected = after an attribute name");
      this.pos++;
      this.skipSpace();
      raw.push({ qname: name, value: this.attrValue() });
    }
  }

  private element(parent: XmlElement | null, depth: number): XmlElement {
    if (depth > MAX_XML_DEPTH) fail("document nests too deeply");
    this.pos++; // "<"
    const qname = this.name();
    const el = resolveElement(qname, this.startTagAttributes(), parent);
    this.elements.push(el);
    if (this.s[this.pos] === "/") {
      if (this.s[this.pos + 1] !== ">") fail("bad empty-element tag");
      this.pos += 2;
      return el;
    }
    this.pos++; // ">"
    this.content(el, depth);
    this.endTag(qname);
    return el;
  }

  /** The end tag `</qname>` (content() stopped at its `</`). */
  private endTag(qname: string): void {
    this.pos += 2;
    const close = this.name();
    if (close !== qname) fail(`</${close}> closes <${qname}>`);
    this.skipSpace();
    if (this.s[this.pos] !== ">") fail("bad end tag");
    this.pos++;
  }

  private pushText(el: XmlElement, value: string): void {
    if (!value) return;
    const last = el.children[el.children.length - 1];
    if (last && last.type === "text") last.value += value;
    else el.children.push({ type: "text", value });
  }

  private cdata(el: XmlElement): void {
    const start = this.pos + 9;
    const end = this.s.indexOf("]]>", start);
    if (end === -1) fail("unterminated CDATA section");
    this.pushText(el, this.s.slice(start, end));
    this.pos = end + 3;
  }

  /** One markup construct at `this.pos` inside `el` (never an end tag). */
  private markup(el: XmlElement, depth: number): void {
    const s = this.s;
    const at = this.pos;
    if (s.startsWith("<!--", at)) el.children.push(this.comment());
    else if (s.startsWith("<![CDATA[", at)) this.cdata(el);
    else if (s.startsWith("<!", at)) this.declaration();
    else if (s.startsWith("<?", at)) el.children.push(this.pi());
    else el.children.push(this.element(el, depth + 1));
  }

  private content(el: XmlElement, depth: number): void {
    const s = this.s;
    for (;;) {
      const lt = s.indexOf("<", this.pos);
      if (lt === -1) fail(`unterminated element <${el.qname}>`);
      if (lt > this.pos) {
        const raw = s.slice(this.pos, lt);
        if (raw.includes("]]>")) fail('"]]>" in character data');
        this.pushText(el, this.references(raw));
        this.pos = lt;
      }
      if (s.startsWith("</", lt)) return;
      this.markup(el, depth);
    }
  }
}

/** Validate one `xmlns` / `xmlns:p` declaration; `null` for a redundant `xmlns:xml`. */
function namespaceDeclaration(a: RawAttr): [string, string] | null {
  const prefix = a.qname === "xmlns" ? "" : splitQName(a.qname)[1];
  const reserved = a.value === XML_NS || a.value === XMLNS_NS;
  if (prefix === "xmlns") fail("the xmlns prefix cannot be declared");
  if (prefix === "xml") {
    if (a.value !== XML_NS) fail("the xml prefix cannot be rebound");
    return null; // permitted and redundant: no namespace node to render
  }
  if (reserved) fail(`reserved namespace bound to "${prefix}"`);
  if (prefix && !a.value) fail(`empty namespace for prefix "${prefix}"`);
  return [prefix, a.value];
}

const isNamespaceDeclaration = (a: RawAttr) => a.qname === "xmlns" || a.qname.startsWith("xmlns:");

/** Bind an element's and its attributes' prefixes, refusing duplicates and unbound prefixes. */
function resolveElement(qname: string, raw: RawAttr[], parent: XmlElement | null): XmlElement {
  const seen = new Set<string>();
  for (const a of raw) {
    if (seen.has(a.qname)) fail(`duplicate attribute "${a.qname}"`);
    seen.add(a.qname);
  }
  const nsDecls: [string, string][] = [];
  for (const a of raw.filter(isNamespaceDeclaration)) {
    const decl = namespaceDeclaration(a);
    if (decl) nsDecls.push(decl);
  }
  const [prefix, local] = splitQName(qname);
  const el: XmlElement = {
    type: "element",
    qname,
    prefix,
    local,
    ns: "",
    attrs: [],
    nsDecls,
    children: [],
    parent,
  };
  el.ns = boundNamespace(el, prefix);
  const expanded = new Set<string>();
  for (const a of raw) {
    if (isNamespaceDeclaration(a)) continue;
    const [ap, al] = splitQName(a.qname);
    const ans = ap ? boundNamespace(el, ap) : "";
    const key = `${ans} ${al}`;
    if (expanded.has(key)) fail(`duplicate attribute {${ans}}${al}`);
    expanded.add(key);
    el.attrs.push({ qname: a.qname, prefix: ap, local: al, ns: ans, value: a.value });
  }
  return el;
}

function boundNamespace(el: XmlElement, prefix: string): string {
  const ns = lookupNamespace(el, prefix);
  if (ns === undefined) fail(`unbound prefix "${prefix}"`);
  return ns;
}

/**
 * The namespace URI `prefix` is bound to at `el` (`""` = the default namespace, which
 * resolves to `""` when undeclared), or `undefined` when the prefix is unbound.
 */
export function lookupNamespace(el: XmlElement | null, prefix: string): string | undefined {
  if (prefix === "xml") return XML_NS;
  for (let e = el; e; e = e.parent) {
    for (const [p, uri] of e.nsDecls) if (p === prefix) return uri;
  }
  return prefix === "" ? "" : undefined;
}

/**
 * Parse a UTF-8 SAML document strictly.
 *
 * @param input The document, as decoded text or as UTF-8 bytes.
 * @throws {SamlError} `malformed_xml` or `doctype_forbidden`.
 */
export function parseXml(input: string | Uint8Array): XmlDocument {
  let text: string;
  if (typeof input === "string") {
    text = input;
    if (text.length > MAX_XML_BYTES) fail("document too large");
  } else {
    if (input.byteLength > MAX_XML_BYTES) fail("document too large");
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      fail("document is not valid UTF-8");
    }
  }
  if (new TextEncoder().encode(text).byteLength > MAX_XML_BYTES) fail("document too large");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // XML 1.0 §2.11: every CR LF and lone CR becomes LF before parsing.
  text = text.replace(/\r\n?/g, "\n");
  if (ILLEGAL_CHAR.test(text)) fail("illegal character in the document");
  return new Parser(text).parse();
}

/** The child elements of `el` with namespace `ns` and local name `local`. */
export function childElements(el: XmlElement, ns: string, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) {
    if (c.type === "element" && c.ns === ns && c.local === local) out.push(c);
  }
  return out;
}

/** The value of the unprefixed (no-namespace) attribute `local`, or `undefined`. */
export function attr(el: XmlElement, local: string): string | undefined {
  for (const a of el.attrs) if (a.ns === "" && a.local === local) return a.value;
  return undefined;
}
