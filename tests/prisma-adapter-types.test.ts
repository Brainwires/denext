// `denext/prisma-adapter` restates Prisma's driver-adapter contract instead of importing it
// (the runtime stays zero-npm). This checks the restatement against the real
// `@prisma/driver-adapter-utils` at the version denext pins for Prisma (6.19.3), in both
// directions: what the adapter produces is what Prisma takes, and what Prisma passes is what the
// adapter reads. The checks are type-level: `deno test` type-checks this file.

import { assertEquals } from "@std/assert";
import type * as Prisma from "@prisma/driver-adapter-utils";
import {
  ColumnTypeEnum,
  type MappedError,
  PrismaDenoSql,
  type SqlDriverAdapter,
  type SqlQuery,
  type SqlResultSet,
  type Transaction,
} from "../src/server/prisma-adapter/mod.ts";

/** `true` when `A` and `B` are mutually assignable. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Prisma reads these from the adapter: ours must be assignable to Prisma's.
const _factory: Prisma.SqlMigrationAwareDriverAdapterFactory = new PrismaDenoSql(":memory:");
const _adapter = (a: SqlDriverAdapter): Prisma.SqlDriverAdapter => a;
const _tx = (t: Transaction): Prisma.Transaction => t;
const _result = (r: SqlResultSet): Prisma.SqlResultSet => r;
// Prisma passes these to the adapter: Prisma's must be assignable to ours.
const _query = (q: Prisma.SqlQuery): SqlQuery => q;
// The shared vocabularies are the same sets.
const sameErrors: Same<MappedError, Prisma.MappedError> = true;
const sameColumnTypes: Same<typeof ColumnTypeEnum, typeof Prisma.ColumnTypeEnum> = true;

Deno.test("prisma-adapter: the restated contract matches @prisma/driver-adapter-utils 6.19.3", () => {
  void [_factory, _adapter, _tx, _result, _query];
  assertEquals([sameErrors, sameColumnTypes], [true, true]);
  assertEquals(Object.keys(ColumnTypeEnum).length, 32);
});
