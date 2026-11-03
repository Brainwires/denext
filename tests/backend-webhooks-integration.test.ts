// `@denext/backend` webhook retention against a REAL Postgres: settled events past their
// retention are deleted (delivered after `deliveredMs`, failed after `failedMs`), pending ones and
// younger ones are kept, through the `backend_webhooks_0002` index.
//
// Opt-in, on denext's Deno runtime (the built-in `Deno.SQL`):
//
//   docker run --rm -d --name dnx-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
//     deno test -A tests/backend-webhooks-integration.test.ts
//
// Ignored without DENEXT_TEST_POSTGRES_URL or Deno.SQL; tests/backend-webhooks.test.ts covers the
// statements and the schedule against a scripted client.

import { assertEquals } from "@std/assert";
import { builtinSql } from "../src/server/postgres.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import {
  ensureWebhooksMigrated,
  installWebhooks,
  purgeWebhookEvents,
  resolveWebhooks,
} from "../packages/backend/src/webhooks.ts";
import { postgresEnvironment } from "./helpers/postgres-env.ts";

const URL_ = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const SQL = builtinSql();
const reason = !URL_
  ? "set DENEXT_TEST_POSTGRES_URL"
  : !SQL
  ? "needs denext's Deno runtime (Deno.SQL)"
  : undefined;

Deno.test({
  name: `webhooks on a real Postgres: the retention cleanup deletes only settled, expired events${
    reason ? ` (skipped: ${reason})` : ""
  }`,
  ignore: reason !== undefined,
  async fn() {
    const env = await postgresEnvironment(true, SQL!, URL_!);
    try {
      installPostgres({ sql: env.app, rls: { migrate: false } });
      installWebhooks(resolveWebhooks({ delivery: "manual" }));
      const info = console.info;
      console.info = () => {};
      try {
        await ensureWebhooksMigrated(env.app);
      } finally {
        console.info = info;
      }
      // hook = what it is; created `age` days ago.
      const rows: Array<[string, string, number]> = [
        ["delivered-old", "delivered", 8],
        ["delivered-new", "delivered", 6],
        ["failed-old", "failed", 31],
        ["failed-mid", "failed", 8],
        ["pending-old", "pending", 90],
      ];
      for (const [hook, status, age] of rows) {
        await env.app.unsafe(
          "insert into supabase_functions.webhook_events (hook, payload, status, created_at) " +
            "values ($1, '{}', $2, now() - make_interval(days => $3))",
          [hook, status, age],
        );
      }
      assertEquals(await purgeWebhookEvents(), { deleted: 2 });
      const left = await env.app.unsafe<{ hook: string }>(
        "select hook from supabase_functions.webhook_events order by hook",
      );
      assertEquals(left.map((r) => r.hook), ["delivered-new", "failed-mid", "pending-old"]);
      const index = await env.app.unsafe(
        "select 1 from pg_indexes where indexname = 'webhook_events_settled_idx'",
      );
      assertEquals(index.length, 1);
    } finally {
      installWebhooks(undefined);
      installPostgres(undefined);
      await env.drop();
    }
  },
});
