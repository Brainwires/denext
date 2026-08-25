// Project audit: the engine behind `denext audit`. It turns denext's real zero-npm
// runtime guarantee into machine-checkable evidence for an app — a dependency
// inventory classified by registry, a scan proving the app's own runtime source
// pulls in no npm package (the same resolution the `no-npm-compat-guard` test uses),
// a minimal CycloneDX SBOM, and a conservative least-privilege permission set.
//
// Build-time only; never imported by a shipped bundle.

import { walk } from "@std/fs";
import { join } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";

/** How a dependency's resolved target is classified. */
export type DepKind = "npm" | "jsr" | "node" | "deno" | "http" | "relative" | "unknown";

/** One entry from the project's import map. */
export interface DepComponent {
  /** The import specifier (import-map key). */
  readonly specifier: string;
  /** The resolved target (import-map value). */
  readonly target: string;
  /** Registry classification of the target. */
  readonly kind: DepKind;
}

/** The full audit result for a project. */
export interface AuditReport {
  readonly projectDir: string;
  /** Every import-map entry, classified. */
  readonly deps: DepComponent[];
  /** The subset whose target resolves to npm. */
  readonly npmDeps: DepComponent[];
  /** App source imports that resolve to npm (empty = zero-npm runtime). */
  readonly runtimeNpmOffenders: string[];
  /** A conservative least-privilege `--allow-*` set for serving this app. */
  readonly permissions: string[];
}

/** Directories never scanned for runtime-npm offenders (vendored / generated). */
const SKIP_DIRS = new Set([
  "node_modules",
  ".denext",
  ".git",
  "out",
  "dist",
  "coverage",
  "build",
]);

/** Matches `... from "X"` and `import("X")` with a literal specifier. */
const SPEC_RE = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;

/** Classify an import-map target by its registry prefix. */
function classify(target: string): DepKind {
  if (target.startsWith("npm:")) return "npm";
  if (target.startsWith("jsr:")) return "jsr";
  if (target.startsWith("node:")) return "node";
  if (target.startsWith("http://") || target.startsWith("https://")) return "http";
  if (target.startsWith("./") || target.startsWith("../")) return "relative";
  if (target.startsWith("deno:")) return "deno";
  return "unknown";
}

/** Load a deno.json/deno.jsonc import map (empty when absent). */
async function loadImportMap(path: string): Promise<Record<string, string>> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      // Parse as JSONC (comments + trailing commas) with a real parser — a regex
      // comment-strip would corrupt values containing `//` (e.g. `https://…`).
      const json = parseJsonc(await Deno.readTextFile(join(path, name))) as {
        imports?: Record<string, string>;
      };
      if (json && json.imports) return json.imports;
    } catch { /* try next / none */ }
  }
  return {};
}

/** True when a specifier resolves (directly or via an alias) to `npm:`. */
function resolvesToNpm(spec: string, importMap: Record<string, string>): boolean {
  if (spec.startsWith("npm:")) return true;
  const exact = importMap[spec];
  if (exact) return exact.startsWith("npm:");
  for (const [alias, target] of Object.entries(importMap)) {
    if (alias.endsWith("/") && spec.startsWith(alias)) return target.startsWith("npm:");
  }
  return false;
}

/** Scan the project's own `.ts`/`.tsx` source for imports resolving to npm. */
async function scanRuntimeNpm(
  dir: string,
  importMap: Record<string, string>,
): Promise<string[]> {
  const offenders: string[] = [];
  try {
    for await (
      const entry of walk(dir, {
        exts: [".ts", ".tsx", ".js", ".jsx"],
        skip: [...SKIP_DIRS].map((d) => new RegExp(`[/\\\\]${d}([/\\\\]|$)`)),
      })
    ) {
      if (!entry.isFile) continue;
      const text = await Deno.readTextFile(entry.path);
      for (const m of text.matchAll(SPEC_RE)) {
        if (resolvesToNpm(m[1], importMap)) offenders.push(`${entry.path}: ${m[1]}`);
      }
    }
  } catch { /* unreadable tree — reported as no offenders */ }
  return offenders;
}

/**
 * A conservative least-privilege permission set for serving a denext app: net
 * (serve), read (route modules, config, static assets), write (the on-disk SQLite
 * page cache under `.denext`), and env (`.env` + `PUBLIC_*`). A starting point to
 * tighten, not a guarantee.
 */
function derivePermissions(): string[] {
  return ["--allow-net", "--allow-read", "--allow-write", "--allow-env"];
}

/** Audit the project at `dir`: inventory deps, prove zero-npm runtime, derive perms. */
export async function auditProject(dir: string): Promise<AuditReport> {
  const importMap = await loadImportMap(dir);
  const deps: DepComponent[] = Object.entries(importMap)
    .map(([specifier, target]) => ({ specifier, target, kind: classify(target) }))
    .sort((a, b) => a.specifier.localeCompare(b.specifier));
  const npmDeps = deps.filter((d) => d.kind === "npm");
  const runtimeNpmOffenders = await scanRuntimeNpm(dir, importMap);
  return {
    projectDir: dir,
    deps,
    npmDeps,
    runtimeNpmOffenders,
    permissions: derivePermissions(),
  };
}

/**
 * A minimal CycloneDX 1.5 SBOM for the audited dependency inventory. Each import-map
 * entry becomes a component; the registry classification maps to a PURL-ish `purl`.
 */
export function toCycloneDx(report: AuditReport): unknown {
  const purlType: Record<DepKind, string> = {
    npm: "npm",
    jsr: "jsr",
    node: "deno",
    deno: "deno",
    http: "generic",
    relative: "generic",
    unknown: "generic",
  };
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: { type: "application", name: report.projectDir.split("/").pop() || "app" },
      tools: [{ vendor: "denext", name: "denext audit" }],
    },
    components: report.deps.map((d) => ({
      type: "library",
      name: d.specifier,
      purl: `pkg:${purlType[d.kind]}/${encodeURIComponent(d.target)}`,
      properties: [{ name: "denext:kind", value: d.kind }],
    })),
  };
}
