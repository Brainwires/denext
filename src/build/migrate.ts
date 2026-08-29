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
import { parse as parseJsonc } from "@std/jsonc";
import { frameworkRoot } from "./bundle.ts";
import { DESKTOP_ICON_FILE, detectIconSource } from "./desktop-icon.ts";

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
  // denext provides no-op shims for these (aliased below) — never npm-pin them, or the
  // pin overwrites the alias and the throwing real package resurfaces on the native path.
  "server-only",
  "client-only",
]);
/** The `@denext/pages-router` plugin specifier written for a `pages/` app. */
const PAGES_ROUTER_SPEC = "jsr:@denext/pages-router@^0.8.0";
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
  /**
   * Point the generated config at a LOCAL denext checkout (a filesystem path) instead of the
   * published `jsr:@denext/denext`: `denext`/`react`/`next` map to `file://…` under it (resolved
   * via its `deno.json` exports), and the `dev`/`build`/`export`/`start` tasks run its local
   * `cli.ts`. For testing an unreleased/dev denext against a real app without publishing — a dev
   * aid, not the shipped drop-in. When set, no `npm:`/`jsr:` denext pins are emitted.
   */
  denextLocalPath?: string;
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
  /** The `--icon` file the desktop task uses (always `desktop-icon.png` — composed by `export` from `spa.desktop.icon` or an auto-detected web icon); undefined when no icon was detected at migrate time. */
  desktopIcon?: string;
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
  /**
   * A hand-authored `deno.json` (no migrate sentinel) was found and left untouched.
   * Migrate did NOT write its import map / tasks — the user must merge them by hand.
   */
  denoJsonExists: boolean;
  /** Present when {@link kind} is `"spa"`. */
  spa?: SpaMigrateInfo;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    // tsconfig/jsconfig allow comments + trailing commas (JSONC). Use a real JSONC
    // parser — a naive `//`-stripper corrupts `//` inside string values (e.g. the
    // `"$schema": "https://…"` URL the official Next.js example tsconfigs carry),
    // which silently drops every `paths` alias.
    return parseJsonc(await Deno.readTextFile(path)) as Record<string, unknown>;
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
      return {
        paths: co.paths,
        baseDir: resolve(dirname(file), co.baseUrl ?? "."),
      };
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
async function collectTsPathAliases(
  appDir: string,
): Promise<Array<[string, string]>> {
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
    const cfg = JSON.parse(
      Deno.readTextFileSync(join(frameworkRoot(), "deno.json")),
    ) as {
      version?: string;
    };
    return cfg.version ? `@^${cfg.version}` : "";
  } catch {
    return "";
  }
}

/** How the generated config points at denext: published JSR (default) or a local checkout. */
interface DenextResolver {
  /** The bare `denext` specifier. */
  base: string;
  /** `denext/<sub>` (a JSR subpath, or the local file it resolves to). */
  sub: (sub: string) => string;
  /** A trailing-slash prefix specifier (`next/`, `next-intl/`). */
  prefix: (sub: string) => string;
  /** The CLI specifier the `dev`/`build`/… tasks invoke. */
  cli: string;
  /** `@denext/pages-router/<sub>` (exact subpath, e.g. `router`/`link`/`head`). */
  pagesRouter: (sub: string) => string;
  /** The `@denext/pages-router` base + subpath-prefix import-map entries. */
  pagesRouterEntries: () => Record<string, string>;
  /**
   * denext's OWN `jsr:`/`npm:` deps (`@std/*`, `ws`, esbuild, …), for **local-path mode
   * only**. A `file://` denext is not a self-contained package, so tools that follow its
   * modules — notably `deno desktop`, which compiles `denext/desktop`'s graph and can't
   * resolve `@std/path` from the app's own import map — need these entries in the app
   * config. Empty for published JSR (the package carries its own deps).
   */
  frameworkDeps: () => Record<string, string>;
}

/**
 * Build a {@link DenextResolver}. Without `localPath` everything points at published JSR. With
 * it (`--denext-local-path`), `denext`/react/next map to `file://` under the local checkout
 * (resolved via its `deno.json` exports) and tasks run its local `cli.ts` — for testing an
 * unreleased/dev denext against a real app without publishing.
 */
async function denextResolver(V: string, localPath?: string): Promise<DenextResolver> {
  if (!localPath) {
    const jsr = (sub: string) => `jsr:@denext/denext${V}/${sub}`;
    return {
      base: `jsr:@denext/denext${V}`,
      sub: jsr,
      prefix: jsr,
      cli: "jsr:@denext/denext/cli",
      pagesRouter: (sub) => (sub ? `${PAGES_ROUTER_SPEC}/${sub}` : PAGES_ROUTER_SPEC),
      pagesRouterEntries: () => ({
        "@denext/pages-router": PAGES_ROUTER_SPEC,
        "@denext/pages-router/": PAGES_ROUTER_SPEC + "/",
      }),
      frameworkDeps: () => ({}), // published JSR package carries its own deps
    };
  }
  const abs = resolve(localPath);
  const denoCfg = (await readJson(join(abs, "deno.json"))) ?? {};
  const exp = (denoCfg.exports ?? {}) as Record<string, string>;
  // denext's own `jsr:`/`npm:` deps — the app config must carry these so `deno desktop`
  // (and any tool following the local file:// denext modules) can resolve `@std/path`, `ws`, …
  const frameworkDeps: Record<string, string> = {};
  for (const [k, v] of Object.entries((denoCfg.imports ?? {}) as Record<string, string>)) {
    if (v.startsWith("jsr:") || v.startsWith("npm:")) frameworkDeps[k] = v;
  }
  const fileFor = (root: string, rel: string) =>
    toFileUrl(join(root, rel.replace(/^\.\//, ""))).href;
  const local = (sub: string): string => {
    const rel = exp[sub === "" ? "." : "./" + sub];
    return rel ? fileFor(abs, rel) : toFileUrl(join(abs, sub)).href;
  };
  // pages-router is a workspace member at <abs>/packages/pages-router in a checkout.
  const prDir = join(abs, "packages", "pages-router");
  const prExp = ((await readJson(join(prDir, "deno.json")))?.exports ?? {}) as Record<
    string,
    string
  >;
  return {
    base: local(""),
    sub: local,
    // `next/`, `next-intl/` map to a local source-dir prefix (sloppy-imports adds `.ts`).
    prefix: (sub) => toFileUrl(join(abs, "src", "compat", sub.replace(/\/$/, "")) + "/").href,
    cli: toFileUrl(join(abs, "cli.ts")).href,
    pagesRouter: (sub) => {
      const key = sub === "" ? "." : "./" + sub.replace(/\/$/, "");
      return fileFor(prDir, prExp[key] ?? "./mod.ts");
    },
    // Local mode can't map a `@denext/pages-router/` prefix to one file, so expand each of the
    // package's concrete export subpaths (mirrors JSR's exports-based subpath resolution).
    pagesRouterEntries: () => {
      const out: Record<string, string> = {
        "@denext/pages-router": fileFor(prDir, prExp["."] ?? "./mod.ts"),
      };
      for (const [k, rel] of Object.entries(prExp)) {
        if (k !== ".") out["@denext/pages-router/" + k.slice(2)] = fileFor(prDir, rel);
      }
      return out;
    },
    frameworkDeps: () => frameworkDeps,
  };
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
   * remark/rehype/recma lists). `createMDX` hides those options inside a webpack-loader
   * closure, so the generated `denext.config.ts` recovers them at BUILD time via
   * `resolveNextMdx` (running the app's own next.config with `@next/mdx` captured) rather
   * than serializing the live plugin fns or dropping them.
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
/**
 * next.config keys denext cannot copy verbatim — reported with per-key guidance so
 * a load-bearing key (e.g. `env`, `transpilePackages`) is never dropped without a
 * pointer to its denext equivalent. Keys map to a one-line note; keys with no note
 * ("") are genuinely inert on denext. Emitted by {@link nextConfigSource}.
 */
const NEXT_DROP_GUIDANCE: Record<string, string> = {
  // Deno transpiles every dependency natively (no Babel/webpack loader chain), so
  // there is nothing to opt into transpiling — this key is simply unnecessary.
  transpilePackages: "not needed — Deno transpiles all dependencies natively.",
  // Next's `env` inlines arbitrary `process.env.X` at build. denext exposes vars a
  // different way: NEXT_PUBLIC_*/publicEnv reach the client, and server code reads
  // `Deno.env`/`process.env` at runtime. Re-express any client-read keys as publicEnv.
  env: "denext reads env at runtime; expose client-visible keys via `publicEnv` (NEXT_PUBLIC_*).",
  // `output: "export"` ≈ `deno task export` (static), `"standalone"` ≈ `deno task build`
  // (prod server) — chosen by which task you run, not a config field.
  output:
    'use the task instead — `deno task export` (≈ "export") or `deno task build` (≈ "standalone").',
  // denext follows React's own StrictMode semantics; wrap a subtree in <StrictMode>
  // where you want the double-invoke dev checks, rather than a global flag.
  reactStrictMode: "wrap a subtree in <StrictMode> where you want dev double-invoke checks.",
  pageExtensions:
    "denext routes .tsx/.ts/.jsx/.js by convention; custom page extensions aren't configurable.",
  webpack: "", // no webpack — Deno + esbuild handle bundling.
  compiler: "", // SWC/Babel compiler options don't apply to Deno's toolchain.
  swcMinify: "", // minification is handled by the denext build, always on for prod.
  experimental: "", // Next experimental flags don't correspond to denext features.
  poweredByHeader: "", // denext never emits an X-Powered-By header.
  productionBrowserSourceMaps: "", // source-map emission is governed by the denext build.
};
/** The set of drop keys (derived from {@link NEXT_DROP_GUIDANCE}). */
const NEXT_DROP_KEYS = new Set(Object.keys(NEXT_DROP_GUIDANCE));

/**
 * The evaluator program run as a SUBPROCESS in the app's own directory, so the config's
 * npm plugin imports (`@next/mdx`, …) and `next` resolve from the app's node_modules — not
 * denext's module graph. It imports the resolved default export, copies the honored literal
 * fields, CALLS `redirects`/`rewrites`/`headers` and inlines their resolved arrays (a
 * function can't be serialized; its result can, and denext's config takes the same shape),
 * lists dropped keys, and prints one JSON line. `import(Deno.args[0])`.
 */
/** Max time to spend evaluating an app's next.config before falling back to hand-port. */
const NEXT_EVAL_TIMEOUT_MS = 15_000;

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
async function readNextConfig(
  dir: string,
): Promise<NextConfigTranslation | null> {
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
      (/@next\/mdx|createMDX/.test(src) &&
        /codehike|remark-|rehype-|recma-/.test(src));
  } catch { /* unreadable — leave mdx false */ }
  const base: NextConfigTranslation = {
    fields: {},
    rules: {},
    dropped: [],
    file,
    raw: false,
    mdx,
  };
  // Bound the eval: a side-effectful next.config (a watcher, a DB connect, an unresolved
  // top-level await) would otherwise hang `denext migrate` forever. On timeout we abort the
  // child and fall back to the regex/hand-port path (raw:true) rather than block.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), NEXT_EVAL_TIMEOUT_MS);
  try {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "-", toFileUrl(join(dir, file)).href],
      cwd: dir,
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
      signal: ctl.signal,
    });
    const child = cmd.spawn();
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(NEXT_EVAL_PROGRAM));
    await w.close();
    const { code, stdout } = await child.output();
    if (code !== 0) return { ...base, raw: true };
    const line = new TextDecoder().decode(stdout).trim().split("\n").pop() ??
      "";
    const parsed = JSON.parse(line) as Pick<
      NextConfigTranslation,
      "fields" | "rules" | "dropped"
    >;
    return { ...base, ...parsed };
  } catch {
    return { ...base, raw: true };
  } finally {
    clearTimeout(timer);
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
  if (
    from !== "next" && (from === "cra" || (!from && await isCra(dir, deps)))
  ) {
    return await migrateSpaProject(dir, deps, options, "cra");
  }
  if (
    from !== "next" &&
    (from === "vite" || (!from && await isViteSpa(dir, deps)))
  ) {
    return await migrateSpaProject(dir, deps, options, "vite");
  }
  if (
    from !== "next" &&
    (from === "generic" || (!from && await isGenericSpa(dir, deps)))
  ) {
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
  const R = await denextResolver(V, options.denextLocalPath);
  const jsr = R.sub;
  const imports: Record<string, string> = {
    "denext": R.base,
    "denext/jsx-runtime": jsr("jsx-runtime"),
    "denext/server": jsr("server"),
    "denext/client": jsr("client"),
  };
  for (const [spec, sub] of Object.entries(DENEXT_ALIASES)) {
    imports[spec] = jsr(sub);
  }
  imports["next/"] = R.prefix("next/");
  imports["next-intl/"] = R.prefix("next-intl/");
  // `server-only`/`client-only`: alias to denext no-ops so the deno-native SSR import
  // resolves to an inert module, not the throwing npm package (the build still enforces
  // the client/server boundary via the esbuild env-poison plugin). See src/compat/*-only.ts.
  for (const poison of ["server-only", "client-only"]) {
    if (poison in deps) imports[poison] = jsr(poison);
  }
  // `/mdx` provides the type-only `mdx/types` module; MDX apps often import from it
  // at value syntax (no `type` keyword), so alias it to an empty module (types-only at runtime).
  if ("@types/mdx" in deps) imports["mdx/types"] = jsr("empty");

  // tsconfig/jsconfig path aliases (e.g. "@/*": ["./*"]) — follows `extends` and a
  // monorepo-root tsconfig, so a workspace app's `@scope/*` → `packages/*/src` maps resolve.
  for (const [key, val] of await collectTsPathAliases(dir)) {
    if (!(key in imports)) imports[key] = val;
  }
  // Local-path mode only: denext's own deps (`@std/*`, `ws`, …), so `deno desktop` and
  // other tools can resolve the local `file://` denext modules' imports. No-op for JSR.
  for (const [key, val] of Object.entries(R.frameworkDeps())) {
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
    else if (name.startsWith("@types/") || name.startsWith("eslint")) {
      dropped.push(name);
    } else {
      // Pin a concrete version so Deno resolves it in both the esbuild bundle AND the
      // native passes. A `catalog:`/`workspace:*` (non-numeric) version can't be pinned —
      // leave it to node_modules + the tolerant resolver.
      if (/^\D*\d/.test(version)) {
        imports[name] = `npm:${name}@${version.replace(/^[\^~]/, "")}`;
      }
      passthrough.push(name);
    }
  }

  const pagesRouter = await exists(join(dir, "pages")) ||
    await exists(join(dir, "src/pages"));

  const written: string[] = [];
  let pagesConfigWritten = false;
  let pagesConfigExists = false;
  const configPath = join(dir, "denext.config.ts");

  if (pagesRouter) {
    // A Pages Router app runs on the @denext/pages-router plugin: map its specifier and
    // scaffold a denext.config.ts that registers the plugin.
    Object.assign(imports, R.pagesRouterEntries());
    // The Pages Router router/link/head APIs live in the plugin, not denext core:
    // point `next/router`, `next/link`, `next/head` at the plugin so an UNMODIFIED
    // app (no `--codemod`) resolves them. These override the App Router `next/*`
    // entries set above (which don't include `next/router` at all).
    imports["next/router"] = R.pagesRouter("router");
    imports["next/link"] = R.pagesRouter("link");
    imports["next/head"] = R.pagesRouter("head");
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
    // MDX-plugin apps: the generated config recovers the live remark/recma fns from
    // next.config at build time (see nextConfigSource), so it imports the recovery helper.
    if (next?.mdx) imports["denext/build/next-mdx"] = jsr("build/next-mdx");
    if (await writable(configPath)) {
      await Deno.writeTextFile(
        configPath,
        nextConfigSource({ tailwind, publicEnv, next }),
      );
      written.push(configPath);
    } else {
      pagesConfigExists = true; // reuse the "config already exists" signal for the CLI hint
    }
  }

  const denoJson = {
    tasks: spaTasks(false, R.cli, false),
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
  // Never clobber a hand-authored deno.json (one without the migrate sentinel): a repo
  // may carry its own Deno config (custom tasks, importMap, compilerOptions). Only write
  // when absent or previously generated by migrate (idempotent re-run).
  let denoJsonExists = false;
  if (await writable(denoJsonPath)) {
    await Deno.writeTextFile(denoJsonPath, denoJsonText(denoJson));
    written.unshift(denoJsonPath);
  } else {
    denoJsonExists = true;
  }
  // Ignore denext's generated build artifacts (`.denext/` build cache, `out/` export).
  await ensureGitignore(dir, [".denext/", "out/"], written);
  // Turn on the Deno LSP so editors resolve the `denext` import map like `deno` does.
  await ensureVscodeDeno(dir, written);
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
    denoJsonExists,
  };
}

// ── Vite SPA migration ──────────────────────────────────────────────────────

/** True for a Vite React SPA: a `vite.config.*`, no `next.config.*`, React in deps. */
async function isViteSpa(
  dir: string,
  deps: Record<string, string>,
): Promise<boolean> {
  const vite = await anyExists(dir, [
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mts",
  ]);
  if (!vite) return false;
  const next = await anyExists(dir, [
    "next.config.ts",
    "next.config.js",
    "next.config.mjs",
  ]);
  if (next) return false;
  return "react" in deps || "react-dom" in deps;
}

/** The SPA-shaped source frameworks that share {@link migrateSpaProject}. */
type SpaSource = "vite" | "cra" | "generic";

/** True for a Create React App: `react-scripts` in deps, or `public/index.html` + React, no vite/next. */
async function isCra(
  dir: string,
  deps: Record<string, string>,
): Promise<boolean> {
  if ("react-scripts" in deps) return true;
  if (!(await exists(join(dir, "public", "index.html")))) return false;
  if (
    await anyExists(dir, [
      "vite.config.ts",
      "vite.config.js",
      "vite.config.mts",
    ])
  ) return false;
  if (await isNext(dir, deps)) return false;
  return "react" in deps || "react-dom" in deps;
}

/** True for a Next.js app: `next` in deps or a `next.config.*` present. */
async function isNext(
  dir: string,
  deps: Record<string, string>,
): Promise<boolean> {
  if ("next" in deps) return true;
  return await anyExists(dir, [
    "next.config.ts",
    "next.config.js",
    "next.config.mjs",
    "next.config.cjs",
  ]);
}

/** True for a generic React SPA: React + a root `index.html`, and not Vite/CRA/Next. */
async function isGenericSpa(
  dir: string,
  deps: Record<string, string>,
): Promise<boolean> {
  if (!("react" in deps || "react-dom" in deps)) return false;
  if (!(await exists(join(dir, "index.html")))) return false;
  if (
    await anyExists(dir, [
      "vite.config.ts",
      "vite.config.js",
      "vite.config.mts",
    ])
  ) return false;
  if (await isCra(dir, deps)) return false;
  if (await isNext(dir, deps)) return false;
  return true;
}

/** Entry + title for a CRA app: title from `public/index.html`, entry `./src/index.*`. */
async function readCraIndex(
  dir: string,
): Promise<{ entry: string; title: string }> {
  const html = await Deno.readTextFile(join(dir, "public", "index.html")).catch(
    () => null,
  );
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
    for (const m of text.matchAll(/process\.env\.(REACT_APP_[A-Za-z0-9_]+)/g)) {
      keys.add(m[1]);
    }
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
    if (!pnp && await anyExists(cur, [".pnp.cjs", ".pnp.loader.mjs"])) {
      pnp = true;
    }
    if (pm === null) {
      if (await anyExists(cur, ["pnpm-lock.yaml", "pnpm-workspace.yaml"])) {
        pm = "pnpm";
      } else if (await anyExists(cur, ["bun.lockb", "bun.lock"])) pm = "bun";
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
async function readIndexHtml(
  dir: string,
): Promise<{ entry: string; title: string }> {
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
    for (
      const m of text.matchAll(/import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)
    ) {
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
async function walkCode(
  root: string,
  scan: (text: string) => void,
): Promise<void> {
  // `Deno.readDir` is lazy — a missing/again-unreadable dir throws while iterating, not at
  // the call — so the guard must wrap the whole loop (App Router apps have no `src/`).
  try {
    for await (const e of Deno.readDir(root)) {
      if (e.isDirectory) {
        if (
          e.name === "node_modules" || e.name === "dist" || e.name === ".denext"
        ) continue;
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
async function parseViteProxyPrefixes(
  dir: string,
): Promise<string[] | undefined> {
  for (const f of ["vite.config.ts", "vite.config.js", "vite.config.mts"]) {
    const t = await Deno.readTextFile(join(dir, f)).catch(() => null);
    if (!t) continue;
    const block = t.match(/proxy\s*:\s*\{([\s\S]*?)\n\s*\}/);
    if (block) {
      const keys = [...block[1].matchAll(/["'`](\/[^"'`]+)["'`]\s*:/g)].map((
        x,
      ) => x[1]);
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
  desktop?: boolean;
}): string {
  const needsPkg = o.envKeys.includes("APP_VERSION");
  const envLines = o.envKeys
    .map((
      k,
    ) => (k === "APP_VERSION" ? `      APP_VERSION: pkg.version,` : `      ${k}: "",`))
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
    // Show the desktop-icon override so it's discoverable (commented → auto-detection
    // stays the default). The path can point anywhere; a PNG is composed into the macOS
    // icon template, a value change takes effect on the next `deno task desktop`.
    (o.desktop
      ? `    // desktop: { icon: "./public/apple-touch-icon.png" }, // override the app icon (any PNG path)\n`
      : "") +
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
    bodyLines.push(
      `  tailwind: { input: "./src/index.css", output: "./src/index.gen.css" },`,
    );
  }
  if (o.publicEnv.length) {
    bodyLines.push(
      `  publicEnv: [${o.publicEnv.map((k) => JSON.stringify(k)).join(", ")}],`,
    );
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
      notes.push(
        `  // redirects/rewrites/headers inlined from ${o.next.file} at migrate time.`,
      );
      for (const [fn, arr] of ruleEntries) {
        bodyLines.push(`  ${fn}: () => (${JSON.stringify(arr)}),`);
      }
    }
    if (o.next.dropped.length) {
      // Per-key guidance so a load-bearing key isn't dropped without a pointer to
      // its denext equivalent. Inert keys (no note) are grouped on one line.
      const inert: string[] = [];
      for (const k of o.next.dropped) {
        const note = NEXT_DROP_GUIDANCE[k];
        if (note) notes.push(`  // ${k}: ${note}`);
        else inert.push(k);
      }
      if (inert.length) {
        notes.push(`  // Dropped (no denext equivalent needed): ${inert.join(", ")}.`);
      }
    }
  }

  // MDX plugins: `@next/mdx`'s createMDX hides its remark/recma plugin fns in a
  // webpack-loader closure — live function references that can't be serialized into this
  // file. So instead of dropping them (or leaving a hand-port note), recover them at BUILD
  // time: resolveNextMdx runs the app's own next.config with @next/mdx captured and returns
  // the real plugin fns. Deterministic + zero hand-edits — the config stays commit-parity.
  const imports = [`import type { DenextConfig } from "denext/server";`];
  if (o.next?.mdx) {
    imports.push(`import { resolveNextMdx } from "denext/build/next-mdx";`);
    notes.push(
      `  // MDX plugins recovered from ${o.next.file} at build time (createMDX hides them).`,
    );
    bodyLines.push(
      `  mdx: await resolveNextMdx(import.meta.url, ${JSON.stringify("./" + o.next.file)}),`,
    );
  }

  return GEN_MARKER + "\n" +
    imports.join("\n") + "\n\n" +
    `export default {\n` +
    (notes.length ? notes.join("\n") + "\n" : "") +
    bodyLines.join("\n") + "\n" +
    `} satisfies DenextConfig;\n`;
}

/** Source text for the generated `deno desktop` entry (`desktop.ts`). */
function spaDesktopSource(): string {
  // Always read `spa.proxy` from denext.config.ts (harmlessly `undefined` when no
  // proxy is set) so ADDING a backend proxy to the config later just works — no
  // desktop.ts hand-edit or re-migration. `deno desktop` compiles this import in, so
  // the proxy config is baked into the packaged app (which has no config at runtime).
  return GEN_MARKER + "\n" +
    `// Entry for \`deno desktop\` — serves the static export in \`out/\` inside a native\n` +
    `// window (run \`deno task export\` first, or \`deno task desktop\`).\n` +
    `// Backend reverse proxy: set \`spa.proxy\` in denext.config.ts (e.g. to reach a\n` +
    `// local server same-origin so its session cookies persist).\n` +
    `import { runDesktop } from "denext/desktop";\n` +
    `import config from "./denext.config.ts";\n\n` +
    `await runDesktop({ importMetaUrl: import.meta.url, proxy: config.spa?.proxy });\n`;
}

/**
 * deno.json tasks for a SPA (dev/build/export/start, plus desktop when requested).
 * `hasIcon` wires the desktop task's `--icon` when the app has (or is configured with)
 * an app icon; the icon file itself is composed at build time by `export` — see
 * {@link prepareDesktopIcon} — so `spa.desktop.icon` drives it without re-migration.
 */
function spaTasks(desktop: boolean, cli: string, hasIcon: boolean): Record<string, string> {
  const tasks: Record<string, string> = {
    dev: `deno run -A ${cli} dev .`,
    build: `deno run -A ${cli} build .`,
    export: `deno run -A ${cli} export .`,
    start: `deno run --allow-net --allow-read --allow-env ${cli} start .`,
  };
  if (desktop) {
    // `--node-modules-dir=none` resolves the desktop runtime's npm deps (denext's
    // `ws`, for the proxy's WebSocket bridge) from Deno's global cache rather than the
    // app's `nodeModulesDir:"manual"` tree, which does not carry them.
    //
    // `--exclude-unused-npm` embeds ONLY the npm packages `desktop.ts` actually reaches
    // (denext's runtime + `ws`) instead of the app's entire lockfile snapshot. Without
    // it, a large app's every dependency — React, build tooling, native binaries — is
    // baked into the bundle even though the desktop entry only serves the static `out/`
    // (e.g. a monorepo SPA ballooned to 2.4GB → ~104MB with the flag).
    //
    // `--include out` embeds the static export itself. `desktop.ts` reads `out/` at
    // runtime via dynamic paths (`serveStatic`), so it is NOT in the module graph and
    // would otherwise be left out of the bundle — the packaged app would then serve
    // nothing on another machine.
    //
    // `--icon desktop-icon.png` (when present) is the app icon `export` composes from
    // `spa.desktop.icon` (or an auto-detected web icon) into Apple's macOS template.
    //
    // The permissions are baked into the compiled, distributable app (it runs with none
    // otherwise). `--allow-net` is SCOPED to loopback — `runDesktop` binds `127.0.0.1`
    // and the reverse proxy targets a loopback backend (the `spa.proxy` default; a
    // non-loopback target needs `allowNonLoopback`, and then widening this flag by hand)
    // — so the distributed binary can't reach the wider network. `--allow-read` (serving
    // the embedded `out/`) and `--allow-env` (`PORT` + the app's env) stay broad: a local
    // desktop app legitimately needs them, and narrowing them risks breaking the runtime.
    const iconFlag = hasIcon ? ` --icon ${DESKTOP_ICON_FILE}` : "";
    tasks.desktop = `deno task export && deno desktop ` +
      `--allow-net=127.0.0.1,localhost --allow-read --allow-env ` +
      `--node-modules-dir=none --exclude-unused-npm --include out${iconFlag} desktop.ts`;
  }
  return tasks;
}

/**
 * Add denext's generated build artifacts to the project's `.gitignore` (creating it if
 * absent; appending only the entries not already present, under a one-line marker).
 * Never reorders or removes the user's existing lines, and is idempotent — a second run
 * adds nothing. Pushes the path to `written` when it changes.
 *
 * @param dir The app directory.
 * @param entries `.gitignore` lines to ensure (e.g. `.denext/`, `out/`).
 * @param written Accumulator the `.gitignore` path is pushed onto when modified.
 */
async function ensureGitignore(dir: string, entries: string[], written: string[]): Promise<void> {
  const path = join(dir, ".gitignore");
  let current = "";
  try {
    current = await Deno.readTextFile(path);
  } catch { /* no .gitignore yet — create one */ }
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !have.has(e));
  if (missing.length === 0) return;
  const marker = "# denext generated build artifacts";
  const block = (have.has(marker) ? "" : `${marker}\n`) + missing.join("\n") + "\n";
  // Separate from existing content with a blank line; finish a dangling last line first.
  const lead = current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  // Remove any existing entry before writing: `Deno.writeTextFile` follows a symlink and
  // writes its target, so a `.gitignore` committed as a symlink (migrate runs on cloned
  // third-party repos) could otherwise redirect this append out of tree. Deno.remove
  // unlinks the symlink itself. Same guard as `writeMergedModuleConfig`.
  await Deno.remove(path).catch(() => {});
  await Deno.writeTextFile(path, current + lead + block);
  written.push(path);
}

/**
 * Enable the Deno language server for the migrated project so editors resolve the `denext`
 * import map (and the react aliases) exactly the way `deno` does. Without this, VSCode's
 * built-in TypeScript server — which knows nothing about `deno.json`'s `imports` — flags
 * `denext`/`denext/desktop` and the aliased `react` as unresolved even though `deno check`
 * passes and the app builds.
 *
 * Writes `.vscode/settings.json` (`"deno.enable": true`) and `.vscode/extensions.json`
 * (recommending `denoland.vscode-deno`, so the LSP is one prompt away). Both are merged
 * additively: any existing keys/recommendations are preserved, the entry is added only when
 * missing, and a re-run with it already present writes nothing (idempotent). Pushes each
 * changed path onto `written`. Scoped to this app dir — VSCode only reads a folder's
 * `.vscode` when that folder is a workspace root, so a monorepo's other (Node) packages are
 * unaffected unless this app is opened directly.
 *
 * @param dir The app directory.
 * @param written Accumulator each changed `.vscode` path is pushed onto.
 */
async function ensureVscodeDeno(dir: string, written: string[]): Promise<void> {
  const vscodeDir = join(dir, ".vscode");

  // settings.json → turn on the Deno LSP for this workspace folder.
  const settingsPath = join(vscodeDir, "settings.json");
  const settings = (await readJson(settingsPath)) ?? {};
  if (settings["deno.enable"] !== true) {
    settings["deno.enable"] = true;
    await writeVscodeJson(vscodeDir, settingsPath, settings, written);
  }

  // extensions.json → recommend the Deno extension so the LSP is a click away.
  const extPath = join(vscodeDir, "extensions.json");
  const ext = (await readJson(extPath)) ?? {};
  const recs = Array.isArray(ext.recommendations) ? ext.recommendations as string[] : [];
  if (!recs.includes("denoland.vscode-deno")) {
    ext.recommendations = [...recs, "denoland.vscode-deno"];
    await writeVscodeJson(vscodeDir, extPath, ext, written);
  }
}

/** Write a `.vscode/*.json` file (mkdir + symlink-safe overwrite), pushing it to `written`. */
async function writeVscodeJson(
  vscodeDir: string,
  path: string,
  obj: Record<string, unknown>,
  written: string[],
): Promise<void> {
  await Deno.mkdir(vscodeDir, { recursive: true });
  // Same symlink guard as `ensureGitignore`: unlink first so a symlinked target (possible in
  // a cloned third-party repo) isn't followed out of tree.
  await Deno.remove(path).catch(() => {});
  await Deno.writeTextFile(path, JSON.stringify(obj, null, 2) + "\n");
  written.push(path);
}

/** Generate denext SPA config files (deno.json + denext.config.ts [+ desktop.ts]). */
async function migrateSpaProject(
  dir: string,
  deps: Record<string, string>,
  options: MigrateOptions,
  source: SpaSource,
): Promise<MigrateResult> {
  const V = denextVersion();
  const R = await denextResolver(V, options.denextLocalPath);
  const jsr = R.sub;
  const { pm, pnp } = await detectPackageManager(dir);
  if (pnp) throw pnpUnsupported(dir);
  // Any real PM install → `manual`: denext resolves deps from the app's own installed
  // node_modules (via the default-on resolver), so no `npm:` entries are pinned and
  // `package.json` is never rewritten. No lockfile → `auto` (Deno materializes deps).
  const manual = pm !== null;

  const imports: Record<string, string> = {
    "denext": R.base,
    "denext/jsx-runtime": jsr("jsx-runtime"),
    "denext/jsx-dev-runtime": jsr("jsx-dev-runtime"),
    "denext/server": jsr("server"),
    "denext/client": jsr("client"),
  };
  for (const [spec, sub] of Object.entries(SPA_REACT_ALIASES)) {
    imports[spec] = jsr(sub);
  }
  // `server-only`/`client-only` → denext no-ops (see the Next path + src/compat/*-only.ts).
  for (const poison of ["server-only", "client-only"]) {
    if (poison in deps) imports[poison] = jsr(poison);
  }
  // `/mdx` provides the type-only `mdx/types` module; MDX apps often import from it
  // at value syntax (no `type` keyword), so alias it to an empty module (types-only at runtime).
  if ("@types/mdx" in deps) imports["mdx/types"] = jsr("empty");
  if (options.desktop) imports["denext/desktop"] = jsr("desktop");

  // tsconfig/jsconfig path aliases (e.g. "~/*": ["./src/*"] → "~/": "./src/"). Follows
  // `extends` + a monorepo-root tsconfig so workspace-package source aliases resolve.
  for (const [key, val] of await collectTsPathAliases(dir)) {
    if (!(key in imports)) imports[key] = val;
  }
  // Local-path mode only: denext's own deps (`@std/*`, `ws`, …), so `deno desktop` and
  // other tools can resolve the local `file://` denext modules' imports. No-op for JSR.
  for (const [key, val] of Object.entries(R.frameworkDeps())) {
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
    else if (name.startsWith("@types/") || name.startsWith("eslint")) {
      dropped.push(name);
    } else {
      passthrough.push(name);
      if (!manual) {
        imports[name] = `npm:${name}@${version.replace(/^[\^~]/, "")}`;
      }
    }
  }

  // Entry/env/proxy are read per source: CRA from public/index.html + process.env
  // .REACT_APP_*; Vite from index.html + import.meta.env + a literal vite proxy;
  // generic from index.html + the union of both env conventions.
  const { entry, title } = source === "cra" ? await readCraIndex(dir) : await readIndexHtml(dir);
  const envKeys = source === "cra" ? await collectCraEnvKeys(dir) : source === "generic"
    ? [
      ...new Set([
        ...await collectSpaEnvKeys(dir),
        ...await collectCraEnvKeys(dir),
      ]),
    ].sort()
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
      spaConfigSource({ entry, title, envKeys, tailwind, proxy, desktop: !!options.desktop }),
    );
    configWritten = true;
    written.push(configPath);
  }

  // desktop.ts (only with --desktop; write when absent or previously generated).
  let desktopWritten = false;
  let desktopIcon: string | undefined;
  if (options.desktop) {
    const desktopPath = join(dir, "desktop.ts");
    if (await writable(desktopPath)) {
      await Deno.writeTextFile(desktopPath, spaDesktopSource());
      desktopWritten = true;
      written.push(desktopPath);
    }
    // Only decide whether the desktop task wires `--icon` — the icon file itself is
    // composed by `export` from `spa.desktop.icon` (or an auto-detected web icon), so
    // the icon is config-driven and changeable without re-migrating.
    if (await detectIconSource(dir)) desktopIcon = DESKTOP_ICON_FILE;
  }

  const denoJson = {
    tasks: spaTasks(!!options.desktop, R.cli, !!desktopIcon),
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
  // Never clobber a hand-authored deno.json (see the Next path).
  let denoJsonExists = false;
  if (await writable(denoJsonPath)) {
    await Deno.writeTextFile(denoJsonPath, denoJsonText(denoJson));
    written.unshift(denoJsonPath);
  } else {
    denoJsonExists = true;
  }

  // Ignore denext's generated build artifacts: `.denext/` (build cache), `out/` (the
  // static export), `src/index.gen.css` (the compiled Tailwind output, rebuilt each
  // `dev`/`build`) when Tailwind is used, and — for a desktop app — the composed
  // `desktop-icon.png` (rebuilt from `spa.desktop.icon` each `export`).
  await ensureGitignore(
    dir,
    [
      ".denext/",
      "out/",
      ...(tailwind ? ["src/index.gen.css"] : []),
      ...(options.desktop ? ["desktop-icon.png"] : []),
    ],
    written,
  );
  // Turn on the Deno LSP so editors resolve the `denext` import map like `deno` does.
  await ensureVscodeDeno(dir, written);

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
    denoJsonExists,
    spa: {
      entry,
      title,
      envKeys,
      tailwind,
      proxy,
      configWritten,
      desktopWritten,
      desktopIcon,
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
async function firstExisting(
  dir: string,
  names: string[],
): Promise<string | null> {
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
