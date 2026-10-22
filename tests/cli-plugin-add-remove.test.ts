// `denext plugin add` / `remove` end to end against a fake `deno` (DENO_BIN): the dependency step
// runs `deno add` / `deno remove` with the package in the project directory, then the config is
// created, wired, left alone (already wired), unwired, or, when it can't be edited safely, the
// manual wiring is printed. tests/cli-plugin-coverage.test.ts covers `list` and the usage exits.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { pluginCommand } from "../src/cli/commands/plugin.ts";
import { capture, makeCtx, stubExit } from "./_cli-coverage-helpers.ts";

/** A project directory with a fake `deno` that logs its arguments and exits with `FAKE_DENO_CODE`. */
async function project(): Promise<{ dir: string; log: string; dispose: () => Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_plugin_add_" });
  const bin = await Deno.makeTempDir({ prefix: "denext_plugin_bin_" });
  const log = join(bin, "calls.log");
  const fake = join(bin, "deno");
  await Deno.writeTextFile(
    fake,
    `#!/bin/sh\necho "$PWD|$*" >> "${log}"\nexit "\${FAKE_DENO_CODE:-0}"\n`,
  );
  await Deno.chmod(fake, 0o755);
  const prev = Deno.env.get("DENO_BIN");
  Deno.env.set("DENO_BIN", fake);
  return {
    dir,
    log,
    dispose: async () => {
      if (prev === undefined) Deno.env.delete("DENO_BIN");
      else Deno.env.set("DENO_BIN", prev);
      Deno.env.delete("FAKE_DENO_CODE");
      await Deno.remove(dir, { recursive: true });
      await Deno.remove(bin, { recursive: true });
    },
  };
}

/** Run `denext plugin <args>` in `dir`, Deno.exit stubbed; the output and any exit code. */
async function plugin(
  dir: string,
  positionals: string[],
  flags: Record<string, string | boolean> = {},
) {
  const cap = capture();
  const exit = stubExit();
  try {
    await pluginCommand.run(makeCtx({ positionals, flags, global: { cwd: dir } }));
  } catch (e) {
    if (!String(e).includes("__exit__")) throw e;
  } finally {
    exit.restore();
    cap.restore();
  }
  return { out: cap.logs.join("\n"), err: cap.errs.join("\n"), exits: exit.calls };
}

const POSIX = { ignore: Deno.build.os === "windows" }; // the fake `deno` is a shell script

Deno.test({
  name: "plugin add: deno add, then a new denext.config.ts with the plugin",
  ...POSIX,
  fn: async () => {
    const p = await project();
    try {
      const r = await plugin(p.dir, ["add", "@denext/htmx"]);
      assertEquals(r.exits, []);
      assertStringIncludes(r.out, "Installing jsr:@denext/htmx");
      assertStringIncludes(r.out, "Wrote denext.config.ts with `plugins: [htmx()]`");
      const config = await Deno.readTextFile(join(p.dir, "denext.config.ts"));
      assertStringIncludes(config, `import { htmx } from "@denext/htmx";`);
      assertStringIncludes(config, "htmx()");
      const [call] = (await Deno.readTextFile(p.log)).trim().split("\n");
      assertEquals(call.split("|")[1], "add jsr:@denext/htmx");
      assertEquals(await Deno.realPath(call.split("|")[0]), await Deno.realPath(p.dir));
    } finally {
      await p.dispose();
    }
  },
});

Deno.test({
  name: "plugin add: wires an existing config once; the second add changes nothing",
  ...POSIX,
  fn: async () => {
    const p = await project();
    try {
      const path = join(p.dir, "denext.config.ts");
      await Deno.writeTextFile(path, `export default { plugins: [] };\n`);
      const first = await plugin(p.dir, ["add", "@denext/htmx"]);
      assertStringIncludes(first.out, "Wired htmx into");
      assertStringIncludes(first.out, "added import, added htmx() to plugins");
      const wired = await Deno.readTextFile(path);
      const second = await plugin(p.dir, ["add", "@denext/htmx"]);
      assertStringIncludes(second.out, "already wired up");
      assertEquals(await Deno.readTextFile(path), wired);
      // A ready value (--no-call) under a custom export name.
      const third = await plugin(p.dir, ["add", "my-plugin"], {
        export: "configureMine",
        "no-call": true,
      });
      assertStringIncludes(third.out, "Wired configureMine into");
      assertStringIncludes(await Deno.readTextFile(path), "configureMine");
    } finally {
      await p.dispose();
    }
  },
});

Deno.test({
  name: "plugin add: a failed deno add exits with its code and leaves no config",
  ...POSIX,
  fn: async () => {
    const p = await project();
    try {
      Deno.env.set("FAKE_DENO_CODE", "3");
      const r = await plugin(p.dir, ["add", "@denext/htmx"]);
      assertEquals(r.exits, [3]);
      assertStringIncludes(r.err, "`deno add jsr:@denext/htmx` failed (exit 3)");
      let exists = true;
      await Deno.stat(join(p.dir, "denext.config.ts")).catch(() => (exists = false));
      assert(!exists, "no config is written after a failed install");
    } finally {
      await p.dispose();
    }
  },
});

Deno.test({
  name: "plugin add: a config it can't edit safely prints the manual wiring and exits 1",
  ...POSIX,
  fn: async () => {
    const p = await project();
    try {
      // No `plugins` array and no object literal default export to add one to.
      await Deno.writeTextFile(
        join(p.dir, "denext.config.ts"),
        `import base from "./base.ts";\nexport default base;\n`,
      );
      const r = await plugin(p.dir, ["add", "@denext/htmx"]);
      assertEquals(r.exits, [1]);
      assertStringIncludes(r.err, "Couldn't safely edit the config");
      assertStringIncludes(r.err, `import { htmx } from "@denext/htmx";`);
    } finally {
      await p.dispose();
    }
  },
});

Deno.test({
  name: "plugin remove: unwires the config, then deno remove; a non-zero exit is only a note",
  ...POSIX,
  fn: async () => {
    const p = await project();
    try {
      const path = join(p.dir, "denext.config.ts");
      await Deno.writeTextFile(path, `export default { plugins: [] };\n`);
      await plugin(p.dir, ["add", "@denext/htmx"]);
      const r = await plugin(p.dir, ["remove", "@denext/htmx"]);
      assertEquals(r.exits, []);
      assertStringIncludes(r.out, "Unwired htmx from");
      assertStringIncludes(r.out, "removed htmx() from plugins, removed import");
      assert(!(await Deno.readTextFile(path)).includes("htmx"));
      assertStringIncludes(await Deno.readTextFile(p.log), "|remove @denext/htmx");
      // Not wired (any more), and deno remove fails: both are notes, not errors.
      Deno.env.set("FAKE_DENO_CODE", "1");
      const again = await plugin(p.dir, ["remove", "@denext/htmx"]);
      assertEquals(again.exits, []);
      assertStringIncludes(again.out, "isn't wired up");
      assertStringIncludes(again.out, "`deno remove @denext/htmx` exited 1");
      // No config at all: only the dependency is dropped.
      await Deno.remove(path);
      Deno.env.delete("FAKE_DENO_CODE");
      const bare = await plugin(p.dir, ["remove", "@denext/htmx"]);
      assertStringIncludes(bare.out, "Removing @denext/htmx");
      assert(!bare.out.includes("wired"));
    } finally {
      await p.dispose();
    }
  },
});
