// `@denext/backend`'s platform services against a REAL Postgres (with pgvector): Vault (AES-GCM
// in the app, ciphertext bound to its row, key rotation, nothing granted to anon /
// authenticated), queues with pgmq's API as plain SQL (send / read with a visibility timeout /
// pop / archive / delete / set_vt / metrics / purge, and the pgmq_public wrappers obeying grants
// and row-level security), the queue consumer job, pgvector's match_documents recipe, and
// database webhooks (the trigger records, the app delivers signed requests with retries, and a
// target that is not configured is never fetched).
//
// The app connects as a NON-superuser role in a database of its own (both dropped afterwards).
// Opt-in, on denext's Deno runtime (the built-in `Deno.SQL`), with a superuser URL of a server
// that has pgvector (the pgvector/pgvector:pg17 image):
//
//   docker run --rm -d --name dnx-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 pgvector/pgvector:pg17
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
//     deno test -A tests/backend-platform-integration.test.ts
//
// The vector case needs the extension: with DENEXT_TEST_PGVECTOR=0 (a stock postgres image) it
// checks the clear error instead.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { builtinSql } from "../src/server/postgres.ts";
import { applyPlugins, resetPlugins, runPluginTeardown } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { backend } from "../packages/backend/mod.ts";
import {
  db,
  deliverWebhooks,
  matchDocuments,
  queue,
  queueConsumer,
  queues,
  requireVector,
  toVector,
  vault,
  vectorSearchSql,
  verifyWebhook,
  webhookEvents,
} from "../packages/backend/server.ts";
import { installPostgres, rlsReady } from "../packages/backend/src/postgres.ts";
import { postgresEnvironment as environment } from "./helpers/postgres-env.ts";

const URL_ = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const SQL = builtinSql();
const VECTOR = Deno.env.get("DENEXT_TEST_PGVECTOR") !== "0";
const reason = !URL_
  ? "set DENEXT_TEST_POSTGRES_URL"
  : !SQL
  ? "needs denext's Deno runtime (Deno.SQL)"
  : undefined;
const label = reason ? ` (skipped: ${reason})` : "";
const load = ((path: string) => import(path)) as unknown as ModuleLoader;
const A = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a00a1";
const B = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a00b2";
const KEY = "vault-key-at-least-32-characters-long!!";
const OLD_KEY = "an-older-vault-key-of-32-characters!!!";
const WEBHOOK_SECRET = "whsec_" + btoa("webhook-signing-secret-bytes");

Deno.test({
  name:
    `platform on a real Postgres: vault, queues + pgmq_public, consumer, pgvector, webhooks${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const env = await environment();
    const root = await Deno.makeTempDir({ prefix: "dnx-platform-pg-" });
    // A receiver for the webhooks: the first call to /flaky fails, then it succeeds.
    const received: { path: string; headers: Headers; body: string }[] = [];
    let flaky = 0;
    const receiver = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
      const path = new URL(req.url).pathname;
      received.push({ path, headers: req.headers, body: await req.text() });
      if (path === "/flaky" && flaky++ === 0) return new Response("no", { status: 503 });
      if (path === "/redirect") return Response.redirect("http://169.254.169.254/", 302);
      return new Response("ok");
    });
    const base = `http://127.0.0.1:${receiver.addr.port}`;
    try {
      await Deno.mkdir(`${root}/app`);
      resetPlugins();
      installPostgres(undefined);
      const config = {
        plugins: [
          backend({
            postgres: { sql: env.app },
            vault: { key: [KEY, OLD_KEY] },
            queues: {},
            webhooks: {
              hooks: {
                "order-created": { url: `${base}/orders`, secret: WEBHOOK_SECRET },
                "flaky": { url: `${base}/flaky`, secret: WEBHOOK_SECRET },
                "redirect": { url: `${base}/redirect` },
              },
              allowUrls: [`${base}/allowed/`],
              secret: WEBHOOK_SECRET,
              backoffMs: 1,
              maxAttempts: 3,
              delivery: "manual",
            },
          }),
        ],
      } as DenextConfig;
      await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "build", load });
      await rlsReady();

      await t.step("vault", async () => {
        const id = await vault.createSecret("sk_live_123", "stripe_key", "Stripe");
        assertEquals(await vault.get("stripe_key"), "sk_live_123");
        assertEquals(await vault.get("missing"), null);
        const [stored] = await db
          .service()`select secret, nonce, key_id::text as key_id from vault.secrets where id = ${id}::uuid`;
        assert(!String(stored.secret).includes("sk_live"), "ciphertext only");
        // A ciphertext moved onto another row does not decrypt there.
        const other = await vault.createSecret("other", "other_key");
        await db
          .service()`update vault.secrets set secret = ${stored.secret}, nonce = ${stored.nonce} where id = ${other}::uuid`;
        await assertRejects(() => vault.get("other_key"), Error, "does not decrypt");
        await vault.updateSecret(other, { secret: "fixed", description: "now fine" });
        assertEquals(await vault.get("other_key"), "fixed");
        await vault.updateSecret(id, { name: "stripe" });
        assertEquals(await vault.get("stripe"), "sk_live_123");
        const decrypted = await vault.decryptedSecrets();
        assertEquals(decrypted.map((s) => [s.name, s.decryptedSecret]), [
          ["stripe", "sk_live_123"],
          ["other_key", "fixed"],
        ]);
        assertEquals((await vault.list()).map((s) => s.description), ["Stripe", "now fine"]);
        // Nothing is granted to the client roles.
        await assertRejects(() => db({ as: { id: A } })`select * from vault.secrets`);
        await assertRejects(() => db({ as: "anon" })`select * from vault.secrets`);
        assertEquals(await vault.delete("other_key"), true);
        assertEquals(await vault.delete(id), true);
        assertEquals(await vault.delete("nope"), false);
      });

      await t.step("queues: pgmq's API as SQL", async () => {
        await queues.create("jobs");
        await queues.create("jobs"); // idempotent
        assertEquals((await queues.list()).map((q) => q.queueName), ["jobs"]);
        const jobs = queue<{ n: number }>("jobs");
        const first = await jobs.send({ n: 1 });
        const later = await jobs.send({ n: 2 }, { delay: 60 });
        const batch = await jobs.sendBatch([{ n: 3 }, { n: 4 }]);
        assertEquals(batch.length, 2);
        const read = await jobs.read({ vt: 30, qty: 10 });
        assertEquals(read.map((m) => m.message.n), [1, 3, 4], "the delayed one is hidden");
        assertEquals(read[0].readCt, 1);
        assertEquals((await jobs.read({ vt: 30, qty: 10 })).length, 0, "hidden while vt runs");
        await jobs.setVt(first, 0);
        const again = await jobs.read({ vt: 30, qty: 1 });
        assertEquals([again[0].msgId, again[0].readCt], [first, 2]);
        assertEquals(await jobs.archive(first), [first]);
        assertEquals(await jobs.delete(batch), batch);
        const metrics = await jobs.metrics();
        assertEquals([metrics.queueLength, metrics.totalMessages], [1, 4]);
        await jobs.setVt(later, 0);
        const popped = await jobs.pop();
        assertEquals(popped?.message, { n: 2 });
        assertEquals(await jobs.pop(), null);
        const [archived] = await db.service()`select count(*)::int as n from pgmq.a_jobs`;
        assertEquals(archived.n, 1);
        await jobs.sendBatch([{ n: 5 }, { n: 6 }]);
        assertEquals(await jobs.purge(), 2);
        const polled = jobs.read({ vt: 30, qty: 1, pollSeconds: 2 });
        await new Promise((r) => setTimeout(r, 200));
        await jobs.send({ n: 7 });
        assertEquals((await polled).map((m) => m.message.n), [7]);
        await assertRejects(
          () => db.service()`select pgmq.send('Bad-Name', '{}')`,
          Error,
          "invalid",
        );
        // SQL written for Supabase Queues runs as is.
        const [sent] = await db
          .service()`select * from pgmq.send(queue_name => 'jobs', msg => '{"n":8}', delay => 0)`;
        assert(Number(sent.send) > 0);
        const [m] = await db.service()`select * from pgmq.metrics_all()`;
        assertEquals(m.queue_name, "jobs");
      });

      await t.step("queues: pgmq_public obeys grants and row-level security", async () => {
        await queues.create("tasks");
        // Without a grant the wrappers reach nothing.
        await assertRejects(
          () => db({ as: { id: A } })`select * from pgmq_public.send('tasks', '{"owner":"x"}')`,
          Error,
          "permission denied",
        );
        await db.service().unsafe(`
          grant select, insert, update, delete on pgmq.q_tasks to authenticated;
          grant select, insert on pgmq.a_tasks to authenticated;
          alter table pgmq.q_tasks enable row level security;
          create policy own on pgmq.q_tasks to authenticated
            using (message ->> 'owner' = auth.uid()::text)
            with check (message ->> 'owner' = auth.uid()::text);
        `).simple!();
        const asA = db({ as: { id: A } });
        const asB = db({ as: { id: B } });
        const [mine] = await asA`select * from pgmq_public.send('tasks', ${
          JSON.stringify({ owner: A })
        }::jsonb)`;
        await assertRejects(
          () =>
            asA`select * from pgmq_public.send('tasks', ${JSON.stringify({ owner: B })}::jsonb)`,
          Error,
          "row-level security",
        );
        await db.service()`select pgmq.send('tasks', ${JSON.stringify({ owner: B })}::jsonb)`;
        assertEquals((await asB`select * from pgmq_public.read('tasks', 30, 10)`).length, 1);
        assertEquals(
          (await asA`select * from pgmq_public.read('tasks', 0, 10)`).map((r) => r.msg_id),
          [mine.send],
        );
        const [archived] =
          await asA`select pgmq_public.archive('tasks', ${mine.send}::bigint) as ok`;
        assertEquals(archived.ok, true);
        await assertRejects(
          () => db({ as: "anon" })`select * from pgmq_public.pop('tasks')`,
          Error,
          "permission denied",
        );
        // Queue names are validated before any SQL is built from them.
        await assertRejects(
          () => asA`select * from pgmq_public.pop('tasks; drop table x')`,
          Error,
          "invalid",
        );
      });

      await t.step("queueConsumer: handles, retries, dead-letters", async () => {
        await queues.create("mail");
        const mail = queue<{ to: string }>("mail");
        await mail.sendBatch([{ to: "ok@x" }, { to: "fail@x" }]);
        const seen: string[] = [];
        const job = queueConsumer<{ to: string }>({
          queue: "mail",
          vt: 0,
          batchSize: 10,
          maxAttempts: 2,
          handler: ({ message }) => {
            seen.push(message.to);
            if (message.to === "fail@x") throw new Error("smtp down");
          },
        });
        const ctx = {
          name: "mail",
          trigger: "manual" as const,
          signal: new AbortController().signal,
          attempt: 1,
        };
        assertEquals(await job.handler(ctx), { handled: 1, failed: 1, dead: 0 });
        assertEquals(await job.handler(ctx), { handled: 0, failed: 1, dead: 0 });
        assertEquals(await job.handler(ctx), { handled: 0, failed: 0, dead: 1 });
        assertEquals(seen, ["ok@x", "fail@x", "fail@x"]);
        assertEquals((await mail.metrics()).queueLength, 0);
      });

      await t.step("pgvector: match_documents", async () => {
        if (!VECTOR) {
          await assertRejects(
            () => requireVector(),
            Error,
            "create extension if not exists vector",
          );
          return;
        }
        // Created by a superuser in the app's database (the admin connection is on another one).
        const adminUrl = new URL(URL_!);
        adminUrl.pathname = `/${env.database}`;
        const admin = new SQL!(adminUrl.toString());
        try {
          await admin.unsafe(`create extension if not exists vector`);
        } finally {
          await admin.close();
        }
        await db.service().unsafe(vectorSearchSql({ dimensions: 3 })).simple!();
        await db.service()`insert into documents (content, metadata, embedding) values
          ('cats', '{"k":1}', ${toVector([1, 0, 0])}::vector),
          ('dogs', '{"k":2}', ${toVector([0, 1, 0])}::vector),
          ('cat food', '{"k":3}', ${toVector([0.9, 0.1, 0])}::vector)`;
        const matches = await matchDocuments<{ k: number }>({
          embedding: [1, 0, 0],
          matchThreshold: 0.5,
          matchCount: 5,
          as: { id: A },
        });
        assertEquals(matches.map((m) => m.content), ["cats", "cat food"]);
        assert(matches[0].similarity > 0.99);
        assertEquals(matches[1].metadata, { k: 3 });
        // The recipe grants the table to authenticated only.
        await assertRejects(
          () => matchDocuments({ embedding: [1, 0, 0], as: "anon" }),
          Error,
          "permission denied",
        );
      });

      await t.step(
        "webhooks: the trigger records, the app delivers signed, retries, refuses",
        async () => {
          await deliverWebhooks(); // applies the migration
          await db.service().unsafe(`
          create table orders (id int primary key, total int);
          grant select, insert, update, delete on orders to authenticated;
          create trigger orders_created after insert on orders for each row
            execute function supabase_functions.http_request('order-created', 'POST', '{"x-extra":"1"}', '{}', '1000');
          create trigger orders_updated after update on orders for each row
            execute function supabase_functions.http_request('flaky');
          create trigger orders_deleted after delete on orders for each row
            execute function supabase_functions.http_request('${base}/allowed/deleted');
          create trigger orders_truncated after truncate on orders for each statement
            execute function supabase_functions.http_request('http://169.254.169.254/latest/meta-data');
        `).simple!();
          // A user's write fires the trigger (SECURITY DEFINER records it).
          await db({ as: { id: A } })`insert into orders values (1, 10)`;
          await db.service()`update orders set total = 20 where id = 1`;
          await db.service()`delete from orders where id = 1`;
          await db.service()`truncate orders`;
          await assertRejects(() =>
            db({ as: { id: A } })`select * from supabase_functions.webhook_events`
          );
          const first = await deliverWebhooks();
          assertEquals(first, { delivered: 2, retrying: 1, failed: 1 });
          const order = received.find((r) => r.path === "/orders")!;
          const body = JSON.parse(order.body);
          assertEquals([body.type, body.table, body.schema, body.record, body.old_record], [
            "INSERT",
            "orders",
            "public",
            { id: 1, total: 10 },
            null,
          ]);
          assertEquals(order.headers.get("x-extra"), "1");
          const verified = await verifyWebhook(
            new Request("http://x/", { method: "POST", headers: order.headers, body: order.body }),
            WEBHOOK_SECRET,
          );
          assertEquals((verified as { type: string }).type, "INSERT");
          assertEquals(
            await verifyWebhook(
              new Request("http://x/", {
                method: "POST",
                headers: order.headers,
                body: order.body + " ",
              }),
              WEBHOOK_SECRET,
            ),
            null,
            "a changed body fails",
          );
          const deleted = received.find((r) => r.path === "/allowed/deleted")!;
          assertEquals(JSON.parse(deleted.body).old_record, { id: 1, total: 20 });
          assert(
            !received.some((r) => r.path.startsWith("/latest")),
            "a URL not allowed is never fetched",
          );
          await new Promise((r) => setTimeout(r, 50));
          assertEquals(await deliverWebhooks(), { delivered: 1, retrying: 0, failed: 0 });
          assertEquals(received.filter((r) => r.path === "/flaky").length, 2);
          const failed = await webhookEvents({ status: "failed" });
          assertEquals(failed.length, 1);
          assert(failed[0].lastError?.includes("not configured"));
          // A redirect is not followed: it counts as a failure, and is retried until maxAttempts.
          await db.service().unsafe(`
          create trigger orders_redirect after insert on orders for each row
            execute function supabase_functions.http_request('redirect');`).simple!();
          await db.service()`insert into orders values (2, 1)`;
          for (let i = 0; i < 3; i++) {
            await deliverWebhooks();
            await new Promise((r) => setTimeout(r, 20));
          }
          assertEquals(received.filter((r) => r.path === "/redirect").length, 3);
          assertEquals((await webhookEvents({ status: "failed" })).length, 2);
        },
      );
    } finally {
      await runPluginTeardown();
      resetPlugins();
      installPostgres(undefined);
      await receiver.shutdown();
      await env.drop();
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: `denext db on a real Postgres: push, status, diff against a shadow database, reset${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { createDbCommand, backendMigrationsOf } = await import(
      "../packages/backend/src/db-command.ts"
    );
    const { queuesMigrations } = await import("../packages/backend/src/queues-sql.ts");
    const env = await environment();
    const role = decodeURIComponent(new URL(env.url).username);
    await env.admin.unsafe(`ALTER ROLE ${role} CREATEDB`);
    const root = await Deno.makeTempDir({ prefix: "dnx-db-cmd-" });
    try {
      await Deno.mkdir(`${root}/app`);
      await Deno.mkdir(`${root}/migrations`);
      await Deno.writeTextFile(
        `${root}/migrations/20260101000000_init.sql`,
        "create table items (id int primary key, name text not null);",
      );
      await Deno.writeTextFile(`${root}/seed.sql`, "insert into items values (1, 'seeded');");
      resetPlugins();
      installPostgres(undefined);
      const config = {
        plugins: [backend({ postgres: { sql: env.app }, queues: {} })],
      } as DenextConfig;
      await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "build", load });
      const lines: string[] = [];
      const errors: string[] = [];
      let code = 0;
      const command = createDbCommand({
        url: env.url,
        backendMigrations: () => backendMigrationsOf([queuesMigrations]),
        serviceSchemas: ["pgmq", "pgmq_public"],
      }, {
        log: (l) => lines.push(l),
        error: (l) => errors.push(l),
        exit: (c) => (code = c),
        run: () => Promise.reject(new Error("unused")),
        write: (path, data) =>
          typeof data === "string" ? Deno.writeTextFile(path, data) : Deno.writeFile(path, data),
        connect: (url) => new SQL!(url),
      });
      const run = async (positionals: string[], flags: Record<string, string | boolean> = {}) => {
        lines.length = 0;
        errors.length = 0;
        code = 0;
        await command.run({ positionals, flags, global: { cwd: root } as never, rest: [] });
        return lines.join("\n");
      };
      const pushed = await run(["push"]);
      assert(pushed.includes("applied backend_queues_0001"), pushed);
      assert(pushed.includes("applied 20260101000000_init.sql"), pushed);
      assertEquals(await run(["push"]), "The database is up to date.");
      const status = await run(["status"]);
      assert(status.includes("applied  20260101000000_init.sql"), status);
      assertEquals(await run(["diff"]), "No changes: the database matches the migrations.");
      // A change made in the live database (a dashboard edit, say) shows up as DDL.
      await db.service().unsafe(`
        alter table items add column price integer default 0;
        create index items_name_idx on items (name);
        alter table items enable row level security;
        create policy "read items" on items for select to authenticated using (true);
        create function item_count() returns bigint language sql as $$ select count(*) from items $$;
      `).simple!();
      const diff = await run(["diff"]);
      for (
        const expected of [
          "ALTER TABLE public.items ADD COLUMN price integer DEFAULT 0;",
          "CREATE INDEX items_name_idx ON public.items USING btree (name);",
          "ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;",
          `CREATE POLICY "read items" ON public.items FOR SELECT TO authenticated USING (true);`,
          "CREATE OR REPLACE FUNCTION public.item_count()",
        ]
      ) assert(diff.includes(expected), `${expected}\n---\n${diff}`);
      // Written as a migration, then a reset re-applies everything and seeds.
      await run(["diff"], { file: "dashboard_changes" });
      assert(lines[0].startsWith("Wrote migrations/"), lines[0]);
      await run(["reset"]);
      assertEquals(code, 1);
      assert(errors[0].includes("--yes"));
      const reset = await run(["reset"], { yes: true });
      assert(reset.includes("seeded from seed.sql"), reset);
      assertEquals((await db.service()`select name, price from items`)[0], {
        name: "seeded",
        price: 0,
      });
      assertEquals(await run(["diff"]), "No changes: the database matches the migrations.");
      assertEquals((await db.service()`select count(*)::int as n from pgmq.meta`)[0].n, 0);
    } finally {
      resetPlugins();
      installPostgres(undefined);
      await env.drop();
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: `supabase-js rpc to pgmq_public on a real Postgres: grants and row-level security${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { createClient } = await import("@supabase/supabase-js");
    const { generateSupabaseKeys, resolveSupabaseKeys, signSupabaseJwt } = await import(
      "../src/server/auth/gotrue/keys.ts"
    );
    const { createApp } = await import("../src/server/app.ts");
    const { scanRoutes } = await import("../src/router/manifest.ts");
    const { getPluginRequestHandler } = await import("../src/plugin/mod.ts");
    const env = await environment();
    const root = await Deno.makeTempDir({ prefix: "dnx-pgmq-sb-" });
    const g = await generateSupabaseKeys();
    const keyConfig = {
      publishableKey: g.publishableKey,
      secretKey: g.secretKey,
      signingKeys: g.signingKey,
    };
    try {
      await Deno.mkdir(`${root}/app`);
      resetPlugins();
      installPostgres(undefined);
      const config = {
        plugins: [backend({
          supabase: keyConfig,
          postgres: { sql: env.app },
          queues: {},
          rest: { schemas: ["public", "pgmq_public"] },
        })],
      } as DenextConfig;
      await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "build", load });
      await rlsReady();
      await queues.create("tasks");
      await db.service().unsafe(`
        grant select, insert, update, delete on pgmq.q_tasks to authenticated;
        grant select, insert on pgmq.a_tasks to authenticated;
        alter table pgmq.q_tasks enable row level security;
        create policy own on pgmq.q_tasks to authenticated
          using (message ->> 'owner' = auth.uid()::text)
          with check (message ->> 'owner' = auth.uid()::text);
      `).simple!();
      const manifest = await scanRoutes(`${root}/app`);
      const handler = createApp({
        getManifest: () => manifest,
        load,
        matchExternal: getPluginRequestHandler(),
      });
      const appFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const headers = new Headers(request.headers);
        headers.set("host", "app.test");
        return await handler(
          new Request(request.url, { method: request.method, headers, body: request.body }),
        );
      }) as typeof fetch;
      const keys = await resolveSupabaseKeys(keyConfig);
      const tokenFor = (sub: string) =>
        signSupabaseJwt(keys, {
          sub,
          role: "authenticated",
          aud: "authenticated",
          exp: Math.floor(Date.now() / 1000) + 600,
        });
      const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
      // deno-lint-ignore no-explicit-any
      const as = async (sub?: string): Promise<any> => {
        const token = sub ? await tokenFor(sub) : undefined;
        return createClient("https://app.test", g.publishableKey, {
          global: { fetch: appFetch },
          auth,
          ...(token ? { accessToken: () => Promise.resolve(token) } : {}),
        }).schema("pgmq_public");
      };
      const a = await as(A);
      const sent = await a.rpc("send", { queue_name: "tasks", message: { owner: A, job: 1 } });
      assertEquals(sent.error, null);
      const [id] = sent.data as number[];
      assert(id > 0);
      // RLS: A cannot enqueue in B's name.
      const forged = await a.rpc("send", { queue_name: "tasks", message: { owner: B } });
      assertEquals(forged.status, 403);
      await db.service()`select pgmq.send('tasks', ${JSON.stringify({ owner: B })}::jsonb)`;
      const read = await a.rpc("read", { queue_name: "tasks", sleep_seconds: 30, n: 10 });
      assertEquals(read.data.map((m: { msg_id: number }) => m.msg_id), [id], "only A's own");
      const b = await as(B);
      assertEquals((await b.rpc("pop", { queue_name: "tasks" })).data[0].message.owner, B);
      assertEquals((await a.rpc("archive", { queue_name: "tasks", message_id: id })).data, true);
      assertEquals((await a.rpc("delete", { queue_name: "tasks", message_id: id })).data, false);
      // anon: no grant on the queue table.
      const anon = await (await as()).rpc("send", { queue_name: "tasks", message: {} });
      assert(anon.error, "anon refused");
      // A queue name that is not one is refused before SQL is built from it.
      const bad = await a.rpc("pop", { queue_name: "tasks; drop table x" });
      assertStringIncludes(String(bad.error?.message), "invalid");
    } finally {
      resetPlugins();
      installPostgres(undefined);
      await env.drop();
      await Deno.remove(root, { recursive: true });
    }
  },
});
