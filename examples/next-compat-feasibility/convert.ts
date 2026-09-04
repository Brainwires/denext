#!/usr/bin/env -S deno run -A
/**
 * convert.ts — prototype `package.json` -> `deno.json` converter for denext.
 *
 * This is the missing piece the drop-in claim hinges on: turn a third-party
 * Next.js app's `package.json` (+ its route tree) into a denext `deno.json`
 * import map automatically, and report exactly what could and couldn't be
 * converted. It doubles as the spec for a future `denext migrate` command.
 *
 * What it does:
 *   1. Reads the target app's package.json dependencies + devDependencies.
 *   2. Aliases the React/Next family onto denext (resolved against a LOCAL denext
 *      checkout via that repo's own deno.json "exports", so we can test an
 *      unreleased 1.0), passes other npm deps through as `npm:name@version`, and
 *      FLAGS anything denext can't support (native addons, Prisma, etc.).
 *   3. Scans app/ for the App Router tree and emits a next-compat page manifest
 *      (routePath/filePath/layouts) — the wiring the migration guide currently
 *      makes you write by hand.
 *   4. Writes deno.json into the app and prints a conversion REPORT to stdout.
 *
 * Usage:
 *   deno run -A convert.ts --app <app-dir> --denext <denext-repo-dir> [--write]
 */
import { join, relative } from "@std/path";

type Json = Record<string, unknown>;

function arg(name: string, fallback?: string): string {
  const i = Deno.args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < Deno.args.length) return Deno.args[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}
const WRITE = Deno.args.includes("--write");

// Canonicalize both roots (realpath) so the absolute file:// URLs we emit for
// path aliases (e.g. "@/") match the canonical paths denext's build keys its CSS
// shim redirects under. On symlinked roots (macOS /tmp, symlinked homes/worktrees)
// a raw vs. realpath mismatch makes those redirects miss and `.css` imports crash.
const APP = Deno.realPathSync(arg("app"));
const DENEXT = Deno.realPathSync(arg("denext"));

// --- 1. denext's own export map -> concrete local file targets -----------------
const denextCfg = JSON.parse(
  await Deno.readTextFile(join(DENEXT, "deno.json")),
) as { exports: Record<string, string> };

// specifier the app will write  ->  denext export key that satisfies it
const DENEXT_ALIASES: Record<string, string> = {
  "react": ".",
  "react/jsx-runtime": "./react/jsx-runtime",
  "react/jsx-dev-runtime": "./react/jsx-dev-runtime",
  "react-dom": "./react-dom",
  "react-dom/client": "./react-dom/client",
  "react-is": "./react-is",
  "next": "./next",
  "next-intl": "./next-intl",
  "better-sqlite3": "./better-sqlite3",
  // denext's own generated bundles/entries import these bare specifiers, so the
  // app's import map must resolve them even though app code never writes them.
  "denext": ".",
  "denext/client": "./client",
  "denext/server": "./server",
  "denext/jsx-runtime": "./jsx-runtime",
  "denext/compiler-runtime": "./compiler-runtime",
};
// react is the `.` export (mod.ts) re-exported through ./react in real denext;
// prefer the dedicated react entry when present.
if (denextCfg.exports["./react"]) DENEXT_ALIASES["react"] = "./react";

function localFile(exportKey: string): string {
  const rel = denextCfg.exports[exportKey];
  if (!rel) throw new Error(`denext has no export "${exportKey}"`);
  return "file://" + join(DENEXT, rel);
}

// Prefix maps for the wildcard families (next/*, next-intl/*).
const PREFIX_ALIASES: Record<string, string> = {
  "next/": "file://" + join(DENEXT, "src/compat/next") + "/",
  "next-intl/": "file://" + join(DENEXT, "src/compat/next-intl") + "/",
};
// react-dom/server isn't a public export but the compat module exists.
const REACT_DOM_SERVER = join(DENEXT, "src/compat/react-dom-server.ts");

// --- 2. classify the app's dependencies ---------------------------------------
const pkg = JSON.parse(
  await Deno.readTextFile(join(APP, "package.json")),
) as { dependencies?: Json; devDependencies?: Json };
const deps: Record<string, string> = {
  ...(pkg.dependencies ?? {}) as Record<string, string>,
  ...(pkg.devDependencies ?? {}) as Record<string, string>,
};

// Packages denext provides itself — never pass these to npm.
const DENEXT_OWNED = new Set([
  "react",
  "react-dom",
  "react-is",
  "next",
  "next-intl",
  "better-sqlite3",
]);
// Native addons / build-time engines denext cannot run — hard flags.
const HARD_UNSUPPORTED = /^(@prisma\/|prisma$|@swc\/core|node-gyp|canvas$)/;
// Deps that are no-ops under denext (it has its own pipeline) — soft-drop.
const SOFT_DROP = new Set([
  "sharp",
  "eslint-config-next",
  "@next/eslint-plugin-next",
]);

const imports: Record<string, string> = {};
const aliased: string[] = [];
const passthrough: string[] = [];
const flagged: string[] = [];
const dropped: string[] = [];

// --- translate the app's tsconfig `paths` (e.g. "@/*") into deno import map ---
// Next apps universally use "@/..." aliases; without this every app-internal
// import fails to resolve. A tsconfig `"@/*": ["./*"]` becomes `"@/": "./"`.
async function readTsconfigPaths(): Promise<Record<string, string>> {
  for (const f of ["tsconfig.json", "jsconfig.json"]) {
    try {
      return pathsToImports(
        parseTsconfig(await Deno.readTextFile(join(APP, f))),
      );
    } catch { /* try next */ }
  }
  return {};
}

interface TsconfigPaths {
  paths: Record<string, string[]>;
  baseUrl: string;
}

/** tsconfig allows comments/trailing commas; strip the common cases before parsing. */
function parseTsconfig(raw: string): TsconfigPaths {
  const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  const cfg = JSON.parse(cleaned) as {
    compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string };
  };
  const { paths = {}, baseUrl = "." } = cfg.compilerOptions ?? {};
  return { paths, baseUrl };
}

/** Every `paths` entry with a target → an import-map prefix entry. */
function pathsToImports(cfg: TsconfigPaths): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, arr] of Object.entries(cfg.paths)) {
    if (arr?.length) out[aliasKey(k)] = aliasTarget(arr[0], cfg.baseUrl);
  }
  return out;
}

/** "@/*" -> "@/" (an import-map prefix key). */
function aliasKey(k: string): string {
  return k.endsWith("/*") ? k.slice(0, -1) : k;
}

/** "./*" -> "./<base>/" (an import-map prefix target, relative to the app). */
function aliasTarget(target: string, base: string): string {
  const val = dotRelative(aliasKey(target));
  return base !== "." && val === "./" ? "./" + base + "/" : val;
}

/** Ensure a `./` prefix on a bare relative target. */
function dotRelative(val: string): string {
  return val.startsWith(".") ? val : "./" + val;
}

const tsPaths = await readTsconfigPaths();

// Wire the denext aliases + wildcard families up front.
for (const [spec, key] of Object.entries(DENEXT_ALIASES)) {
  imports[spec] = localFile(key);
}
// App path aliases (after denext, before npm) — never let these clobber react/next.
// Emit prefix keys ("@/") as ABSOLUTE dir URLs with a trailing slash: the import-map
// spec requires prefix targets to end in "/", and a relative "./" loses the slash
// once a toolchain absolutizes it.
for (const [k, v] of Object.entries(tsPaths)) {
  if (k in imports) continue;
  if (k.endsWith("/")) {
    imports[k] = ("file://" + join(APP, v)).replace(/\/?$/, "/");
  } else {
    imports[k] = v;
  }
}
for (const [prefix, target] of Object.entries(PREFIX_ALIASES)) {
  imports[prefix] = target;
}
imports["react-dom/server"] = "file://" + REACT_DOM_SERVER;

for (const [name, version] of Object.entries(deps)) {
  if (DENEXT_OWNED.has(name)) {
    aliased.push(name);
    continue;
  }
  if (SOFT_DROP.has(name)) {
    dropped.push(`${name} (denext provides its own; not needed)`);
    continue;
  }
  if (HARD_UNSUPPORTED.test(name)) {
    flagged.push(
      `${name}@${version} — native/engine dep, will NOT run on Deno`,
    );
    continue;
  }
  if (name.startsWith("@types/") || name.startsWith("eslint")) {
    dropped.push(`${name} (dev-only tooling)`);
    continue;
  }
  // Pass through as an `npm:` entry so the bundler + next-compat build resolve the
  // package (incl. deep subpath imports like `next-themes/dist/types`). The
  // next-compat SSR/client bundles rewrite each lib's internal `import "react"`
  // to denext at bundle time, so a single React runs on both server and client.
  imports[name] = `npm:${name}@${version.replace(/^[\^~]/, "")}`;
  passthrough.push(name);
}

// --- 3. discover the App Router route tree ------------------------------------
async function appDir(): Promise<string | null> {
  for (const d of ["app", "src/app"]) {
    try {
      if ((await Deno.stat(join(APP, d))).isDirectory) return join(APP, d);
    } catch { /* nope */ }
  }
  return null;
}
async function hasPagesRouter(): Promise<boolean> {
  for (const d of ["pages", "src/pages"]) {
    try {
      if ((await Deno.stat(join(APP, d))).isDirectory) return true;
    } catch { /* nope */ }
  }
  return false;
}

type RouteEntry = { routePath: string; filePath: string; layouts: string[] };
const routes: RouteEntry[] = [];
/** `layouts` plus this dir's `layout.tsx` when it has one. */
async function layoutsAt(dir: string, layouts: string[]): Promise<string[]> {
  try {
    await Deno.stat(join(dir, "layout.tsx"));
    return [...layouts, relative(APP, join(dir, "layout.tsx"))];
  } catch {
    return layouts; // no layout at this level
  }
}

async function walk(dir: string, layouts: string[]) {
  const local = await layoutsAt(dir, layouts);
  for await (const e of Deno.readDir(dir)) {
    const full = join(dir, e.name);
    if (e.isDirectory) await walk(full, local);
    else if (/^page\.(t|j)sx?$/.test(e.name)) routes.push(await routeEntry(dir, full, local));
  }
}

/** The route for a `page.*` file: its URL path (route groups dropped) and layouts. */
async function routeEntry(dir: string, full: string, layouts: string[]): Promise<RouteEntry> {
  const root = (await appDir())!;
  const seg = relative(root, dir).replace(/\\/g, "/");
  const routePath = "/" + seg.replace(/\(.*?\)\/?/g, "").replace(/\/$/, "");
  return { routePath, filePath: relative(APP, full), layouts };
}

const root = await appDir();
const pagesRouter = await hasPagesRouter();
if (root) await walk(root, []);

// --- 4. emit deno.json + next-compat manifest ---------------------------------
const denoJson = {
  // "auto": Deno manages node_modules from its cache. (We explored "manual" +
  // node_modules React shims to fix dual-React at SSR, but it conflicts with
  // denext's own npm deps, which a manual app node_modules can't resolve — see
  // ROADMAP.md → Engineering backlog / the dual-React notes. Left on "auto" as the
  // build-passing baseline until dual-React is solved at the SSR layer.)
  nodeModulesDir: "auto",
  // Next apps write extensionless imports ("@/x", "next/link"); denext's toolchain
  // and Deno both need sloppy-imports to resolve them. Put it in config so the
  // build/start commands inherit it too.
  unstable: ["sloppy-imports"],
  compilerOptions: {
    jsx: "react-jsx",
    jsxImportSource: "react", // aliased to denext above
    lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
    strict: true,
    // Skip checking npm libraries' bundled `.d.ts` (as Next.js/CRA do) — with
    // `react` aliased to denext they'd otherwise report harmless type-shim
    // mismatches deep in node_modules. Your own `.tsx` is still fully checked.
    skipLibCheck: true,
  },
  imports,
};

if (WRITE) {
  await Deno.writeTextFile(
    join(APP, "deno.json"),
    JSON.stringify(denoJson, null, 2) + "\n",
  );
  // The next-compat page manifest — feeds buildNextCompatPages, which builds each
  // page's SSR + client bundle with `react` rewritten to denext (dual-React fix).
  await Deno.writeTextFile(
    join(APP, "denext.pages.json"),
    JSON.stringify(routes, null, 2) + "\n",
  );
}

// --- 5. REPORT ----------------------------------------------------------------
const R: string[] = [];
R.push("# denext conversion report\n");
R.push(`App:    ${APP}`);
R.push(
  `denext: ${DENEXT} (v${(denextCfg as unknown as { version?: string }).version ?? "?"})`,
);
R.push("");
R.push(
  `Router:        ${root ? `App Router (${relative(APP, root)}/)` : "none found"}`,
);
R.push(
  `Pages Router:  ${
    pagesRouter ? "⚠️  PRESENT — unsupported, those routes will NOT convert" : "absent ✅"
  }`,
);
R.push(`Routes found:  ${routes.length}`);
R.push(
  `tsconfig paths: ${
    Object.keys(tsPaths).length
      ? Object.entries(tsPaths).map(([k, v]) => `${k}→${v}`).join(", ")
      : "none"
  }`,
);
R.push("");
R.push(`## Dependency conversion (${Object.keys(deps).length} total)`);
R.push(`- aliased to denext (${aliased.length}): ${aliased.join(", ") || "—"}`);
R.push(
  `- passed through to npm (${passthrough.length}): ${passthrough.join(", ") || "—"}`,
);
R.push(`- dropped (${dropped.length}): ${dropped.join("; ") || "—"}`);
R.push(
  `- ⚠️  FLAGGED unsupported (${flagged.length}): ${flagged.join("; ") || "none 🎉"}`,
);
R.push("");
R.push(
  WRITE
    ? "Wrote deno.json + denext.pages.json into the app."
    : "(dry run — pass --write to emit files)",
);
console.log(R.join("\n"));

// Non-zero exit if we hit a hard blocker, so the harness can branch.
if (flagged.length > 0 || pagesRouter) Deno.exit(2);
