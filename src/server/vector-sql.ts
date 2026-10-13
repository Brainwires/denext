// The SQL for Supabase's pgvector semantic-search recipe (`match_documents`), shared by
// `@denext/backend`'s `vectorSearchSql()` and `denext generate vector-search`.

/** A plain SQL identifier. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

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
 * rows with their similarity — callable with `matchDocuments()` from `@denext/backend/server`,
 * `db()`, or REST `/rpc`.
 *
 * ```sh
 * denext generate vector-search documents   # writes it as a migration
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
