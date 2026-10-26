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
import { assertInsideProject } from "../../build/project-confine.ts";
import {
  DENEXT_EXCLUDE,
  type DepAgeRule,
  holdMessage,
  readProjectRule,
  stripDenextExclude,
} from "../../build/dep-age.ts";
import { addTsgoLspSetting, tsgoLspByDefault } from "../../ts/lsp-settings.ts";
import {
  desktopPackageTasks,
  LEGACY_DESKTOP_PACKAGE_TASKS,
  RETIRED_UNSTABLE,
  SCAFFOLD_EXCLUDE,
} from "../../build/scaffold.ts";
import { deleteJsonValue, setJsonValue } from "../../build/json-edit.ts";
import { applyJailExceptions, type JailReport } from "../../build/jail-scripts.ts";

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
): Promise<{ paths: string[]; unresolved: string[]; outside: string[] }> {
  const paths: string[] = [];
  const unresolved: string[] = [];
  const outside: string[] = [];
  for (const entry of workspaceEntries(text)) {
    const dirs = await memberDirs(dir, entry);
    const found = (await Promise.all(dirs.map(configPath))).filter((p): p is string => !!p);
    // A member entry (`"../other"`) or a member linked out of the project is never rewritten.
    const inside = (await Promise.all(found.map((p) => insideProject(dir, p))))
      .every(Boolean);
    if (!inside) outside.push(entry);
    else if (found.length) paths.push(...found);
    else unresolved.push(entry);
  }
  return { paths: [...new Set(paths)], unresolved, outside };
}

/** The string entries of a config's `workspace` (a list, or `{ members }`); none when unparsable. */
function workspaceEntries(text: string): string[] {
  let members: unknown;
  try {
    members = (parseJsonc(text) as { workspace?: unknown })?.workspace;
  } catch {
    return [];
  }
  const list = Array.isArray(members)
    ? members
    : (members as { members?: unknown } | undefined)?.members;
  return Array.isArray(list) ? list.filter((e): e is string => typeof e === "string") : [];
}

/** Whether a write to `path` stays inside the project at `dir` (no `..`, no symlink out). */
async function insideProject(dir: string, path: string): Promise<boolean> {
  try {
    await assertInsideProject(dir, path);
    return true;
  } catch {
    return false;
  }
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
  /** Whether the `.deno/` exclude was (or would be) added to the root config, if it was missing. */
  readonly denoExclude: { readonly written: boolean } | null;
  /** The lifecycle-script jail exceptions the dependencies need (`null`: none needed). */
  readonly jail: JailReport | null;
  /** The 5.0 config clean-ups made (or that would be), per config that needed one. */
  readonly retired: readonly RetiredConfigChange[];
}

/** What {@linkcode retiredConfigUpdate} changed in one config. */
interface RetiredConfigChange {
  /** The config's path. */
  readonly path: string;
  /** The retired `unstable` entries removed (`no-legacy-abort`). */
  readonly unstable: readonly string[];
  /** The scaffold's pre-5.0 packaging tasks rewritten to `denext desktop package`. */
  readonly tasks: readonly string[];
  /**
   * Packaging tasks that run a `scripts/package-*.ts` straight on `deno` but could not be
   * rewritten safely (edited by hand, or no `jsr:@denext/denext@…/cli` task to take the CLI
   * from): each needs `denext desktop package` by hand.
   */
  readonly manual: readonly string[];
  /** Whether the file was written. */
  readonly written: boolean;
}

/** The CLI specifier a project's tasks run (`jsr:@denext/denext@^4.9.0/cli`). */
const CLI_SPEC = /jsr:@denext\/denext@[~^]?\d[^\s/"']*\/cli(?=[\s"']|$)/;

/** A task that runs a packaging script straight on `deno`, refused there off denext's runtime. */
const RAW_PACKAGE_TASK = /\bdeno\s+run\b[^&|;]*\bscripts\/package-(?:macos|linux|windows)\.ts\b/;

/**
 * A config's text with denext 5.0's clean-ups applied, or `null` when it needs none (or isn't a
 * JSON object): the retired `unstable` entries ({@linkcode RETIRED_UNSTABLE}) removed (the key
 * too once empty), and the packaging tasks `denext create --desktop` wrote before 5.0 (exactly
 * {@linkcode LEGACY_DESKTOP_PACKAGE_TASKS}) rewritten to `denext desktop package` over the CLI the
 * project's other tasks run. A packaging task edited by hand is left for the user (`manual`).
 * Comments and key order are kept.
 *
 * @param text The `deno.json` / `deno.jsonc` text.
 * @returns The new text and what changed, or `null`.
 */
export async function retiredConfigUpdate(
  text: string,
): Promise<{ text: string; unstable: string[]; tasks: string[]; manual: string[] } | null> {
  let doc: unknown;
  try {
    doc = parseJsonc(text);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  let source = text;
  const config = doc as { unstable?: unknown; tasks?: unknown };
  const unstable: string[] = [];
  if (Array.isArray(config.unstable)) {
    const kept = config.unstable.filter((f) => !RETIRED_UNSTABLE.includes(f as string));
    unstable.push(...config.unstable.filter((f) => RETIRED_UNSTABLE.includes(f as string)));
    if (unstable.length) {
      const edit = kept.length
        ? await setJsonValue(source, ["unstable"], kept)
        : await deleteJsonValue(source, ["unstable"]);
      if (edit.ok) source = edit.source;
      else unstable.length = 0;
    }
  }
  const { tasks, manual, source: next } = await rewritePackageTasks(source, config.tasks);
  source = next;
  if (!unstable.length && !tasks.length && !manual.length) return null;
  return { text: source, unstable, tasks, manual };
}

/** A config's string tasks (`{ command }` objects included), as `[name, command]`. */
function taskCommands(tasks: Record<string, unknown>): [string, string][] {
  return Object.entries(tasks)
    .map(([k, v]): [string, unknown] => [k, typeof v === "string" ? v : objectCommand(v)])
    .filter((e): e is [string, string] => typeof e[1] === "string");
}

/** A `{ command }` task's command. */
function objectCommand(v: unknown): unknown {
  return v !== null && typeof v === "object" ? (v as { command?: unknown }).command : undefined;
}

/** Whether `tasks[name]` is exactly the string a pre-5.0 `create --desktop` wrote. */
function isLegacyPackageTask(tasks: Record<string, unknown>, name: string): boolean {
  return Object.hasOwn(LEGACY_DESKTOP_PACKAGE_TASKS, name) &&
    tasks[name] === LEGACY_DESKTOP_PACKAGE_TASKS[name];
}

/** {@linkcode retiredConfigUpdate}'s task half. */
async function rewritePackageTasks(
  source: string,
  value: unknown,
): Promise<{ tasks: string[]; manual: string[]; source: string }> {
  const tasks: string[] = [];
  const manual: string[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { tasks, manual, source };
  }
  const all = value as Record<string, unknown>;
  const entries = taskCommands(all);
  const spec = entries.map(([, v]) => CLI_SPEC.exec(v)?.[0]).find((s) => s !== undefined);
  const wanted = spec === undefined ? {} : desktopPackageTasks(spec);
  for (const [name] of entries.filter(([, c]) => RAW_PACKAGE_TASK.test(c))) {
    const next = isLegacyPackageTask(all, name) ? await setTask(source, name, wanted[name]) : null;
    if (next === null) manual.push(name);
    else {
      source = next;
      tasks.push(name);
    }
  }
  return { tasks, manual, source };
}

/** `source` with `tasks[name]` set to `command`, or `null` (no command, or the edit refused). */
async function setTask(
  source: string,
  name: string,
  command: string | undefined,
): Promise<string | null> {
  if (command === undefined) return null;
  const edit = await setJsonValue(source, ["tasks", name], command);
  return edit.ok ? edit.source : null;
}

/** {@linkcode retiredConfigUpdate} over every config (the root's and the members'), written when `write`. */
async function applyRetiredConfig(
  paths: readonly string[],
  write: boolean,
): Promise<RetiredConfigChange[]> {
  const changes: RetiredConfigChange[] = [];
  for (const path of paths) {
    const update = await retiredConfigUpdate(await Deno.readTextFile(path));
    if (update === null) continue;
    const writes = write && (update.unstable.length > 0 || update.tasks.length > 0);
    if (writes) await Deno.writeTextFile(path, update.text);
    changes.push({
      path,
      unstable: update.unstable,
      tasks: update.tasks,
      manual: update.manual,
      written: writes,
    });
  }
  return changes;
}

/** Whether an `exclude` entry already keeps the runtime's `.deno/` directory out. */
const DENO_DIR_ENTRY = /^(?:\.\/)?\.deno(?:\/(?:\*\*)?)?$/;

/**
 * The root config's text with the scaffold's `.deno/` entry added to its top-level `exclude`
 * (runtime 3.0.0-rc.5's type-check writes `.deno/npm-compat` there, whose `_test.ts` files
 * `deno test` would otherwise walk), or `null`: already there, or a config whose `exclude` isn't
 * a list (left for the user). Comments and key order are kept.
 *
 * @param text The `deno.json` / `deno.jsonc` text.
 * @returns The new text, or `null`.
 */
export async function denoDirExcludeUpdate(text: string): Promise<string | null> {
  let doc: unknown;
  try {
    doc = parseJsonc(text);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const exclude = (doc as { exclude?: unknown }).exclude;
  if (exclude !== undefined && !Array.isArray(exclude)) return null;
  const list = (exclude ?? []) as unknown[];
  if (list.some((e) => typeof e === "string" && DENO_DIR_ENTRY.test(e.trim()))) return null;
  const edit = await setJsonValue(text, ["exclude"], [...list, ...SCAFFOLD_EXCLUDE]);
  return edit.ok ? edit.source : null;
}

/** Add the `.deno/` exclude to the root config when it is missing (written when `write`). */
async function applyDenoExclude(
  path: string,
  write: boolean,
): Promise<UpgradeOutcome["denoExclude"]> {
  const next = await denoDirExcludeUpdate(await Deno.readTextFile(path));
  if (next === null) return null;
  if (write) await Deno.writeTextFile(path, next);
  return { written: write };
}

/**
 * The jail exceptions the project's dependencies need (sharp, Prisma's engines, puppeteer, …):
 * the runtime jails dependencies' lifecycle scripts by default from 3.0.0-rc.5, so a project
 * upgraded from a denext that pinned an earlier runtime gets them written now, as `create`,
 * `migrate` and `add` write them (only when `write`; else reported).
 */
async function applyJail(dir: string, write: boolean): Promise<JailReport | null> {
  try {
    const report = await applyJailExceptions(dir, { edit: write });
    return report.action === "none" ? null : report;
  } catch {
    return null; // an unreadable project: the doctor check reports it
  }
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
  if (!info?.isFile || !await insideProject(dir, path)) return null;
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

/** The `--json` document of an outcome. */
function outcomeJson(
  o: UpgradeOutcome,
  files: { changedFiles: string[]; unresolved: string[]; outside: string[] },
): Record<string, unknown> {
  return {
    config: o.path,
    ...o.plan,
    written: o.written,
    files: files.changedFiles,
    ...(o.stripped.length ? { removedExclude: o.stripped } : {}),
    ...(o.lock === undefined ? {} : { lockRefreshed: o.lock }),
    ...(o.editor ? { editorSettings: o.editor } : {}),
    ...(o.denoExclude ? { denoExclude: o.denoExclude } : {}),
    ...(o.jail ? { jailExceptions: { action: o.jail.action, lines: o.jail.lines } } : {}),
    ...(o.retired.length ? { retiredConfig: o.retired } : {}),
    ...(files.unresolved.length ? { unresolvedMembers: files.unresolved } : {}),
    ...(files.outside.length ? { outsideMembers: files.outside } : {}),
  };
}

/** Print the outcome: one JSON document, or the human report. */
function printOutcome(
  json: boolean,
  o: UpgradeOutcome,
  files: { changedFiles: string[]; unresolved: string[]; outside: string[] },
): void {
  const { changedFiles, unresolved, outside } = files;
  if (json) return void console.log(JSON.stringify(outcomeJson(o, files)));
  report(o.plan, o.path, o.check, o.written, o.now);
  reportExclude(o.dir, o.stripped, o.written);
  reportWorkspace(o.dir, o.plan.ok ? changedFiles : [], unresolved, outside);
  reportEditor(o.dir, o.editor);
  reportProjectRepairs(o);
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
  if (!await insideProject(dir, path)) {
    console.error(
      `denext upgrade: ${path} is a symlink that leads out of the project; not changed`,
    );
    return 1;
  }
  const { files: read, unresolved, outside } = await workspaceConfigs(dir, path);
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
  const repairs = await projectRepairs(
    dir,
    files.map((f) => f.path),
    plan.ok,
    !check && ctx.flags["dry-run"] !== true,
  );
  const lock = written && await hasLockfile(dir) ? await refreshLock(dir) : undefined;
  const outcome = { dir, path, plan, check, written, lock, stripped, now, ...repairs };
  printOutcome(ctx.global.json === true, outcome, { changedFiles, unresolved, outside });
  if (!plan.ok) return 1;
  return check && changed ? 1 : 0;
}

/**
 * What an upgrade sets right beside the pins (only once the plan is good): the `.deno/` exclude,
 * the jail exceptions, the editor's language server and denext 5.0's config clean-ups (every
 * config: the root's, then the members'), written when `write` (not with `--dry-run` /
 * `--check`, which only report them).
 */
async function projectRepairs(
  dir: string,
  paths: readonly string[],
  ok: boolean,
  write: boolean,
): Promise<Pick<UpgradeOutcome, "denoExclude" | "jail" | "editor" | "retired">> {
  if (!ok) return { denoExclude: null, jail: null, editor: null, retired: [] };
  return {
    denoExclude: await applyDenoExclude(paths[0], write),
    jail: await applyJail(dir, write),
    editor: await applyEditorSetting(dir, write),
    retired: await applyRetiredConfig(paths, write),
  };
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
): Promise<{ files: { path: string; text: string }[]; unresolved: string[]; outside: string[] }> {
  const text = await Deno.readTextFile(path);
  const members = await memberConfigs(dir, text);
  const files = [{ path, text }];
  for (const member of members.paths) {
    if (member !== path) files.push({ path: member, text: await Deno.readTextFile(member) });
  }
  return { files, unresolved: members.unresolved, outside: members.outside };
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

/** The `.deno/` exclude and the jail exceptions added (or that would be). */
function reportProjectRepairs(o: UpgradeOutcome): void {
  if (o.denoExclude) {
    console.log(
      `\n${o.denoExclude.written ? "Added" : "Would add"} ".deno/" to ${
        relative(o.dir, o.path) || o.path
      }'s "exclude": the runtime's type-check writes .deno/npm-compat, which test, lint and ` +
        "fmt must not walk.",
    );
  }
  if (o.jail) console.log(`\n${o.jail.lines.join("\n")}`);
  for (const r of o.retired) reportRetired(o.dir, r);
}

/** One config's 5.0 clean-ups: what was (or would be) changed, and what is left to the user. */
function reportRetired(dir: string, r: RetiredConfigChange): void {
  const where = relative(dir, r.path) || r.path;
  const verb = r.written ? "Removed" : "Would remove";
  if (r.unstable.length) {
    console.log(
      `\n${verb} ${r.unstable.map((f) => `"${f}"`).join(", ")} from ${where}'s "unstable": ` +
        "denext 5.0's runtime has that behavior by default.",
    );
  }
  if (r.tasks.length) {
    console.log(
      `\n${r.written ? "Rewrote" : "Would rewrite"} ${r.tasks.join(", ")} in ${where} to run ` +
        "`denext desktop package`, which runs the packaging script on denext's runtime (a plain " +
        "`deno task` on another Deno would be refused).",
    );
  }
  if (r.manual.length) {
    console.error(
      `denext upgrade: ${r.manual.join(", ")} in ${where} run${
        r.manual.length === 1 ? "s" : ""
      } a scripts/package-*.ts straight on \`deno\`, ` +
        "which denext 5.0 refuses off its runtime; not rewritten (edited by hand, or no denext " +
        "CLI task to copy). Point it at `denext desktop package [--target-os linux|windows]`, " +
        "or run it with `denext task`.",
    );
  }
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
function reportWorkspace(
  dir: string,
  changed: readonly string[],
  unresolved: readonly string[],
  outside: readonly string[],
) {
  if (changed.length > 1) {
    console.log(`Workspace configs: ${changed.map((f) => relative(dir, f)).join(", ")}`);
  }
  for (const m of unresolved) {
    console.error(`denext upgrade: workspace member ${m} has no deno.json; its pins were not read`);
  }
  for (const m of outside) {
    console.error(
      `denext upgrade: workspace member ${m} is outside the project (or linked out of it); ` +
        "its pins were not read or changed",
    );
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
    'A missing ".deno/" entry is added to the top-level "exclude", and the lifecycle-script jail\n' +
    "exceptions the dependencies need (sharp, Prisma's engines, …) are written, as create does.\n" +
    'A .vscode/settings.json that turns the Deno LSP on and sets no "deno.unstable" gets\n' +
    '"deno.unstable": ["tsgo-lsp"] (the TypeScript 7 language server; DENEXT_TSGO_LSP=0 skips it).\n' +
    'denext 5.0 clean-ups: "no-legacy-abort" leaves "unstable" (the runtime\'s default now), and\n' +
    "the desktop:package tasks create wrote before 5.0 (`deno run -A scripts/package-*.ts`) become\n" +
    "`denext desktop package` (a hand-edited one is reported, not rewritten).\n" +
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
