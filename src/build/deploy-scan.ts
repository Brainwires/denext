// The source scans behind the deploy manifest (./deploy-manifest.ts): route segment config,
// route-handler methods, the middleware matcher, job schedules and environment reads — all read
// as TEXT, never imported. Like Next's own build, a route's segment config is read from literal
// exports (`export const dynamic = "force-dynamic"`, `export const revalidate = 60`), so a
// computed value is not seen; a page that reads request data only through a helper of its own is
// classified by what its route files say.
//
// Build-time only; never imported by a shipped bundle.

import { walk } from "@std/fs";
import { relative, SEPARATOR } from "@std/path";
import type { PageRoute } from "../router/manifest.ts";
import type { DeployRoute } from "../deploy/manifest.ts";

/** A file's text, or `""` when it can't be read. */
export async function readText(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}

/** `path` relative to `root`, `/`-separated. */
export function rel(root: string, path: string): string {
  return relative(root, path).split(SEPARATOR).join("/");
}

const DYNAMIC_EXPORT =
  /export\s+const\s+dynamic\s*(?::[^=]+)?=\s*["'](auto|force-dynamic|force-static|error)["']/;
const REVALIDATE_EXPORT = /export\s+const\s+revalidate\s*(?::[^=]+)?=\s*(\d+|false)\b/;
const STATIC_PARAMS =
  /export\s+(?:async\s+)?function\s+generateStaticParams\b|export\s+const\s+generateStaticParams\b/;
/** Request APIs whose call makes a render per-request. */
const REQUEST_APIS = /\b(cookies|headers|connection|draftMode|getSession|auth)\s*\(/;

/** The segment config a page's route files declare, innermost (the page) winning. */
interface RouteFacts {
  dynamic?: string;
  revalidate?: number | false;
  staticParams: boolean;
  requestApi?: string;
  searchParams: boolean;
}

/** The lower of two revalidation periods (Next's rule); `false` never lowers a number. */
function lowerRevalidate(
  current: number | false | undefined,
  value: number | false,
): number | false {
  if (typeof current !== "number") return value;
  return value !== false && value < current ? value : current;
}

/** Read the facts of one route file into `facts` (the page last, so it wins). */
function readFacts(text: string, facts: RouteFacts): void {
  const dynamic = DYNAMIC_EXPORT.exec(text)?.[1];
  if (dynamic) facts.dynamic = dynamic;
  const revalidate = REVALIDATE_EXPORT.exec(text)?.[1];
  if (revalidate !== undefined) {
    facts.revalidate = lowerRevalidate(
      facts.revalidate,
      revalidate === "false" ? false : Number(revalidate),
    );
  }
  if (STATIC_PARAMS.test(text)) facts.staticParams = true;
  facts.requestApi ??= REQUEST_APIS.exec(text)?.[1]?.concat("()");
}

/** Whether a route pattern has a dynamic segment. */
function hasDynamicSegment(page: PageRoute): boolean {
  return page.pattern.some((s) => s.kind !== "static");
}

/** A page route's kind, and why when it is not static. */
type PageKind = Pick<DeployRoute, "kind" | "reason" | "revalidate">;

/** The ISR kind when the chain sets a positive `revalidate`, else static. */
function cachedKind(facts: RouteFacts): PageKind {
  return typeof facts.revalidate === "number" && facts.revalidate > 0
    ? { kind: "isr", revalidate: facts.revalidate, reason: "export const revalidate" }
    : { kind: "static" };
}

/** Why a page renders per request, or `undefined` when nothing says so. */
function dynamicReason(facts: RouteFacts, dynamicSegments: boolean): string | undefined {
  if (facts.dynamic === "force-dynamic") return 'export const dynamic = "force-dynamic"';
  if (facts.dynamic === "force-static") return undefined;
  if (dynamicSegments && !facts.staticParams) {
    return "a dynamic segment without generateStaticParams";
  }
  if (facts.requestApi) return `calls ${facts.requestApi}`;
  return facts.searchParams ? "reads searchParams" : undefined;
}

/** The kind of a page whose facts are read, and why when it is not static. */
function pageKind(facts: RouteFacts, dynamicSegments: boolean): PageKind {
  const reason = dynamicReason(facts, dynamicSegments);
  return reason ? { kind: "dynamic", reason } : cachedKind(facts);
}

/**
 * Classify one page route from its layout chain and its own module (read as text).
 *
 * @param projectDir The project root (sources are recorded relative to it).
 * @param page The scanned route.
 * @returns The route's manifest entry.
 */
export async function classifyPage(projectDir: string, page: PageRoute): Promise<DeployRoute> {
  const facts: RouteFacts = { staticParams: false, searchParams: false };
  for (const file of [...page.layoutChain, page.filePath]) readFacts(await readText(file), facts);
  facts.searchParams = /\bsearchParams\b/.test(await readText(page.filePath));
  const { kind, reason, revalidate } = pageKind(facts, hasDynamicSegment(page));
  return {
    path: page.routePath,
    kind,
    source: rel(projectDir, page.filePath),
    ...(reason ? { reason } : {}),
    ...(revalidate !== undefined ? { revalidate } : {}),
  };
}

const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/**
 * A route handler's exported HTTP methods, from its source.
 *
 * @param text The module's source.
 * @returns The methods, in the order of {@link HTTP_METHODS}.
 */
export function handlerMethods(text: string): string[] {
  return HTTP_METHODS.filter((m) =>
    new RegExp(
      `export\\s+(?:async\\s+)?function\\s+${m}\\b|export\\s+(?:const|let|var)\\s+${m}\\b|export\\s*\\{[^}]*\\b${m}\\b[^}]*\\}`,
    ).test(text)
  );
}

/**
 * The middleware's `config.matcher`, when it is a string literal or an array of them.
 *
 * @param text The middleware module's source.
 * @returns The patterns, or `undefined` (every path, or not a literal).
 */
export function middlewareMatcher(text: string): string[] | undefined {
  const m = /\bmatcher\s*:\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/.exec(text)?.[1];
  if (!m) return undefined;
  const items = [...m.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
  return items.length ? items : undefined;
}

/** A module found under a convention directory (`jobs/`, `services/`). */
export interface ConventionModule {
  /** Its name: the path under the directory without the extension. */
  name: string;
  /** Absolute path. */
  path: string;
}

/**
 * The modules a convention directory holds, as the server discovers them (dotfiles and `_private`
 * files skipped), sorted by name.
 *
 * @param dir The directory (`<project>/jobs`).
 * @returns The modules; empty when the directory is missing.
 */
export async function conventionModules(dir: string): Promise<ConventionModule[]> {
  const found: ConventionModule[] = [];
  try {
    for await (
      const entry of walk(dir, {
        exts: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
        includeDirs: false,
        skip: [/[/\\]\.[^/\\]+/, /[/\\]_/],
      })
    ) {
      const name = rel(dir, entry.path).replace(/\.(tsx?|jsx?|mjs)$/, "");
      found.push({ name, path: entry.path });
    }
  } catch { /* no such directory */ }
  return found.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * The cron expressions a job's own `defineJob({ schedule })` declares, when they are literals.
 *
 * @param text The job module's source.
 * @returns The expressions (a string or an array of strings), in source order.
 */
export function jobSchedules(text: string): string[] {
  const m = /\bschedule\s*:\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|`[^`$]*`)/.exec(text)?.[1];
  if (!m) return [];
  return [...m.matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1].trim()).filter(Boolean);
}

/** The directories (and dotfiles) an environment scan never enters, matched project-relative. */
const ENV_SKIP_NAMES = String.raw`(node_modules|out|dist|coverage|tests?|__tests__|\.[^/\\]+)`;

/** {@link ENV_SKIP_NAMES} at any depth under `root` (an absolute path, as `walk` reports it). */
function envSkip(root: string): RegExp {
  const prefix = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(String.raw`^${prefix}[/\\](?:.*[/\\])?${ENV_SKIP_NAMES}(?:[/\\]|$)`);
}

/** `Deno.env.get("X")` (with `!` when asserted) and `process.env.X` / `process.env["X"]`. */
const ENV_READ =
  /Deno\.env\.get\(\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\)(!?)|process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\])/g;

/** One environment read found in the source. */
export interface EnvRead {
  /** The variable. */
  name: string;
  /** Whether the read asserts it is set (`!`). */
  asserted: boolean;
  /** The file, project-relative. */
  source: string;
}

/**
 * Every literal environment read in the project's own source (tests, the build and dependencies
 * left out).
 *
 * @param projectDir The project root.
 * @returns The reads, in walk order.
 */
export async function envReads(projectDir: string): Promise<EnvRead[]> {
  const reads: EnvRead[] = [];
  for await (
    const entry of walk(projectDir, {
      exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"],
      includeDirs: false,
      skip: [envSkip(projectDir)],
    })
  ) {
    const source = rel(projectDir, entry.path);
    for (const m of (await readText(entry.path)).matchAll(ENV_READ)) {
      reads.push({ name: m[1] ?? m[3] ?? m[4], asserted: m[2] === "!", source });
    }
  }
  return reads;
}

/**
 * Every file under `dir`, relative and `/`-separated, sorted — precompressed `.gz` siblings left
 * out. Empty when `dir` is missing.
 *
 * @param dir The directory.
 * @param skipDirs Top-level subdirectories to leave out.
 * @returns The files.
 */
export async function filesUnder(dir: string, skipDirs: readonly string[] = []): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of walk(dir, { includeDirs: false })) {
      const name = rel(dir, entry.path);
      if (name.endsWith(".gz") || skipDirs.some((d) => name.startsWith(`${d}/`))) continue;
      files.push(name);
    }
  } catch { /* missing */ }
  return files.sort();
}

/** Whether `path` exists. */
export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
