// `denext codemod` — rewrite a Next.js app's SOURCE imports to native denext.
//
// Where `denext migrate` writes a deno.json that ALIASES `next/*`/`react` to denext
// (a drop-in that leans on the compat layer), the codemod edits the app's own files
// so they import from `denext` directly — turning a drop-in into a native denext app
// with no reliance on the alias for the app's own code.
//
// It rewrites `import`/`export … from` statements, side-effect imports, and the
// specifier of a `require(…)` / dynamic `import(…)` call; it never touches runtime
// logic. A default-component or shape-changing specifier seen in call form, and any
// unmapped `next/*` subpath, are reported as warnings for a human to review — nothing
// is silently dropped.

import { join, relative } from "@std/path";

/** A single specifier rewrite, preserving the import clause. The react-family keys
 * are the canonical `REACT_FAMILY_CORE` set (see `./react-specifiers.ts`);
 * `tests/react-specifiers.test.ts` guards against drift. */
export const SPEC_REWRITE: Record<string, string> = {
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

/** Specifiers that can't be mechanically rewritten — warn instead (App Router). */
const WARN_SPEC: Record<string, string> = {
  "next/router":
    "Pages Router (next/router) — this is a pages/ app; migrate with `denext migrate` " +
    "(it wires the @denext/pages-router plugin), or run the codemod inside a pages/ project.",
  "next/head":
    "next/head is Pages Router — App Router uses the metadata export or <head> in a layout.",
  "next/app": "next/app is a Pages Router file — App Router uses app/layout.tsx.",
  "next/document": "next/document is a Pages Router file — App Router uses app/layout.tsx.",
  // Remix imports aren't a mechanical import-remap: the route tree + loader/action data
  // model must be transformed. Point the user at the dedicated assisted migration.
  "@remix-run/react":
    "Remix import — run `denext migrate --from remix` to transform the route tree and " +
    "invert loaders/actions (Link/useParams map to denext; useLoaderData is inlined).",
  "@remix-run/node":
    "Remix server helper — `denext migrate --from remix` scaffolds the data model " +
    "(redirect → denext; json() → a plain value in a Server Component).",
};

// --- Pages Router mode -------------------------------------------------------
// When the project has a `pages/` tree, its Next Pages Router imports resolve to
// the `@denext/pages-router` plugin's compat modules instead of App Router denext.

/** Pages Router specifier rewrites (named/default-preserving). */
const PAGES_SPEC_REWRITE: Record<string, string> = {
  "next/router": "@denext/pages-router/router", // useRouter, RouterContext, …
  "next/head": "@denext/pages-router/head", // default `Head`
};
/** Pages Router default-import components → named plugin imports. */
const PAGES_DEFAULT_COMPONENT: Record<string, { target: string; name: string }> = {
  "next/link": { target: "@denext/pages-router/link", name: "Link" },
};
/** Pages Router special files the plugin owns — rare as imports; warn, don't rewrite. */
const PAGES_WARN_SPEC: Record<string, string> = {
  "next/document": "next/document (_document.tsx) is handled by the @denext/pages-router plugin; " +
    'import { Html, Head, Main, NextScript } from "@denext/pages-router/document" if you need them.',
  "next/app":
    "next/app (_app.tsx) is handled by the @denext/pages-router plugin; the file works as-is.",
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
// Call-form module reference: `require("spec")` or a dynamic `import("spec")`.
// The `(?<![.\w$])` guard rejects a member/identifier that merely ends in the
// keyword (`foo.import(...)`, `reimport(...)`), and the leading paren distinguishes
// a dynamic `import(...)` from a static side-effect `import "..."`.
const CALL_RE = /(?<![.\w$])(require|import)\s*\(\s*(["'])([^"']+)\2\s*\)/g;

/** Specifier prefixes whose unmapped subpaths are worth flagging (not the bare root). */
const NEXTISH_SUBPATH = /^(next|next-intl)\//;

/** Options for {@linkcode rewriteSource}. */
export interface RewriteOptions {
  /**
   * The project has a `pages/` tree: rewrite Pages Router imports
   * (`next/router`, `next/head`, `next/link`) to the `@denext/pages-router`
   * plugin's compat modules instead of App Router denext.
   */
  pagesRouter?: boolean;
}

/** The per-file rewrite state: the active spec maps and the collected rewrites/warnings. */
interface RewriteCtx {
  rewrites: Rewrite[];
  warnings: Warning[];
  specRewrite: Record<string, string>;
  defaultComponent: Record<string, { target: string; name: string }>;
  warnSpec: Record<string, string>;
}

function createRewriteCtx(options: RewriteOptions): RewriteCtx {
  // In a Pages Router project, the plugin's compat maps take precedence.
  const pages = options.pagesRouter === true;
  return {
    rewrites: [],
    warnings: [],
    specRewrite: pages ? { ...SPEC_REWRITE, ...PAGES_SPEC_REWRITE } : SPEC_REWRITE,
    defaultComponent: pages
      ? { ...DEFAULT_COMPONENT, ...PAGES_DEFAULT_COMPONENT }
      : DEFAULT_COMPONENT,
    warnSpec: pages ? PAGES_WARN_SPEC : WARN_SPEC,
  };
}

/** Record one warning per specifier. */
function warn(ctx: RewriteCtx, specifier: string, message: string): void {
  if (ctx.warnings.some((w) => w.specifier === specifier)) return;
  ctx.warnings.push({ specifier, message });
}

/**
 * Flag a `next/*`/`next-intl/*` subpath the codemod left untouched: it still resolves
 * through the `next/*` compat alias `denext migrate` writes, but it was not converted to
 * a native denext import (nothing silently vanishes).
 */
function warnUnmappedNextish(ctx: RewriteCtx, spec: string): void {
  if (!NEXTISH_SUBPATH.test(spec)) return;
  if (ctx.specRewrite[spec] || ctx.defaultComponent[spec] || ctx.warnSpec[spec]) return;
  warn(
    ctx,
    spec,
    `${spec} has no native denext equivalent — left as-is (it resolves through the ` +
      `\`next/*\` compat alias). Port it by hand if you want a native import.`,
  );
}

/** Default-export component (`next/link` → `{ Link }`) → a named denext import. */
function rewriteDefaultComponent(
  ctx: RewriteCtx,
  kind: "import" | "export",
  c: Clause,
  spec: string,
  comp: { target: string; name: string },
): string {
  if (c.default) {
    const local = c.default;
    c.named.unshift({
      name: comp.name,
      alias: local === comp.name ? null : local,
      typeOnly: false,
    });
    c.default = null;
  }
  ctx.rewrites.push({ from: spec, to: comp.target, note: `default import → { ${comp.name} }` });
  return build(kind, c, comp.target);
}

/**
 * A default `React` import has no denext equivalent — convert it to a namespace so
 * `React.foo` still resolves. `import React, { useState }` becomes two statements (a `*`
 * and a `{}` clause can't be combined); a mixed default + namespace import is flagged.
 * Returns the statement(s), or null to fall through to the plain rewrite.
 */
function rewriteReactDefault(
  ctx: RewriteCtx,
  kind: "import" | "export",
  c: Clause,
  target: string,
  indent: string,
): string | null {
  const name = c.default!;
  c.default = null;
  if (c.namespace) {
    warn(ctx, "react", `mixed default + namespace React import — review \`${name}\` by hand.`);
    return null;
  }
  c.namespace = name;
  if (c.named.length === 0) return null;
  const named = build(kind, { ...c, namespace: null }, target);
  const ns = build(kind, { ...c, named: [] }, target);
  ctx.rewrites.push({ from: "react", to: target, note: "default React → namespace" });
  return indent + ns + ";\n" + indent + named;
}

/** Rewrite one static `import … from "spec"` / `export … from "spec"` statement. */
function rewriteImportStatement(
  ctx: RewriteCtx,
  full: string,
  indent: string,
  kind: "import" | "export",
  typeOnly: boolean,
  clauseStr: string,
  spec: string,
): string {
  if (ctx.warnSpec[spec]) {
    warn(ctx, spec, ctx.warnSpec[spec]);
    return full;
  }
  const comp = ctx.defaultComponent[spec];
  if (comp) {
    return indent +
      rewriteDefaultComponent(ctx, kind, parseClause(clauseStr, typeOnly), spec, comp);
  }
  const target = ctx.specRewrite[spec];
  if (!target) {
    warnUnmappedNextish(ctx, spec);
    return full;
  }
  const c = parseClause(clauseStr, typeOnly);
  if (spec === "react" && c.default) {
    const split = rewriteReactDefault(ctx, kind, c, target, indent);
    if (split) return split;
  }
  ctx.rewrites.push({ from: spec, to: target });
  return indent + build(kind, c, target);
}

/** Rewrite a side-effect `import "spec"`. */
function rewriteSideEffect(ctx: RewriteCtx, full: string, indent: string, spec: string): string {
  const target = ctx.specRewrite[spec] ?? ctx.defaultComponent[spec]?.target;
  if (!target) {
    if (ctx.warnSpec[spec]) warn(ctx, spec, ctx.warnSpec[spec]);
    else warnUnmappedNextish(ctx, spec);
    return full;
  }
  ctx.rewrites.push({ from: spec, to: target });
  return `${indent}import "${target}"`;
}

/**
 * `require("spec")` / dynamic `import("spec")`: rewrite the specifier when it's a plain
 * module-identity remap (react → denext), where only the URL changes. A default-export
 * component (next/link → { Link }) or a warn-listed specifier changes the module SHAPE,
 * which can't be expressed inside a call expression — so those are flagged for a human,
 * never silently half-rewritten.
 */
function rewriteCallForm(
  ctx: RewriteCtx,
  full: string,
  kw: string,
  quote: string,
  spec: string,
): string {
  const target = ctx.specRewrite[spec];
  if (target) {
    ctx.rewrites.push({ from: spec, to: target });
    return `${kw}(${quote}${target}${quote})`;
  }
  const comp = ctx.defaultComponent[spec];
  if (comp) {
    warn(
      ctx,
      spec,
      `${kw}("${spec}") — this import's default export maps to the named denext export ` +
        `\`${comp.name}\` from "${comp.target}", which can't be rewritten inside a call. ` +
        `Convert it to a static \`import { ${comp.name} } from "${comp.target}"\` by hand.`,
    );
    return full;
  }
  if (ctx.warnSpec[spec]) warn(ctx, spec, ctx.warnSpec[spec]);
  else warnUnmappedNextish(ctx, spec);
  return full;
}

/**
 * Rewrite one file's `next/*` and `react` imports to native denext imports.
 *
 * @param code The source text.
 * @param options `{ pagesRouter }` to target the Pages Router plugin.
 * @returns The {@linkcode RewriteResult}.
 */
export function rewriteSource(code: string, options: RewriteOptions = {}): RewriteResult {
  const ctx = createRewriteCtx(options);
  let out = code.replace(
    IMPORT_RE,
    (full, indent: string, kind: string, typeKw: string | undefined, clauseStr, spec: string) =>
      rewriteImportStatement(
        ctx,
        full,
        indent,
        kind as "import" | "export",
        Boolean(typeKw),
        clauseStr,
        spec,
      ),
  );
  out = out.replace(
    SIDE_EFFECT_RE,
    (full, indent: string, spec: string) => rewriteSideEffect(ctx, full, indent, spec),
  );
  out = out.replace(
    CALL_RE,
    (full, kw: string, quote: string, spec: string) => rewriteCallForm(ctx, full, kw, quote, spec),
  );
  const { rewrites, warnings } = ctx;
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
  /**
   * Target the Pages Router plugin for `next/router`/`next/head`/`next/link`.
   * Defaults to auto-detection (a `pages/` or `src/pages/` directory).
   */
  pagesRouter?: boolean;
}

/** The summary of a codemod run. */
export interface CodemodReport {
  /** Files that changed (or would change, in a dry run). */
  files: FileReport[];
  /** Number of source files scanned. */
  scanned: number;
  /** Whether changes were written to disk. */
  wrote: boolean;
  /** Whether Pages Router rewrites were applied (a `pages/` project). */
  pagesRouter: boolean;
}

/** Does `dir` hold a Pages Router tree (`pages/` or `src/pages/`)? */
async function hasPagesDir(dir: string): Promise<boolean> {
  for (const p of [join(dir, "pages"), join(dir, "src", "pages")]) {
    try {
      if ((await Deno.stat(p)).isDirectory) return true;
    } catch { /* not present */ }
  }
  return false;
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
 * `{ write: true }` to apply. A `pages/` tree is auto-detected and its Pages
 * Router imports are routed to the `@denext/pages-router` plugin.
 *
 * @param projectDir The project root to scan.
 * @param options `{ write, pagesRouter }` — apply changes / force Pages Router mode.
 * @returns A {@linkcode CodemodReport}.
 */
export async function runCodemod(
  projectDir: string,
  options: CodemodOptions = {},
): Promise<CodemodReport> {
  const files: FileReport[] = [];
  const pagesRouter = options.pagesRouter ?? await hasPagesDir(projectDir);
  const sources = await collectSources(projectDir);
  for (const file of sources) {
    let code: string;
    try {
      code = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    const result = rewriteSource(code, { pagesRouter });
    if (result.rewrites.length === 0 && result.warnings.length === 0) continue;
    if (result.changed && options.write) await Deno.writeTextFile(file, result.code);
    files.push({
      path: relative(projectDir, file),
      rewrites: result.rewrites,
      warnings: result.warnings,
    });
  }
  return { files, scanned: sources.length, wrote: options.write === true, pagesRouter };
}
