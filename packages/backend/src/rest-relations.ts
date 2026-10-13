// Embedded resources: which relationship `select=*,books(*)` means, inferred from the foreign
// keys the catalog read — PostgREST's rules. From a relation P, an embed named N can follow
//
//   - many-to-one: a foreign key of P to a relation named N (or N is that key's column, or its
//     constraint name); one object (or null);
//   - one-to-many: a foreign key of a relation named N to P (one-to-one when its columns are a
//     unique key of N); an array (or one object);
//   - many-to-many: a junction J with foreign keys to P and to N whose columns are all part of
//     one of J's unique keys (its primary key, typically); an array.
//
// A `!hint` (a constraint name, a foreign-key column, or the junction's name) picks one when
// several match. None is PostgREST's 400 `PGRST200`; several are its 300 `PGRST201` with the
// candidates in `details`.

import {
  type RestCatalog,
  type RestForeignKey,
  type RestRelationName,
  type RestTable,
  tableIn,
} from "./rest-catalog.ts";
import { RestError } from "./rest-parse.ts";

/** A resolved relationship from a parent relation to an embedded one. */
export interface Relationship {
  /** `m2o` (many-to-one), `o2m` (one-to-many, or one-to-one), `m2m` (through a junction). */
  readonly kind: "m2o" | "o2m" | "m2m";
  /** It yields at most one row (an object, not an array). */
  readonly toOne: boolean;
  /** The foreign key's (or the junction's) name. */
  readonly name: string;
  /** The embedded relation. */
  readonly target: RestTable;
  /** For `m2o` / `o2m`: `[target column, parent column]` pairs that must be equal. */
  readonly pairs: readonly (readonly [string, string])[];
  /** For `m2m`: the junction, and its column pairs to the target and to the parent. */
  readonly junction?: {
    readonly table: RestTable;
    /** `[junction column, target column]`. */
    readonly toTarget: readonly (readonly [string, string])[];
    /** `[junction column, parent column]`. */
    readonly toParent: readonly (readonly [string, string])[];
  };
}

/** Same relation. */
function same(a: RestRelationName, b: RestRelationName): boolean {
  return a.schema === b.schema && a.name === b.name;
}

/** Whether `columns` are (in any order) exactly a unique key of `table`, or include one. */
function coversUniqueKey(table: RestTable, columns: readonly string[]): boolean {
  const set = new Set(columns);
  return (table.uniqueKeys ?? [table.primaryKey]).some((key) =>
    key.length > 0 && key.every((c) => set.has(c))
  );
}

/** Whether every one of `columns` is part of one unique key of `table`. */
function withinUniqueKey(table: RestTable, columns: readonly string[]): boolean {
  return (table.uniqueKeys ?? [table.primaryKey]).some((key) =>
    columns.every((c) => key.includes(c))
  );
}

/** Zip two column lists into pairs. */
function zip(a: readonly string[], b: readonly string[]): [string, string][] {
  return a.map((column, i) => [column, b[i]]);
}

/** The candidate relationships from `parent` for an embed named `name`. */
function candidates(catalog: RestCatalog, parent: RestRelationName, name: string): Relationship[] {
  const found: Relationship[] = [];
  const keys = catalog.foreignKeys;
  for (const fk of keys) {
    const single = fk.columns.length === 1 ? fk.columns[0] : undefined;
    if (same(fk.table, parent) && [fk.foreignTable.name, fk.name, single].includes(name)) {
      const target = tableIn(catalog, fk.foreignTable.schema, fk.foreignTable.name)!;
      found.push({
        kind: "m2o",
        toOne: true,
        name: fk.name,
        target,
        pairs: zip(fk.foreignColumns, fk.columns),
      });
    }
    if (same(fk.foreignTable, parent) && (fk.table.name === name || fk.name === name)) {
      const target = tableIn(catalog, fk.table.schema, fk.table.name)!;
      found.push({
        kind: "o2m",
        toOne: coversUniqueKey(target, fk.columns),
        name: fk.name,
        target,
        pairs: zip(fk.columns, fk.foreignColumns),
      });
    }
  }
  return [...found, ...manyToMany(catalog, parent, name)];
}

/** The many-to-many candidates: junctions with keys to `parent` and to a relation `name`. */
function manyToMany(catalog: RestCatalog, parent: RestRelationName, name: string): Relationship[] {
  const found: Relationship[] = [];
  const keys = catalog.foreignKeys;
  for (const toParent of keys) {
    if (!same(toParent.foreignTable, parent)) continue;
    for (const toTarget of keys) {
      if (!isJunctionPair(catalog, toParent, toTarget, name)) continue;
      const junction = tableIn(catalog, toParent.table.schema, toParent.table.name)!;
      found.push({
        kind: "m2m",
        toOne: false,
        name: junction.name,
        target: tableIn(catalog, toTarget.foreignTable.schema, toTarget.foreignTable.name)!,
        pairs: [],
        junction: {
          table: junction,
          toTarget: zip(toTarget.columns, toTarget.foreignColumns),
          toParent: zip(toParent.columns, toParent.foreignColumns),
        },
      });
    }
  }
  return found;
}

/** Whether two foreign keys of one relation make it a junction from the parent to `name`. */
function isJunctionPair(
  catalog: RestCatalog,
  toParent: RestForeignKey,
  toTarget: RestForeignKey,
  name: string,
): boolean {
  if (toTarget === toParent || !same(toTarget.table, toParent.table)) return false;
  if (toTarget.foreignTable.name !== name) return false;
  const junction = tableIn(catalog, toParent.table.schema, toParent.table.name);
  return junction !== undefined &&
    withinUniqueKey(junction, [...toParent.columns, ...toTarget.columns]);
}

/** Whether a `!hint` selects the relationship. */
function hinted(rel: Relationship, hint: string, catalog: RestCatalog): boolean {
  if (rel.name === hint) return true;
  if (rel.kind === "m2m") {
    const j = rel.junction!.table;
    return catalog.foreignKeys.some((fk) => same(fk.table, j) && fk.name === hint);
  }
  const columns = rel.kind === "m2o" ? rel.pairs.map(([, p]) => p) : rel.pairs.map(([t]) => t);
  return columns.length === 1 && columns[0] === hint;
}

/**
 * A self-referencing key read both ways (`employees!supervisor_id`): the table's own name picks
 * the one-to-many side, as PostgREST does — the many-to-one side is reached by naming the column
 * (`supervisor:supervisor_id(name)`).
 */
function selfReference(found: Relationship[]): Relationship[] {
  if (found.length !== 2) return found;
  const [a, b] = found;
  if (a.name !== b.name || a.kind === b.kind || a.kind === "m2m" || b.kind === "m2m") return found;
  return [a.kind === "o2m" ? a : b];
}

/** PostgREST's cardinality word for a relationship. */
function cardinality(rel: Relationship): string {
  if (rel.kind === "m2m") return "many-to-many";
  if (rel.kind === "m2o") return "many-to-one";
  return rel.toOne ? "one-to-one" : "one-to-many";
}

/**
 * The relationship an embed means.
 *
 * @param catalog The catalog.
 * @param parent The parent relation.
 * @param name The embed's name.
 * @param hint Its `!hint`, if any.
 * @returns The relationship.
 * @throws {RestError} `PGRST200` (400) when none matches, `PGRST201` (300) when several do.
 */
export function resolveRelationship(
  catalog: RestCatalog,
  parent: RestRelationName,
  name: string,
  hint: string | undefined,
): Relationship {
  let found = candidates(catalog, parent, name);
  if (hint !== undefined) found = found.filter((rel) => hinted(rel, hint, catalog));
  found = selfReference(found);
  if (found.length === 1) return found[0];
  const label = hint === undefined ? name : `${name}!${hint}`;
  if (found.length === 0) {
    throw new RestError(
      400,
      "PGRST200",
      `Could not find a relationship between '${parent.name}' and '${label}' in the schema cache`,
      `Searched for a foreign key relationship between '${parent.name}' and '${label}' in the ` +
        `schema '${parent.schema}', but no matches were found.`,
      "Check the foreign keys between the two relations, and that both are exposed.",
    );
  }
  throw new RestError(
    300,
    "PGRST201",
    `Could not embed because more than one relationship was found for '${parent.name}' and ` +
      `'${name}'`,
    found.map((rel) => ({
      cardinality: cardinality(rel),
      embedding: `${parent.name} with ${rel.target.name}`,
      relationship: `${rel.name} using ${parent.name} and ${rel.target.name}`,
    })),
    `Try changing '${name}' to one of the following: ${
      found.map((rel) => `'${name}!${rel.name}'`).join(", ")
    }. Find the desired relationship in the 'details' key.`,
  );
}
