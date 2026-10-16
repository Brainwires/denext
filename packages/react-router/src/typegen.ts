// React Router's route typegen (`react-router typegen`) on denext: one `+types/<route>.ts` per
// route module under `<project>/.react-router/types/`, mirroring the app's tree as React Router
// lays it out (`app/routes/team.tsx` → `.react-router/types/app/routes/+types/team.ts`), so the
// `import type { Route } from "./+types/team"` a route module writes resolves through
// `compilerOptions.rootDirs` (`[".", "./.react-router/types"]`, which `denext migrate` writes).
// Each file's `Route` namespace has React Router's names (`LoaderArgs`, `ComponentProps`,
// `MetaFunction`, …), typed from the route module itself (`typeof import(…)`): its params from
// the full URL pattern, its loader / action data from what they return (unwrapped from
// `data()`), and its matches from the route's ancestors. The files are self-contained (no import
// but the route modules), so they type-check against whichever runtime the app's import map
// points `react-router` at. Writes are content-compared, like the route wrappers.

import { basename, dirname, extname, join, relative } from "@std/path";
import type { RouteNode } from "./route-tree.ts";

/** Inputs of {@link generateRouteTypes}. */
export interface TypegenOptions {
  /** The project root (absolute): the types mirror the app's tree relative to it. */
  projectRoot: string;
  /** The RR app directory (absolute). */
  appDir: string;
  /** The route tree. */
  nodes: RouteNode[];
  /** `root.tsx`'s path (absolute), or null when the app has none. */
  rootFile: string | null;
}

/** Where the route types go, relative to the project (React Router's own location). */
const TYPES_DIR = ".react-router/types";

/** One module of the match chain: its route id, file and full URL pattern. */
interface Level {
  id: string;
  file: string;
  pattern: string;
}

/**
 * Write every route's `+types` module; returns their paths (absolute). Stale ones (a route that
 * was removed) are deleted.
 */
export async function generateRouteTypes(opts: TypegenOptions): Promise<string[]> {
  const outRoot = join(opts.projectRoot, TYPES_DIR);
  const byId = new Map(opts.nodes.map((n) => [n.id, n]));
  const root: Level | null = opts.rootFile
    ? { id: "root", file: opts.rootFile, pattern: "" }
    : null;
  const written: string[] = [];
  const emit = async (self: Level, chain: Level[], params: string) => {
    const out = typesPathFor(self.file, opts.projectRoot, outRoot);
    await Deno.mkdir(dirname(out), { recursive: true });
    await writeIfChanged(out, routeTypesSource(self, chain, params, dirname(out)));
    written.push(out);
  };
  if (root) await emit(root, [root], "{}");
  for (const node of opts.nodes) {
    const self: Level = { id: node.id, file: join(opts.appDir, node.file), pattern: node.pattern };
    const chain: Level[] = [
      ...(root ? [root] : []),
      ...node.layoutIds.map((id) => {
        const n = byId.get(id)!;
        return { id, file: join(opts.appDir, n.file), pattern: n.pattern };
      }),
      self,
    ];
    await emit(self, chain, paramsType(node.pattern, node.layout ? descendantPatterns(node) : []));
  }
  await pruneStale(outRoot, new Set(written));
  return written;
}

/** `app/routes/team.tsx` → `<outRoot>/app/routes/+types/team.ts`. */
function typesPathFor(file: string, projectRoot: string, outRoot: string): string {
  const rel = relative(projectRoot, dirname(file));
  return join(outRoot, rel, "+types", basename(file, extname(file)) + ".ts");
}

/** The full patterns of every route below a layout (its children's params are optional). */
function descendantPatterns(node: RouteNode): string[] {
  return node.children.flatMap((c) => [c.pattern, ...descendantPatterns(c)]);
}

/**
 * A route's `params` type: each dynamic segment of its full pattern (`:id` → `id: string`,
 * `:lang?` → `lang?: string`, `*` → `"*": string`); a layout's also gets its descendants'
 * params, optional (it renders for each of them).
 */
export function paramsType(pattern: string, below: string[] = []): string {
  const own = paramsOf(pattern);
  const fields = new Map<string, boolean>(); // name → optional
  for (const [name, optional] of own) fields.set(name, optional);
  for (const p of below) {
    for (const [name] of paramsOf(p)) if (!fields.has(name)) fields.set(name, true);
  }
  if (fields.size === 0) return "{}";
  const body = [...fields].map(([name, optional]) =>
    `${JSON.stringify(name)}${optional ? "?" : ""}: string`
  );
  return `{ ${body.join("; ")} }`;
}

function paramsOf(pattern: string): Array<[string, boolean]> {
  const out: Array<[string, boolean]> = [];
  for (const seg of pattern.split("/")) {
    if (seg === "*") out.push(["*", false]);
    else if (seg.startsWith(":")) {
      const optional = seg.endsWith("?");
      out.push([optional ? seg.slice(1, -1) : seg.slice(1), optional]);
    }
  }
  return out;
}

/** A relative module specifier from `fromDir` to `file` (extension kept, as Deno resolves it). */
function specifier(fromDir: string, file: string): string {
  const rel = relative(fromDir, file).replace(/\\/g, "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** The `+types` module of one route. */
function routeTypesSource(self: Level, chain: Level[], params: string, dir: string): string {
  const modules = chain.map((l, i) =>
    `type M${i} = typeof import(${JSON.stringify(specifier(dir, l.file))});`
  );
  const matches = chain.map((l, i) =>
    `  Match<${JSON.stringify(l.id)}, M${i}, ${
      i === chain.length - 1 ? "Params" : paramsType(l.pattern)
    }>,`
  );
  return `// Generated by @denext/react-router (React Router's route typegen). Do not edit.
// deno-lint-ignore-file
// Route ${JSON.stringify(self.id)} (${self.pattern === "" ? "/" : "/" + self.pattern}).

${modules.join("\n")}
type Module = M${chain.length - 1};
type Params = ${params};
type Matches = [
${matches.join("\n")}
];

${HELPERS}`;
}

// The same in every file (kept local, so a `+types` module imports nothing but route modules).
const HELPERS = `type Unwrap<V> = V extends { type: "DataWithResponseInit"; data: infer D } ? D
  : V extends Response ? unknown
  : V;
type DataOf<F> = F extends (...args: never[]) => infer R ? Unwrap<Awaited<R>> : undefined;
type Defined<T> = [T] extends [undefined] ? false : true;
type ServerLoaderData<M> = M extends { loader: infer L } ? DataOf<L> : undefined;
type ClientLoaderData<M> = M extends { clientLoader: infer L } ? DataOf<L> : undefined;
type Hydrates<M> = M extends { clientLoader: { hydrate: true } } ? true : false;
type HasFallback<M> = M extends { HydrateFallback: unknown } ? true : false;
/** React Router's \`loaderData\`: the client loader's when it runs at hydration, else either. */
type LoaderData<M> = [HasFallback<M>, Hydrates<M>] extends [true, true] ? ClientLoaderData<M>
  : [Defined<ClientLoaderData<M>>, Defined<ServerLoaderData<M>>] extends [true, true]
    ? ServerLoaderData<M> | ClientLoaderData<M>
  : Defined<ClientLoaderData<M>> extends true ? ClientLoaderData<M>
  : ServerLoaderData<M>;
type ActionData<M> =
  | (M extends { clientAction: infer A } ? DataOf<A>
    : M extends { action: infer A } ? DataOf<A>
    : undefined)
  | undefined;
type Match<Id extends string, M, P> = {
  id: Id;
  params: P;
  pathname: string;
  data: LoaderData<M>;
  loaderData: LoaderData<M>;
  handle: M extends { handle: infer H } ? H : unknown;
};
type AppLoadContext = Record<string, unknown>;
type Location = { pathname: string; search: string; hash: string; state: unknown; key: string };
type MetaDescriptor =
  | { charSet: "utf-8" }
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string }
  | { httpEquiv: string; content: string }
  | { "script:ld+json": unknown }
  | { tagName: "meta" | "link"; [name: string]: string }
  | { [name: string]: unknown };
type LinkDescriptor = { [name: string]: unknown };

export namespace Route {
  export type LinkDescriptors = LinkDescriptor[];
  export type LinksFunction = () => LinkDescriptors;

  export type MetaArgs = {
    data: LoaderData<Module>;
    loaderData: LoaderData<Module>;
    params: Params;
    location: Location;
    matches: Matches;
    error?: unknown;
  };
  export type MetaDescriptors = MetaDescriptor[];
  export type MetaFunction = (args: MetaArgs) => MetaDescriptors | undefined;

  export type HeadersArgs = {
    loaderHeaders: Headers;
    parentHeaders: Headers;
    actionHeaders: Headers;
    errorHeaders: Headers | undefined;
  };
  export type HeadersFunction = (args: HeadersArgs) => Headers | HeadersInit;

  export type LoaderArgs = { request: Request; params: Params; context: AppLoadContext };
  export type ClientLoaderArgs = {
    request: Request;
    params: Params;
    serverLoader: () => Promise<ServerLoaderData<Module>>;
  };
  export type ActionArgs = { request: Request; params: Params; context: AppLoadContext };
  export type ClientActionArgs = {
    request: Request;
    params: Params;
    serverAction: () => Promise<
      Module extends { action: infer A } ? DataOf<A> : undefined
    >;
  };

  export type HydrateFallbackProps = {
    params: Params;
    loaderData?: LoaderData<Module>;
    actionData?: ActionData<Module>;
  };
  export type ComponentProps = {
    params: Params;
    loaderData: LoaderData<Module>;
    actionData?: ActionData<Module>;
    matches: Matches;
  };
  export type ErrorBoundaryProps = {
    params: Params;
    error: unknown;
    loaderData?: LoaderData<Module>;
    actionData?: ActionData<Module>;
  };
}
`;

/** Delete the `+types` files under `outRoot` that this run did not write. */
async function pruneStale(outRoot: string, keep: Set<string>): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory) await walk(path);
      else if (dirname(path).endsWith("+types") && !keep.has(path)) {
        await Deno.remove(path).catch(() => {});
      }
    }
  };
  await walk(outRoot);
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  const current = await Deno.readTextFile(path).catch(() => null);
  if (current !== content) await Deno.writeTextFile(path, content);
}
