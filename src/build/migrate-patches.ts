// `denext migrate`: carry pnpm's and Bun's npm patches into deno.json's `patchedDependencies`.
//
// pnpm declares them in package.json (`pnpm.patchedDependencies`) or pnpm-workspace.yaml
// (`patchedDependencies`, pnpm 10), Bun in package.json (`patchedDependencies`): a key
// (`pkg@1.2.3`, `pkg@^1`, `pkg`) and a patch file, a `diff --git` section per changed file with
// package-relative paths. denext's Deno from runtime 3.0.0-denext.3 applies the same map from
// deno.json whenever it installs the package (`denext patch` registers its own there too), and
// takes the same keys and the same patch form (index lines included). So each patch is copied to
// `patches/npm/<name>+<version>.patch` — its paths made package-relative when the patch names
// them under `node_modules/<pkg>/`, and a `diff --git` line added where a plain unified diff has
// none — and registered under its own key. A patch that adds, deletes, renames a file or changes
// a binary is not carried (the runtime's applier changes existing text files only): it is a review
// item, as is every patch when the pinned runtime doesn't apply them.
//
// Build-time only; every read and write goes through `mfs`, so `migrate --check` writes nothing.

import { parse as parseJsonc } from "@std/jsonc";
import { parse as parseYaml } from "@std/yaml";
import { dirname, join, relative, resolve } from "@std/path";
import { mfs } from "./migrate-io.ts";
import { supportsPatchedDependencies } from "./deno-version.ts";
import { patchFileName, patchRuntime } from "./patches.ts";

/** The package manager a patch was declared for. */
export type PatchSource = "pnpm" | "bun";

/** A patch carried into deno.json's `patchedDependencies` (or to carry, by hand). */
export interface CarriedPatch {
  /** The key, as the package manager had it (`pkg@1.2.3`, `pkg@^1`, `pkg`). */
  readonly key: string;
  /** Who declared it. */
  readonly source: PatchSource;
  /** The package manager's patch file, project-relative. */
  readonly from: string;
  /** The copy the runtime reads, project-relative (`patches/npm/<name>+<version>.patch`). */
  readonly to: string;
  /** Whether its paths were rewritten from `node_modules/<pkg>/…` to package-relative ones. */
  readonly converted: boolean;
}

/** A declared patch that is not carried, and why. */
export interface PatchReview {
  /** The key. */
  readonly key: string;
  /** Who declared it. */
  readonly source: PatchSource;
  /** Its patch file, project-relative. */
  readonly from: string;
  /** Why it is not carried, and what to do. */
  readonly reason: string;
}

/** What {@linkcode carryPackageManagerPatches} did. */
export interface MigratePatchesReport {
  /**
   * `written`: the copies made and deno.json updated; `manual`: the copies made, the entries left
   * to add by hand (a hand-authored deno.json); `unsupported`: the pinned runtime doesn't apply
   * `patchedDependencies`, nothing carried.
   */
  readonly action: "written" | "manual" | "unsupported";
  /** The patches carried. */
  readonly carried: readonly CarriedPatch[];
  /** The patches left for review. */
  readonly review: readonly PatchReview[];
  /** The `patchedDependencies` JSON to add by hand (`manual`). */
  readonly snippet?: string;
  /** What to tell the user, one line each. */
  readonly lines: readonly string[];
}

/** Options for {@linkcode carryPackageManagerPatches}. */
export interface CarryPatchesOptions {
  /** Whether deno.json may be edited (false: a hand-authored one migrate keeps). Default true. */
  readonly edit?: boolean;
  /**
   * The version of denext's Deno that installs the project's npm packages (default: the pinned
   * toolchain's, see `patchRuntime`; `null`: one that doesn't apply `patchedDependencies`).
   */
  readonly runtime?: string | null;
}

/** One declared patch: its key, who declared it and the file's absolute path. */
interface Declared {
  readonly key: string;
  readonly source: PatchSource;
  readonly file: string;
}

/** Where the runtime's copies go, project-relative. */
const RUNTIME_PATCHES_DIR = "patches/npm";

/** A file's text through `mfs`, or null. */
async function readMaybe(path: string): Promise<string | null> {
  try {
    return await mfs.readTextFile(path);
  } catch {
    return null;
  }
}

/** `{ key: file }` entries of a `patchedDependencies` object, files resolved against `base`. */
function entriesOf(value: unknown, source: PatchSource, base: string): Declared[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, file]) =>
    typeof file === "string" && file !== "" ? [{ key, source, file: resolve(base, file) }] : []
  );
}

/** Whether `path` exists (through `mfs`). */
async function present(path: string): Promise<boolean> {
  try {
    await mfs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The nearest `pnpm-workspace.yaml` at or above `dir` (an app inside a pnpm workspace), up to the
 * repository's root (`.git`), or null.
 */
async function pnpmWorkspaceFile(dir: string): Promise<string | null> {
  for (let at = resolve(dir);; at = dirname(at)) {
    const path = join(at, "pnpm-workspace.yaml");
    if (await present(path)) return path;
    if (dirname(at) === at || await present(join(at, ".git"))) return null;
  }
}

/** Every patch the project's package manager declares (package.json, pnpm-workspace.yaml). */
async function declaredPatches(dir: string): Promise<Declared[]> {
  const out: Declared[] = [];
  const pkgText = await readMaybe(join(dir, "package.json"));
  if (pkgText !== null) {
    try {
      const pkg = parseJsonc(pkgText) as Record<string, unknown>;
      const pnpm = pkg.pnpm as Record<string, unknown> | undefined;
      out.push(...entriesOf(pnpm?.patchedDependencies, "pnpm", dir));
      // Top-level `patchedDependencies` is Bun's (pnpm keeps its settings under `pnpm`).
      out.push(...entriesOf(pkg.patchedDependencies, "bun", dir));
    } catch { /* an unparsable package.json: migrate reports it elsewhere */ }
  }
  const yaml = await pnpmWorkspaceFile(dir);
  if (yaml) {
    try {
      const doc = parseYaml(await mfs.readTextFile(yaml)) as Record<string, unknown> | null;
      for (const d of entriesOf(doc?.patchedDependencies, "pnpm", dirname(yaml))) {
        if (!out.some((o) => o.key === d.key)) out.push(d);
      }
    } catch { /* unparsable: nothing declared there */ }
  }
  return out;
}

/** The package name of a key (`pkg@1.2.3`, `@scope/pkg@^2`, `pkg`) and its version part. */
function splitKey(key: string): { name: string; version: string } {
  const at = key.indexOf("@", key.startsWith("@") ? 1 : 0);
  return at === -1
    ? { name: key, version: "" }
    : { name: key.slice(0, at), version: key.slice(at + 1) };
}

/** The copy's file name: `<name>+<version>.patch`, a range made file-name safe. */
function copyName(key: string): string {
  const { name, version } = splitKey(key);
  return patchFileName(name, version === "" ? "any" : version.replace(/[^\w.\-]+/g, "_"));
}

/** A patch converted to the runtime's form, or why it can't be. */
type Converted = { body: string; converted: boolean } | { reason: string };

/** What a header line outside a hunk makes of the patch (a reason it can't be carried, or null). */
function unsupportedHeader(line: string): string | null {
  if (/^(new|deleted) file mode /.test(line)) return "it adds or deletes a file";
  if (/^(rename|copy) (from|to) /.test(line)) return "it renames or copies a file";
  if (line.startsWith("GIT binary patch") || /^Binary files /.test(line)) {
    return "it changes a binary file";
  }
  return null;
}

/** A path from a patch (`a/x`, `b/x`, `x`) made package-relative, and whether it changed. */
function packagePath(raw: string, pkg: string): { path: string; converted: boolean } {
  const path = raw.replace(/^[ab]\//, "");
  const prefix = `node_modules/${pkg}/`;
  return path.startsWith(prefix)
    ? { path: path.slice(prefix.length), converted: true }
    : { path, converted: false };
}

/** The old and new line counts of a hunk header (`@@ -a,b +c,d @@`), or null. */
function hunkCounts(line: string): [number, number] | null {
  const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
  return m ? [Number(m[1] ?? 1), Number(m[2] ?? 1)] : null;
}

/** Whether a hunk body line consumes an old line and a new line. */
function consumes(line: string): [number, number] {
  if (line.startsWith("+")) return [0, 1];
  if (line.startsWith("-")) return [1, 0];
  if (line.startsWith("\\")) return [0, 0]; // "\ No newline at end of file"
  return [1, 1];
}

/** {@linkcode convertPatch}'s progress through a patch. */
interface ConvertState {
  /** The converted lines so far. */
  readonly out: string[];
  /** Whether a path was made package-relative. */
  converted: boolean;
  /** Whether the current file's `diff --git` line has been written. */
  sawGit: boolean;
  /** The old and new lines the current hunk still holds. */
  pending: [number, number];
}

/** Copy one hunk body line, counting it off the hunk. */
function bodyLine(st: ConvertState, line: string): void {
  const [o, n] = consumes(line);
  st.pending = [st.pending[0] - o, st.pending[1] - n];
  st.out.push(line);
}

/** Both paths of a header made package-relative, noting a conversion. */
function headerPaths(st: ConvertState, oldRaw: string, newRaw: string, pkg: string): string[] {
  const a = packagePath(oldRaw, pkg);
  const b = packagePath(newRaw, pkg);
  st.converted ||= a.converted || b.converted;
  return [a.path, b.path];
}

/**
 * One line outside a hunk: a header rewritten (a `---` / `+++` pair consumes two lines), a hunk
 * header started, or why the patch can't be carried.
 */
function headerLine(
  st: ConvertState,
  lines: readonly string[],
  i: number,
  pkg: string,
): { next: number } | { reason: string } {
  const line = lines[i];
  const why = unsupportedHeader(line);
  if (why) return { reason: why };
  const git = /^diff --git (\S+) (\S+)$/.exec(line);
  if (git) {
    const [a, b] = headerPaths(st, git[1], git[2], pkg);
    st.sawGit = true;
    st.out.push(`diff --git a/${a} b/${b}`);
    return { next: i + 1 };
  }
  if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
    const oldRaw = line.slice(4).split("\t")[0];
    const newRaw = lines[i + 1].slice(4).split("\t")[0];
    if (oldRaw === "/dev/null" || newRaw === "/dev/null") {
      return { reason: "it adds or deletes a file" };
    }
    const [a, b] = headerPaths(st, oldRaw, newRaw, pkg);
    if (!st.sawGit) st.out.push(`diff --git a/${a} b/${b}`);
    st.out.push(`--- a/${a}`, `+++ b/${b}`);
    st.sawGit = false;
    return { next: i + 2 };
  }
  st.pending = hunkCounts(line) ?? st.pending;
  st.out.push(line);
  return { next: i + 1 };
}

/**
 * Convert a pnpm / Bun patch to the runtime's form: package-relative paths in every header (a
 * `node_modules/<pkg>/` prefix dropped) and a `diff --git` line before each file's `---` where a
 * plain unified diff has none. Hunk bodies are copied as they are.
 *
 * @param text The patch.
 * @param pkg The package it patches.
 * @returns The converted patch, or why the runtime can't apply it.
 */
export function convertPatch(text: string, pkg: string): Converted {
  const lines = text.split("\n");
  const st: ConvertState = { out: [], converted: false, sawGit: false, pending: [0, 0] };
  for (let i = 0; i < lines.length;) {
    if (st.pending[0] > 0 || st.pending[1] > 0) {
      bodyLine(st, lines[i++]);
      continue;
    }
    const step = headerLine(st, lines, i, pkg);
    if ("reason" in step) return step;
    i = step.next;
  }
  return { body: st.out.join("\n"), converted: st.converted };
}

/** `a/b.patch` relative to `dir`, `/`-separated. */
function rel(dir: string, path: string): string {
  return relative(dir, path).replaceAll("\\", "/");
}

/** Carry each declared patch's copy into `patches/npm/`, or say why not. */
async function copyPatches(
  dir: string,
  declared: readonly Declared[],
): Promise<{ carried: CarriedPatch[]; review: PatchReview[] }> {
  const carried: CarriedPatch[] = [];
  const review: PatchReview[] = [];
  for (const d of declared) {
    const from = rel(dir, d.file);
    const text = await readMaybe(d.file);
    if (text === null) {
      review.push({ ...d, from, reason: `${from} could not be read; add it by hand` });
      continue;
    }
    const result = convertPatch(text, splitKey(d.key).name);
    if ("reason" in result) {
      review.push({
        ...d,
        from,
        reason: `${result.reason}, which the runtime's patchedDependencies can't apply (it ` +
          "changes existing text files only): keep it with the package manager, or record the " +
          "change with `denext patch create`",
      });
      continue;
    }
    const to = `${RUNTIME_PATCHES_DIR}/${copyName(d.key)}`;
    await mfs.mkdir(join(dir, RUNTIME_PATCHES_DIR), { recursive: true });
    await mfs.writeTextFile(join(dir, to), result.body);
    carried.push({ key: d.key, source: d.source, from, to, converted: result.converted });
  }
  return { carried, review };
}

/** deno.json's current `patchedDependencies` (`{}` when none), or null when it can't be parsed. */
function currentEntries(text: string): Record<string, unknown> | null {
  try {
    const parsed = parseJsonc(text) as { patchedDependencies?: Record<string, unknown> } | null;
    return parsed?.patchedDependencies ?? {};
  } catch {
    return null;
  }
}

/**
 * deno.json's `patchedDependencies` with the carried entries (a key it maps to another file is
 * kept, and reviewed): the file written, or null when it can't be edited.
 */
async function registered(
  dir: string,
  carried: readonly CarriedPatch[],
  review: PatchReview[],
): Promise<string | null> {
  const path = join(dir, "deno.json");
  const text = await readMaybe(path);
  const current = text === null ? null : currentEntries(text);
  if (text === null || current === null) return null;
  // comment-preserving, swc-backed: loaded only when there is something to write
  const { setJsonValue } = await import("./json-edit.ts");
  let source = text;
  for (const p of carried) {
    const mapped = current[p.key];
    if (mapped !== undefined && mapped !== p.to) {
      const reason = `deno.json already maps it to ${JSON.stringify(mapped)}, left as is`;
      review.push({ key: p.key, source: p.source, from: p.from, reason });
      continue;
    }
    const edit = await setJsonValue(source, ["patchedDependencies", p.key], p.to);
    if (!edit.ok) return null;
    source = edit.source;
  }
  if (source !== text) await mfs.writeTextFile(path, source);
  return path;
}

/** `pnpm` / `Bun` / `pnpm and Bun` for the patches carried. */
function managers(patches: readonly { source: PatchSource }[]): string {
  const set = [...new Set(patches.map((p) => p.source === "bun" ? "Bun" : "pnpm"))];
  return set.join(" and ");
}

/** The review lines: one per patch left out. */
function reviewLines(review: readonly PatchReview[]): string[] {
  return review.map((r) => `not carried: ${r.key} (${r.from}): ${r.reason}`);
}

/**
 * Carry the project's pnpm / Bun npm patches into deno.json's `patchedDependencies`: each patch
 * copied to `patches/npm/` in the form the runtime reads and registered under its key, so denext's
 * Deno from runtime 3.0.0-denext.3 applies it on install. Only when that runtime installs the
 * project's packages; a patch that adds, deletes or renames a file, or changes a binary one, is a
 * review item. A hand-authored deno.json is not edited: the entries are reported to add by hand.
 *
 * @param dir The project.
 * @param options Whether deno.json may be edited, and the runtime.
 * @returns What was carried and what was not, or null when no patch is declared.
 */
export async function carryPackageManagerPatches(
  dir: string,
  options: CarryPatchesOptions = {},
): Promise<MigratePatchesReport | null> {
  const declared = await declaredPatches(dir);
  if (declared.length === 0) return null;
  const runtime = options.runtime === undefined ? patchRuntime() : options.runtime;
  if (runtime === null || !supportsPatchedDependencies(runtime)) {
    const review = declared.map((d) => ({
      ...d,
      from: rel(dir, d.file),
      reason: "the Deno that installs the packages doesn't apply deno.json's patchedDependencies " +
        "(denext's Deno from runtime 3.0.0-denext.3 does): `denext patch create` records the " +
        "change for denext to apply at boot",
    }));
    return {
      action: "unsupported",
      carried: [],
      review,
      lines: [
        `${declared.length} ${managers(declared)} patch(es) not carried: ` +
        `the runtime ${runtime ?? "(not denext's)"} doesn't apply patchedDependencies`,
        ...reviewLines(review),
      ],
    };
  }
  const { carried, review } = await copyPatches(dir, declared);
  const written = carried.length > 0 && options.edit !== false
    ? await registered(dir, carried, review)
    : null;
  const entries = Object.fromEntries(carried.map((p) => [p.key, p.to]));
  const carriedLines = carried.map((p) =>
    `${p.key}: ${p.from} → ${p.to}${p.converted ? " (paths made package-relative)" : ""}`
  );
  if (carried.length === 0 || written) {
    return {
      action: "written",
      carried,
      review,
      lines: [
        carried.length
          ? `deno.json: patchedDependencies for ${carried.length} ${managers(carried)} ` +
            "patch(es), applied by the runtime when it installs the package"
          : `no ${managers(declared)} patch could be carried`,
        ...carriedLines,
        ...reviewLines(review),
      ],
    };
  }
  const snippet = JSON.stringify({ patchedDependencies: entries }, null, 2);
  return {
    action: "manual",
    carried,
    review,
    snippet,
    lines: [
      `${carried.length} ${managers(carried)} patch(es) copied to ${RUNTIME_PATCHES_DIR}/; add ` +
      "them to deno.json by hand:",
      ...snippet.split("\n").map((l) => `  ${l}`),
      ...carriedLines,
      ...reviewLines(review),
    ],
  };
}
