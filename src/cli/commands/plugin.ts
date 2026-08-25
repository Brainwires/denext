// `denext plugin add <pkg>` — install a denext plugin in one step: run `deno add`
// to add the dependency, then wire it into `denext.config.ts` (creating the config
// if absent). The two-step-by-hand alternative is `denext add jsr:<pkg>` followed
// by editing the config's `plugins` array; this verb does both.

import { resolve } from "@std/path";
import { denoExecutable } from "../../build/bundle.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import {
  createConfigSource,
  injectPlugin,
  type PluginNames,
  resolvePluginNames,
} from "../../build/plugin-install.ts";

/** Run `deno add <spec>` in `cwd`, returning its exit code (does not exit). */
async function denoAdd(spec: string, cwd: string): Promise<number> {
  const child = new Deno.Command(denoExecutable(), {
    args: ["add", spec],
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
  const code = await denoAdd(names.addSpec, dir);
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

export const pluginCommand: CommandSpec = {
  name: "plugin",
  summary: "Manage denext plugins (add)",
  usage: "  denext plugin add <pkg> [dir]\n\n" +
    "  Adds the dependency (deno add) and wires the plugin into denext.config.ts.\n\n" +
    "  denext plugin add @denext/htmx\n" +
    "  denext plugin add @denext/pages-router\n" +
    "  denext plugin add my-plugin --export configureMyPlugin",
  positionals: [
    { name: "action", help: "add", required: true },
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
    if (action !== "add") {
      console.error(
        `denext plugin: unknown action "${action ?? ""}". Try: denext plugin add <pkg>`,
      );
      Deno.exit(1);
    }
    const pkg = ctx.positionals[1];
    if (!pkg) {
      console.error("denext plugin add: missing package.\n  Usage: denext plugin add <pkg> [dir]");
      Deno.exit(1);
    }
    const dir = resolve(ctx.global.cwd ?? ctx.positionals[2] ?? ".");
    await addPlugin(pkg, dir, ctx);
  },
};
