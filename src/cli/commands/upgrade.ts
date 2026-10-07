// `denext upgrade` — bump the project's denext pin, the CLI tasks pinned to it and every
// first-party `@denext/*` package together, to versions whose compatibility ranges agree.
// The planning lives in `src/build/upgrade.ts`; this file reads and writes `deno.json`.

import { parse as parseJsonc } from "@std/jsonc";
import { join, relative } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import {
  applyUpgrade,
  jsrLookups,
  planUpgrade,
  type UpgradeLookups,
  type UpgradePlan,
  type UpgradeStep,
} from "../../build/upgrade.ts";
import { projectDir } from "../shared.ts";

/** The project config `upgrade` edits: `deno.json`, else `deno.jsonc`. */
async function configPath(dir: string): Promise<string | null> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const path = join(dir, name);
    try {
      if ((await Deno.stat(path)).isFile) return path;
    } catch { /* try the next */ }
  }
  return null;
}

/**
 * The workspace members' configs the root config names (`"workspace": ["./a", "./packages/*"]`):
 * their pins move with the root's. A member entry that resolves to no config is reported.
 */
async function memberConfigs(
  dir: string,
  text: string,
): Promise<{ paths: string[]; unresolved: string[] }> {
  let members: unknown;
  try {
    members = (parseJsonc(text) as { workspace?: unknown })?.workspace;
  } catch {
    return { paths: [], unresolved: [] };
  }
  const list = Array.isArray(members)
    ? members
    : (members as { members?: unknown } | undefined)?.members;
  if (!Array.isArray(list)) return { paths: [], unresolved: [] };
  const paths: string[] = [];
  const unresolved: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const dirs = await memberDirs(dir, entry);
    const found = (await Promise.all(dirs.map(configPath))).filter((p): p is string => !!p);
    if (found.length) paths.push(...found);
    else unresolved.push(entry);
  }
  return { paths: [...new Set(paths)], unresolved };
}

/** The directories one `workspace` entry names: a path, or a `dir/*` glob over subdirectories. */
async function memberDirs(root: string, entry: string): Promise<string[]> {
  if (!entry.includes("*")) return [join(root, entry)];
  const m = /^(.*?)\/?\*\/?$/.exec(entry);
  if (!m || m[1].includes("*")) return [];
  const parent = join(root, m[1]);
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(parent)) if (e.isDirectory) out.push(join(parent, e.name));
  } catch { /* no such directory: unresolved */ }
  return out.sort();
}

/** The steps as aligned `name  from → to` lines (unchanged ones say so). */
function describeSteps(steps: readonly UpgradeStep[]): string {
  const width = Math.max(...steps.map((s) => s.name.length));
  return steps.map((s) =>
    `  ${s.name.padEnd(width)}  ${
      s.from === s.to ? `${s.from} (up to date)` : `${s.from} → ${s.to}`
    }`
  ).join("\n");
}

/**
 * Run `denext upgrade` against `dir`: plan, then print / check / write.
 *
 * @param ctx The invocation (`--dry-run`, `--check`, `--to`, global `--json`).
 * @param lookups The registry lookups (JSR; injected by tests).
 * @returns The process exit code.
 */
export async function runUpgrade(
  ctx: CommandContext,
  lookups: UpgradeLookups = jsrLookups(),
): Promise<number> {
  const dir = projectDir(ctx);
  const path = await configPath(dir);
  if (!path) {
    console.error(`denext upgrade: no deno.json in ${dir}`);
    return 1;
  }
  // A workspace's members pin denext too: plan over every config at once so they all agree.
  const { files, unresolved } = await workspaceConfigs(dir, path);
  const to = typeof ctx.flags.to === "string" ? ctx.flags.to.replace(/^v/, "") : undefined;
  const plan = await planUpgrade(files.map((f) => f.text).join("\n"), {
    to,
    allowDowngrade: ctx.flags["allow-downgrade"] === true,
    allowMajor: ctx.flags["allow-major"] === true,
  }, lookups);
  const check = ctx.flags.check === true;
  const written = plan.ok && plan.changed && !check && ctx.flags["dry-run"] !== true;
  const changedFiles = plan.ok ? await applyToFiles(files, plan.steps, written) : [];
  if (ctx.global.json) {
    console.log(JSON.stringify({
      config: path,
      ...plan,
      written,
      files: changedFiles,
      ...(unresolved.length ? { unresolvedMembers: unresolved } : {}),
    }));
  } else {
    report(plan, path, check, written);
    reportWorkspace(dir, plan.ok ? changedFiles : [], unresolved);
  }
  if (!plan.ok) return 1;
  return check && plan.changed ? 1 : 0;
}

/** The root config and each workspace member's, with their text; members with no config. */
async function workspaceConfigs(
  dir: string,
  path: string,
): Promise<{ files: { path: string; text: string }[]; unresolved: string[] }> {
  const text = await Deno.readTextFile(path);
  const members = await memberConfigs(dir, text);
  const files = [{ path, text }];
  for (const member of members.paths) {
    if (member !== path) files.push({ path: member, text: await Deno.readTextFile(member) });
  }
  return { files, unresolved: members.unresolved };
}

/** The files the steps change (written when `write`), in order. */
async function applyToFiles(
  files: readonly { path: string; text: string }[],
  steps: readonly UpgradeStep[],
  write: boolean,
): Promise<string[]> {
  const changed: string[] = [];
  for (const f of files) {
    const next = applyUpgrade(f.text, steps);
    if (next === f.text) continue;
    changed.push(f.path);
    if (write) await Deno.writeTextFile(f.path, next);
  }
  return changed;
}

/** The workspace part of the human output: the member configs touched, and those not read. */
function reportWorkspace(dir: string, changed: readonly string[], unresolved: readonly string[]) {
  if (changed.length > 1) {
    console.log(`Workspace configs: ${changed.map((f) => relative(dir, f)).join(", ")}`);
  }
  for (const m of unresolved) {
    console.error(`denext upgrade: workspace member ${m} has no deno.json; its pins were not read`);
  }
}

/** The human output: the steps, then what happened to the file (or why nothing could). */
function report(plan: UpgradePlan, path: string, check: boolean, written: boolean): void {
  if (!plan.ok) {
    console.error(`denext upgrade: ${plan.reason}`);
    return;
  }
  console.log(describeSteps(plan.steps));
  if (!plan.changed) console.log("\nEverything is up to date.");
  else if (written) {
    console.log(
      `\nUpdated ${path}. The next \`deno task\` (or \`deno install\`) refreshes deno.lock.`,
    );
  } else console.log(`\n${check ? "Out of date" : "Dry run"} — ${path} was not changed.`);
}

/** `denext upgrade [dir]`. */
export const upgradeCommand: CommandSpec = {
  name: "upgrade",
  summary: "Bump denext, its CLI tasks and the first-party @denext/* packages together",
  usage: "Reads every jsr:@denext/* pin in deno.json (the import map and the `deno task`s that\n" +
    "run the CLI) and moves them to the newest versions that work together: the newest denext\n" +
    "every pinned first-party package has a compatible version for (each package's own\n" +
    "@denext/denext range, from src/plugin/catalog.json or its published deno.json on JSR).\n" +
    "Nothing moves backwards; each pin keeps its ^ / ~ / exact operator. A package that imports\n" +
    "no denext stays within its own caret range unless --allow-major. Workspace members'\n" +
    "deno.json files move with the root. A JSR request that fails is an error, never read as\n" +
    "incompatible. --to picks the denext version (an older one needs --allow-downgrade);\n" +
    "--dry-run prints the plan; --check exits 1 when anything is out of date.",
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [
    { name: "dry-run", type: "boolean", help: "Print the plan without writing deno.json" },
    {
      name: "check",
      type: "boolean",
      help: "Write nothing; exit 1 when an upgrade is available (for CI)",
    },
    {
      name: "to",
      type: "string",
      valueName: "<version>",
      help: "The denext version to move to (default: the newest every package supports)",
    },
    {
      name: "allow-downgrade",
      type: "boolean",
      help: "Let --to name a denext version older than the current pin",
    },
    {
      name: "allow-major",
      type: "boolean",
      help: "Let a package that imports no denext move to a new major (breaking) version",
    },
  ],
  run: async (ctx) => {
    const code = await runUpgrade(ctx);
    if (code !== 0) Deno.exit(code);
  },
};
