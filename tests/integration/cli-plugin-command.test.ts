// Proves the plugin `addCommand` seam end-to-end: a project whose denext.config.ts
// lists a plugin that contributes a CLI verb can invoke that verb through the
// `denext` binary. The CLI discovers it only because the first parse hit an unknown
// command, then loaded the project's plugins.

import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { join } from "@std/path";

const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));

Deno.test("a plugin-contributed CLI verb is discovered and dispatched", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_plugin_cmd_" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({}));
    // A plugin whose setup contributes a `greet` verb. No denext import needed —
    // the plugin shape is just { name, setup }, and the command is a CommandSpec.
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default {
  plugins: [{
    name: "demo-plugin",
    setup(ctx) {
      ctx.addCommand({
        name: "greet",
        summary: "demo plugin verb",
        run: (c) => console.log("GREET_OK:" + (c.positionals[0] ?? "world")),
      });
    },
  }],
};
`,
    );

    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", CLI, "greet", "denext", "--cwd", dir],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);
    assert(code === 0, `expected exit 0, got ${code}. stderr:\n${err}`);
    assertStringIncludes(out, "GREET_OK:denext");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an unknown verb with no plugin still errors cleanly", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_plugin_none_" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({}));
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", CLI, "notacommand", "--cwd", dir],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    const err = new TextDecoder().decode(stderr);
    assert(code === 1, `expected exit 1, got ${code}`);
    assertStringIncludes(err, "unknown command");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
