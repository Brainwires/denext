// Fail closed: no client bundle ships the source of a `"use server"` module.
//
// Every client bundle replaces each `"use server"` module with an action stub (the bundler's
// import map, ./client-imports.ts; the esbuild paths' stub plugin; the unbundled dev server's
// transform). Should any import reach the real module anyway — a spelling no resolver rule
// covers, a copy some other redirect mechanism made, a module the boundary never saw — its
// source, and every constant and credential in it, would be served publicly. So the bundle is
// checked for what it actually emitted: a shipped module whose directive prologue says
// `"use server"` fails the build with the module, the import chain that reached it, and the fix.
// The directive is read by the prologue scanner (./directives.ts), so a stub, an inline
// `"use server"` inside a function body, and a string that merely mentions the directive are
// not flagged.

import { fromFileUrl, relative, toFileUrl } from "@std/path";
import { readDirective } from "./directives.ts";

/** A `"use server"` module a client bundle shipped. */
export interface ServerModuleLeak {
  /** Absolute path of the module (the app's original for a rewritten copy). */
  readonly module: string;
  /** The entries that shipped it (route / islands / SPA labels). */
  readonly entries: string[];
  /** The import chain from the entry to the module, as display paths; empty when unknown. */
  chain: string[];
}

/**
 * The shipped modules whose source declares `"use server"`.
 *
 * @param shipped Absolute paths of the modules a bundle emitted (its source maps' `sources`).
 * @param directiveOf Read a module's directive (defaults to {@linkcode readDirective}).
 * @returns The `"use server"` modules among them, in `shipped` order.
 */
export async function findShippedServerModules(
  shipped: Iterable<string>,
  directiveOf: (path: string) => Promise<string | null> = readDirective,
): Promise<string[]> {
  const out: string[] = [];
  for (const path of shipped) {
    if (/\.(?:[cm]?[jt]sx?)$/.test(path) && (await directiveOf(path)) === "server") out.push(path);
  }
  return out;
}

/** One module of a `deno info --json` graph (the fields the chain walk reads). */
interface InfoModule {
  specifier: string;
  dependencies?: Array<{ code?: { specifier?: string } }>;
}

/** How to run `deno info` for {@linkcode importerChains}. */
export interface DenoInfoRunner {
  /** The `deno` binary. */
  readonly deno: string;
  /** Extra flags (the minimum-dependency-age policy). */
  readonly args: readonly string[];
}

/** `path`'s real path, or itself. */
async function real(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return path;
  }
}

/** The `deno info --json` modules of a barrel importing `roots`, resolved under `configPath`. */
async function infoModules(
  barrel: string,
  configPath: string,
  runner: DenoInfoRunner,
): Promise<InfoModule[]> {
  const { code, stdout } = await new Deno.Command(runner.deno, {
    args: [
      "info",
      "--unstable-sloppy-imports",
      ...runner.args,
      "--json",
      "--config",
      configPath,
      toFileUrl(barrel).href,
    ],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (code !== 0) return [];
  return (JSON.parse(new TextDecoder().decode(stdout)) as { modules?: InfoModule[] }).modules ??
    [];
}

/** Each module reachable from `root` → the module that first imported it (breadth first). */
function importParents(modules: InfoModule[], root: string): Map<string, string | null> {
  const byId = new Map(modules.map((m) => [m.specifier, m]));
  const parent = new Map<string, string | null>([[root, null]]);
  const queue = [root];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const dep of byId.get(id)?.dependencies ?? []) {
      const next = dep.code?.specifier;
      if (next && !parent.has(next)) {
        parent.set(next, id);
        queue.push(next);
      }
    }
  }
  return parent;
}

/** The file paths from `root`'s first import down to `id`, through `parent`. */
function chainTo(id: string, root: string, parent: Map<string, string | null>): string[] {
  const chain: string[] = [];
  for (let at: string | null = id; at && at !== root; at = parent.get(at) ?? null) {
    chain.unshift(fromFileUrl(at));
  }
  return chain;
}

/**
 * The import chain from `roots` to each of `targets`, resolved by `deno info` under `configPath`
 * (the bundle's own merged config, so it resolves exactly as the bundle did). Each chain lists
 * the file paths from the importing root down to the target; a target the walk cannot reach maps
 * to an empty chain. Best effort: a failing `deno info` gives empty chains.
 */
export async function importerChains(
  roots: readonly string[],
  configPath: string,
  targets: readonly string[],
  runner: DenoInfoRunner,
): Promise<Map<string, string[]>> {
  const out = new Map(targets.map((t) => [t, [] as string[]]));
  const tmp = await Deno.makeTempDir({ prefix: "denext_chain_" });
  try {
    const barrel = `${tmp}/barrel.ts`;
    await Deno.writeTextFile(
      barrel,
      roots.map((r) => `import ${JSON.stringify(toFileUrl(r).href)};`).join("\n") + "\n",
    );
    const root = toFileUrl(barrel).href;
    const parent = importParents(await infoModules(barrel, configPath, runner), root);
    const wanted = new Map<string, string>();
    for (const t of targets) wanted.set(await real(t), t);
    for (const id of parent.keys()) {
      const target = id.startsWith("file:") ? wanted.get(await real(fromFileUrl(id))) : undefined;
      if (target) out.set(target, chainTo(id, root, parent));
    }
    return out;
  } catch {
    return out;
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

/**
 * The build error for shipped `"use server"` modules: each module, the chain that reached it and
 * the entries that shipped it, and the fix. Paths are shown relative to `projectDir`.
 *
 * @param leaks The leaked modules.
 * @param projectDir The directory paths are made relative to.
 */
export function formatServerModuleLeaks(
  leaks: readonly ServerModuleLeak[],
  projectDir: string,
): string {
  const show = (p: string) => {
    const rel = relative(projectDir, p);
    return rel.startsWith("..") ? p : rel;
  };
  const lines = leaks.map((leak) => {
    const chain = leak.chain.length > 1
      ? `\n    imported through ${leak.chain.slice(0, -1).map(show).join(" → ")}`
      : "";
    return `  ${show(leak.module)}${chain}\n    shipped by ${leak.entries.join(", ")}`;
  });
  return `denext: a "use server" module would ship to the browser.\n\n${lines.join("\n")}\n\n` +
    `A client bundle replaces every "use server" module with an action stub that calls the ` +
    `server, so the module's source — and any secret in it — never leaves the server. This ` +
    `one reached the bundle without its stub, so the build stops instead of publishing it. ` +
    `Fix: import the action from a "use client" component or a route the App Router renders ` +
    `(its stub comes from the route's import graph). A SPA has no server to call: keep the ` +
    `code the browser needs out of "use server" modules. If the import looks right, this is ` +
    `a denext bug — please report it with the chain above.`;
}
