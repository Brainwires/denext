// A small XML property-list reader and writer, for files denext merges as data rather than
// splices as text: the iOS privacy manifest (`PrivacyInfo.xcprivacy`), whose accessed-API and
// collected-data entries are arrays of dicts, and the Info.plist / entitlements values
// `denext mobile doctor` reads. Every element Apple's plist DTD defines round-trips (dict,
// array, string, integer, real, date, data, true, false), with the text of scalars kept
// verbatim, so a merge that only adds entries never loses one the file already had.
// Comments and formatting are not kept: callers write only when the value changed.

/** One plist value. Scalars keep their text as written (numbers and dates are not parsed). */
export type PlistNode =
  | { readonly kind: "dict"; readonly entries: Array<[string, PlistNode]> }
  | { readonly kind: "array"; readonly items: PlistNode[] }
  | { readonly kind: "string" | "integer" | "real" | "date" | "data"; readonly text: string }
  | { readonly kind: "bool"; readonly value: boolean };

/** A dict node. */
export type PlistDict = Extract<PlistNode, { kind: "dict" }>;

/** A tag, a comment or a declaration of the XML (group 1: `/`, 2: name, 4: `/` self-closing). */
const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z]+)([^>]*?)(\/?)>/g;

/** A parse position: the text and the offset just past the last token read. */
interface Cursor {
  readonly text: string;
  at: number;
}

/** The XML entities a plist may use, decoded. */
function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

/** `&`, `<` and `>` escaped for element text. */
function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The next element tag at or after the cursor (comments and declarations skipped). */
function nextTag(c: Cursor): RegExpExecArray {
  TOKEN.lastIndex = c.at;
  for (let m = TOKEN.exec(c.text); m; m = TOKEN.exec(c.text)) {
    if (m[2] === undefined) continue;
    c.at = TOKEN.lastIndex;
    return m;
  }
  throw new Error("unexpected end of the plist");
}

/** The text up to `</name>`, the cursor moved past it. */
function elementText(c: Cursor, name: string): string {
  const close = c.text.indexOf(`</${name}>`, c.at);
  if (close < 0) throw new Error(`<${name}> is not closed`);
  const text = c.text.slice(c.at, close);
  c.at = close + name.length + 3;
  return unescapeXml(text);
}

const SCALARS = ["string", "integer", "real", "date", "data"] as const;

/** The value whose opening tag `open` was just read. */
function readValue(c: Cursor, open: RegExpExecArray): PlistNode {
  const [, closing, name, , selfClosing] = open;
  if (closing) throw new Error(`unexpected </${name}>`);
  if (name === "true" || name === "false") {
    if (!selfClosing) elementText(c, name);
    return { kind: "bool", value: name === "true" };
  }
  if ((SCALARS as readonly string[]).includes(name)) {
    const text = selfClosing ? "" : elementText(c, name);
    return { kind: name as (typeof SCALARS)[number], text };
  }
  if (name === "array") return selfClosing ? { kind: "array", items: [] } : readArray(c);
  if (name === "dict") return selfClosing ? { kind: "dict", entries: [] } : readDict(c);
  throw new Error(`unknown plist element <${name}>`);
}

/** An `<array>`'s items, up to its `</array>`. */
function readArray(c: Cursor): PlistNode {
  const items: PlistNode[] = [];
  for (let tag = nextTag(c); !(tag[1] && tag[2] === "array"); tag = nextTag(c)) {
    items.push(readValue(c, tag));
  }
  return { kind: "array", items };
}

/** A `<dict>`'s key/value pairs, up to its `</dict>`. */
function readDict(c: Cursor): PlistNode {
  const entries: Array<[string, PlistNode]> = [];
  for (let tag = nextTag(c); !(tag[1] && tag[2] === "dict"); tag = nextTag(c)) {
    if (tag[2] !== "key" || tag[1]) throw new Error(`expected <key> in a dict, got <${tag[2]}>`);
    const key = elementText(c, "key");
    entries.push([key, readValue(c, nextTag(c))]);
  }
  return { kind: "dict", entries };
}

/**
 * Parse an XML property list.
 *
 * @param text The file's text.
 * @returns Its root value.
 * @throws When it is not a well-formed XML plist (a binary plist included).
 */
export function parsePlist(text: string): PlistNode {
  const c: Cursor = { text, at: 0 };
  const plist = nextTag(c);
  if (plist[2] !== "plist" || plist[1]) throw new Error("not an XML plist (no <plist> element)");
  return readValue(c, nextTag(c));
}

/** The XML header every plist Xcode writes starts with. */
const HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
`;

/** `node` as lines, each indented by `depth` tabs (Xcode's layout). */
function valueLines(node: PlistNode, depth: number): string[] {
  const pad = "\t".repeat(depth);
  switch (node.kind) {
    case "bool":
      return [`${pad}<${node.value}/>`];
    case "array":
      if (node.items.length === 0) return [`${pad}<array/>`];
      return [
        `${pad}<array>`,
        ...node.items.flatMap((v) => valueLines(v, depth + 1)),
        `${pad}</array>`,
      ];
    case "dict":
      if (node.entries.length === 0) return [`${pad}<dict/>`];
      return [
        `${pad}<dict>`,
        ...node.entries.flatMap(([k, v]) => [
          `${pad}\t<key>${escapeXml(k)}</key>`,
          ...valueLines(v, depth + 1),
        ]),
        `${pad}</dict>`,
      ];
    default:
      return [`${pad}<${node.kind}>${escapeXml(node.text)}</${node.kind}>`];
  }
}

/**
 * A property list as XML text, laid out as Xcode writes one (tabs, one element per line).
 *
 * @param root The root value (a dict for every file denext writes).
 * @returns The file text, ending in a newline.
 */
export function renderPlist(root: PlistNode): string {
  return `${HEADER}${valueLines(root, 0).join("\n")}\n</plist>\n`;
}

/** The value of `key` in `dict`, or undefined. */
export function dictGet(dict: PlistDict, key: string): PlistNode | undefined {
  return dict.entries.find(([k]) => k === key)?.[1];
}

/** A string node's text, or undefined for any other node. */
export function stringOf(node: PlistNode | undefined): string | undefined {
  return node?.kind === "string" ? node.text : undefined;
}

/** Whether two plist values are equal (dict key order counts). */
export function plistEqual(a: PlistNode, b: PlistNode): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
