// `@denext/backend` pgvector helpers: embeddings as parameters and back, the extension check
// (with the fix in its error), the match_documents recipe's SQL for each distance, and the typed
// call. The recipe runs against a real Postgres with pgvector in
// tests/backend-platform-integration.test.ts.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  fromVector,
  matchDocuments,
  requireVector,
  toVector,
  vectorSearchSql,
  VectorUnavailableError,
} from "../packages/backend/src/vector.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import { scriptedSql } from "./helpers/scripted-sql.ts";

Deno.test("toVector / fromVector", () => {
  assertEquals(toVector([0.5, -1, 2]), "[0.5,-1,2]");
  assertEquals(toVector(new Float32Array([1, 2])), "[1,2]");
  assertThrows(() => toVector([]), TypeError);
  assertThrows(() => toVector([1, Number.NaN]), TypeError);
  assertThrows(() => toVector(["1" as unknown as number]), TypeError);
  assertEquals(fromVector("[1,2.5,-3]"), [1, 2.5, -3]);
  assertEquals(fromVector(" [] "), []);
  assertEquals(fromVector([4, 5]), [4, 5]);
});

Deno.test("vectorSearchSql: Supabase's recipe, per distance; identifiers validated", () => {
  const sql = vectorSearchSql();
  for (
    const part of [
      "create extension if not exists vector;",
      "create table if not exists documents",
      "embedding vector(1536) not null",
      "using hnsw (embedding vector_cosine_ops)",
      "create or replace function match_documents (",
      "1 - (documents.embedding <=> query_embedding) as similarity",
      "limit least(match_count, 200)",
      "alter table documents enable row level security;",
    ]
  ) assertStringIncludes(sql, part);
  const ip = vectorSearchSql({
    table: "chunks",
    fn: "find_chunks",
    dimensions: 3,
    distance: "inner_product",
    rls: false,
  });
  assertStringIncludes(ip, "vector_ip_ops");
  assertStringIncludes(ip, "(chunks.embedding <#> query_embedding) * -1");
  assertStringIncludes(ip, "create or replace function find_chunks");
  assert(!ip.includes("row level security"));
  assertStringIncludes(vectorSearchSql({ distance: "l2" }), "vector_l2_ops");
  assertThrows(() => vectorSearchSql({ table: "x; drop" }), TypeError, "table");
  assertThrows(() => vectorSearchSql({ fn: "1x" }), TypeError, "fn");
  assertThrows(() => vectorSearchSql({ dimensions: 0 }), TypeError, "dimensions");
  assertThrows(
    () => vectorSearchSql({ distance: "hamming" as "l2" }),
    TypeError,
    "distance",
  );
});

Deno.test("requireVector: once per client; a missing extension names the fix", async () => {
  let installed = false;
  const sql = scriptedSql(() => [{ ok: installed }]);
  await assertRejects(() => requireVector(sql), VectorUnavailableError, "create extension");
  installed = true;
  await requireVector(sql);
  await requireVector(sql);
  assertEquals(sql.calls.length, 2, "a failure is re-checked; a success is remembered");
});

Deno.test("matchDocuments: the typed call, as the request's identity or a given one", async () => {
  const sql = scriptedSql((text) => {
    if (text.includes("pg_extension")) return [{ ok: true }];
    if (text.includes("match_documents(")) {
      return [{ id: "1", content: "cats", metadata: '{"k":1}', similarity: "0.98" }];
    }
    if (text.includes("find(")) {
      return [{ id: "2", content: "dogs", metadata: { k: 2 }, similarity: 0.5 }];
    }
    return [];
  });
  installPostgres({ sql, rls: { migrate: false } });
  try {
    const [match] = await matchDocuments<{ k: number }>({ embedding: [1, 0], matchCount: 3 });
    assertEquals(match, { id: 1, content: "cats", metadata: { k: 1 }, similarity: 0.98 });
    const call = sql.calls.find((c) => c.text.includes("match_documents("))!;
    assertEquals(call.params, ["[1,0]", 0.5, 3]);
    assertEquals(
      sql.calls.find((c) => c.text.includes("set_config('role'"))?.params[0],
      "anon",
      "outside a request: anon",
    );
    const [other] = await matchDocuments({
      embedding: [1],
      fn: "find",
      as: "service",
      matchThreshold: 0.1,
    });
    assertEquals(other.metadata, { k: 2 });
    await matchDocuments({ embedding: [1], as: { id: "6d1c4c6e-7a1e-4d43-9a0f-3c1f0c0a0001" } });
    await assertRejects(() => matchDocuments({ embedding: [1], fn: "x y" }), TypeError);
  } finally {
    installPostgres(undefined);
  }
});
