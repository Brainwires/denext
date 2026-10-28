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
import { SCAFFOLD_EXCLUDE } from "../../build/scaffold.ts";
import { setJsonValue } from "../../build/json-edit.ts";
import { applyJailExceptions, type JailReport } from "../../build/jail-scripts.ts";
import {
  authSpecifierFor,
  crossesAuthSplit,
  planAuthSourceRewrites,
  rewriteAuthConfig,
} from "../../build/upgrade-auth.ts";

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
      s.from === ""
        ? `added at ${s.to}`
        : s.from === s.to
        ? `${s.from} (up to date)`
        : `${s.from} → ${s.to}`
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
  /** The 4.x → 5.0 auth rewrite (`null`: the upgrade doesn't cross into 5.0). */
  readonly auth: AuthMigration | null;
}

/** What the 4.x → 5.0 auth rewrite changed (or would). */
interface AuthMigration {
  /** The `@denext/auth` specifier pinned. */
  readonly spec: string;
  /** The source modules whose imports were split, relative to the project. */
  readonly files: readonly string[];
  /** Statements left for a hand edit. */
  readonly warnings: readonly string[];
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
    ...(o.auth ? { authPackage: o.auth } : {}),
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
  reportAuthMigration(o);
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
  const path = await upgradeConfigPath(dir);
  if (!path) return 1;
  // A workspace's members pin denext too: plan over every config at once so they all agree.
  const { files: read, unresolved, outside } = await workspaceConfigs(dir, path);
  // The `jsr:@denext/*` exemption from Deno's dependency-age hold goes first: the plan then
  // picks only versions the hold lets in.
  const files = read.map((f) => ({ ...f, ...stripDenextExclude(f.text) }));
  const stripped = files.filter((f) => f.removed).map((f) => f.path);
  const now = options.now ?? new Date();
  const rule = options.rule ?? await readProjectRule(dir, now, files[0].text);
  const { plan, split, auth } = await planWithAuthSplit(
    dir,
    files,
    { ...upgradeFlags(ctx), rule, now },
    lookups,
  );
  const check = ctx.flags.check === true;
  const changed = plan.ok && (plan.changed || stripped.length > 0);
  const written = changed && !check && ctx.flags["dry-run"] !== true;
  const changedFiles = plan.ok ? await applyToFiles(read, files, plan.steps, written) : [];
  if (written) await writeAuthSources(dir, split);
  const repairs = await projectRepairs(dir, path, plan.ok, !check && ctx.flags["dry-run"] !== true);
  const lock = written && await hasLockfile(dir) ? await refreshLock(dir) : undefined;
  const outcome = { dir, path, plan, check, written, lock, stripped, now, auth, ...repairs };
  printOutcome(ctx.global.json === true, outcome, { changedFiles, unresolved, outside });
  if (!plan.ok) return 1;
  return check && changed ? 1 : 0;
}

/**
 * Plan the upgrade; when it moves denext from 4.x into 5.0, apply the auth split to `files` (in
 * place: their texts gain the `@denext/auth` pin and lose `denext/auth`) and plan again, so the
 * new pin is chosen like any other: the newest `@denext/auth` that admits the denext the plan
 * picks and the dependency-age rule lets in (it starts at a placeholder floor).
 */
async function planWithAuthSplit(
  dir: string,
  files: { path: string; text: string; removed: boolean }[],
  flags: Parameters<typeof planUpgrade>[1],
  lookups: UpgradeLookups,
): Promise<{ plan: UpgradePlan; split: AuthSplit | null; auth: AuthMigration | null }> {
  const first = await planUpgrade(files.map((f) => f.text).join("\n"), flags, lookups);
  const split = first.ok ? await authSplit(dir, files, first.steps) : null;
  if (!split) return { plan: first, split: null, auth: null };
  files.splice(0, files.length, ...split.files);
  const plan = await planUpgrade(split.files.map((f) => f.text).join("\n"), flags, lookups);
  if (!plan.ok) return { plan, split, auth: null };
  const steps = plan.steps.map((s) => addedStep(s, split.floor));
  const to = steps.find((s) => s.name === "@denext/auth")?.to;
  const auth = to ? { ...split.migration, spec: authSpecifierFor(files[0].text, to) } : null;
  return { plan: { ...plan, steps }, split, auth };
}

/** The 4.x → 5.0 auth rewrite planned over a project (see {@link authSplit}). */
interface AuthSplit {
  /** The placeholder version the new `@denext/auth` pin starts at (the plan moves it up). */
  readonly floor: string;
  /** Each config's text with the auth entries rewritten. */
  readonly files: { path: string; text: string; removed: boolean }[];
  /** The source modules to write. */
  readonly sources: readonly { path: string; text: string }[];
  /** What to report. */
  readonly migration: AuthMigration;
}

/**
 * When the plan moves denext from 4.x into 5.0 or later: the configs with `@denext/auth` pinned
 * at the target (the root's entry added when a source needs it) and the `next-auth` aliases on
 * its shim, plus the source modules whose auth imports split. `null` otherwise.
 */
async function authSplit(
  dir: string,
  files: readonly { path: string; text: string; removed: boolean }[],
  steps: readonly UpgradeStep[],
): Promise<AuthSplit | null> {
  const denext = steps.find((s) => s.name === "@denext/denext");
  if (!denext || !crossesAuthSplit(denext.from, denext.to)) return null;
  const sources = await planAuthSourceRewrites(dir);
  // A prerelease floor lets the plan consider prereleases (`5.0.0-rc.1`) for a prerelease target.
  const floor = /-/.test(denext.to) ? "0.0.0-0" : "0.0.0";
  const spec = authSpecifierFor(files[0].text, floor);
  const rewritten = [];
  for (const [i, f] of files.entries()) {
    const out = await rewriteAuthConfig(f.text, spec, i === 0 && sources.needsAuth);
    rewritten.push({ ...f, text: out.text });
  }
  return {
    floor,
    files: rewritten,
    sources: sources.files,
    migration: { spec, files: sources.files.map((f) => f.path), warnings: sources.warnings },
  };
}

/** A step from the placeholder floor is a package the upgrade adds (`from` is empty). */
function addedStep(step: UpgradeStep, floor: string): UpgradeStep {
  return step.name === "@denext/auth" && step.from === floor ? { ...step, from: "" } : step;
}

/** The auth rewrite's lines: the package, the modules split, and what needs a hand edit. */
function reportAuthMigration(o: UpgradeOutcome): void {
  if (!o.auth) return;
  const verb = o.written ? "Moved" : "Would move";
  console.log(
    `\n${verb} the auth imports to ${o.auth.spec} (denext 5.0 ships the auth layer as its own ` +
      `package: https://denext.dev/docs/upgrading-to-5)` +
      (o.auth.files.length ? `:\n${o.auth.files.map((f) => `  ${f}`).join("\n")}` : "."),
  );
  for (const w of o.auth.warnings) console.error(`denext upgrade: ${w}`);
}

/** The project config `upgrade` edits, or `null` (and why, printed): none, or linked outside. */
async function upgradeConfigPath(dir: string): Promise<string | null> {
  const path = await configPath(dir);
  if (!path) {
    console.error(`denext upgrade: no deno.json in ${dir}`);
    return null;
  }
  if (!await insideProject(dir, path)) {
    console.error(
      `denext upgrade: ${path} is a symlink that leads out of the project; not changed`,
    );
    return null;
  }
  return path;
}

/** Write the source modules the auth split rewrote (none without a split). */
async function writeAuthSources(dir: string, split: AuthSplit | null): Promise<void> {
  for (const f of split?.sources ?? []) await Deno.writeTextFile(join(dir, f.path), f.text);
}

/**
 * What an upgrade sets right beside the pins (only once the plan is good): the `.deno/` exclude,
 * the jail exceptions and the editor's language server, written when `write` (not with
 * `--dry-run` / `--check`, which only report them).
 */
async function projectRepairs(
  dir: string,
  path: string,
  ok: boolean,
  write: boolean,
): Promise<Pick<UpgradeOutcome, "denoExclude" | "jail" | "editor">> {
  if (!ok) return { denoExclude: null, jail: null, editor: null };
  return {
    denoExclude: await applyDenoExclude(path, write),
    jail: await applyJail(dir, write),
    editor: await applyEditorSetting(dir, write),
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
    "Into 5.0 (from 4.x) it also moves the auth layer to its own package: `@denext/auth` is\n" +
    "pinned beside denext, imports of the auth names from denext/server or denext/auth are split\n" +
    "onto it (auth(), requireAuth, requireSession and the session types stay in denext/server),\n" +
    "and the next-auth aliases point at @denext/auth's shim.\n" +
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
