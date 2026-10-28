// `denext doctor`'s `@denext/backend` checks (src/cli/commands/doctor-backend.ts): nothing for an
// app without the backend; a setup the backend refuses (a placeholder secret key) is a critical
// failure; an unreachable database is a critical failure; keys, storage and — with a test
// Postgres (DENEXT_TEST_POSTGRES_URL) — the database and pending migrations are reported.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type BackendCheck, backendChecks } from "../src/cli/commands/doctor-backend.ts";
import { applyPlugins, resetPlugins } from "../src/plugin/mod.ts";
import { installSupabaseKeys } from "../src/server/supabase-keys.ts";
import { generateSupabaseKeys } from "../src/server/supabase-keys.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { backend, fs } from "../packages/backend/mod.ts";
import { installRuntime } from "../packages/backend/src/runtime.ts";

const load = ((path: string) => import(path)) as unknown as ModuleLoader;
const PG = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;

function setUpWith(config: DenextConfig) {
  return (projectDir: string) =>
    applyPlugins({
      projectRoot: projectDir,
      appDir: `${projectDir}/app`,
      config,
      mode: "build",
      load,
    });
}

async function run(config: DenextConfig) {
  const root = await Deno.makeTempDir({ prefix: "dnx-doctor-backend-" });
  resetPlugins();
  installSupabaseKeys(undefined);
  installRuntime(undefined);
  try {
    return await backendChecks(root, config, setUpWith(config));
  } finally {
    resetPlugins();
    installSupabaseKeys(undefined);
    installRuntime(undefined);
    await Deno.remove(root, { recursive: true });
  }
}

const byName = (checks: BackendCheck[], name: string) => checks.find((c) => c.name === name);

Deno.test("doctor backend: nothing without @denext/backend", async () => {
  assertEquals(await backendChecks(".", { plugins: [] } as DenextConfig), []);
  assertEquals(await backendChecks(".", null), []);
});

Deno.test("doctor backend: a refused setup (placeholder secret key) is a critical failure", async () => {
  const g = await generateSupabaseKeys();
  const checks = await run({
    plugins: [backend({ supabase: { publishableKey: g.publishableKey, secretKey: "undefined" } })],
  } as DenextConfig);
  const config = byName(checks, "backend config");
  assert(config && !config.ok && config.critical, JSON.stringify(checks));
  assertStringIncludes(config.detail, "placeholder");
});

Deno.test("doctor backend: keys and storage are reported; an unreachable database fails", async () => {
  const g = await generateSupabaseKeys();
  const checks = await run({
    plugins: [backend({
      supabase: { publishableKey: g.publishableKey, signingKeys: g.signingKey },
      postgres: { url: "postgres://nobody:wrong@127.0.0.1:1/none" },
      storage: {
        secret: "storage-secret-at-least-32-characters",
        driver: fs({ dir: ".storage" }),
        buckets: { files: { authorize: () => true } },
      },
    })],
  } as DenextConfig);
  assertEquals(byName(checks, "backend keys")?.ok, true);
  const database = byName(checks, "backend database");
  assert(database && !database.ok && database.critical, JSON.stringify(checks));
  assert(!database.detail.includes("wrong"), "the password is masked");
  assertEquals(byName(checks, "backend storage")?.ok, true);
});

Deno.test({
  name: "doctor backend: a reachable database, and pending migrations reported",
  ignore: !PG,
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const checks = await run({
    plugins: [backend({ postgres: { url: PG }, queues: {} })],
  } as DenextConfig);
  const database = byName(checks, "backend database");
  assert(database?.ok, JSON.stringify(checks));
  const migrations = byName(checks, "backend migrations");
  // A fresh database: the queues service's own migrations have not run yet.
  assert(migrations && !migrations.ok, JSON.stringify(checks));
  assertStringIncludes(migrations.detail, "denext migration up");
});
