// `create` (scaffold into a new/empty dir) and `init` (scaffold into an existing
// dir). Both bypass the app-dir / CSS re-exec checks — no project exists yet — and
// share one implementation parameterized by mode.

import { resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import {
  SCAFFOLD_TEMPLATES,
  scaffoldProject,
  type ScaffoldTemplate,
} from "../../build/scaffold.ts";
import { multiSelect } from "../../build/multi-select.ts";

/** Feature toggles offered at scaffold time (flag pre-selects; TTY multi-select otherwise). */
const FEATURES: Array<{ key: string; flag: string; label: string }> = [
  { key: "tailwind", flag: "tailwind", label: "Tailwind CSS" },
  { key: "srcDir", flag: "src-dir", label: "src/ directory layout" },
  { key: "compiler", flag: "compiler", label: "Auto-memo compiler (experimental)" },
  { key: "desktop", flag: "desktop", label: "Native desktop app (deno desktop)" },
  { key: "capacitor", flag: "capacitor", label: "iOS / Android (Capacitor)" },
  { key: "compatibility", flag: "compatibility", label: "React + Next import aliases" },
];

const SCAFFOLD_FLAGS = [
  ...FEATURES.map((f) => ({ name: f.flag, type: "boolean" as const, help: f.label })),
  { name: "template", type: "string" as const, valueName: "<name>", help: "Starter template" },
  { name: "yes", alias: "y", type: "boolean" as const, help: "Skip prompts, use flags/defaults" },
];

async function runCreate(ctx: CommandContext, mode: "create" | "init"): Promise<void> {
  const target = createTarget(ctx, mode);
  const dir = resolve(target);
  const template = (ctx.flags.template as string | undefined) ?? "default";
  if (!SCAFFOLD_TEMPLATES.includes(template as ScaffoldTemplate)) {
    console.error(
      `denext create: unknown template "${template}" (expected ${SCAFFOLD_TEMPLATES.join(" | ")}).`,
    );
    Deno.exit(1);
  }
  const selected = selectFeatures(ctx);
  const on = (k: string): boolean => selected.has(k);
  console.log(`\n  Scaffolding a denext app in ${dir}\n`);
  const written = await scaffoldProject({
    dir,
    template: template as ScaffoldTemplate,
    tailwind: on("tailwind"),
    srcDir: on("srcDir"),
    compiler: on("compiler"),
    desktop: on("desktop"),
    capacitor: on("capacitor"),
    compatibilityMode: on("compatibility"),
    allowExisting: mode === "init",
  });
  for (const p of written) console.log(`   + ${p}`);
  const cd = mode === "init" ? "" : `    cd ${target}\n`;
  const notes = featureNotes(on);
  console.log(
    `\n  Done. Next steps:\n${cd}    deno task dev\n` +
      (notes.length ? "\n" + notes.join("\n") + "\n" : ""),
  );
}

/** The target directory: the positional, or `.` for `init`; `create` requires one. */
function createTarget(ctx: CommandContext, mode: "create" | "init"): string {
  const target = ctx.positionals[0] ?? (mode === "init" ? "." : undefined);
  if (target) return target;
  console.error(
    "denext create: missing target directory.\n" +
      "  denext create my-app [--tailwind] [--src-dir] [--compiler] [--desktop] [--capacitor] [--compatibility]\n" +
      "  denext init            (scaffold into the current directory)",
  );
  Deno.exit(1);
}

/**
 * A matching flag pre-selects the feature; on a TTY (and without --yes) the remaining
 * choice is made in a single multi-select.
 */
function selectFeatures(ctx: CommandContext): Set<string> {
  const selected = new Set(FEATURES.filter((f) => ctx.flags[f.flag] === true).map((f) => f.key));
  if (ctx.flags.yes === true || !Deno.stdin.isTerminal()) return selected;
  return multiSelect(
    "  Select features  (↑/↓ move · space toggle · enter confirm)",
    FEATURES,
    selected,
  );
}

/** Post-scaffold notes for the selected features. */
function featureNotes(on: (key: string) => boolean): string[] {
  return [
    on("tailwind") ? "  Tailwind is compiled automatically by denext dev/build." : "",
    on("desktop") ? "  Desktop: `deno task desktop` (needs Deno 2.9+ `deno desktop`)." : "",
    on("capacitor")
      ? "  Mobile: `deno install`, then `deno task mobile:sync` (needs Xcode/Android Studio)."
      : "",
    on("compatibility")
      ? '  React/Next aliases added: `import ... from "react"`/`"next/*"` resolves to denext.'
      : "",
  ].filter(Boolean);
}

export const createCommand: CommandSpec = {
  name: "create",
  summary: "Scaffold a new app",
  flags: SCAFFOLD_FLAGS,
  positionals: [{ name: "dir", help: "New app directory", required: true }],
  run: (ctx) => runCreate(ctx, "create"),
};

export const initCommand: CommandSpec = {
  name: "init",
  summary: "Scaffold into the current directory",
  flags: SCAFFOLD_FLAGS,
  positionals: [{ name: "dir", help: "Existing directory (default: .)" }],
  run: (ctx) => runCreate(ctx, "init"),
};
