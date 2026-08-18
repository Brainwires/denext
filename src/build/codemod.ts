// `denext codemod` — rewrite a Next.js app's SOURCE imports to native denext.
//
// Where `denext migrate` writes a deno.json that ALIASES `next/*`/`react` to denext
// (a drop-in that leans on the compat layer), the codemod edits the app's own files
// so they import from `denext` directly — turning a drop-in into a native denext app
// with no reliance on the alias for the app's own code.
//
// It rewrites import/export-from statements only; it never touches runtime logic.
// Anything it can't safely rewrite is reported as a warning for a human to review.

import { join, relative } from "@std/path";

/** A single specifier rewrite, preserving the import clause. */
const SPEC_REWRITE: Record<string, string> = {
  "react": "denext",
  "react-dom": "denext/client",
  "react-dom/client": "denext/client",
  "react-dom/server": "denext/react-dom/server",
  "react/jsx-runtime": "denext/jsx-runtime",
  "react/jsx-dev-runtime": "denext/jsx-dev-runtime",
  "react-is": "denext/react-is",
  // next/navigation's whole surface (redirect/notFound + the client hooks) is on
  // the denext main entry.
  "next/navigation": "denext",
  "next/headers": "denext/server",
  "next/cache": "denext/server",
  // Compat modules denext provides under its own scope.
  "next/font/google": "denext/next/font/google",
  "next/font/local": "denext/next/font/local",
  "next/og": "denext/next/og",
  "next/server": "denext/next/server",
  "next/form": "denext/next/form",
  "next/headers/index": "denext/server",
};

/** Default-export components whose default import becomes a NAMED denext import. */
const DEFAULT_COMPONENT: Record<string, { target: string; name: string }> = {
  "next/link": { target: "denext", name: "Link" },
  "next/image": { target: "denext", name: "Image" },
  "next/script": { target: "denext", name: "Script" },
  "next/dynamic": { target: "denext", name: "dynamic" },
};

/** Specifiers that can't be mechanically rewritten — warn instead. */
const WARN_SPEC: Record<string, string> = {
  "next/router":
    "Pages Router (next/router) — use the @denext/pages-router plugin, not App Router.",
  "next/head":
    "next/head is Pages Router — App Router uses the metadata export or <head> in a layout.",
  "next/app": "next/app is a Pages Router file — App Router uses app/layout.tsx.",
  "next/document": "next/document is a Pages Router file — App Router uses app/layout.tsx.",
};

/** One import edit the codemod made. */
export interface Rewrite {
  /** The original specifier. */
  from: string;
  /** The specifier it was rewritten to. */
  to: string;
  /** A note when the import clause itself changed (e.g. default → named). */
  note?: string;
}

/** Something the codemod couldn't safely handle. */
export interface Warning {
  /** The specifier that triggered the warning. */
  specifier: string;
  /** A human-readable explanation. */
  message: string;
}

/** The result of rewriting one file's source. */
export interface RewriteResult {
  /** The transformed source (identical to the input when nothing changed). */
  code: string;
  /** Whether any edit was made. */
  changed: boolean;
  /** The specifier rewrites applied. */
  rewrites: Rewrite[];
  /** Non-fatal issues for a human to review. */
  warnings: Warning[];
}

/** A parsed import binding. */
interface Clause {
  typeOnly: boolean;
  default: string | null;
  namespace: string | null;
  star: boolean; // `export * from`
  named: { name: string; alias: string | null; typeOnly: boolean }[];
}

/** Split a top-level comma list, ignoring commas inside `{ }`. */
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Parse a named list body (`a, b as c, type d`). */
function parseNamed(body: string): Clause["named"] {
  const out: Clause["named"] = [];
  for (const raw of body.split(",")) {
    let t = raw.trim();
    if (!t) continue;
    let typeOnly = false;
    if (t.startsWith("type ")) {
      typeOnly = true;
      t = t.slice(5).trim();
    }
    const asIdx = t.split(/\s+as\s+/);
    if (asIdx.length === 2) out.push({ name: asIdx[0].trim(), alias: asIdx[1].trim(), typeOnly });
    else out.push({ name: t, alias: null, typeOnly });
  }
  return out;
}

/** Parse an import clause (everything between `import`/`export` and `from`). */
function parseClause(clause: string, typeOnly: boolean): Clause {
  const c: Clause = { typeOnly, default: null, namespace: null, star: false, named: [] };
  const trimmed = clause.trim();
  if (trimmed === "*") {
    c.star = true;
    return c;
  }
  for (const part of splitTop(trimmed)) {
    const p = part.trim();
    if (p.startsWith("{")) {
      c.named = parseNamed(p.replace(/^\{|\}$/g, ""));
    } else if (/^\*\s+as\s+/.test(p)) {
      c.namespace = p.replace(/^\*\s+as\s+/, "").trim();
    } else if (p) {
      c.default = p;
    }
  }
  return c;
}

/** Serialize a named entry back to source. */
function fmtNamed(n: Clause["named"][number]): string {
  const t = n.typeOnly ? "type " : "";
  return n.alias ? `${t}${n.name} as ${n.alias}` : `${t}${n.name}`;
}

/** Rebuild an import/export statement from its parts. */
function build(kind: "import" | "export", c: Clause, spec: string): string {
  const type = c.typeOnly ? "type " : "";
  if (c.star && kind === "export") return `export ${type}* from "${spec}"`;
  const bits: string[] = [];
  if (c.default) bits.push(c.default);
  if (c.namespace) bits.push(`* as ${c.namespace}`);
  if (c.named.length > 0) bits.push(`{ ${c.named.map(fmtNamed).join(", ")} }`);
  if (bits.length === 0) return `${kind} "${spec}"`;
  return `${kind} ${type}${bits.join(", ")} from "${spec}"`;
}

// import/export ... from "spec"  (clause may span lines; excludes quotes so a
// string literal can't be mistaken for a clause).
const IMPORT_RE = /(^[ \t]*)(import|export)\s+(type\s+)?([^;'"]*?)\bfrom\s*["']([^"']+)["']/gm;
// Side-effect import:  import "spec"
const SIDE_EFFECT_RE = /(^[ \t]*)import\s*["']([^"']+)["']/gm;

/**
 * Rewrite one file's `next/*` and `react` imports to native denext imports.
 *
 * @param code The source text.
 * @returns The {@linkcode RewriteResult}.
 */
export function rewriteSource(code: string): RewriteResult {
  const rewrites: Rewrite[] = [];
  const warnings: Warning[] = [];
  const seenWarn = new Set<string>();

  const warn = (specifier: string, message: string) => {
    if (seenWarn.has(specifier)) return;
    seenWarn.add(specifier);
    warnings.push({ specifier, message });
  };

  let out = code.replace(
    IMPORT_RE,
    (full, indent: string, kind: string, typeKw: string | undefined, clauseStr, spec: string) => {
      if (WARN_SPEC[spec]) {
        warn(spec, WARN_SPEC[spec]);
        return full;
      }
      const k = kind as "import" | "export";
      const typeOnly = Boolean(typeKw);

      // Default-export component → named denext import.
      const comp = DEFAULT_COMPONENT[spec];
      if (comp) {
        const c = parseClause(clauseStr, typeOnly);
        if (c.default) {
          const local = c.default;
          c.named.unshift({
            name: comp.name,
            alias: local === comp.name ? null : local,
            typeOnly: false,
          });
          c.default = null;
        }
        rewrites.push({
          from: spec,
          to: comp.target,
          note: `default import → { ${comp.name} }`,
        });
        return indent + build(k, c, comp.target);
      }

      const target = SPEC_REWRITE[spec];
      if (!target) return full;

      const c = parseClause(clauseStr, typeOnly);
      // A default `React` import has no denext equivalent — convert it to a
      // namespace so `React.foo` still resolves.
      if (spec === "react" && c.default) {
        const name = c.default;
        c.default = null;
        if (c.namespace) {
          warn("react", `mixed default + namespace React import — review \`${name}\` by hand.`);
        } else {
          c.namespace = name;
          if (c.named.length > 0) {
            // `import React, { useState }` → two statements (can't combine * and {}).
            const named = build(k, { ...c, namespace: null }, target);
            const ns = build(k, { ...c, named: [] }, target);
            rewrites.push({ from: spec, to: target, note: "default React → namespace" });
            return indent + ns + ";\n" + indent + named;
          }
        }
      }
      rewrites.push({ from: spec, to: target });
      return indent + build(k, c, target);
    },
  );

  out = out.replace(SIDE_EFFECT_RE, (full, indent: string, spec: string) => {
    const target = SPEC_REWRITE[spec] ?? DEFAULT_COMPONENT[spec]?.target;
    if (!target) {
      if (WARN_SPEC[spec]) warn(spec, WARN_SPEC[spec]);
      return full;
    }
    rewrites.push({ from: spec, to: target });
    return `${indent}import "${target}"`;
  });

  return { code: out, changed: rewrites.length > 0, rewrites, warnings };
}

/** Directories never walked (build output, deps, VCS). */
const SKIP_DIRS = new Set([
  "node_modules",
  ".denext",
  ".git",
  "out",
  "dist",
  "build",
  ".next",
  "coverage",
]);
const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/;

/** A per-file entry in a codemod run's report. */
export interface FileReport {
  /** Project-relative path. */
  path: string;
  /** The rewrites applied to this file. */
  rewrites: Rewrite[];
  /** Warnings raised for this file. */
  warnings: Warning[];
}

/** Options for {@linkcode runCodemod}. */
export interface CodemodOptions {
  /** Write changes to disk. When `false` (default), it's a dry run. */
  write?: boolean;
}

/** The summary of a codemod run. */
export interface CodemodReport {
  /** Files that changed (or would change, in a dry run). */
  files: FileReport[];
  /** Number of source files scanned. */
  scanned: number;
  /** Whether changes were written to disk. */
  wrote: boolean;
}

/** Recursively collect source files under `dir`. */
async function collectSources(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(d)];
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory) {
        if (!SKIP_DIRS.has(e.name)) await walk(join(d, e.name));
      } else if (SOURCE_EXT.test(e.name)) {
        out.push(join(d, e.name));
      }
    }
  };
  await walk(dir);
  return out;
}

/**
 * Run the codemod over every source file under `projectDir`, rewriting
 * `next/*`/`react` imports to native denext. A dry run by default; pass
 * `{ write: true }` to apply.
 *
 * @param projectDir The project root to scan.
 * @param options `{ write }` to apply changes.
 * @returns A {@linkcode CodemodReport}.
 */
export async function runCodemod(
  projectDir: string,
  options: CodemodOptions = {},
): Promise<CodemodReport> {
  const files: FileReport[] = [];
  const sources = await collectSources(projectDir);
  for (const file of sources) {
    let code: string;
    try {
      code = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    const result = rewriteSource(code);
    if (result.rewrites.length === 0 && result.warnings.length === 0) continue;
    if (result.changed && options.write) await Deno.writeTextFile(file, result.code);
    files.push({
      path: relative(projectDir, file),
      rewrites: result.rewrites,
      warnings: result.warnings,
    });
  }
  return { files, scanned: sources.length, wrote: options.write === true };
}
