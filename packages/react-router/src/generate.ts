// Generating denext route modules for a React Router v7 app WITHOUT touching its sources: each
// route module is split (client component / server data) and wrapped exactly as
// `denext migrate --from remix` would write into `app/` — except the output lands under
// `.denext/react-router/<route>/` and the originals stay where they are. The user's relative
// imports are re-based to the generated location; bare specifiers (`~/…`, `#app/…`, npm) are
// untouched. Writes are content-compared, so a dev re-scan that changes nothing writes nothing.

import { remixCodegen as cg } from "@denext/denext/plugin-kit";
import { dirname, join, relative } from "@std/path";
import type { RouteNode } from "./route-tree.ts";

/** What one route node produced on disk (absolute paths). */
export interface GeneratedRoute {
  /** The RR route id. */
  id: string;
  /** `page.tsx` (a leaf with a component) or `layout.tsx` (a node with children / the root). */
  wrapper?: string;
  /** `error.tsx` — the route's `ErrorBoundary`. */
  error?: string;
  /** `route.ts` — a resource route's GET/POST, or a page's action POST handler. */
  api?: string;
  /** Whether the module renders a component (a resource route does not). */
  component: boolean;
  /** Whether the route has an `action` (a page then also gets its `route.ts`). */
  action: boolean;
}

/** Inputs of {@link generateRoutes}. */
export interface GenerateOptions {
  /** The RR app directory (absolute) — where `root.tsx` and the route files live. */
  appDir: string;
  /** Where to write (absolute; `<project>/.denext/react-router`). */
  outDir: string;
  /** The routes to generate. */
  nodes: RouteNode[];
  /** `root.tsx`'s path (absolute), or null when the app has none. */
  rootFile: string | null;
}

/** The generated siblings a wrapper imports — relative to the OUTPUT dir already. */
const GENERATED_SIBLING = /^\.\/(?:page|layout)\.(?:data|client)\.tsx$/;

/** The generated root layout's id (denext's root layout slot). */
export const ROOT_ID = "root";

/**
 * Generate every route's modules. Returns the generated files by route id (the root under
 * {@link ROOT_ID}).
 */
export async function generateRoutes(
  opts: GenerateOptions,
): Promise<Map<string, GeneratedRoute>> {
  const out = new Map<string, GeneratedRoute>();
  if (opts.rootFile) out.set(ROOT_ID, await generateRoot(opts.rootFile, opts.outDir));
  for (const node of opts.nodes) {
    const file = join(opts.appDir, node.file);
    out.set(node.id, await generateNode(node, file, opts.outDir));
  }
  return out;
}

/** `routes/users.$id` → `routes__users.$id` (one flat directory per route). */
function slug(id: string): string {
  return id.replace(/[\\/]/g, "__").replace(/[^A-Za-z0-9_.$@+-]/g, "_");
}

async function generateNode(
  node: RouteNode,
  file: string,
  outDir: string,
): Promise<GeneratedRoute> {
  const source = await Deno.readTextFile(file);
  const parts = await cg.analyzeModule(source);
  const dir = join(outDir, slug(node.id));
  const srcDir = dirname(file);
  const role = node.layout ? "layout" : "page";
  const dataFile = `${role}.data.tsx`;
  const clientFile = `${role}.client.tsx`;
  const result: GeneratedRoute = {
    id: node.id,
    component: parts.hasDefault,
    action: parts.hasAction,
  };
  await Deno.mkdir(dir, { recursive: true });
  const hasServer = parts.serverStatements.length > 0;
  if (hasServer) {
    await writeIfChanged(join(dir, dataFile), rebase(cg.dataModuleSource(parts), srcDir, dir));
  }
  if (
    parts.hasDefault || parts.clientStatements.length > 0 || parts.helpers.some((h) => h.exported)
  ) {
    await writeIfChanged(
      join(dir, clientFile),
      rebase(cg.clientModuleSource(parts, dataFile, role, false, true), srcDir, dir),
    );
  }
  if (!parts.hasDefault) {
    // A resource route: GET/POST handlers only.
    result.api = join(dir, "route.ts");
    await writeIfChanged(result.api, cg.resourceRouteSource(node.id, dataFile, parts));
    return result;
  }
  result.wrapper = join(dir, `${role}.tsx`);
  const wrapper = role === "page"
    ? cg.pageWrapperSource(node.id, parts, clientFile, dataFile)
    : cg.layoutWrapperSource(node.id, parts, clientFile, dataFile);
  await writeIfChanged(result.wrapper, wrapper);
  if (parts.hasErrorBoundary || parts.hasCatchBoundary) {
    result.error = join(dir, "error.tsx");
    await writeIfChanged(result.error, cg.errorWrapperSource(clientFile));
  }
  if (role === "page" && parts.hasAction) {
    result.api = join(dir, "route.ts");
    await writeIfChanged(result.api, cg.pageActionRouteSource(dataFile));
  }
  return result;
}

/** `app/root.tsx` → the root layout: a server shell when it is one, else the client/data split. */
async function generateRoot(rootFile: string, outDir: string): Promise<GeneratedRoute> {
  const source = cg.stripRootDoc(await Deno.readTextFile(rootFile));
  const parts = await cg.analyzeModule(source);
  const dir = join(outDir, ROOT_ID);
  const srcDir = dirname(rootFile);
  await Deno.mkdir(dir, { recursive: true });
  const result: GeneratedRoute = {
    id: ROOT_ID,
    wrapper: join(dir, "layout.tsx"),
    component: true,
    action: parts.hasAction,
  };
  if (!cg.rootNeedsClient(parts)) {
    await writeIfChanged(result.wrapper!, rebase(cg.serverRootLayoutSource(parts), srcDir, dir));
    return result;
  }
  if (parts.serverStatements.length > 0) {
    await writeIfChanged(
      join(dir, "layout.data.tsx"),
      rebase(cg.dataModuleSource(parts), srcDir, dir),
    );
  }
  await writeIfChanged(
    join(dir, "layout.client.tsx"),
    rebase(cg.clientModuleSource(parts, "layout.data.tsx", "layout", true, true), srcDir, dir),
  );
  await writeIfChanged(
    result.wrapper!,
    cg.layoutWrapperSource(ROOT_ID, parts, "layout.client.tsx", "layout.data.tsx"),
  );
  if (parts.hasErrorBoundary || parts.hasCatchBoundary) {
    result.error = join(dir, "error.tsx");
    await writeIfChanged(result.error, cg.errorWrapperSource("layout.client.tsx"));
  }
  return result;
}

/** Re-base a generated module's relative imports from the source dir to the output dir. */
function rebase(code: string, srcDir: string, outDir: string): string {
  return cg.rewriteSpecifiers(code, (spec) => {
    if (!spec.startsWith(".") || GENERATED_SIBLING.test(spec)) return null;
    const next = relative(outDir, join(srcDir, spec)).replace(/\\/g, "/");
    return next.startsWith(".") ? next : `./${next}`;
  });
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  const current = await Deno.readTextFile(path).catch(() => null);
  if (current === content) return;
  await Deno.writeTextFile(path, content);
}
