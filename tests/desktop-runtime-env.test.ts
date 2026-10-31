// The env allow-list `desktop.permissions: "strict"` bakes (src/build/desktop-runtime-env.ts):
// scan the desktop runtime's module graph (`src/build/desktop.ts` and every `src/desktop/` module,
// through their relative imports) for environment reads and fail when one names a variable outside
// the list, when a new read cannot be resolved to a name, or when a listed name is no longer read.
// The graph's JSR dependencies (@std/*) read no environment.

import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import { DESKTOP_RUNTIME_ENV } from "../src/build/desktop-runtime-env.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/**
 * Reads whose variable is a parameter: each file's wrapper(s), whose callers pass literal names
 * (scanned below). A new one fails the test: give it literal-name callers, then count it here.
 */
const DYNAMIC_READS: Readonly<Record<string, number>> = {
  "src/build/code-signing.ts": 1,
  "src/build/deno-cache-dir.ts": 2,
  "src/build/desktop-launch-policy.ts": 1,
  "src/build/desktop-package-script.ts": 1,
  "src/build/desktop-runtime.ts": 1,
  "src/build/dev-server/dev-token.ts": 1,
  "src/build/runtime-revocations.ts": 1,
  "src/build/stock-deprecation.ts": 2,
  "src/build/verified-download.ts": 1,
  "src/desktop/app-dirs.ts": 1,
  "src/desktop/sidecar-child.ts": 3,
  "src/runtime/env-safe.ts": 1,
};

/**
 * Reads of the whole environment (`Deno.env.toObject()`, `process.env` enumerated): a program
 * sidecar's and the login shell's environment (strict mode refuses both), a module sidecar's
 * `process.env` copy and `spawnSelf()` child, and `envAll()`, which reads a refused environment as
 * empty.
 */
const WHOLE_ENV_READS: Readonly<Record<string, number>> = {
  "src/desktop/sidecar-child.ts": 1,
  "src/desktop/sidecar-launch.ts": 3,
  "src/desktop/sidecar-login-env.ts": 1,
  "src/runtime/env-safe.ts": 1,
};

/**
 * Calls that hand a variable's name on to a reader (`proxyEnv` → `env(name)` reads the name and its
 * lowercase spelling; `downloadTimeoutMs` → `env(name)`), and the app's own public variables
 * (`public-env.ts`, which the app declares in `desktop.permissions.env`); the rest build an
 * environment for a child rather than read one.
 */
const FORWARDED: ReadonlySet<string> = new Set([
  "src/build/desktop-package-script.ts desktopExportEnv",
  "src/build/desktop-package-script.ts desktopRuntimeEnv",
  "src/build/desktop-runtime.ts localRuntimeEnv",
  "src/build/verified-download.ts env",
  "src/desktop/caps/shell.ts shellPathEnv",
  "src/desktop/sidecar-launch.ts sidecarEnv",
  "src/desktop/sidecar-login-env.ts probeEnv",
  "src/desktop/updater.ts env",
  "src/runtime/public-env.ts envGet",
  "src/server/config-validate.ts validateCacheAndEnv",
  "src/server/config.ts envGet",
]);

/** Readers whose first argument is a name read by a wrapper they call. */
const NAME_READERS = ["downloadTimeoutMs"];
/** Readers that also read the lowercase spelling of the name. */
const CASE_FOLDING_READERS = new Set(["proxyEnv"]);

/** A file's text without comments, so a documented read is not counted. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");
}

/** The roots of the desktop runtime's graph: `src/build/desktop.ts` and every `src/desktop/` module. */
async function graphRoots(): Promise<string[]> {
  const roots = [join(ROOT, "src/build/desktop.ts")];
  for (const dir of ["src/desktop", "src/desktop/caps"]) {
    for await (const e of Deno.readDir(join(ROOT, dir))) {
      if (e.isFile && e.name.endsWith(".ts")) roots.push(join(ROOT, dir, e.name));
    }
  }
  return roots;
}

/** A module's code without comments, or `undefined` (a generated module not in the checkout). */
async function moduleCode(file: string): Promise<string | undefined> {
  try {
    return stripComments(await Deno.readTextFile(file));
  } catch {
    return undefined;
  }
}

const IMPORTS = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

/** The modules `code` (at `file`) imports by relative path. */
function relativeImports(file: string, code: string): string[] {
  return [...code.matchAll(IMPORTS)]
    .map((m) => resolve(dirname(file), m[1]))
    .filter((target) => /\.(?:m?[jt]sx?)$/.test(target));
}

/** The desktop runtime's own modules: the roots and everything they import by relative path. */
async function desktopGraph(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const queue = await graphRoots();
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (out.has(file)) continue;
    const code = await moduleCode(file);
    if (code === undefined) continue;
    out.set(file, code);
    queue.push(...relativeImports(file, code));
  }
  return out;
}

interface EnvInventory {
  readonly names: Map<string, string>;
  readonly dynamic: Map<string, number>;
  readonly whole: Map<string, number>;
  readonly forwarded: Set<string>;
  readonly unresolved: string[];
}

/** One module's scan: where it is, its code, and the graph's string constants. */
interface ModuleScan {
  readonly rel: string;
  readonly code: string;
  readonly consts: ReadonlyMap<string, string>;
  readonly inv: EnvInventory;
}

const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

/** The graph's `const NAME = "value"` string constants (a name read through one resolves). */
function stringConstants(graph: Map<string, string>): Map<string, string> {
  const consts = new Map<string, string>();
  const decl = /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*["']([^"']+)["']/g;
  for (const code of graph.values()) {
    for (const m of code.matchAll(decl)) consts.set(m[1], m[2]);
  }
  return consts;
}

/** A name token (`"NAME"` or a constant) as the variable it names. */
function nameOf(scan: ModuleScan, token: string): string | undefined {
  return /^["']/.test(token) ? token.slice(1, -1) : scan.consts.get(token);
}

function addName(scan: ModuleScan, name: string): void {
  if (!scan.inv.names.has(name)) scan.inv.names.set(name, scan.rel);
}

/** `Deno.env.get/has/set/delete(…)`: a name, else a dynamic read. */
function scanDenoEnv(scan: ModuleScan): void {
  for (const m of scan.code.matchAll(/Deno\.env\.(get|has|set|delete)\(\s*([^,)]*)/g)) {
    const arg = m[2].trim();
    if (!/^["'][A-Za-z_]\w*["']$|^[A-Z][A-Z0-9_]*$/.test(arg)) {
      bump(scan.inv.dynamic, scan.rel);
      continue;
    }
    const name = nameOf(scan, arg);
    if (name) addName(scan, name);
    else scan.inv.unresolved.push(`${scan.rel}: ${m[0]}`);
  }
}

/** `process.env.NAME` / `process.env["NAME"]`, and the whole environment. */
function scanWholeEnv(scan: ModuleScan): void {
  for (
    const m of scan.code.matchAll(/process\.env(?:\.([A-Za-z_]\w*)|\[\s*["']([^"']+)["']\s*\])?/g)
  ) {
    const name = m[1] ?? m[2];
    if (name) addName(scan, name);
    else bump(scan.inv.whole, scan.rel);
  }
  for (const _ of scan.code.matchAll(/Deno\.env\.toObject\(\)/g)) bump(scan.inv.whole, scan.rel);
}

const READER = /\b([A-Za-z_$][\w$]*Env|env|envGet|envOr|readEnv|takeEnv)\(([^()]*)\)/g;
const NAME_READER_CALLS = NAME_READERS.map((n) => new RegExp(`\\b(${n})\\(([^()]*)\\)`, "g"));

/** A call that hands on a parameter rather than a name (a definition is not one). */
function forwards(code: string, at: number, args: string): boolean {
  const definition = /\bfunction\s*$/.test(code.slice(0, at)) || args.includes(":");
  return /^[a-z]/.test(args) && !definition;
}

/** The names one reader call is given (`proxyEnv` also reads each one's lowercase spelling). */
function addCallNames(scan: ModuleScan, callee: string, tokens: readonly string[]): void {
  for (const token of tokens) {
    const name = nameOf(scan, token); // an UPPER_CASE value that names nothing is skipped
    if (name === undefined) continue;
    addName(scan, name);
    if (CASE_FOLDING_READERS.has(callee)) addName(scan, name.toLowerCase());
  }
}

/** Calls of env readers: the names they are given, or a forwarded parameter. */
function scanReaders(scan: ModuleScan): void {
  const calls = [READER, ...NAME_READER_CALLS].flatMap((callee) => [...scan.code.matchAll(callee)]);
  for (const m of calls) {
    const args = m[2].trim();
    const tokens = [...args.matchAll(/["'][A-Z][A-Za-z0-9_]*["']|\b[A-Z][A-Z0-9_]*\b/g)].map((t) =>
      t[0]
    );
    if (tokens.length === 0 && forwards(scan.code, m.index!, args)) {
      scan.inv.forwarded.add(`${scan.rel} ${m[1]}`);
    }
    addCallNames(scan, m[1], tokens);
  }
}

/** Every environment read in the graph, by name, plus the reads that name none. */
function inventory(graph: Map<string, string>): EnvInventory {
  const consts = stringConstants(graph);
  const inv: EnvInventory = {
    names: new Map(),
    dynamic: new Map(),
    whole: new Map(),
    forwarded: new Set(),
    unresolved: [],
  };
  for (const [file, code] of graph) {
    const scan = { rel: relative(ROOT, file).replaceAll("\\", "/"), code, consts, inv };
    scanDenoEnv(scan);
    scanWholeEnv(scan);
    scanReaders(scan);
  }
  return inv;
}

const graph = await desktopGraph();
const found = inventory(graph);

Deno.test("desktop runtime env: every variable the desktop runtime modules read is in the strict allow-list", () => {
  assert(graph.size > 100, `the graph walk found only ${graph.size} modules`);
  const missing = [...found.names].filter(([name]) => !DESKTOP_RUNTIME_ENV.includes(name));
  assertEquals(
    missing.map(([name, file]) => `${name} (${file})`),
    [],
    "add these to DESKTOP_RUNTIME_ENV (src/build/desktop-runtime-env.ts)",
  );
  assertEquals(found.unresolved, [], "a constant name read that does not resolve to a string");
});

Deno.test("desktop runtime env: no listed variable is stale, and the list is sorted and unique", () => {
  const stale = DESKTOP_RUNTIME_ENV.filter((name) => !found.names.has(name));
  assertEquals(stale, [], "no desktop runtime module reads these any more: drop them");
  assertEquals([...DESKTOP_RUNTIME_ENV], [...new Set(DESKTOP_RUNTIME_ENV)].sort());
});

Deno.test("desktop runtime env: reads that name no variable are the known wrappers", () => {
  assertEquals(Object.fromEntries([...found.dynamic].sort()), DYNAMIC_READS);
  assertEquals(Object.fromEntries([...found.whole].sort()), WHOLE_ENV_READS);
  assertEquals([...found.forwarded].sort(), [...FORWARDED].sort());
});

Deno.test("desktop runtime env: the scan sees a literal, a constant, a wrapper and process.env", () => {
  const code = stripComments([
    'const A_ENV = "A_VAR"; shellPathEnv(os, "open");',
    'Deno.env.get("B_VAR"); Deno.env.get(A_ENV); env("C_VAR"); process.env.D_VAR;',
    'proxyEnv(x ? "E_VAR" : "F_VAR"); // Deno.env.get("COMMENTED")',
    "Deno.env.get(name); Deno.env.toObject(); envGet(key);",
  ].join("\n"));
  const inv = inventory(new Map([[join(ROOT, "x.ts"), code]]));
  assertEquals(
    [...inv.names.keys()].sort(),
    ["A_VAR", "B_VAR", "C_VAR", "D_VAR", "E_VAR", "F_VAR", "e_var", "f_var"],
  );
  assertEquals(inv.dynamic.get("x.ts"), 1);
  assertEquals(inv.whole.get("x.ts"), 1);
  assertEquals([...inv.forwarded].sort(), ["x.ts envGet", "x.ts shellPathEnv"]);
});
