// pgvector helpers: embeddings as query parameters, a check that the `vector` extension is there
// (with the fix in the error), the SQL for Supabase's `match_documents` recipe, and a typed call
// to it. Nothing here needs the extension until it is used.

import type { SqlClient } from "@denext/denext/server";
import { db } from "./postgres.ts";
import type { DbIdentity } from "./rls.ts";
import { IDENTIFIER } from "./realtime-shared.ts";

/** Thrown when the `vector` extension is not installed in the database. */
export class VectorUnavailableError extends Error {
  constructor() {
    super(
      "pgvector: the `vector` extension is not installed in this database. Run " +
        "`create extension if not exists vector;` as a role allowed to (a superuser, or the " +
        "database owner where the provider marks it trusted), e.g. in a migration.",
    );
    this.name = "VectorUnavailableError";
  }
}

/**
 * An embedding as pgvector's text form (`[0.1,0.2,…]`), to bind as a parameter and cast:
 * `` db()`select * from items order by embedding <=> ${toVector(e)}::vector limit 5` ``.
 *
 * @param embedding The embedding.
 * @returns Its literal.
 * @throws {TypeError} For an empty list or a value that is not a finite number.
 */
export function toVector(embedding: ArrayLike<number>): string {
  const values = Array.from(embedding);
  if (!values.length || values.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    throw new TypeError("toVector: an embedding is a non-empty list of finite numbers");
  }
  return `[${values.join(",")}]`;
}

/**
 * pgvector's text form back to numbers (what a `vector` column reads as without a type parser).
 *
 * @param text The column's value (`"[1,2,3]"`), or numbers already.
 * @returns The embedding.
 */
export function fromVector(text: string | number[]): number[] {
  if (Array.isArray(text)) return text;
  const inner = text.trim().replace(/^\[|\]$/g, "");
  return inner === "" ? [] : inner.split(",").map(Number);
}

const checked = new WeakMap<SqlClient, Promise<void>>();

/**
 * Resolve when the `vector` extension is installed; reject with {@linkcode VectorUnavailableError}
 * otherwise. Checked once per client (a failure is re-checked next time).
 *
 * @param sql The client (default `db.service()`).
 */
export function requireVector(sql: SqlClient = db.service()): Promise<void> {
  let pending = checked.get(sql);
  if (!pending) {
    pending = Promise.resolve(
      sql.unsafe<{ ok: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ok",
      ),
    ).then((rows) => {
      if (![...rows][0]?.ok) throw new VectorUnavailableError();
    });
    pending.catch(() => checked.delete(sql));
    checked.set(sql, pending);
  }
  return pending;
}

/** Options for {@linkcode vectorSearchSql}. */
export interface VectorSearchSqlOptions {
  /** The table (default `"documents"`). */
  table?: string;
  /** The embedding's dimensions (default 1536, OpenAI's `text-embedding-3-small`). */
  dimensions?: number;
  /** The search function's name (default `"match_documents"`). */
  fn?: string;
  /** The distance: `"cosine"` (default), `"inner_product"` or `"l2"`. */
  distance?: "cosine" | "inner_product" | "l2";
  /** Enable row-level security on the table, readable by `authenticated` (default `true`). */
  rls?: boolean;
}

const DISTANCE = {
  cosine: { op: "<=>", ops: "vector_cosine_ops", similarity: (d: string) => `1 - (${d})` },
  inner_product: { op: "<#>", ops: "vector_ip_ops", similarity: (d: string) => `(${d}) * -1` },
  l2: { op: "<->", ops: "vector_l2_ops", similarity: (d: string) => `1 / (1 + (${d}))` },
} as const;

function identifier(name: string, what: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new TypeError(`vectorSearchSql: ${what} must be a plain identifier`);
  }
  return name;
}

/**
 * The SQL for Supabase's semantic-search recipe, for a migration: the `vector` extension, a
 * documents table (`id`, `content`, `metadata`, `embedding vector(N)`) with an HNSW index, and a
 * `match_documents(query_embedding, match_threshold, match_count)` function returning the closest
 * rows with their similarity — callable with {@linkcode matchDocuments}, `db()`, or REST `/rpc`.
 *
 * ```sh
 * denext generate migration add_documents   # then paste vectorSearchSql() into it
 * ```
 *
 * @param o The table, dimensions, function name and distance.
 * @returns The SQL.
 */
export function vectorSearchSql(o: VectorSearchSqlOptions = {}): string {
  const table = identifier(o.table ?? "documents", "table");
  const fn = identifier(o.fn ?? "match_documents", "fn");
  const dims = o.dimensions ?? 1536;
  if (!Number.isInteger(dims) || dims < 1 || dims > 16000) {
    throw new TypeError("vectorSearchSql: dimensions must be an integer from 1 to 16000");
  }
  const distance = DISTANCE[o.distance ?? "cosine"];
  if (!distance) throw new TypeError("vectorSearchSql: distance is cosine, inner_product or l2");
  const d = `${table}.embedding ${distance.op} query_embedding`;
  const rls = o.rls === false ? "" : `
alter table ${table} enable row level security;
create policy "authenticated read ${table}" on ${table} for select to authenticated using (true);
grant select on ${table} to authenticated;`;
  return `-- Semantic search over ${table} (pgvector), Supabase's match_documents recipe.
create extension if not exists vector;

create table if not exists ${table} (
  id bigint primary key generated always as identity,
  content text not null,
  metadata jsonb not null default '{}',
  embedding vector(${dims}) not null
);

create index if not exists ${table}_embedding_idx on ${table}
  using hnsw (embedding ${distance.ops});
${rls}

create or replace function ${fn} (
  query_embedding vector(${dims}),
  match_threshold float,
  match_count int
)
returns table (id bigint, content text, metadata jsonb, similarity float)
language sql stable
as $$
  select ${table}.id, ${table}.content, ${table}.metadata, ${distance.similarity(d)} as similarity
  from ${table}
  where ${distance.similarity(d)} > match_threshold
  order by ${d} asc
  limit least(match_count, 200);
$$;
`;
}

/** One match from {@linkcode matchDocuments}. */
export interface DocumentMatch<M = Record<string, unknown>> {
  /** The row's id. */
  id: number;
  /** Its content. */
  content: string;
  /** Its metadata. */
  metadata: M;
  /** How close it is (1 is identical for cosine). */
  similarity: number;
}

/** Options for {@linkcode matchDocuments}. */
export interface MatchDocumentsOptions {
  /** The query's embedding. */
  embedding: ArrayLike<number>;
  /** The lowest similarity returned (default 0.5). */
  matchThreshold?: number;
  /** The most rows returned (default 10). */
  matchCount?: number;
  /** The search function (default `"match_documents"`). */
  fn?: string;
  /**
   * Who the query runs as (default: the request's user, or anon — `db()`), so the table's
   * row-level security decides which documents can match.
   */
  as?: Exclude<DbIdentity, "service"> | "service";
}

/**
 * Call a `match_documents`-shaped function ({@linkcode vectorSearchSql}): the documents closest to
 * an embedding, as the request's user by default.
 *
 * @param o The embedding, threshold, count and function.
 * @returns The matches, closest first.
 * @throws {VectorUnavailableError} When the `vector` extension is missing.
 */
export async function matchDocuments<M = Record<string, unknown>>(
  o: MatchDocumentsOptions,
): Promise<DocumentMatch<M>[]> {
  const fn = identifier(o.fn ?? "match_documents", "fn");
  const vector = toVector(o.embedding);
  await requireVector();
  const sql = o.as === "service" ? db.service() : db(o.as === undefined ? {} : { as: o.as });
  const rows = await sql.unsafe<Record<string, unknown>>(
    `SELECT id::text AS id, content, metadata, similarity FROM ${fn}($1::vector, $2, $3)`,
    [vector, o.matchThreshold ?? 0.5, o.matchCount ?? 10],
  );
  return [...rows].map((row) => ({
    id: Number(row.id),
    content: String(row.content),
    metadata: (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) as M,
    similarity: Number(row.similarity),
  }));
}
