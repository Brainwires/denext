// `denext completions <shell>` is meant to be sourced from a shell rc file
// (`source <(denext completions bash)`), so it runs whenever a terminal opens — in whatever
// directory that is, a freshly cloned repository included. It must never import the project's
// `denext.config.ts` (or run a plugin `setup`): it lists denext's verbs, the forwarded Deno verbs
// and the project verbs the last `denext commands` recorded (`.denext/commands.json`, trusted only
// while its fingerprint matches), nothing else.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { writeCommandCache } from "../src/cli/command-cache.ts";
import { removeTempDir } from "./helpers/temp.ts";
import { boundedOutput } from "./helpers/bounded-command.ts";

const CLI = fromFileUrl(new URL("../cli.ts", import.meta.url));

/** A project whose config announces (and records) that it was imported. */
async function untrustedProject(): Promise<{ dir: string; marker: string }> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_completions_" }));
  const marker = join(dir, "imported.txt");
  await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `console.log("PWNED: config imported");
try { Deno.writeTextFileSync(${JSON.stringify(marker)}, "x"); } catch { /* no permission */ }
export default {
  commands: [{ name: "acme-seed", summary: "Load fixtures", run: () => {} }],
  plugins: [{ name: "evil", setup() { console.log("PWNED: setup ran"); } }],
};
`,
  );
  return { dir, marker };
}

/** `denext completions <shell>` run in `dir`. */
async function completions(dir: string, shell: string): Promise<string> {
  const out = await boundedOutput(Deno.execPath(), {
    args: ["run", "-A", CLI, "completions", shell],
    cwd: dir,
    env: { DENEXT_DENO: "stock", NO_COLOR: "1" },
  });
  const stdout = new TextDecoder().decode(out.stdout);
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  return stdout;
}

Deno.test("denext completions never imports the project's config or runs a plugin setup", async () => {
  const { dir, marker } = await untrustedProject();
  try {
    for (const shell of ["bash", "zsh", "fish"]) {
      const script = await completions(dir, shell);
      assert(!script.includes("PWNED"), `${shell}: ${script.slice(0, 200)}`);
      assertStringIncludes(script, "dev"); // denext's own verbs are there
      assert(!script.includes("acme-seed"), "no listing yet: no project verbs");
    }
    let imported = true;
    try {
      await Deno.stat(marker);
    } catch {
      imported = false;
    }
    assertEquals(imported, false, "the config ran");
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("denext completions lists the project verbs `denext commands` recorded", async () => {
  const { dir } = await untrustedProject();
  try {
    await writeCommandCache(dir, [{ name: "acme-seed", summary: "Load fixtures" }]);
    const script = await completions(dir, "zsh");
    assertStringIncludes(script, "'acme-seed:Load fixtures'");
    assert(!script.includes("PWNED"));
    // A config changed since the listing: the listing is not trusted, so it is not offered.
    await Deno.writeTextFile(join(dir, "denext.config.ts"), "export default {};\n");
    assert(!(await completions(dir, "bash")).includes("acme-seed"));
  } finally {
    await removeTempDir(dir);
  }
});
