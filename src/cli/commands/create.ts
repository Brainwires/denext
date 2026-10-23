// `create` (scaffold into a new/empty dir) and `init` (scaffold into an existing
// dir). Both bypass the app-dir / CSS re-exec checks — no project exists yet — and
// share one implementation parameterized by mode.

import { join, resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import {
  denoJson,
  SCAFFOLD_TEMPLATES,
  type ScaffoldOptions,
  scaffoldProject,
  type ScaffoldTemplate,
} from "../../build/scaffold.ts";
import { pinEligible } from "../../build/eligible-pins.ts";
import {
  MONOREPO_APP_DIR,
  MONOREPO_CONFIGS,
  monorepoConfigText,
  scaffoldMonorepo,
} from "../../build/scaffold-monorepo.ts";
import { applyUpgrade } from "../../build/upgrade.ts";
import { multiSelect } from "../../build/multi-select.ts";
import { applyJailExceptions } from "../../build/jail-scripts.ts";

/** One scaffold-time feature toggle: the option it sets, its flag, and its label. */
export interface ScaffoldFeature {
  /** The {@link ScaffoldOptions} key it turns on (`compatibility` → `compatibilityMode`). */
  readonly key: string;
  /** The `denext create` flag that pre-selects it. */
  readonly flag: string;
  /** The human-readable label shown in the picker (and on `denext ui`'s Setup page). */
  readonly label: string;
  /**
   * Checked when the interactive picker (or the Setup page) opens. A non-interactive run
   * (`--yes`, no TTY) still selects only what its flags name.
   */
  readonly defaultOn?: boolean;
}

/**
 * Feature toggles offered at scaffold time (flag pre-selects; TTY multi-select otherwise).
 * Exported so `denext ui`'s Setup page offers exactly the same list as the CLI.
 */
export const FEATURES: readonly ScaffoldFeature[] = [
  { key: "tailwind", flag: "tailwind", label: "Tailwind CSS" },
  { key: "srcDir", flag: "src-dir", label: "src/ directory layout" },
  {
    key: "compiler",
    flag: "compiler",
    label: "Auto-memo compiler",
  },
  {
    key: "desktop",
    flag: "desktop",
    label: "Native desktop app (deno desktop)",
  },
  { key: "capacitor", flag: "capacitor", label: "iOS / Android (Capacitor)" },
  {
    key: "fastlane",
    flag: "fastlane",
    label: "fastlane lanes for the iOS / Android app (denext fastlane; adds Capacitor)",
  },
  {
    key: "compatibility",
    flag: "compatibility",
    label: "React + Next import aliases",
  },
  {
    key: "fallow",
    flag: "fallow",
    label: "fallow code-health gate (dead code, duplication, complexity)",
  },
  {
    key: "mcp",
    flag: "mcp",
    label: "denext MCP server for coding agents (Claude Code, VS Code, Cursor)",
    defaultOn: true,
  },
  {
    key: "monorepo",
    flag: "monorepo",
    label: "Monorepo: a Deno workspace with apps/web + shared packages/ui and packages/shared",
  },
];

const SCAFFOLD_FLAGS = [
  ...FEATURES.map((f) => ({
    name: f.flag,
    type: "boolean" as const,
    help: f.label,
  })),
  {
    name: "template",
    type: "string" as const,
    valueName: "<name>",
    help: `Starter template (${SCAFFOLD_TEMPLATES.join(" | ")}; default: default)`,
  },
  {
    name: "no-vscode",
    type: "boolean" as const,
    help: "Don't write .vscode/settings.json + extensions.json (Deno LSP)",
  },
  {
    name: "yes",
    alias: "y",
    type: "boolean" as const,
    help: "Skip prompts, use flags/defaults",
  },
];

async function runCreate(
  ctx: CommandContext,
  mode: "create" | "init",
): Promise<void> {
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
  const options: ScaffoldOptions = {
    dir,
    template: template as ScaffoldTemplate,
    tailwind: on("tailwind"),
    srcDir: on("srcDir"),
    compiler: on("compiler"),
    desktop: on("desktop"),
    capacitor: on("capacitor"),
    fastlane: on("fastlane"),
    compatibilityMode: on("compatibility"),
    fallow: on("fallow"),
    mcp: on("mcp"),
    vscode: ctx.flags["no-vscode"] !== true,
    allowExisting: mode === "init",
  };
  const monorepo = monorepoMode(on("monorepo"), mode);
  const { written, notes: held } = await scaffoldEligible(options, mode, monorepo);
  for (const p of written) console.log(`   + ${p}`);
  for (const note of held) console.log(`\n  ${note}`);
  // `init` scaffolds next to an existing package.json: its dependencies may need exceptions.
  const [jail, ...jailMore] = (await applyJailExceptions(dir)).lines;
  if (jail) console.log(`\n  ${[jail, ...jailMore.map((l) => `    ${l}`)].join("\n")}`);
  const cd = mode === "init" ? "" : `    cd ${target}\n`;
  const notes = [...featureNotes(on), ...(template === "lustre" ? [LUSTRE_NOTE] : [])];
  console.log(
    `\n  Done. Next steps:\n${cd}    denext task dev\n` +
      `\n  (\`deno task dev\` does the same with Deno installed. The first run downloads the framework\n` +
      `  from JSR — a few seconds; later runs are cached.)\n` +
      (notes.length ? "\n" + notes.join("\n") + "\n" : ""),
  );
}

/** Whether to scaffold a monorepo: `--monorepo` on `create`; `init` refuses it (exit 1). */
function monorepoMode(selected: boolean, mode: "create" | "init"): boolean {
  if (selected && mode === "init") {
    console.error(
      "denext init: --monorepo scaffolds a new directory; use `denext create <dir> --monorepo`.",
    );
    Deno.exit(1);
  }
  return selected;
}

/**
 * Scaffold with the newest denext Deno's dependency-age hold lets in — this CLI's own release
 * can be too new for it. Checked before anything is written, so a project that can't resolve
 * yet is never made (that exits 1 with when it can).
 */
async function scaffoldEligible(
  options: ScaffoldOptions,
  mode: "create" | "init",
  monorepo: boolean,
): Promise<{ written: string[]; notes: readonly string[] }> {
  // A monorepo's configs (root, app, packages) are planned together: their pins move as one.
  const text = monorepo ? monorepoConfigText(options) : denoJson(options);
  const eligible = await pinEligible(text, options.dir);
  if (!eligible.ok) {
    console.error(`denext ${mode}: ${eligible.error}`);
    Deno.exit(1);
  }
  console.log(`\n  Scaffolding a denext ${monorepo ? "monorepo" : "app"} in ${options.dir}\n`);
  const written = monorepo ? await scaffoldMonorepo(options) : await scaffoldProject(options);
  const configs = monorepo ? MONOREPO_CONFIGS : ["deno.json"];
  for (const config of eligible.steps.length ? configs : []) {
    if (!written.includes(config)) continue;
    const path = join(options.dir, config);
    await Deno.writeTextFile(path, applyUpgrade(await Deno.readTextFile(path), eligible.steps));
  }
  return { written, notes: eligible.notes };
}

/** The target directory: the positional, or `.` for `init`; `create` requires one. */
function createTarget(ctx: CommandContext, mode: "create" | "init"): string {
  const target = ctx.positionals[0] ?? (mode === "init" ? "." : undefined);
  if (target) return target;
  console.error(
    "denext create: missing target directory.\n" +
      "  denext create my-app [--tailwind] [--src-dir] [--compiler] [--desktop] [--capacitor] [--fastlane] [--compatibility] [--fallow] [--mcp] [--monorepo] [--no-vscode]\n" +
      "  denext init            (scaffold into the current directory)",
  );
  Deno.exit(1);
}

/**
 * The features selected before any prompt: those whose flag is set, plus — only when the
 * picker will be shown — the {@linkcode ScaffoldFeature.defaultOn} ones, so `--yes` (or a
 * non-TTY run) writes exactly what its flags name.
 *
 * @param flags The parsed `denext create` flags.
 * @param interactive Whether the multi-select picker will be shown.
 * @returns The pre-selected feature keys.
 */
export function preselectedFeatures(
  flags: Readonly<Record<string, unknown>>,
  interactive: boolean,
): Set<string> {
  return new Set(
    FEATURES.filter((f) => flags[f.flag] === true || (interactive && f.defaultOn === true))
      .map((f) => f.key),
  );
}

/**
 * A matching flag pre-selects the feature; on a TTY (and without --yes) the remaining
 * choice is made in a single multi-select.
 */
function selectFeatures(ctx: CommandContext): Set<string> {
  const interactive = ctx.flags.yes !== true && Deno.stdin.isTerminal();
  const selected = preselectedFeatures(ctx.flags, interactive);
  if (!interactive) return selected;
  return multiSelect(
    "  Select features  (↑/↓ move · space toggle · enter confirm)",
    [...FEATURES],
    selected,
  );
}

/** Post-scaffold notes for the selected features. */
function featureNotes(on: (key: string) => boolean): string[] {
  return FEATURE_NOTES.filter(([keys]) => keys.some(on)).map(([, note]) => note);
}

/** Each post-scaffold note, with the features (any one of them) that print it. */
const FEATURE_NOTES: readonly (readonly [readonly string[], string])[] = [
  [["tailwind"], "  Tailwind is compiled automatically by denext dev/build."],
  [["desktop"], "  Desktop: `denext task desktop`."],
  [
    ["capacitor", "fastlane"],
    "  Mobile: `denext install`, then `denext task mobile:sync` (needs Xcode/Android Studio).\n" +
    "  Over-the-air UI updates: after `cap add ios|android`, `denext task mobile:add-ota`.",
  ],
  [
    ["fastlane"],
    "  fastlane: `denext fastlane ios|android build|beta|release` (fastlane/Fastfile). The first\n" +
    "  run installs denext's pinned fastlane (macOS / Linux, needs a C compiler; not Windows).",
  ],
  [
    ["compatibility"],
    '  React/Next aliases added: `import ... from "react"`/`"next/*"` resolves to denext.',
  ],
  [
    ["fallow"],
    "  fallow: `denext task fallow:audit` runs the gate; `git init`, then `denext task hooks:install`\n" +
    "  runs it before every commit (AGENTS.md tells coding agents the same).",
  ],
  [
    ["mcp"],
    "  MCP: .mcp.json, .vscode/mcp.json and .cursor/mcp.json run `deno task mcp` (the pinned\n" +
    "  denext); approve the `denext` server when your agent asks.",
  ],
  [
    ["monorepo"],
    `  Monorepo: the app is ${MONOREPO_APP_DIR} (the root's dev/build/start tasks delegate to it);\n` +
    "  packages/ui and packages/shared are imported by name. `denext task check` runs fmt, lint\n" +
    "  and every member's tests.",
  ],
];

/** The Lustre template's note. */
const LUSTRE_NOTE =
  "  The Lustre template compiles gleam/ with denext's pinned Gleam: the first dev/build\n" +
  "  downloads the compiler, then Lustre from Hex.";

export const createCommand: CommandSpec = {
  name: "create",
  summary: "Scaffold a new app",
  usage: "Scaffolds a denext app. Deno's `deno create` (a project from a template):\n" +
    "`denext deno create`.",
  flags: SCAFFOLD_FLAGS,
  positionals: [{ name: "dir", help: "New app directory", required: true }],
  run: (ctx) => runCreate(ctx, "create"),
};

export const initCommand: CommandSpec = {
  name: "init",
  summary: "Scaffold into the current directory",
  usage: "Scaffolds a denext app into an existing directory. Deno's `deno init`:\n" +
    "`denext deno init`.",
  flags: SCAFFOLD_FLAGS,
  positionals: [{ name: "dir", help: "Existing directory (default: .)" }],
  run: (ctx) => runCreate(ctx, "init"),
};
