// Keep the `workspace.links` section of every committed example (and site) `deno.lock` in step
// with the repo's workspace, so building an example never rewrites a tracked file.
//
// An example lives inside the repo's workspace and imports the checkout (`../../mod.ts`), so
// Deno records each workspace member it links as `jsr:<name>@<version>` with that member's
// dependencies. Those entries change whenever the workspace does — every release bumps the
// versions, and a member's new dependency changes its list — and the next build of the example
// rewrote its lock: a dirty tree after the pre-push budget build, in every checkout, until
// someone committed it. The entries are exactly the root `deno.lock`'s `workspace` section (the
// dependency lists, in Deno's normalized form) under each member's current version, so they are
// derived here instead; `deno task regen` runs it, and `regen --check` (the pre-push precheck)
// fails while one is stale. The rest of each lock (what the example's graph actually resolves)
// is left to Deno.
//
//   deno task sync:example-locks

import { fromFileUrl, join, relative } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** The directories whose `deno.lock` files are searched (with their subdirectories). */
const LOCK_DIRS = ["examples", "site"] as const;

/** How deep below each of {@linkcode LOCK_DIRS} a lock is looked for. */
const MAX_DEPTH = 3;

/** A workspace member as a lock links it: its current version and dependency list. */
interface Member {
  readonly version: string;
  readonly dependencies: readonly string[];
}

/** The parts of a `deno.lock` this script reads and writes. */
interface Lock {
  workspace?: {
    dependencies?: string[];
    members?: Record<string, { dependencies?: string[] }>;
    links?: Record<string, { dependencies?: string[] }>;
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(Deno.readTextFileSync(path)) as T;
}

/**
 * Every workspace member by package name: the root package and each `workspace` entry, with the
 * dependency list the root `deno.lock` records for it.
 *
 * @param root The repository root.
 * @returns The members, keyed by name (`@denext/backend`).
 */
export function workspaceMembers(root: string = ROOT): Map<string, Member> {
  const config = readJson<{ name: string; version: string; workspace?: string[] }>(
    join(root, "deno.json"),
  );
  const lock = readJson<Lock>(join(root, "deno.lock")).workspace ?? {};
  const members = new Map<string, Member>([
    [config.name, { version: config.version, dependencies: lock.dependencies ?? [] }],
  ]);
  for (const entry of config.workspace ?? []) {
    const path = entry.replace(/^\.\//, "").replace(/\/$/, "");
    const member = readJson<{ name?: string; version?: string }>(join(root, path, "deno.json"));
    if (!member.name || !member.version) continue;
    members.set(member.name, {
      version: member.version,
      dependencies: lock.members?.[path]?.dependencies ?? [],
    });
  }
  return members;
}

/**
 * The `workspace.links` Deno writes for a lock inside this workspace: every member, as
 * `jsr:<name>@<version>` with its dependency list (`{}` without one), sorted by key.
 *
 * @param members From {@linkcode workspaceMembers}.
 * @returns The links.
 */
export function workspaceLinks(
  members: ReadonlyMap<string, Member>,
): Record<string, { dependencies?: string[] }> {
  const links = [...members].map(([name, member]) =>
    [
      `jsr:${name}@${member.version}`,
      member.dependencies.length > 0 ? { dependencies: [...member.dependencies] } : {},
    ] as const
  );
  return Object.fromEntries(links.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Every committed-style lock under {@linkcode LOCK_DIRS} that links workspace members.
 *
 * @param root The repository root.
 * @returns Repo-relative paths, sorted.
 */
export function linkedLockFiles(root: string = ROOT): string[] {
  const found: string[] = [];
  for (const dir of LOCK_DIRS) collectLinkedLocks(join(root, dir), 0, found);
  return found.map((p) => relative(root, p).replaceAll("\\", "/")).sort();
}

/** Whether `path` is a lock with a `workspace.links` section (an unreadable one is not). */
function linksWorkspace(path: string): boolean {
  try {
    return readJson<Lock>(path).workspace?.links !== undefined;
  } catch {
    return false;
  }
}

/** Whether {@linkcode collectLinkedLocks} descends into `entry` at `depth`. */
function descends(entry: Deno.DirEntry, depth: number): boolean {
  return entry.isDirectory && depth < MAX_DEPTH && entry.name !== "node_modules" &&
    !entry.name.startsWith(".");
}

/** Push every linked lock under `dir` (down to {@linkcode MAX_DEPTH}) onto `found`. */
function collectLinkedLocks(dir: string, depth: number, found: string[]): void {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile && entry.name === "deno.lock") {
      if (linksWorkspace(path)) found.push(path);
    } else if (descends(entry, depth)) {
      collectLinkedLocks(path, depth + 1, found);
    }
  }
}

/**
 * Rewrite the `workspace.links` of every lock {@linkcode linkedLockFiles} finds.
 *
 * @param root The repository root.
 * @returns The repo-relative paths whose contents changed.
 */
export function syncExampleLocks(root: string = ROOT): string[] {
  const links = workspaceLinks(workspaceMembers(root));
  const changed: string[] = [];
  for (const rel of linkedLockFiles(root)) {
    const path = join(root, rel);
    const before = Deno.readTextFileSync(path);
    const lock = JSON.parse(before) as Lock;
    lock.workspace!.links = links;
    const after = JSON.stringify(lock, null, 2) + "\n";
    if (after !== before) {
      Deno.writeTextFileSync(path, after);
      changed.push(rel);
    }
  }
  return changed;
}

if (import.meta.main) {
  const changed = syncExampleLocks();
  console.log(
    changed.length === 0
      ? "sync:example-locks: every example lock links the current workspace"
      : `sync:example-locks: updated ${changed.join(", ")}`,
  );
}
