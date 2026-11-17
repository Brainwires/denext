// A `denext.config.ts` that imports through an app-only import-map alias (`"@/": "./"`), run by a
// source checkout's CLI under the framework's own config. The published CLI and the compiled
// binary's pinned child read the project's deno.json, so the alias resolves there; a checkout's CLI
// reaches the app's map only through its module re-exec (src/cli/run-verb.ts), and the CSS gate
// imported the config before that re-exec ran, so the config failed with `Import "@/…" not a
// dependency and not in import map` (a `graphql({ schema })` imported as `@/gql/schema.ts`, say).

import { assert } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { boundedOutput } from "./helpers/bounded-command.ts";

Deno.test("a source checkout's CLI loads a config that imports through an app-only alias", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_config_alias_" }));
  try {
    const root = fromFileUrl(new URL("..", import.meta.url));
    const jobs = toFileUrl(join(root, "src/server/jobs.ts")).href;
    await Deno.mkdir(join(dir, "lib"));
    await Deno.mkdir(join(dir, "jobs"));
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ imports: { "@/": "./" } }));
    await Deno.writeTextFile(join(dir, "lib", "flags.ts"), "export const flags = { X: true };\n");
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `import { flags } from "@/lib/flags.ts";\nexport default { features: flags };\n`,
    );
    await Deno.writeTextFile(
      join(dir, "jobs", "hello.ts"),
      `import { defineJob } from "${jobs}";\n` +
        `export default defineJob({ handler: () => console.log("job ran") });\n`,
    );
    const out = await boundedOutput(Deno.execPath(), {
      args: [
        "run",
        "--config",
        join(root, "deno.json"),
        "-A",
        join(root, "cli.ts"),
        "job",
        "hello",
      ],
      cwd: dir,
      env: { NO_COLOR: "1", DENEXT_DENO: "stock", DENEXT_NO_DEPRECATION_WARNINGS: "1" },
    });
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);
    assert(!stderr.includes("not in import map"), stderr);
    assert(out.code === 0, `exit ${out.code}\n${stdout}\n${stderr}`);
    assert(stdout.includes("job ran"), `${stdout}\n${stderr}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
