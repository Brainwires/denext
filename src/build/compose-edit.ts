// Round-trip editing of `docker-compose.yml` for the `denext ui` Docker panel.
//
// A user who has added a service, a port or an env var to a compose file must not lose it to a
// regeneration — and `@std/yaml`'s `stringify` rebuilds every node, dropping the generated-file
// sentinel, the `# env_file` hint and the commented Postgres example `renderCompose()` writes.
// So nothing here re-serialises. Each edit follows the discipline `config-edit.ts` applies to
// TypeScript:
//
//   1. PARSE with @std/yaml — to validate, and to get the canonical model.
//   2. LOCATE the lines with an indentation-aware scan (`compose-scan.ts`) keyed on the parsed
//      service and field names; any disagreement between the two makes the file opaque.
//   3. SPLICE only the lines one operation touches, then RE-PARSE the result and compare it with
//      the same change applied to the parsed model — a mismatch is a refusal, never a write.
//
// The operation set is closed: image, restart, ports, environment, depends_on, volumes, and
// commenting a whole service out or back in. Every other byte of the file is left as it was.
//
// Build-time only; never imported by a shipped bundle.

import { parse } from "@std/yaml";
import type { EditResult } from "./config-edit.ts";
import { createUnifiedDiff } from "./patch-diff.ts";
import {
  commentLine,
  type ComposeModel,
  type Entry,
  envEntries,
  isInert,
  isMapping,
  itemHead,
  joinDoc,
  keyHead,
  load,
  restEmpty,
  scanBlock,
  type Service,
  type Span,
  type State,
  texts,
  toModel,
  uncommentLine,
} from "./compose-scan.ts";

export type { ComposeModel, ComposeService } from "./compose-scan.ts";

/** The file name compose diffs are labelled with. */
const LABEL = "docker-compose.yml";
/** How much of the file a refusal to read it quotes back. */
const SNIPPET_MAX = 200;
/** Words a YAML 1.1 reader (older compose tooling) takes for a boolean or null. */
const YAML11_WORDS = /^(?:y|n|yes|no|on|off|true|false|null|~)$/i;
/** Text a YAML reader may take for a number (or, in YAML 1.1, a sexagesimal `5432:5432`). */
const NUMBER_LIKE = /^[-+.]?\d/;
/** An environment variable name this editor writes. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
/**
 * Where a missing field is created: after the last of these fields that is present (after the
 * `name:` line when none is); a field not listed goes after the service's last field.
 */
const ANCHORS: Readonly<Record<string, readonly string[]>> = {
  image: [],
  ports: ["image", "build"],
  environment: ["image", "build", "ports"],
};

// --- public types -----------------------------------------------------------

/** One edit. {@linkcode applyComposeEdits} applies a list of them in order, all or nothing. */
export type ComposeOp =
  /**
   * Set `image`/`restart`/`build` (created when absent), or delete it with `value: null`.
   * `build` is a context path; a service whose `build:` is a mapping is refused.
   */
  | { op: "set"; service: string; field: "image" | "restart" | "build"; value: string | null }
  /** Append a `"host:container"` mapping, or remove/replace the entry at `index`. */
  | {
    op: "ports";
    service: string;
    action: "add" | "remove" | "update";
    index?: number;
    value?: string;
  }
  /** Set (add or overwrite) or delete one variable, in the form the service already uses. */
  | { op: "env"; service: string; action: "set" | "delete"; key: string; value?: string }
  /** Add or remove one `depends_on` / `volumes` / `networks` list entry, matched by its text. */
  | {
    op: "dependsOn" | "volumes" | "networks";
    service: string;
    action: "add" | "remove";
    value: string;
  }
  /** Comment an active service block out, or uncomment a commented one, byte for byte. */
  | { op: "toggleService"; service: string };

// --- internal types ---------------------------------------------------------

type Raw = Record<string, unknown>;
type SetOp = Extract<ComposeOp, { op: "set" }>;
type PortsOp = Extract<ComposeOp, { op: "ports" }>;
type EnvOp = Extract<ComposeOp, { op: "env" }>;
type NamedOp = Extract<ComposeOp, { op: "dependsOn" | "volumes" | "networks" }>;

/** Replace `remove` lines at `at` with `insert`. */
interface Splice {
  at: number;
  remove: number;
  insert: string[];
}

/** What the file must read back as once an edit is applied. */
interface Expected {
  raw: Raw;
  commented: Record<string, unknown>;
}

/** One operation, planned: its splice plus the same change applied to the parsed model. */
type Change = Splice & { expect: (want: Expected) => void };

/** One list edit resolved to positions. */
type ListEdit =
  | { kind: "add"; value: string; text: string }
  | { kind: "remove"; index: number }
  | { kind: "update"; index: number; value: string; text: string };

/** A service field's children (list items or mapping entries), located line by line. */
interface Children {
  field?: Entry;
  items: Entry[];
  indent: number;
}

// --- reading ----------------------------------------------------------------

/**
 * Read a compose file into the model the Docker panel renders.
 *
 * @param text The file's contents.
 * @returns The model, or null when the file is opaque — it does not parse, is not a mapping of
 * service mappings, or uses syntax a line splice cannot follow (anchors, aliases, merge keys,
 * flow-style services, several documents, mixed line endings).
 */
export function readCompose(text: string): ComposeModel | null {
  const state = load(text);
  return typeof state === "string" ? null : toModel(state);
}

// --- writing ----------------------------------------------------------------

/**
 * Apply compose edits by splicing lines, re-parsing after every one. Operations apply in
 * order; the first refusal fails the whole call and the input is returned untouched.
 *
 * @param text The compose file's current contents.
 * @param ops The edits, in order.
 * @param label The file name the diff is labelled with (default `docker-compose.yml`).
 * @returns The new contents and one unified diff for the whole call, or an honest refusal
 * (an opaque file, an unknown or commented-out service, a flow-style or long-syntax field, a
 * duplicate entry, or an edit that would not read back as intended).
 */
export function applyComposeEdits(
  text: string,
  ops: ComposeOp[],
  label: string = LABEL,
): EditResult {
  let state = load(text);
  if (typeof state === "string") return bail(state, text.slice(0, SNIPPET_MAX));
  for (const op of ops) {
    const next = step(state, op);
    if ("ok" in next) return next;
    state = next;
  }
  return { ok: true, source: state.text, diff: diffOf(text, state.text, label) };
}

/** A refusal, optionally carrying the patch the edit would have made. */
function bail(reason: string, snippet: string, diff?: string): EditResult {
  return diff ? { ok: false, reason, snippet, diff } : { ok: false, reason, snippet };
}

/** The unified diff of a proposed write, labelled the way `git diff` labels one. */
function diffOf(before: string, after: string, label: string = LABEL): string {
  return createUnifiedDiff(before, after, `a/${label}`, `b/${label}`);
}

/** The commented services by name (a fresh copy). */
function commentedOf(state: State): Record<string, unknown> {
  return Object.fromEntries(state.commented.map((c) => [c.name, structuredClone(c.value)]));
}

/** Apply one operation and prove it: the result must re-read as exactly the intended change. */
function step(state: State, op: ComposeOp): State | EditResult {
  const change = plan(state, op);
  if (typeof change === "string") return bail(change, JSON.stringify(op));
  const lines = [...state.doc.lines];
  lines.splice(change.at, change.remove, ...change.insert);
  const next = joinDoc(state.doc, lines);
  const want: Expected = { raw: structuredClone(state.raw), commented: commentedOf(state) };
  change.expect(want);
  const reread = load(next);
  if (
    typeof reread === "string" || !deepEqual(reread.raw, want.raw) ||
    !deepEqual(commentedOf(reread), want.commented)
  ) {
    const reason = "the edited file does not read back as the requested change — denext " +
      "refuses to write it";
    return bail(reason, JSON.stringify(op), diffOf(state.text, next));
  }
  return reread;
}

/** Plan one operation against the current file. */
function plan(state: State, op: ComposeOp): Change | string {
  switch (op.op) {
    case "set":
      return setScalar(state, op);
    case "ports":
      return editPorts(state, op);
    case "env":
      return editEnv(state, op);
    case "dependsOn":
    case "volumes":
    case "networks":
      return editNamed(state, op);
    case "toggleService":
      return toggle(state, op.service);
    default:
      return `unknown compose operation ${JSON.stringify((op as { op?: unknown }).op)}`;
  }
}

/** Structural equality of parsed YAML values (mapping key order ignored). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && deepEqual((a as Raw)[k], (b as Raw)[k]));
}

/** Whether `value` survives as itself when written as a plain (unquoted) YAML scalar. */
function plainReadsBack(value: string): boolean {
  if (value === "" || value !== value.trim() || /[\r\n\t]/.test(value)) return false;
  try {
    const back = parse(`k: ${value}`);
    return isMapping(back) && back.k === value;
  } catch {
    return false;
  }
}

/**
 * A string as a YAML scalar: plain when every YAML reader keeps it a string, else
 * double-quoted (JSON's escapes are valid YAML double-quoted escapes).
 */
function yamlScalar(value: string): string {
  const plain = !YAML11_WORDS.test(value) && !NUMBER_LIKE.test(value) && plainReadsBack(value);
  return plain ? value : JSON.stringify(value);
}

// --- splices ----------------------------------------------------------------

/** `n` spaces. */
function pad(n: number): string {
  return " ".repeat(n);
}

/** Delete a span. */
function cut(span: Span): Splice {
  return { at: span.start, remove: span.end - span.start, insert: [] };
}

/** Attach the expected change to a splice (a refusal passes through). */
function withExpect(splice: Splice | string, expect: Change["expect"]): Change | string {
  return typeof splice === "string" ? splice : { ...splice, expect };
}

/** Whether an entry's value continues on content lines below its head. */
function hasContent(lines: readonly string[], entry: Entry): boolean {
  return lines.slice(entry.start + 1, entry.end).some((l) => !isInert(l));
}

/** Where an inline scalar value ends: past a quoted scalar, or before a ` #` comment. */
function valueEnd(rest: string): number {
  const quoted = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/.exec(rest);
  if (quoted) return quoted[0].length;
  if (rest.startsWith("#")) return 0;
  const hash = rest.search(/[ \t]#/);
  return hash === -1 ? rest.length : hash;
}

/** The trailing comment an inline value carries (kept by a rewrite), or null for anything else. */
function commentTail(rest: string): string | null {
  const tail = rest.slice(valueEnd(rest));
  if (tail.trim() === "") return "";
  if (!tail.trim().startsWith("#")) return null;
  return /^\s/.test(tail) ? tail : " " + tail;
}

/**
 * Replace an entry's value with the scalar `text`: in place on its head line when the value is
 * inline (an inline comment is kept), else the whole entry becomes `lead + text`.
 */
function rewrite(
  lines: readonly string[],
  entry: Entry,
  text: string,
  lead: string,
): Splice | string {
  if (hasContent(lines, entry)) {
    return {
      at: entry.start,
      remove: entry.end - entry.start,
      insert: [pad(entry.indent) + lead + text],
    };
  }
  const line = lines[entry.start];
  const tail = commentTail(line.slice(entry.valueCol));
  if (tail === null) {
    return `line ${entry.start + 1} carries a value denext cannot rewrite in place`;
  }
  return { at: entry.start, remove: 1, insert: [line.slice(0, entry.headEnd) + " " + text + tail] };
}

/** The line a missing `key` field is created at (see {@linkcode ANCHORS}). */
function afterFields(svc: Service, key: string): number {
  const anchors = Object.hasOwn(ANCHORS, key) ? ANCHORS[key] : null;
  let at = svc.start + 1;
  for (const [k, f] of svc.fields) {
    if (anchors === null || anchors.includes(k)) at = Math.max(at, f.end);
  }
  return at;
}

/** The active service `name`, or why an edit cannot target it. */
function serviceOf(state: State, name: string): Service | string {
  const svc = state.services.get(name);
  if (svc) return svc;
  return state.commented.some((c) => c.name === name)
    ? `service "${name}" is commented out — enable it first`
    : `no service named "${name}"`;
}

/** A service's mapping inside a parsed document. */
function rawService(raw: Raw, name: string): Raw {
  return (raw.services as Raw)[name] as Raw;
}

/** How many children a parsed field value has. */
function countOf(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  return isMapping(v) ? Object.keys(v).length : 0;
}

/** An expectation that mutates one field's value, dropping the field when it ends up empty. */
function fieldExpect<T extends unknown[] | Raw>(
  service: string,
  key: string,
  empty: () => T,
  mutate: (value: T) => void,
): Change["expect"] {
  return (want) => {
    const s = rawService(want.raw, service);
    const value = (s[key] ?? empty()) as T;
    mutate(value);
    if (countOf(value)) s[key] = value;
    else delete s[key];
  };
}

/** Locate a block list/mapping field's children, refusing flow style and the other form. */
function childrenOf(
  state: State,
  svc: Service,
  key: string,
  form: "list" | "map",
): Children | string {
  const field = svc.fields.get(key);
  if (!field) return { items: [], indent: svc.fieldIndent + 2 };
  const lines = state.doc.lines;
  const value = rawService(state.raw, svc.key)[key];
  if (!restEmpty(lines[field.start], field)) {
    return `${key} of "${svc.key}" is written in flow style — edit it by hand`;
  }
  if (value !== null && (form === "list") !== Array.isArray(value)) {
    return `${key} of "${svc.key}" is not written as a ${form} — edit it by hand`;
  }
  const head = form === "list" ? itemHead : keyHead;
  const items = scanBlock(lines, field.start + 1, field.end, head, form === "map");
  if (typeof items === "string") return items;
  if (items.length !== countOf(value)) {
    return `the entries of ${key} in "${svc.key}" could not be located line by line`;
  }
  return { field, items, indent: items.length ? items[0].indent : field.indent + 2 };
}

/** Append one child line (`body` is the line without its indentation), creating the field. */
function append(svc: Service, key: string, ch: Children, body: string): Splice {
  const line = pad(ch.indent) + body;
  if (!ch.field) {
    return {
      at: afterFields(svc, key),
      remove: 0,
      insert: [pad(svc.fieldIndent) + key + ":", line],
    };
  }
  const last = ch.items[ch.items.length - 1];
  return { at: last ? last.end : ch.field.start + 1, remove: 0, insert: [line] };
}

/**
 * Remove one child — or the whole field when it is the only one. Comment lines inside the
 * field's span (a commented-out sibling entry, a note) are the user's, not the entry's, so they
 * stay where they were when the emptied field goes.
 */
function dropChild(lines: readonly string[], ch: Children, item: Entry): Splice {
  const field = ch.field;
  if (ch.items.length !== 1 || !field) return cut(item);
  const kept: string[] = [];
  for (let n = field.start + 1; n < field.end; n++) {
    const outside = n < item.start || n >= item.end;
    if (outside && lines[n].trim().startsWith("#")) kept.push(lines[n]);
  }
  return { ...cut(field), insert: kept };
}

// --- operations -------------------------------------------------------------

/** `set`: write, create or delete `image` / `restart`. */
function setScalar(state: State, op: SetOp): Change | string {
  const svc = serviceOf(state, op.service);
  if (typeof svc === "string") return svc;
  const field = svc.fields.get(op.field);
  if (
    op.field === "build" && field && typeof rawService(state.raw, op.service).build !== "string"
  ) {
    return `build of "${op.service}" is a mapping — edit it by hand`;
  }
  const expect = (want: Expected) => {
    const s = rawService(want.raw, op.service);
    if (op.value === null) delete s[op.field];
    else s[op.field] = op.value;
  };
  if (op.value === null) {
    return field
      ? { ...cut(field), expect }
      : `service "${op.service}" has no ${op.field} to delete`;
  }
  if (typeof op.value !== "string" || op.value === "") return `${op.field} needs a non-empty value`;
  const value = yamlScalar(op.value);
  if (field) return withExpect(rewrite(state.doc.lines, field, value, `${op.field}: `), expect);
  const insert = [pad(svc.fieldIndent) + `${op.field}: ${value}`];
  return { at: afterFields(svc, op.field), remove: 0, insert, expect };
}

/** Append, drop or replace one entry of a block list field. */
function editList(state: State, service: string, key: string, edit: ListEdit): Change | string {
  const svc = serviceOf(state, service);
  if (typeof svc === "string") return svc;
  const ch = childrenOf(state, svc, key, "list");
  if (typeof ch === "string") return ch;
  const expect = fieldExpect(service, key, (): unknown[] => [], (list) => {
    if (edit.kind === "add") list.push(edit.value);
    else if (edit.kind === "remove") list.splice(edit.index, 1);
    else list[edit.index] = edit.value;
  });
  if (edit.kind === "add") return { ...append(svc, key, ch, "- " + edit.text), expect };
  const item = ch.items[edit.index];
  if (!item) return `${key} of "${service}" has no entry #${edit.index}`;
  if (edit.kind === "remove") return { ...dropChild(state.doc.lines, ch, item), expect };
  return withExpect(rewrite(state.doc.lines, item, edit.text, "- "), expect);
}

/** `ports`: mappings are always double-quoted (`"5432:5432"` is a number to YAML 1.1). */
function editPorts(state: State, op: PortsOp): Change | string {
  const index = op.index ?? -1;
  if (op.action === "remove") {
    return editList(state, op.service, "ports", { kind: "remove", index });
  }
  if (typeof op.value !== "string" || op.value.trim() === "") return "a port mapping needs a value";
  const value = op.value;
  const text = JSON.stringify(value);
  if (op.action === "add") {
    return editList(state, op.service, "ports", { kind: "add", value, text });
  }
  if (op.action === "update") {
    return editList(state, op.service, "ports", { kind: "update", index, value, text });
  }
  return `unknown ports action ${JSON.stringify(op.action)}`;
}

/** `dependsOn` / `volumes`: add or remove one list entry, matched by its text. */
function editNamed(state: State, op: NamedOp): Change | string {
  const key = op.op === "dependsOn" ? "depends_on" : op.op;
  const svc = serviceOf(state, op.service);
  if (typeof svc === "string") return svc;
  const ch = childrenOf(state, svc, key, "list");
  if (typeof ch === "string") return ch;
  if (typeof op.value !== "string" || op.value === "") return `${key} needs a value`;
  const index = texts(rawService(state.raw, op.service)[key]).indexOf(op.value);
  if (op.action === "remove") {
    return index === -1
      ? `${key} of "${op.service}" does not list ${op.value}`
      : editList(state, op.service, key, { kind: "remove", index });
  }
  if (index !== -1) return `${key} of "${op.service}" already lists ${op.value}`;
  return editList(state, op.service, key, {
    kind: "add",
    value: op.value,
    text: yamlScalar(op.value),
  });
}

/** `env`: dispatch on the form the service's `environment:` is written in. */
function editEnv(state: State, op: EnvOp): Change | string {
  if (typeof op.key !== "string" || !ENV_KEY.test(op.key)) {
    return `${JSON.stringify(op.key)} is not an environment variable name denext writes`;
  }
  if (op.action === "set" && typeof op.value !== "string") return `setting ${op.key} needs a value`;
  const svc = serviceOf(state, op.service);
  if (typeof svc === "string") return svc;
  const env = rawService(state.raw, op.service).environment;
  return Array.isArray(env) ? envList(state, op, env) : envMap(state, svc, op);
}

/** The refusal for deleting a variable that is not set. */
function noEnv(op: EnvOp): string {
  return `environment of "${op.service}" has no ${op.key}`;
}

/** `env` against a `- KEY=value` list. */
function envList(state: State, op: EnvOp, env: unknown[]): Change | string {
  const hits = envEntries(env).flatMap((e, i) => e.key === op.key ? [i] : []);
  if (hits.length > 1) return `environment of "${op.service}" lists ${op.key} more than once`;
  const index = hits.length ? hits[0] : -1;
  if (op.action === "delete") {
    return index === -1
      ? noEnv(op)
      : editList(state, op.service, "environment", { kind: "remove", index });
  }
  const value = `${op.key}=${op.value}`;
  const text = yamlScalar(value);
  const edit: ListEdit = index === -1
    ? { kind: "add", value, text }
    : { kind: "update", index, value, text };
  return editList(state, op.service, "environment", edit);
}

/** `env` against a `KEY: value` mapping (also how a missing `environment:` is created). */
function envMap(state: State, svc: Service, op: EnvOp): Change | string {
  const ch = childrenOf(state, svc, "environment", "map");
  if (typeof ch === "string") return ch;
  const entry = ch.items.find((e) => e.key === op.key);
  const expect = fieldExpect(op.service, "environment", (): Raw => ({}), (env) => {
    if (op.action === "delete") delete env[op.key];
    else env[op.key] = op.value;
  });
  if (op.action === "delete") {
    return entry ? { ...dropChild(state.doc.lines, ch, entry), expect } : noEnv(op);
  }
  const text = yamlScalar(String(op.value));
  if (entry) return withExpect(rewrite(state.doc.lines, entry, text, `${op.key}: `), expect);
  return { ...append(svc, "environment", ch, `${op.key}: ${text}`), expect };
}

/** `toggleService`: comment an active service out, or a commented one back in. */
function toggle(state: State, name: string): Change | string {
  const svc = state.services.get(name);
  if (svc) return commentService(state, svc);
  const block = state.commented.find((c) => c.name === name);
  if (!block) return `no service named "${name}"`;
  const insert = state.doc.lines.slice(block.start, block.end)
    .map((l) => uncommentLine(l, state.indent));
  const expect = (want: Expected) => {
    const services = isMapping(want.raw.services) ? want.raw.services : {};
    services[name] = structuredClone(block.value);
    want.raw.services = services;
    delete want.commented[name];
  };
  return { at: block.start, remove: block.end - block.start, insert, expect };
}

/** Comment an active service's whole block out, the way `renderCompose` writes its example. */
function commentService(state: State, svc: Service): Change | string {
  const lines = state.doc.lines.slice(svc.start, svc.end);
  const lead = pad(state.indent);
  if (lines.some((l) => l.trim() === "" || !l.startsWith(lead))) {
    return `service "${svc.key}" has blank or shallower lines inside it — comment it out by hand`;
  }
  if (state.commented.some((c) => c.name === svc.key)) {
    return `a commented-out "${svc.key}" block already exists`;
  }
  const expect = (want: Expected) => {
    const services = want.raw.services as Raw;
    want.commented[svc.key] = services[svc.key];
    delete services[svc.key];
    if (Object.keys(services).length === 0) want.raw.services = null;
  };
  const insert = lines.map((l) => commentLine(l, state.indent));
  return { at: svc.start, remove: lines.length, insert, expect };
}
