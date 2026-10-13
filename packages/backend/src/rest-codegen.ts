// `.denext/rest.ts`: the auto-REST schema's types, generated from the live catalog by the
// plugin's prepare step (`denext dev` startup, `denext build`), in the shape
// `supabase gen types typescript` writes — `Database` with each exposed schema's `Tables`,
// `Views`, `Functions`, `Enums` and `CompositeTypes` (tables with their `Relationships`), plus the
// `Tables<>` / `TablesInsert<>` / `TablesUpdate<>` / `Enums<>` helpers and `Constants` — so
// `createClient<Database>()` from `@supabase/supabase-js` type-checks against it. Importing it also
// registers the default schema on `RegisteredRest`, so `from("notes")` from
// `@denext/backend/client` is typed to the table. Without a database to read (no DATABASE_URL at
// build time), a stub is written instead and the client types rows as `Record<string, unknown>`;
// an earlier generated file is kept as it is.

import type {
  RestCatalog,
  RestColumn,
  RestForeignKey,
  RestFunction,
  RestTable,
} from "./rest-catalog.ts";

/** The generated file's name, inside `.denext/`. */
const REST_TYPES_FILE = "rest.ts";

/** How long the prepare step waits for the catalog before writing the stub. */
const CATALOG_WAIT_MS = 10_000;

/** Plain string types (by `pg_type.typname`) inside categories that are otherwise not strings. */
const STRING_TYPES = new Set(["money", "uuid", "bytea", "xml", "tsvector", "tsquery", "citext"]);

/** `pg_type.typcategory` → the TypeScript type `json_agg` prints it as. */
const CATEGORY_TYPES: Record<string, string> = {
  B: "boolean",
  N: "number",
  C: "Json",
  S: "string",
  D: "string",
  T: "string",
  I: "string",
  G: "string",
  V: "string",
  R: "string",
};

/** A (base) type as TypeScript, as `json_agg` prints it. */
function scalarType(typeName: string, category: string, labels?: readonly string[]): string {
  if (typeName === "json" || typeName === "jsonb") return "Json";
  if (STRING_TYPES.has(typeName)) return "string";
  if (category === "E") {
    return labels?.length ? labels.map((l) => JSON.stringify(l)).join(" | ") : "string";
  }
  return Object.hasOwn(CATEGORY_TYPES, category) ? CATEGORY_TYPES[category] : "unknown";
}

/**
 * A column's TypeScript type (without `| null`).
 *
 * @param column The column (or anything with the same type facts).
 * @returns The type.
 */
export function columnType(
  column: Pick<RestColumn, "category" | "element" | "typeName" | "enumLabels">,
): string {
  if (column.category === "A" && column.element) {
    const inner = scalarType(column.element.typeName, column.element.category);
    return inner.includes(" ") ? `(${inner})[]` : `${inner}[]`;
  }
  return scalarType(column.typeName, column.category, column.enumLabels);
}

/** A property key: bare when it is an identifier, quoted otherwise. */
function key(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** A string literal type (or value). */
function lit(text: string): string {
  return JSON.stringify(text);
}

/** The indentation for a nesting level. */
function pad(level: number): string {
  return "  ".repeat(level);
}

/** An object type from `lines` (`Record<string, never>` when there are none). */
function objectType(lines: string[], level: number): string {
  if (!lines.length) return "Record<string, never>";
  return `{\n${lines.map((l) => `${pad(level + 1)}${l};`).join("\n")}\n${pad(level)}}`;
}

/** A column's type, `| null` when nullable. */
function nullable(c: RestColumn): string {
  return columnType(c) + (c.nullable ? " | null" : "");
}

/** The `Relationships` tuple of a relation: its own foreign keys. */
function relationships(table: RestTable, keys: readonly RestForeignKey[], level: number): string {
  const own = keys.filter((fk) => fk.table.schema === table.schema && fk.table.name === table.name);
  if (!own.length) return "[]";
  const items = own.map((fk) => {
    const oneToOne = (table.uniqueKeys ?? []).some((uk) =>
      uk.length === fk.columns.length && uk.every((c) => fk.columns.includes(c))
    );
    return `${pad(level + 1)}{\n` +
      `${pad(level + 2)}foreignKeyName: ${lit(fk.name)};\n` +
      `${pad(level + 2)}columns: [${fk.columns.map(lit).join(", ")}];\n` +
      `${pad(level + 2)}isOneToOne: ${oneToOne};\n` +
      `${pad(level + 2)}referencedRelation: ${lit(fk.foreignTable.name)};\n` +
      `${pad(level + 2)}referencedColumns: [${fk.foreignColumns.map(lit).join(", ")}];\n` +
      `${pad(level + 1)}},`;
  });
  return `[\n${items.join("\n")}\n${pad(level)}]`;
}

/** One table's (or view's) entry: `Row`, `Insert`, `Update` (tables), `Relationships`. */
function tableEntry(table: RestTable, keys: readonly RestForeignKey[], view: boolean): string {
  const level = 4;
  const row = objectType(table.columns.map((c) => `${key(c.name)}: ${nullable(c)}`), level);
  const parts = [`Row: ${row}`];
  if (!view) {
    const writable = table.columns.filter((c) => !c.readOnly);
    const optional = (c: RestColumn) => c.nullable || c.hasDefault ? "?" : "";
    parts.push(
      `Insert: ${
        objectType(writable.map((c) => `${key(c.name)}${optional(c)}: ${nullable(c)}`), level)
      }`,
      `Update: ${objectType(writable.map((c) => `${key(c.name)}?: ${nullable(c)}`), level)}`,
    );
  }
  parts.push(`Relationships: ${relationships(table, keys, level)}`);
  return `${pad(3)}${key(table.name)}: {\n${parts.map((p) => `${pad(level)}${p};`).join("\n")}\n` +
    `${pad(3)}};`;
}

/** A function's `Args`. */
function argsType(fn: RestFunction): string {
  if (!fn.args.length) return "Record<PropertyKey, never>";
  const lines = fn.args.map((a) => `${key(a.name)}${a.hasDefault ? "?" : ""}: ${columnType(a)}`);
  return objectType(lines, 5);
}

/** A function's `Returns`. */
function returnsType(fn: RestFunction): string {
  const result = fn.returns;
  if (result.kind === "void") return "undefined";
  const one = result.kind === "scalar"
    ? (result.column ? columnType(result.column) : "unknown")
    : objectType((result.columns ?? []).map((c) => `${key(c.name)}: ${nullable(c)}`), 5);
  if (!fn.setOf) return one;
  return one.includes(" ") && !one.startsWith("{") ? `(${one})[]` : `${one}[]`;
}

/** One function's entry (overloads as a union). */
function functionEntry(name: string, overloads: readonly RestFunction[]): string {
  const variants = overloads.map((fn) =>
    `{\n${pad(5)}Args: ${argsType(fn)};\n${pad(5)}Returns: ${returnsType(fn)};\n${pad(4)}}`
  );
  const body = variants.length === 1
    ? variants[0]
    : variants.map((v) => `\n${pad(4)}| ${v}`).join("");
  return `${pad(3)}${key(name)}: ${body};`;
}

/** A section's body (`{ [_ in never]: never }` when empty). */
function section(entries: string[]): string {
  return entries.length
    ? `{\n${entries.join("\n")}\n${pad(2)}}`
    : "{\n      [_ in never]: never;\n    }";
}

/** Sort by name. */
function byName<T extends { name: string }>(list: Iterable<T>): T[] {
  return [...list].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** One schema's types. */
function schemaType(catalog: RestCatalog, schema: string): string {
  const relations = byName(catalog.tables.get(schema)?.values() ?? []);
  const isView = (t: RestTable) => t.kind === "view" || t.kind === "materialized view";
  const tables = relations.filter((t) => !isView(t)).map((t) =>
    tableEntry(t, catalog.foreignKeys, false)
  );
  const views = relations.filter(isView).map((t) => tableEntry(t, catalog.foreignKeys, true));
  const functions = [...catalog.functions.get(schema) ?? []]
    .sort(([a], [b]) => a < b ? -1 : 1)
    .map(([name, overloads]) => functionEntry(name, overloads));
  const enums = [...catalog.enums.get(schema) ?? []]
    .sort(([a], [b]) => a < b ? -1 : 1)
    .map(([name, labels]) =>
      `${pad(3)}${key(name)}: ${labels.length ? labels.map(lit).join(" | ") : "never"};`
    );
  const composites = byName(catalog.compositeTypes.filter((t) => t.schema === schema)).map((t) =>
    `${pad(3)}${key(t.name)}: ${
      objectType(t.columns.map((c) => `${key(c.name)}: ${nullable(c)}`), 3)
    };`
  );
  return `  ${key(schema)}: {\n` +
    `    Tables: ${section(tables)};\n` +
    `    Views: ${section(views)};\n` +
    `    Functions: ${section(functions)};\n` +
    `    Enums: ${section(enums)};\n` +
    `    CompositeTypes: ${section(composites)};\n` +
    `  };`;
}

/** `Constants`: each schema's enums as value arrays. */
function constants(catalog: RestCatalog): string {
  const schemas = catalog.schemas.map((schema) => {
    const enums = [...catalog.enums.get(schema) ?? []].sort(([a], [b]) => a < b ? -1 : 1)
      .map(([name, labels]) => `      ${key(name)}: [${labels.map(lit).join(", ")}],`);
    return `  ${key(schema)}: {\n    Enums: {${
      enums.length ? `\n${enums.join("\n")}\n    ` : ""
    }},\n  },`;
  });
  return `export const Constants = {\n${schemas.join("\n")}\n} as const;`;
}

/**
 * The source of `.denext/rest.ts` for `catalog`.
 *
 * @param catalog The catalog.
 * @returns The module source.
 */
export function generateRestTypes(catalog: RestCatalog): string {
  const main = catalog.schemas[0] ?? "public";
  const schemas = catalog.schemas.map((schema) => schemaType(catalog, schema)).join("\n");
  return `// AUTO-GENERATED by @denext/backend — DO NOT EDIT.
// Regenerated on \`denext build\` / \`denext dev\` from the catalog of the schemas
// ${
    catalog.schemas.join(", ")
  }, in the shape \`supabase gen types typescript\` writes. Import it once
// (\`import "./.denext/rest.ts";\`) to type \`from("table")\` from @denext/backend/client, or pass
// \`Database\` to \`createClient<Database>()\` from @supabase/supabase-js.

/** A JSON value (a \`json\` / \`jsonb\` column). */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

/** Every exposed schema: its tables, views, functions, enums and composite types. */
export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "12";
  };
${schemas}
};

type DefaultSchema = Database[${lit(main)}];

/** A table's or view's row. */
export type Tables<T extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])> =
  (DefaultSchema["Tables"] & DefaultSchema["Views"])[T] extends { Row: infer R } ? R : never;
/** What an insert into a table takes. */
export type TablesInsert<T extends keyof DefaultSchema["Tables"]> =
  DefaultSchema["Tables"][T] extends { Insert: infer I } ? I : never;
/** What an update of a table takes. */
export type TablesUpdate<T extends keyof DefaultSchema["Tables"]> =
  DefaultSchema["Tables"][T] extends { Update: infer U } ? U : never;
/** An enum's values. */
export type Enums<T extends keyof DefaultSchema["Enums"]> = DefaultSchema["Enums"][T];
/** A composite type. */
export type CompositeTypes<T extends keyof DefaultSchema["CompositeTypes"]> =
  DefaultSchema["CompositeTypes"][T];

${constants(catalog)}

/** The default schema's tables and views, as \`from()\` sees them. */
export type RestTables = DefaultSchema["Tables"] & DefaultSchema["Views"];

declare module "@denext/backend/client" {
  interface RegisteredRest {
    tables: RestTables;
    database: Database;
  }
}
`;
}

/** The stub written when the catalog cannot be read. */
function stub(reason: string): string {
  return `// AUTO-GENERATED by @denext/backend — DO NOT EDIT.
// The database could not be read when this file was written, so auto-REST rows are typed
// Record<string, unknown>. Run \`denext dev\` or \`denext build\` with DATABASE_URL set to
// generate the table types. Reason: ${reason.replaceAll("\n", " ").slice(0, 300)}
export {};
`;
}

/** Whether `path` holds a generated (non-stub) file. */
async function hasGenerated(path: string): Promise<boolean> {
  try {
    return (await Deno.readTextFile(path)).includes("interface RegisteredRest");
  } catch {
    return false;
  }
}

/**
 * The prepare step: read the catalog and write `.denext/rest.ts`. When the catalog cannot be
 * read, an earlier generated file is kept, and otherwise a stub is written; either way the
 * reason is printed.
 *
 * @param outDir The `.denext` directory.
 * @param _rest The resolved options (the catalog carries the schemas).
 * @param catalog Reads the catalog.
 */
export async function writeRestTypes(
  outDir: string,
  _rest: unknown,
  catalog: () => Promise<RestCatalog>,
): Promise<void> {
  const path = `${outDir}/${REST_TYPES_FILE}`;
  let source: string;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${CATALOG_WAIT_MS / 1000} s`)),
        CATALOG_WAIT_MS,
      );
    });
    // The whole exposed schema, as `supabase gen types` writes it (the secret key's view).
    const read = await Promise.race([catalog(), timeout]);
    source = generateRestTypes(read.service ?? read);
  } catch (error) {
    const reason = (error as Error)?.message ?? String(error);
    const keep = await hasGenerated(path);
    console.warn(
      `[@denext/backend] rest: skipped generating .denext/${REST_TYPES_FILE} (${reason}); ` +
        (keep ? "keeping the previous one" : "rows are typed Record<string, unknown>"),
    );
    if (keep) return;
    source = stub(reason);
  } finally {
    clearTimeout(timer);
  }
  await Deno.mkdir(outDir, { recursive: true });
  await Deno.writeTextFile(path, source);
}
