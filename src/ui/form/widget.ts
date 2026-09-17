// Choosing a widget for a schema node: the `[predicate, build]` rule table that turns
// `denext.config.schema.json` into type-appropriate controls (enum → select, array of object →
// list-of-forms with typed rows, record → key/value map, …) instead of a raw text box.
//
// The table is ordered and the first match wins. It is deliberately a table rather than a
// `switch`: adding a widget is one row, and the rules stay individually readable.

import {
  branchIndexFor,
  itemSchema,
  MAP_SEGMENT,
  mapValueSchema,
  pathKey,
  type SchemaNode,
} from "./schema.ts";

/** Every control the config editor can render. */
export type WidgetKind =
  | "text"
  | "textarea"
  | "number"
  | "toggle"
  | "select"
  | "segmented"
  | "multi-select"
  | "chips"
  | "list-of-forms"
  | "map"
  | "union"
  | "group"
  | "code";

/** One choice of a select, segmented control or checkbox group. */
export interface WidgetOption {
  /** The posted value. */
  readonly value: string;
  /** The visible label. */
  readonly label: string;
}

/** One alternative shape of a union field, behind the discriminator picker. */
export interface WidgetBranch {
  /** The picker label (a lone `enum` value, else the JSON type). */
  readonly label: string;
  /** The widget for this branch. */
  readonly spec: WidgetSpec;
}

/** A resolved widget: what to render at one path, and everything the renderer needs. */
export interface WidgetSpec {
  /** Which control to render. */
  readonly kind: WidgetKind;
  /** The path this widget edits (array indices as numeric segments). */
  readonly path: readonly string[];
  /** The schema node it was derived from. */
  readonly schema: SchemaNode;
  /** Whether the field must be present. */
  readonly required: boolean;
  /** The visible label. */
  readonly label: string;
  /** Help text, from the schema's `description`. */
  readonly description?: string;
  /** Choices, for `select` / `segmented` / `multi-select`. */
  readonly options?: readonly WidgetOption[];
  /** The row template, for `chips` / `list-of-forms` / `map`. */
  readonly items?: WidgetSpec;
  /** The alternatives, for `union`. */
  readonly branches?: readonly WidgetBranch[];
  /** The fields, for `group`. */
  readonly children?: readonly WidgetSpec[];
  /** Inclusive lower bound, for `number`. */
  readonly min?: number;
  /** Inclusive upper bound, for `number`. */
  readonly max?: number;
  /** What the key is when absent, when the schema says (a `@default` JSDoc tag). */
  readonly default?: unknown;
}

/**
 * Config paths the editor refuses to own, however well the schema describes them.
 *
 * `plugins` is an array of objects and would otherwise render as a list-of-forms, but a plugin
 * entry is a live `setup` function: the plugins panel adds and removes entries through the
 * import-preserving injector, so the config form shows the array read-only rather than offering
 * an edit that cannot round-trip.
 */
const READ_ONLY_PATHS: ReadonlySet<string> = new Set(["plugins"]);

/** The most options a segmented control shows before it becomes a select. */
const SEGMENTED_MAX = 4;

/** The longest option label a segmented control shows before it becomes a select. */
const SEGMENTED_LABEL_MAX = 12;

/** Scalar JSON types a chip row can hold. */
const SCALAR_TYPES: ReadonlySet<string> = new Set(["string", "number", "integer", "boolean"]);

/** What a rule is handed. */
interface RuleInput {
  /** The schema node. */
  readonly node: SchemaNode;
  /** Its path. */
  readonly path: readonly string[];
  /** `pathKey(path)` — computed once, since most rules key off it. */
  readonly key: string;
  /** Whether the field is required. */
  readonly required: boolean;
}

/** One row of the widget table: a predicate and the spec builder it selects. */
type Rule = readonly [(input: RuleInput) => boolean, (input: RuleInput) => WidgetSpec];

/** The node's declared type, as a single string (`["string","null"]` reads as `"string"`). */
function typeOf(node: SchemaNode): string {
  const type = node.type;
  return Array.isArray(type) ? (type.find((entry) => entry !== "null") ?? "") : (type ?? "");
}

/** The visible label for a path segment. */
function labelFor(path: readonly string[]): string {
  const last = path[path.length - 1];
  if (last === undefined) return "config";
  if (last === MAP_SEGMENT) return "value";
  return /^\d+$/.test(last) ? `#${Number(last) + 1}` : last;
}

/** The shared part of every spec, so the builders below only state what is specific to them. */
function base(input: RuleInput, kind: WidgetKind): WidgetSpec {
  return {
    kind,
    path: input.path,
    schema: input.node,
    required: input.required,
    label: labelFor(input.path),
    description: input.node.description,
    // Spread rather than assigned, so a spec without a stated default has no `default` key at
    // all and still deep-equals the shape the widget tests compare against.
    ...(input.node.default === undefined ? {} : { default: input.node.default }),
  };
}

/** The choices of an `enum` node, with "— unset —" first when the field is optional. */
function enumOptions(input: RuleInput): WidgetOption[] {
  const options = (input.node.enum ?? []).map((value) => ({
    value: String(value),
    label: String(value),
  }));
  return input.required ? options : [{ value: "", label: "— unset —" }, ...options];
}

/** A union branch's picker label: its lone `enum` value, else its JSON type, else "custom…". */
function branchLabel(branch: SchemaNode): string {
  if (branch.enum?.length === 1) return String(branch.enum[0]);
  return typeOf(branch) || "custom…";
}

/** The widget for one child of an object node. */
function childSpec(input: RuleInput, name: string, node: SchemaNode): WidgetSpec {
  return widgetFor(node, [...input.path, name], input.node.required?.includes(name) ?? false);
}

/** The rule table, in priority order: the first predicate that matches picks the widget. */
const RULES: readonly Rule[] = [
  // Policy: a path the editor deliberately does not own (see READ_ONLY_PATHS).
  [(i) => READ_ONLY_PATHS.has(i.key), (i) => base(i, "code")],
  // A closed set of values: radios while they fit on one line, a select once they do not.
  [(i) => Array.isArray(i.node.enum), (i) => {
    const options = enumOptions(i);
    const short = options.length <= SEGMENTED_MAX &&
      options.every((option) => option.label.length <= SEGMENTED_LABEL_MAX);
    return { ...base(i, short ? "segmented" : "select"), options };
  }],
  // Several alternative shapes: a discriminator picker plus the selected branch.
  [(i) => Array.isArray(i.node.anyOf), (i) => ({
    ...base(i, "union"),
    branches: (i.node.anyOf ?? []).map((branch) => ({
      label: branchLabel(branch),
      spec: widgetFor(branch, i.path, i.required),
    })),
  })],
  // An array of a closed set of values: a checkbox group.
  [(i) => typeOf(i.node) === "array" && Array.isArray(i.node.items?.enum), (i) => ({
    ...base(i, "multi-select"),
    options: (i.node.items?.enum ?? []).map((value) => ({
      value: String(value),
      label: String(value),
    })),
    items: widgetFor(itemSchema(i.node), [...i.path, "0"], true),
  })],
  // An array of scalars: reorderable one-line rows.
  [(i) => typeOf(i.node) === "array" && SCALAR_TYPES.has(typeOf(itemSchema(i.node))), (i) => ({
    ...base(i, "chips"),
    items: widgetFor(itemSchema(i.node), [...i.path, "0"], true),
  })],
  // An array of objects: a typed sub-form per row.
  [(i) => typeOf(i.node) === "array" && i.node.items?.properties !== undefined, (i) => ({
    ...base(i, "list-of-forms"),
    items: widgetFor(itemSchema(i.node), [...i.path, "0"], true),
  })],
  // An array denext could not describe (a list of functions): read-only.
  [(i) => typeOf(i.node) === "array", (i) => base(i, "code")],
  // A record: key/value rows.
  [(i) => mapValueSchema(i.node) !== undefined, (i) => ({
    ...base(i, "map"),
    items: widgetFor(mapValueSchema(i.node) ?? {}, [...i.path, MAP_SEGMENT], true),
  })],
  // A fixed set of properties: a collapsible group.
  [(i) => i.node.properties !== undefined, (i) => ({
    ...base(i, "group"),
    children: Object.entries(i.node.properties ?? {}).map(([name, node]) =>
      childSpec(i, name, node)
    ),
  })],
  // Scalars.
  [(i) => typeOf(i.node) === "boolean", (i) => base(i, "toggle")],
  [(i) => typeOf(i.node) === "number" || typeOf(i.node) === "integer", (i) => ({
    ...base(i, "number"),
    min: i.node.minimum,
    max: i.node.maximum,
  })],
  [
    (i) => typeOf(i.node) === "string",
    (i) => base(i, i.node["x-denext"]?.widget === "textarea" ? "textarea" : "text"),
  ],
  // Anything left (an opaque `{}`: a callback, a plugin's `setup`): read-only.
  [() => true, (i) => base(i, "code")],
];

/**
 * The widget for one schema node — the first matching rule of the table above wins.
 *
 * Recursive: a group carries its children, a list its row template, a union its branches, so one
 * call at a top-level config key yields the whole sub-form.
 *
 * @param node The schema node (already `OVERRIDES`-patched by `resolveAt`).
 * @param path Its path segments (array indices as numeric segments).
 * @param required Whether the field is required (an optional enum gains "— unset —").
 * @returns The widget to render.
 */
export function widgetFor(
  node: SchemaNode,
  path: readonly string[],
  required: boolean,
): WidgetSpec {
  const input: RuleInput = { node, path, key: pathKey(path), required };
  for (const [matches, build] of RULES) {
    if (matches(input)) return build(input);
  }
  return base(input, "code");
}

/**
 * The branch of a union spec that holds `value` — the picker's current selection.
 *
 * @param spec A `union` spec.
 * @param value The current value.
 * @returns The selected branch and its index.
 */
export function selectedBranch(
  spec: WidgetSpec,
  value: unknown,
): { branch: WidgetBranch; index: number } {
  const branches = spec.branches ?? [];
  const index = branchIndexFor(spec.schema, value);
  return { branch: branches[index] ?? branches[0], index };
}
