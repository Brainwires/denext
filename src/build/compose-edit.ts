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
// The operation set is closed: image, restart, build, ports, environment, depends_on, volumes,
// networks, and commenting a whole service out or back in. Every other byte of the file is left
// as it was — except a service written as an alias or a flow mapping, which its first edit
// rewrites as a block mapping, and a field an alias or a merge key supplied, which an edit
// writes out as the service's own copy.
//
// Build-time only; never imported by a shipped bundle.

import type { EditResult } from "./config-edit.ts";
import { emitEntry, flowScalar, flowText, yamlKey, yamlScalar } from "./compose-emit.ts";
import {
  afterFields,
  append,
  type Change,
  type Children,
  childrenOf,
  commentTail,
  cut,
  deepEqual,
  deleteKey,
  detach,
  dropChild,
  type Expected,
  fieldExpect,
  flowAdd,
  type FlowField,
  flowRemove,
  flowUpdate,
  mapNode,
  pad,
  rawService,
  rewrite,
  type Scalar,
  serviceOf,
  servicesOf,
  setKey,
  type Splice,
  withExpect,
  writeField,
} from "./compose-splice.ts";
import { createUnifiedDiff } from "./patch-diff.ts";
import {
  anchorIn,
  commentLine,
  type ComposeModel,
  type Entry,
  envEntries,
  isMapping,
  load,
  type Service,
  type Span,
  spliceDoc,
  type State,
  texts,
  toModel,
  uncommentLine,
} from "./compose-scan.ts";

export type { ComposeModel, ComposeService } from "./compose-scan.ts";

/** What a long-form dependency may wait for, the first being what a short one means. */
export const DEPENDS_CONDITIONS = [
  "service_started",
  "service_healthy",
  "service_completed_successfully",
] as const;

/** One of {@linkcode DEPENDS_CONDITIONS}. */
export type DependsCondition = typeof DEPENDS_CONDITIONS[number];

/** A key of a long-syntax port or volume entry this editor writes. */
const ENTRY_KEY = /^[a-z_][a-z0-9_]*$/;

/** The file name compose diffs are labelled with. */
const LABEL = "docker-compose.yml";
/** How much of the file a refusal to read it quotes back. */
const SNIPPET_MAX = 200;
/** An environment variable name this editor writes. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

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
  /**
   * Add or remove one `depends_on` / `volumes` / `networks` entry, matched by its text (a
   * long-form mapping's key). A dependency added with a `condition` other than
   * `service_started` is written in the long form.
   */
  | {
    op: "dependsOn" | "volumes" | "networks";
    service: string;
    action: "add" | "remove";
    value: string;
    condition?: DependsCondition;
  }
  /**
   * Set (a scalar) or delete (`value: null`) one key of a long-syntax `ports` / `volumes`
   * entry — a mapping such as `{ target: 80, published: "8080" }`.
   */
  | {
    op: "entry";
    service: string;
    field: "ports" | "volumes";
    index: number;
    key: string;
    value: Scalar | null;
  }
  /**
   * Set the `condition` a dependency waits for; a short `depends_on` list is rewritten in the
   * long form (every other dependency keeping `service_started`).
   */
  | { op: "condition"; service: string; value: string; condition: DependsCondition }
  /** Comment an active service block out, or uncomment a commented one, byte for byte. */
  | { op: "toggleService"; service: string };

/**
 * What {@linkcode applyComposeEdits} answers: the new contents and one diff — plus `notes`, when
 * an edit also changed another node that repeats the edited one through an alias or a merge
 * key — or a refusal.
 */
export type ComposeEditResult =
  | { ok: true; source: string; diff: string; notes: string[] }
  | Refusal;

// --- internal types ---------------------------------------------------------

type Raw = Record<string, unknown>;
type Refusal = Extract<EditResult, { ok: false }>;
type SetOp = Extract<ComposeOp, { op: "set" }>;
type PortsOp = Extract<ComposeOp, { op: "ports" }>;
type EnvOp = Extract<ComposeOp, { op: "env" }>;
type NamedOp = Extract<ComposeOp, { op: "dependsOn" | "volumes" | "networks" }>;
type EntryOp = Extract<ComposeOp, { op: "entry" }>;
type ConditionOp = Extract<ComposeOp, { op: "condition" }>;

/** One list edit resolved to positions. */
type ListEdit =
  | { kind: "add"; value: string; quote?: boolean }
  | { kind: "remove"; index: number }
  | { kind: "update"; index: number; value: string; quote?: boolean };

// --- reading ----------------------------------------------------------------

/**
 * Read a compose file into the model the Docker panel renders.
 *
 * @param text The file's contents.
 * @returns The model, or null when the file is opaque — it does not parse (several documents do
 * not), is not a mapping of service mappings, or uses syntax a line splice cannot follow (a
 * document marker carrying content, a Unicode line separator).
 */
export function readCompose(text: string): ComposeModel | null {
  return inspectCompose(text).model;
}

/**
 * Read a compose file into the panel's model, or say why the editor cannot follow it.
 *
 * @param text The file's contents.
 * @returns The model, or `model: null` and the reason the file is opaque.
 */
export function inspectCompose(
  text: string,
): { model: ComposeModel; reason?: undefined } | { model: null; reason: string } {
  const state = load(text);
  return typeof state === "string" ? { model: null, reason: state } : { model: toModel(state) };
}

// --- writing ----------------------------------------------------------------

/**
 * Apply compose edits by splicing lines, re-parsing after every one. Operations apply in
 * order; the first refusal fails the whole call and the input is returned untouched.
 *
 * @param text The compose file's current contents.
 * @param ops The edits, in order.
 * @param label The file name the diff is labelled with (default `docker-compose.yml`).
 * @returns The new contents, one unified diff for the whole call and notes on what else an
 * alias carried an edit to — or an honest refusal (an opaque file, an unknown or commented-out
 * service, a flow-style or long-syntax field, a duplicate entry, or an edit that would not read
 * back as intended).
 */
export function applyComposeEdits(
  text: string,
  ops: ComposeOp[],
  label: string = LABEL,
): ComposeEditResult {
  let state = load(text);
  if (typeof state === "string") return bail(state, text.slice(0, SNIPPET_MAX));
  const notes: string[] = [];
  for (const op of ops) {
    const next = step(state, op, notes);
    if ("ok" in next) return next;
    state = next;
  }
  return { ok: true, source: state.text, diff: diffOf(text, state.text, label), notes };
}

/** A refusal, optionally carrying the patch the edit would have made. */
function bail(reason: string, snippet: string, diff?: string): Refusal {
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

/** The active service an operation targets, if any. */
function targetOf(state: State, op: ComposeOp): Service | undefined {
  return state.services.get(op.service);
}

/** Apply one operation and prove it: the result must re-read as exactly the intended change. */
function step(state: State, op: ComposeOp, notes: string[]): State | Refusal {
  const ready = normalized(state, op);
  if ("ok" in ready) return ready;
  const change = plan(ready, op);
  if (typeof change === "string") return bail(change, JSON.stringify(op));
  return commit(ready, change, op, notes);
}

/** Splice one planned change in and re-read it; the new state, or a refusal carrying its diff. */
function commit(state: State, change: Change, op: ComposeOp, notes: string[]): State | Refusal {
  const next = spliceDoc(state.doc, change.at, change.remove, change.insert);
  const want: Expected = { raw: detach(state.raw), commented: commentedOf(state) };
  change.expect(want);
  const reread = load(next);
  const carried = typeof reread === "string" ? null : readsBack(state, change, op, reread, want);
  if (carried === null) {
    return bail(mismatchReason(state, change, op), JSON.stringify(op), diffOf(state.text, next));
  }
  notes.push(...carried);
  return reread as State;
}

/** The keys whose values differ between two mappings. */
function differing(a: Raw, b: Raw): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => !deepEqual(a[key], b[key]));
}

/** Whether a splice stays inside one service's lines. */
function within(change: Splice, span: Span): boolean {
  return change.at >= span.start && change.at + change.remove <= span.end;
}

/**
 * Whether the edited file reads back as the intended change: `[]` when it does exactly, a note
 * when an alias or a merge key also carries the change elsewhere, null when it does not.
 *
 * The note is sound because the splice stayed inside the target service: every other line is
 * unchanged, so anything else that reads differently now repeats part of that service through
 * an alias or a merge key — the file's own meaning, which the note names.
 */
function readsBack(
  state: State,
  change: Change,
  op: ComposeOp,
  reread: State,
  want: Expected,
): string[] | null {
  if (!deepEqual(commentedOf(reread), want.commented)) return null;
  if (deepEqual(reread.raw, want.raw)) return [];
  const svc = targetOf(state, op);
  if (!svc || !within(change, svc)) return null;
  const [got, exp] = [servicesOf(reread.raw), servicesOf(want.raw)];
  if (!deepEqual(got[svc.key], exp[svc.key])) return null;
  const others = differing(got, exp).map((name) => `service "${name}"`);
  const top = differing(reread.raw, want.raw).filter((key) => key !== "services");
  const also = [...others, ...top.map((key) => `"${key}"`)].join(", ");
  return [
    `this edit to "${svc.key}" also changes ${also}, which repeats part of it through an alias ` +
    "or a merge key",
  ];
}

/** Why a planned change was refused at the read-back, naming an anchor or merge key it met. */
function mismatchReason(state: State, change: Change, op: ComposeOp): string {
  const reason = "the edited file does not read back as the requested change — denext refuses " +
    "to write it";
  const anchor = anchorIn(state.doc.lines.slice(change.at, change.at + change.remove));
  if (anchor !== null) return `${reason} (it rewrites the anchor &${anchor})`;
  const svc = targetOf(state, op);
  return svc?.fields.has("<<")
    ? `${reason} (the merge key (<<) of "${svc.key}" supplies part of its value)`
    : reason;
}

/**
 * Before an edit to a service written as an alias (`web: *base`) or a flow mapping, rewrite it
 * as a block mapping of the same value — proved by the same read-back — so the edit can splice
 * its fields. An alias becomes the service's own copy; its head line's comment is kept.
 */
function normalized(state: State, op: ComposeOp): State | Refusal {
  if (state.servicesInline) {
    const services = servicesOf(state.raw);
    if (Object.keys(services).length === 0) {
      return bail("`services:` is an empty mapping — add a service by hand", JSON.stringify(op));
    }
    return commit(state, blockRewrite(state, state.servicesInline, services), op, []);
  }
  const svc = targetOf(state, op);
  if (!svc?.inline) return state;
  const value = rawService(state.raw, svc.key);
  if (Object.keys(value).length === 0) {
    return bail(
      `service "${svc.key}" is an empty mapping — add a field by hand`,
      JSON.stringify(op),
    );
  }
  return commit(state, blockRewrite(state, svc, value), op, []);
}

/**
 * Rewrite one entry as block YAML of `value` (its parsed value), keeping its head as written and
 * its head line's comment. The change it plans is no change to what the file says.
 */
function blockRewrite(state: State, entry: Entry, value: unknown): Change {
  const line = state.doc.lines[entry.start];
  const keep = {
    head: line.slice(0, entry.headEnd),
    tail: commentTail(line.slice(entry.valueCol)),
  };
  const insert = emitEntry(entry.key, value, entry.indent, { ...keep, tail: keep.tail ?? "" });
  return { at: entry.start, remove: entry.end - entry.start, insert, expect: () => {} };
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
    case "entry":
      return editEntry(state, op);
    case "condition":
      return setCondition(state, op);
    case "toggleService":
      return toggle(state, op.service);
    default:
      return `unknown compose operation ${JSON.stringify((op as { op?: unknown }).op)}`;
  }
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
    if (field) return { ...cut(field), expect };
    return Object.hasOwn(rawService(state.raw, op.service), op.field)
      ? `${op.field} of "${op.service}" comes from its merge key (<<) — set a value to override ` +
        "it, or edit the anchor by hand"
      : `service "${op.service}" has no ${op.field} to delete`;
  }
  if (typeof op.value !== "string" || op.value === "") return `${op.field} needs a non-empty value`;
  const value = yamlScalar(op.value);
  if (field) return withExpect(rewrite(state.doc.lines, field, value, `${op.field}: `), expect);
  const insert = [pad(svc.fieldIndent) + `${op.field}: ${value}`];
  return { at: afterFields(svc, op.field), remove: 0, insert, expect };
}

/** Apply a list edit to a parsed list in place; false when it names an entry the list lacks. */
function applyListEdit(list: unknown[], edit: ListEdit): boolean {
  if (edit.kind === "add") list.push(edit.value);
  else if (!(edit.index in list)) return false;
  else if (edit.kind === "remove") list.splice(edit.index, 1);
  else list[edit.index] = edit.value;
  return true;
}

/** How a list entry is written: double-quoted when it asks to be, else as plain as reads back. */
function entryText(edit: { value: string; quote?: boolean }, flow: boolean): string {
  if (edit.quote) return JSON.stringify(edit.value);
  return flow ? flowScalar(edit.value) : yamlScalar(edit.value);
}

/** A block list edit's splice; null when it names an entry the list lacks. */
function blockListSplice(
  lines: readonly string[],
  svc: Service,
  key: string,
  ch: Children,
  edit: ListEdit,
): Splice | string | null {
  if (edit.kind === "add") return append(svc, key, ch, "- " + entryText(edit, false));
  const item = ch.items[edit.index];
  if (!item) return null;
  if (edit.kind === "remove") return dropChild(lines, ch, item);
  return rewrite(lines, item, entryText(edit, false), "- ");
}

/** A flow list edit's splice, in place; null when it names an entry the list lacks. */
function flowListSplice(lines: readonly string[], ch: FlowField, edit: ListEdit): Splice | null {
  if (edit.kind === "add") return flowAdd(ch, entryText(edit, true));
  if (!(edit.index in ch.flow.items)) return null;
  if (edit.kind === "remove") return flowRemove(lines, ch, edit.index);
  return flowUpdate(ch, edit.index, entryText(edit, true));
}

/** Append, drop or replace one entry of a list field (block, flow, or an alias's own copy). */
function editList(state: State, service: string, key: string, edit: ListEdit): Change | string {
  const svc = serviceOf(state, service);
  if (typeof svc === "string") return svc;
  const ch = childrenOf(state, svc, key, "list");
  if (typeof ch === "string") return ch;
  const missing = `${key} of "${service}" has no entry #${"index" in edit ? edit.index : ""}`;
  if ("whole" in ch) {
    const list = detach(rawService(state.raw, service)[key] as unknown[]);
    return applyListEdit(list, edit) ? writeField(state, svc, key, ch.field, list) : missing;
  }
  const expect = fieldExpect(service, key, (): unknown[] => [], (list) => {
    applyListEdit(list, edit);
  });
  const lines = state.doc.lines;
  const splice = "flow" in ch
    ? flowListSplice(lines, ch, edit)
    : blockListSplice(lines, svc, key, ch, edit);
  return splice === null ? missing : withExpect(splice, expect);
}

/** `ports`: mappings are always double-quoted (`"5432:5432"` is a number to YAML 1.1). */
function editPorts(state: State, op: PortsOp): Change | string {
  const index = op.index ?? -1;
  if (op.action === "remove") {
    return editList(state, op.service, "ports", { kind: "remove", index });
  }
  if (typeof op.value !== "string" || op.value.trim() === "") return "a port mapping needs a value";
  const value = op.value;
  if (op.action === "add") {
    return editList(state, op.service, "ports", { kind: "add", value, quote: true });
  }
  if (op.action === "update") {
    return editList(state, op.service, "ports", { kind: "update", index, value, quote: true });
  }
  return `unknown ports action ${JSON.stringify(op.action)}`;
}

/** `dependsOn` / `volumes`: add or remove one list entry, matched by its text. */
function editNamed(state: State, op: NamedOp): Change | string {
  const key = op.op === "dependsOn" ? "depends_on" : op.op;
  const svc = serviceOf(state, op.service);
  if (typeof svc === "string") return svc;
  if (typeof op.value !== "string" || op.value === "") return `${key} needs a value`;
  const value = rawService(state.raw, op.service)[key];
  const names = namesOf(value);
  const index = names.indexOf(op.value);
  if (op.action === "remove" && index === -1) {
    return `${key} of "${op.service}" does not list ${op.value}`;
  }
  if (op.action === "add" && index !== -1) {
    return `${key} of "${op.service}" already lists ${op.value}`;
  }
  if (isMapping(value)) return editNamedMap(state, svc, key, op, index);
  if (op.action === "remove") return editList(state, op.service, key, { kind: "remove", index });
  const condition = op.condition ?? DEPENDS_CONDITIONS[0];
  if (condition !== DEPENDS_CONDITIONS[0]) {
    const long = longDependsOn([...names, op.value], { [op.value]: condition });
    return writeField(state, svc, key, svc.fields.get(key), long);
  }
  return editList(state, op.service, key, { kind: "add", value: op.value });
}

/** A `depends_on` / `networks` value's names: the list's entries, or the long form's keys. */
function namesOf(value: unknown): string[] {
  return isMapping(value) ? Object.keys(value) : texts(value);
}

/** A short `depends_on` list in the long form, each entry with its condition. */
function longDependsOn(names: string[], conditions: Record<string, DependsCondition>): Raw {
  return Object.fromEntries(
    names.map((name) => [name, { condition: conditions[name] ?? DEPENDS_CONDITIONS[0] }]),
  );
}

/** What a new long-form entry holds: a dependency's condition; a network nothing (null). */
function longEntryOf(key: string, op: NamedOp): Raw | null {
  return key === "depends_on" ? { condition: op.condition ?? DEPENDS_CONDITIONS[0] } : null;
}

/** Add or remove one key of a long-form (`name: {…}`) `depends_on` / `networks`. */
function editNamedMap(
  state: State,
  svc: Service,
  key: string,
  op: NamedOp,
  index: number,
): Change | string {
  const ch = childrenOf(state, svc, key, "map");
  if (typeof ch === "string") return ch;
  const entry = longEntryOf(key, op);
  const mutate = (map: Raw) => {
    if (op.action === "add") map[op.value] = detach(entry);
    else delete map[op.value];
  };
  if ("whole" in ch) {
    const map = detach(rawService(state.raw, op.service)[key] as Raw);
    mutate(map);
    return writeField(state, svc, key, ch.field, map);
  }
  const expect = fieldExpect(op.service, key, (): Raw => ({}), mutate);
  const lines = state.doc.lines;
  if ("flow" in ch) {
    const item = `${yamlKey(op.value)}: ${flowText(entry)}`;
    return { ...(op.action === "add" ? flowAdd(ch, item) : flowRemove(lines, ch, index)), expect };
  }
  if (op.action === "add") {
    return { ...append(svc, key, ch, emitEntry(op.value, entry, 0)), expect };
  }
  return { ...dropChild(lines, ch, ch.items[index]), expect };
}

/** The long-syntax entry an `entry` op edits, with the entry as it must read afterwards. */
function entryTarget(
  state: State,
  op: EntryOp,
): { svc: Service; list: unknown[]; next: Raw; where: string } | string {
  const svc = serviceOf(state, op.service);
  if (typeof svc === "string") return svc;
  if (typeof op.key !== "string" || !ENTRY_KEY.test(op.key)) {
    return `${JSON.stringify(op.key)} is not a key denext writes`;
  }
  const list = rawService(state.raw, op.service)[op.field];
  const item = Array.isArray(list) ? list[op.index] : undefined;
  const where = `${op.field} entry #${op.index} of "${op.service}"`;
  if (item === undefined) return `${op.field} of "${op.service}" has no entry #${op.index}`;
  if (!isMapping(item)) return `${where} is not a long-syntax (mapping) entry`;
  if (op.value !== null && !["string", "number", "boolean"].includes(typeof op.value)) {
    return `${op.key} needs a string, number, boolean or null`;
  }
  const next = detach(item);
  if (op.value === null) delete next[op.key];
  else next[op.key] = op.value;
  return { svc, list: list as unknown[], next, where };
}

/** `entry`: set or delete one key of a long-syntax port or volume, in place. */
function editEntry(state: State, op: EntryOp): Change | string {
  const target = entryTarget(state, op);
  if (typeof target === "string") return target;
  const { svc, list, next, where } = target;
  const ch = childrenOf(state, svc, op.field, "list");
  if (typeof ch === "string") return ch;
  if ("whole" in ch) {
    return writeField(
      state,
      svc,
      op.field,
      ch.field,
      list.map((v, i) => i === op.index ? next : v),
    );
  }
  const expect = (want: Expected) => {
    (rawService(want.raw, op.service)[op.field] as unknown[])[op.index] = detach(next);
  };
  if ("flow" in ch) return { ...flowUpdate(ch, op.index, flowText(next)), expect };
  const node = mapNode(state.doc.lines, ch.items[op.index], list[op.index]);
  if (!node) return `${where} is written in a way denext cannot edit in place — edit it by hand`;
  const splice = op.value === null
    ? deleteKey(state.doc.lines, node, op.key, where)
    : setKey(state.doc.lines, node, op.key, op.value);
  return withExpect(splice, expect);
}

/** `condition`: set what one dependency waits for, writing a short list in the long form. */
function setCondition(state: State, op: ConditionOp): Change | string {
  const svc = serviceOf(state, op.service);
  if (typeof svc === "string") return svc;
  if (!DEPENDS_CONDITIONS.includes(op.condition)) {
    return `unknown condition ${JSON.stringify(op.condition)}`;
  }
  const value = rawService(state.raw, op.service).depends_on;
  const names = namesOf(value);
  if (!names.includes(op.value)) return `depends_on of "${op.service}" does not list ${op.value}`;
  if (!isMapping(value)) {
    const long = longDependsOn(names, { [op.value]: op.condition });
    return writeField(state, svc, "depends_on", svc.fields.get("depends_on"), long);
  }
  const current = value[op.value];
  const next: Raw = { ...(isMapping(current) ? detach(current) : {}), condition: op.condition };
  return conditionChange(state, svc, op, next);
}

/** Write one long-form dependency's new settings: in place, or as the service's own copy. */
function conditionChange(state: State, svc: Service, op: ConditionOp, next: Raw): Change | string {
  const value = rawService(state.raw, op.service).depends_on as Raw;
  const ch = childrenOf(state, svc, "depends_on", "map");
  if (typeof ch === "string") return ch;
  if ("whole" in ch) {
    return writeField(state, svc, "depends_on", ch.field, { ...detach(value), [op.value]: next });
  }
  const expect = (want: Expected) => {
    (rawService(want.raw, op.service).depends_on as Raw)[op.value] = detach(next);
  };
  if ("flow" in ch) {
    const at = Object.keys(value).indexOf(op.value);
    return { ...flowUpdate(ch, at, `${yamlKey(op.value)}: ${flowText(next)}`), expect };
  }
  const entry = ch.items.find((e) => e.key === op.value)!;
  const node = mapNode(state.doc.lines, entry, value[op.value]);
  if (!node) return `the "${op.value}" dependency is written in a way denext cannot edit in place`;
  return withExpect(setKey(state.doc.lines, node, "condition", op.condition), expect);
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
  const edit: ListEdit = index === -1 ? { kind: "add", value } : { kind: "update", index, value };
  return editList(state, op.service, "environment", edit);
}

/** Apply an env edit to a parsed `KEY: value` mapping in place. */
function applyEnvEdit(env: Raw, op: EnvOp): void {
  if (op.action === "delete") delete env[op.key];
  else env[op.key] = op.value;
}

/** `env` against a `KEY: value` mapping (also how a missing `environment:` is created). */
function envMap(state: State, svc: Service, op: EnvOp): Change | string {
  const ch = childrenOf(state, svc, "environment", "map");
  if (typeof ch === "string") return ch;
  if ("whole" in ch) {
    const env = detach(rawService(state.raw, op.service).environment as Raw);
    if (op.action === "delete" && !Object.hasOwn(env, op.key)) return noEnv(op);
    applyEnvEdit(env, op);
    return writeField(state, svc, "environment", ch.field, env);
  }
  const expect = fieldExpect(op.service, "environment", (): Raw => ({}), (env) => {
    applyEnvEdit(env, op);
  });
  if ("flow" in ch) return envFlow(state, ch, op, expect);
  const entry = ch.items.find((e) => e.key === op.key);
  if (op.action === "delete") {
    return entry ? { ...dropChild(state.doc.lines, ch, entry), expect } : noEnv(op);
  }
  const text = yamlScalar(String(op.value));
  if (entry) return withExpect(rewrite(state.doc.lines, entry, text, `${op.key}: `), expect);
  return { ...append(svc, "environment", ch, `${op.key}: ${text}`), expect };
}

/** `env` against a flow mapping (`{ A: "1", B: x }`), in place. */
function envFlow(
  state: State,
  ch: FlowField,
  op: EnvOp,
  expect: Change["expect"],
): Change | string {
  const env = rawService(state.raw, op.service).environment;
  const index = Object.keys(isMapping(env) ? env : {}).indexOf(op.key);
  if (op.action === "delete") {
    return index === -1 ? noEnv(op) : { ...flowRemove(state.doc.lines, ch, index), expect };
  }
  const item = `${yamlKey(op.key)}: ${flowScalar(String(op.value))}`;
  return { ...(index === -1 ? flowAdd(ch, item) : flowUpdate(ch, index, item)), expect };
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
