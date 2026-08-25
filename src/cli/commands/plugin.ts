// `denext plugin add <pkg>` — install a denext plugin in one step: run `deno add`
// to add the dependency, then wire it into `denext.config.ts` (creating the config
// if absent). The two-step-by-hand alternative is `denext add jsr:<pkg>` followed
// by editing the config's `plugins` array; this verb does both.

import { resolve } from "@std/path";
import { denoExecutable } from "../../build/bundle.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import {
  createConfigSource,
  ejectPlugin,
  injectPlugin,
  type PluginNames,
  resolvePluginNames,
} from "../../build/plugin-install.ts";

/** Run `deno <sub> <spec>` in `cwd`, returning its exit code (does not exit). */
async function runDeno(sub: string, spec: string, cwd: string): Promise<number> {
  const child = new Deno.Command(denoExecutable(), {
    args: [sub, spec],
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const { code } = await child.status;
  return code;
}

/** Find an existing denext config in `dir` (ts/js/mjs), or null. */
async function findConfig(dir: string): Promise<string | null> {
  for (const name of ["denext.config.ts", "denext.config.js", "denext.config.mjs"]) {
    const path = resolve(dir, name);
    try {
      if ((await Deno.stat(path)).isFile) return path;
    } catch {
      // next
    }
  }
  return null;
}

/** Print the copy-paste wiring the user must add by hand when auto-edit can't. */
function manualInstructions(names: PluginNames): void {
  console.error(
    `  ⚠️  Couldn't safely edit the config. Add the plugin by hand:\n` +
      `      import { ${names.factory} } from "${names.importSpec}";\n` +
      `      // then add ${names.call} to your default export's \`plugins\` array.`,
  );
}

async function addPlugin(pkg: string, dir: string, ctx: CommandContext): Promise<void> {
  const names = resolvePluginNames(pkg, {
    export: ctx.flags.export as string | undefined,
    noCall: ctx.flags["no-call"] === true,
  });

  console.log(`  Installing ${names.addSpec} …`);
  const code = await runDeno("add", names.addSpec, dir);
  if (code !== 0) {
    console.error(`  ✗ \`deno add ${names.addSpec}\` failed (exit ${code}).`);
    Deno.exit(code);
  }

  const configPath = await findConfig(dir);
  if (!configPath) {
    const path = resolve(dir, "denext.config.ts");
    await Deno.writeTextFile(path, createConfigSource(names));
    console.log(`  ✔ Wrote denext.config.ts with \`plugins: [${names.call}]\`.`);
    return;
  }

  const source = await Deno.readTextFile(configPath);
  const result = injectPlugin(source, names);
  if (result.alreadyPresent) {
    console.log(`  • ${names.factory} is already wired up in ${configPath} — nothing to do.`);
    return;
  }
  if (result.bailed) {
    manualInstructions(names);
    Deno.exit(1);
  }
  await Deno.writeTextFile(configPath, result.source);
  const bits = [
    result.addedImport ? "added import" : null,
    result.addedPlugin ? `added ${names.call} to plugins` : null,
  ].filter(Boolean).join(", ");
  console.log(`  ✔ Wired ${names.factory} into ${configPath} (${bits}).`);
}

async function removePlugin(pkg: string, dir: string, ctx: CommandContext): Promise<void> {
  const names = resolvePluginNames(pkg, {
    export: ctx.flags.export as string | undefined,
    noCall: ctx.flags["no-call"] === true,
  });

  // Unwire from the config first (so a failed dep removal still leaves a consistent
  // config), then drop the dependency.
  const configPath = await findConfig(dir);
  if (configPath) {
    const result = ejectPlugin(await Deno.readTextFile(configPath), names);
    if (result.notPresent) {
      console.log(`  • ${names.factory} isn't wired up in ${configPath} — nothing to unwire.`);
    } else {
      await Deno.writeTextFile(configPath, result.source);
      const bits = [
        result.removedPlugin ? `removed ${names.call} from plugins` : null,
        result.removedImport ? "removed import" : null,
      ].filter(Boolean).join(", ");
      console.log(`  ✔ Unwired ${names.factory} from ${configPath} (${bits}).`);
    }
  }

  console.log(`  Removing ${names.importSpec} …`);
  const code = await runDeno("remove", names.importSpec, dir);
  if (code !== 0) {
    // `deno remove` can exit non-zero when the dep wasn't in the import map, or on an
    // unrelated lockfile re-resolution — a soft note, not a hard error (the config
    // unwire above may already have been the real work). See deno's output above.
    console.log(`  • \`deno remove ${names.importSpec}\` exited ${code} — see output above.`);
  }
}

export const pluginCommand: CommandSpec = {
  name: "plugin",
  summary: "Manage denext plugins (add, remove)",
  usage: "  denext plugin add <pkg> [dir]\n" +
    "  denext plugin remove <pkg> [dir]\n\n" +
    "  add     adds the dependency (deno add) and wires the plugin into denext.config.ts\n" +
    "  remove  unwires the plugin from denext.config.ts and drops the dependency\n\n" +
    "  denext plugin add @denext/htmx\n" +
    "  denext plugin remove @denext/htmx\n" +
    "  denext plugin add my-plugin --export configureMyPlugin",
  positionals: [
    { name: "action", help: "add | remove", required: true },
    { name: "pkg", help: "Plugin package (e.g. @denext/htmx)" },
    { name: "dir", help: "Project directory (default: .)" },
  ],
  flags: [
    {
      name: "export",
      type: "string",
      valueName: "<name>",
      help: "Factory export name (default: camelCased package name)",
    },
    { name: "no-call", type: "boolean", help: "Plugin is a ready value, not a factory — omit ()" },
  ],
  run: async (ctx) => {
    const action = ctx.positionals[0];
    if (action !== "add" && action !== "remove") {
      console.error(
        `denext plugin: unknown action "${action ?? ""}". Try: denext plugin add|remove <pkg>`,
      );
      Deno.exit(1);
    }
    const pkg = ctx.positionals[1];
    if (!pkg) {
      console.error(
        `denext plugin ${action}: missing package.\n  Usage: denext plugin ${action} <pkg> [dir]`,
      );
      Deno.exit(1);
    }
    const dir = resolve(ctx.global.cwd ?? ctx.positionals[2] ?? ".");
    if (action === "add") await addPlugin(pkg, dir, ctx);
    else await removePlugin(pkg, dir, ctx);
  },
};
