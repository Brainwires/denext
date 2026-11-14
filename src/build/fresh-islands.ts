// `denext migrate --from fresh`: islands a Fresh app registers in code, outside `islands/` and the
// `(_islands)` folders — `app.island(fileOrUrl, exportName, Component)` / `app.islands(…)` in its
// server entry, `builder.registerIsland(specifier)` in a Fresh `dev.ts`, `fresh({
// islandSpecifiers })` in its Vite config, and a Fresh 1.x plugin's `islands: { baseLocation,
// paths }`. On denext an island is a `"use client"` module, so each one becomes one where it is:
//
//   • a module inside the project is marked `"use client"` in place (no move);
//   • a package module (`jsr:`, `npm:`, or a name the import map maps) gets a `"use client"`
//     re-export under `app/_fresh/islands/`, and the import map points the specifier the app
//     imports it by at that module, which itself imports the package by its full specifier.
//
// A package module's export names come from `deno doc` (which parses, never runs, it); an
// `https:` URL island, or one whose exports cannot be read, is reported.

import { dirname, fromFileUrl, isAbsolute, join, relative, resolve } from "@std/path";
import { balancedGroup, literalValue, splitTopLevel } from "./fresh-config-read.ts";
import { mfs } from "./migrate-io.ts";

/** One island a source registers. */
export interface IslandRegistration {
  /** The specifier as written (a path, a `file:` URL, a package specifier). */
  spec: string;
  /** The project-relative file that registered it. */
  from: string;
  /** Resolve a relative `spec` against `from`'s directory (`import.meta.resolve`, `new URL`). */
  relativeToFile: boolean;
  /** The export it names (`app.island(spec, "Counter", Counter)`), when known. */
  exportName?: string;
}

/** The calls that register islands. */
const CALLS = /\.(island|islands|registerIsland)\s*\(/g;

/** The arguments of a call whose `(` is at `open`. */
function callArgs(source: string, open: number): string[] {
  const group = balancedGroup(source, open);
  return group ? splitTopLevel(group.slice(1, -1)) : [];
}

/** A specifier expression's value: a literal, `import.meta.resolve(…)` or `new URL(…, import.meta.url)`. */
function specOf(expr: string): { spec: string; relativeToFile: boolean } | null {
  const lit = literalValue(expr);
  if (typeof lit === "string") return { spec: lit, relativeToFile: false };
  const resolved = /^import\.meta\.resolve\(\s*(["'])([^"']+)\1\s*\)$/.exec(expr);
  if (resolved) return { spec: resolved[2], relativeToFile: true };
  const url = /^new\s+URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)(?:\.href)?$/.exec(expr);
  if (url) return { spec: url[2], relativeToFile: true };
  return null;
}

/** The specifier expressions of one registering call, and the export it names. */
function callSpecs(kind: string, args: string[]): { specs: string[]; exportName?: string } {
  if (kind === "islands") return { specs: args.flatMap(arrayItems) };
  const name = kind === "island" ? literalValue(args[1] ?? "") : undefined;
  return { specs: args.slice(0, 1), ...(typeof name === "string" ? { exportName: name } : {}) };
}

/**
 * The islands a source registers (`app.island(…)`, `app.islands(…)`, `registerIsland(…)`), and
 * the call arguments it could not read.
 *
 * @param rel The project-relative file.
 * @param source Its source.
 * @returns The registrations and the unreadable arguments.
 */
export function islandRegistrations(
  rel: string,
  source: string,
): { found: IslandRegistration[]; unread: string[] } {
  const found: IslandRegistration[] = [];
  const unread: string[] = [];
  for (const m of source.matchAll(CALLS)) {
    const { specs, exportName } = callSpecs(m[1], callArgs(source, m.index + m[0].length - 1));
    for (const expr of specs) {
      const s = specOf(expr);
      if (s) found.push({ ...s, from: rel, ...(exportName ? { exportName } : {}) });
      else unread.push(expr);
    }
  }
  return { found, unread };
}

/** The items of an array literal's text, or the text itself. */
function arrayItems(expr: string): string[] {
  if (!expr.startsWith("[")) return [expr];
  return callArgs(`(${expr.slice(1, -1)})`, 0);
}

/** How the import map resolves a bare specifier (an exact key, or a package / prefix key). */
export function resolveBare(spec: string, imports: Record<string, string>): string | null {
  if (spec in imports) return imports[spec];
  let best: string | null = null;
  for (const key of Object.keys(imports)) {
    const prefix = key.endsWith("/") ? key : `${key}/`;
    const target = imports[key];
    const packageKey = !key.endsWith("/") && /^(?:jsr|npm):/.test(target);
    if (!spec.startsWith(prefix) || (!key.endsWith("/") && !packageKey)) continue;
    if (best === null || key.length > best.length) best = key;
  }
  if (best === null) return null;
  const target = imports[best];
  const rest = spec.slice(best.endsWith("/") ? best.length : best.length + 1);
  return best.endsWith("/") ? target + rest : `${target}/${rest}`;
}

/** The registered islands, sorted into what the migration does with each. */
export interface IslandPlan {
  /** Project-relative modules to mark `"use client"` in place. */
  local: string[];
  /** Package islands: the specifier the app imports, its full specifier, the re-export's name. */
  packages: { key: string; target: string; exportName?: string }[];
  /** Registrations that cannot become islands, with the reason. */
  unsupported: { item: string; reason: string }[];
}

/** Sort `regs` into local modules and package modules (see the module comment). */
export function planIslands(
  dir: string,
  regs: IslandRegistration[],
  imports: Record<string, string>,
): IslandPlan {
  const plan: IslandPlan = { local: [], packages: [], unsupported: [] };
  for (const r of regs) {
    const where = localPath(dir, r, imports);
    if (where !== null) {
      if (where.startsWith("..") || isAbsolute(where)) {
        plan.unsupported.push({
          item: `${r.from}: ${r.spec}`,
          reason: "the island is outside the project; move it into the project",
        });
      } else if (!plan.local.includes(where)) plan.local.push(where);
      continue;
    }
    packageIsland(plan, r, imports);
  }
  return plan;
}

/** A local registration's project-relative path, or null for a package specifier. */
function localPath(
  dir: string,
  r: IslandRegistration,
  imports: Record<string, string>,
): string | null {
  let spec = r.spec;
  if (!/^(?:\.{1,2}\/|\/|file:)/.test(spec)) {
    const mapped = resolveBare(spec, imports);
    if (mapped === null || !/^(?:\.{1,2}\/|\/|file:)/.test(mapped)) {
      // A bare relative path Fresh resolves against the project (`registerIsland("islands/X.tsx")`).
      if (mapped === null && !/^(?:jsr|npm|https?|node):/.test(spec) && /\.[jt]sx?$/.test(spec)) {
        return relative(dir, resolve(dir, spec)).replaceAll("\\", "/");
      }
      return null;
    }
    spec = mapped;
  }
  const base = r.relativeToFile ? dirname(join(dir, r.from)) : dir;
  const abs = spec.startsWith("file:") ? fromFileUrl(spec) : resolve(base, spec);
  return relative(dir, abs).replaceAll("\\", "/");
}

/** A package registration: its full specifier, or an unsupported finding. */
function packageIsland(plan: IslandPlan, r: IslandRegistration, imports: Record<string, string>) {
  if (/^https?:/.test(r.spec)) {
    plan.unsupported.push({
      item: `${r.from}: ${r.spec}`,
      reason: "an island imported by URL: map a name to it in deno.json's imports and import " +
        "and register it by that name, then re-run migrate",
    });
    return;
  }
  const target = /^(?:jsr|npm):/.test(r.spec) ? altSpecifier(r.spec) : resolveBare(r.spec, imports);
  if (target === null) {
    plan.unsupported.push({
      item: `${r.from}: ${r.spec}`,
      reason: "the specifier is not in deno.json's imports; add it, then re-run migrate",
    });
    return;
  }
  if (plan.packages.some((p) => p.key === r.spec)) return;
  plan.packages.push({
    key: r.spec,
    target,
    ...(r.exportName ? { exportName: r.exportName } : {}),
  });
}

/**
 * The same module under a second spelling (`jsr:@a/b` → `jsr:/@a/b`), which the import-map entry
 * for the first does not catch.
 */
function altSpecifier(spec: string): string {
  return spec.replace(/^(jsr|npm):(?!\/)/, "$1:/");
}

/** A file-name-safe slug of a specifier. */
function slug(spec: string): string {
  return spec.replace(/^(?:jsr|npm):\/?/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The module path of a package island's `"use client"` re-export. */
export function islandWrapperPath(key: string): string {
  return `app/_fresh/islands/${slug(key)}.ts`;
}

/**
 * The export names of a package module, read with `deno doc` (parsed, not run), or null when it
 * cannot be read (offline, an unknown specifier).
 *
 * @param dir The app directory (its `deno.json` resolves the specifier).
 * @param target The full specifier.
 * @returns The names (`default` included when it has one).
 */
export async function packageExportNames(dir: string, target: string): Promise<string[] | null> {
  try {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["doc", "--json", target],
      cwd: dir,
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(60_000),
    });
    const out = await cmd.output();
    if (!out.success) return null;
    const json = JSON.parse(new TextDecoder().decode(out.stdout)) as {
      nodes?: Record<
        string,
        { symbols?: { name: string; declarations?: { declarationKind: string }[] }[] }
      >;
    };
    const names = new Set<string>();
    for (const node of Object.values(json.nodes ?? {})) {
      for (const sym of node.symbols ?? []) {
        if (sym.declarations?.some((d) => d.declarationKind === "export")) names.add(sym.name);
      }
    }
    return names.size > 0 ? [...names] : null;
  } catch {
    return null;
  }
}

/** The source of a package island's `"use client"` re-export (every name it exports). */
export function islandWrapperSource(
  header: string,
  key: string,
  target: string,
  names: string[],
): string {
  const named = names.filter((n) => n !== "default");
  const lines = [
    `${header}// The island ${key} (registered in code): a client module re-exporting the package's.`,
    `"use client";`,
    ...(named.length ? [`export { ${named.join(", ")} } from ${JSON.stringify(target)};`] : []),
    ...(names.includes("default") ? [`export { default } from ${JSON.stringify(target)};`] : []),
    "",
  ];
  return lines.join("\n");
}

/** Read the registrations in the app's server entry, `dev.ts` and any other source that makes them. */
export async function scanIslandRegistrations(
  dir: string,
  files: string[],
): Promise<{ found: IslandRegistration[]; unread: { item: string; reason: string }[] }> {
  const found: IslandRegistration[] = [];
  const unread: { item: string; reason: string }[] = [];
  for (const rel of files) {
    const source = await mfs.readTextFile(join(dir, rel)).catch(() => "");
    if (!/\.(?:island|islands|registerIsland)\s*\(/.test(source)) continue;
    const r = islandRegistrations(rel, source);
    found.push(...r.found);
    for (const expr of r.unread) {
      unread.push({
        item: `${rel}: ${expr}`,
        reason: "an island registered by a computed specifier; register it with a string, " +
          'import.meta.resolve("…") or new URL("…", import.meta.url), then re-run migrate',
      });
    }
  }
  return { found, unread };
}
