// `denext migrate --from fresh` for a Fresh 1.x `fresh.config.ts` with plugins: the config stays
// (the generated `middleware.ts` and root layout import it, and `denext/fresh/server` runs its
// plugins' routes, middleware and render hooks; `freshPlugins()` in `denext.config.ts` bundles
// their client entrypoints), minus Fresh's Tailwind plugin, which denext's own Tailwind build
// replaces. The islands a local plugin names (`islands: { baseLocation: import.meta.url, paths }`)
// are read here, so the migration marks them `"use client"`.

import { dirname, join, relative, resolve } from "@std/path";
import { balancedGroup, literalValue, type PluginCall, pluginCalls } from "./fresh-config-read.ts";
import { mfs } from "./migrate-io.ts";

/** What the migration does with a `fresh.config.ts`. */
export interface FreshConfigPlan {
  /** The config's new source (Tailwind's plugin removed), or null to remove the file. */
  source: string | null;
  /** The plugins it keeps running (their call names). */
  plugins: string[];
  /** Island modules local plugins name (project-relative). */
  islands: string[];
  /** Plugins imported from outside the project (their islands cannot be read). */
  remote: { name: string; specifier: string }[];
}

/** Fresh's Tailwind plugin: its import and its call. */
const TAILWIND_IMPORT =
  /^\s*import\s+tailwind\s+from\s+["'][^"']*plugins\/tailwind(?:\.ts)?["'];?[^\n]*\n/m;
const TAILWIND_CALL = /\btailwind\s*\((?:[^()]|\([^()]*\))*\)\s*,?\s*/;

/** The specifier the config imports a plugin's factory from (`import x from "…"`). */
function importOf(source: string, name: string): string | null {
  const local = name.split(".")[0];
  for (const m of source.matchAll(/^\s*import\s+([^"';]+?)\s+from\s+["']([^"']+)["']/gm)) {
    const names = m[1].replace(/[{}*]/g, ",").split(",").map((p) =>
      p.trim().split(/\s+as\s+/).pop()?.trim()
    );
    if (names.includes(local)) return m[2];
  }
  return null;
}

/** The island paths a plugin module declares, resolved (`islands: { baseLocation, paths }`). */
function declaredIslands(dir: string, file: string, source: string): string[] {
  const m = /\bislands\s*:\s*\{/.exec(source);
  const group = m ? balancedGroup(source, m.index + m[0].length - 1) : null;
  if (!group || !/baseLocation\s*:\s*import\.meta\.url/.test(group)) return [];
  const paths = /paths\s*:\s*(\[[\s\S]*?\])/.exec(group)?.[1];
  const list = paths ? literalValue(paths) : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter((p): p is string => typeof p === "string").map((p) =>
    relative(dir, resolve(dirname(file), p)).replaceAll("\\", "/")
  );
}

/** Sort one plugin call into a local plugin (its islands read) or a remote one. */
async function readPlugin(
  dir: string,
  source: string,
  call: PluginCall,
  out: FreshConfigPlan,
): Promise<void> {
  out.plugins.push(call.name);
  const spec = importOf(source, call.name);
  if (spec === null || !/^\.{1,2}\//.test(spec)) {
    if (spec !== null && !spec.startsWith("$fresh/")) {
      out.remote.push({ name: call.name, specifier: spec });
    }
    return;
  }
  const file = join(dir, spec);
  const mod = await mfs.readTextFile(file).catch(() => "");
  out.islands.push(...declaredIslands(dir, file, mod));
}

/**
 * Plan a `fresh.config.ts`: keep it when it has plugins other than Tailwind's (with that one
 * removed), read the islands its local plugins declare.
 *
 * @param dir The app directory.
 * @param source The config's source.
 * @returns The plan.
 */
export async function planFreshConfig(dir: string, source: string): Promise<FreshConfigPlan> {
  const out: FreshConfigPlan = { source: null, plugins: [], islands: [], remote: [] };
  const calls = pluginCalls(source).filter((c) => c.name !== "tailwind");
  if (calls.length === 0) return out;
  for (const call of calls) await readPlugin(dir, source, call, out);
  out.source = source.replace(TAILWIND_IMPORT, "").replace(TAILWIND_CALL, "");
  return out;
}
