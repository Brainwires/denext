// Which `.env` tier a verb loads. `deno task start` used to read `.env.development` and never
// `.env.production`: the module gate loaded the env files BEFORE `start` marked the process as
// production, so the mode it derived was the default. A production verb now declares its tier,
// and the deployer's own `DENEXT_ENV` / `NODE_ENV` still wins over it.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { envTierFor } from "../src/cli/shared.ts";
import { buildCommand, exportCommand, startCommand } from "../src/cli/commands/serve.ts";
import { devCommand } from "../src/cli/commands/serve.ts";
import { defaultEnvFiles, loadEnv } from "../src/server/env.ts";

const nothing = () => undefined;

Deno.test("build, export and start declare the production tier; dev does not", () => {
  assertEquals(envTierFor(startCommand, nothing), "production");
  assertEquals(envTierFor(buildCommand, nothing), "production");
  assertEquals(envTierFor(exportCommand, nothing), "production");
  assertEquals(envTierFor(devCommand, nothing), undefined);
});

Deno.test("the deployer's DENEXT_ENV / NODE_ENV wins over the verb's tier", () => {
  const env = (vars: Record<string, string>) => (key: string) => vars[key];
  assertEquals(envTierFor(startCommand, env({ DENEXT_ENV: "staging" })), "staging");
  assertEquals(envTierFor(startCommand, env({ NODE_ENV: "test" })), "test");
  assertEquals(envTierFor(devCommand, env({ NODE_ENV: "production" })), "production");
  // A read that throws (`--allow-env=PORT`) falls back to the verb's tier, never crashes.
  assertEquals(
    envTierFor(startCommand, () => {
      throw new Error("not permitted");
    }),
    "production",
  );
});

Deno.test("the production tier reads .env.production, and .env.production.local over it", async () => {
  assertEquals(defaultEnvFiles("production"), [
    ".env",
    ".env.production",
    ".env.local",
    ".env.production.local",
  ]);
  const dir = await Deno.makeTempDir({ prefix: "denext_env_tier_" });
  const key = `DENEXT_TEST_TIER_${Date.now()}`;
  try {
    await Deno.writeTextFile(join(dir, ".env"), `${key}=base\n`);
    await Deno.writeTextFile(join(dir, ".env.development"), `${key}=dev\n`);
    await Deno.writeTextFile(join(dir, ".env.production"), `${key}=prod\n`);
    const merged = await loadEnv({ dir, mode: envTierFor(startCommand, nothing) });
    assertEquals(merged[key], "prod");
    assertEquals(Deno.env.get(key), "prod");
  } finally {
    Deno.env.delete(key);
    await Deno.remove(dir, { recursive: true });
  }
});
