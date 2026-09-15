// Reading side of the docker-compose round-trip editor (`compose-edit.ts`): the model the
// `denext ui` Docker panel renders, and the line spans the editor splices.
//
// `@std/yaml` answers WHAT a compose file says; this module answers WHERE it says it. It walks
// the file's lines with a strict, indentation-aware reading of block YAML — one mapping key or
// sequence item per head line, its value on that line or on deeper lines below it — and hands
// back line spans the editor splices. It never decides meaning on its own: the editor
// cross-checks every span against the parsed document, and a file this reading cannot follow
// (several documents, a flow-style top level) is reported as opaque rather than guessed at.
// Anchors, aliases and merge keys are followed: a service or field whose value an alias or a
// merge key supplies is located as such, and the editor decides what an edit to it may do.
//
// Build-time only; never imported by a shipped bundle.

import { parse } from "@std/yaml";
import { isGeneratedDockerFile } from "./docker-template.ts";

/** A file as lines, each with the break that ended it, so a rejoin is byte-exact. */
export interface Doc {
  /** The file's lines, without their line breaks. */
  readonly lines: string[];
  /** The break after each line: `"\n"`, `"\r\n"` or `"\r"` (`""` after a last line without one). */
  readonly eols: string[];
}

/** A run of lines, `[start, end)` as 0-based line indices. */
export interface Span {
  /** First line of the run. */
  start: number;
  /** One past the last line of the run. */
  end: number;
}

/** Where a head line's parts sit: what {@linkcode HeadParser} recognises. */
export interface Head {
  /** The mapping key (`""` for a sequence item). */
  key: string;
  /** Column just past the `:` of a key or the `-` of an item. */
  headEnd: number;
  /** Column the inline value starts at (the line's length when there is none). */
  valueCol: number;
}

/** One block-mapping key or block-sequence item plus the lines its value occupies. */
export interface Entry extends Span, Head {
  /** Leading spaces of the head line. */
  indent: number;
}

/** Reads a head (`key:` or `-`) that starts at column `indent`, or null when there is none. */
export type HeadParser = (line: string, indent: number) => Head | null;

/** A service written out as comments — the way `renderCompose` ships its Postgres example. */
export interface CommentedBlock extends Span {
  /** The service name (the block's first line, uncommented, is `name:`). */
  name: string;
  /** The service mapping the uncommented block parses to. */
  value: Record<string, unknown>;
}

/**
 * A bare mapping key (or the merge key `<<`), a `"double"`- or a `'single'`-quoted one, then `:`
 * and a space or EOL.
 */
const KEY =
  /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|(<<|[A-Za-z0-9_$./][\w$./-]*))[ \t]*:(?=[ \t]|$)/;
/** A block-sequence item indicator. */
const ITEM = /^-(?=[ \t]|$)/;
/** A YAML document marker (`---` / `...`) at column 0. */
const DOC_MARKER = /^(?:---|\.\.\.)(?:[ \t]|$)/;
/** A document marker with nothing after it but a comment — a line a splice can pass over. */
const BARE_MARKER = /^(?:---|\.\.\.)[ \t]*(?:#.*)?$/;
/** Node properties — anchors (`&a`) and tags (`!t`) — that may precede a node on its line. */
const PROPERTIES = /^(?:[&!]\S*[ \t]*)*/;
/** An anchor's name where a YAML node may start (quoted scalars and comments blanked first). */
const ANCHOR = /(?:^|[\s:[{,-])&([\w.-]+)/;
/** Quoted scalars, blanked before a line is searched for syntax. */
const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g;
/**
 * Compose's own tags (`!reset`, `!override`), which a generic YAML parser refuses. They are
 * blanked (same length, so every column stays put) before the file is parsed.
 */
const COMPOSE_TAG = /(^|[\s[{,:-])!(?:reset|override)(?=[\s,\]}]|$)/g;
/** A line break: CRLF, LF, or a lone CR — every break a YAML parser splits a line at. */
const BREAK = /\r\n|\r|\n/g;

/**
 * Whether `value` is a plain YAML mapping (not a sequence, not null).
 *
 * @param value A parsed YAML value.
 * @returns Whether it is a mapping.
 */
export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    !(value instanceof Date);
}

/** Split a file into lines at every break a YAML parser sees, keeping each break. */
function splitDoc(text: string): Doc {
  const lines: string[] = [];
  const eols: string[] = [];
  let from = 0;
  for (const m of text.matchAll(BREAK)) {
    lines.push(text.slice(from, m.index));
    eols.push(m[0]);
    from = m.index + m[0].length;
  }
  if (from < text.length) {
    lines.push(text.slice(from));
    eols.push("");
  }
  return { lines, eols };
}

/** The break a new line gets at `at`: its neighbour's, else the file's first, else LF. */
function breakAt(doc: Doc, at: number): string {
  return doc.eols[at - 1] || doc.eols[at] || doc.eols.find((eol) => eol !== "") || "\n";
}

/**
 * Replace `remove` lines at `at` with `insert` and rejoin the file. A replaced line keeps the
 * break it had, a new line takes its neighbour's, and the file keeps its final-newline state —
 * so a file that mixes line endings stays exactly as mixed outside the lines an edit touched.
 *
 * @param doc The file.
 * @param at First line replaced.
 * @param remove How many lines are replaced.
 * @param insert The lines put in their place (without breaks).
 * @returns The file's new contents.
 */
export function spliceDoc(
  doc: Doc,
  at: number,
  remove: number,
  insert: readonly string[],
): string {
  const fill = breakAt(doc, at);
  const kept = doc.eols.slice(at, at + remove);
  const lines = [...doc.lines];
  const eols = [...doc.eols];
  lines.splice(at, remove, ...insert);
  eols.splice(at, remove, ...insert.map((_, k) => kept[k] ?? ""));
  const last = lines.length - 1;
  const bare = doc.eols.at(-1) === "";
  const end = (i: number) => (i === last && bare ? "" : eols[i] || fill);
  return lines.map((line, i) => line + end(i)).join("");
}

/** The number of leading spaces on a line. */
function indentOf(line: string): number {
  return line.length - line.replace(/^ +/, "").length;
}

/**
 * Whether a line carries no YAML content: blank, only a comment, or a bare document marker.
 *
 * @param line One line.
 * @returns Whether the line is blank or a comment.
 */
export function isInert(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#") || BARE_MARKER.test(line);
}

/** The column the value starts at: past `headEnd` and the whitespace after it. */
function valueColOf(line: string, headEnd: number): number {
  return headEnd + (line.slice(headEnd).length - line.slice(headEnd).replace(/^[ \t]+/, "").length);
}

/** A quoted key's text, or null when it uses an escape JSON does not share. */
function decodeKey(m: RegExpExecArray): string | null {
  if (m[3] !== undefined) return m[3];
  if (m[2] !== undefined) return m[2].replaceAll("''", "'");
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
}

/**
 * Read a block-mapping key (`key:`, `"key":`, `'key':`) starting at column `indent`.
 *
 * @param line One line.
 * @param indent The column the key must start at.
 * @returns The key and its columns, or null when the line is not a key line.
 */
export function keyHead(line: string, indent: number): Head | null {
  const m = KEY.exec(line.slice(indent));
  const key = m ? decodeKey(m) : null;
  if (m === null || key === null) return null;
  const headEnd = indent + m[0].length;
  return { key, headEnd, valueCol: valueColOf(line, headEnd) };
}

/**
 * Read a block-sequence item (`- value`) starting at column `indent`.
 *
 * @param line One line.
 * @param indent The column the `-` must sit at.
 * @returns The item's columns (key `""`), or null when the line is not an item line.
 */
export function itemHead(line: string, indent: number): Head | null {
  if (!ITEM.test(line.slice(indent))) return null;
  return { key: "", headEnd: indent + 1, valueCol: valueColOf(line, indent + 1) };
}

/**
 * A head line's inline value, past any anchor or tag: `""` or a comment when the value (if
 * any) is the block on the lines below.
 *
 * @param line The head line.
 * @param head Its parsed head.
 * @returns The rest of the line after the node properties.
 */
export function inlineValue(line: string, head: Head): string {
  return line.slice(head.valueCol).replace(PROPERTIES, "");
}

/**
 * Whether a head line carries no inline value (only, at most, an anchor, a tag and a comment) —
 * its value, if any, is the block on the lines below.
 *
 * @param line The head line.
 * @param head Its parsed head.
 * @returns Whether the rest of the line is empty or a comment.
 */
export function restEmpty(line: string, head: Head): boolean {
  const rest = inlineValue(line, head);
  return rest === "" || rest.startsWith("#");
}

/**
 * The first anchor (`&name`) the lines define, outside quoted scalars and comments.
 *
 * @param lines Some of the file's lines.
 * @returns The anchor's name, or null when the lines define none.
 */
export function anchorIn(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (isInert(line)) continue;
    const m = ANCHOR.exec(line.replace(QUOTED, '""').replace(/(^|\s)#.*$/, ""));
    if (m) return m[1];
  }
  return null;
}

/**
 * Where the block opened at line `start` ends: every following line deeper than `indent` (and,
 * with `items`, a `-` item at `indent` — YAML's compact sequence under a key), plus comment
 * lines deeper than `indent` that directly follow it. Blank lines and shallower comments
 * trailing the block are left outside it.
 */
function blockEnd(
  lines: readonly string[],
  start: number,
  limit: number,
  indent: number,
  items: boolean,
): number {
  let end = start + 1;
  for (let i = start + 1; i < limit; i++) {
    const line = lines[i];
    const ind = indentOf(line);
    if (line.trim() === "") continue;
    if (line.trimStart().startsWith("#")) {
      if (ind > indent && end === i) end = i + 1;
      continue;
    }
    if (ind < indent || (ind === indent && !(items && ITEM.test(line.slice(ind))))) break;
    end = i + 1;
  }
  return end;
}

/**
 * Scan the children of one block: every content line in `[start, end)` must be a head at one
 * shared indentation; each child spans its head plus its value's lines.
 *
 * @param lines The file's lines.
 * @param start First line to scan.
 * @param end One past the last line to scan.
 * @param head Recognises a child's head line ({@linkcode keyHead} or {@linkcode itemHead}).
 * @param items Whether a `-` item at a child's own indentation still belongs to that child.
 * @returns The children in source order, or why the block cannot be read line by line.
 */
export function scanBlock(
  lines: readonly string[],
  start: number,
  end: number,
  head: HeadParser,
  items: boolean,
): Entry[] | string {
  const out: Entry[] = [];
  let indent = -1;
  for (let i = start; i < end; i++) {
    if (isInert(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (indent === -1) indent = ind;
    const h = ind === indent ? head(lines[i], ind) : null;
    if (h === null) return `line ${i + 1} is not in the block layout denext can edit`;
    const stop = blockEnd(lines, i, end, ind, items);
    out.push({ ...h, start: i, end: stop, indent: ind });
    i = stop - 1;
  }
  return out;
}

/**
 * Blank Compose's own tags so a generic YAML parser reads the file (see {@linkcode COMPOSE_TAG}):
 * `!reset null` parses as `null`, `!override [x]` as `[x]`.
 */
function blankComposeTags(text: string): string {
  if (!text.includes("!")) return text;
  const masked = text.replace(QUOTED, (q) => "\0".repeat(q.length));
  let out = "";
  let from = 0;
  for (const m of masked.matchAll(COMPOSE_TAG)) {
    const at = m.index + m[1].length;
    const length = m[0].length - m[1].length;
    out += text.slice(from, at) + " ".repeat(length);
    from = at + length;
  }
  return out + text.slice(from);
}

/**
 * Parse a compose file (or a block of one) the way the editor reads it: Compose's tags blanked.
 *
 * @param text YAML text.
 * @returns The parsed value (throws on a syntax error).
 */
function parseCompose(text: string): unknown {
  return parse(blankComposeTags(text));
}

/** Index mapping entries by key, refusing a key written twice. */
function toMap(entries: Entry[] | string): Map<string, Entry> | string {
  if (typeof entries === "string") return entries;
  const map = new Map<string, Entry>();
  for (const e of entries) {
    if (map.has(e.key)) return `duplicate key "${e.key}" at line ${e.start + 1}`;
    map.set(e.key, e);
  }
  return map;
}

/**
 * Refuse a document marker that carries content (`--- {…}`). A bare one can only open or close
 * the single document the parser already accepted, so the scan passes over it.
 */
function syntaxGate(lines: readonly string[]): string | null {
  const at = lines.findIndex((line) => DOC_MARKER.test(line) && !BARE_MARKER.test(line));
  return at === -1 ? null : `line ${at + 1} puts content on a YAML document marker`;
}

/**
 * Comment one line out exactly as `renderCompose`'s `commentOut` does: `# ` after `indent`
 * leading spaces, an empty line left empty.
 *
 * @param line One line.
 * @param indent The column the `# ` goes at.
 * @returns The commented line.
 */
export function commentLine(line: string, indent: number): string {
  return line === "" ? line : line.slice(0, indent) + "# " + line.slice(indent);
}

/**
 * The exact inverse of {@linkcode commentLine}: drop the `# ` at column `indent`.
 *
 * @param line A line that has `# ` at column `indent`.
 * @param indent The column the `# ` sits at.
 * @returns The uncommented line.
 */
export function uncommentLine(line: string, indent: number): string {
  return line.slice(0, indent) + line.slice(indent + 2);
}

/** The service mapping a commented block uncomments to, or null when it is not exactly one. */
function blockValue(
  block: readonly string[],
  indent: number,
  name: string,
): Record<string, unknown> | null {
  const text = block.map((l) => uncommentLine(l, indent).slice(indent)).join("\n");
  try {
    const value = parseCompose(text);
    if (!isMapping(value) || Object.keys(value).length !== 1) return null;
    return isMapping(value[name]) ? value[name] : null;
  } catch {
    return null;
  }
}

/**
 * One past the last line from `from` on that carries `nested` (a commented, deeper line),
 * running through blank lines that the block continues after.
 */
function commentRunEnd(
  lines: readonly string[],
  from: number,
  to: number,
  nested: string,
  covered: (line: number) => boolean,
): number {
  const open = (i: number) => i < to && !covered(i);
  let j = from;
  while (open(j)) {
    if (lines[j].startsWith(nested)) {
      j++;
      continue;
    }
    // A blank line inside a commented service belongs to it when the block carries on
    // after it; otherwise enabling the service would uncomment only its first half.
    let k = j;
    while (open(k) && lines[k].trim() === "") k++;
    if (k === j || !open(k) || !lines[k].startsWith(nested)) break;
    j = k;
  }
  return j;
}

/**
 * Services written out as comments in `[from, to)`: a run of lines with `# ` at the services'
 * indentation, the first reading `name:` once uncommented and the rest nested below it, that
 * parses as exactly one service mapping. Lines of an active service (`covered`) never count;
 * a name already found is not reported twice.
 */
function findCommented(
  lines: readonly string[],
  from: number,
  to: number,
  indent: number,
  covered: (line: number) => boolean,
): CommentedBlock[] {
  const prefix = " ".repeat(indent) + "# ";
  const out: CommentedBlock[] = [];
  for (let i = from; i < to; i++) {
    if (covered(i) || !lines[i].startsWith(prefix)) continue;
    const first = uncommentLine(lines[i], indent);
    const head = keyHead(first, indent);
    if (head === null || !restEmpty(first, head)) continue;
    const j = commentRunEnd(lines, i + 1, to, prefix + " ", covered);
    const value = blockValue(lines.slice(i, j), indent, head.key);
    if (value === null || out.some((c) => c.name === head.key)) continue;
    out.push({ name: head.key, value, start: i, end: j });
    i = j - 1;
  }
  return out;
}

// --- the model --------------------------------------------------------------

type Raw = Record<string, unknown>;

/** One service as the Docker panel shows it: an active one, or one written out as comments. */
export interface ComposeService {
  /** The service's key under `services:`. */
  name: string;
  /** `image:`, when set to a scalar. */
  image?: string;
  /** `build:` as parsed (a context path or a mapping), when present. */
  build?: unknown;
  /** `restart:`, when set to a scalar. */
  restart?: string;
  /** `ports:` entries in order; a long-syntax (mapping) entry is its JSON text. */
  ports: string[];
  /** `environment:` entries in order; a variable without a value has value `""`. */
  environment: { key: string; value: string }[];
  /** `KEY: value` mapping or `- KEY=value` list (`"map"` when there is no `environment:`). */
  envForm: "list" | "map";
  /** `volumes:` entries in order; a long-syntax (mapping) entry is its JSON text. */
  volumes: string[];
  /** Services `depends_on:` names (the list, or the long form's keys). */
  dependsOn: string[];
  /** `networks:` the service joins (the list, or the long form's keys). */
  networks: string[];
  /** `profiles:` entries. */
  profiles: string[];
  /** Whether the service is written out as comments (only `toggleService` applies to it). */
  commented: boolean;
  /** Fields the service takes from a merge key (`<<`) rather than writing them itself. */
  inherited: string[];
  /**
   * How an active service's value is written when it is not a block mapping: an alias of
   * another node (`web: *base`) or a flow mapping (`web: { image: x }`). The first edit
   * rewrites it as a block mapping.
   */
  inline?: "alias" | "flow";
  /** 1-based line of the service's `name:` line (`# name:` when commented). */
  line: number;
}

/** A compose file the editor can round-trip. */
export interface ComposeModel {
  /** Whether the file carries the `denext generate docker` sentinel (regenerating is safe). */
  sentinel: boolean;
  /** Active and commented services, in source order. */
  services: ComposeService[];
  /** Top-level named volumes. */
  volumes: string[];
  /** The top-level `networks:` keys. */
  networks: string[];
}

/** An active service's lines: its entry under `services:` plus its fields by key. */
export interface Service extends Entry {
  /** Its fields by key (empty for an inline service); `<<` is a merge key. */
  fields: Map<string, Entry>;
  /** The column its fields start at. */
  fieldIndent: number;
  /** Set when its value is not a block mapping (see {@linkcode ComposeService.inline}). */
  inline?: "alias" | "flow";
}

/** A compose file read both ways — parsed, and located line by line. */
export interface State {
  text: string;
  doc: Doc;
  raw: Raw;
  services: Map<string, Service>;
  commented: CommentedBlock[];
  /** The services' indentation (where a commented service's `# ` sits). */
  indent: number;
  /**
   * The `services:` entry, when its value is a flow mapping (or an alias) rather than a block
   * one: every service then shares its lines, and the first edit rewrites it as block mappings.
   */
  servicesInline?: Entry;
}

/** U+2028, U+2029 and NEL: line breaks to a YAML parser, but not to a line splicer. */
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029, 0x85)}]`);

/**
 * Parse, gate and locate a compose file.
 *
 * @param text The file's contents.
 * @returns The file read both ways, or why it is opaque.
 */
export function load(text: string): State | string {
  const doc = splitDoc(text);
  // A YAML parser treats U+2028 / U+2029 / NEL as line breaks where a line splicer (and a
  // reader of the panel) does not, so a crafted file could hide a key or a whole service from
  // the editor that docker still runs. Such a file is read-only.
  if (LINE_SEPARATORS.test(text)) {
    return "the file holds a Unicode line separator (U+2028, U+2029 or NEL)";
  }
  let raw: unknown;
  try {
    raw = parseCompose(text);
  } catch (e) {
    return `the file does not parse as YAML: ${String((e as Error).message).split("\n")[0]}`;
  }
  const refusal = shapeGate(raw) ?? syntaxGate(doc.lines);
  return refusal ?? locate(text, doc, raw as Raw);
}

/** The top level must be a mapping whose `services` is a mapping of mappings (or empty). */
function shapeGate(raw: unknown): string | null {
  if (!isMapping(raw)) return "the top level of the file is not a mapping";
  const services = raw.services;
  if (services === undefined) return "the file has no `services:` key";
  if (services !== null && !isMapping(services)) return "`services:` is not a mapping";
  const bad = Object.entries(services ?? {}).find(([, v]) => !isMapping(v));
  return bad ? `service "${bad[0]}" is not a mapping` : null;
}

/**
 * Whether a scan found exactly the keys the parse did. Behind a merge key (`<<`) the parse also
 * holds the keys the merge supplied, so there the scan's own keys only have to be among them.
 */
function sameKeys(found: Map<string, Entry>, raw: Raw): boolean {
  const own = [...found.keys()].filter((key) => key !== "<<");
  if (!own.every((key) => Object.hasOwn(raw, key))) return false;
  return found.has("<<") || own.length === Object.keys(raw).length;
}

/** Locate `services:`, every active service and field, and the commented services. */
function locate(text: string, doc: Doc, raw: Raw): State | string {
  const lines = doc.lines;
  const top = toMap(scanBlock(lines, 0, lines.length, keyHead, true));
  if (typeof top === "string") return top;
  const entry = top.get("services");
  if (!entry || entry.indent !== 0 || !sameKeys(top, raw)) {
    return "`services:` is not a mapping denext can locate line by line";
  }
  if (!restEmpty(lines[entry.start], entry)) return inlineServices(text, doc, raw, entry);
  const services = scanServices(lines, entry, (raw.services ?? {}) as Raw);
  if (typeof services === "string") return services;
  const later = [...top.values()].map((e) => e.start).filter((s) => s > entry.start);
  const regionEnd = Math.min(lines.length, ...later);
  const spans: Span[] = [...services.values()];
  const indent = spans.length
    ? (spans[0] as Service).indent
    : guessIndent(lines, entry.start + 1, regionEnd);
  const covered = (i: number) => spans.some((s) => i >= s.start && i < s.end);
  const commented = findCommented(lines, entry.start + 1, regionEnd, indent, covered)
    .filter((c) => !services.has(c.name));
  return { text, doc, raw, services, commented, indent };
}

/** `services:` written as a flow mapping (or an alias): every service shares its lines. */
function inlineServices(text: string, doc: Doc, raw: Raw, entry: Entry): State {
  const services = new Map<string, Service>();
  for (const name of Object.keys(isMapping(raw.services) ? raw.services : {})) {
    services.set(name, { ...entry, key: name, fields: new Map(), fieldIndent: 4, inline: "flow" });
  }
  return { text, doc, raw, services, commented: [], indent: 2, servicesInline: entry };
}

/** The services' indentation when none is active: the first indented comment's, else 2. */
function guessIndent(lines: readonly string[], from: number, to: number): number {
  for (let i = from; i < to; i++) {
    const m = /^( +)# \S/.exec(lines[i]);
    if (m) return m[1].length;
  }
  return 2;
}

/** Every active service with its fields, cross-checked against the parsed services. */
function scanServices(
  lines: readonly string[],
  entry: Entry,
  raw: Raw,
): Map<string, Service> | string {
  const found = toMap(scanBlock(lines, entry.start + 1, entry.end, keyHead, true));
  if (typeof found === "string") return found;
  if (!sameKeys(found, raw)) return "the services could not be located line by line";
  const out = new Map<string, Service>();
  for (const [name, e] of found) {
    const service = serviceAt(lines, name, e, raw[name] as Raw);
    if (typeof service === "string") return service;
    out.set(name, service);
  }
  return out;
}

/** One active service located: its fields, or — an alias or a flow mapping — just its lines. */
function serviceAt(lines: readonly string[], name: string, e: Entry, raw: Raw): Service | string {
  if (!restEmpty(lines[e.start], e)) {
    const inline = inlineValue(lines[e.start], e).startsWith("*") ? "alias" : "flow";
    return { ...e, fields: new Map(), fieldIndent: e.indent + 2, inline };
  }
  const fields = toMap(scanBlock(lines, e.start + 1, e.end, keyHead, true));
  if (typeof fields === "string") return fields;
  if (!sameKeys(fields, raw)) {
    return `the fields of service "${name}" could not be located line by line`;
  }
  const first = fields.values().next().value;
  return { ...e, fields, fieldIndent: first ? first.indent : e.indent + 2 };
}

/** A parsed scalar as text; a mapping or sequence as its JSON. */
function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/**
 * A parsed sequence's entries as text (anything else: none).
 *
 * @param v A parsed value.
 * @returns Its entries as text.
 */
export function texts(v: unknown): string[] {
  return Array.isArray(v) ? v.map(text) : [];
}

/** Whether a parsed value is a scalar (not absent, null, a mapping or a sequence). */
function isScalar(v: unknown): boolean {
  return v !== undefined && v !== null && typeof v !== "object";
}

/**
 * `environment:` as ordered key/value pairs, from either form.
 *
 * @param env The parsed `environment:` value.
 * @returns Its variables in order.
 */
export function envEntries(env: unknown): { key: string; value: string }[] {
  if (isMapping(env)) {
    return Object.entries(env).map(([key, value]) => ({ key, value: text(value) }));
  }
  return texts(env).map((item) => {
    const eq = item.indexOf("=");
    return eq === -1
      ? { key: item, value: "" }
      : { key: item.slice(0, eq), value: item.slice(eq + 1) };
  });
}

/** How an active service came to hold its fields: what a merge key supplied, and its form. */
type Provenance = Pick<ComposeService, "inherited" | "inline">;

/** One service's model entry. */
function describe(
  name: string,
  v: Raw,
  commented: boolean,
  index: number,
  provenance: Provenance,
): ComposeService {
  return {
    name,
    ...(isScalar(v.image) ? { image: text(v.image) } : {}),
    ...(v.build !== undefined ? { build: v.build } : {}),
    ...(isScalar(v.restart) ? { restart: text(v.restart) } : {}),
    ports: texts(v.ports),
    environment: envEntries(v.environment),
    envForm: Array.isArray(v.environment) ? "list" : "map",
    volumes: texts(v.volumes),
    dependsOn: isMapping(v.depends_on) ? Object.keys(v.depends_on) : texts(v.depends_on),
    networks: isMapping(v.networks) ? Object.keys(v.networks) : texts(v.networks),
    profiles: texts(v.profiles),
    commented,
    line: index + 1,
    ...provenance,
  };
}

/** Where an active service's fields come from (see {@linkcode Provenance}). */
function provenanceOf(service: Service, raw: Raw): Provenance {
  const inherited = service.fields.has("<<")
    ? Object.keys(raw).filter((key) => !service.fields.has(key))
    : [];
  return service.inline ? { inherited, inline: service.inline } : { inherited };
}

/**
 * The panel's model of a loaded file.
 *
 * @param state A file {@linkcode load} read.
 * @returns Its model.
 */
export function toModel(state: State): ComposeModel {
  const services = (state.raw.services ?? {}) as Raw;
  const active = [...state.services.values()].map((s) => {
    const raw = services[s.key] as Raw;
    return describe(s.key, raw, false, s.start, provenanceOf(s, raw));
  });
  const commented = state.commented
    .map((c) => describe(c.name, c.value, true, c.start, { inherited: [] }));
  return {
    sentinel: isGeneratedDockerFile(state.text),
    services: [...active, ...commented].sort((a, b) => a.line - b.line),
    volumes: isMapping(state.raw.volumes) ? Object.keys(state.raw.volumes) : [],
    networks: isMapping(state.raw.networks) ? Object.keys(state.raw.networks) : [],
  };
}
