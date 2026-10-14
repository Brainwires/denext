// The auto-REST request grammar, PostgREST's: `select=` trees (columns, aliases, casts, JSON
// paths, embedded resources with `!hint` / `!inner` / `!left`, spreads), filter values
// (`[not.]op[(any|all|config)].value`), `or=` / `and=` logic trees, and `order=` terms. Parsing
// only produces names and values; nothing here touches SQL — the builder (`rest-query.ts`) looks
// every name up in the catalog and binds every value as a parameter.

/** A refused request, answered with a PostgREST-shaped JSON error. */
export class RestError extends Error {
  /** The HTTP status. */
  readonly status: number;
  /** A PostgREST-style code (`PGRST100`) or a Postgres SQLSTATE (`42703`). */
  readonly code: string;
  /** More detail, if any (a string, or PostgREST's list for an ambiguous embed). */
  readonly details: unknown;
  /** How to fix it, if known. */
  readonly hint: string | null;

  /**
   * Build the error.
   *
   * @param status The HTTP status.
   * @param code The code.
   * @param message What went wrong.
   * @param details More detail.
   * @param hint How to fix it.
   */
  constructor(
    status: number,
    code: string,
    message: string,
    details: unknown = null,
    hint: string | null = null,
  ) {
    super(message);
    this.name = "RestError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.hint = hint;
  }
}

/**
 * A malformed request (`PGRST100`, 400).
 *
 * @param message What is wrong.
 * @param hint How to fix it.
 * @returns The error.
 */
export function parseError(message: string, hint: string | null = null): RestError {
  return new RestError(400, "PGRST100", message, null, hint);
}

/**
 * A request-supplied name, shortened for an error message.
 *
 * @param name The name.
 * @returns It, JSON-quoted.
 */
export function shown(name: string): string {
  return JSON.stringify(name.length > 64 ? `${name.slice(0, 64)}…` : name);
}

/** The deepest embedding (and logic-tree nesting) a request may ask for. */
export const MAX_DEPTH = 8;
/** The most items a whole `select=` tree may hold. */
const MAX_SELECT_ITEMS = 256;
/** The longest `select=` / `or=` text accepted. */
const MAX_EXPRESSION_LENGTH = 16_384;

/** One step of a JSON path: `->key` (JSON) or `->>key` (text). */
export interface JsonStep {
  /** The arrow. */
  readonly arrow: "->" | "->>";
  /** The key, or an array index (digits, maybe negative). */
  readonly key: string;
}

/** A column, maybe followed by a JSON path. */
export interface FieldRef {
  /** The column. */
  readonly column: string;
  /** The JSON path (empty for the column itself). */
  readonly path: readonly JsonStep[];
  /** In a logic tree: the embedded resources the column belongs to (`books.authors.name`). */
  readonly embed?: readonly string[];
}

/** A column of the select list. */
export interface SelectField {
  /** `field`. */
  readonly kind: "field";
  /** The column and path. */
  readonly field: FieldRef;
  /** `::cast`, as written. */
  readonly cast?: string;
  /** The output key (`alias:`), else the column, else the last JSON key. */
  readonly key: string;
}

/** An embedded resource (or a spread one). */
export interface SelectEmbed {
  /** `embed`. */
  readonly kind: "embed";
  /** The relation (or FK column / constraint) named. */
  readonly name: string;
  /** The output key (`alias:`, else the name). */
  readonly key: string;
  /** A `!hint` that is neither `inner` nor `left`. */
  readonly hint?: string;
  /** `!inner` drops parent rows without a match. */
  readonly inner: boolean;
  /** `...rel(cols)` merges a to-one relation's columns into the parent. */
  readonly spread: boolean;
  /** Its own select list. */
  readonly select: readonly SelectItem[];
}

/** An aggregate: `col.sum()`, `col::int.avg()::text`, `count()`. */
export interface SelectAggregate {
  /** `aggregate`. */
  readonly kind: "aggregate";
  /** The function. */
  readonly fn: "sum" | "avg" | "min" | "max" | "count";
  /** Its column (none for `count()`). */
  readonly field?: FieldRef;
  /** A cast of the column before aggregating. */
  readonly castBefore?: string;
  /** A cast of the result. */
  readonly cast?: string;
  /** The output key (`alias:`, else the function's name). */
  readonly key: string;
}

/** One item of a select list. */
export type SelectItem = { readonly kind: "star" } | SelectField | SelectEmbed | SelectAggregate;

/** A type name in a cast. */
const CAST_NAME = "[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)?(?: [a-z]+)*(?:\\[\\])?";
/** What may follow a select column: `::cast`, `.fn()`, `::cast`. */
const FIELD_TAIL = new RegExp(
  `^(?:::(${CAST_NAME}))?(?:\\.(sum|avg|min|max|count)\\(\\))?(?:::(${CAST_NAME}))?$`,
);
/** `count()` on its own, maybe cast. */
const COUNT_ALL = new RegExp(`^count\\(\\)(?:::(${CAST_NAME}))?$`);

/** One identifier character run: letters, digits, `_`, `$`, and `-` not starting `->`. */
const BARE = /[\p{L}\p{N}_$]+(?:-(?!>)[\p{L}\p{N}_$]+)*/uy;
/** A double-quoted identifier (`""` is a quote). */
const QUOTED = /"((?:[^"]|"")*)"/y;
/** A JSON array index. */
const INDEX = /-?\d+(?![\p{L}_$])/uy;

/** Read an identifier at `at`: `{ value, end }`, or `null`. */
function identAt(text: string, at: number): { value: string; end: number } | null {
  QUOTED.lastIndex = at;
  const quoted = QUOTED.exec(text);
  if (quoted) return { value: quoted[1].replaceAll('""', '"'), end: QUOTED.lastIndex };
  BARE.lastIndex = at;
  const bare = BARE.exec(text);
  return bare ? { value: bare[0], end: BARE.lastIndex } : null;
}

/** Read a JSON key (an index or an identifier) at `at`. */
function jsonKeyAt(text: string, at: number): { value: string; end: number } | null {
  INDEX.lastIndex = at;
  const index = INDEX.exec(text);
  if (index) return { value: index[0], end: INDEX.lastIndex };
  return identAt(text, at);
}

/** Read a column and its JSON path from `at`: the field and where it ends. */
function fieldAt(text: string, at: number): { field: FieldRef; end: number } {
  const column = identAt(text, at);
  if (!column) throw parseError(`expected a column name in ${shown(text)}`);
  const path: JsonStep[] = [];
  let end = column.end;
  while (text.startsWith("->", end)) {
    const arrow = text.startsWith("->>", end) ? "->>" : "->";
    const key = jsonKeyAt(text, end + arrow.length);
    if (!key) throw parseError(`expected a JSON key after ${arrow} in ${shown(text)}`);
    path.push({ arrow, key: key.value });
    end = key.end;
  }
  return { field: { column: column.value, path }, end };
}

/**
 * A whole filter / order key that is a field (`col`, `col->a->>b`).
 *
 * @param text The key.
 * @returns The field.
 * @throws {RestError} When it is not one.
 */
export function parseField(text: string): FieldRef {
  const { field, end } = fieldAt(text, 0);
  if (end !== text.length) throw parseError(`unexpected text in ${shown(text)}`);
  return field;
}

/**
 * Split `text` on `separator` outside parentheses and double quotes (`\` escapes inside them).
 *
 * @param text The text.
 * @param separator One character.
 * @returns The parts.
 * @throws {RestError} For unbalanced parentheses or an unterminated quote.
 */
export function splitTopLevel(text: string, separator = ","): string[] {
  const parts: string[] = [];
  const state = { depth: 0, quoted: false };
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (state.quoted) i += quotedStep(text[i], state);
    else if (text[i] === separator && state.depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    } else nestingStep(text, text[i], state);
  }
  if (state.quoted || state.depth !== 0) {
    throw parseError(`unbalanced quotes or parentheses in ${shown(text)}`);
  }
  parts.push(text.slice(start));
  return parts;
}

/** One character inside quotes: `\` skips the next one, `"` closes. Returns how many to skip. */
function quotedStep(ch: string, state: { quoted: boolean }): number {
  if (ch === "\\") return 1;
  if (ch === '"') state.quoted = false;
  return 0;
}

/** One character outside quotes: a quote opens, parentheses nest. */
function nestingStep(text: string, ch: string, state: { depth: number; quoted: boolean }): void {
  if (ch === '"') state.quoted = true;
  else if (ch === "(") state.depth++;
  else if (ch === ")" && --state.depth < 0) {
    throw parseError(`unbalanced parentheses in ${shown(text)}`);
  }
}

/** Remove whitespace outside double quotes (PostgREST ignores it in select / logic trees). */
function compact(text: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === "\\") {
      out += ch + (text[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (quoted || !/\s/.test(ch)) out += ch;
  }
  return out;
}

/** Counts select items across the whole tree. */
interface SelectBudget {
  items: number;
}

/** An `alias:` prefix: the alias and where the rest starts, or none. */
function aliasAt(text: string): { alias?: string; at: number } {
  const ident = identAt(text, 0);
  if (ident && text[ident.end] === ":" && text[ident.end + 1] !== ":") {
    return { alias: ident.value, at: ident.end + 1 };
  }
  return { at: 0 };
}

/** `name!hint!inner(…)` from `at`. */
function embedAt(
  text: string,
  at: number,
  alias: string | undefined,
  spread: boolean,
  depth: number,
  budget: SelectBudget,
): SelectEmbed | null {
  const name = identAt(text, at);
  if (!name) return null;
  let end = name.end;
  let hint: string | undefined;
  let inner = false;
  while (text[end] === "!") {
    const word = identAt(text, end + 1);
    if (!word) throw parseError(`expected a hint after ! in ${shown(text)}`);
    if (word.value === "inner") inner = true;
    else if (word.value !== "left") hint = word.value;
    end = word.end;
  }
  if (text[end] !== "(") {
    if (end !== name.end || spread) throw parseError(`expected (columns) in ${shown(text)}`);
    return null;
  }
  if (!text.endsWith(")")) throw parseError(`unexpected text after ) in ${shown(text)}`);
  if (depth >= MAX_DEPTH) throw parseError(`embedding is limited to ${MAX_DEPTH} levels`);
  const select = selectList(text.slice(end + 1, -1), depth + 1, budget);
  return {
    kind: "embed",
    name: name.value,
    key: alias ?? name.value,
    ...(hint === undefined ? {} : { hint }),
    inner,
    spread,
    select,
  };
}

/** One select item. */
function selectItem(text: string, depth: number, budget: SelectBudget): SelectItem {
  if (++budget.items > MAX_SELECT_ITEMS) {
    throw parseError(`select takes at most ${MAX_SELECT_ITEMS} items`);
  }
  if (text === "*") return { kind: "star" };
  const { alias, at } = aliasAt(text);
  const countAll = COUNT_ALL.exec(text.slice(at));
  if (countAll) return aggregateItem("count", alias, undefined, undefined, countAll[1]);
  const spread = text.startsWith("...", at);
  const embed = embedAt(text, spread ? at + 3 : at, alias, spread, depth, budget);
  return embed ?? columnItem(text, at, alias);
}

/** An aggregate item. */
function aggregateItem(
  fn: string,
  alias: string | undefined,
  field: FieldRef | undefined,
  before: string | undefined,
  after: string | undefined,
): SelectAggregate {
  return {
    kind: "aggregate",
    fn: fn as SelectAggregate["fn"],
    ...(field ? { field } : {}),
    ...(before ? { castBefore: before } : {}),
    ...(after ? { cast: after } : {}),
    key: alias ?? fn,
  };
}

/** A column item (`alias:col->path::cast`), or an aggregate over one (`col.sum()`). */
function columnItem(text: string, at: number, alias: string | undefined): SelectItem {
  const { field, end } = fieldAt(text, at);
  const tail = FIELD_TAIL.exec(text.slice(end));
  if (!tail) throw parseError(`unexpected text in select item ${shown(text)}`);
  const [, before, fn, after] = tail;
  if (fn) return aggregateItem(fn, alias, field, before, after);
  if (before && after) throw parseError(`two casts in select item ${shown(text)}`);
  const cast = before ?? after;
  return {
    kind: "field",
    field,
    ...(cast === undefined ? {} : { cast }),
    key: alias ?? fieldKey(field),
  };
}

/** A field's default key: the last JSON key (not an index), else the column. */
function fieldKey(field: FieldRef): string {
  const last = field.path.at(-1);
  return last && !/^-?\d+$/.test(last.key) ? last.key : field.column;
}

/** A comma-separated select list (empty text: no columns). */
function selectList(text: string, depth: number, budget: SelectBudget): SelectItem[] {
  if (text === "") return [];
  return splitTopLevel(text).map((item) => {
    if (item === "") throw parseError("an empty item in select");
    return selectItem(item, depth, budget);
  });
}

/**
 * Parse `select=` (`*` when absent or blank).
 *
 * @param raw The parameter.
 * @returns The items.
 * @throws {RestError} For a malformed list.
 */
export function parseSelect(raw: string | null): SelectItem[] {
  if (raw === null || raw.trim() === "") return [{ kind: "star" }];
  if (raw.length > MAX_EXPRESSION_LENGTH) throw parseError("select is too long");
  return selectList(compact(raw), 0, { items: 0 });
}

/** The operators a filter may name. */
const OPERATOR_NAMES = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "match",
  "imatch",
  "is",
  "isdistinct",
  "in",
  "cs",
  "cd",
  "ov",
  "sl",
  "sr",
  "nxl",
  "nxr",
  "adj",
  "fts",
  "plfts",
  "phfts",
  "wfts",
]);

/** A filter's operator and value. */
export interface ParsedFilterValue {
  /** `not.` was given. */
  readonly negate: boolean;
  /** The operator. */
  readonly op: string;
  /** `(any)` / `(all)` for a comparison or pattern; the text-search config for `fts`… */
  readonly modifier?: string;
  /** The value, as text. */
  readonly value: string;
}

/** `[not.]op[(modifier)].value`. */
const FILTER = /^(not\.)?([a-z]+)(?:\(([A-Za-z_][A-Za-z0-9_]*)\))?\.([\s\S]*)$/;

/**
 * Parse a filter's value part (`not.eq.5`, `like(any).{a*,b*}`, `fts(english).cat`).
 *
 * @param raw The text after `col=`.
 * @param key The filter's key (named in an error).
 * @returns The operator and value.
 * @throws {RestError} For an unknown operator or modifier.
 */
export function parseFilterValue(raw: string, key: string): ParsedFilterValue {
  const match = FILTER.exec(raw);
  if (!match) throw parseError(`filter ${shown(key)} needs an operator: ${key}=eq.value`);
  const [, negate, op, modifier, value] = match;
  if (!OPERATOR_NAMES.has(op)) {
    throw parseError(
      `unknown operator ${shown(op)}`,
      "operators: eq neq gt gte lt lte like ilike match imatch is isdistinct in cs cd ov sl sr " +
        "nxl nxr adj fts plfts phfts wfts (each may follow not.)",
    );
  }
  return {
    negate: negate !== undefined,
    op,
    ...(modifier === undefined ? {} : { modifier }),
    value,
  };
}

/** A condition of a `WHERE`: one filter, or an `and` / `or` group. */
export type Condition =
  | {
    readonly kind: "filter";
    readonly field: FieldRef;
    readonly filter: ParsedFilterValue;
  }
  | {
    readonly kind: "group";
    readonly op: "and" | "or";
    readonly negate: boolean;
    readonly items: readonly Condition[];
  };

/** `[not.](and|or)(…)`. */
const GROUP = /^(not\.)?(and|or)\(([\s\S]*)\)$/;

/** Unquote a logic-tree value (`"a,b"` → `a,b`, `\"` and `\\` escapes). */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return value;
}

/** `[not.]op[(modifier)].` — where a logic-tree filter's operator starts. */
const OPERATOR_START = /^(?:not\.)?([a-z]+)(?:\([A-Za-z_][A-Za-z0-9_]*\))?\./;

/**
 * A logic-tree field, maybe on embedded resources (`books.authors.name.eq.x`): leading names
 * not followed by an operator are embeds.
 */
function embeddedFieldAt(text: string): { field: FieldRef; end: number } {
  const embed: string[] = [];
  let { field, end } = fieldAt(text, 0);
  while (text[end] === "." && field.path.length === 0) {
    const op = OPERATOR_START.exec(text.slice(end + 1));
    if (op && OPERATOR_NAMES.has(op[1])) break;
    if (embed.length >= MAX_DEPTH) throw parseError(`embedding is limited to ${MAX_DEPTH} levels`);
    embed.push(field.column);
    ({ field, end } = fieldAt(text, end + 1));
  }
  return { field: embed.length ? { ...field, embed } : field, end };
}

/** One term of a logic tree. */
function logicTerm(text: string, depth: number, counter: { filters: number }): Condition {
  const group = GROUP.exec(text);
  if (group) {
    return logicGroup(
      group[2] as "and" | "or",
      group[1] !== undefined,
      group[3],
      depth + 1,
      counter,
    );
  }
  const { field, end } = embeddedFieldAt(text);
  if (text[end] !== ".") throw parseError(`expected column.operator.value in ${shown(text)}`);
  counter.filters++;
  const filter = parseFilterValue(text.slice(end + 1), field.column);
  return {
    kind: "filter",
    field,
    filter: filter.op === "in" ? filter : { ...filter, value: unquote(filter.value) },
  };
}

/** An `and` / `or` group's items. */
function logicGroup(
  op: "and" | "or",
  negate: boolean,
  inner: string,
  depth: number,
  counter: { filters: number },
): Condition {
  if (depth > MAX_DEPTH) throw parseError(`logic trees nest at most ${MAX_DEPTH} levels`);
  if (inner === "") throw parseError(`${op}() needs at least one condition`);
  const items = splitTopLevel(inner).map((term) => logicTerm(term.trim(), depth, counter));
  return { kind: "group", op, negate, items };
}

/**
 * Parse an `or=` / `and=` parameter (`(a.eq.1,and(b.gt.2,c.is.null))`).
 *
 * @param op The group's operator (from the key: `or`, `and`, `not.or`, `not.and`).
 * @param negate The key was `not.or` / `not.and`.
 * @param raw The value.
 * @param counter Counts the filters (each leaf).
 * @returns The group.
 * @throws {RestError} For a malformed tree.
 */
export function parseLogic(
  op: "and" | "or",
  negate: boolean,
  raw: string,
  counter: { filters: number },
): Condition {
  if (raw.length > MAX_EXPRESSION_LENGTH) throw parseError(`${op} is too long`);
  const text = raw.trim();
  if (!text.startsWith("(") || !text.endsWith(")")) {
    throw parseError(`${op} takes a list in parentheses: ${op}=(a.eq.1,b.eq.2)`);
  }
  return logicGroup(op, negate, text.slice(1, -1), 1, counter);
}

/** One `order=` term. */
export interface OrderTerm {
  /** The column and path. */
  readonly field: FieldRef;
  /** A to-one embedded resource the column belongs to (`order=author(name)`). */
  readonly relation?: string;
  /** `DESC`. */
  readonly descending: boolean;
  /** `NULLS FIRST` / `NULLS LAST`, when given. */
  readonly nulls?: "first" | "last";
}

/** An order term's field: `col`, `col->k`, or `rel(col)` on a to-one embed. */
function orderFieldAt(term: string): { field: FieldRef; end: number; relation?: string } {
  const head = identAt(term, 0);
  if (head && term[head.end] === "(") {
    const { field, end } = fieldAt(term, head.end + 1);
    if (term[end] !== ")") throw parseError(`bad order term ${shown(term)}`);
    return { field, end: end + 1, relation: head.value };
  }
  return fieldAt(term, 0);
}

/** `.asc|.desc` then `.nullsfirst|.nullslast`, both optional. */
const ORDER_TAIL = /^(?:\.(asc|desc))?(?:\.(nullsfirst|nullslast))?$/;

/**
 * Parse `order=a.desc.nullslast,meta->>k`.
 *
 * @param raw The parameter.
 * @returns The terms (none for an empty value).
 * @throws {RestError} For a malformed term.
 */
export function parseOrder(raw: string): OrderTerm[] {
  if (raw.trim() === "") return [];
  return splitTopLevel(compact(raw)).map((term) => {
    const { field, end, relation } = orderFieldAt(term);
    const tail = ORDER_TAIL.exec(term.slice(end));
    if (!tail) {
      throw parseError(
        `bad order term ${shown(term)}`,
        "order=column.asc|desc.nullsfirst|nullslast",
      );
    }
    return {
      field,
      ...(relation === undefined ? {} : { relation }),
      descending: tail[1] === "desc",
      ...(tail[2] ? { nulls: tail[2] === "nullsfirst" ? "first" : "last" } : {}),
    } as OrderTerm;
  });
}

/**
 * A list of column names (`columns=` / `on_conflict=`): comma-separated, each bare or quoted.
 *
 * @param raw The parameter.
 * @param name The parameter's name (named in an error).
 * @returns The names.
 * @throws {RestError} For an empty or malformed list.
 */
export function parseNameList(raw: string, name: string): string[] {
  const names = splitTopLevel(compact(raw)).map((item) => {
    const ident = identAt(item, 0);
    if (!ident || ident.end !== item.length) throw parseError(`${name}: bad column ${shown(item)}`);
    return ident.value;
  });
  if (names.length === 0) throw parseError(`${name} lists no columns`);
  return names;
}

/** The most values one `in.(…)` filter takes. */
export const MAX_IN_VALUES = 1000;

/** One in-list item: `"quoted"` (`\"` and `\\` escapes) or bare, up to a comma or the end. */
const IN_ITEM = /"((?:[^"\\]|\\.)*)"(?=,|$)|([^,"]*)(?=,|$)/y;

/**
 * Split an `in.(…)` list: comma-separated, `"quoted, items"` with `\"` and `\\` escapes.
 *
 * @param raw The value, parentheses included.
 * @returns The items.
 * @throws {RestError} For a malformed or oversized list.
 */
export function parseInList(raw: string): string[] {
  if (!raw.startsWith("(") || !raw.endsWith(")")) {
    throw parseError("an in filter takes a list: in.(a,b,c)");
  }
  const body = raw.slice(1, -1);
  if (body === "") return [];
  const items: string[] = [];
  for (let at = 0; at <= body.length; at = IN_ITEM.lastIndex + 1) {
    IN_ITEM.lastIndex = at;
    const match = IN_ITEM.exec(body);
    if (!match) throw parseError("a malformed in-list: quote an item holding a comma or a quote");
    items.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2]);
    if (items.length > MAX_IN_VALUES) {
      throw parseError(`an in filter takes at most ${MAX_IN_VALUES} values`);
    }
  }
  return items;
}
