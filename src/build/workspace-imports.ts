// The Deno workspace an app belongs to, as import-map entries. Deno resolves a workspace
// member's imports through the workspace — the root's `imports`, and every other member by its
// `name` (`import { Button } from "@acme/ui"`) — but the configs denext writes for a re-exec
// (`module-config.json`, `css-config.json`) are standalone files outside it, so under them those
// specifiers are "not in import map". This turns the workspace into plain entries those configs
// carry: the root's imports, each member's `exports` under its `name`, and each member's own
// imports scoped to its directory.

import { dirname, isAbsolute, join, resolve, toFileUrl } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { parse as parseYaml } from "@std/yaml";
import { CONFIG_FILES } from "./config-files.ts";
import { withNpmrcSupplyChain } from "./npmrc-supply-chain.ts";
import { expandWorkspaceMembers } from "./workspace-globs.ts";

/** What {@linkcode workspaceImports} adds to a merged config. */
export interface WorkspaceImports {
  /** The workspace root's `imports`, then each member package's exports, as absolute entries. */
  readonly imports: Record<string, string>;
  /** Each member's own `imports`, scoped to the member's directory (`file:` URL ending in `/`). */
  readonly scopes: Record<string, Record<string, string>>;
}

const CONFIG_NAMES = ["deno.json", "deno.jsonc"] as const;

/** A config file's object, or `null` (absent, unreadable, not a JSON(C) object). */
function readObject(path: string): Record<string, unknown> | null {
  try {
    const value = parseJsonc(Deno.readTextFileSync(path));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** The `deno.json` / `deno.jsonc` in `dir` with its parsed object, or `null`. */
function configIn(dir: string): { path: string; config: Record<string, unknown> } | null {
  for (const name of CONFIG_NAMES) {
    const config = readObject(join(dir, name));
    if (config) return { path: join(dir, name), config };
  }
  return null;
}

/** A config's workspace member entries (`"workspace": [...]` or `{ members: [...] }`). */
export function workspaceMembers(config: Record<string, unknown> | null): string[] | null {
  const ws = config?.workspace;
  const list = Array.isArray(ws) ? ws : (ws as { members?: unknown } | undefined)?.members;
  return Array.isArray(list) ? list.filter((m): m is string => typeof m === "string") : null;
}

/**
 * The directories one `workspace` entry names, as Deno expands it (see workspace-globs.ts): a
 * path (as written, outside the root too), or a glob (`apps/*`, `packages/**`, one mid-path) over the directories that hold a
 * config, minus any the list's `!` entries exclude.
 *
 * @param root The workspace root directory.
 * @param entry One `workspace` entry.
 * @param members The whole list, whose `!` entries apply (default: the entry alone).
 */
export function memberDirs(
  root: string,
  entry: string,
  members: readonly string[] = [entry],
): Promise<string[]> {
  if (entry.startsWith("!")) return Promise.resolve([]);
  // A path as written, even one outside the root: `denext upgrade` reports that one.
  if (!/[*?]/.test(entry)) return Promise.resolve([join(root, entry)]);
  const negations = members.filter((m) => m.startsWith("!"));
  return Promise.resolve(expandWorkspaceMembers(root, [entry, ...negations], "deno"));
}

/**
 * Every member directory a workspace root lists (resolved, de-duplicated), but none outside the
 * root (`../x`): Deno refuses such a member, so its imports are never read and no hint names it.
 */
function allMemberDirs(root: string, members: readonly string[]): string[] {
  return expandWorkspaceMembers(resolve(root), members, "deno");
}

/** A config's `imports` with `./` / `../` values made absolute `file:` URLs (prefixes keep `/`). */
function absoluteImports(config: Record<string, unknown>, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const imports = config.imports;
  if (!imports || typeof imports !== "object") return out;
  for (const [key, value] of Object.entries(imports as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    out[key] = value.startsWith("./") || value.startsWith("../") ? fileUrl(dir, value) : value;
  }
  return out;
}

/** `rel` under `dir` as a `file:` URL, keeping a trailing `/`. */
function fileUrl(dir: string, rel: string): string {
  const href = toFileUrl(resolve(dir, rel)).href;
  return rel.endsWith("/") && !href.endsWith("/") ? href + "/" : href;
}

/**
 * A member package's entries: `name` → its `"."` export, `name/sub` → its `"./sub"` export.
 * A member without a string `name` and `exports` is not importable by name (Deno's rule too).
 */
function packageEntries(config: Record<string, unknown>, dir: string): Record<string, string> {
  const name = config.name;
  const exports = typeof config.exports === "string" ? { ".": config.exports } : config.exports;
  if (typeof name !== "string" || !exports || typeof exports !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, target] of Object.entries(exports as Record<string, unknown>)) {
    if (typeof target !== "string") continue;
    const sub = key === "." ? "" : key.replace(/^\.\//, "/");
    out[name + sub] = fileUrl(dir, target);
  }
  return out;
}

/** A workspace: its root directory, the root config and its member entries. */
interface Workspace {
  readonly root: string;
  readonly config: Record<string, unknown>;
  readonly members: string[];
}

/** The workspace `dir`'s own config declares, or null. */
function workspaceAt(dir: string): Workspace | null {
  const found = configIn(dir);
  const members = workspaceMembers(found?.config ?? null);
  return found && members ? { root: dir, config: found.config, members } : null;
}

/**
 * The workspace root whose members include `appDir`: the app's own config when it declares a
 * `workspace`, else the nearest ancestor config with one — when that one lists the app (Deno
 * treats an unlisted app as standalone, and so does denext).
 */
function findWorkspace(appDir: string): Workspace | null {
  const own = workspaceAt(appDir);
  if (own) return own;
  for (let up = dirname(appDir), below = appDir; up !== below; below = up, up = dirname(up)) {
    const ws = workspaceAt(up);
    if (ws) return allMemberDirs(up, ws.members).includes(appDir) ? ws : null;
  }
  return null;
}

/** A Deno workspace as {@linkcode workspaceOf} reports it. */
export interface WorkspaceDirs {
  /** The root directory (the one whose config declares `workspace`). */
  readonly root: string;
  /** Every member directory the root lists (resolved). */
  readonly members: readonly string[];
}

/**
 * The Deno workspace `dir` belongs to (as its root or a listed member), or null.
 *
 * @param dir A project directory.
 * @returns The root and member directories.
 */
export async function workspaceOf(dir: string): Promise<WorkspaceDirs | null> {
  const ws = await findWorkspace(resolve(dir));
  return ws ? { root: ws.root, members: await allMemberDirs(ws.root, ws.members) } : null;
}

/**
 * A package.json's npm `workspaces` entries (`["packages/*"]`, or Yarn's `{ packages: [...] }`).
 *
 * @param pkg The parsed package.json (or null).
 * @returns The entries, or null when it declares none.
 */
function npmWorkspaceEntries(pkg: Record<string, unknown> | null): string[] | null {
  const ws = pkg?.workspaces;
  const list = Array.isArray(ws) ? ws : (ws as { packages?: unknown } | undefined)?.packages;
  return Array.isArray(list) ? list.filter((m): m is string => typeof m === "string") : null;
}

/** A `pnpm-workspace.yaml`'s `packages` entries, or null when it lists none. */
function pnpmWorkspaceEntries(dir: string): string[] | null {
  let doc: unknown;
  try {
    doc = parseYaml(Deno.readTextFileSync(join(dir, "pnpm-workspace.yaml")));
  } catch {
    return null;
  }
  const list = (doc as { packages?: unknown } | null)?.packages;
  return Array.isArray(list) ? list.filter((m): m is string => typeof m === "string") : null;
}

/**
 * The npm-family workspace `dir` declares, or null: a `pnpm-workspace.yaml`'s `packages` (pnpm
 * reads that file, never package.json `workspaces`), else the package.json `workspaces`.
 */
function npmWorkspaceAt(dir: string): WorkspaceDirs | null {
  const pnpm = pnpmWorkspaceEntries(dir);
  if (pnpm) return { root: dir, members: expandWorkspaceMembers(dir, pnpm, "pnpm") };
  const members = npmWorkspaceEntries(readObject(join(dir, "package.json")));
  return members ? { root: dir, members: expandWorkspaceMembers(dir, members, "npm") } : null;
}

/**
 * The npm workspace (package.json `workspaces`, or pnpm's `pnpm-workspace.yaml`, which Deno
 * installs for as it does a deno.json `workspace`) `dir` belongs to, as its root or a listed
 * member; null otherwise. Members are expanded as that manager does (workspace-globs.ts: `*`,
 * `**`, `!` exclusions, `node_modules` skipped) and none outside the root.
 *
 * @param dir A project directory.
 * @returns The root and member directories.
 */
export function npmWorkspaceOf(dir: string): Promise<WorkspaceDirs | null> {
  const appDir = resolve(dir);
  const own = npmWorkspaceAt(appDir);
  if (own) return Promise.resolve(own);
  for (let up = dirname(appDir), below = appDir; up !== below; below = up, up = dirname(up)) {
    const ws = npmWorkspaceAt(up);
    if (ws) return Promise.resolve(ws.members.includes(appDir) ? ws : null);
  }
  return Promise.resolve(null);
}

/**
 * The npm supply-chain settings a config denext generates for a re-exec (`module-config.json`,
 * `css-config.json`, the compile config) must carry, so a build child resolves npm packages
 * under the project's own policy (`paranoid`, `advisoryCheck: "required"`, the jail and its
 * exceptions) and not Deno's defaults. Deno reads `supplyChain` from the workspace root's
 * config alone, so a member app takes the root's. The root's `.npmrc`, which Deno does not
 * find next to a config in `.denext/`, adds its supply-chain keys (never the file itself, which
 * may hold registry credentials): {@linkcode withNpmrcSupplyChain}. Relative `jailScripts.packages.*.write` paths
 * are made absolute against that config's directory (the generated file lives elsewhere); `~`
 * paths stay for the runtime to resolve.
 *
 * @param appConfigPath The app's `deno.json` / `deno.jsonc`.
 * @returns `{ supplyChain }`, or `{}` when the project sets none.
 */
export async function supplyChainConfig(
  appConfigPath: string,
): Promise<{ supplyChain?: unknown }> {
  const appDir = resolve(dirname(appConfigPath));
  const ws = await findWorkspace(appDir);
  const root = ws?.root ?? appDir;
  const config = ws ? ws.config : await readObject(resolve(appConfigPath));
  // The child's config lives in `.denext/`, where Deno looks for no project `.npmrc`.
  const npmrc = await Deno.readTextFile(join(root, ".npmrc")).catch(() => null);
  const value = withNpmrcSupplyChain(config?.supplyChain, npmrc);
  if (value === undefined || value === null) return {};
  const copy = structuredClone(value) as Record<string, unknown>;
  const jail = copy?.jailScripts as { packages?: Record<string, { write?: unknown }> } | undefined;
  for (const pkg of Object.values(jail?.packages ?? {})) {
    if (!pkg || !Array.isArray(pkg.write)) continue;
    pkg.write = pkg.write.map((w) =>
      typeof w === "string" && !w.startsWith("~") && !isAbsolute(w) ? resolve(root, w) : w
    );
  }
  return { supplyChain: copy };
}

/**
 * The import-map entries a standalone config needs to resolve as the app's workspace does: the
 * root's `imports` (when the app is a member, not the root), every other member package by name,
 * and each member's own `imports` as a scope over its directory. Empty outside a workspace.
 *
 * @param appConfigPath The app's `deno.json` / `deno.jsonc`.
 * @returns The entries (the caller layers the app's own imports over `imports`).
 */
export function workspaceImports(appConfigPath: string): Promise<WorkspaceImports> {
  return Promise.resolve(workspaceImportsSync(appConfigPath));
}

/**
 * {@linkcode workspaceImports}, synchronously: what the client bundler's loader is handed for an
 * app a workspace names through a glob member (`apps/*`, `packages/**`), which its own discovery
 * can't expand.
 *
 * @param appConfigPath The app's `deno.json` / `deno.jsonc`.
 * @returns The entries.
 */
export function workspaceImportsSync(appConfigPath: string): WorkspaceImports {
  const appDir = resolve(dirname(appConfigPath));
  const ws = findWorkspace(appDir);
  if (!ws) return { imports: {}, scopes: {} };
  const imports: Record<string, string> = ws.root === appDir
    ? {}
    : absoluteImports(ws.config, ws.root);
  const scopes: Record<string, Record<string, string>> = {};
  for (const dir of allMemberDirs(ws.root, ws.members)) {
    if (dir === appDir) continue;
    const member = configIn(dir);
    if (!member) continue;
    Object.assign(imports, packageEntries(member.config, dir));
    const own = absoluteImports(member.config, dir);
    if (Object.keys(own).length > 0) scopes[toFileUrl(dir).href + "/"] = own;
  }
  return { imports, scopes };
}

/**
 * The root directory of the Deno workspace that lists the app at `appConfigPath` as a member (a
 * glob member included), or `null`: outside a workspace, the root itself, or not a member.
 *
 * @param appConfigPath The app's `deno.json` / `deno.jsonc`.
 */
export function workspaceRootSync(appConfigPath: string): string | null {
  const appDir = resolve(dirname(appConfigPath));
  const ws = findWorkspace(appDir);
  return ws && ws.root !== appDir ? ws.root : null;
}

/**
 * The other members of the Deno workspace `appDir` belongs to (absolute directories that
 * exist): the packages an app may import by name, which `denext dev` watches beside the app.
 * Empty outside a workspace.
 *
 * @param appDir The app's directory.
 */
export async function workspaceMemberDirs(appDir: string): Promise<string[]> {
  const dir = resolve(appDir);
  const ws = findWorkspace(dir);
  if (!ws) return [];
  const out: string[] = [];
  for (const d of allMemberDirs(ws.root, ws.members)) {
    if (d === dir) continue;
    try {
      if ((await Deno.stat(d)).isDirectory) out.push(d);
    } catch { /* listed but missing */ }
  }
  return out;
}

/** Whether `path` is a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/** Whether `dir` holds a denext app: an `app/` or `src/app/` folder, or a `denext.config.*`. */
async function isAppDir(dir: string): Promise<boolean> {
  if (await isDirectory(join(dir, "app")) || await isDirectory(join(dir, "src", "app"))) {
    return true;
  }
  for (const name of CONFIG_FILES) {
    if (await Deno.stat(join(dir, name)).then((s) => s.isFile, () => false)) return true;
  }
  return false;
}

/**
 * The other members of `appDir`'s workspace that are not denext apps themselves: the packages
 * (`packages/ui`) whose files the app may take as its own — a sibling app's stylesheets (its
 * Tailwind input among them) are that app's.
 *
 * @param appDir The app's directory.
 */
export async function workspacePackageDirs(appDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const dir of await workspaceMemberDirs(appDir)) if (!await isAppDir(dir)) out.push(dir);
  return out;
}

/**
 * The members of the workspace rooted at `rootDir` that are denext apps (an `app/` or
 * `src/app/` folder, or a `denext.config.*`), relative to the root and `/`-separated. Empty when `rootDir` declares no
 * `workspace`.
 *
 * @param rootDir A directory whose `deno.json` may declare a workspace.
 */
export async function workspaceApps(rootDir: string): Promise<string[]> {
  const root = resolve(rootDir);
  const members = workspaceMembers(configIn(root)?.config ?? null);
  if (!members) return [];
  const apps: string[] = [];
  for (const dir of allMemberDirs(root, members)) {
    if (await isAppDir(dir)) apps.push(dir.slice(root.length + 1).replaceAll("\\", "/"));
  }
  return apps;
}

/**
 * What to tell someone who ran an app command at a workspace root: which members are the apps,
 * and how to run the command on one. `null` when `rootDir` is no workspace root with an app.
 *
 * @param rootDir The directory the command ran on.
 */
export async function workspaceRootHint(rootDir: string): Promise<string | null> {
  const apps = await workspaceApps(rootDir);
  if (apps.length === 0) return null;
  return `${rootDir} is a Deno workspace root; its denext app${
    apps.length > 1 ? "s are" : " is"
  } ` +
    `${apps.join(", ")}. Run the command on one (\`denext dev ${apps[0]}\`, \`denext build ` +
    `${apps[0]}\`), or a root task (\`denext task dev\`), which delegates to it.`;
}

/** What a verb run at a directory operates on: see {@linkcode workspaceVerbTarget}. */
export type WorkspaceVerbTarget =
  | {
    /** The directory to run on: the one given, or its workspace's single app. */
    readonly dir: string;
    /** The app member it was moved to (root-relative), when it was. */
    readonly app?: string;
  }
  | {
    /** Why it can't run there: the workspace has several apps and the verb names none. */
    readonly error: string;
  };

/** Options for {@linkcode workspaceVerbTarget}. */
export interface WorkspaceVerbTargetOptions {
  /** The verb as typed (`denext desktop add secure-store`), for the hint naming each app. */
  readonly command: string;
  /** Which members the verb applies to (default: every denext app). */
  readonly accepts?: (memberDir: string) => Promise<boolean>;
  /** The flag that points the verb at a project (default `--cwd`). */
  readonly dirFlag?: string;
}

/**
 * Where a project verb that may write (`denext ui`, `denext desktop …`, `denext mobile add`) runs
 * when it is pointed at `dir`: `dir` itself, unless `dir` is a Deno workspace root that is no app
 * of its own (no `app/`, `src/app/` or `denext.config.*`) — a `denext create --monorepo` root.
 * There it runs on the workspace's one app the verb applies to, or, with several, refuses with a
 * hint that names them, so it never scaffolds a config or a native shell into the root.
 *
 * @param dir The directory the verb was pointed at.
 * @param options The verb as typed, and which members it applies to.
 * @returns The directory to run on, or why there is none.
 */
export async function workspaceVerbTarget(
  dir: string,
  options: WorkspaceVerbTargetOptions,
): Promise<WorkspaceVerbTarget> {
  const root = resolve(dir);
  const ws = workspaceAt(root);
  if (!ws || await isAppDir(root)) return { dir: root };
  const accepts = options.accepts ?? isAppDir;
  const apps: string[] = [];
  for (const member of allMemberDirs(root, ws.members)) {
    if (await accepts(member)) apps.push(member.slice(root.length + 1).replaceAll("\\", "/"));
  }
  if (apps.length === 0) return { dir: root };
  if (apps.length === 1) return { dir: join(root, apps[0]), app: apps[0] };
  return {
    error: `${root} is a Deno workspace root with several apps (${apps.join(", ")}). Run it on ` +
      `one: \`${options.command} ${options.dirFlag ?? "--cwd"} ${apps[0]}\`.`,
  };
}
