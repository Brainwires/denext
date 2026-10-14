// `backend()` wiring for the platform services: each needs `postgres`; with it, the plugin
// installs vault, queues and webhooks, contributes `denext db` (and `denext functions`), and at
// server start applies the queues and webhooks migrations and starts webhook delivery — stopped
// on teardown. On a scripted Postgres.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { backend } from "../packages/backend/mod.ts";
import {
  applyPlugins,
  getPluginCommands,
  resetPlugins,
  runPluginTeardown,
} from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import { installVault } from "../packages/backend/src/vault.ts";
import { installQueues } from "../packages/backend/src/queues.ts";
import { installWebhooks, WEBHOOK_CHANNEL } from "../packages/backend/src/webhooks.ts";
import { scriptedSql } from "./helpers/scripted-sql.ts";

const load = ((path: string) => import(path)) as unknown as ModuleLoader;

Deno.test("backend(): vault, queues and webhooks need postgres", () => {
  for (const service of ["vault", "queues", "webhooks"] as const) {
    assertThrows(() => backend({ [service]: {} }), TypeError, `${service} needs \`postgres\``);
  }
});

Deno.test({
  name: "backend(): the platform services at server start, and teardown",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = scriptedSql(() => [], { withListen: true });
    const root = await Deno.makeTempDir();
    try {
      resetPlugins();
      const config = {
        plugins: [backend({
          postgres: { sql, rls: { migrate: false } },
          vault: { key: "k".repeat(32) },
          queues: {},
          webhooks: { hooks: { a: { url: "https://h.test/" } }, pollIntervalMs: 60_000 },
          functions: {},
        })],
      } as DenextConfig;
      await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "dev", load });
      const names = getPluginCommands().map((c) => c.name).sort();
      // `denext db` is core; the plugin installs its hooks for it instead.
      assertEquals(names, ["functions"]);
      const hooks = (globalThis as Record<symbol, unknown>)[Symbol.for("denext.backend.db")] as {
        serviceSchemas: string[];
      };
      assertEquals(hooks.serviceSchemas, ["vault", "pgmq", "pgmq_public", "supabase_functions"]);
      // Migrations applied in the background; delivery listening. Poll, with a deadline that
      // only bounds a failure.
      const deadline = Date.now() + 15_000;
      while (!sql.listeners.has(WEBHOOK_CHANNEL) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert(sql.listeners.has(WEBHOOK_CHANNEL));
      while (Date.now() < deadline) {
        const ran = (text: string) => sql.calls.some((c) => c.text.includes(text));
        if (ran("pgmq_public.send") && ran("supabase_functions.http_request")) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert(sql.calls.some((c) => c.text.includes("pgmq_public.send")), "queues migrated");
      assert(
        sql.calls.some((c) => c.text.includes("supabase_functions.http_request")),
        "webhooks migrated",
      );
      await runPluginTeardown();
      assert(!sql.listeners.has(WEBHOOK_CHANNEL), "delivery stopped");
    } finally {
      resetPlugins();
      installPostgres(undefined);
      installVault(undefined);
      installQueues(undefined);
      installWebhooks(undefined);
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "backend(): a failed startup migration is a warning, retried on first use",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = scriptedSql(() => {
      throw new Error("db unreachable");
    });
    const root = await Deno.makeTempDir();
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => warnings.push(String(line));
    try {
      resetPlugins();
      const config = {
        plugins: [backend({
          postgres: { sql, rls: { migrate: false } },
          queues: {},
          webhooks: { delivery: "manual" },
        })],
      } as DenextConfig;
      await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "prod", load });
      const deadline = Date.now() + 15_000;
      while (warnings.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assertStringIncludes(warnings.join("\n"), "queues: db unreachable");
      assertStringIncludes(warnings.join("\n"), "webhooks: db unreachable");
    } finally {
      console.warn = warn;
      await runPluginTeardown();
      resetPlugins();
      installPostgres(undefined);
      installQueues(undefined);
      installWebhooks(undefined);
      await Deno.remove(root, { recursive: true });
    }
  },
});
