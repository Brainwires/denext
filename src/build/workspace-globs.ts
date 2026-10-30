// Workspace member lists, expanded the way the tool that reads each one does: a deno.json
// `workspace`, a package.json `workspaces` (npm, Yarn) and a `pnpm-workspace.yaml` `packages`.
// Every denext caller that turns such a list into directories goes through here, so `denext ui`
// at a monorepo root, the build's import maps, `generate app`, `upgrade` and the jail settings
// all see the same members.
//
// What the three agree on, and what this does for all of them:
// - `*` and `?` match within one path segment, `**` any number of segments (none included);
//   a glob may sit anywhere in the path (`apps/*/web`).
// - A wildcard never matches a name that starts with `.` (a segment spelled `.x` or `.*` does)
//   or `node_modules`, and `**` never descends into either.
// - `!pattern` excludes the directories that pattern matches itself (`!packages/a` leaves
//   `packages/a/inner` a member), whatever its place in the list.
// - A glob names only directories that hold the tool's manifest; the root is never a member, and
//   nothing outside it is.
// Where they differ:
// - Deno (libs/config: `is_glob_pattern`, `escape_brackets`) has no character classes or braces:
//   `[` `]` `{` `}` are literal. Its wildcards never match a symlinked directory, a path entry
//   (no glob) is a member whether or not a `!` entry matches it, and a glob member holds a
//   `deno.json`, `deno.jsonc` or `package.json`.
// - npm (@npmcli/map-workspaces over `glob`), Yarn (fast-glob) and pnpm (micromatch) take
//   `[abc]` classes and `{a,b}` braces, apply `!` to every entry, and may match a symlinked
//   directory. A member holds a `package.json` (pnpm: also `package.yaml` / `package.json5`).
// Unlike the tools, a match whose real path leaves the root (a symlink out of it) is no member
// here, and `**` does not descend through a symlink.

import { isAbsolute, join, normalize, relative, SEPARATOR } from "@std/path";

/** Which tool's rules a member list follows. */
export type WorkspaceKind = "deno" | "npm" | "pnpm";

/** The manifests a glob member must hold, per tool. */
const MANIFESTS: Record<WorkspaceKind, readonly string[]> = {
  deno: ["deno.json", "deno.jsonc", "package.json"],
  npm: ["package.json"],
  pnpm: ["package.json", "package.yaml", "package.json5"],
};

/** One parsed path segment: a literal name, `**`, or a single-segment glob. */
type Segment =
  | { readonly kind: "literal"; readonly name: string }
  | { readonly kind: "globstar" }
  | { readonly kind: "glob"; readonly re: RegExp; readonly dot: boolean };

/** A parsed entry: its segments, whether it is negated, and whether any segment is a glob. */
interface Pattern {
  readonly segments: readonly Segment[];
  readonly negated: boolean;
  readonly glob: boolean;
}

/** Whether `s` holds a glob character for `kind` (Deno: `*` `?`; the npm family: also `[`). */
function hasGlob(s: string, kind: WorkspaceKind): boolean {
  return kind === "deno" ? /[*?]/.test(s) : /[*?[]/.test(s);
}

/** `{a,b}` braces expanded (the npm family's globs), innermost-first; none: the entry itself. */
function expandBraces(entry: string): string[] {
  const m = /\{([^{}]*)\}/.exec(entry);
  if (!m || !m[1].includes(",")) return [entry];
  const head = entry.slice(0, m.index);
  const tail = entry.slice(m.index + m[0].length);
  return m[1].split(",").flatMap((alt) => expandBraces(head + alt + tail));
}

/** A glob segment as an anchored regular expression. */
function segmentRegExp(seg: string, kind: WorkspaceKind): RegExp {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[" && kind !== "deno") {
      const end = seg.indexOf("]", i + 2);
      if (end < 0) out += "\\[";
      else {
        const body = seg.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
        out += `[${body}]`;
        i = end;
      }
    } else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/**
 * One list entry parsed, or null when it names nothing: the root itself, a path that leaves it
 * (`../x`), or an absolute one.
 */
function parseEntry(entry: string, kind: WorkspaceKind): Pattern | null {
  const negated = entry.startsWith("!");
  const body = (negated ? entry.slice(1) : entry).trim().replaceAll("\\", "/");
  if (body === "" || body.startsWith("/") || /^[A-Za-z]:\//.test(body)) return null;
  const norm = normalize(body).replaceAll("\\", "/").replace(/\/+$/, "");
  if (norm === "." || norm === "" || norm === ".." || norm.startsWith("../")) return null;
  const segments: Segment[] = norm.split("/").map((seg): Segment =>
    seg === "**"
      ? { kind: "globstar" }
      : hasGlob(seg, kind)
      ? { kind: "glob", re: segmentRegExp(seg, kind), dot: seg.startsWith(".") }
      : { kind: "literal", name: seg }
  );
  return { segments, negated, glob: segments.some((s) => s.kind !== "literal") };
}

/** Every entry parsed (the npm family's braces expanded first). */
function parseEntries(entries: readonly string[], kind: WorkspaceKind): Pattern[] {
  const out: Pattern[] = [];
  for (const entry of entries) {
    for (const e of kind === "deno" ? [entry] : expandBraces(entry)) {
      const p = parseEntry(e, kind);
      if (p) out.push(p);
    }
  }
  return out;
}

/** Whether a wildcard may match the directory name `name`. */
function wildcardMay(name: string, dot = false): boolean {
  return name !== "node_modules" && (dot || !name.startsWith("."));
}

/** Whether `seg` (not `**`) matches the one name `name`. */
function segmentMatches(seg: Segment, name: string): boolean {
  if (seg.kind === "literal") return seg.name === name;
  if (seg.kind === "glob") return wildcardMay(name, seg.dot) && seg.re.test(name);
  return false;
}

/** Whether `segments` match the path `parts` (both relative to the root). */
function matchParts(segments: readonly Segment[], parts: readonly string[]): boolean {
  if (segments.length === 0) return parts.length === 0;
  const [seg, ...rest] = segments;
  if (seg.kind === "globstar") {
    for (let i = 0; i <= parts.length; i++) {
      if (i > 0 && !wildcardMay(parts[i - 1])) return false;
      if (matchParts(rest, parts.slice(i))) return true;
    }
    return false;
  }
  return parts.length > 0 && segmentMatches(seg, parts[0]) && matchParts(rest, parts.slice(1));
}

/** `rel` (root-relative, either separator) as path segments; null for the root or outside it. */
function partsOf(rel: string): string[] | null {
  const norm = normalize(rel.replaceAll("\\", "/") || ".").replaceAll("\\", "/");
  if (norm === "." || norm === ".." || norm.startsWith("../") || isAbsolute(norm)) return null;
  return norm.replace(/\/+$/, "").split("/");
}

/** Whether a negated entry excludes `parts` (Deno: only directories a glob entry found). */
function excluded(patterns: readonly Pattern[], parts: readonly string[]): boolean {
  return patterns.some((p) => p.negated && matchParts(p.segments, parts));
}

/**
 * Whether the member list `entries` selects the root-relative directory `rel`, by the patterns
 * alone (no file system: the directory need not exist yet, and its manifest is not checked) —
 * what `denext generate app` asks before it lists a new app.
 *
 * @param entries The list's entries.
 * @param rel A directory relative to the workspace root (`apps/admin`).
 * @param kind Whose rules the list follows.
 */
export function workspaceSelects(
  entries: readonly string[],
  rel: string,
  kind: WorkspaceKind,
): boolean {
  const parts = partsOf(rel);
  if (!parts) return false;
  const patterns = parseEntries(entries, kind);
  for (const p of patterns) {
    if (p.negated || !matchParts(p.segments, parts)) continue;
    if (kind === "deno" && !p.glob) return true;
    if (!excluded(patterns, parts)) return true;
  }
  return false;
}

/** `Deno.realPathSync`, or null when the path is missing or unreadable. */
function realPath(path: string): string | null {
  try {
    return Deno.realPathSync(path);
  } catch {
    return null;
  }
}

/** Whether `path` is a directory (following a symlink), never throwing. */
function isDir(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

/** Whether `dir` holds one of `names` as a file. */
function holdsManifest(dir: string, names: readonly string[]): boolean {
  return names.some((n) => {
    try {
      return Deno.statSync(join(dir, n)).isFile;
    } catch {
      return false;
    }
  });
}

/** A directory's entries, or none when it can't be read. */
function entriesOf(dir: string): Deno.DirEntry[] {
  try {
    return [...Deno.readDirSync(dir)];
  } catch {
    return [];
  }
}

/** What a glob walk needs at every step. */
interface Walk {
  readonly kind: WorkspaceKind;
  readonly found: Set<string>;
}

/**
 * The subdirectories of `dir` a wildcard may step into, each with whether it is a symlink:
 * Deno's wildcards skip a symlinked directory, the npm family's take one (but `**` never
 * descends through it).
 */
function childDirs(w: Walk, dir: string): { name: string; path: string; link: boolean }[] {
  const out: { name: string; path: string; link: boolean }[] = [];
  for (const e of entriesOf(dir)) {
    const path = join(dir, e.name);
    const link = e.isSymlink;
    const usable = link ? w.kind !== "deno" && isDir(path) : e.isDirectory;
    if (usable) out.push({ name: e.name, path, link });
  }
  return out;
}

/** `**` at `segments[0]`: no segment, or one more directory with `**` still to match. */
function walkGlobstar(w: Walk, dir: string, segments: readonly Segment[]): void {
  const rest = segments.slice(1);
  walk(w, dir, rest);
  for (const c of childDirs(w, dir)) {
    if (wildcardMay(c.name)) walk(w, c.path, c.link ? rest : segments);
  }
}

/** The directories under `dir` that `segments` match, walking the file system. */
function walk(w: Walk, dir: string, segments: readonly Segment[]): void {
  if (segments.length === 0) {
    w.found.add(dir);
    return;
  }
  const [seg, ...rest] = segments;
  if (seg.kind === "globstar") return walkGlobstar(w, dir, segments);
  if (seg.kind === "literal") {
    const next = join(dir, seg.name);
    if (isDir(next)) walk(w, next, rest);
    return;
  }
  for (const c of childDirs(w, dir)) if (segmentMatches(seg, c.name)) walk(w, c.path, rest);
}

/** Whether `path` is strictly below `root` (both real paths). */
function strictlyWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + SEPARATOR) && !isAbsolute(rel);
}

/**
 * The directories a glob pattern matches that are members: not excluded by a `!` entry, holding
 * the tool's manifest, and with a real path inside the root.
 */
function globMembers(root: string, p: Pattern, patterns: readonly Pattern[], kind: WorkspaceKind) {
  const realRoot = realPath(root);
  const w: Walk = { kind, found: new Set() };
  walk(w, root, p.segments);
  return [...w.found].sort().filter((dir) => {
    if (excluded(patterns, relative(root, dir).split(SEPARATOR))) return false;
    if (!holdsManifest(dir, MANIFESTS[kind])) return false;
    const real = realPath(dir);
    return realRoot !== null && real !== null && strictlyWithin(realRoot, real);
  });
}

/**
 * The member directories a workspace list names, as the tool `kind` reads it (see the module
 * comment): absolute and de-duplicated, in list order (each glob's matches sorted), none outside
 * `root` and never `root` itself. A Deno path entry (no glob) is kept as written, existing or
 * not (Deno reports a missing one), while a glob names only directories that hold the tool's
 * manifest, and none whose real path leaves the root.
 *
 * @param root The workspace root directory.
 * @param entries The list's entries (`["./apps/*", "packages/**", "!packages/legacy"]`).
 * @param kind Whose rules the list follows.
 * @returns The member directories.
 */
export function expandWorkspaceMembers(
  root: string,
  entries: readonly string[],
  kind: WorkspaceKind,
): string[] {
  const patterns = parseEntries(entries, kind);
  const out = new Set<string>();
  for (const p of patterns) {
    if (p.negated) continue;
    const dirs = kind === "deno" && !p.glob
      ? [join(root, ...p.segments.map((s) => (s as { name: string }).name))]
      : globMembers(root, p, patterns, kind);
    for (const dir of dirs) out.add(dir);
  }
  return [...out];
}
