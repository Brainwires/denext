// `denext migrate` — convert an existing React app (Next.js App Router, or a Vite
// SPA) to run on denext by generating denext config files. Does NOT touch the app's
// source (run the codemod separately to rewrite imports to native denext).
//
// Next path: reads package.json (+ tsconfig paths) and writes a deno.json import map
// that aliases the react/next family to denext, passes other npm deps through, and
// translates path aliases (`@/…`). The next-compat build/SSR pipeline rewrites
// react→denext at bundle time so npm React libraries run on denext's single React.
//
// Vite SPA path: detects a `vite.config.*` (no `next.config.*`) with React, and
// writes a deno.json (react aliases + tsconfig `~/` path alias) + a `denext.config.ts`
// with `mode:"spa"`, `compatibilityMode:true`, the Tailwind and `spa.env` blocks
// derived from the Vite config/usage, and — with `--desktop` — a `desktop.ts` entry
// and `spa.proxy` for a `deno desktop` build.

import { dirname, join } from "@std/path";
import { frameworkRoot } from "./bundle.ts";

/** react/next specifiers → denext JSR subpath (matches denext's deno.json exports). */
const DENEXT_ALIASES: Record<string, string> = {
  "react": "react",
  "react-dom": "react-dom",
  "react-dom/client": "react-dom/client",
  "react-dom/server": "react-dom/server",
  "react/jsx-runtime": "react/jsx-runtime",
  "react/jsx-dev-runtime": "react/jsx-dev-runtime",
  "react-is": "react-is",
  "next": "next",
  "next-intl": "next-intl",
  "better-sqlite3": "better-sqlite3",
};
/** react-family specifiers → denext JSR subpath, for a client-only Vite SPA (no next/*). */
const SPA_REACT_ALIASES: Record<string, string> = {
  "react": "react",
  "react-dom": "react-dom",
  "react-dom/client": "react-dom/client",
  "react/jsx-runtime": "react/jsx-runtime",
  "react/jsx-dev-runtime": "react/jsx-dev-runtime",
  "react-is": "react-is",
};
/** Packages denext provides — never pass to npm. */
const DENEXT_OWNED = new Set([
  "react",
  "react-dom",
  "react-is",
  "next",
  "next-intl",
  "better-sqlite3",
]);
/** The `@denext/pages-router` plugin specifier written for a `pages/` app. */
const PAGES_ROUTER_SPEC = "jsr:@denext/pages-router@^0.3.0";
/** Native/engine deps denext can't run — flag them. */
const HARD_UNSUPPORTED = /^(@prisma\/|prisma$|@swc\/core|node-gyp|canvas$)/;
/** Deps that are no-ops under denext (its own pipeline). */
const SOFT_DROP = new Set(["sharp", "eslint-config-next", "@next/eslint-plugin-next", "next"]);

/** Options controlling what a migration run emits. */
export interface MigrateOptions {
  /** Emit `desktop.ts` + a `desktop` task (Vite SPA path); with {@link backend}, also `spa.proxy`. */
  desktop?: boolean;
  /** Backend origin for the desktop reverse proxy (e.g. `"http://127.0.0.1:3773"`). */
  backend?: string;
  /** Proxy path prefixes; when omitted, parsed from a literal `vite.config` proxy, else `["/api"]`. */
  proxyPrefixes?: string[];
}

/** SPA-specific portion of a migration result. */
export interface SpaMigrateInfo {
  entry: string;
  title: string;
  envKeys: string[];
  tailwind: boolean;
  proxy?: { prefixes: string[]; target: string };
  /** `denext.config.ts` was written (false when one already existed). */
  configWritten: boolean;
  /** `desktop.ts` was written (false when `--desktop` off or one already existed). */
  desktopWritten: boolean;
  nodeModulesDir: "manual" | "auto";
}

/** Result of a migration run (for the CLI to print). */
export interface MigrateResult {
  kind: "next" | "spa";
  /** Files written by this run (deno.json, and for SPA the config/desktop entries). */
  wrote: string[];
  aliased: string[];
  passthrough: string[];
  dropped: string[];
  flagged: string[];
  pagesRouter: boolean;
  /** A `denext.config.ts` wiring the pages-router plugin was written by migrate. */
  pagesConfigWritten: boolean;
  /** A `denext.config.ts` already existed — the user must add `pagesRouter()` by hand. */
  pagesConfigExists: boolean;
  /** Present when {@link kind} is `"spa"`. */
  spa?: SpaMigrateInfo;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    // tsconfig allows comments/trailing commas.
    const raw = (await Deno.readTextFile(path))
      .replace(/\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function denextVersion(): string {
  try {
    const cfg = JSON.parse(Deno.readTextFileSync(join(frameworkRoot(), "deno.json"))) as {
      version?: string;
    };
    return cfg.version ? `@^${cfg.version}` : "";
  } catch {
    return "";
  }
}

/**
 * Convert the Next.js project at `dir` to a denext `deno.json`. Returns a summary;
 * throws only on unreadable package.json.
 */
export async function migrateProject(
  dir: string,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const pkg = await readJson(join(dir, "package.json"));
  if (!pkg) throw new Error(`no package.json found in ${dir}`);
  const deps: Record<string, string> = {
    ...(pkg.dependencies as Record<string, string> ?? {}),
    ...(pkg.devDependencies as Record<string, string> ?? {}),
  };

  // A Vite SPA (vite.config.* present, no next.config.*, React in deps) takes the
  // SPA path — `mode:"spa"` + a generated denext.config.ts. Everything else is treated
  // as a Next.js App Router project.
  if (await isViteSpa(dir, deps)) {
    return await migrateSpaProject(dir, deps, options);
  }

  const V = denextVersion();
  const jsr = (sub: string) => `jsr:@denext/denext${V}/${sub}`;
  const imports: Record<string, string> = {
    "denext": `jsr:@denext/denext${V}`,
    "denext/jsx-runtime": jsr("jsx-runtime"),
    "denext/server": jsr("server"),
    "denext/client": jsr("client"),
  };
  for (const [spec, sub] of Object.entries(DENEXT_ALIASES)) imports[spec] = jsr(sub);
  imports["next/"] = jsr("next/");
  imports["next-intl/"] = jsr("next-intl/");

  // tsconfig/jsconfig path aliases (e.g. "@/*": ["./*"]).
  const ts = (await readJson(join(dir, "tsconfig.json"))) ??
    (await readJson(join(dir, "jsconfig.json")));
  const tsPaths = (ts?.compilerOptions as { paths?: Record<string, string[]> })?.paths ?? {};
  for (const [k, arr] of Object.entries(tsPaths)) {
    if (!arr?.length) continue;
    const key = k.endsWith("/*") ? k.slice(0, -1) : k;
    let val = arr[0].endsWith("/*") ? arr[0].slice(0, -1) : arr[0];
    if (!val.startsWith(".")) val = "./" + val;
    if (!(key in imports)) imports[key] = val;
  }

  const aliased: string[] = [];
  const passthrough: string[] = [];
  const dropped: string[] = [];
  const flagged: string[] = [];
  for (const [name, version] of Object.entries(deps)) {
    if (DENEXT_OWNED.has(name)) aliased.push(name);
    else if (SOFT_DROP.has(name)) dropped.push(name);
    else if (HARD_UNSUPPORTED.test(name)) flagged.push(`${name}@${version}`);
    else if (name.startsWith("@types/") || name.startsWith("eslint")) dropped.push(name);
    else {
      imports[name] = `npm:${name}@${version.replace(/^[\^~]/, "")}`;
      passthrough.push(name);
    }
  }

  const pagesRouter = await exists(join(dir, "pages")) || await exists(join(dir, "src/pages"));

  // A Pages Router app runs on the @denext/pages-router plugin: map its specifier
  // and scaffold a denext.config.ts that registers the plugin (the codemod rewrites
  // the app's next/router|head|link imports to the plugin's compat modules).
  let pagesConfigWritten = false;
  let pagesConfigExists = false;
  if (pagesRouter) {
    imports["@denext/pages-router"] = PAGES_ROUTER_SPEC;
    imports["@denext/pages-router/"] = PAGES_ROUTER_SPEC + "/";
    const configPath = join(dir, "denext.config.ts");
    if (await exists(configPath)) {
      pagesConfigExists = true;
    } else {
      await Deno.writeTextFile(
        configPath,
        `import { pagesRouter } from "@denext/pages-router";\n\n` +
          `export default {\n  plugins: [pagesRouter()],\n};\n`,
      );
      pagesConfigWritten = true;
    }
  }

  const denoJson = {
    nodeModulesDir: "auto",
    unstable: ["sloppy-imports"],
    compilerOptions: {
      jsx: "react-jsx",
      jsxImportSource: "react",
      lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
      strict: true,
      // npm React libraries ship their own `@types/react`-based `.d.ts`; with
      // `react` aliased to denext they'd be re-checked against denext's type shim
      // and report harmless mismatches deep in node_modules. Skip declaration-file
      // checking (as Next.js/CRA do) so `deno check` validates YOUR code, not the
      // libraries' bundled types. Your `.tsx` is still fully type-checked.
      skipLibCheck: true,
    },
    imports,
  };
  const wrote = join(dir, "deno.json");
  await Deno.writeTextFile(wrote, JSON.stringify(denoJson, null, 2) + "\n");
  return {
    kind: "next",
    wrote: [wrote],
    aliased,
    passthrough,
    dropped,
    flagged,
    pagesRouter,
    pagesConfigWritten,
    pagesConfigExists,
  };
}

// ── Vite SPA migration ──────────────────────────────────────────────────────

/** True for a Vite React SPA: a `vite.config.*`, no `next.config.*`, React in deps. */
async function isViteSpa(dir: string, deps: Record<string, string>): Promise<boolean> {
  const vite = await anyExists(dir, ["vite.config.ts", "vite.config.js", "vite.config.mts"]);
  if (!vite) return false;
  const next = await anyExists(dir, ["next.config.ts", "next.config.js", "next.config.mjs"]);
  if (next) return false;
  return "react" in deps || "react-dom" in deps;
}

/** deno.json `nodeModulesDir: "manual"` when a pnpm lockfile/workspace is found (here or above). */
async function detectPnpm(dir: string): Promise<boolean> {
  let cur = dir;
  for (let i = 0; i < 6; i++) {
    if (await anyExists(cur, ["pnpm-lock.yaml", "pnpm-workspace.yaml"])) return true;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return false;
}

/** Entry module + title from `index.html` (`<script type=module src>` / `<title>`). */
async function readIndexHtml(dir: string): Promise<{ entry: string; title: string }> {
  const html = await Deno.readTextFile(join(dir, "index.html")).catch(() => null);
  let entry = "./src/main.tsx";
  let title = "app";
  if (html) {
    const m = html.match(/<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/i) ??
      html.match(/<script[^>]*src=["']([^"']+)["'][^>]*type=["']module["']/i);
    if (m) {
      const src = m[1];
      entry = src.startsWith("/") ? "." + src : src.startsWith(".") ? src : "./" + src;
    }
    const t = html.match(/<title>([^<]*)<\/title>/i);
    if (t && t[1].trim()) title = t[1].trim();
  }
  return { entry, title };
}

/** `import.meta.env.*` names used across vite.config + `src/` — the seed for `spa.env`. */
async function collectSpaEnvKeys(dir: string): Promise<string[]> {
  const BUILTIN = new Set(["MODE", "DEV", "PROD", "SSR", "BASE_URL"]);
  const keys = new Set<string>();
  const scan = (text: string) => {
    for (const m of text.matchAll(/import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!BUILTIN.has(m[1])) keys.add(m[1]);
    }
  };
  for (const f of ["vite.config.ts", "vite.config.js", "vite.config.mts"]) {
    const t = await Deno.readTextFile(join(dir, f)).catch(() => null);
    if (t) scan(t);
  }
  await walkCode(join(dir, "src"), scan);
  return [...keys].sort();
}

/** Recursively feed every code file's text to `scan` (skips node_modules/dist/.denext). */
async function walkCode(root: string, scan: (text: string) => void): Promise<void> {
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(root);
  } catch {
    return;
  }
  for await (const e of entries) {
    if (e.isDirectory) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".denext") continue;
      await walkCode(join(root, e.name), scan);
    } else if (/\.(tsx?|jsx?|mts|mjs)$/.test(e.name)) {
      const t = await Deno.readTextFile(join(root, e.name)).catch(() => null);
      if (t) scan(t);
    }
  }
}

/** Best-effort prefixes from a *literal* `proxy: { "/api": … }` in vite.config (else undefined). */
async function parseViteProxyPrefixes(dir: string): Promise<string[] | undefined> {
  for (const f of ["vite.config.ts", "vite.config.js", "vite.config.mts"]) {
    const t = await Deno.readTextFile(join(dir, f)).catch(() => null);
    if (!t) continue;
    const block = t.match(/proxy\s*:\s*\{([\s\S]*?)\n\s*\}/);
    if (block) {
      const keys = [...block[1].matchAll(/["'`](\/[^"'`]+)["'`]\s*:/g)].map((x) => x[1]);
      if (keys.length) return keys;
    }
  }
  return undefined;
}

/** Source text for the generated `denext.config.ts`. */
function spaConfigSource(o: {
  entry: string;
  title: string;
  envKeys: string[];
  tailwind: boolean;
  proxy?: { prefixes: string[]; target: string };
}): string {
  const needsPkg = o.envKeys.includes("APP_VERSION");
  const envLines = o.envKeys
    .map((k) => (k === "APP_VERSION" ? `      APP_VERSION: pkg.version,` : `      ${k}: "",`))
    .join("\n");
  const tailwindBlock = o.tailwind
    ? `  tailwind: { input: "./src/index.css", output: "./src/index.gen.css" },\n`
    : "";
  const proxyBlock = o.proxy
    ? `    proxy: {\n      prefixes: [${
      o.proxy.prefixes.map((p) => JSON.stringify(p)).join(", ")
    }],\n      target: ${JSON.stringify(o.proxy.target)},\n    },\n`
    : "";
  return `import type { DenextConfig } from "denext/server";\n` +
    (needsPkg ? `import pkg from "./package.json" with { type: "json" };\n` : "") +
    `\n` +
    `export default {\n` +
    `  mode: "spa",\n` +
    `  compatibilityMode: true,\n` +
    tailwindBlock +
    `  spa: {\n` +
    `    entry: ${JSON.stringify(o.entry)},\n` +
    `    title: ${JSON.stringify(o.title)},\n` +
    (envLines ? `    env: {\n${envLines}\n    },\n` : "") +
    proxyBlock +
    `  },\n` +
    `} satisfies DenextConfig;\n`;
}

/** Source text for the generated `deno desktop` entry (`desktop.ts`). */
function spaDesktopSource(hasProxy: boolean): string {
  const head =
    `// Entry for \`deno desktop\` — serves the static export in \`out/\` inside a native\n` +
    `// window (run \`deno task export\` first, or \`deno task desktop\`).\n`;
  if (hasProxy) {
    return head +
      `// The backend reverse proxy is configured via \`spa.proxy\` in denext.config.ts.\n` +
      `import { runDesktop } from "denext/desktop";\n` +
      `import config from "./denext.config.ts";\n\n` +
      `await runDesktop({ importMetaUrl: import.meta.url, proxy: config.spa?.proxy });\n`;
  }
  return head +
    `import { runDesktop } from "denext/desktop";\n\n` +
    `await runDesktop({ importMetaUrl: import.meta.url });\n`;
}

/** deno.json tasks for a SPA (dev/build/export/start, plus desktop when requested). */
function spaTasks(desktop: boolean): Record<string, string> {
  const tasks: Record<string, string> = {
    dev: "deno run -A jsr:@denext/denext/cli dev .",
    build: "deno run -A jsr:@denext/denext/cli build .",
    export: "deno run -A jsr:@denext/denext/cli export .",
    start: "deno run --allow-net --allow-read --allow-env jsr:@denext/denext/cli start .",
  };
  if (desktop) {
    // `--node-modules-dir=none` resolves the desktop runtime's npm deps (denext's
    // `ws`, for the proxy's WebSocket bridge) from Deno's global cache rather than the
    // app's `nodeModulesDir:"manual"` tree, which does not carry them.
    tasks.desktop = "deno task export && deno desktop --node-modules-dir=none desktop.ts";
  }
  return tasks;
}

/** Generate denext SPA config files (deno.json + denext.config.ts [+ desktop.ts]). */
async function migrateSpaProject(
  dir: string,
  deps: Record<string, string>,
  options: MigrateOptions,
): Promise<MigrateResult> {
  const V = denextVersion();
  const jsr = (sub: string) => `jsr:@denext/denext${V}/${sub}`;
  const manual = await detectPnpm(dir);

  const imports: Record<string, string> = {
    "denext": `jsr:@denext/denext${V}`,
    "denext/jsx-runtime": jsr("jsx-runtime"),
    "denext/jsx-dev-runtime": jsr("jsx-dev-runtime"),
    "denext/server": jsr("server"),
    "denext/client": jsr("client"),
  };
  for (const [spec, sub] of Object.entries(SPA_REACT_ALIASES)) imports[spec] = jsr(sub);
  if (options.desktop) imports["denext/desktop"] = jsr("desktop");

  // tsconfig/jsconfig path aliases (e.g. "~/*": ["./src/*"] → "~/": "./src/").
  const ts = (await readJson(join(dir, "tsconfig.json"))) ??
    (await readJson(join(dir, "jsconfig.json")));
  const tsPaths = (ts?.compilerOptions as { paths?: Record<string, string[]> })?.paths ?? {};
  for (const [k, arr] of Object.entries(tsPaths)) {
    if (!arr?.length) continue;
    const key = k.endsWith("/*") ? k.slice(0, -1) : k;
    let val = arr[0].endsWith("/*") ? arr[0].slice(0, -1) : arr[0];
    if (!val.startsWith(".")) val = "./" + val;
    if (!(key in imports)) imports[key] = val;
  }

  // Classify deps for the summary. With nodeModulesDir:"manual" (pnpm) the npm deps
  // resolve from the installed node_modules, so no `npm:` import entries are emitted;
  // with "auto" they are pinned as `npm:name@version` like the Next path.
  const aliased: string[] = [];
  const passthrough: string[] = [];
  const dropped: string[] = [];
  const flagged: string[] = [];
  for (const [name, version] of Object.entries(deps)) {
    if (DENEXT_OWNED.has(name)) aliased.push(name);
    else if (SOFT_DROP.has(name)) dropped.push(name);
    else if (HARD_UNSUPPORTED.test(name)) flagged.push(`${name}@${version}`);
    else if (name.startsWith("@types/") || name.startsWith("eslint")) dropped.push(name);
    else {
      passthrough.push(name);
      if (!manual) imports[name] = `npm:${name}@${version.replace(/^[\^~]/, "")}`;
    }
  }

  const { entry, title } = await readIndexHtml(dir);
  const envKeys = await collectSpaEnvKeys(dir);
  const tailwind = ("@tailwindcss/vite" in deps || "tailwindcss" in deps) &&
    await exists(join(dir, "src", "index.css"));

  let proxy: { prefixes: string[]; target: string } | undefined;
  if (options.desktop && options.backend) {
    const prefixes = options.proxyPrefixes ?? (await parseViteProxyPrefixes(dir)) ?? ["/api"];
    proxy = { prefixes, target: options.backend };
  }

  const written: string[] = [];

  // denext.config.ts (never overwrite an existing one).
  const configPath = join(dir, "denext.config.ts");
  let configWritten = false;
  if (!(await exists(configPath))) {
    await Deno.writeTextFile(
      configPath,
      spaConfigSource({ entry, title, envKeys, tailwind, proxy }),
    );
    configWritten = true;
    written.push(configPath);
  }

  // desktop.ts (only with --desktop; never overwrite).
  let desktopWritten = false;
  if (options.desktop) {
    const desktopPath = join(dir, "desktop.ts");
    if (!(await exists(desktopPath))) {
      await Deno.writeTextFile(desktopPath, spaDesktopSource(!!proxy));
      desktopWritten = true;
      written.push(desktopPath);
    }
  }

  const denoJson = {
    tasks: spaTasks(!!options.desktop),
    nodeModulesDir: manual ? "manual" : "auto",
    unstable: ["sloppy-imports"],
    compilerOptions: {
      jsx: "react-jsx",
      jsxImportSource: "react",
      lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
      // See the Next path: npm React ships its own types; skip lib-checking so
      // `deno check` validates YOUR code, not the libraries' bundled declarations.
      skipLibCheck: true,
    },
    imports,
  };
  const denoJsonPath = join(dir, "deno.json");
  await Deno.writeTextFile(denoJsonPath, JSON.stringify(denoJson, null, 2) + "\n");
  written.unshift(denoJsonPath);

  return {
    kind: "spa",
    wrote: written,
    aliased,
    passthrough,
    dropped,
    flagged,
    pagesRouter: false,
    pagesConfigWritten: false,
    pagesConfigExists: false,
    spa: {
      entry,
      title,
      envKeys,
      tailwind,
      proxy,
      configWritten,
      desktopWritten,
      nodeModulesDir: manual ? "manual" : "auto",
    },
  };
}

async function anyExists(dir: string, names: string[]): Promise<boolean> {
  for (const n of names) {
    if (await exists(join(dir, n))) return true;
  }
  return false;
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}
