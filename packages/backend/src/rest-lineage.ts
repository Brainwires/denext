// Views' column lineage, the way PostgREST infers it: each view column that is a plain reference
// to a column of another relation carries that origin in the view's `_RETURN` rule
// (`pg_rewrite.ev_action`, a node tree whose target entries hold `:resorigtbl` / `:resorigcol`).
// With it a view inherits its base tables' foreign keys and unique keys, so embedding works
// from a view, into a view, and through a view as a junction — and a view over a view follows
// the chain to the table underneath. Only column references count: an expression, an aggregate
// or a function call has no origin, so a key that needs such a column is not inherited.

import type { RestForeignKey, RestRelationName } from "./rest-catalog.ts";

/** One view column traced to its origin. */
export interface LineageEntry {
  /** The view column. */
  readonly column: string;
  /** The origin relation's oid. */
  readonly oid: string;
  /** The origin column's attnum. */
  readonly attnum: number;
}

/** A target entry of a rule's node tree (its name may hold `\`-escaped characters). */
const TARGET_ENTRY =
  /:resno (\d+) :resname ((?:\\.|[^\s\\])+) :ressortgroupref \d+ :resorigtbl (\d+) :resorigcol (\d+) :resjunk (true|false)/g;

/**
 * The column references of a view's `_RETURN` rule.
 *
 * @param action `pg_rewrite.ev_action::text`.
 * @returns Each named, non-junk target entry with an origin, first occurrence per column.
 */
export function parseLineage(action: string): LineageEntry[] {
  const seen = new Set<string>();
  const out: LineageEntry[] = [];
  for (const match of action.matchAll(TARGET_ENTRY)) {
    const [, , rawName, oid, attnum, junk] = match;
    if (junk === "true" || oid === "0") continue;
    const column = rawName.replace(/\\(.)/g, "$1");
    if (column === "<>" || seen.has(column)) continue;
    seen.add(column);
    out.push({ column, oid, attnum: Number(attnum) });
  }
  return out;
}

/** A relation known by oid: its name and its columns by attnum. */
export interface RelationInfo extends RestRelationName {
  /** Column names by attnum. */
  readonly columns: ReadonlyMap<number, string>;
}

/** A view over a relation: the view and how the relation's columns appear in it. */
export interface ViewOver {
  /** The view's oid. */
  readonly oid: string;
  /** The view. */
  readonly view: RestRelationName;
  /** Base column name → the view's column name. */
  readonly columns: ReadonlyMap<string, string>;
}

/**
 * For each relation (by oid), the views over it, following views over views down to the
 * relation a column really comes from.
 *
 * @param lineage Each view's (by oid) traced columns.
 * @param relations Every relation by oid.
 * @returns Base relation oid → the views exposing its columns.
 */
export function viewsOver(
  lineage: ReadonlyMap<string, readonly LineageEntry[]>,
  relations: ReadonlyMap<string, RelationInfo>,
): Map<string, ViewOver[]> {
  const out = new Map<string, ViewOver[]>();
  for (const [viewOid, entries] of lineage) {
    const view = relations.get(viewOid);
    if (!view) continue;
    const byBase = new Map<string, Map<string, string>>();
    for (const entry of entries) {
      const origin = traceOrigin(entry.oid, entry.attnum, lineage, relations, 0);
      if (!origin) continue;
      const columns = byBase.get(origin.oid) ?? new Map<string, string>();
      byBase.set(origin.oid, columns);
      if (!columns.has(origin.column)) columns.set(origin.column, entry.column);
    }
    for (const [baseOid, columns] of byBase) {
      const list = out.get(baseOid) ?? [];
      out.set(baseOid, list);
      list.push({ oid: viewOid, view: { schema: view.schema, name: view.name }, columns });
    }
  }
  return out;
}

/** The deepest view chain followed. */
const MAX_VIEW_DEPTH = 16;

/** Follow an origin through views to the relation that owns the column. */
function traceOrigin(
  oid: string,
  attnum: number,
  lineage: ReadonlyMap<string, readonly LineageEntry[]>,
  relations: ReadonlyMap<string, RelationInfo>,
  depth: number,
): { oid: string; column: string } | undefined {
  const relation = relations.get(oid);
  const column = relation?.columns.get(attnum);
  if (!relation || column === undefined) return undefined;
  const inner = lineage.get(oid)?.find((e) => e.column === column);
  if (inner && depth < MAX_VIEW_DEPTH) {
    return traceOrigin(inner.oid, inner.attnum, lineage, relations, depth + 1) ??
      { oid, column };
  }
  return { oid, column };
}

/** Map every column through a view, or `undefined` when one is not exposed by it. */
function mapped(columns: readonly string[], over: ViewOver): string[] | undefined {
  const out: string[] = [];
  for (const column of columns) {
    const name = over.columns.get(column);
    if (name === undefined) return undefined;
    out.push(name);
  }
  return out;
}

/** A foreign key's end: the relation and its columns. */
interface End {
  rel: RestRelationName;
  columns: readonly string[];
}

/** The ends a foreign key end can take: the relation itself, and each view covering its columns. */
function endsOf(oid: string, end: End, views: ReadonlyMap<string, ViewOver[]>): End[] {
  const ends: End[] = [end];
  for (const over of views.get(oid) ?? []) {
    const columns = mapped(end.columns, over);
    if (columns) ends.push({ rel: over.view, columns });
  }
  return ends;
}

/** A base foreign key with the oids of its two ends. */
export interface BaseForeignKey extends RestForeignKey {
  /** The referencing relation's oid. */
  readonly oid: string;
  /** The referenced relation's oid. */
  readonly foreignOid: string;
}

/**
 * Every foreign key as seen through views: each base key, plus the same key from every view
 * covering its columns and to every view covering the referenced columns (both ends may be
 * views). The constraint keeps its name, so a `!hint` names it either way.
 *
 * @param keys The base foreign keys.
 * @param views {@linkcode viewsOver}'s result.
 * @returns The keys, views included (ends not yet filtered to the exposed relations).
 */
export function inheritedForeignKeys(
  keys: readonly BaseForeignKey[],
  views: ReadonlyMap<string, ViewOver[]>,
): RestForeignKey[] {
  const out: RestForeignKey[] = [];
  for (const fk of keys) {
    const origins = endsOf(fk.oid, { rel: fk.table, columns: fk.columns }, views);
    const targets = endsOf(
      fk.foreignOid,
      { rel: fk.foreignTable, columns: fk.foreignColumns },
      views,
    );
    for (const origin of origins) {
      for (const target of targets) {
        out.push({
          name: fk.name,
          table: origin.rel,
          columns: origin.columns,
          foreignTable: target.rel,
          foreignColumns: target.columns,
        });
      }
    }
  }
  return out;
}

/**
 * A base relation's unique keys as a view shows them: each key whose every column the view
 * exposes.
 *
 * @param keys The base relation's unique keys.
 * @param over The view over it.
 * @returns The view's inherited keys.
 */
export function inheritedKeys(
  keys: readonly (readonly string[])[],
  over: ViewOver,
): string[][] {
  return keys.map((key) => mapped(key, over)).filter((k): k is string[] => k !== undefined);
}
