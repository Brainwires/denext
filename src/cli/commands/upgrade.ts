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
import { memberDirs } from "../../build/workspace-imports.ts";
import {
  DENEXT_EXCLUDE,
  type DepAgeRule,
  holdMessage,
  readProjectRule,
  stripDenextExclude,
} from "../../build/dep-age.ts";
import { addTsgoLspSetting, tsgoLspByDefault } from "../../ts/lsp-settings.ts";

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

/** The steps as aligned `name  from → to` lines (unchanged ones say so). */
function describeSteps(steps: readonly UpgradeStep[]): string {
  const width = Math.max(...steps.map((s) => s.name.length));
  return steps.map((s) =>
    `  ${s.name.padEnd(width)}  ${
      s.from === s.to ? `${s.from} (up to date)` : `${s.from} → ${s.to}`
    }`
  ).join("\n");
}

/** What one `denext upgrade` run did, for its output. */
interface UpgradeOutcome {
  readonly dir: string;
  readonly path: string;
  readonly plan: UpgradePlan;
  readonly check: boolean;
  readonly written: boolean;
  /** Whether `deno.lock` was refreshed (`undefined`: there was none to, or nothing was written). */
  readonly lock: boolean | undefined;
  /** The configs whose `"jsr:@denext/*"` exclude entry was (or would be) removed. */
  readonly stripped: readonly string[];
  /** The clock the plan was made at (for the hold lines). */
  readonly now: Date;
  /** The editor settings that get (or would get) the TypeScript 7 language server, if any. */
  readonly editor: { readonly path: string; readonly written: boolean } | null;
}

/**
 * The project's `.vscode/settings.json` text with `"deno.unstable": ["tsgo-lsp"]` added — the
 * TypeScript 7 language server, denext's default for new apps — when the settings turn the Deno
 * LSP on (`"deno.enable": true`) and choose no `deno.unstable` of their own; `null` otherwise
 * (no settings, another editor setup, a `deno.unstable` the user set, a symlinked file, or
 * `DENEXT_TSGO_LSP=0`). The rest of the file keeps its bytes.
 *
 * @param dir The project directory.
 * @param env Env reader (default: the process environment).
 * @returns The settings path and its new text, or `null`.
 */
export async function editorSettingUpdate(
  dir: string,
  env?: (name: string) => string | undefined,
): Promise<{ path: string; text: string } | null> {
  if (!tsgoLspByDefault(env)) return null;
  const path = join(dir, ".vscode", "settings.json");
  const info = await Deno.lstat(path).catch(() => null);
  if (!info?.isFile) return null;
  const before = await Deno.readTextFile(path);
  let settings: unknown;
  try {
    settings = parseJsonc(before);
  } catch {
    return null;
  }
  if ((settings as Record<string, unknown> | null)?.["deno.enable"] !== true) return null;
  const text = addTsgoLspSetting(before);
  return text === null ? null : { path, text };
}

/** Print the outcome: one JSON document, or the human report. */
function printOutcome(
  json: boolean,
  o: UpgradeOutcome,
  files: { changedFiles: string[]; unresolved: string[] },
): void {
  const { changedFiles, unresolved } = files;
  if (json) {
    console.log(JSON.stringify({
      config: o.path,
      ...o.plan,
      written: o.written,
      files: changedFiles,
      ...(o.stripped.length ? { removedExclude: o.stripped } : {}),
      ...(o.lock === undefined ? {} : { lockRefreshed: o.lock }),
      ...(o.editor ? { editorSettings: o.editor } : {}),
      ...(unresolved.length ? { unresolvedMembers: unresolved } : {}),
    }));
    return;
  }
  report(o.plan, o.path, o.check, o.written, o.now);
  reportExclude(o.dir, o.stripped, o.written);
  reportWorkspace(o.dir, o.plan.ok ? changedFiles : [], unresolved);
  reportEditor(o.dir, o.editor);
  if (o.lock === true) console.log("deno.lock refreshed.");
  if (o.lock === false) {
    console.error(
      "denext upgrade: deno.lock was not refreshed; run `deno install` before a " +
        "`deno install --frozen` (CI) or commit.",
    );
  }
}

/**
 * Refresh `dir`'s `deno.lock` for the config just written: `deno install --lockfile-only` on
 * denext's Deno toolchain (it writes the lock, installs nothing). Resolves whether it succeeded.
 */
async function refreshLockfile(dir: string): Promise<boolean> {
  try {
    const { forwardedDeno } = await import("../deno-path.ts");
    const { deno, env } = await forwardedDeno();
    const out = await new Deno.Command(deno, {
      args: ["install", "--lockfile-only"],
      cwd: dir,
      env,
      stdin: "null",
      stdout: "null",
      stderr: "inherit",
    }).output();
    return out.success;
  } catch {
    return false;
  }
}

/** Whether `dir` has a `deno.lock` (only an existing lock is refreshed). */
async function hasLockfile(dir: string): Promise<boolean> {
  return await Deno.stat(join(dir, "deno.lock")).then((s) => s.isFile, () => false);
}

/**
 * Run `denext upgrade` against `dir`: plan, then print / check / write — and, once written,
 * refresh an existing `deno.lock` so a `deno install --frozen` in CI passes.
 *
 * @param ctx The invocation (`--dry-run`, `--check`, `--to`, global `--json`).
 * @param lookups The registry lookups (JSR; injected by tests).
 * @param refreshLock Refreshes `deno.lock` in a directory, resolving whether it did (injected by
 *   tests; default `deno install --lockfile-only` on the toolchain).
 * @param options The dependency-age rule and clock (injected by tests; default: the project's).
 * @returns The process exit code.
 */
export async function runUpgrade(
  ctx: CommandContext,
  lookups: UpgradeLookups = jsrLookups(),
  refreshLock: (dir: string) => Promise<boolean> = refreshLockfile,
  options: { rule?: DepAgeRule; now?: Date } = {},
): Promise<number> {
  const dir = projectDir(ctx);
  const path = await configPath(dir);
  if (!path) {
    console.error(`denext upgrade: no deno.json in ${dir}`);
    return 1;
  }
  // A workspace's members pin denext too: plan over every config at once so they all agree.
  const { files: read, unresolved } = await workspaceConfigs(dir, path);
  // The `jsr:@denext/*` exemption from Deno's dependency-age hold goes first: the plan then
  // picks only versions the hold lets in.
  const files = read.map((f) => ({ ...f, ...stripDenextExclude(f.text) }));
  const stripped = files.filter((f) => f.removed).map((f) => f.path);
  const now = options.now ?? new Date();
  const rule = options.rule ?? await readProjectRule(dir, now, files[0].text);
  const plan = await planUpgrade(
    files.map((f) => f.text).join("\n"),
    { ...upgradeFlags(ctx), rule, now },
    lookups,
  );
  const check = ctx.flags.check === true;
  const changed = plan.ok && (plan.changed || stripped.length > 0);
  const written = changed && !check && ctx.flags["dry-run"] !== true;
  const changedFiles = plan.ok ? await applyToFiles(read, files, plan.steps, written) : [];
  const lock = written && await hasLockfile(dir) ? await refreshLock(dir) : undefined;
  const editor = plan.ok
    ? await applyEditorSetting(dir, !check && ctx.flags["dry-run"] !== true)
    : null;
  const outcome = { dir, path, plan, check, written, lock, stripped, now, editor };
  printOutcome(ctx.global.json === true, outcome, { changedFiles, unresolved });
  if (!plan.ok) return 1;
  return check && changed ? 1 : 0;
}

/**
 * The editor half of an upgrade: {@linkcode editorSettingUpdate}, written when `write` (not with
 * `--dry-run` / `--check`, which only report it; it never changes `--check`'s exit code).
 */
async function applyEditorSetting(
  dir: string,
  write: boolean,
): Promise<UpgradeOutcome["editor"]> {
  const update = await editorSettingUpdate(dir);
  if (!update) return null;
  if (write) await Deno.writeTextFile(update.path, update.text);
  return { path: update.path, written: write };
}

/** `--to`, `--allow-downgrade`, `--allow-major` as planner options. */
function upgradeFlags(ctx: CommandContext) {
  return {
    to: typeof ctx.flags.to === "string" ? ctx.flags.to.replace(/^v/, "") : undefined,
    allowDowngrade: ctx.flags["allow-downgrade"] === true,
    allowMajor: ctx.flags["allow-major"] === true,
  };
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

/**
 * The files the steps change (written when `write`), in order. `files` holds each config's
 * text with the exclude entry already stripped; `read` its text on disk.
 */
async function applyToFiles(
  read: readonly { path: string; text: string }[],
  files: readonly { path: string; text: string }[],
  steps: readonly UpgradeStep[],
  write: boolean,
): Promise<string[]> {
  const changed: string[] = [];
  for (const [i, f] of files.entries()) {
    const next = applyUpgrade(f.text, steps);
    if (next === read[i].text) continue;
    changed.push(f.path);
    if (write) await Deno.writeTextFile(f.path, next);
  }
  return changed;
}

/** The editor settings that got (or would get) the TypeScript 7 language server. */
function reportEditor(dir: string, editor: UpgradeOutcome["editor"]): void {
  if (!editor) return;
  console.log(
    `\n${editor.written ? "Added" : "Would add"} "deno.unstable": ["tsgo-lsp"] to ` +
      `${relative(dir, editor.path)}: the editor's Deno language server runs TypeScript 7 ` +
      `(DENEXT_TSGO_LSP=0 leaves it out; "deno.unstable": [] keeps TypeScript 6).`,
  );
}

/** Why the `jsr:@denext/*` exclude entry was removed (or would be). */
function reportExclude(dir: string, stripped: readonly string[], written: boolean): void {
  if (!stripped.length) return;
  const where = stripped.map((p) => relative(dir, p) || p).join(", ");
  console.log(
    `\n${
      written ? "Removed" : "Would remove"
    } "${DENEXT_EXCLUDE}" from minimumDependencyAge.exclude ` +
      `in ${where}. It let a just-published @denext/* release in before Deno's dependency-age ` +
      `hold (two days by default) had passed — the window that catches a compromised release. ` +
      `denext now pins only versions old enough for the hold. If you publish denext yourself, ` +
      `add it back: https://denext.dev/docs/toolchain#supply-chain-hold`,
  );
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
function report(
  plan: UpgradePlan,
  path: string,
  check: boolean,
  written: boolean,
  now: Date,
): void {
  if (!plan.ok) {
    console.error(`denext upgrade: ${plan.reason}`);
    return;
  }
  console.log(describeSteps(plan.steps));
  for (const h of plan.held ?? []) console.log(`\n${holdMessage(h.held, h.pinned, now)}`);
  if (!plan.changed) console.log("\nEverything is up to date.");
  else if (written) {
    console.log(
      `\nUpdated ${path}.`,
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
    "--dry-run prints the plan; --check exits 1 when anything is out of date.\n" +
    "Only versions Deno's minimum dependency age already lets in are pinned (a newer one is\n" +
    "named, with when it becomes eligible; a pin still held moves down to one that resolves),\n" +
    'and the "jsr:@denext/*" entry older projects carry in minimumDependencyAge.exclude is removed.\n' +
    'A .vscode/settings.json that turns the Deno LSP on and sets no "deno.unstable" gets\n' +
    '"deno.unstable": ["tsgo-lsp"] (the TypeScript 7 language server; DENEXT_TSGO_LSP=0 skips it).\n' +
    "Upgrading the Deno binary itself is Deno's `deno upgrade`: `denext deno upgrade`.",
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
