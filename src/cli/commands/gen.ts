// `denext gen <types|keys|signing-key|bearer-jwt>` — the Supabase CLI's `gen` group:
//
//   types [typescript]  = `denext db types` (the whole schema's `Database` type; --schema, --file)
//   keys, signing-key   = `denext backend keys` (a publishable / secret key and an ES256 key)
//   bearer-jwt          = `denext backend token` (--role, --sub, --exp, --claims)
//
// They need `@denext/backend` (`types` with `postgres`, the rest with `supabase`).

import { resolve } from "@std/path";
import type { CommandSpec } from "../command.ts";
import { getPluginCommands } from "../../plugin/mod.ts";
import { backendAction, type MigrationRun } from "../db/migrations.ts";
import { dispatchDb, TARGET_FLAGS } from "./migration.ts";

/** Run the plugin verb `backend <action>` with this invocation's flags. */
function viaBackend(action: string): (run: MigrationRun) => Promise<void> {
  return async (run) => {
    const verb = getPluginCommands().find((c) => c.name === "backend");
    if (!verb) {
      throw new Error(
        "this needs @denext/backend with its Supabase surface: backend({ supabase: true })",
      );
    }
    await verb.run({ ...run.ctx, positionals: [action, ...run.ctx.positionals.slice(1)] });
  };
}

/** The `gen` actions. */
export const GEN_ACTIONS: Record<string, (run: MigrationRun) => Promise<void>> = {
  types: (run) => backendAction(run, "types"),
  keys: viaBackend("keys"),
  "signing-key": viaBackend("keys"),
  "bearer-jwt": viaBackend("token"),
};

export const genCommand: CommandSpec = {
  name: "gen",
  summary: "Generate database types, API keys or a test bearer JWT (supabase gen)",
  loadsModules: true,
  moduleDir: (ctx) => resolve(ctx.global.cwd ?? "."),
  usage: [
    "Usage: denext gen <types|keys|signing-key|bearer-jwt> [flags]",
    "",
    "  types [typescript]  The `Database` type for the schemas (= denext db types;",
    "                      --schema, --file <path>, --db-url / --linked)",
    "  keys, signing-key   A publishable key, a secret key and an ES256 signing key",
    "                      (= denext backend keys; --legacy, --json)",
    "  bearer-jwt          A signed access token (= denext backend token; --role, --sub, --exp)",
  ].join("\n"),
  positionals: [
    { name: "what", help: Object.keys(GEN_ACTIONS).join(" | "), required: true },
    { name: "lang", help: "types: typescript (the only one)" },
  ],
  flags: [
    {
      name: "schema",
      type: "string",
      repeatable: true,
      valueName: "<name>",
      help: "types: the schema (repeatable; default public)",
    },
    { name: "file", type: "string", valueName: "<path>", help: "types: write to this file" },
    { name: "legacy", type: "boolean", help: "keys: also mint the legacy HS256 keys" },
    { name: "role", type: "string", help: "bearer-jwt: authenticated | anon | service_role" },
    { name: "sub", type: "string", help: "bearer-jwt: the user id" },
    { name: "email", type: "string", help: "bearer-jwt: the email claim" },
    { name: "exp", type: "number", help: "bearer-jwt: seconds until it expires" },
    { name: "claims", type: "string", help: "bearer-jwt: extra claims, a JSON object" },
    ...TARGET_FLAGS,
  ],
  run: (ctx) => {
    if (
      ctx.positionals[0] === "types" && ctx.positionals[1] && ctx.positionals[1] !== "typescript"
    ) {
      console.error(`denext gen types: only typescript is generated (got ${ctx.positionals[1]})`);
      Deno.exit(1);
    }
    return dispatchDb("gen", ctx, GEN_ACTIONS);
  },
};
