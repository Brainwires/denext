// `denext migrate` for a Lustre app (Gleam, JavaScript target, run by lustre_dev_tools).
//
// The Gleam project stays exactly where it is: `gleam.toml` at the root, the code in `src/`. The
// `gleam()` plugin (`denext/gleam`) compiles it with denext's pinned Gleam at dev startup, on
// every `.gleam` change and at build, and the `@gleam/` import-map entry points at its output
// (`build/dev/javascript/`). No Gleam file is rewritten. The migration generates the denext side
// around it —
//   • `app/page.tsx` + `app/lustre-app.tsx`: an island that calls the entry module's own `main`
//     in the browser, on the element `main` mounts on (the selector of its `lustre.start` call),
//     as lustre_dev_tools' `index.html` did;
//   • `app/layout.tsx`: the document (`<title>` from `index.html` or `[tools.lustre.html]`);
// — moves `priv/static/` to `public/` (lustre_dev_tools' own bundle output stays behind), and
// reports what has no denext equivalent: Erlang-target code (`.erl` / `.ex` FFI, Erlang-only
// packages, an Erlang server project) and the lustre_dev_tools settings to port by hand.
// Components (`lustre.component`) and server components (`lustre/server_component`) keep
// working inside the app; `lustreElement` / `defineLustreView` are pointed at, not applied.

import { join } from "@std/path";
import { exists } from "./migrate-fs.ts";
import { mfs } from "@denext/denext/internal/migrate-host";
import { type FreshFinding, removeEmptyDirs, walk } from "./migrate-fresh.ts";

/** What the Lustre migration did and left to the user (`MigrateResult.lustre`). */
export interface LustreMigrateInfo {
  /** The Gleam package name (`gleam.toml`'s `name`): `@gleam/<package>/…` imports use it. */
  package: string;
  /** The entry module whose `main` the island calls (`src/<package>.gleam`). */
  entry: string;
  /** The element `main` mounts on (its `lustre.start` selector, else lustre_dev_tools' `#app`). */
  selector: string;
  /** Files moved from `priv/static/` to `public/`. */
  staticMoved: number;
  /** What does not migrate, and why. */
  wontMigrate: FreshFinding[];
  /** What migrates but needs a look. */
  review: FreshFinding[];
}

/** A Lustre app `dir` holds: its parsed `gleam.toml`. */
export interface LustreDetection {
  /** `gleam.toml`'s sections (`""` for the top level), each key's raw value. */
  toml: GleamToml;
  /** The package name. */
  name: string;
}

/** A `gleam.toml`, read line by line: section → key → the value as written (quotes removed). */
export type GleamToml = Map<string, Map<string, string>>;

/** The selector lustre_dev_tools' generated `index.html` mounts the app on. */
const DEFAULT_SELECTOR = "#app";

/**
 * The sections and `key = value` lines of a `gleam.toml` — enough of TOML for the keys migrate
 * reads (multi-line arrays and inline tables keep their first line, unparsed).
 *
 * @param text The file's text.
 * @returns Section name (`""` for the top) → key → value, quotes stripped from a string.
 */
export function parseGleamToml(text: string): GleamToml {
  const out: GleamToml = new Map([["", new Map()]]);
  let section = out.get("")!;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const header = /^\[([^\[\]]+)\]$/.exec(line);
    if (header) {
      const name = header[1].trim();
      section = out.get(name) ?? new Map();
      out.set(name, section);
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+|"[^"]+")\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].replace(/^"|"$/g, "");
    const value = kv[2].trim();
    section.set(key, /^"[^"]*"$/.test(value) ? value.slice(1, -1) : value);
  }
  return out;
}

/** Whether the package `name` is listed in `[dependencies]` or `[dev-dependencies]`. */
function hasDep(toml: GleamToml, name: string, dev = false): boolean {
  return toml.get(dev ? "dev-dependencies" : "dependencies")?.has(name) === true ||
    (dev && toml.get("dev_dependencies")?.has(name) === true);
}

/**
 * The Lustre app at `dir`: a `gleam.toml` that depends on `lustre` and builds for JavaScript
 * (`target = "javascript"`, or lustre_dev_tools, which always does).
 *
 * @param dir The project directory.
 * @returns The detection, or null when `dir` holds no Lustre web app.
 */
export async function detectLustre(dir: string): Promise<LustreDetection | null> {
  let text: string;
  try {
    text = await mfs.readTextFile(join(dir, "gleam.toml"));
  } catch {
    return null;
  }
  const toml = parseGleamToml(text);
  const name = toml.get("")!.get("name");
  if (!name || !hasDep(toml, "lustre")) return null;
  const target = toml.get("")!.get("target");
  const web = target === "javascript" || hasDep(toml, "lustre_dev_tools", true);
  return web ? { toml, name } : null;
}

/** Packages that run only on the Erlang target (servers, OTP, Erlang drivers). */
const ERLANG_PACKAGES = new Set([
  "mist",
  "wisp",
  "glisten",
  "gleam_erlang",
  "gleam_otp",
  "gleam_httpc",
  "pog",
  "sqlight",
  "envoy_erlang",
]);

/** Every Gleam-project file under `src/` (relative to the project, `/`-separated). */
async function sourceFiles(dir: string): Promise<string[]> {
  return (await walk(join(dir, "src"))).map((rel) => `src/${rel}`);
}

/** Erlang-target packages in `[dependencies]`. */
function erlangPackageFindings(toml: GleamToml): FreshFinding[] {
  return [...toml.get("dependencies")?.keys() ?? []].filter((dep) => ERLANG_PACKAGES.has(dep))
    .map((dep) => ({
      item: `gleam.toml: ${dep}`,
      reason: "an Erlang-target package; denext compiles the JavaScript target only, so code " +
        "using it does not build. Move it to a server of its own, or port it to a route handler " +
        "(app/api/…/route.ts)",
    }));
}

/** Erlang / Elixir FFI files, and Gleam modules whose `@external`s are Erlang-only. */
async function erlangSourceFindings(dir: string, files: string[]): Promise<FreshFinding[]> {
  const out: FreshFinding[] = [];
  for (const rel of files) {
    if (/\.(?:erl|hrl|ex)$/.test(rel)) {
      out.push({
        item: rel,
        reason: "Erlang / Elixir FFI; the JavaScript build never loads it (give each external " +
          "function a JavaScript implementation, `@external(javascript, …)`)",
      });
      continue;
    }
    if (!rel.endsWith(".gleam")) continue;
    const src = await mfs.readTextFile(join(dir, rel));
    if (/@external\(\s*erlang\b/.test(src) && !/@external\(\s*javascript\b/.test(src)) {
      out.push({
        item: rel,
        reason: "has Erlang-only `@external` functions; calling them from the JavaScript " +
          "build fails to compile",
      });
    }
  }
  return out;
}

/** A Gleam server project beside the app (`server/`, `backend/`). */
async function serverProjectFindings(dir: string): Promise<FreshFinding[]> {
  const out: FreshFinding[] = [];
  for (const sub of ["server", "backend"]) {
    if (await exists(join(dir, sub, "gleam.toml"))) {
      out.push({
        item: `${sub}/`,
        reason: "a separate Gleam server project (the Erlang target) is not migrated: keep " +
          "running it, or port its endpoints to route handlers (app/api/…/route.ts)",
      });
    }
  }
  return out;
}

/** The Erlang-target code and packages: none of it runs in a JavaScript build. */
async function erlangFindings(
  dir: string,
  toml: GleamToml,
  files: string[],
): Promise<FreshFinding[]> {
  return [
    ...erlangPackageFindings(toml),
    ...await erlangSourceFindings(dir, files),
    ...await serverProjectFindings(dir),
  ];
}

/** The lustre_dev_tools settings (`[tools.lustre.*]`), each with what replaces it. */
const DEV_TOOLS_NOTES: Record<string, string> = {
  html: "the HTML lustre_dev_tools generated is app/layout.tsx now: carry stylesheets, scripts " +
    "and <head> tags there (the title is carried)",
  dev: "the dev server is `denext dev`: port a `proxy` to `rewrites` in denext.config.ts or a " +
    "route handler, and watched dirs are the gleam() plugin's",
  build: "the bundle is denext's (`denext build` / `export`); minify and output settings do not " +
    "apply",
  bin: "denext runs its own pinned Gleam (and esbuild / Tailwind); pinned binaries do not apply",
};

/** `[tools.lustre.*]` sections, reported for review with what replaces each. */
function devToolsFindings(toml: GleamToml): FreshFinding[] {
  const out: FreshFinding[] = [];
  for (const [section, keys] of toml) {
    const m = /^tools\.lustre(?:\.(.+))?$/.exec(section);
    if (!m) continue;
    const sub = m[1] ?? "";
    const note = DEV_TOOLS_NOTES[sub.split(".")[0]] ??
      "a lustre_dev_tools setting with no denext equivalent; port it by hand";
    const listed = [...keys.keys()].join(", ");
    out.push({ item: `gleam.toml [${section}]${listed ? ` (${listed})` : ""}`, reason: note });
  }
  return out;
}

/** Pointers for Lustre components and server components (both keep running inside the app). */
async function lustreFeatureFindings(dir: string, files: string[]): Promise<FreshFinding[]> {
  const out: FreshFinding[] = [];
  for (const rel of files.filter((f) => f.endsWith(".gleam"))) {
    const src = await mfs.readTextFile(join(dir, rel));
    if (/\bimport\s+lustre\/server_component\b/.test(src)) {
      out.push({
        item: rel,
        reason: "uses lustre/server_component; to serve it from denext over the Live socket, " +
          "wrap the app with defineLustreView (https://denext.dev/docs/gleam)",
      });
    }
    if (/\blustre\.component\(|\blustre\.register\(/.test(src)) {
      out.push({
        item: rel,
        reason: "defines a Lustre component; it keeps working as registered, and lustreElement " +
          "renders one with a prerendered shadow root if you want (https://denext.dev/docs/gleam)",
      });
    }
  }
  return out;
}

/** The selector the entry's `lustre.start(app, "<selector>", flags)` mounts on, or null. */
export function startSelector(entrySource: string): string | null {
  return /\bstart\([^"]*?,\s*"([^"]+)"/.exec(entrySource)?.[1] ?? null;
}

/** The mount element's attributes for a selector (`#id`, `.class`), or null for another kind. */
function mountAttributes(selector: string): string | null {
  const id = /^#([A-Za-z][\w-]*)$/.exec(selector);
  if (id) return `id="${id[1]}"`;
  const cls = /^\.([A-Za-z][\w-]*)$/.exec(selector);
  return cls ? `className="${cls[1]}"` : null;
}

/** The document title: `index.html`'s `<title>`, else `[tools.lustre.html] title`, else the name. */
async function appTitle(dir: string, toml: GleamToml, name: string): Promise<string> {
  const html = await mfs.readTextFile(join(dir, "index.html")).catch(() => "");
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1].trim();
  return title || toml.get("tools.lustre.html")?.get("title") || name;
}

/**
 * Move `priv/static/` to `public/`, leaving lustre_dev_tools' own bundle output
 * (`<package>.mjs`, `<package>.min.mjs`) behind: denext bundles the app itself.
 */
async function moveStatic(
  dir: string,
  name: string,
  review: FreshFinding[],
  wont: FreshFinding[],
): Promise<number> {
  const bundle = new Set([`${name}.mjs`, `${name}.min.mjs`]);
  let moved = 0;
  for (const rel of await walk(join(dir, "priv", "static"))) {
    if (bundle.has(rel)) {
      review.push({
        item: `priv/static/${rel}`,
        reason: "lustre_dev_tools' bundle output; denext builds its own, so delete it",
      });
      continue;
    }
    const to = join(dir, "public", rel);
    if (await exists(to)) {
      wont.push({
        item: `priv/static/${rel}`,
        reason: `public/${rel} already exists; merge by hand`,
      });
      continue;
    }
    await mfs.mkdir(join(to, ".."), { recursive: true });
    await mfs.rename(join(dir, "priv", "static", rel), to);
    moved++;
  }
  if (moved > 0) {
    review.push({
      item: "public/",
      reason: "priv/static/ moved here, so its files are served from / (was /priv/static/): " +
        "update the paths the app links them by",
    });
  }
  await removeEmptyDirs(join(dir, "priv", "static"));
  if (await exists(join(dir, "priv"))) await removeEmptyDirs(join(dir, "priv"));
  return moved;
}

/** The generated `app/` sources (each path relative to the project). */
export interface LustreAppFiles {
  "app/layout.tsx": string;
  "app/page.tsx": string;
  "app/lustre-app.tsx": string;
}

/**
 * The `app/` files: the root layout, the page, and the island that runs the entry's `main`.
 *
 * @param marker The migrate-generated marker line (`// generated by …`).
 * @param info The package, the entry and the mount selector.
 * @param title The document title.
 * @returns The sources by path.
 */
export function lustreAppFiles(
  marker: string,
  info: Pick<LustreMigrateInfo, "package" | "entry" | "selector">,
  title: string,
): LustreAppFiles {
  const mount = mountAttributes(info.selector) ?? `id="app"`;
  const module = `@gleam/${info.package}/${info.package}.mjs`;
  return {
    "app/layout.tsx": `${marker}
// The document lustre_dev_tools' index.html was: add the app's stylesheets and <head> tags here.
import type { LayoutProps } from "denext/server";

export const metadata = { title: ${JSON.stringify(title)} };

export default function RootLayout({ children }: LayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    "app/page.tsx": `${marker}
// The Lustre app (${info.entry}), mounted as an island.
import { LustreApp } from "./lustre-app.tsx";

export default function Home() {
  return <LustreApp />;
}
`,
    "app/lustre-app.tsx": `"use client";
${marker}
// Runs the Lustre app's own \`main\` (${info.entry}) in the browser. \`main\` mounts the app on
// ${
      JSON.stringify(info.selector)
    }, the element rendered here, as it did on lustre_dev_tools' index.html.
// The gleam() plugin compiles the Gleam project; @gleam/ maps onto its JavaScript build.
// For a server-rendered first paint, export the app (\`lustre.simple(…)\`) from Gleam and use
// lustreIsland from "denext/gleam" instead (https://denext.dev/docs/gleam).
import { useEffect } from "denext";
import { main } from "${module}";

export function LustreApp() {
  useEffect(() => {
    main();
  }, []);
  return <div ${mount} />;
}
`,
  };
}

/**
 * Plan the Lustre migration: find the entry and its mount selector, move `priv/static/`, and
 * collect the findings. The `app/` files are written by the caller ({@link lustreAppFiles}).
 *
 * @param dir The project directory.
 * @param detection What {@link detectLustre} found.
 * @returns The migration info and the document title.
 */
export async function transformLustreApp(
  dir: string,
  detection: LustreDetection,
): Promise<{ info: LustreMigrateInfo; title: string }> {
  const { toml, name } = detection;
  const entry = `src/${name}.gleam`;
  const entrySource = await mfs.readTextFile(join(dir, entry)).catch(() => null);
  if (entrySource === null || !/\bpub\s+fn\s+main\s*\(\s*\)/.test(entrySource)) {
    throw new Error(
      `no Lustre entry in ${dir}: expected ${entry} with a \`pub fn main()\` that starts the app ` +
        "(lustre_dev_tools' convention)",
    );
  }
  const wont: FreshFinding[] = [];
  const review: FreshFinding[] = [];
  const found = startSelector(entrySource);
  const selector = found ?? DEFAULT_SELECTOR;
  if (!found || !mountAttributes(found)) {
    review.push({
      item: entry,
      reason: found
        ? `main mounts on ${JSON.stringify(found)}; app/lustre-app.tsx renders <div id="app">, ` +
          "so give it the element that selector matches"
        : 'the selector main mounts on was not found; app/lustre-app.tsx renders <div id="app">',
    });
  }
  if (toml.get("")!.get("target") !== "javascript") {
    review.push({
      item: "gleam.toml: target",
      reason: 'not "javascript": the gleam() plugin builds the JavaScript target anyway, but set ' +
        '`target = "javascript"` so `gleam build` / `gleam test` agree',
    });
  }
  if (await exists(join(dir, "src", "app"))) {
    review.push({
      item: "src/app/",
      reason: "denext reads src/app/ as the App Router directory (Next's src layout), which " +
        "takes precedence over app/: rename the Gleam module directory",
    });
  }
  if (await exists(join(dir, "index.html"))) {
    review.push({
      item: "index.html",
      reason: "no longer served: app/layout.tsx is the document (its title is carried); move " +
        "its stylesheets and <head> tags there, then delete it",
    });
  }
  const files = await sourceFiles(dir);
  for (const css of files.filter((f) => f.endsWith(".css"))) {
    review.push({
      item: css,
      reason: "lustre_dev_tools bundled this stylesheet; import it from app/layout.tsx (with " +
        "Tailwind, set `tailwind: { input }` in denext.config.ts)",
    });
  }
  wont.push(...await erlangFindings(dir, toml, files));
  review.push(...devToolsFindings(toml), ...await lustreFeatureFindings(dir, files));
  const staticMoved = await moveStatic(dir, name, review, wont);
  const title = await appTitle(dir, toml, name);
  return {
    info: { package: name, entry, selector, staticMoved, wontMigrate: wont, review },
    title,
  };
}

/** The `denext.config.ts` of a migrated Lustre app: the gleam() plugin. */
export function lustreConfigSource(marker: string): string {
  return `${marker}
import type { DenextConfig } from "denext/server";
import { gleam } from "denext/gleam";

// A Lustre app on denext: gleam() compiles the Gleam project (gleam.toml at the root) with
// denext's pinned Gleam at dev startup, on every .gleam change and at build.
export default {
  plugins: [gleam()],
} satisfies DenextConfig;
`;
}
