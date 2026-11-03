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
import { dispatchDb } from "./migration.ts";
import { commandMeta } from "../command-meta.ts";

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
  ...commandMeta("gen"),
  moduleDir: (ctx) => resolve(ctx.global.cwd ?? "."),
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
