// `generateStaticParams` enumeration for a dynamic route, Next.js style: a layout above the
// page may enumerate ITS dynamic segments, and the page's generator is then called once per
// parent set with `{ params }` (the parent's values) and its results merged in.

import type { PageRoute } from "../router/manifest.ts";
import { paramPath, type RouteParams } from "../router/segments.ts";
import type { LayoutModule, ModuleLoader, PageModule, StaticParamsGenerator } from "./types.ts";

/** The generator exported by a module, if any. */
function generatorOf(mod: unknown): StaticParamsGenerator | null {
  const g = (mod as { generateStaticParams?: unknown })?.generateStaticParams;
  return typeof g === "function" ? g as StaticParamsGenerator : null;
}

/** Call one generator once per parent param set, merging each result over its parent. */
async function expand(
  gen: StaticParamsGenerator,
  parents: RouteParams[],
): Promise<RouteParams[]> {
  const out: RouteParams[] = [];
  for (const parent of parents) {
    for (const set of await gen({ params: parent })) out.push({ ...parent, ...set });
  }
  return out;
}

/**
 * Every param set a route's `generateStaticParams` chain enumerates (layouts outer→inner,
 * then the page). `null` when neither the page nor any layout exports a generator — the
 * route is dynamic with unknown params (callers decide what a static route means).
 */
export async function enumerateStaticParams(
  route: PageRoute,
  load: ModuleLoader,
): Promise<RouteParams[] | null> {
  const modules: unknown[] = [];
  for (const layoutPath of route.layoutChain) {
    modules.push((await load(layoutPath)) as LayoutModule);
  }
  modules.push((await load(route.filePath)) as PageModule);
  return await enumerateParamSets(modules);
}

/**
 * Every param set the `generateStaticParams` exports of `modules` enumerate, outermost first
 * (each generator is called once per set its ancestors produced). `null` when none of the
 * modules exports a generator.
 *
 * @param modules Loaded layout / page / route modules, outermost first.
 * @returns The enumerated param sets, or `null`.
 */
export async function enumerateParamSets(modules: unknown[]): Promise<RouteParams[] | null> {
  let sets: RouteParams[] = [{}];
  let any = false;
  for (const mod of modules) {
    const gen = generatorOf(mod);
    if (!gen) continue;
    any = true;
    sets = await expand(gen, sets);
  }
  return any ? sets : null;
}

/**
 * Whether `params` is one of the `known` enumerated sets (every key equal in its path form).
 * `null` (nothing enumerated) admits nothing — the `dynamicParams = false` rule.
 *
 * @param known The sets {@link enumerateParamSets} produced, or `null`.
 * @param params The request's matched params.
 * @returns True when the params were enumerated.
 */
export function paramsEnumerated(known: RouteParams[] | null, params: RouteParams): boolean {
  if (known === null) return false;
  const keys = Object.keys(params);
  return known.some((set) => keys.every((k) => paramPath(set[k]) === paramPath(params[k])));
}
