// `denext patch` — patch-package for denext, denext itself included.
//
// A patch is a unified diff in `patches/<name>+<version>.patch` (patch-package's file
// convention; a scoped package is `@scope+name+1.2.3.patch`). Two kinds of target:
//
//   • an npm package: the diff is against the files in `node_modules/<pkg>` (pristine copies
//     come from Deno's npm cache, populated on demand). `applyPatches` writes the patched
//     files into the app's own `node_modules` tree at boot (`dev`/`build`/`start`/`export`),
//     idempotently — that tree is per-project under `nodeModulesDir: "auto"|"manual"`, and
//     it is where both Deno (SSR) and esbuild (compat bundles) read the package from.
//   • denext (`denext+<version>.patch`, name `denext`): the diff is against the framework's
//     own sources as installed (JSR or a local checkout). It reaches the app two ways:
//       – natively: each patched file is materialized into `patches/denext/<rel>` (its
//         relative imports absolutized to the framework root, since the copy lives elsewhere)
//         and the app's `deno.json` import map maps the file's FULL URL
//         (`https://jsr.io/@denext/denext/<v>/src/…`) to that copy — Deno applies import maps
//         to the resolved URL of a relative import inside a JSR package, so a single file of
//         the published framework is overridden without vendoring the package;
//       – in the compat runtime prebuild (esbuild + the deno loader, which reads framework
//         sources itself): {@link patchPlugin} applies the same diff in memory on load.
//
// Editing denext: `denext patch edit denext src/server/document.ts` writes a plain working
// copy to `patches/.work/denext/…`; `denext patch create denext` diffs the working copies
// against pristine, writes the patch and materializes it.

import type { Plugin } from "esbuild";
import { walk } from "@std/fs";
import { dirname, fromFileUrl, isAbsolute, join, relative, resolve } from "@std/path";
import { frameworkRootUrl, minDepAgeArgs, readFrameworkJson } from "./bundle.ts";
import {
  applyFileDiff,
  createUnifiedDiff,
  type FileDiff,
  fileDiffApplies,
  parseUnifiedDiff,
  reverseFileDiff,
} from "./patch-diff.ts";
import { absolutizeSpecifiers, applyEdits, type Edit, parseModule } from "./swc-ast.ts";

/** The project-relative directory patches live in. */
const PATCHES_DIR = "patches";
/** The patch name that targets the framework itself. */
export const DENEXT_PATCH_NAME = "denext";
/** Under `patches/`: the editable working copies of framework files. */
const WORK_DIR = ".work";
/** Under `patches/`: the materialized (import-map-referenced) framework files. */
const MATERIALIZED_DIR = "denext";
/** The import-map value prefix that marks an entry as managed by `denext patch`. */
const MANAGED_PREFIX = `./${PATCHES_DIR}/${MATERIALIZED_DIR}/`;

/** One patch file on disk. */
export interface PatchEntry {
  /** The package name (`left-pad`, `@scope/name`) or `denext`. */
  name: string;
  /** The version the patch was made against. */
  version: string;
  /** Absolute path of the `.patch` file. */
  file: string;
  /** What it targets. */
  kind: "denext" | "npm";
}

/** Seams for tests and for a framework served from elsewhere; every field has a default. */
export interface PatchOptions {
  /** The framework root URL (default: the running framework's). */
  frameworkRoot?: string;
  /** The framework version (default: read from the framework's `deno.json`). */
  frameworkVersion?: string;
  /** Where a pristine copy of `pkg@version` lives (default: Deno's npm cache, populated on demand). */
  npmPristine?: (pkg: string, version: string) => Promise<string>;
  /** Progress/warning sink (default: `console.warn`). */
  log?: (line: string) => void;
}

/** `left-pad` @ `1.3.0` → `left-pad+1.3.0.patch`; `@scope/name` → `@scope+name+1.2.3.patch`. */
export function patchFileName(name: string, version: string): string {
  return `${name.replace("/", "+")}+${version}.patch`;
}

/** The inverse of {@link patchFileName}, or null for a file that isn't one. */
export function parsePatchFileName(base: string): { name: string; version: string } | null {
  const m = base.match(/^(.+)\+([^+]+)\.patch$/);
  if (!m) return null;
  const name = m[1].startsWith("@") ? m[1].replace("+", "/") : m[1];
  if (name.includes("+")) return null;
  return { name, version: m[2] };
}

/** Every patch under `<projectDir>/patches/`, sorted by file name. */
export async function listPatches(projectDir: string): Promise<PatchEntry[]> {
  const dir = join(projectDir, PATCHES_DIR);
  const out: PatchEntry[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile) continue;
      const parsed = parsePatchFileName(e.name);
      if (!parsed) continue;
      out.push({
        ...parsed,
        file: join(dir, e.name),
        kind: parsed.name === DENEXT_PATCH_NAME ? "denext" : "npm",
      });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** The patch whose name or 1-based list index is `ref`, or null. */
export async function findPatch(projectDir: string, ref: string): Promise<PatchEntry | null> {
  const all = await listPatches(projectDir);
  if (/^\d+$/.test(ref)) return all[Number(ref) - 1] ?? null;
  return all.find((p) => p.name === ref) ?? null;
}

/** The parsed file diffs of a patch. */
export async function readPatch(entry: PatchEntry): Promise<FileDiff[]> {
  return parseUnifiedDiff(await Deno.readTextFile(entry.file));
}

// ── npm packages ──────────────────────────────────────────────────────────────

/** The installed package directory (symlinks resolved), or a clear error. */
export async function npmPackageDir(projectDir: string, pkg: string): Promise<string> {
  const path = join(projectDir, "node_modules", ...pkg.split("/"));
  try {
    return await Deno.realPath(path);
  } catch {
    throw new Error(
      `denext patch: "${pkg}" is not installed in ${
        relative(projectDir, path) || "."
      } — patches need a node_modules directory (\`nodeModulesDir: "auto"\` or "manual"; ` +
        `run \`deno install\` first)`,
    );
  }
}

async function packageVersion(dir: string): Promise<string> {
  const pkg = JSON.parse(await Deno.readTextFile(join(dir, "package.json")));
  return String(pkg.version ?? "0.0.0");
}

/** Deno's cache dir (`deno info --json`), memoized. */
let denoDirPromise: Promise<string> | undefined;
function denoDir(): Promise<string> {
  return denoDirPromise ??= (async () => {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["info", "--json"],
      stdout: "piped",
      stderr: "null",
    }).output();
    return String(JSON.parse(new TextDecoder().decode(out.stdout)).denoDir);
  })();
}

/**
 * A pristine copy of `pkg@version` from Deno's npm cache
 * (`$DENO_DIR/npm/registry.npmjs.org/<pkg>/<version>`), fetched with `deno cache` when absent.
 */
async function npmPristineDir(pkg: string, version: string): Promise<string> {
  const dir = join(await denoDir(), "npm", "registry.npmjs.org", ...pkg.split("/"), version);
  if (await exists(join(dir, "package.json"))) return dir;
  const spec = `npm:${pkg}@${version}`;
  const res = await new Deno.Command(Deno.execPath(), {
    args: ["cache", "--node-modules-dir=none", ...minDepAgeArgs(), spec],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!res.success || !(await exists(join(dir, "package.json")))) {
    throw new Error(
      `denext patch: could not fetch a pristine ${spec} into Deno's cache:\n` +
        new TextDecoder().decode(res.stderr).trim(),
    );
  }
  return dir;
}

/** Text files of a package dir (relative paths), skipping nested node_modules and binaries. */
async function packageTextFiles(dir: string): Promise<string[]> {
  const rels: string[] = [];
  for await (const e of walk(dir, { includeDirs: false })) {
    const rel = relative(dir, e.path).replace(/\\/g, "/");
    // Nested installs and bin shims are not the package's own sources.
    if (/^(?:node_modules|\.bin)\//.test(rel) || rel.includes("/node_modules/")) continue;
    if (await isTextFile(e.path)) rels.push(rel);
  }
  return rels.sort();
}

async function isTextFile(path: string): Promise<boolean> {
  const f = await Deno.open(path);
  try {
    const buf = new Uint8Array(512);
    const n = await f.read(buf);
    return !buf.subarray(0, n ?? 0).includes(0);
  } finally {
    f.close();
  }
}

async function readOr(path: string, fallback: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return fallback;
  }
}

/** What {@link createNpmPatch}/{@link createDenextPatch} produced. */
export interface CreatedPatch {
  /** The `.patch` file written. */
  file: string;
  /** The files that differ (package-relative). */
  files: string[];
}

/**
 * Diff the installed `node_modules/<pkg>` against its pristine copy and write
 * `patches/<pkg>+<version>.patch`. Throws when nothing differs.
 */
export async function createNpmPatch(
  projectDir: string,
  pkg: string,
  opts: PatchOptions = {},
): Promise<CreatedPatch> {
  const installed = await npmPackageDir(projectDir, pkg);
  const version = await packageVersion(installed);
  const pristine = await (opts.npmPristine ?? npmPristineDir)(pkg, version);
  const root = `node_modules/${pkg}/`;
  const diffs: string[] = [];
  const files: string[] = [];
  for (const rel of await packageTextFiles(installed)) {
    const before = await readOr(join(pristine, rel), "");
    const after = await Deno.readTextFile(join(installed, rel));
    const diff = createUnifiedDiff(before, after, `a/${root}${rel}`, `b/${root}${rel}`);
    if (diff === "") continue;
    diffs.push(diff);
    files.push(rel);
  }
  if (diffs.length === 0) {
    throw new Error(`denext patch: node_modules/${pkg}@${version} has no changes to record`);
  }
  const file = await writePatchFile(projectDir, pkg, version, diffs.join(""));
  return { file, files };
}

async function writePatchFile(
  projectDir: string,
  name: string,
  version: string,
  body: string,
): Promise<string> {
  const dir = join(projectDir, PATCHES_DIR);
  await Deno.mkdir(dir, { recursive: true });
  // One patch per package: a re-create against a new version replaces the old file.
  for (const old of await listPatches(projectDir)) {
    if (old.name === name && old.version !== version) await Deno.remove(old.file);
  }
  const file = join(dir, patchFileName(name, version));
  await Deno.writeTextFile(file, body);
  return file;
}

/** The outcome of applying one patch. */
export type ApplyOutcome = "applied" | "already-applied";

/**
 * Apply an npm patch to the app's `node_modules` (idempotent: a file the patch already
 * transformed is recognized by its reverse applying cleanly and left alone). Warns on a
 * version mismatch; throws naming the hunk when one no longer applies.
 */
/**
 * Resolve a patch's target path and refuse anything outside `root` — a `+++ b/../../x` header
 * (or an absolute path) must never write outside the package the patch names. Patches run
 * automatically at boot, so a hostile patch in a cloned repo is an arbitrary-file write.
 */
function containedPath(root: string, rel: string, what: string): string {
  const target = resolve(root, rel);
  const inside = relative(root, target);
  if (isAbsolute(rel) || inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`denext patch: ${what} names ${JSON.stringify(rel)}, outside its package`);
  }
  return target;
}

/** The absolute target of one file diff, contained to the npm package the entry names. */
function npmPatchTarget(projectDir: string, entry: PatchEntry, newPath: string): string {
  const root = join(projectDir, "node_modules", ...entry.name.split("/"));
  return containedPath(root, relative(root, join(projectDir, newPath)), entry.name);
}

export async function applyNpmPatch(
  projectDir: string,
  entry: PatchEntry,
  opts: PatchOptions = {},
): Promise<ApplyOutcome> {
  const log = opts.log ?? console.warn;
  const installed = await npmPackageDir(projectDir, entry.name);
  const version = await packageVersion(installed);
  if (version !== entry.version) {
    log(
      `denext patch: ${entry.name} is ${version} but the patch was made against ${entry.version} — applying anyway`,
    );
  }
  let outcome: ApplyOutcome = "already-applied";
  for (const diff of await readPatch(entry)) {
    const path = npmPatchTarget(projectDir, entry, diff.newPath);
    const text = await readOr(path, "");
    if (fileDiffApplies(text, reverseFileDiff(diff))) continue; // already patched
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, applyFileDiff(text, diff));
    outcome = "applied";
  }
  return outcome;
}

/** Undo an npm patch in `node_modules` (best effort: a file the reverse doesn't fit is left). */
export async function revertNpmPatch(projectDir: string, entry: PatchEntry): Promise<string[]> {
  const left: string[] = [];
  for (const diff of await readPatch(entry)) {
    const path = npmPatchTarget(projectDir, entry, diff.newPath);
    const text = await readOr(path, "");
    const reverse = reverseFileDiff(diff);
    if (fileDiffApplies(text, reverse)) {
      await Deno.writeTextFile(path, applyFileDiff(text, reverse));
    } else left.push(diff.newPath);
  }
  return left;
}

// ── denext itself ──────────────────────────────────────────────────────────────

async function frameworkVersion(opts: PatchOptions): Promise<string> {
  if (opts.frameworkVersion) return opts.frameworkVersion;
  return String((await readFrameworkJson("deno.json")).version ?? "0.0.0");
}

/** A pristine framework file by project-relative path (`src/server/document.ts`). */
async function pristineFrameworkFile(root: string, rel: string): Promise<string> {
  const url = root + rel;
  if (url.startsWith("file://")) return await Deno.readTextFile(fromFileUrl(url));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`denext patch: could not fetch ${url} (${res.status})`);
  return await res.text();
}

const workPath = (projectDir: string, rel: string) =>
  join(projectDir, PATCHES_DIR, WORK_DIR, MATERIALIZED_DIR, rel);
const materializedPath = (projectDir: string, rel: string) =>
  join(projectDir, PATCHES_DIR, MATERIALIZED_DIR, rel);

/**
 * Prepare a framework file for editing: `patches/.work/denext/<rel>` holds the pristine
 * source (with the current denext patch applied, when one exists). Returns the path;
 * an existing working copy is kept.
 */
export async function editDenextFile(
  projectDir: string,
  rel: string,
  opts: PatchOptions = {},
): Promise<string> {
  const path = workPath(projectDir, rel);
  if (await exists(path)) return path;
  const root = opts.frameworkRoot ?? frameworkRootUrl();
  let text = await pristineFrameworkFile(root, rel);
  const current = (await listPatches(projectDir)).find((p) => p.kind === "denext");
  const diff = current
    ? (await readPatch(current)).find((d) => d.newPath === `${DENEXT_PATCH_NAME}/${rel}`)
    : undefined;
  if (diff) text = applyFileDiff(text, diff);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
  return path;
}

/**
 * Diff every working copy under `patches/.work/denext/` against the pristine framework
 * source, write `patches/denext+<version>.patch`, and materialize it. Throws when nothing
 * differs.
 */
export async function createDenextPatch(
  projectDir: string,
  opts: PatchOptions = {},
): Promise<CreatedPatch> {
  const root = opts.frameworkRoot ?? frameworkRootUrl();
  const version = await frameworkVersion(opts);
  const workDir = join(projectDir, PATCHES_DIR, WORK_DIR, MATERIALIZED_DIR);
  const diffs: string[] = [];
  const files: string[] = [];
  if (await exists(workDir)) {
    for await (const e of walk(workDir, { includeDirs: false })) {
      const rel = relative(workDir, e.path).replace(/\\/g, "/");
      const before = await pristineFrameworkFile(root, rel);
      const after = await Deno.readTextFile(e.path);
      const diff = createUnifiedDiff(before, after, `a/denext/${rel}`, `b/denext/${rel}`);
      if (diff === "") continue;
      diffs.push(diff);
      files.push(rel);
    }
  }
  if (diffs.length === 0) {
    throw new Error(
      `denext patch: no framework changes to record — edit a file first: ` +
        `\`denext patch edit denext <src/…>\` (working copies live in patches/.work/denext/)`,
    );
  }
  const file = await writePatchFile(projectDir, DENEXT_PATCH_NAME, version, diffs.join(""));
  const entry: PatchEntry = { name: DENEXT_PATCH_NAME, version, file, kind: "denext" };
  await materializeDenextPatch(projectDir, entry, opts);
  return { file, files };
}

/** What {@link materializeDenextPatch} wrote. */
interface Materialized {
  /** The framework files now overridden (framework-relative). */
  files: string[];
  /** Whether `deno.json`'s import map was rewritten. */
  importMapChanged: boolean;
}

/**
 * Write each patched framework file to `patches/denext/<rel>` (relative imports
 * absolutized to the framework root) and point the app's import map at it. Warns on a
 * version mismatch; throws naming the hunk when one no longer applies.
 */
async function materializeDenextPatch(
  projectDir: string,
  entry: PatchEntry,
  opts: PatchOptions = {},
): Promise<Materialized> {
  const log = opts.log ?? console.warn;
  const root = opts.frameworkRoot ?? frameworkRootUrl();
  const version = await frameworkVersion(opts);
  if (version !== entry.version) {
    log(
      `denext patch: denext is ${version} but the patch was made against ${entry.version} — applying anyway`,
    );
  }
  const entries = new Map<string, string>();
  const files: string[] = [];
  for (const diff of await readPatch(entry)) {
    const rel = diff.newPath.replace(/^denext\//, "");
    // `rel` is spliced onto the framework root URL and onto the materialized dir: it must be
    // a plain relative path (no `..`, no absolute, no scheme).
    if (isAbsolute(rel) || /^[a-z]+:/i.test(rel) || rel.split(/[\\/]/).includes("..")) {
      throw new Error(`denext patch: framework patch names ${JSON.stringify(rel)}, outside denext`);
    }
    const patched = applyFileDiff(await pristineFrameworkFile(root, rel), diff);
    const out = materializedPath(projectDir, rel);
    await Deno.mkdir(dirname(out), { recursive: true });
    await Deno.writeTextFile(out, await absolutizeImports(patched, root + rel));
    entries.set(root + rel, `${MANAGED_PREFIX}${rel}`);
    files.push(rel);
  }
  const importMapChanged = await updateManagedImports(projectDir, entries);
  return { files, importMapChanged };
}

/**
 * Rewrite a module's relative imports to absolute URLs under its ORIGINAL location. The
 * AST pass handles what swc's TSX parser accepts; TS-only syntax (`<T>x` casts) makes it
 * bail, so a textual pass over the import/export forms covers the rest — and a relative
 * specifier that survives both is an error, not a boot-time "Module not found".
 */
async function absolutizeImports(source: string, moduleUrl: string): Promise<string> {
  let out = source;
  const parsed = await parseModule(source);
  if (parsed) {
    const edits: Edit[] = [];
    if (absolutizeSpecifiers(parsed.ctx, parsed.body, moduleUrl, edits)) {
      out = applyEdits(parsed.ctx.bytes, edits);
    }
  }
  out = out.replace(
    RELATIVE_SPECIFIER,
    (_m, lead: string, quote: string, spec: string) =>
      `${lead}${quote}${new URL(spec, moduleUrl).href}${quote}`,
  );
  const left = out.match(RELATIVE_SPECIFIER);
  if (left) throw new Error(`denext patch: could not absolutize ${left[0].trim()} in ${moduleUrl}`);
  return out;
}

/** `from "./x"`, `import "./x"`, `import("./x")`, `export * from "../x"` — a quoted relative specifier. */
const RELATIVE_SPECIFIER = /((?:\bfrom|\bimport)\s*\(?\s*)(["'])(\.\.?\/[^"'\n]*)\2/g;

/**
 * Replace the managed entries of the app's `deno.json` import map (values under
 * `./patches/denext/`) with `entries`. Returns whether the file changed.
 */
async function updateManagedImports(
  projectDir: string,
  entries: Map<string, string>,
): Promise<boolean> {
  const path = join(projectDir, "deno.json");
  const raw = await readOr(path, "");
  if (raw === "") throw new Error(`denext patch: ${path} not found (deno.jsonc is not supported)`);
  const config = JSON.parse(raw) as { imports?: Record<string, string> };
  const imports = config.imports ?? {};
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(imports)) if (!v.startsWith(MANAGED_PREFIX)) next[k] = v;
  for (const [k, v] of entries) next[k] = v;
  if (JSON.stringify(next) === JSON.stringify(imports)) return false;
  config.imports = next;
  await Deno.writeTextFile(path, JSON.stringify(config, null, 2) + "\n");
  return true;
}

/** Drop the materialized framework files, the working copies, and the managed import-map entries. */
async function removeDenextPatchFiles(projectDir: string): Promise<void> {
  await Deno.remove(join(projectDir, PATCHES_DIR, MATERIALIZED_DIR), { recursive: true })
    .catch(() => {});
  await Deno.remove(join(projectDir, PATCHES_DIR, WORK_DIR), { recursive: true }).catch(() => {});
  if (await exists(join(projectDir, "deno.json"))) {
    await updateManagedImports(projectDir, new Map());
  }
}

// ── Apply-all (boot) + delete ─────────────────────────────────────────────────

/** What {@link applyPatches} did. */
export interface ApplyReport {
  /** Patches applied or refreshed this run (`name@version`). */
  applied: string[];
  /** Patches found already in place (`name@version`). */
  unchanged: string[];
}

/**
 * Apply every patch under `patches/`: npm patches into `node_modules`, the denext patch
 * materialized + import-mapped. Run at the start of `dev`/`build`/`start`/`export`. A patch
 * that no longer applies throws (running unpatched silently would be worse).
 */
export async function applyPatches(
  projectDir: string,
  opts: PatchOptions = {},
): Promise<ApplyReport> {
  const report: ApplyReport = { applied: [], unchanged: [] };
  for (const entry of await listPatches(projectDir)) {
    const label = `${entry.name}@${entry.version}`;
    if (entry.kind === "npm") {
      const outcome = await applyNpmPatch(projectDir, entry, opts);
      (outcome === "applied" ? report.applied : report.unchanged).push(label);
    } else {
      const m = await materializeDenextPatch(projectDir, entry, opts);
      (m.importMapChanged ? report.applied : report.unchanged).push(label);
    }
  }
  return report;
}

/** Remove a patch (by name or index) and undo it: npm files reverted, denext files un-mapped. */
export async function deletePatch(projectDir: string, ref: string): Promise<PatchEntry> {
  const entry = await findPatch(projectDir, ref);
  if (!entry) throw new Error(`denext patch: no patch "${ref}" (see \`denext patch list\`)`);
  if (entry.kind === "npm") {
    const left = await revertNpmPatch(projectDir, entry).catch((err) => {
      console.warn(
        `denext patch: could not revert ${entry.name}: ${err instanceof Error ? err.message : err}`,
      );
      return [] as string[];
    });
    for (const file of left) {
      console.warn(
        `denext patch: ${file} no longer matches the patch — left as is (reinstall to reset it)`,
      );
    }
  } else await removeDenextPatchFiles(projectDir);
  await Deno.remove(entry.file);
  return entry;
}

// ── esbuild: the framework patch in memory ────────────────────────────────────

/** The denext patch as `framework-relative path → diff`, for {@link patchPlugin}. */
export type DenextPatchSet = Map<string, FileDiff>;

/** The project's denext patch, or null when it has none. */
export async function loadDenextPatchSet(projectDir: string): Promise<DenextPatchSet | null> {
  const entry = (await listPatches(projectDir)).find((p) => p.kind === "denext");
  if (!entry) return null;
  const set: DenextPatchSet = new Map();
  for (const diff of await readPatch(entry)) set.set(diff.newPath.replace(/^denext\//, ""), diff);
  return set;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * esbuild plugin: when the deno loader (or esbuild itself) loads a patched framework file —
 * `file` namespace for a checkout, `https` (scheme-less path) for JSR — hand it the
 * patched source instead. Only files under `frameworkRoot` are intercepted.
 */
export function patchPlugin(set: DenextPatchSet, frameworkRoot = frameworkRootUrl()): Plugin {
  const rels = [...set.keys()];
  const filter = new RegExp(`(?:${rels.map(escapeRe).join("|")})$`);
  // esbuild reports REAL paths (macOS: /var → /private/var), so compare against the real root.
  const fileRoot = frameworkRoot.startsWith("file://") ? realDir(fromFileUrl(frameworkRoot)) : null;
  const httpsRoot = frameworkRoot.startsWith("https://")
    ? frameworkRoot.slice("https:".length)
    : null;
  return {
    name: "denext-patch",
    setup(build) {
      for (const namespace of ["file", "https"]) {
        build.onLoad({ filter, namespace }, async (args) => {
          const root = namespace === "file" ? fileRoot : httpsRoot;
          if (!root || !args.path.startsWith(root)) return undefined;
          const rel = args.path.slice(root.length);
          const diff = set.get(rel);
          if (!diff) return undefined;
          const pristine = namespace === "file"
            ? await Deno.readTextFile(args.path)
            : await fetchPristine("https:" + args.path);
          return { contents: applyFileDiff(pristine, diff), loader: loaderFor(rel) };
        });
      }
    },
  };
}

/** `dir` with symlinks resolved and a trailing separator (the dir itself when unresolvable). */
/** Fetch a pristine framework module for the bundle; a non-OK status is an error, never source. */
async function fetchPristine(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`denext patch: could not fetch ${url} (${res.status})`);
  return await res.text();
}

function realDir(dir: string): string {
  try {
    return Deno.realPathSync(dir) + "/";
  } catch {
    return dir;
  }
}

function loaderFor(path: string): "ts" | "tsx" | "js" | "jsx" {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".ts")) return "ts";
  if (path.endsWith(".jsx")) return "jsx";
  return "js";
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
