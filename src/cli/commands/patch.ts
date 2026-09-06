// `denext patch` — record, list, apply and drop patches to npm packages and to denext itself
// (`patches/<name>+<version>.patch`, patch-package's format). See `src/build/patches.ts`.

import { relative, resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import {
  applyPatches,
  createDenextPatch,
  createNpmPatch,
  deletePatch,
  DENEXT_PATCH_NAME,
  editDenextFile,
  listPatches,
  npmPackageDir,
  readPatch,
} from "../../build/patches.ts";

type Action = "create" | "list" | "delete" | "apply" | "edit";

function patchAction(raw: string | undefined): Action {
  if (raw === "create" || raw === "list" || raw === "delete" || raw === "apply" || raw === "edit") {
    return raw;
  }
  console.error(
    `denext patch: unknown action "${raw ?? ""}". Try: denext patch create|list|delete|apply|edit`,
  );
  Deno.exit(1);
}

function fail(message: string): never {
  console.error(`  ✖ ${message}`);
  Deno.exit(1);
}

/** `denext patch create <name>`: record the package's (or denext's) current edits. */
async function create(name: string, dir: string): Promise<void> {
  const created = name === DENEXT_PATCH_NAME
    ? await createDenextPatch(dir)
    : await createNpmPatch(dir, name);
  console.log(`  ✔ wrote ${relative(dir, created.file)} (${created.files.length} file(s)):`);
  for (const f of created.files) console.log(`      ${f}`);
  if (name === DENEXT_PATCH_NAME) {
    console.log(
      "    materialized into patches/denext/ and mapped in deno.json — takes effect on the next start.",
    );
  } else {
    console.log("    re-applied to node_modules at every dev/build/start (idempotent).");
  }
}

/** `denext patch list`: the patches, indexed for `delete`. */
async function list(dir: string, json: boolean): Promise<void> {
  const patches = await listPatches(dir);
  if (json) {
    const rows = [];
    for (const p of patches) {
      rows.push({
        ...p,
        file: relative(dir, p.file),
        files: (await readPatch(p)).map((d) => d.newPath),
      });
    }
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (patches.length === 0) {
    console.log(
      "  no patches (patches/*.patch) — `denext patch create <package|denext>` records one.",
    );
    return;
  }
  for (const [i, p] of patches.entries()) {
    const files = await readPatch(p);
    console.log(
      `  ${i + 1}. ${p.name}@${p.version}  (${files.length} file(s), ${relative(dir, p.file)})`,
    );
    for (const d of files) console.log(`       ${d.newPath}`);
  }
}

/** `denext patch edit <name> <file>`: where to edit — a working copy for denext, the installed file for npm. */
async function edit(name: string, file: string | undefined, dir: string): Promise<void> {
  if (!file) fail(`missing file.\n    Usage: denext patch edit ${name} <path-inside-package>`);
  if (name === DENEXT_PATCH_NAME) {
    const path = await editDenextFile(dir, file);
    console.log(`  ✔ edit ${relative(dir, path)}\n    then run \`denext patch create denext\`.`);
    return;
  }
  const path = resolve(await npmPackageDir(dir, name), file);
  console.log(`  ✔ edit ${path}\n    then run \`denext patch create ${name}\`.`);
}

export const patchCommand: CommandSpec = {
  name: "patch",
  summary: "Patch npm packages — or denext itself (patches/*.patch)",
  usage: "  denext patch create <package|denext> [dir]\n" +
    "  denext patch list [dir]\n" +
    "  denext patch delete <name|index> [dir]\n" +
    "  denext patch apply [dir]\n" +
    "  denext patch edit <package|denext> <file> [dir]\n\n" +
    "  create  diff the package's installed files (node_modules/<pkg>) — or denext's working\n" +
    "          copies (patches/.work/denext/) — against pristine → patches/<name>+<version>.patch\n" +
    "  list    the patches, indexed\n" +
    "  delete  remove a patch and undo it (npm files reverted, denext mapping dropped)\n" +
    "  apply   apply every patch now (dev/build/start/export do this at boot)\n" +
    "  edit    for denext: copy a framework file to patches/.work/denext/ to edit;\n" +
    "          for a package: print the installed file's path\n\n" +
    "  denext patch edit denext src/server/document.ts\n" +
    "  denext patch create denext\n" +
    "  denext patch create left-pad\n" +
    "  denext patch delete 2",
  positionals: [
    { name: "action", help: "create | list | delete | apply | edit", required: true },
    { name: "name", help: "Package name, `denext`, or (delete) a list index" },
    { name: "file", help: "(edit) path inside the package" },
    { name: "dir", help: "Project directory (default: .)" },
  ],
  run: async (ctx: CommandContext) => {
    const action = patchAction(ctx.positionals[0]);
    const { name, dir } = parseArgs(action, ctx);
    try {
      await dispatch(action, name, dir, ctx);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  },
};

/** The name (when the action takes one) and the project dir from the positionals. */
function parseArgs(action: Action, ctx: CommandContext): { name: string; dir: string } {
  const needsName = action === "create" || action === "delete" || action === "edit";
  const name = ctx.positionals[1] ?? "";
  if (needsName && !name) {
    const what = action === "delete" ? "name|index" : "package|denext";
    fail(`missing name.\n    Usage: denext patch ${action} <${what}>`);
  }
  // `list`/`apply` take no name: their first positional after the action is the dir.
  const dirIndex = !needsName ? 1 : action === "edit" ? 3 : 2;
  return { name, dir: resolve(ctx.global.cwd ?? ctx.positionals[dirIndex] ?? ".") };
}

async function dispatch(action: Action, name: string, dir: string, ctx: CommandContext) {
  switch (action) {
    case "list":
      return await list(dir, ctx.global.json);
    case "create":
      return await create(name, dir);
    case "edit":
      return await edit(name, ctx.positionals[2], dir);
    case "delete": {
      const removed = await deletePatch(dir, name);
      console.log(
        `  ✔ removed ${removed.name}@${removed.version} (${relative(dir, removed.file)})`,
      );
      return;
    }
    case "apply": {
      const r = await applyPatches(dir);
      const which = r.applied.length ? ` (${r.applied.join(", ")})` : "";
      console.log(
        `  ✔ ${r.applied.length} applied${which}, ${r.unchanged.length} already in place`,
      );
    }
  }
}

/**
 * Apply the project's patches before a command that loads the app (dev/build/start/export).
 * Prints what changed; a patch that no longer applies is fatal (running unpatched silently
 * would hide the problem).
 */
export async function applyPatchesAtBoot(projectDir: string): Promise<void> {
  const r = await applyPatches(projectDir);
  if (r.applied.length > 0) console.log(`denext patch: applied ${r.applied.join(", ")}`);
}
