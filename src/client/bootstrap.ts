// Browser entry point: read the hydration payload the server embedded, import
// the page + layout modules, rebuild the same tree the server rendered, and
// hydrate the existing markup in place.
//
// This module runs only in the browser. It is referenced by the document's
// `clientEntry` script tag.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { hydrateRoot } from "./reconciler.ts";
import { ROOT_ID } from "../server/document.ts";

interface HydrationPayload {
  routeModule: string;
  layoutModules: string[];
  params: Record<string, string>;
  searchParams: string;
  pathname: string;
}

export async function start(): Promise<void> {
  const dataEl = document.getElementById("__denext_data");
  const container = document.getElementById(ROOT_ID);
  if (!dataEl || !container) return;

  const data = JSON.parse(dataEl.textContent ?? "{}") as HydrationPayload;
  const searchParams = new URLSearchParams(data.searchParams);

  const [pageMod, ...layoutMods] = await Promise.all([
    import(data.routeModule),
    ...data.layoutModules.map((url) => import(url)),
  ]);

  const props = { params: data.params, searchParams };
  let tree: VNode = h(pageMod.default, props);
  // Wrap innermost -> outermost, mirroring the server's composition.
  for (let i = layoutMods.length - 1; i >= 0; i--) {
    tree = h(layoutMods[i].default, { children: tree, params: data.params });
  }

  hydrateRoot(container, tree);
}

if (typeof document !== "undefined") {
  start().catch((err) => console.error("denext hydration failed:", err));
}
