// Reading side of the docker-compose round-trip editor (`compose-edit.ts`): the model the
// `denext ui` Docker panel renders, and the line spans the editor splices.
//
// `@std/yaml` answers WHAT a compose file says; this module answers WHERE it says it. It walks
// the file's lines with a strict, indentation-aware reading of block YAML — one mapping key or
// sequence item per head line, its value on that line or on deeper lines below it — and hands
// back line spans the editor splices. It never decides meaning on its own: the editor
// cross-checks every span against the parsed document, and a file this reading cannot follow
// (flow style, anchors, several documents) is reported as opaque rather than guessed at.
//
// Build-time only; never imported by a shipped bundle.

import { parse } from "@std/yaml";
import { isGeneratedDockerFile } from "./docker-template.ts";

/** A file as lines, remembering its line ending and final newline so a rejoin is byte-exact. */
export interface Doc {
  /** The file's lines, without their line endings. */
  readonly lines: string[];
  /** The line ending the file uses (`"\n"` or `"\r\n"`). */
  readonly eol: string;
  /** Whether the file ends with a line ending. */
  readonly finalNewline: boolean;
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

/** A bare mapping key, a `"double"`- or a `'single'`-quoted one, then `:` and a space or EOL. */
const KEY =
  /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([A-Za-z0-9_$./][\w$./-]*))[ \t]*:(?=[ \t]|$)/;
/** A block-sequence item indicator. */
const ITEM = /^-(?=[ \t]|$)/;
/** A YAML document marker (`---` / `...`) at column 0. */
const DOC_MARKER = /^(?:---|\.\.\.)(?:[ \t]|$)/;
/** An anchor (`&a`) or alias (`*a`) where a YAML node may start. */
const NODE_PROPERTY = /(?:^|:[ \t]+|-[ \t]+|[[{,][ \t]*)[&*][^\s,[\]{}]/;
/** A merge key. */
const MERGE_KEY = /<<[ \t]*:/;
/** Quoted scalars, blanked before the syntax gate looks for anchors and merge keys. */
const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g;

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

/** Split a file into lines — or null when CRLF and LF are mixed (no exact rejoin). */
function splitDoc(text: string): Doc | null {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1;
  if (crlf !== 0 && crlf !== lf) return null;
  const eol = crlf ? "\r\n" : "\n";
  const finalNewline = text.endsWith("\n");
  const body = finalNewline ? text.slice(0, -eol.length) : text;
  return { lines: body === "" && !finalNewline ? [] : body.split(eol), eol, finalNewline };
}

/**
 * Join lines back into a file with `doc`'s line ending and final-newline state.
 *
 * @param doc The file the lines came from.
 * @param lines The (edited) lines.
 * @returns The file's new contents.
 */
export function joinDoc(doc: Doc, lines: readonly string[]): string {
  return lines.join(doc.eol) + (doc.finalNewline && lines.length ? doc.eol : "");
}

/** The number of leading spaces on a line. */
function indentOf(line: string): number {
  return line.length - line.replace(/^ +/, "").length;
}

/**
 * Whether a line carries no YAML content: blank, or only a comment.
 *
 * @param line One line.
 * @returns Whether the line is blank or a comment.
 */
export function isInert(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
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
 * Whether a head line carries no inline value (only, at most, a comment) — its value, if any,
 * is the block on the lines below.
 *
 * @param line The head line.
 * @param head Its parsed head.
 * @returns Whether the rest of the line is empty or a comment.
 */
export function restEmpty(line: string, head: Head): boolean {
  const rest = line.slice(head.valueCol);
  return rest === "" || rest.startsWith("#");
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
 * Refuse what a line splice cannot follow: document markers (several documents) and anchors,
 * aliases and merge keys (one edit could change several places at once).
 */
function syntaxGate(lines: readonly string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    if (DOC_MARKER.test(lines[i])) return `line ${i + 1} is a YAML document marker`;
    if (isInert(lines[i])) continue;
    const code = lines[i].trim().replace(QUOTED, '""').replace(/(^|\s)#.*$/, "");
    if (NODE_PROPERTY.test(code) || MERGE_KEY.test(code)) {
      return `line ${i + 1} uses a YAML anchor, alias or merge key`;
    }
  }
  return null;
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
    const value = parse(text);
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
  /** `profiles:` entries. */
  profiles: string[];
  /** Whether the service is written out as comments (only `toggleService` applies to it). */
  commented: boolean;
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
}

/** An active service's lines: its entry under `services:` plus its fields by key. */
export interface Service extends Entry {
  fields: Map<string, Entry>;
  fieldIndent: number;
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
  if (doc === null) return "the file mixes CRLF and LF line endings";
  // A YAML parser treats U+2028 / U+2029 / NEL as line breaks where a line splicer (and a
  // reader of the panel) does not, so a crafted file could hide a key or a whole service from
  // the editor that docker still runs. Such a file is read-only.
  if (LINE_SEPARATORS.test(text)) {
    return "the file holds a Unicode line separator (U+2028, U+2029 or NEL)";
  }
  let raw: unknown;
  try {
    raw = parse(text);
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

/** Whether a scan found exactly the keys the parse did. */
function sameKeys(found: Map<string, Entry>, raw: Raw): boolean {
  const keys = Object.keys(raw);
  return keys.length === found.size && keys.every((k) => found.has(k));
}

/** Locate `services:`, every active service and field, and the commented services. */
function locate(text: string, doc: Doc, raw: Raw): State | string {
  const lines = doc.lines;
  const top = toMap(scanBlock(lines, 0, lines.length, keyHead, true));
  if (typeof top === "string") return top;
  const entry = top.get("services");
  if (
    !entry || entry.indent !== 0 || !sameKeys(top, raw) || !restEmpty(lines[entry.start], entry)
  ) {
    return "`services:` is not a block mapping denext can locate line by line";
  }
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
    const fields = restEmpty(lines[e.start], e)
      ? toMap(scanBlock(lines, e.start + 1, e.end, keyHead, true))
      : `service "${name}" is written in flow style`;
    if (typeof fields === "string") return fields;
    if (!sameKeys(fields, raw[name] as Raw)) {
      return `the fields of service "${name}" could not be located line by line`;
    }
    const first = fields.values().next().value;
    out.set(name, { ...e, fields, fieldIndent: first ? first.indent : e.indent + 2 });
  }
  return out;
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

/** One service's model entry. */
function describe(name: string, v: Raw, commented: boolean, index: number): ComposeService {
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
    profiles: texts(v.profiles),
    commented,
    line: index + 1,
  };
}

/**
 * The panel's model of a loaded file.
 *
 * @param state A file {@linkcode load} read.
 * @returns Its model.
 */
export function toModel(state: State): ComposeModel {
  const services = (state.raw.services ?? {}) as Raw;
  const active = [...state.services.values()]
    .map((s) => describe(s.key, services[s.key] as Raw, false, s.start));
  const commented = state.commented.map((c) => describe(c.name, c.value, true, c.start));
  return {
    sentinel: isGeneratedDockerFile(state.text),
    services: [...active, ...commented].sort((a, b) => a.line - b.line),
    volumes: isMapping(state.raw.volumes) ? Object.keys(state.raw.volumes) : [],
  };
}
