// `denext generate app <name>`: another app in a `denext create --monorepo` workspace —
// `apps/<name>` scaffolded as `apps/web` was (importing the workspace's `<scope>/ui` and
// `<scope>/shared`), added to the root's `workspace` list, with a `dev:<name>` root task.

import { join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { scaffoldFiles } from "./scaffold.ts";
import { setJsonValue } from "./json-edit.ts";
import { memberDirs, workspaceMembers } from "./workspace-imports.ts";
import { VERSION } from "../../mod.ts";

/** One file the plan writes (the shape of `generate.ts`'s preview file). */
interface AppPlanFile {
  readonly path: string;
  readonly contents: string;
  readonly overwrite?: boolean;
}

/** An app name: a lower-case folder name (`admin`, `docs-site`). */
const APP_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The workspace root's config file and text, or a refusal naming what is missing. */
async function readRootConfig(rootDir: string): Promise<{ path: string; text: string }> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const path = join(rootDir, name);
    try {
      return { path, text: await Deno.readTextFile(path) };
    } catch { /* try the next */ }
  }
  throw new Error(`denext: generate app: no deno.json in ${rootDir}.`);
}

/** The `name` of every member package (members without one are skipped). */
async function memberNames(rootDir: string, members: readonly string[]): Promise<string[]> {
  const names: string[] = [];
  for (const entry of members) {
    for (const dir of await memberDirs(rootDir, entry)) {
      for (const file of ["deno.json", "deno.jsonc"]) {
        try {
          const name = (parseJsonc(await Deno.readTextFile(join(dir, file))) as { name?: unknown })
            ?.name;
          if (typeof name === "string") names.push(name);
          break;
        } catch { /* try the next */ }
      }
    }
  }
  return names;
}

/** A member entry without its leading `./` and trailing `/`. */
const bareEntry = (entry: string) => entry.replace(/^\.\//, "").replace(/\/$/, "");

/**
 * Whether the workspace entry `entry` names the member at `dir` (root-relative, `/`-separated):
 * the same path, or a `<parent>/*` glob over `dir`'s parent — Deno refuses a member named twice,
 * so a glob that covers the new app means it is listed already.
 */
function namesMember(entry: string, dir: string): boolean {
  const bare = bareEntry(entry);
  if (!bare.includes("*")) return bare === dir;
  const glob = /^(.*?)\/?\*$/.exec(bare);
  return glob !== null && !glob[1].includes("*") &&
    bareEntry(glob[1]) === dir.slice(0, dir.lastIndexOf("/"));
}

/** The scope whose `ui` and `shared` packages are both members (`@acme`), or null. */
function sharedScope(names: readonly string[]): string | null {
  for (const name of names) {
    const m = /^(@[^/]+)\/ui$/.exec(name);
    if (m && names.includes(`${m[1]}/shared`)) return m[1];
  }
  return null;
}

/**
 * The plan for `denext generate app <name>` in the workspace at `rootDir`: the new app's files
 * (pinned to the denext version the workspace already pins) and the root config with the member
 * and its `dev:<name>` task added.
 *
 * @param rootDir The workspace root (`denext create --monorepo`'s directory).
 * @param name The app's folder name under `apps/`.
 * @returns The files to write; the root config is marked `overwrite`.
 */
export async function appPlan(rootDir: string, name: string): Promise<AppPlanFile[]> {
  if (!APP_NAME.test(name)) {
    throw new Error(
      `denext: generate app: "${name}" is not an app name (lower-case letters, digits and "-").`,
    );
  }
  const root = await readRootConfig(rootDir);
  const config = parseJsonc(root.text) as Record<string, unknown> | null;
  const members = workspaceMembers(config);
  if (!members) {
    throw new Error(
      `denext: generate app: ${root.path} declares no "workspace"; ` +
        "`denext create <dir> --monorepo` makes a workspace to add apps to.",
    );
  }
  const scope = sharedScope(await memberNames(rootDir, members));
  if (!scope) {
    throw new Error(
      "denext: generate app: the workspace has no <scope>/ui and <scope>/shared packages " +
        "(what `denext create --monorepo` writes) for the new app to import.",
    );
  }
  const dir = `apps/${name}`;
  // The workspace's own pin, so every member resolves the same denext.
  const pinned = /jsr:@denext\/denext@([^/"\s]+)/.exec(root.text)?.[1] ?? `^${VERSION}`;
  const files = scaffoldFiles({ dir: join(rootDir, dir), monorepoScope: scope, vscode: false })
    .map((f) => ({
      path: join(rootDir, dir, f.path),
      contents: f.content.replaceAll(
        `jsr:@denext/denext@^${VERSION}`,
        `jsr:@denext/denext@${pinned}`,
      ),
    }));
  const listed = members.some((m) => namesMember(m, dir));
  const workspace = listed ? members : [...members, `./${dir}`];
  const text = await withMember(root.text, config!, workspace, name, dir);
  return [...files, { path: root.path, contents: text, overwrite: true }];
}

/**
 * The root config with the member list and the app's `dev:<name>` task set: re-serialized when it
 * is plain JSON (laid out as `deno fmt` keeps it), else spliced so its comments survive.
 */
async function withMember(
  text: string,
  config: Record<string, unknown>,
  workspace: readonly string[],
  name: string,
  dir: string,
): Promise<string> {
  const listPath = Array.isArray(config.workspace) ? ["workspace"] : ["workspace", "members"];
  const task = `deno task --cwd ${dir} dev`;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    if (Array.isArray(json.workspace)) json.workspace = workspace;
    else (json.workspace as Record<string, unknown>).members = workspace;
    json.tasks = { ...(json.tasks as Record<string, string> | undefined), [`dev:${name}`]: task };
    return JSON.stringify(json, null, 2) + "\n";
  } catch {
    const next = edited(await setJsonValue(text, listPath, workspace));
    return edited(await setJsonValue(next, ["tasks", `dev:${name}`], task));
  }
}

/** An edit's new text, or the refusal as an error. */
function edited(result: Awaited<ReturnType<typeof setJsonValue>>): string {
  if (!result.ok) {
    throw new Error(`denext: generate app: can't edit the root config: ${result.reason}`);
  }
  return result.source;
}
