// `denext graphql sdl` against a real app whose `schema` is a module path: the verb imports the
// app's schema module, so it must run under the APP's config (its import map names the npm
// packages the schema uses), not whichever config the CLI process happened to start with.

import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { boundedOutput } from "./helpers/bounded-command.ts";

const abs = (p: string) => fromFileUrl(new URL(`../${p}`, import.meta.url));

Deno.test({
  name: "denext graphql sdl loads a module-path schema through the app's own import map",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // From the example's directory with NO --config: the example's deno.json (and only it) maps
    // `@pothos/core`, which its app/graphql/schema.ts imports.
    const out = await boundedOutput(Deno.execPath(), {
      args: ["run", "-A", abs("cli.ts"), "graphql", "sdl"],
      cwd: abs("examples/graphql"),
      env: { NO_COLOR: "1", DENEXT_DENO: "stock" },
    });
    const stdout = new TextDecoder().decode(out.stdout);
    const log = stdout + new TextDecoder().decode(out.stderr);
    assert(out.success, log);
    assertStringIncludes(stdout, "type Subscription");
    assertStringIncludes(stdout, "messages(room: String!): Message");
  },
});
