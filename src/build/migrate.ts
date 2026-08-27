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

import { dirname, join, relative, resolve, toFileUrl } from "@std/path";
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
const SOFT_DROP = new Set([
  "sharp",
  "eslint-config-next",
  "@next/eslint-plugin-next",
  "next",
  // Bundler/toolchain deps denext replaces — never passed through as runtime npm.
  "react-scripts",
  "vite",
  "@vitejs/plugin-react",
  "@vitejs/plugin-react-swc",
]);

/** Options controlling what a migration run emits. */
export interface MigrateOptions {
  /** Emit `desktop.ts` + a `desktop` task (Vite SPA path); with {@link backend}, also `spa.proxy`. */
  desktop?: boolean;
  /** Backend origin for the desktop reverse proxy (e.g. `"http://127.0.0.1:3773"`). */
  backend?: string;
  /** Proxy path prefixes; when omitted, parsed from a literal `vite.config` proxy, else `["/api"]`. */
  proxyPrefixes?: string[];
  /**
   * Force the source framework instead of auto-detecting (`next` | `vite` | `cra` |
   * `generic`). Reserved for ambiguous cases; auto-detection is used when omitted.
   */
  from?: string;
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
  kind: "next" | "spa" | "cra" | "generic";
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

/**
 * Resolve the effective `compilerOptions.paths` (+ `baseUrl`) for the tsconfig/jsconfig at
 * `dir`, following `extends` and — when neither this file nor its extends-chain declares
 * paths — walking up parent directories (monorepos commonly put `paths` in a root tsconfig
 * the app tsconfig doesn't even extend). Returns the paths and the ABSOLUTE base dir they
 * resolve against (the defining file's dir + its `baseUrl`), or null when none are found.
 */
async function resolveTsPaths(
  dir: string,
): Promise<{ paths: Record<string, string[]>; baseDir: string } | null> {
  // Read a config file following its `extends` chain; paths/baseUrl are taken from the
  // nearest file in the chain that declares them, resolved against THAT file's directory.
  const readChain = async (
    file: string,
    seen = new Set<string>(),
  ): Promise<{ paths: Record<string, string[]>; baseDir: string } | null> => {
    if (seen.has(file)) return null;
    seen.add(file);
    const cfg = await readJson(file);
    if (!cfg) return null;
    const co = cfg.compilerOptions as
      | { paths?: Record<string, string[]>; baseUrl?: string }
      | undefined;
    if (co?.paths && Object.keys(co.paths).length) {
      return { paths: co.paths, baseDir: resolve(dirname(file), co.baseUrl ?? ".") };
    }
    if (typeof cfg.extends === "string") {
      const ext = cfg.extends.startsWith(".") ? resolve(dirname(file), cfg.extends) : null; // package-name extends (e.g. @tsconfig/*) aren't followed
      if (ext) {
        const withExt = ext.endsWith(".json") ? ext : ext + ".json";
        return await readChain(withExt, seen);
      }
    }
    return null;
  };

  let cur = dir;
  for (let i = 0; i < 6; i++) {
    const ts = await firstExisting(cur, ["tsconfig.json", "jsconfig.json"]);
    if (ts) {
      const r = await readChain(join(cur, ts));
      if (r) return r;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/**
 * tsconfig/jsconfig `paths` → deno.json import entries, as `[key, value]` pairs with the
 * value made RELATIVE to `appDir` (so a monorepo-root tsconfig's `./packages/x/src` becomes
 * `../packages/x/src` for an app in a subdir). A `foo/*` key/target keeps a trailing `/`
 * (prefix map); a bare key maps to the exact file.
 */
async function collectTsPathAliases(appDir: string): Promise<Array<[string, string]>> {
  const resolved = await resolveTsPaths(appDir);
  if (!resolved) return [];
  const out: Array<[string, string]> = [];
  for (const [k, arr] of Object.entries(resolved.paths)) {
    if (!arr?.length) continue;
    const isPrefix = k.endsWith("/*"); // "@x/*" is a prefix map; "@x" an exact map
    const key = isPrefix ? k.slice(0, -1) : k; // "@x/*" → "@x/"
    const rawTarget = arr[0].endsWith("/*") ? arr[0].slice(0, -2) : arr[0];
    // Absolute target (against the defining tsconfig's baseDir), then relative to appDir.
    const abs = resolve(resolved.baseDir, rawTarget);
    let val = relative(appDir, abs).replace(/\\/g, "/"); // Deno uses forward slashes
    if (!val.startsWith(".")) val = "./" + val;
    // A prefix map's target must keep a trailing slash (`resolve` strips it).
    if (isPrefix && !val.endsWith("/")) val += "/";
    out.push([key, val]);
  }
  return out;
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
 * Distinctive sentinel marking a file as migrate-generated. Its presence lets a re-run
 * overwrite the file (idempotence) while a hand-authored file of the same name is left
 * untouched — the basis of a PR's commit-parity check (`re-run migrate → git diff` clean).
 * It rides in a `.ts` comment line ({@link GEN_MARKER}) or a deno.json `"//"` key
 * ({@link GEN_MARKER_TEXT}), so deno.json stays valid strict JSON.
 */
const GEN_SENTINEL = "generated by `denext migrate`";
const GEN_MARKER_TEXT = `${GEN_SENTINEL} — safe to edit; re-running may overwrite`;
const GEN_MARKER = `// ${GEN_MARKER_TEXT}`;

/** Whether a path is absent or a previously migrate-generated file (safe to (over)write). */
async function writable(path: string): Promise<boolean> {
  const cur = await Deno.readTextFile(path).catch(() => null);
  return cur === null || cur.includes(GEN_SENTINEL);
}

/** Serialize a generated deno.json with the sentinel in a leading `"//"` key (strict JSON). */
function denoJsonText(obj: Record<string, unknown>): string {
  return JSON.stringify({ "//": GEN_MARKER_TEXT, ...obj }, null, 2) + "\n";
}

/** The next.config.* keys denext honors directly (copied as literals into denext.config). */
interface NextConfigTranslation {
  /** Literal config fields denext consumes as-is (basePath, images, i18n, …). */
  fields: Record<string, unknown>;
  /** Resolved `redirects`/`rewrites`/`headers` arrays (functions called + inlined). */
  rules: Record<string, unknown>;
  /** Recognized-but-unsupported keys (warned + dropped). */
  dropped: string[];
  /** The next.config filename that was read, or null. */
  file: string | null;
  /** True when the config couldn't be evaluated → emit a hand-port note instead. */
  raw: boolean;
  /**
   * True when the next.config wires MDX plugins (`@next/mdx`/`createMDX` with
   * remark/rehype/recma lists). `createMDX` hides those options inside a webpack loader
   * closure, so they can't be recovered from the resolved config object — emit a
   * hand-port note pointing at denext.config's `mdx` field rather than silently drop them.
   */
  mdx?: boolean;
}

/** next.config keys denext maps straight through (same names/shapes as Next). */
const NEXT_PASSTHROUGH_KEYS = [
  "basePath",
  "trailingSlash",
  "assetPrefix",
  "images",
  "i18n",
] as const;
/** `() => Rule[]` async config functions denext supports with the same signature. */
const NEXT_RULE_FNS = ["redirects", "rewrites", "headers"] as const;
/** next.config keys denext cannot honor — warned and dropped (not silently ignored). */
const NEXT_DROP_KEYS = new Set([
  "webpack",
  "compiler",
  "swcMinify",
  "output",
  "env",
  "transpilePackages",
  "experimental",
  "pageExtensions",
  "reactStrictMode",
  "poweredByHeader",
  "productionBrowserSourceMaps",
]);

/**
 * The evaluator program run as a SUBPROCESS in the app's own directory, so the config's
 * npm plugin imports (`@next/mdx`, …) and `next` resolve from the app's node_modules — not
 * denext's module graph. It imports the resolved default export, copies the honored literal
 * fields, CALLS `redirects`/`rewrites`/`headers` and inlines their resolved arrays (a
 * function can't be serialized; its result can, and denext's config takes the same shape),
 * lists dropped keys, and prints one JSON line. `import(Deno.args[0])`.
 */
const NEXT_EVAL_PROGRAM = `
const PASS = ${JSON.stringify(NEXT_PASSTHROUGH_KEYS)};
const RULES = ${JSON.stringify(NEXT_RULE_FNS)};
const DROP = ${JSON.stringify([...NEXT_DROP_KEYS])};
const mod = await import(Deno.args[0]);
let cfg = mod?.default ?? mod;
if (typeof cfg === "function") cfg = await cfg();
cfg = await cfg;
const out = { fields: {}, rules: {}, dropped: [] };
if (cfg && typeof cfg === "object") {
  for (const k of PASS) if (cfg[k] !== undefined) out.fields[k] = cfg[k];
  for (const fn of RULES) {
    if (typeof cfg[fn] === "function") {
      try { out.rules[fn] = await cfg[fn](); } catch { /* skip a rule fn that throws */ }
    }
  }
  for (const k of Object.keys(cfg)) if (DROP.includes(k)) out.dropped.push(k);
}
console.log(JSON.stringify(out));
`;

/**
 * Evaluate the app's `next.config.*` in a subprocess rooted at the app dir (so its npm
 * plugin imports resolve from the app's installed node_modules), returning the honored
 * translation. On any failure (exotic/side-effectful config, missing deps) the caller falls
 * back to a hand-port note. Returns null when there is no next.config at all.
 */
async function readNextConfig(dir: string): Promise<NextConfigTranslation | null> {
  const file = await firstExisting(dir, [
    "next.config.ts",
    "next.config.mjs",
    "next.config.js",
    "next.config.cjs",
  ]);
  if (!file) return null;
  // Scan the config SOURCE for MDX-plugin wiring: `createMDX({ options })` buries its
  // remark/recma lists in a webpack-loader closure the subprocess eval can't reach, so a
  // source signal is the only reliable detection. Trigger only when plugins are actually
  // configured (a plain `@next/mdx` with no plugins is covered by the baseline loader).
  let mdx = false;
  try {
    const src = await Deno.readTextFile(join(dir, file));
    mdx = /\b(remark|rehype|recma)Plugins\b/.test(src) ||
      (/@next\/mdx|createMDX/.test(src) && /codehike|remark-|rehype-|recma-/.test(src));
  } catch { /* unreadable — leave mdx false */ }
  const base: NextConfigTranslation = { fields: {}, rules: {}, dropped: [], file, raw: false, mdx };
  try {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "-", toFileUrl(join(dir, file)).href],
      cwd: dir,
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    });
    const child = cmd.spawn();
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(NEXT_EVAL_PROGRAM));
    await w.close();
    const { code, stdout } = await child.output();
    if (code !== 0) return { ...base, raw: true };
    const line = new TextDecoder().decode(stdout).trim().split("\n").pop() ?? "";
    const parsed = JSON.parse(line) as Pick<
      NextConfigTranslation,
      "fields" | "rules" | "dropped"
    >;
    return { ...base, ...parsed };
  } catch {
    return { ...base, raw: true };
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

  // Detect the source framework (a `--from` override wins). CRA, Vite, and generic
  // React apps all take the SPA path — `mode:"spa"` + a generated denext.config.ts,
  // differing only in how the entry/env/proxy are read. Everything else is treated
  // as a Next.js App Router project.
  const from = options.from;
  if (from !== "next" && (from === "cra" || (!from && await isCra(dir, deps)))) {
    return await migrateSpaProject(dir, deps, options, "cra");
  }
  if (from !== "next" && (from === "vite" || (!from && await isViteSpa(dir, deps)))) {
    return await migrateSpaProject(dir, deps, options, "vite");
  }
  if (from !== "next" && (from === "generic" || (!from && await isGenericSpa(dir, deps)))) {
    return await migrateSpaProject(dir, deps, options, "generic");
  }

  const { pnp } = await detectPackageManager(dir);
  if (pnp) throw pnpUnsupported(dir);
  // App Router has Deno-native build passes (the boundary/exports reader imports app
  // modules) — not only the esbuild compat bundle — so Deno itself must resolve app npm
  // deps. The proven shape is `nodeModulesDir:"auto"` + a pinned `npm:name@version` per
  // dep (these go in the generated deno.json; package.json/the lockfile are never touched).
  // Deps with an unpinnable `catalog:`/`workspace:*` version are left to the installed
  // node_modules + the default-on tolerant resolver instead of a (bogus) pin.

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

  // tsconfig/jsconfig path aliases (e.g. "@/*": ["./*"]) — follows `extends` and a
  // monorepo-root tsconfig, so a workspace app's `@scope/*` → `packages/*/src` maps resolve.
  for (const [key, val] of await collectTsPathAliases(dir)) {
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
      // Pin a concrete version so Deno resolves it in both the esbuild bundle AND the
      // native passes. A `catalog:`/`workspace:*` (non-numeric) version can't be pinned —
      // leave it to node_modules + the tolerant resolver.
      if (/^\D*\d/.test(version)) {
        imports[name] = `npm:${name}@${version.replace(/^[\^~]/, "")}`;
      }
      passthrough.push(name);
    }
  }

  const pagesRouter = await exists(join(dir, "pages")) || await exists(join(dir, "src/pages"));

  const written: string[] = [];
  let pagesConfigWritten = false;
  let pagesConfigExists = false;
  const configPath = join(dir, "denext.config.ts");

  if (pagesRouter) {
    // A Pages Router app runs on the @denext/pages-router plugin: map its specifier and
    // scaffold a denext.config.ts that registers the plugin (the codemod rewrites the
    // app's next/router|head|link imports to the plugin's compat modules).
    imports["@denext/pages-router"] = PAGES_ROUTER_SPEC;
    imports["@denext/pages-router/"] = PAGES_ROUTER_SPEC + "/";
    if (await writable(configPath)) {
      await Deno.writeTextFile(
        configPath,
        GEN_MARKER + "\n" +
          `import { pagesRouter } from "@denext/pages-router";\n\n` +
          `export default {\n  plugins: [pagesRouter()],\n};\n`,
      );
      pagesConfigWritten = true;
      written.push(configPath);
    } else {
      pagesConfigExists = true;
    }
  } else {
    // App Router: generate a full denext.config.ts (compat mode, Tailwind, next.config
    // translation, publicEnv). Never clobber a hand-authored one (no marker).
    const tailwind = ("tailwindcss" in deps || "@tailwindcss/postcss" in deps) &&
      await exists(join(dir, "src", "index.css"));
    const publicEnv = await collectNextPublicEnvKeys(dir);
    const next = await readNextConfig(dir);
    if (await writable(configPath)) {
      await Deno.writeTextFile(configPath, nextConfigSource({ tailwind, publicEnv, next }));
      written.push(configPath);
    } else {
      pagesConfigExists = true; // reuse the "config already exists" signal for the CLI hint
    }
  }

  const denoJson = {
    tasks: spaTasks(false),
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
  const denoJsonPath = join(dir, "deno.json");
  await Deno.writeTextFile(denoJsonPath, denoJsonText(denoJson));
  written.unshift(denoJsonPath);
  return {
    kind: "next",
    wrote: written,
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

/** The SPA-shaped source frameworks that share {@link migrateSpaProject}. */
type SpaSource = "vite" | "cra" | "generic";

/** True for a Create React App: `react-scripts` in deps, or `public/index.html` + React, no vite/next. */
async function isCra(dir: string, deps: Record<string, string>): Promise<boolean> {
  if ("react-scripts" in deps) return true;
  if (!(await exists(join(dir, "public", "index.html")))) return false;
  if (await anyExists(dir, ["vite.config.ts", "vite.config.js", "vite.config.mts"])) return false;
  if (await isNext(dir, deps)) return false;
  return "react" in deps || "react-dom" in deps;
}

/** True for a Next.js app: `next` in deps or a `next.config.*` present. */
async function isNext(dir: string, deps: Record<string, string>): Promise<boolean> {
  if ("next" in deps) return true;
  return await anyExists(dir, [
    "next.config.ts",
    "next.config.js",
    "next.config.mjs",
    "next.config.cjs",
  ]);
}

/** True for a generic React SPA: React + a root `index.html`, and not Vite/CRA/Next. */
async function isGenericSpa(dir: string, deps: Record<string, string>): Promise<boolean> {
  if (!("react" in deps || "react-dom" in deps)) return false;
  if (!(await exists(join(dir, "index.html")))) return false;
  if (await anyExists(dir, ["vite.config.ts", "vite.config.js", "vite.config.mts"])) return false;
  if (await isCra(dir, deps)) return false;
  if (await isNext(dir, deps)) return false;
  return true;
}

/** Entry + title for a CRA app: title from `public/index.html`, entry `./src/index.*`. */
async function readCraIndex(dir: string): Promise<{ entry: string; title: string }> {
  const html = await Deno.readTextFile(join(dir, "public", "index.html")).catch(() => null);
  let title = "app";
  if (html) {
    const t = html.match(/<title>([^<]*)<\/title>/i);
    // CRA templates often interpolate `%PUBLIC_URL%`/`%REACT_APP_*%` — strip them.
    if (t) {
      const clean = t[1].replace(/%[A-Za-z0-9_]+%/g, "").trim();
      if (clean) title = clean;
    }
  }
  let entry = "./src/index.tsx";
  for (const cand of ["index.tsx", "index.jsx", "index.ts", "index.js"]) {
    if (await exists(join(dir, "src", cand))) {
      entry = "./src/" + cand;
      break;
    }
  }
  return { entry, title };
}

/**
 * `NEXT_PUBLIC_*` env names referenced in the app — recorded in `publicEnv` so the build
 * ships them to the client even when a reference is computed (which the build's static
 * literal scan would miss). Scans `app/`, `src/`, `pages/`, `components/`, `lib/`.
 */
async function collectNextPublicEnvKeys(dir: string): Promise<string[]> {
  const keys = new Set<string>();
  const scan = (text: string) => {
    for (const m of text.matchAll(/NEXT_PUBLIC_[A-Za-z0-9_]+/g)) keys.add(m[0]);
  };
  for (const sub of ["app", "src", "pages", "components", "lib"]) {
    await walkCode(join(dir, sub), scan);
  }
  return [...keys].sort();
}

/** `process.env.REACT_APP_*` names across `src/` — the seed for a CRA app's `spa.env`. */
async function collectCraEnvKeys(dir: string): Promise<string[]> {
  const keys = new Set<string>();
  const scan = (text: string) => {
    for (const m of text.matchAll(/process\.env\.(REACT_APP_[A-Za-z0-9_]+)/g)) keys.add(m[1]);
  };
  await walkCode(join(dir, "src"), scan);
  return [...keys].sort();
}

/** The app's package manager, inferred from its lockfile (searched here + up to 6 parents). */
export type PackageManager = "pnpm" | "yarn" | "npm" | "bun";

/** PM detection result. `pnp` = a Yarn Plug'n'Play install (no `node_modules` tree). */
export interface PmInfo {
  pm: PackageManager | null;
  pnp: boolean;
}

/**
 * Detect the app's package manager by lockfile, walking up to 6 dirs (monorepo-aware),
 * and whether it is a Yarn PnP install. denext consumes the app's own installed
 * `node_modules`, so the PM choice only affects `nodeModulesDir` and whether the build
 * relies on a prior install — it never changes which PM the consumer runs.
 */
async function detectPackageManager(dir: string): Promise<PmInfo> {
  let cur = dir;
  let pm: PackageManager | null = null;
  let pnp = false;
  for (let i = 0; i < 6; i++) {
    // PnP ships no node_modules — resolution goes through .pnp.cjs, which denext's
    // file-based resolver cannot read. Flag it so migrate can guide the user.
    if (!pnp && await anyExists(cur, [".pnp.cjs", ".pnp.loader.mjs"])) pnp = true;
    if (pm === null) {
      if (await anyExists(cur, ["pnpm-lock.yaml", "pnpm-workspace.yaml"])) pm = "pnpm";
      else if (await anyExists(cur, ["bun.lockb", "bun.lock"])) pm = "bun";
      else if (await exists(join(cur, "yarn.lock"))) pm = "yarn";
      else if (await exists(join(cur, "package-lock.json"))) pm = "npm";
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { pm, pnp };
}

/** Message thrown when the app uses Yarn PnP (unsupported — needs a real node_modules). */
function pnpUnsupported(dir: string): Error {
  return new Error(
    `${dir} is a Yarn Plug'n'Play install (.pnp.cjs) — denext resolves the app's ` +
      `node_modules on disk, which PnP does not create.\n` +
      `Fix: add \`nodeLinker: node-modules\` to .yarnrc.yml and re-run \`yarn install\`, ` +
      `then \`denext migrate\` again.`,
  );
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
  // `Deno.readDir` is lazy — a missing/again-unreadable dir throws while iterating, not at
  // the call — so the guard must wrap the whole loop (App Router apps have no `src/`).
  try {
    for await (const e of Deno.readDir(root)) {
      if (e.isDirectory) {
        if (e.name === "node_modules" || e.name === "dist" || e.name === ".denext") continue;
        await walkCode(join(root, e.name), scan);
      } else if (/\.(tsx?|jsx?|mts|mjs)$/.test(e.name)) {
        const t = await Deno.readTextFile(join(root, e.name)).catch(() => null);
        if (t) scan(t);
      }
    }
  } catch {
    // missing dir → nothing to scan
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
  return GEN_MARKER + "\n" +
    `import type { DenextConfig } from "denext/server";\n` +
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

/**
 * Source text for an App Router app's generated `denext.config.ts`. Carries
 * `compatibilityMode:true`, an optional `tailwind` block, `publicEnv` for statically-seen
 * computed public-env keys, and the honored next.config translation: literal fields inlined,
 * `redirects`/`rewrites`/`headers` re-exported as function refs from the original next.config
 * (preserving dynamic logic), unsupported keys listed in a hand-port comment.
 */
function nextConfigSource(o: {
  tailwind: boolean;
  publicEnv: string[];
  next: NextConfigTranslation | null;
}): string {
  const bodyLines: string[] = [`  compatibilityMode: true,`];

  if (o.tailwind) {
    bodyLines.push(`  tailwind: { input: "./src/index.css", output: "./src/index.gen.css" },`);
  }
  if (o.publicEnv.length) {
    bodyLines.push(`  publicEnv: [${o.publicEnv.map((k) => JSON.stringify(k)).join(", ")}],`);
  }

  const notes: string[] = [];
  if (o.next?.raw) {
    notes.push(
      `  // NOTE: your ${o.next.file} could not be evaluated automatically. Port any`,
      `  // basePath/trailingSlash/assetPrefix/images/i18n/redirects/rewrites/headers by hand.`,
    );
  } else if (o.next) {
    for (const [k, v] of Object.entries(o.next.fields)) {
      bodyLines.push(`  ${k}: ${JSON.stringify(v)},`);
    }
    const ruleEntries = Object.entries(o.next.rules);
    if (ruleEntries.length) {
      // Rule functions are called at migrate time and their RESOLVED arrays inlined —
      // deterministic + self-contained (no import of the app's next.config, which would
      // drag its plugin chain into denext's runtime). Env-dependent rules are frozen here.
      notes.push(`  // redirects/rewrites/headers inlined from ${o.next.file} at migrate time.`);
      for (const [fn, arr] of ruleEntries) {
        bodyLines.push(`  ${fn}: () => (${JSON.stringify(arr)}),`);
      }
    }
    if (o.next.dropped.length) {
      notes.push(`  // Dropped unsupported next.config keys: ${o.next.dropped.join(", ")}.`);
    }
  }
  if (o.next?.mdx) {
    // createMDX hides remark/recma plugin lists in a webpack-loader closure, so they
    // can't be auto-extracted. Point the author at denext's `mdx` field (same unified
    // plugin shape) — the compat build forwards these to MDX's compile verbatim.
    notes.push(
      `  // MDX plugins detected in ${o.next.file}. \`@next/mdx\`'s createMDX hides them, so`,
      `  // port them here by importing the plugins and setting the \`mdx\` field, e.g.:`,
      `  //   import { remarkCodeHike, recmaCodeHike } from "codehike/mdx";`,
      `  //   mdx: { remarkPlugins: [[remarkCodeHike, chConfig]], recmaPlugins: [[recmaCodeHike, chConfig]] },`,
    );
  }

  return GEN_MARKER + "\n" +
    `import type { DenextConfig } from "denext/server";\n\n` +
    `export default {\n` +
    (notes.length ? notes.join("\n") + "\n" : "") +
    bodyLines.join("\n") + "\n" +
    `} satisfies DenextConfig;\n`;
}

/** Source text for the generated `deno desktop` entry (`desktop.ts`). */
function spaDesktopSource(hasProxy: boolean): string {
  const head = GEN_MARKER + "\n" +
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
  source: SpaSource,
): Promise<MigrateResult> {
  const V = denextVersion();
  const jsr = (sub: string) => `jsr:@denext/denext${V}/${sub}`;
  const { pm, pnp } = await detectPackageManager(dir);
  if (pnp) throw pnpUnsupported(dir);
  // Any real PM install → `manual`: denext resolves deps from the app's own installed
  // node_modules (via the default-on resolver), so no `npm:` entries are pinned and
  // `package.json` is never rewritten. No lockfile → `auto` (Deno materializes deps).
  const manual = pm !== null;

  const imports: Record<string, string> = {
    "denext": `jsr:@denext/denext${V}`,
    "denext/jsx-runtime": jsr("jsx-runtime"),
    "denext/jsx-dev-runtime": jsr("jsx-dev-runtime"),
    "denext/server": jsr("server"),
    "denext/client": jsr("client"),
  };
  for (const [spec, sub] of Object.entries(SPA_REACT_ALIASES)) imports[spec] = jsr(sub);
  if (options.desktop) imports["denext/desktop"] = jsr("desktop");

  // tsconfig/jsconfig path aliases (e.g. "~/*": ["./src/*"] → "~/": "./src/"). Follows
  // `extends` + a monorepo-root tsconfig so workspace-package source aliases resolve.
  for (const [key, val] of await collectTsPathAliases(dir)) {
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

  // Entry/env/proxy are read per source: CRA from public/index.html + process.env
  // .REACT_APP_*; Vite from index.html + import.meta.env + a literal vite proxy;
  // generic from index.html + the union of both env conventions.
  const { entry, title } = source === "cra" ? await readCraIndex(dir) : await readIndexHtml(dir);
  const envKeys = source === "cra"
    ? await collectCraEnvKeys(dir)
    : source === "generic"
    ? [...new Set([...await collectSpaEnvKeys(dir), ...await collectCraEnvKeys(dir)])].sort()
    : await collectSpaEnvKeys(dir);
  const tailwind = ("@tailwindcss/vite" in deps || "tailwindcss" in deps) &&
    await exists(join(dir, "src", "index.css"));

  let proxy: { prefixes: string[]; target: string } | undefined;
  if (options.desktop && options.backend) {
    // Only Vite carries a proxy block in its config; CRA/generic rely on --proxy.
    const parsed = source === "vite" ? await parseViteProxyPrefixes(dir) : undefined;
    const prefixes = options.proxyPrefixes ?? parsed ?? ["/api"];
    proxy = { prefixes, target: options.backend };
  }

  const written: string[] = [];

  // denext.config.ts (write when absent or previously migrate-generated).
  const configPath = join(dir, "denext.config.ts");
  let configWritten = false;
  if (await writable(configPath)) {
    await Deno.writeTextFile(
      configPath,
      spaConfigSource({ entry, title, envKeys, tailwind, proxy }),
    );
    configWritten = true;
    written.push(configPath);
  }

  // desktop.ts (only with --desktop; write when absent or previously generated).
  let desktopWritten = false;
  if (options.desktop) {
    const desktopPath = join(dir, "desktop.ts");
    if (await writable(desktopPath)) {
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
  await Deno.writeTextFile(denoJsonPath, denoJsonText(denoJson));
  written.unshift(denoJsonPath);

  return {
    // Vite keeps the historical `"spa"` kind; CRA/generic report themselves.
    kind: source === "vite" ? "spa" : source,
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

/** The first of `names` that exists in `dir` (relative filename), or null. */
async function firstExisting(dir: string, names: string[]): Promise<string | null> {
  for (const n of names) {
    if (await exists(join(dir, n))) return n;
  }
  return null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}
