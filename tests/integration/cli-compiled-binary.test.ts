// A `deno compile`d denext on a project whose denext.config.ts imports a plugin package. The
// binary resolves modules through its own embedded import map, so importing the project's config
// in-process failed (`Module not found: …/deno-compile-denext/packages/backend/mod.ts`) and both
// `denext commands` and `denext <project verb>` broke on such a project. They now run on the
// denext the project pins (a `deno run` child that reads the project's deno.json), as the
// binary's module verbs already did.
//
// Opt-in and heavy (it compiles the CLI and the pinned child fetches denext from JSR):
// DENEXT_TEST_COMPILED_CLI=1.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../..", import.meta.url));
const enabled = Deno.env.get("DENEXT_TEST_COMPILED_CLI") === "1";

/** A published denext + @denext/backend pair the project pins (the child runs these). */
const PINNED_DENEXT = "4.0.0";
const PINNED_BACKEND = "0.4.0";

const CONFIG = `import { backend } from "@denext/backend";
export default {
  plugins: [backend({ supabase: true })],
  commands: [{
    name: "seed",
    summary: "load fixture data",
    run: (c) => console.log("SEED_OK:" + (c.positionals[0] ?? "all")),
  }],
};
`;

async function run(bin: string, args: string[], cwd: string) {
  const { code, stdout, stderr } = await new Deno.Command(bin, {
    args,
    cwd,
    // The pinned child resolves the pins from JSR: a release younger than Deno's minimum
    // dependency age would otherwise be refused there.
    env: { DENEXT_MIN_DEP_AGE: "0" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return { code, out: decoder.decode(stdout), err: decoder.decode(stderr) };
}

Deno.test({
  name: `a compiled denext lists and runs a plugin project's verbs${
    enabled ? "" : " (skipped: set DENEXT_TEST_COMPILED_CLI=1)"
  }`,
  ignore: !enabled,
  async fn() {
    const tmp = await Deno.makeTempDir({ prefix: "denext_compiled_cli_" });
    try {
      const bin = join(tmp, Deno.build.os === "windows" ? "denext.exe" : "denext");
      const compiled = await new Deno.Command(Deno.execPath(), {
        args: [
          "compile",
          "-A",
          "--include",
          join(ROOT, "src/cli/lazy-modules.generated.ts"),
          "--output",
          bin,
          join(ROOT, "cli.ts"),
        ],
        cwd: ROOT,
        stdout: "inherit",
        stderr: "inherit",
      }).output();
      assert(compiled.success, "deno compile failed");
      const project = join(tmp, "app");
      await Deno.mkdir(join(project, "app"), { recursive: true });
      await Deno.writeTextFile(
        join(project, "deno.json"),
        JSON.stringify({
          imports: {
            "denext": `jsr:@denext/denext@${PINNED_DENEXT}`,
            "denext/server": `jsr:@denext/denext@${PINNED_DENEXT}/server`,
            "@denext/backend": `jsr:@denext/backend@${PINNED_BACKEND}`,
          },
        }),
      );
      await Deno.writeTextFile(join(project, "denext.config.ts"), CONFIG);

      const version = await run(bin, ["--version"], project);
      assertStringIncludes(version.out, "(binary)");
      // A verb the binary runs itself loads its module on demand (embedded by --include).
      const completions = await run(bin, ["completions", "bash"], tmp);
      assertEquals(completions.code, 0, completions.err);
      assertStringIncludes(completions.out, "_denext_complete()");

      // The project's plugin comes from JSR with a cold cache here: on a slow disk (Windows
      // scans every file written) its download alone can outlast the 1.5 s listing budget,
      // which bounds a hung `setup`, not a first download.
      const listing = await run(
        bin,
        ["commands", "--json", "--timeout", "120000", "--cwd", project],
        project,
      );
      assertEquals(listing.code, 0, listing.err);
      const json = JSON.parse(listing.out.slice(listing.out.indexOf("{"))) as {
        project: { name: string }[];
        timedOut: boolean;
        error?: string;
      };
      assertEquals(json.error, undefined);
      assertEquals(json.timedOut, false);
      const names = json.project.map((verb) => verb.name);
      assert(names.includes("seed"), `project verbs: ${names.join(", ")}`);
      assert(names.includes("backend"), `the plugin's verb is listed: ${names.join(", ")}`);

      const seed = await run(bin, ["seed", "users"], project);
      assertEquals(seed.code, 0, seed.err);
      assertStringIncludes(seed.out, "SEED_OK:users");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});
