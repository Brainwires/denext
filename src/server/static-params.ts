// `generateStaticParams` enumeration for a dynamic route, Next.js style: a layout above the
// page may enumerate ITS dynamic segments, and the page's generator is then called once per
// parent set with `{ params }` (the parent's values) and its results merged in.

import type { PageRoute } from "../router/manifest.ts";
import type { RouteParams } from "../router/segments.ts";
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
  let sets: RouteParams[] = [{}];
  let any = false;
  for (const layoutPath of route.layoutChain) {
    const gen = generatorOf((await load(layoutPath)) as LayoutModule);
    if (!gen) continue;
    any = true;
    sets = await expand(gen, sets);
  }
  const pageGen = generatorOf((await load(route.filePath)) as PageModule);
  if (pageGen) {
    any = true;
    sets = await expand(pageGen, sets);
  }
  return any ? sets : null;
}
