// The help text of `denext gen` (the verb's summary, usage, flags and positionals: what `--help`,
// `denext --help`, shell completions and the CLI reference print), implemented in ../gen.ts. Edit
// it here, then run `deno task gen:command-table` (or `deno task regen`). Not published:
// scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the verb's spec
// reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import { GEN_ACTIONS } from "../gen.ts";
import { TARGET_FLAGS } from "./migration.ts";

/** `denext gen`. */
export const genMeta: CommandMeta = {
  name: "gen",
  summary: "Generate database types, API keys or a test bearer JWT (supabase gen)",
  loadsModules: true,
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
};
