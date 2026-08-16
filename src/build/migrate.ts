// `denext migrate` — convert a Next.js App Router project to run on denext.
//
// Reads the app's package.json (+ tsconfig paths) and writes a deno.json import
// map that aliases the react/next family to denext, passes other npm deps through
// (resolved from node_modules), enables sloppy-imports, and translates path
// aliases (`@/…`). The next-compat build/SSR pipeline (detected automatically via
// node_modules/react) then rewrites react→denext at bundle time so npm React
// libraries run on denext's single React. Does NOT touch the app's source.

import { join } from "@std/path";
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
/** Packages denext provides — never pass to npm. */
const DENEXT_OWNED = new Set([
  "react",
  "react-dom",
  "react-is",
  "next",
  "next-intl",
  "better-sqlite3",
]);
/** Native/engine deps denext can't run — flag them. */
const HARD_UNSUPPORTED = /^(@prisma\/|prisma$|@swc\/core|node-gyp|canvas$)/;
/** Deps that are no-ops under denext (its own pipeline). */
const SOFT_DROP = new Set(["sharp", "eslint-config-next", "@next/eslint-plugin-next", "next"]);

/** Result of a migration run (for the CLI to print). */
export interface MigrateResult {
  wrote: string;
  aliased: string[];
  passthrough: string[];
  dropped: string[];
  flagged: string[];
  pagesRouter: boolean;
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
export async function migrateProject(dir: string): Promise<MigrateResult> {
  const pkg = await readJson(join(dir, "package.json"));
  if (!pkg) throw new Error(`no package.json found in ${dir}`);
  const deps: Record<string, string> = {
    ...(pkg.dependencies as Record<string, string> ?? {}),
    ...(pkg.devDependencies as Record<string, string> ?? {}),
  };

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

  const denoJson = {
    nodeModulesDir: "auto",
    unstable: ["sloppy-imports"],
    compilerOptions: {
      jsx: "react-jsx",
      jsxImportSource: "react",
      lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
      strict: true,
    },
    imports,
  };
  const wrote = join(dir, "deno.json");
  await Deno.writeTextFile(wrote, JSON.stringify(denoJson, null, 2) + "\n");
  return { wrote, aliased, passthrough, dropped, flagged, pagesRouter };
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}
