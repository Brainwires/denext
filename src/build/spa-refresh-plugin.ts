// SPA-mode Fast Refresh: a per-module esbuild transform.
//
// The App Router gets Fast Refresh for free — denext *generates* its route/Flight
// entry, so it can emit `registerFamily(Component, "url#export")` for every
// route-structural component there (see `generateRouteEntry`/`generateFlightEntry`
// in `build/bundle.ts`). A SPA has no generated entry: the app's own `main.tsx`
// calls `createRoot(el).render(<App/>)`, and its components live in ordinary source
// modules denext never authored. So there is nowhere to hang the registrations.
//
// This plugin supplies them. On the esbuild `onLoad` for each app `.tsx`/`.jsx`
// source, it appends a `registerFamily(Name, "<sourceUrl>#Name")` call for every
// top-level component-shaped declaration (a PascalCase function / class, or a const
// bound to an arrow/function expression). The family id is the **source** file URL —
// stable across rebuilds (the browser cache-busts the entry import, not these baked
// strings) — so a re-imported edit's fresh function ref shares a family with the
// live one, and the reconciler (once `enableFastRefresh()` installs the family seam)
// reconciles the new code onto the existing fiber tree, preserving hook state.
//
// It is dev-only (never added to a production build) and correctness-first: a module
// it can't confidently instrument is loaded unchanged (its components simply
// remount on edit — the pre-refresh behavior), never miscompiled.

import type * as esbuild from "esbuild";
import { toFileUrl } from "@std/path";
import { type Node, swcParse } from "./swc-ast.ts";

/** A PascalCase identifier is the React/JSX signal for a component (vs a hook/helper). */
function isComponentName(name: string | undefined): name is string {
  return typeof name === "string" && /^[A-Z]/.test(name);
}

/** True for an initializer that produces a callable (an arrow or function expression). */
function isCallableInit(init: Node): boolean {
  return !!init &&
    (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression");
}

/**
 * Collect the top-level component-shaped binding names of a parsed module: PascalCase
 * function/class declarations and PascalCase consts bound to an arrow/function
 * expression, whether or not they are `export`ed. Object/value consts are excluded
 * (only callables are components), so a `const Config = {…}` is never registered.
 */
export function collectComponentNames(moduleAst: Node): string[] {
  const names: string[] = [];
  const add = (name: string | undefined) => {
    if (isComponentName(name) && !names.includes(name)) names.push(name);
  };
  const fromDecl = (decl: Node): void => {
    if (!decl || typeof decl !== "object") return;
    switch (decl.type) {
      case "FunctionDeclaration":
      case "ClassDeclaration":
        add(decl.identifier?.value);
        return;
      case "VariableDeclaration":
        for (const d of decl.declarations ?? []) {
          if (d?.id?.type === "Identifier" && isCallableInit(d.init)) add(d.id.value);
        }
        return;
    }
  };
  for (const stmt of moduleAst?.body ?? []) {
    if (!stmt || typeof stmt !== "object") continue;
    if (stmt.type === "ExportDeclaration") fromDecl(stmt.declaration);
    else if (stmt.type === "ExportDefaultDeclaration") add(stmt.decl?.identifier?.value);
    else fromDecl(stmt);
  }
  return names;
}

/** The `registerFamily` import + one registration per component, appended to a module. */
export function refreshFooter(sourceUrl: string, names: string[]): string {
  if (names.length === 0) return "";
  // Alias the import so it can never shadow (or be shadowed by) a user binding named
  // `registerFamily`. The import is idempotent — ESM allows a module to import the
  // same specifier more than once — so a hand-written `denext/client` import is fine.
  const regs = names
    .map((n) => `__dnxRegisterFamily(${n}, ${JSON.stringify(`${sourceUrl}#${n}`)});`)
    .join("\n");
  // Leading blank lines: the source may end without a newline (a registration must
  // not fuse onto a trailing `//` comment or expression).
  return `\n\n/* denext Fast Refresh (dev) */\n` +
    `import { registerFamily as __dnxRegisterFamily } from "denext/client-runtime";\n` +
    regs + "\n";
}

/**
 * A dev-only esbuild plugin that instruments each app source module with Fast
 * Refresh family registrations (see the module header). Registered as an
 * `extraPlugin` so its `onLoad` front-runs the deno-loader's own file load.
 *
 * @param projectDir Absolute app root — only files under it are instrumented (npm
 *   deps under `node_modules`, and the generated `.entries` wrappers, are skipped).
 */
export function spaRefreshPlugin(projectDir: string): esbuild.Plugin {
  return {
    name: "denext-spa-fast-refresh",
    setup(build) {
      build.onLoad({ filter: /\.(tsx|jsx)$/ }, async (args) => {
        // Only the app's own first-party source: skip npm deps and the generated
        // SPA entry wrapper (`.entries/index.tsx`), which has no components and
        // whose `import "file://…main.tsx"` already pulls the real modules in.
        if (
          args.path.includes("/node_modules/") ||
          args.path.includes("/.entries/") ||
          !args.path.startsWith(projectDir)
        ) {
          return null; // let the deno-loader load it unchanged
        }
        let source: string;
        try {
          source = await Deno.readTextFile(args.path);
        } catch {
          return null; // unreadable → defer to the loader (which reports the error)
        }
        // Parse-and-instrument is best-effort: any parse failure leaves the module
        // exactly as written (it still bundles; those components just remount on edit).
        try {
          const parse = await swcParse();
          const ast = await parse(source);
          const names = collectComponentNames(ast);
          if (names.length === 0) return { contents: source, loader: "tsx" };
          return {
            contents: source + refreshFooter(toFileUrl(args.path).href, names),
            loader: "tsx",
          };
        } catch {
          return { contents: source, loader: "tsx" };
        }
      });
    },
  };
}
