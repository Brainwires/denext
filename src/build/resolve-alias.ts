// `resolveAlias` (denext.config.ts): module aliases for the esbuild bundles, optionally
// importer-sensitive. `{ "react-native": { to: "uniwind/components/web", except: ["uniwind"] } }`
// sends every `react-native` import to `uniwind/components/web` except the ones uniwind's own
// files make (which must reach the real module): what Metro's `resolveRequest` and Vite's
// `resolve.alias` + a custom resolver express, and what a library's own bundler plugin often
// does. Applied ahead of every other resolver on the esbuild paths (SPA and React Native mode,
// the next-compat App Router's client and server bundles) and in `denext dev`'s dependency
// bundles; the target is resolved through the same build, so it gets every other rule (a
// package's `exports`, the platform files of an app module).

import { join, resolve, SEPARATOR } from "@std/path";
import type * as esbuild from "./esbuild/mod.ts";
import type { ResolveAliasConfig } from "../server/config.ts";

/** One alias, normalized: the target and the packages whose own imports keep the original. */
interface AliasRule {
  readonly to: string;
  readonly except: readonly string[];
}

/** The configured aliases, normalized; null when there are none. */
export function aliasRules(
  config: ResolveAliasConfig | undefined,
): ReadonlyMap<string, AliasRule> | null {
  const rules = new Map<string, AliasRule>();
  for (const [spec, value] of Object.entries(config ?? {})) {
    if (typeof value === "string") rules.set(spec, { to: value, except: [] });
    else if (value && typeof value.to === "string") {
      rules.set(spec, { to: value.to, except: [...(value.except ?? [])] });
    }
  }
  return rules.size > 0 ? rules : null;
}

/** Whether `importer` is a file of the installed package `name` (any `node_modules` layout). */
export function isPackageFile(importer: string, name: string): boolean {
  const segments = ["node_modules", ...name.split("/")];
  const needle = SEPARATOR + segments.join(SEPARATOR) + SEPARATOR;
  return importer.includes(needle) ||
    (SEPARATOR !== "/" && importer.includes("/" + segments.join("/") + "/"));
}

/** A regex source matching `text` literally. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** The project module a bare alias target is resolved from (it need not exist). */
const PROJECT_IMPORTER = "__denext_resolve_alias__.js";

/** Marks the re-resolution of an alias target (`pluginData`), so it is not aliased again. */
const REENTRY = "__denextResolveAlias";

/**
 * The esbuild plugin applying `rules` ({@linkcode aliasRules}): an import of a key (exactly) is
 * resolved as its `to` instead, unless the importing file belongs to a package `except` names.
 * A `./` target is a file of the project at `projectDir`; any other is a specifier resolved
 * from the project (a package, a package subpath). Register it ahead of the other resolvers.
 *
 * @param projectDir The project root (a `./` target and a bare one resolve from here).
 * @param rules The aliases.
 */
function resolveAliasPlugin(
  projectDir: string,
  rules: ReadonlyMap<string, AliasRule>,
): esbuild.Plugin {
  const filter = new RegExp(`^(?:${[...rules.keys()].map(literal).join("|")})$`);
  return {
    name: "denext-resolve-alias",
    setup(build) {
      build.onResolve({ filter }, async (args) => {
        if ((args.pluginData as Record<string, unknown> | undefined)?.[REENTRY]) return undefined;
        const rule = rules.get(args.path);
        if (!rule) return undefined;
        if (args.importer && rule.except.some((name) => isPackageFile(args.importer, name))) {
          return undefined;
        }
        const local = rule.to.startsWith("./") || rule.to.startsWith("../");
        const target = local ? resolve(projectDir, rule.to) : rule.to;
        const result = await build.resolve(target, {
          kind: args.kind,
          // A bare target resolves as the app's own import would (the import map applies), also
          // for an importer inside an npm package, whose own scope has no import map.
          importer: local ? args.importer : join(projectDir, PROJECT_IMPORTER),
          // A bare target resolves from the project, as the app's own imports do.
          resolveDir: projectDir,
          // The importer's namespace: Deno's resolver refuses a resolve with none, which a
          // target the import map sends to a file URL (`denext/preact`) reached.
          namespace: args.namespace || "file",
          pluginData: { [REENTRY]: true },
        });
        if (result.errors.length > 0) return { errors: result.errors };
        return {
          path: result.path,
          namespace: result.namespace,
          external: result.external,
          sideEffects: result.sideEffects,
        };
      });
    },
  };
}

/**
 * {@linkcode resolveAliasPlugin} for the configured `resolveAlias`, as a list (empty when none).
 *
 * @param projectDir The project root.
 * @param config The `resolveAlias` config value.
 */
export function resolveAliasPlugins(
  projectDir: string | undefined,
  config: ResolveAliasConfig | undefined,
): esbuild.Plugin[] {
  const rules = aliasRules(config);
  return rules && projectDir ? [resolveAliasPlugin(projectDir, rules)] : [];
}
