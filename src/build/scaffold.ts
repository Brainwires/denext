// Project scaffolding for `denext create`. Generates a clean minimal starter
// (deno.json wired to the published JSR package, an app/ with a layout, a Server
// Component home page and a `"use client"` counter island, plus the `.vscode` files
// that turn on the Deno LSP), optionally with Tailwind, a `src/` layout, and the
// auto-memo compiler enabled.

import { basename, join, relative } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { VERSION } from "../../mod.ts";
import { reactCompatImportMap } from "./react-specifiers.ts";

/** Options controlling what {@linkcode scaffoldProject} generates. */
/** Named starter templates `denext create --template <name>` can choose. */
export const SCAFFOLD_TEMPLATES = ["default", "minimal"] as const;
export type ScaffoldTemplate = (typeof SCAFFOLD_TEMPLATES)[number];

export interface ScaffoldOptions {
  /** Absolute target directory (created if missing; must be empty). */
  dir: string;
  /**
   * Starter template: `"default"` (a Server Component page rendering a `"use client"`
   * counter island — the SSR + hydration round-trip) or `"minimal"` (a bare page).
   * Defaults to `"default"`.
   */
  template?: ScaffoldTemplate;
  /**
   * Write `.vscode/settings.json` (`"deno.enable": true`) and `.vscode/extensions.json`
   * (recommending the Deno extension) so the editor resolves the `denext` import map the
   * way `deno` does. Defaults to `true`; `denext create --no-vscode` turns it off. Merged
   * additively into files that already exist (`denext init`), like `denext migrate`.
   */
  vscode?: boolean;
  /** Wire up Tailwind (input CSS, config, `import "./globals.css"`). */
  tailwind?: boolean;
  /** Use a `src/` directory layout (`src/app` instead of `app`). */
  srcDir?: boolean;
  /** Enable the auto-memo compiler (`reactCompiler`) in `denext.config.ts`. */
  compiler?: boolean;
  /**
   * Wire up a native desktop app via `deno desktop`: a `desktop.ts` entry
   * (`Deno.serve()` over the static export), a `desktop` block in `deno.json`,
   * and `export`/`desktop`/`desktop:package` tasks.
   */
  desktop?: boolean;
  /**
   * Wire up iOS/Android via Capacitor: a `capacitor.config.ts` (`webDir: "out"`),
   * a `package.json` for Capacitor's CLI, and `export`/`mobile:*` tasks.
   */
  capacitor?: boolean;
  /**
   * Add React + Next import-map aliases (`react`, `react-dom`, `next/*`) so code
   * and libraries that import from `"react"`/`"next"` resolve to denext.
   */
  compatibilityMode?: boolean;
  /**
   * Allow scaffolding into an existing, non-empty directory (`denext init` into
   * `.`). Existing files are never overwritten — a conflict is an error.
   */
  allowExisting?: boolean;
}

/** The scaffolded project's README: what the tasks do, where routes live, where to read more. */
function readme(opts: ScaffoldOptions, appBase: string): string {
  const name = basename(opts.dir) || "my-app";
  return `# ${name}

A [denext](https://denext.dev) app — Next.js's App Router, running on Deno.

## Tasks

| Command            | What it does                                                        |
| ------------------ | ------------------------------------------------------------------- |
| \`deno task dev\`   | Dev server with per-module HMR at http://localhost:3000             |
| \`deno task build\` | Production build into \`.denext/\`                                    |
| \`deno task start\` | Serve the production build (least-privilege permissions)            |
${
    opts.desktop || opts.capacitor
      ? "| `deno task export` | Static export into `out/` (the native shells ship this) |\n"
      : ""
  }
The first \`dev\`/\`build\` downloads the framework from JSR (a few seconds); later runs
are cached.

## Where things live

- \`${appBase}/page.tsx\`, \`${appBase}/layout.tsx\` — routes are files, exactly like the
  Next.js App Router (\`app/blog/[slug]/page.tsx\`, \`app/api/x/route.ts\`, \`loading.tsx\`,
  \`error.tsx\`, \`middleware.ts\`). They are Server Components: they can be \`async\`, read
  the database directly, and ship no JavaScript.
${
    opts.template === "minimal"
      ? ""
      : `- \`${appBase}/counter.tsx\` — a \`"use client"\` island: the one file that ships to the
  browser. Hooks and event handlers live in files like this one; the page passes it
  serialisable props (and Server Actions).
`
  }- \`denext.config.ts\` — redirects, rewrites, headers, images, i18n, CSP, \`cacheComponents\`.
- Imports come from \`denext\` (hooks, \`Link\`, \`Image\`, \`redirect\`), \`denext/server\`
  (\`cookies\`, \`headers\`, \`getSession\`, caching) and \`denext/client\`.
${
    opts.vscode === false
      ? ""
      : `- \`.vscode/\` — turns on the Deno language server (and recommends the Deno extension), so
  the editor resolves \`denext\` exactly as \`deno check\` does.
`
  }
## Learn more

- Guide + API: https://denext.dev/docs
- Ask an agent: \`denext mcp\` exposes the docs and route tools over MCP.
- \`denext doctor\` checks the toolchain; \`denext generate page|component|route|test\` scaffolds.
`;
}

/** A generated file: repo-relative path + contents. */
export interface ScaffoldFile {
  path: string;
  content: string;
}

const dep = `jsr:@denext/denext@^${VERSION}`;
/** The version-pinned CLI specifier used by generated `deno task`s. */
const cli = `${dep}/cli`;
/** The Capacitor release `--capacitor` scaffolds (CLI, core and both native platforms). */
const CAPACITOR = "^8.5.2";
/**
 * What `--capacitor` gitignores. Capacitor 8 builds iOS with Swift Package Manager, and the
 * `ios/` + `android/` projects are meant to be committed — so only their build outputs and
 * the web assets `cap sync` copies in are ignored here (the platforms' own generated
 * `.gitignore` files cover the rest).
 */
const CAPACITOR_IGNORES = [
  "node_modules/",
  "ios/App/App/public/",
  "ios/App/build/",
  "ios/DerivedData/",
  "android/app/src/main/assets/public/",
  "android/app/build/",
  "android/build/",
  "android/.gradle/",
];

/** The `deno task` entries for a scaffolded project (dev/build/start + native targets). */
function scaffoldTasks(opts: ScaffoldOptions): Record<string, string> {
  const tasks: Record<string, string> = {
    // `dev`/`build` compile, write `.denext`, and spawn tooling (Tailwind, esbuild),
    // so they use broad permissions. `start` only serves, so it runs least-privilege:
    // net + read + env, plus write to `.denext` alone — the durable node:sqlite cache
    // (the default) lives there, and without the grant it silently downgrades to the
    // per-process memory store. The CLI is pinned to the same range as the `denext`
    // import so the two never skew (an unversioned `jsr:@denext/denext/cli` would resolve
    // to JSR `latest`).
    dev: `deno run -A ${cli} dev .`,
    build: `deno run -A ${cli} build .`,
    start: `deno run --allow-net --allow-read --allow-env --allow-write=.denext ${cli} start .`,
  };
  // Both native targets ship the static export (SSG) from `out/`.
  if (opts.desktop || opts.capacitor) {
    tasks.export = `deno run -A ${cli} export .`;
  }
  if (opts.desktop) {
    // `deno desktop` wraps the Deno.serve() in desktop.ts in a native window.
    tasks.desktop = "deno task export && deno desktop desktop.ts";
    // The packaging script exports, then builds (embedding `out/`) + code-signs, with
    // opt-in multi-arch (--arch universal|both) and notarization (env vars). See its
    // header + the macOS distribution docs.
    tasks["desktop:package"] = "deno run -A scripts/package-macos.ts";
    // Linux bundle (exe + .so + .desktop) → tar.gz (+ AppImage when appimagetool is present).
    // Cross-builds from any OS via `deno desktop --target`.
    tasks["desktop:package:linux"] = "deno run -A scripts/package-linux.ts";
    // Windows bundle (exe + dlls) → zip, Authenticode-signed when a cert is configured.
    // The exe cross-builds from any OS; signing runs where signtool is available.
    tasks["desktop:package:windows"] = "deno run -A scripts/package-windows.ts";
  }
  if (opts.capacitor) {
    // `mobile:sync` exports, then `cap sync` copies `out/` into the native projects. The
    // export writes no `.gz` siblings the webview would never load: the App Router export
    // doesn't precompress, and a SPA-mode app turns it off with `spa.precompress: false`.
    const cap = `deno run -A --node-modules-dir npm:@capacitor/cli@${CAPACITOR}`;
    tasks["mobile:sync"] = `deno task export && ${cap} sync`;
    tasks["mobile:ios"] = `${cap} open ios`;
    tasks["mobile:android"] = `${cap} open android`;
  }
  return tasks;
}

/** The import map for a scaffolded project (denext entries + native / compat aliases). */
function scaffoldImports(opts: ScaffoldOptions): Record<string, string> {
  return {
    "denext": dep,
    "denext/jsx-runtime": `${dep}/jsx-runtime`,
    "denext/jsx-dev-runtime": `${dep}/jsx-dev-runtime`,
    "denext/server": `${dep}/server`,
    "denext/client": `${dep}/client`,
    "denext/testing": `${dep}/testing`,
    // `denext generate test` writes tests against @std/assert.
    "@std/assert": "jsr:@std/assert@^1",
    // Native-target deps as bare, versioned specifiers (the lint plugin forbids
    // inline `jsr:`/`npm:` in source).
    ...(opts.desktop ? { "denext/desktop": `${dep}/desktop` } : {}),
    ...(opts.capacitor
      ? {
        "denext/mobile": `${dep}/mobile`,
        "@capacitor/cli": `npm:@capacitor/cli@${CAPACITOR}`,
      }
      : {}),
    // React + Next compatibility: alias those specifiers to denext. The
    // react-family entries come from the single canonical specifier list.
    ...(opts.compatibilityMode
      ? {
        ...reactCompatImportMap(dep),
        // Bare `next` (types such as `Metadata`) and the server-only/client-only guards.
        "next": `${dep}/next`,
        "server-only": `${dep}/server-only`,
        "client-only": `${dep}/client-only`,
        "next/": `${dep}/next/`,
        "next-intl": `${dep}/next-intl`,
        "next-intl/": `${dep}/next-intl/`,
        "better-sqlite3": `${dep}/better-sqlite3`,
      }
      : {}),
  };
}

/**
 * The `deno.json` a fresh `denext create` writes — also the template the UI's Setup page
 * diffs an existing project's config against.
 *
 * @param opts The scaffold options (only the feature flags are read).
 * @returns The file's text.
 */
export function denoJson(opts: ScaffoldOptions): string {
  const config: Record<string, unknown> = {
    tasks: scaffoldTasks(opts),
    compilerOptions: {
      jsx: "react-jsx",
      jsxImportSource: "denext",
      // `deno.unstable` provides the Deno.Kv types referenced by denext/server's
      // optional KV cache adapter (type-only; no runtime unstable APIs required).
      lib: [
        "deno.window",
        "deno.unstable",
        "dom",
        "dom.iterable",
        "dom.asynciterable",
      ],
    },
    imports: scaffoldImports(opts),
    lint: { plugins: [`${dep}/lint-plugin`] },
  };
  if (opts.desktop) {
    // Read by `deno desktop` when packaging the native binary.
    config.desktop = {
      app: { name: "denext app", identifier: "com.example.denext" },
      // backend defaults to "webview" (native engine, small binary).
    };
  }
  return JSON.stringify(config, null, 2) + "\n";
}

/** Entry for `deno desktop`: a Deno.serve() over the static export. */
function desktopEntry(): string {
  return `// Entry for \`deno desktop\` — serves the static export in \`out/\` inside a native
// window (run \`deno task export\` first, or \`deno task desktop\`, which exports then
// launches the window). The serve + window plumbing lives in denext's desktop runtime;
// pass \`import.meta.url\` so \`out/\` resolves relative to this entry (works from the
// packaged app too). To reverse-proxy a backend, add \`spa.proxy\` to \`denext.config.ts\`
// and pass it here: \`import config from "./denext.config.ts"; ... proxy: config.spa?.proxy\`.
import { runDesktop } from "denext/desktop";

await runDesktop({ importMetaUrl: import.meta.url });
`;
}

/** Capacitor config: bundle the static export into the native iOS/Android shells. */
function capacitorConfig(): string {
  return `import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.example.denext",
  appName: "denext app",
  // denext's static export (\`deno task export\`) writes here; Capacitor bundles it.
  webDir: "out",
};

export default config;
`;
}

/** Instructions for adding platform app icons to a `deno desktop` build. */
function desktopIcons(): string {
  return `# App icons

\`deno desktop\` uses a default icon unless you provide your own. Drop platform
icons in this folder, then reference them from the \`desktop\` block in
\`deno.json\`:

\`\`\`jsonc
"desktop": {
  "app": {
    "name": "denext app",
    "identifier": "com.example.denext",
    "icons": {
      "macos": "./icons/app.icns",
      "windows": "./icons/app.ico",
      "linux": "./icons/app.png"
    }
  }
}
\`\`\`

- **macOS** \`app.icns\`  ·  **Windows** \`app.ico\`  ·  **Linux** \`app.png\` (512×512+)
`;
}

/** Minimal package.json so Capacitor's (Node-based) CLI and platforms resolve. */
function packageJson(): string {
  return JSON.stringify(
    {
      name: "denext-app",
      private: true,
      // Capacitor's CLI + native platforms are Node packages. Install once with
      // \`deno install\` (or npm install), then use the \`mobile:*\` deno tasks.
      devDependencies: {
        "@capacitor/cli": CAPACITOR,
        "@capacitor/core": CAPACITOR,
        "@capacitor/ios": CAPACITOR,
        "@capacitor/android": CAPACITOR,
      },
    },
    null,
    2,
  ) + "\n";
}

function layout(opts: ScaffoldOptions): string {
  const cssImport = opts.tailwind ? `import "./globals.css";\n` : "";
  const headLink = opts.tailwind ? "" : `\n  head: \`<link rel="stylesheet" href="/styles.css">\`,`;
  return `// Root layout — denext supplies <html>/<head>/<body>; this renders the chrome.
${cssImport}import { Link } from "denext";
import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext app",
  description: "Built with denext",${headLink}
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="app">
      <header class="topbar">
        <Link class="brand" href="/">denext</Link>
      </header>
      <main class="content">{children}</main>
    </div>
  );
}
`;
}

/** The `minimal` template's home page — a bare server component, no interactivity. */
function minimalPage(opts: ScaffoldOptions): string {
  const tw = opts.tailwind;
  const sectionCls = tw ? ' class="mx-auto max-w-xl p-8"' : "";
  const h1Cls = tw ? ' class="text-3xl font-bold"' : "";
  return `// Home page (minimal template).

import type { PageProps } from "denext/server";

export const metadata = { title: "denext — home" };

export default function Home(_props: PageProps) {
  return (
    <section${sectionCls}>
      <h1${h1Cls}>Hello from denext 👋</h1>
      <p>Edit app/page.tsx to get started.</p>
    </section>
  );
}
`;
}

/**
 * The `default` template's home page — a Server Component (no hooks, no `"use client"`,
 * ships no JavaScript) that renders the `Counter` island. The split is the App Router's:
 * the page fetches and lays out, the island is the one file the browser runs.
 */
function page(opts: ScaffoldOptions): string {
  const tw = opts.tailwind;
  const sectionCls = tw ? ' class="mx-auto max-w-xl p-8"' : "";
  const h1Cls = tw ? ' class="text-3xl font-bold"' : "";
  return `// Home page — a Server Component. It runs only on the server (make it \`async\` and
// await your data here; a \`lib/db.ts\` import stays server-side) and ships no
// JavaScript. The interactive part is the <Counter /> island in ./counter.tsx.

import type { PageProps } from "denext/server";
import { Counter } from "./counter.tsx";

export const metadata = { title: "denext — home" };

export default function Home(_props: PageProps) {
  return (
    <section${sectionCls}>
      <h1${h1Cls}>Hello from denext 👋</h1>
      <p>This page is a Server Component; the button below is a client island.</p>
      <Counter />
    </section>
  );
}
`;
}

/**
 * The `default` template's `"use client"` island: hooks and an event handler, so it
 * renders on the server AND hydrates — the counter proves the round-trip.
 */
function counter(opts: ScaffoldOptions): string {
  const tw = opts.tailwind;
  const buttonCls = tw ? ' class="mt-4 rounded bg-black px-4 py-2 text-white"' : "";
  // A dynamic class expression driven by the hydrated flag.
  const statusExpr = tw
    ? `{hydrated ? "text-green-600" : "text-gray-500"}`
    : `{hydrated ? "on" : "off"}`;
  return `"use client";

// A client island. \`"use client"\` marks the boundary: this file (and what it
// imports) is bundled for the browser, hooks and event handlers work, and the
// Server Component that renders it passes plain serialisable props.

import { useEffect, useState } from "denext";

export function Counter() {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  return (
    <div>
      <p>
        Status:{" "}
        <span class=${statusExpr}>
          {hydrated ? "hydrated ✅" : "server-rendered (not yet hydrated)"}
        </span>
      </p>
      <button${buttonCls} type="button" onClick={() => setCount((c) => c + 1)}>
        Clicked {count} {count === 1 ? "time" : "times"}
      </button>
    </div>
  );
}
`;
}

const GLOBAL_CSS_PLAIN = `:root { font-family: system-ui, sans-serif; }
.app { min-height: 100vh; }
.topbar { padding: 1rem; border-bottom: 1px solid #eee; }
.brand { font-weight: 700; text-decoration: none; color: inherit; }
.content { padding: 1rem; }
.on { color: #16a34a; }
.off { color: #6b7280; }
`;

const TAILWIND_INPUT = `@import "tailwindcss";\n`;

function denextConfig(opts: ScaffoldOptions): string {
  const appBase = opts.srcDir ? "src/app" : "app";
  const lines: string[] = [];
  if (opts.tailwind) {
    lines.push(
      `  // Tailwind is compiled by denext from styles/tailwind.css into ${appBase}/globals.css.`,
      `  tailwind: { input: "styles/tailwind.css", output: "${appBase}/globals.css" },`,
    );
  }
  if (opts.compiler) {
    lines.push(
      `  reactCompiler: true, // auto-memoization`,
    );
  }
  return `import type { DenextConfig } from "denext/server";

export default {
${lines.join("\n")}
} satisfies DenextConfig;
`;
}

/**
 * Compute the list of files a scaffold would write, relative to `opts.dir`. Pure
 * (no I/O) so it is easy to test; {@linkcode scaffoldProject} writes them.
 *
 * @param opts What to generate.
 * @returns The files to create, with repo-relative paths.
 */
export function scaffoldFiles(opts: ScaffoldOptions): ScaffoldFile[] {
  const appBase = opts.srcDir ? "src/app" : "app";
  // Generated / build outputs to keep out of version control.
  // `.denext/` (build output), `out/` (`denext export`), env files with secrets.
  const ignore = [".denext/", "out/", ".env*.local", "*.local", "patches/.work/"];
  if (opts.tailwind) ignore.push(`${appBase}/globals.css`);
  if (opts.desktop) ignore.push("dist/"); // packaged desktop binaries
  if (opts.capacitor) ignore.push(...CAPACITOR_IGNORES);
  const gitignore = ignore.join("\n") + "\n";

  const files: ScaffoldFile[] = [
    { path: "deno.json", content: denoJson(opts) },
    { path: ".gitignore", content: gitignore },
    { path: "README.md", content: readme(opts, appBase) },
    { path: `${appBase}/layout.tsx`, content: layout(opts) },
    {
      path: `${appBase}/page.tsx`,
      content: opts.template === "minimal" ? minimalPage(opts) : page(opts),
    },
  ];
  if (opts.template !== "minimal") {
    files.push({ path: `${appBase}/counter.tsx`, content: counter(opts) });
  }
  if (opts.tailwind) {
    files.push({ path: "styles/tailwind.css", content: TAILWIND_INPUT });
  } else {
    files.push({ path: "public/styles.css", content: GLOBAL_CSS_PLAIN });
  }
  if (opts.tailwind || opts.compiler) {
    files.push({ path: "denext.config.ts", content: denextConfig(opts) });
  }
  if (opts.desktop) {
    files.push({ path: "desktop.ts", content: desktopEntry() });
    files.push({ path: "icons/README.md", content: desktopIcons() });
    files.push({
      path: "scripts/package-macos.ts",
      content: MACOS_PACKAGE_SCRIPT,
    });
    files.push({
      path: "scripts/package-linux.ts",
      content: LINUX_PACKAGE_SCRIPT,
    });
    files.push({
      path: "scripts/package-windows.ts",
      content: WINDOWS_PACKAGE_SCRIPT,
    });
  }
  if (opts.capacitor) {
    files.push({ path: "capacitor.config.ts", content: capacitorConfig() });
    files.push({ path: "package.json", content: packageJson() });
  }
  return files;
}

/**
 * Scaffold a new denext project into `opts.dir`. Refuses to overwrite a
 * non-empty directory. Unless `opts.vscode` is `false`, also writes (or additively
 * merges) the `.vscode` files that turn on the Deno LSP — kept out of
 * {@linkcode scaffoldFiles} because they are merged into an existing file rather than
 * refused by `init`.
 *
 * @param opts Target directory and feature toggles.
 * @returns The relative paths written.
 */
export async function scaffoldProject(
  opts: ScaffoldOptions,
): Promise<string[]> {
  const files = scaffoldFiles(opts);
  await refuseToClobber(files, opts);
  for (const f of files) {
    const abs = join(opts.dir, f.path);
    await Deno.mkdir(join(abs, ".."), { recursive: true });
    await Deno.writeTextFile(abs, f.content);
  }
  const written = files.map((f) => f.path);
  if (opts.vscode !== false) {
    const vscode: string[] = [];
    await ensureVscodeDeno(opts.dir, vscode);
    written.push(...vscode.map((p) => relative(opts.dir, p)));
  }
  return written;
}

/** `init`: never clobber an existing file; `create`: the target must be empty or absent. */
async function refuseToClobber(files: ScaffoldFile[], opts: ScaffoldOptions): Promise<void> {
  if (opts.allowExisting) {
    // `init` into an existing dir: never clobber a file that already exists. A README is
    // the one file a repo commonly already has — keep theirs and skip ours.
    await dropExistingReadme(files, opts.dir);
    for (const f of files) {
      if (await exists(join(opts.dir, f.path))) {
        throw new Error(
          `denext init: ${f.path} already exists; refusing to overwrite.`,
        );
      }
    }
  } else {
    // `create`: the target must be empty or not yet exist.
    try {
      for await (const _ of Deno.readDir(opts.dir)) {
        throw new Error(
          `denext create: target directory ${opts.dir} is not empty.`,
        );
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err; // NotFound → create it
    }
  }
}

/**
 * Enable the Deno language server for a project so editors resolve the `denext` import
 * map (and, in a migrated app, the react aliases) exactly the way `deno` does. Without
 * this, VSCode's built-in TypeScript server — which knows nothing about `deno.json`'s
 * `imports` — flags `denext`/`denext/desktop` and the aliased `react` as unresolved even
 * though `deno check` passes and the app builds.
 *
 * Writes `.vscode/settings.json` (`"deno.enable": true`) and `.vscode/extensions.json`
 * (recommending `denoland.vscode-deno`, so the LSP is one prompt away). Both are merged
 * additively: any existing keys/recommendations are preserved, the entry is added only when
 * missing, and a re-run with it already present writes nothing (idempotent). Pushes each
 * changed path onto `written`. Scoped to this app dir — VSCode only reads a folder's
 * `.vscode` when that folder is a workspace root, so a monorepo's other (Node) packages are
 * unaffected unless this app is opened directly. Shared by `denext create` / `init` and
 * `denext migrate`.
 *
 * @param dir The app directory.
 * @param written Accumulator each changed `.vscode` path (absolute) is pushed onto.
 */
export async function ensureVscodeDeno(dir: string, written: string[]): Promise<void> {
  const vscodeDir = join(dir, ".vscode");

  // settings.json → turn on the Deno LSP for this workspace folder.
  const settingsPath = join(vscodeDir, "settings.json");
  const settings = (await readVscodeJson(settingsPath)) ?? {};
  if (settings["deno.enable"] !== true) {
    settings["deno.enable"] = true;
    await writeVscodeJson(vscodeDir, settingsPath, settings, written);
  }

  // extensions.json → recommend the Deno extension so the LSP is a click away.
  const extPath = join(vscodeDir, "extensions.json");
  const ext = (await readVscodeJson(extPath)) ?? {};
  const recs = Array.isArray(ext.recommendations) ? ext.recommendations as string[] : [];
  if (!recs.includes("denoland.vscode-deno")) {
    ext.recommendations = [...recs, "denoland.vscode-deno"];
    await writeVscodeJson(vscodeDir, extPath, ext, written);
  }
}

/** Read a `.vscode/*.json` file (JSONC — VSCode allows comments), or null when absent/invalid. */
async function readVscodeJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return parseJsonc(await Deno.readTextFile(path)) as Record<string, unknown>;
  } catch {
    return null;
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
  // Same symlink guard as migrate's `ensureGitignore`: unlink first so a symlinked target
  // (possible in a cloned third-party repo) isn't followed out of tree.
  await Deno.remove(path).catch(() => {});
  await Deno.writeTextFile(path, JSON.stringify(obj, null, 2) + "\n");
  written.push(path);
}

/** Remove the generated README from `files` when the target dir already has one. */
async function dropExistingReadme(files: ScaffoldFile[], dir: string): Promise<void> {
  const i = files.findIndex((f) => f.path === "README.md");
  if (i !== -1 && await exists(join(dir, "README.md"))) files.splice(i, 1);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The scaffolded macOS packaging script (scripts/package-macos.ts). Builds one or
 * more arch .apps, code-signs, and (with a Developer ID identity + notarytool profile)
 * notarizes + staples. See the macOS distribution docs. */
const MACOS_PACKAGE_SCRIPT = `#!/usr/bin/env -S deno run -A
/**
 * Package this \`deno desktop\` app for macOS distribution: build (for one or more
 * architectures), code-sign, and optionally notarize + staple. Run on a macOS host.
 *
 *   deno run -A scripts/package-macos.ts [--arch <mode>] [--no-export] [--dmg]
 *
 * --arch  host | arm64 | x86_64 | both | universal   (default: host)
 *           host      the machine's own architecture
 *           arm64     Apple Silicon (aarch64-apple-darwin)
 *           x86_64    Intel (x86_64-apple-darwin)
 *           both      arm64 AND x86_64 as two separate .app bundles
 *           universal one .app whose binaries are lipo-merged (runs natively on both)
 * --no-export  skip \`deno task export\` and reuse the existing out/ (faster iteration)
 * --dmg        also wrap each .app in a .dmg
 *
 * Signing / notarization are driven by env vars (nothing secret is hard-coded):
 *   DENEXT_CODESIGN_IDENTITY  "Developer ID Application: Name (TEAMID)". REQUIRED to
 *                             distribute. Omit → an ad-hoc signature (dev/local only;
 *                             Gatekeeper will block it on other Macs).
 *   DENEXT_ENTITLEMENTS       path to an entitlements .plist (optional).
 *   DENEXT_NOTARY_PROFILE     a \`xcrun notarytool store-credentials\` keychain profile.
 *                             Set (with a real identity) → notarize + staple each app.
 *   DENEXT_APP_NAME           output base name (default: the deno.json \`desktop.app.name\`).
 *
 * Outputs into ./dist/.
 *
 * See the "Distributing a macOS desktop app" doc for the full setup (creating a
 * Developer ID Application certificate, storing notarytool credentials, Gatekeeper).
 */

const TARGETS: Record<string, string> = {
  arm64: "aarch64-apple-darwin",
  x86_64: "x86_64-apple-darwin",
};

interface Opts {
  arch: "host" | "arm64" | "x86_64" | "both" | "universal";
  export: boolean;
  dmg: boolean;
}

function parseOpts(argv: string[]): Opts {
  const o: Opts = { arch: "host", export: true, dmg: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--arch") o.arch = argv[++i] as Opts["arch"];
    else if (a.startsWith("--arch=")) o.arch = a.slice(7) as Opts["arch"];
    else if (a === "--no-export") o.export = false;
    else if (a === "--dmg") o.dmg = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        new URL(import.meta.url).pathname,
        "\\nSee the header comment for usage.",
      );
      Deno.exit(0);
    } else throw new Error(\`unknown argument: \${a}\`);
  }
  const valid = ["host", "arm64", "x86_64", "both", "universal"];
  if (!valid.includes(o.arch)) {
    throw new Error(\`--arch must be one of \${valid.join(", ")}\`);
  }
  return o;
}

async function run(
  cmd: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<void> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    env: opts.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await p.output();
  if (code !== 0) throw new Error(\`command failed (\${code}): \${cmd.join(" ")}\`);
}

/** Read the desktop app name from deno.json (falls back to "app"). */
async function appName(): Promise<string> {
  const env = Deno.env.get("DENEXT_APP_NAME");
  if (env) return env;
  try {
    const cfg = JSON.parse(await Deno.readTextFile("deno.json"));
    const n = cfg?.desktop?.app?.name;
    if (typeof n === "string" && n.trim()) return n.trim();
  } catch { /* no/invalid deno.json */ }
  return "app";
}

/** Build a single .app for \`target\` (undefined = host arch). deno desktop signs it
 * ad-hoc; the caller re-signs with the real identity afterwards. */
async function buildApp(out: string, target?: string): Promise<void> {
  await Deno.remove(out, { recursive: true }).catch(() => {});
  const cmd = ["deno", "desktop", "-A", "--include", "out"];
  if (target) cmd.push("--target", target);
  cmd.push("--output", out, "desktop.ts");
  await run(cmd);
}

/** List the Mach-O files inside a .app bundle (executables + dylibs). */
async function machOFiles(app: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of walk(\`\${app}/Contents\`)) {
    if (!e.isFile) continue;
    const probe = await new Deno.Command("lipo", {
      args: ["-archs", e.path],
      stdout: "null",
      stderr: "null",
    }).output();
    if (probe.code === 0) out.push(e.path);
  }
  return out;
}

async function* walk(
  dir: string,
): AsyncGenerator<{ path: string; isFile: boolean }> {
  for await (const e of Deno.readDir(dir)) {
    const path = \`\${dir}/\${e.name}\`;
    if (e.isDirectory) yield* walk(path);
    else yield { path, isFile: e.isFile };
  }
}

/** Merge two same-layout .apps into one universal .app at \`dest\` (lipo per Mach-O). */
async function mergeUniversal(
  armApp: string,
  x86App: string,
  dest: string,
): Promise<void> {
  await Deno.remove(dest, { recursive: true }).catch(() => {});
  await run(["cp", "-R", armApp, dest]);
  for (const file of await machOFiles(dest)) {
    const rel = file.slice(dest.length);
    await run([
      "lipo",
      "-create",
      \`\${armApp}\${rel}\`,
      \`\${x86App}\${rel}\`,
      "-output",
      file,
    ]);
  }
}

/** The bundle's main executable path (from Info.plist CFBundleExecutable). */
async function mainExecutable(app: string): Promise<string> {
  const p = await new Deno.Command("plutil", {
    args: [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-o",
      "-",
      \`\${app}/Contents/Info.plist\`,
    ],
    stdout: "piped",
    stderr: "null",
  }).output();
  const name = new TextDecoder().decode(p.stdout).trim();
  // Fail loudly rather than returning an empty basename: an empty name would never
  // match in the sign loop's \`file === mainExe\` guard, so the main executable would be
  // signed twice (the second time without entitlements) — a silent invariant break.
  if (!p.success || !name) {
    throw new Error(
      \`could not read CFBundleExecutable from \${app}/Contents/Info.plist\`,
    );
  }
  return \`\${app}/Contents/MacOS/\${name}\`;
}

/** Code-sign a .app inside-out. With an identity: Hardened Runtime + secure timestamp
 * (required for notarization). Without one: an ad-hoc signature (dev/local only). */
async function sign(
  app: string,
  identity: string | undefined,
  entitlements?: string,
): Promise<void> {
  const id = identity ?? "-";
  const ts = identity ? "--timestamp" : "--timestamp=none";
  const mainExe = await mainExecutable(app);
  // Nested Mach-O (dylibs/helpers) first; then the bundle, which signs the main
  // executable and applies the entitlements.
  for (const file of await machOFiles(app)) {
    if (file === mainExe) continue;
    await run([
      "codesign",
      "--force",
      ts,
      "--options",
      "runtime",
      "-s",
      id,
      file,
    ]);
  }
  const ent = identity && entitlements ? ["--entitlements", entitlements] : [];
  await run([
    "codesign",
    "--force",
    ts,
    "--options",
    "runtime",
    ...ent,
    "-s",
    id,
    app,
  ]);
  await run(["codesign", "--verify", "--deep", "--strict", app]);
}

/** Notarize + staple a .app (requires a real identity + a notarytool keychain profile). */
async function notarize(app: string, profile: string): Promise<void> {
  const zip = \`\${app}.zip\`;
  try {
    await run(["ditto", "-c", "-k", "--keepParent", app, zip]);
    await run([
      "xcrun",
      "notarytool",
      "submit",
      zip,
      "--keychain-profile",
      profile,
      "--wait",
    ]);
    await run(["xcrun", "stapler", "staple", app]);
  } finally {
    // Remove the submission zip even if notarytool/staple failed.
    await Deno.remove(zip).catch(() => {});
  }
}

async function makeDmg(app: string): Promise<void> {
  const dmg = app.replace(/\\.app$/, ".dmg");
  await Deno.remove(dmg).catch(() => {});
  await run([
    "hdiutil",
    "create",
    "-volname",
    app.split("/").pop()!.replace(/\\.app$/, ""),
    "-srcfolder",
    app,
    "-ov",
    "-format",
    "UDZO",
    dmg,
  ]);
}

/** The signing setup, from env (nothing secret is hard-coded). */
interface Signing {
  identity: string | undefined;
  entitlements: string | undefined;
  notaryProfile: string | undefined;
}

function signingFromEnv(): Signing {
  const identity = Deno.env.get("DENEXT_CODESIGN_IDENTITY") || undefined;
  const notaryProfile = Deno.env.get("DENEXT_NOTARY_PROFILE") || undefined;
  if (!identity) {
    console.warn(
      "⚠  DENEXT_CODESIGN_IDENTITY is unset → ad-hoc signature only. The app runs\\n" +
        "   locally but Gatekeeper will block it on other Macs. Set a\\n" +
        '   "Developer ID Application: … (TEAMID)" identity to distribute.',
    );
  }
  if (notaryProfile && !identity) {
    throw new Error(
      "notarization needs DENEXT_CODESIGN_IDENTITY (a real Developer ID identity).",
    );
  }
  return {
    identity,
    entitlements: Deno.env.get("DENEXT_ENTITLEMENTS") || undefined,
    notaryProfile,
  };
}

/** One .app whose binaries are lipo-merged from an arm64 and an x86_64 build. */
async function buildUniversal(name: string): Promise<string> {
  const arm = "dist/.tmp-arm64.app";
  const x86 = "dist/.tmp-x86_64.app";
  try {
    await buildApp(arm, TARGETS.arm64);
    await buildApp(x86, TARGETS.x86_64);
    const uni = \`dist/\${name}.app\`;
    await mergeUniversal(arm, x86, uni);
    return uni;
  } finally {
    // Always clear the per-arch temp bundles (hundreds of MB each) — even if a
    // build/merge threw partway, so a failed run doesn't litter dist/.
    await Deno.remove(arm, { recursive: true }).catch(() => {});
    await Deno.remove(x86, { recursive: true }).catch(() => {});
  }
}

/** Build the .app bundle(s) for the requested arch mode; returns their paths. */
async function buildArtifacts(opts: Opts, name: string): Promise<string[]> {
  if (opts.arch === "universal") return [await buildUniversal(name)];
  if (opts.arch === "both") {
    const artifacts: string[] = [];
    for (const a of ["arm64", "x86_64"] as const) {
      const app = \`dist/\${name}-\${a}.app\`;
      await buildApp(app, TARGETS[a]);
      artifacts.push(app);
    }
    return artifacts;
  }
  const app = \`dist/\${name}.app\`;
  await buildApp(app, opts.arch === "host" ? undefined : TARGETS[opts.arch]);
  return [app];
}

/**
 * Sign, notarize and wrap each bundle. A lipo-merged (universal) bundle always needs
 * re-signing; for others we re-sign only when a real identity is provided (deno desktop
 * already applied ad-hoc).
 */
async function finishArtifacts(
  artifacts: string[],
  opts: Opts,
  s: Signing,
): Promise<void> {
  for (const app of artifacts) {
    if (s.identity || opts.arch === "universal") {
      await sign(app, s.identity, s.entitlements);
    }
    if (s.notaryProfile && s.identity) await notarize(app, s.notaryProfile);
    if (opts.dmg) await makeDmg(app);
  }
}

function distributionNote(s: Signing): string {
  if (!s.identity) {
    return "  (ad-hoc — not distributable; see the macOS distribution doc)";
  }
  if (!s.notaryProfile) {
    return "  (signed, NOT notarized — set DENEXT_NOTARY_PROFILE to notarize)";
  }
  return "  (signed + notarized + stapled — ready to distribute)";
}

async function main(): Promise<void> {
  if (Deno.build.os !== "darwin") {
    console.error(
      "package-macos.ts must run on macOS (it shells out to codesign/notarytool).",
    );
    Deno.exit(1);
  }
  const opts = parseOpts(Deno.args);
  const signing = signingFromEnv();
  const name = await appName();
  if (opts.export) await run(["deno", "task", "export"]);
  await Deno.mkdir("dist", { recursive: true });
  const artifacts = await buildArtifacts(opts, name);
  await finishArtifacts(artifacts, opts, signing);
  console.log("\\n✓ Packaged:");
  for (const a of artifacts) console.log("  " + a);
  console.log(distributionNote(signing));
}

if (import.meta.main) await main();
`;

/** The scaffolded Linux packaging script (scripts/package-linux.ts). `deno desktop`
 * emits a complete Linux app bundle directory (executable + `.so` + `.desktop`), so
 * this builds one or both arches and wraps each as a distributable `.tar.gz` (and an
 * AppImage when `appimagetool` is on PATH). Cross-builds from any OS. */
const LINUX_PACKAGE_SCRIPT = `#!/usr/bin/env -S deno run -A
/**
 * Package this \`deno desktop\` app for Linux distribution. \`deno desktop\` produces a
 * complete bundle directory (the executable, its \`.so\`, and a freedesktop \`.desktop\`
 * launcher); this builds one or both arches and wraps each as a \`.tar.gz\` (and an
 * AppImage when \`appimagetool\` is available). Cross-builds from any OS.
 *
 *   deno run -A scripts/package-linux.ts [--arch <mode>] [--no-export] [--appimage]
 *
 * --arch  host | x86_64 | arm64 | both   (default: host)
 *           host    the machine's own architecture (x86_64 when cross-building from macOS Intel)
 *           x86_64  x86_64-unknown-linux-gnu
 *           arm64   aarch64-unknown-linux-gnu
 *           both    x86_64 AND arm64 as two bundles
 * --no-export  skip \`deno task export\` and reuse the existing out/ (faster iteration)
 * --appimage   also build an AppImage per arch (needs \`appimagetool\` on PATH)
 *
 *   DENEXT_APP_NAME  output base name (default: the deno.json \`desktop.app.name\`).
 *
 * The end user's Linux desktop needs a WebKitGTK runtime (webkit2gtk) for the window;
 * that is a deploy-environment dependency, not baked into the bundle. Outputs into ./dist/.
 */

const TARGETS: Record<string, string> = {
  x86_64: "x86_64-unknown-linux-gnu",
  arm64: "aarch64-unknown-linux-gnu",
};
// Underscore-free labels for output paths: \`deno desktop\` derives a reverse-DNS bundle id
// from the output basename and rejects '_' (so a raw \`x86_64\` suffix drops the .desktop file).
const LABELS: Record<string, string> = { x86_64: "x64", arm64: "arm64" };
const hostArch = Deno.build.arch === "aarch64" ? "arm64" : "x86_64";

interface Opts {
  arch: "host" | "x86_64" | "arm64" | "both";
  export: boolean;
  appimage: boolean;
}

function parseOpts(argv: string[]): Opts {
  const o: Opts = { arch: "host", export: true, appimage: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--arch") o.arch = argv[++i] as Opts["arch"];
    else if (a.startsWith("--arch=")) o.arch = a.slice(7) as Opts["arch"];
    else if (a === "--no-export") o.export = false;
    else if (a === "--appimage") o.appimage = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        new URL(import.meta.url).pathname,
        "\\nSee the header comment for usage.",
      );
      Deno.exit(0);
    } else throw new Error(\`unknown argument: \${a}\`);
  }
  const valid = ["host", "x86_64", "arm64", "both"];
  if (!valid.includes(o.arch)) {
    throw new Error(\`--arch must be one of \${valid.join(", ")}\`);
  }
  return o;
}

async function run(cmd: string[]): Promise<void> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await p.output();
  if (code !== 0) throw new Error(\`command failed (\${code}): \${cmd.join(" ")}\`);
}

/** Read the desktop app name from deno.json (falls back to "app"). */
async function appName(): Promise<string> {
  const env = Deno.env.get("DENEXT_APP_NAME");
  if (env) return env;
  try {
    const cfg = JSON.parse(await Deno.readTextFile("deno.json"));
    const n = cfg?.desktop?.app?.name;
    if (typeof n === "string" && n.trim()) return n.trim();
  } catch { /* no/invalid deno.json */ }
  return "app";
}

/** Build a Linux bundle directory for \`arch\` at dist/<name>-<label>. */
async function buildBundle(
  name: string,
  arch: "x86_64" | "arm64",
): Promise<string> {
  const out = \`dist/\${name}-\${LABELS[arch]}\`;
  await Deno.remove(out, { recursive: true }).catch(() => {});
  const cmd = [
    "deno",
    "desktop",
    "-A",
    "--include",
    "out",
    "--target",
    TARGETS[arch],
  ];
  // Linux uses a PNG icon; deno desktop skips a non-PNG gracefully.
  for (const icon of ["icons/app.png", "desktop-icon.png"]) {
    try {
      await Deno.stat(icon);
      cmd.push("--icon", icon);
      break;
    } catch { /* no icon at this path */ }
  }
  cmd.push("--output", out, "desktop.ts");
  await run(cmd);
  return out;
}

/** tar.gz a bundle directory for distribution. */
async function tarball(
  name: string,
  arch: "x86_64" | "arm64",
  dir: string,
): Promise<string> {
  const tgz = \`dist/\${name}-\${LABELS[arch]}-linux.tar.gz\`;
  await run(["tar", "czf", tgz, "-C", "dist", dir.replace(/^dist\\//, "")]);
  return tgz;
}

/** Build an AppImage for a bundle if appimagetool is available; returns its path or null. */
async function appImage(
  name: string,
  arch: "x86_64" | "arm64",
  dir: string,
): Promise<string | null> {
  const tool = await new Deno.Command("sh", {
    args: ["-c", "command -v appimagetool"],
    stdout: "null",
    stderr: "null",
  }).output().then((r) => r.code === 0, () => false);
  if (!tool) {
    console.warn(
      \`  appimagetool not found — skipping AppImage for \${arch} (tar.gz still built).\`,
    );
    return null;
  }
  const appdir = \`\${dir}.AppDir\`;
  await Deno.remove(appdir, { recursive: true }).catch(() => {});
  await Deno.mkdir(appdir, { recursive: true });
  // AppDir layout: the bundle contents + the .desktop at the root + an AppRun → exe.
  await run(["cp", "-r", \`\${dir}/.\`, appdir]);
  const exe = \`\${name}-\${LABELS[arch]}\`;
  await Deno.writeTextFile(
    \`\${appdir}/AppRun\`,
    \`#!/bin/sh\\nHERE=$(dirname "$0")\\nexec "$HERE/\${exe}" "$@"\\n\`,
  );
  await Deno.chmod(\`\${appdir}/AppRun\`, 0o755);
  const outFile = \`dist/\${name}-\${LABELS[arch]}.AppImage\`;
  await run(["appimagetool", appdir, outFile]);
  return outFile;
}

/** Filesystem-safe base name (spaces/punctuation → hyphens) for artifact paths. */
function slugify(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "app";
}

async function main(): Promise<void> {
  const opts = parseOpts(Deno.args);
  const name = slugify(await appName());
  await Deno.mkdir("dist", { recursive: true });
  if (opts.export) await run(["deno", "task", "export"]);

  const arches: Array<"x86_64" | "arm64"> = opts.arch === "both"
    ? ["x86_64", "arm64"]
    : [opts.arch === "host" ? hostArch : opts.arch];

  const artifacts: string[] = [];
  for (const arch of arches) {
    const dir = await buildBundle(name, arch);
    artifacts.push(await tarball(name, arch, dir));
    if (opts.appimage) {
      const img = await appImage(name, arch, dir);
      if (img) artifacts.push(img);
    }
  }

  console.log("\\n  Built:");
  for (const a of artifacts) console.log("  " + a);
  console.log(
    "\\n  (the target Linux desktop needs a WebKitGTK / webkit2gtk runtime installed)",
  );
}

if (import.meta.main) await main();
`;

/** Windows packaging script — kept byte-identical to
 * examples/native/scripts/package-windows.ts (asserted by scaffold.test.ts). Builds the
 * `.exe` via `deno desktop --target`, zips it, and Authenticode-signs when a cert is set. */
const WINDOWS_PACKAGE_SCRIPT = `#!/usr/bin/env -S deno run -A
/**
 * Package this \`deno desktop\` app for Windows distribution. \`deno desktop\` produces a
 * complete bundle directory (the \`.exe\`, its \`.dll\`s, and resources); this builds one or
 * both arches and wraps each as a \`.zip\`, then Authenticode-signs the \`.exe\` when a code-
 * signing certificate is provided. The \`.exe\` cross-builds from any OS; signing only runs
 * where \`signtool\` is available (Windows) and a cert is configured.
 *
 *   deno run -A scripts/package-windows.ts [--arch <mode>] [--no-export] [--no-sign]
 *
 * --arch  host | x86_64 | arm64 | both   (default: host)
 *           host    the machine's own architecture
 *           x86_64  x86_64-pc-windows-msvc
 *           arm64   aarch64-pc-windows-msvc
 *           both    x86_64 AND arm64 as two bundles
 * --no-export  skip \`deno task export\` and reuse the existing out/ (faster iteration)
 * --no-sign    skip Authenticode signing even when a certificate is configured
 *
 *   DENEXT_APP_NAME                output base name (default: the deno.json \`desktop.app.name\`).
 *   DENEXT_WINDOWS_CERT            path to a code-signing certificate (.pfx) — signing is
 *                                  skipped when unset (no secrets are ever baked in).
 *   DENEXT_WINDOWS_CERT_PASSWORD   the .pfx password, if any.
 *   DENEXT_SIGN_TIMESTAMP_URL      RFC-3161 timestamp server (default: DigiCert's).
 *
 * The end user's Windows machine needs the Microsoft Edge WebView2 runtime for the window
 * (preinstalled on current Windows 10/11); that is a deploy-environment dependency, not
 * baked into the bundle. Outputs into ./dist/.
 */

const TARGETS: Record<string, string> = {
  x86_64: "x86_64-pc-windows-msvc",
  arm64: "aarch64-pc-windows-msvc",
};
// Underscore-free labels for output paths: \`deno desktop\` derives a reverse-DNS bundle id
// from the output basename and rejects '_' (so a raw \`x86_64\` suffix drops resources).
const LABELS: Record<string, string> = { x86_64: "x64", arm64: "arm64" };
const hostArch = Deno.build.arch === "aarch64" ? "arm64" : "x86_64";
const DEFAULT_TIMESTAMP_URL = "http://timestamp.digicert.com";

interface Opts {
  arch: "host" | "x86_64" | "arm64" | "both";
  export: boolean;
  sign: boolean;
}

function parseOpts(argv: string[]): Opts {
  const o: Opts = { arch: "host", export: true, sign: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--arch") o.arch = argv[++i] as Opts["arch"];
    else if (a.startsWith("--arch=")) o.arch = a.slice(7) as Opts["arch"];
    else if (a === "--no-export") o.export = false;
    else if (a === "--no-sign") o.sign = false;
    else if (a === "-h" || a === "--help") {
      console.log(
        new URL(import.meta.url).pathname,
        "\\nSee the header comment for usage.",
      );
      Deno.exit(0);
    } else throw new Error(\`unknown argument: \${a}\`);
  }
  const valid = ["host", "x86_64", "arm64", "both"];
  if (!valid.includes(o.arch)) {
    throw new Error(\`--arch must be one of \${valid.join(", ")}\`);
  }
  return o;
}

async function run(cmd: string[]): Promise<void> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await p.output();
  if (code !== 0) throw new Error(\`command failed (\${code}): \${cmd.join(" ")}\`);
}

/** Whether a command exists on PATH. */
async function has(cmd: string): Promise<boolean> {
  const probe = Deno.build.os === "windows"
    ? { args: ["/c", "where", cmd] }
    : { args: ["-c", \`command -v \${cmd}\`] };
  const bin = Deno.build.os === "windows" ? "cmd" : "sh";
  return await new Deno.Command(bin, { ...probe, stdout: "null", stderr: "null" })
    .output().then((r) => r.code === 0, () => false);
}

/** Read the desktop app name from deno.json (falls back to "app"). */
async function appName(): Promise<string> {
  const env = Deno.env.get("DENEXT_APP_NAME");
  if (env) return env;
  try {
    const cfg = JSON.parse(await Deno.readTextFile("deno.json"));
    const n = cfg?.desktop?.app?.name;
    if (typeof n === "string" && n.trim()) return n.trim();
  } catch { /* no/invalid deno.json */ }
  return "app";
}

/** Build a Windows bundle directory for \`arch\` at dist/<name>-<label>. */
async function buildBundle(
  name: string,
  arch: "x86_64" | "arm64",
): Promise<string> {
  const out = \`dist/\${name}-\${LABELS[arch]}\`;
  await Deno.remove(out, { recursive: true }).catch(() => {});
  const cmd = [
    "deno",
    "desktop",
    "-A",
    "--include",
    "out",
    "--target",
    TARGETS[arch],
  ];
  // Windows uses an .ico icon; deno desktop skips a non-.ico gracefully.
  for (const icon of ["icons/app.ico", "desktop-icon.ico"]) {
    try {
      await Deno.stat(icon);
      cmd.push("--icon", icon);
      break;
    } catch { /* no icon at this path */ }
  }
  cmd.push("--output", out, "desktop.ts");
  await run(cmd);
  return out;
}

/** Authenticode-sign the bundle's .exe when a certificate is configured; else skip. */
async function sign(name: string, arch: "x86_64" | "arm64", dir: string): Promise<void> {
  const cert = Deno.env.get("DENEXT_WINDOWS_CERT");
  if (!cert) {
    console.warn(
      \`  no DENEXT_WINDOWS_CERT set — skipping Authenticode signing for \${arch} (zip still built).\`,
    );
    return;
  }
  if (!(await has("signtool"))) {
    console.warn(
      \`  signtool not found (Windows SDK) — skipping signing for \${arch}; sign on a Windows host/CI.\`,
    );
    return;
  }
  const exe = \`\${dir}/\${name}-\${LABELS[arch]}.exe\`;
  const timestamp = Deno.env.get("DENEXT_SIGN_TIMESTAMP_URL") ?? DEFAULT_TIMESTAMP_URL;
  const args = ["sign", "/f", cert, "/fd", "sha256", "/tr", timestamp, "/td", "sha256"];
  const pass = Deno.env.get("DENEXT_WINDOWS_CERT_PASSWORD");
  if (pass) args.push("/p", pass);
  args.push(exe);
  await run(["signtool", ...args]);
}

/** Zip a bundle directory for distribution (prefers \`zip\`, falls back to bsdtar). */
async function zipBundle(
  name: string,
  arch: "x86_64" | "arm64",
  dir: string,
): Promise<string> {
  const zip = \`dist/\${name}-\${LABELS[arch]}-windows.zip\`;
  await Deno.remove(zip).catch(() => {});
  const rel = dir.replace(/^dist\\//, "");
  if (await has("zip")) {
    await run(["sh", "-c", \`cd dist && zip -r "\${rel}-windows.zip" "\${rel}"\`]);
  } else {
    // bsdtar (default on Windows 10+/macOS) writes zip from the .zip suffix via -a.
    await run(["tar", "-a", "-c", "-f", zip, "-C", "dist", rel]);
  }
  return zip;
}

/** Filesystem-safe base name (spaces/punctuation → hyphens) for artifact paths. */
function slugify(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "app";
}

async function main(): Promise<void> {
  const opts = parseOpts(Deno.args);
  const name = slugify(await appName());
  await Deno.mkdir("dist", { recursive: true });
  if (opts.export) await run(["deno", "task", "export"]);

  const arches: Array<"x86_64" | "arm64"> = opts.arch === "both"
    ? ["x86_64", "arm64"]
    : [opts.arch === "host" ? hostArch : opts.arch];

  const artifacts: string[] = [];
  for (const arch of arches) {
    const dir = await buildBundle(name, arch);
    if (opts.sign) await sign(name, arch, dir);
    artifacts.push(await zipBundle(name, arch, dir));
  }

  console.log("\\n  Built:");
  for (const a of artifacts) console.log("  " + a);
  console.log(
    "\\n  (the target Windows machine needs the Microsoft Edge WebView2 runtime installed)",
  );
}

if (import.meta.main) await main();
`;
