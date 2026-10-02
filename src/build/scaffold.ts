// Project scaffolding for `denext create`. Generates a clean minimal starter
// (deno.json wired to the published JSR package, an app/ with a layout, a Server
// Component home page and a `"use client"` counter island, plus the `.vscode` files
// that turn on the Deno LSP), optionally with Tailwind, a `src/` layout, and the
// auto-memo compiler enabled.

import { basename, join, relative, SEPARATOR } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { VERSION } from "../../mod.ts";
import { reactCompatImportMap } from "./react-specifiers.ts";
import { FALLOW_GITIGNORE, fallowFiles, fallowTasks } from "./fallow-template.ts";
import {
  MCP_AGENTS_SECTION,
  MCP_README_ROWS,
  mcpTaskCommand,
  writeMcpClientConfigs,
} from "./mcp-template.ts";

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
   * Add the fallow code-health gate (dead code, duplication, complexity): a `fallow.toml`
   * tuned for a denext app, `fallow` / `fallow:audit` / `coverage:fallow` / `hooks:install`
   * tasks running the pinned `npm:fallow` through Deno, a `.githooks/pre-commit` gate (enabled
   * only by `deno task hooks:install`), the coverage converter, and an `AGENTS.md` with the
   * gate's instructions for coding agents.
   */
  fallow?: boolean;
  /**
   * Install denext's MCP server at the project level: a `mcp` task running the pinned denext
   * CLI's `denext mcp`, registered as the `denext` server in `.mcp.json` (Claude Code),
   * `.vscode/mcp.json` and `.cursor/mcp.json` (merged into files that already exist). With
   * {@linkcode fallow}, the generated `AGENTS.md` also lists the MCP tools.
   */
  mcp?: boolean;
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

A [denext](https://denext.dev) app — write it once, ship it to the web, iOS, Android and the desktop.

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
  }${opts.fallow ? FALLOW_README_ROWS : ""}${opts.mcp ? MCP_README_ROWS : ""}
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

/** The README task rows `--fallow` adds. */
const FALLOW_README_ROWS =
  "| `deno task fallow:audit` | fallow's changed-code gate (dead code, duplication, complexity) |\n" +
  "| `deno task hooks:install` | Run that gate before every `git commit` (`.githooks/pre-commit`) |\n";

/** A generated file: repo-relative path + contents. */
export interface ScaffoldFile {
  path: string;
  content: string;
  /** File mode on creation (e.g. `0o755` for the git hook); the default otherwise. */
  mode?: number;
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
    // `denext desktop run` exports, then opens desktop.ts's Deno.serve() in a native `deno desktop`
    // window on denext's pinned Deno Desktop runtime (a bare `deno desktop` uses the stock one).
    tasks.desktop = `deno run -A ${cli} desktop run .`;
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
    // Between the two, `ota manifest` stamps `out/_denext/ota.json`, so the bundled UI knows
    // its over-the-air version (inert until `mobile:add-ota` installs the native plugin).
    const cap = `deno run -A --node-modules-dir npm:@capacitor/cli@${CAPACITOR}`;
    tasks["mobile:sync"] = `deno task export && deno run -A ${cli} ota manifest out && ${cap} sync`;
    // Over-the-air UI updates: installs the DenextOta plugin into the committed ios/ and
    // android/ projects (run after `cap add`; safe to re-run).
    tasks["mobile:add-ota"] = `deno run -A ${cli} mobile add-ota .`;
    tasks["mobile:ios"] = `${cap} open ios`;
    tasks["mobile:android"] = `${cap} open android`;
  }
  if (opts.fallow) Object.assign(tasks, fallowTasks());
  if (opts.mcp) tasks.mcp = mcpTaskCommand(cli);
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
/**
 * The `minimumDependencyAge` a generated `deno.json` carries: Deno's default 24-hour hold on
 * freshly published versions stays on for every dependency EXCEPT denext's own packages, so a
 * project made right after a denext release installs the version that made it (the CLI running
 * is already that release) instead of failing "blocked by the minimum dependency age policy".
 */
export const DENEXT_MIN_DEP_AGE = { exclude: ["jsr:@denext/*"] } as const;

export function denoJson(opts: ScaffoldOptions): string {
  const config: Record<string, unknown> = {
    tasks: scaffoldTasks(opts),
    minimumDependencyAge: DENEXT_MIN_DEP_AGE,
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
// packaged app too).
//
// Native capabilities (\`denext desktop add <cap>\`) are read from \`desktop.capabilities\`
// in the config and served through the gated bridge — default deny when \`desktop\` is
// absent. To reverse-proxy a backend, add \`spa.proxy\` to \`denext.config.ts\` and pass
// \`proxy: (config as DenextConfig).spa?.proxy\` below.
import config from "./denext.config.ts";
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";

await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
});
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
  if (opts.desktop) {
    lines.push(
      `  desktop: {`,
      `    // Unique per app: keys the OS storage dirs and the secureStore keychain service, so`,
      `    // change it to YOUR reverse-DNS id (keep it equal to deno.json's desktop.app.identifier).`,
      `    // secureStore / fs / sqlite refuse to start without it, to avoid sharing data across apps.`,
      `    app: { identifier: "com.example.denext" },`,
      `    // capabilities: { fs: true, secureStore: true, shell: true },  // denext desktop add <cap>`,
      `  },`,
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
  if (opts.fallow) ignore.push(...FALLOW_GITIGNORE);
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
  // The desktop entry imports `./denext.config.ts` to resolve `desktop.capabilities`, so a
  // desktop scaffold always needs the config file even without tailwind/compiler.
  if (opts.tailwind || opts.compiler || opts.desktop) {
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
  if (opts.fallow) {
    files.push(
      ...fallowFiles().map((f) =>
        opts.mcp && f.path === "AGENTS.md" ? { ...f, content: f.content + MCP_AGENTS_SECTION } : f
      ),
    );
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
    await Deno.writeTextFile(abs, f.content, f.mode ? { mode: f.mode } : undefined);
  }
  const written = files.map((f) => f.path);
  if (opts.vscode !== false) {
    const vscode: string[] = [];
    await ensureVscodeDeno(opts.dir, vscode);
    // `/`-separated like every other scaffolded path, on Windows too.
    written.push(...vscode.map((p) => relative(opts.dir, p).split(SEPARATOR).join("/")));
  }
  if (opts.mcp) {
    // Merged like the .vscode files: `init` may meet a client config that already lists servers.
    const mcp = { written: [] as string[], skipped: [] as string[], errors: [] as string[] };
    await writeMcpClientConfigs(opts.dir, {}, mcp);
    written.push(...mcp.written);
    if (mcp.errors.length > 0) {
      throw new Error(`could not register the denext MCP server: ${mcp.errors.join("; ")}`);
    }
  }
  return written;
}

/** `init`: never clobber an existing file; `create`: the target must be empty or absent. */
async function refuseToClobber(files: ScaffoldFile[], opts: ScaffoldOptions): Promise<void> {
  if (opts.allowExisting) {
    // `init` into an existing dir: never clobber a file that already exists. A README (or
    // an agent guide) is the file a repo commonly already has — keep theirs and skip ours.
    await dropExistingDocs(files, opts.dir);
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

/** The generated docs `init` leaves out when the target dir already has its own. */
const KEEP_THEIRS = ["README.md", "AGENTS.md", "CLAUDE.md"];

/** Remove the generated README / agent guide from `files` when the target dir has one. */
async function dropExistingDocs(files: ScaffoldFile[], dir: string): Promise<void> {
  for (const name of KEEP_THEIRS) {
    const i = files.findIndex((f) => f.path === name);
    if (i !== -1 && await exists(join(dir, name))) files.splice(i, 1);
  }
}

/** Whether anything is at `path` — `lstat`, so a symlink counts even when it dangles (writing
 * through a dangling link would create its target, possibly outside the project). */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
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
 * architectures), code-sign, optionally notarize + staple, and wrap each .app in its installers.
 * Run on a macOS host.
 *
 *   deno run -A scripts/package-macos.ts [--arch <mode>] [--no-export] [--format <list>]
 *
 * --arch  host | arm64 | x86_64 | both | universal   (default: host)
 *           host      the machine's own architecture
 *           arm64     Apple Silicon (aarch64-apple-darwin)
 *           x86_64    Intel (x86_64-apple-darwin)
 *           both      arm64 AND x86_64 as two separate .app bundles
 *           universal one .app whose binaries are lipo-merged (runs natively on both)
 * --no-export  skip \`deno task export\` and reuse the existing out/ (faster iteration)
 * --format     installers to build beside each .app, comma-separated: dmg, pkg. Default: the
 *              denext.config.ts \`desktop.installers.macos\` list, else dmg.
 *                dmg  a drag-to-Applications disk image (hdiutil)
 *                pkg  an installer package for MDM / \`installer -pkg\` (productbuild)
 * --dmg        add a .dmg to whatever --format / the config asks for
 *
 * Signing / notarization are driven by env vars (nothing secret is hard-coded):
 *   DENEXT_CODESIGN_IDENTITY  "Developer ID Application: Name (TEAMID)". REQUIRED to
 *                             distribute. Omit → an ad-hoc signature (dev/local only;
 *                             Gatekeeper will block it on other Macs).
 *   DENEXT_ENTITLEMENTS       path to an entitlements .plist (optional).
 *   DENEXT_NOTARY_PROFILE     a \`xcrun notarytool store-credentials\` keychain profile.
 *                             Set (with a real identity) → notarize + staple each app (and
 *                             each signed .pkg).
 *   DENEXT_INSTALLER_IDENTITY "Developer ID Installer: Name (TEAMID)" — signs the .pkg.
 *                             Omit → an unsigned .pkg (MDM tools and Gatekeeper reject it).
 *   DENEXT_APP_NAME           output base name (default: the deno.json \`desktop.app.name\`).
 *
 * Builds on denext's pinned Deno Desktop runtime (custom app origin, per-app storage, deep links,
 * single instance), downloaded once into the Deno cache and SHA-256-verified; it needs the exact
 * Deno version it was built for (\`deno upgrade --version 2.9.7\`).
 *   DENEXT_DESKTOP_RUNTIME=stock     use the stock runtime instead (none of the above works)
 *   DENEXT_DESKTOP_RUNTIME_DIR=<dir> use a local runtime build (unverified; runtime development)
 *   DENEXT_DESKTOP_RUNTIME_VERIFY=1  re-hash the cached runtime before use
 *   DENEXT_DESKTOP_RUNTIME_ATTEST=1  also check a fresh download's build provenance (needs gh)
 *
 * Outputs into ./dist/.
 *
 * See the "Distributing a macOS desktop app" doc for the full setup (creating a
 * Developer ID Application certificate, storing notarytool credentials, Gatekeeper).
 */

import {
  desktopAppName as appName,
  desktopIncludeArgs,
  desktopInstallerPlan,
  type DesktopPackageArgs,
  desktopPackageFlags,
  desktopRun as run,
  desktopRuntimeEnv,
  parseDesktopPackageArgs,
  syncDesktopAppConfig,
  writeLaufeyLaunchConfig,
} from "denext/desktop";

const TARGETS: Record<string, string> = {
  arm64: "aarch64-apple-darwin",
  x86_64: "x86_64-apple-darwin",
};

type Opts = DesktopPackageArgs;

/** Build a single .app for \`target\` (undefined = host arch). deno desktop signs it
 * ad-hoc; the caller re-signs with the real identity afterwards. */
async function buildApp(out: string, target?: string): Promise<void> {
  await Deno.remove(out, { recursive: true }).catch(() => {});
  const cmd = [
    "deno",
    "desktop",
    // Baked least-privilege flags mean an unbaked permission should fail fast, not block on a
    // prompt the packaged GUI has no TTY to answer.
    "--no-prompt",
    ...await desktopPackageFlags(import.meta.url, "darwin"),
    "--include",
    "out",
    ...await desktopIncludeArgs(import.meta.url),
  ];
  if (target) cmd.push("--target", target);
  // deno desktop appends ".app" to --output on macOS, so pass the base name (strip a trailing
  // ".app") to land exactly at \`out\` — else it writes \`out.app\` and sign/lipo/dmg miss it.
  cmd.push("--output", out.replace(/\\.app$/, ""), "desktop.ts");
  // DENORT_DESKTOP_BIN + LAUFEY_DEV_DIR: denext's pinned runtime for this target (verified, cached).
  await run(cmd, await desktopRuntimeEnv(import.meta.url, target));
  // The webview backend's launch settings (app id, the origin's custom scheme, single instance),
  // read from Contents/Resources at launch. Writing into the bundle breaks deno desktop's ad-hoc
  // seal, so a bundle that got one is always re-signed.
  if (await writeLaufeyLaunchConfig(import.meta.url, "darwin", out)) {
    resealNeeded = true;
  }
}

/** Set when a bundle was modified after \`deno desktop\` signed it (see buildApp). */
let resealNeeded = false;

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

async function makeDmg(app: string): Promise<string> {
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
  return dmg;
}

/** Wrap a .app in an installer package (productbuild) that installs it into /Applications;
 * signed with the Developer ID Installer identity, and notarized + stapled with a notary profile. */
async function makePkg(app: string, s: Signing): Promise<string> {
  const pkg = app.replace(/\\.app$/, ".pkg");
  await Deno.remove(pkg).catch(() => {});
  const sign = s.installerIdentity ? ["--sign", s.installerIdentity] : [];
  await run([
    "productbuild",
    ...sign,
    "--component",
    app,
    "/Applications",
    pkg,
  ]);
  if (s.installerIdentity && s.notaryProfile) {
    await run([
      "xcrun",
      "notarytool",
      "submit",
      pkg,
      "--keychain-profile",
      s.notaryProfile,
      "--wait",
    ]);
    await run(["xcrun", "stapler", "staple", pkg]);
  } else if (!s.installerIdentity) {
    console.warn(
      \`  \${pkg}: unsigned (set DENEXT_INSTALLER_IDENTITY to a "Developer ID Installer" identity).\`,
    );
  }
  return pkg;
}

/** The signing setup, from env (nothing secret is hard-coded). */
interface Signing {
  identity: string | undefined;
  entitlements: string | undefined;
  notaryProfile: string | undefined;
  /** "Developer ID Installer: …" for the .pkg. */
  installerIdentity: string | undefined;
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
    installerIdentity: Deno.env.get("DENEXT_INSTALLER_IDENTITY") || undefined,
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
 * Sign, notarize and wrap each bundle in its installers; returns the installer paths. A
 * lipo-merged (universal) bundle always needs re-signing; for others we re-sign only when a real
 * identity is provided (deno desktop already applied ad-hoc).
 */
async function finishArtifacts(
  artifacts: string[],
  opts: Opts,
  formats: string[],
  s: Signing,
): Promise<string[]> {
  const installers: string[] = [];
  for (const app of artifacts) {
    if (s.identity || opts.arch === "universal" || resealNeeded) {
      await sign(app, s.identity, s.entitlements);
    }
    if (s.notaryProfile && s.identity) await notarize(app, s.notaryProfile);
    if (formats.includes("dmg")) installers.push(await makeDmg(app));
    if (formats.includes("pkg")) installers.push(await makePkg(app, s));
  }
  return installers;
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
  const opts = parseDesktopPackageArgs(Deno.args, {
    arches: ["host", "arm64", "x86_64", "both", "universal"],
    legacy: { "--dmg": "dmg" },
  });
  const signing = signingFromEnv();
  const name = await appName();
  // --format, else desktop.installers.macos in denext.config.ts, else a .dmg.
  const plan = await desktopInstallerPlan(
    import.meta.url,
    "darwin",
    opts.formats,
    opts.add,
  );
  // .deno-desktop/app.json (the app origin + identifier) and its deno.json compile.include.
  await syncDesktopAppConfig(import.meta.url);
  if (opts.export) await run(["deno", "task", "export"]);
  await Deno.mkdir("dist", { recursive: true });
  const artifacts = await buildArtifacts(opts, name);
  const installers = await finishArtifacts(
    artifacts,
    opts,
    plan.formats,
    signing,
  );
  console.log("\\n✓ Packaged:");
  for (const a of [...artifacts, ...installers]) console.log("  " + a);
  console.log(distributionNote(signing));
}

if (import.meta.main) await main();
`;

/** The scaffolded Linux packaging script (scripts/package-linux.ts). `deno desktop`
 * emits a complete Linux app bundle directory (executable + `.so` + `.desktop`), so
 * this builds one or both arches and wraps each in its installers: `.tar.gz` + `.deb` by
 * default, `.rpm` (rpmbuild) and an AppImage (appimagetool) on request. */
const LINUX_PACKAGE_SCRIPT = `#!/usr/bin/env -S deno run -A
/**
 * Package this \`deno desktop\` app for Linux distribution. \`deno desktop\` produces a
 * complete bundle directory (the executable, its \`.so\`, and a freedesktop \`.desktop\`
 * launcher); this builds one or both arches and wraps each in its installers.
 *
 *   deno run -A scripts/package-linux.ts [--arch <mode>] [--no-export] [--format <list>]
 *
 * --arch  host | x86_64 | arm64 | both   (default: host)
 *           host    the machine's own architecture (x86_64 when cross-building from macOS Intel)
 *           x86_64  x86_64-unknown-linux-gnu
 *           arm64   aarch64-unknown-linux-gnu
 *           both    x86_64 AND arm64 as two bundles
 * --no-export  skip \`deno task export\` and reuse the existing out/ (faster iteration)
 * --format     installers per arch, comma-separated: tar.gz, deb, rpm, appimage. Default: the
 *              denext.config.ts \`desktop.installers.linux\` list, else tar.gz,deb.
 *                tar.gz    the bundle directory
 *                deb       Debian/Ubuntu package (built by denext; no tool needed)
 *                rpm       Fedora/RHEL/openSUSE package (needs \`rpmbuild\`)
 *                appimage  a single-file AppImage (needs \`appimagetool\`)
 *              The .deb/.rpm install to /usr/lib/<app>, link /usr/bin/<app>, and register the
 *              launcher, the icon and the deno.json \`desktop.app.deepLinks\` schemes. A default
 *              format whose tool is missing is skipped with a warning; one you asked for fails.
 * --appimage   add an AppImage to whatever --format / the config asks for
 *
 *   DENEXT_APP_NAME  output base name (default: the deno.json \`desktop.app.name\`).
 *   deno.json \`version\` is the package version; denext.config.ts \`desktop.installers\`
 *   \`publisher\` / \`description\` fill the package metadata.
 *
 * Builds on denext's pinned Deno Desktop runtime (custom app origin, per-app storage, deep links,
 * single instance), downloaded once into the Deno cache and SHA-256-verified; it needs the exact
 * Deno version it was built for (\`deno upgrade --version 2.9.7\`).
 *   DENEXT_DESKTOP_RUNTIME=stock     use the stock runtime instead (none of the above works)
 *   DENEXT_DESKTOP_RUNTIME_DIR=<dir> use a local runtime build (unverified; runtime development)
 *   DENEXT_DESKTOP_RUNTIME_VERIFY=1  re-hash the cached runtime before use
 *   DENEXT_DESKTOP_RUNTIME_ATTEST=1  also check a fresh download's build provenance (needs gh)
 *
 * The end user's Linux desktop needs a WebKitGTK runtime (webkit2gtk) for the window;
 * that is a deploy-environment dependency, not baked into the bundle. Outputs into ./dist/.
 */

import {
  buildDesktopBundle,
  buildDesktopDeb,
  buildDesktopRpm,
  desktopPackageArches,
  type DesktopPackageMeta,
  desktopRequireTool,
  desktopRun as run,
  parseDesktopPackageArgs,
  prepareDesktopPackage,
} from "denext/desktop";

const TARGETS: Record<string, string> = {
  x86_64: "x86_64-unknown-linux-gnu",
  arm64: "aarch64-unknown-linux-gnu",
};
// Underscore-free labels for output paths: \`deno desktop\` derives a reverse-DNS bundle id
// from the output basename and rejects '_' (so a raw \`x86_64\` suffix drops the .desktop file).
const LABELS: Record<string, string> = { x86_64: "x64", arm64: "arm64" };
const OS = "linux";

/** Build a Linux bundle directory for \`arch\` at dist/<name>-<label> (PNG icon). */
async function buildBundle(name: string, arch: "x86_64" | "arm64"): Promise<string> {
  return await buildDesktopBundle(import.meta.url, OS, {
    target: TARGETS[arch],
    out: \`dist/\${name}-\${LABELS[arch]}\`,
    icons: ["icons/app.png", "desktop-icon.png"],
  });
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

/** Build an AppImage for a bundle with appimagetool; returns its path. */
async function appImage(
  name: string,
  arch: "x86_64" | "arm64",
  dir: string,
): Promise<string> {
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

/** Wrap one finished bundle in each planned installer; returns their paths. */
async function installers(
  name: string,
  arch: "x86_64" | "arm64",
  dir: string,
  plan: { formats: string[]; explicit: boolean },
  meta: DesktopPackageMeta,
): Promise<string[]> {
  const out: string[] = [];
  const base = \`dist/\${name}-\${LABELS[arch]}\`;
  const pkg = { meta, bundleDir: dir, exe: \`\${name}-\${LABELS[arch]}\`, arch };
  for (const format of plan.formats) {
    if (format === "tar.gz") out.push(await tarball(name, arch, dir));
    if (format === "deb") out.push(await buildDesktopDeb({ ...pkg, out: \`\${base}.deb\` }));
    if (format === "rpm" && await desktopRequireTool("rpmbuild", ".rpm", plan.explicit)) {
      out.push(await buildDesktopRpm({ ...pkg, out: \`\${base}.rpm\` }));
    }
    if (
      format === "appimage" && await desktopRequireTool("appimagetool", "AppImage", plan.explicit)
    ) {
      out.push(await appImage(name, arch, dir));
    }
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parseDesktopPackageArgs(Deno.args, {
    arches: ["host", "x86_64", "arm64", "both"],
    legacy: { "--appimage": "appimage" },
  });
  // --format, else desktop.installers.linux in denext.config.ts, else tar.gz + deb; the
  // .deno-desktop/app.json sync, the package metadata (name, version, deep links), the export.
  const { name, plan, meta } = await prepareDesktopPackage(import.meta.url, OS, opts);

  const artifacts: string[] = [];
  for (const arch of desktopPackageArches(opts.arch)) {
    const dir = await buildBundle(name, arch);
    artifacts.push(dir, ...await installers(name, arch, dir, plan, meta));
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
 * `.exe` via `deno desktop --target`, Authenticode-signs it when a cert is set, and wraps the
 * bundle in an `.msi` (WiX) and/or a `.zip`. */
const WINDOWS_PACKAGE_SCRIPT = `#!/usr/bin/env -S deno run -A
/**
 * Package this \`deno desktop\` app for Windows distribution. \`deno desktop\` produces a
 * complete bundle directory (the \`.exe\`, its \`.dll\`s, and resources); this builds one or
 * both arches, Authenticode-signs the \`.exe\` when a code-signing certificate is provided, and
 * wraps each bundle in its installers (an \`.msi\` by default). Signing only runs where
 * \`signtool\` is available (Windows) and a cert is configured.
 *
 *   deno run -A scripts/package-windows.ts [--arch <mode>] [--no-export] [--no-sign] [--format <list>]
 *
 * --arch  host | x86_64 | arm64 | both   (default: host)
 *           host    the machine's own architecture
 *           x86_64  x86_64-pc-windows-msvc
 *           arm64   aarch64-pc-windows-msvc
 *           both    x86_64 AND arm64 as two bundles
 * --no-export  skip \`deno task export\` and reuse the existing out/ (faster iteration)
 * --no-sign    skip Authenticode signing even when a certificate is configured
 * --format     installers per arch, comma-separated: msi, zip. Default: the denext.config.ts
 *              \`desktop.installers.windows\` list, else msi.
 *                msi  a Windows Installer package (WiX 5: \`dotnet tool install --global wix
 *                     --version 5.0.2\`; builds on Windows). Installs per-user into
 *                     %LOCALAPPDATA%\\Programs\\<App> with no admin rights, or per-machine into
 *                     Program Files with \`msiexec /i <app>.msi ALLUSERS=1\`; adds a Start-menu
 *                     shortcut and the deno.json \`desktop.app.deepLinks\` schemes; a newer
 *                     version upgrades in place (the UpgradeCode follows \`desktop.app.identifier\`).
 *                     Signed like the .exe. Without WiX a default .msi falls back to the .zip.
 *                zip  the bundle directory
 *
 *   DENEXT_APP_NAME                output base name (default: the deno.json \`desktop.app.name\`).
 *   DENEXT_WINDOWS_CERT            path to a code-signing certificate (.pfx) — signing is
 *                                  skipped when unset (no secrets are ever baked in).
 *   DENEXT_WINDOWS_CERT_PASSWORD   the .pfx password, if any.
 *   DENEXT_SIGN_TIMESTAMP_URL      RFC-3161 timestamp server (default: DigiCert's).
 *   deno.json \`version\` is the MSI ProductVersion (numeric major.minor.build); denext.config.ts
 *   \`desktop.installers.publisher\` its Manufacturer.
 *
 * Builds on denext's pinned Deno Desktop runtime (custom app origin, per-app storage, deep links,
 * single instance), downloaded once into the Deno cache and SHA-256-verified; it needs the exact
 * Deno version it was built for (\`deno upgrade --version 2.9.7\`).
 *   DENEXT_DESKTOP_RUNTIME=stock     use the stock runtime instead (none of the above works)
 *   DENEXT_DESKTOP_RUNTIME_DIR=<dir> use a local runtime build (unverified; runtime development)
 *   DENEXT_DESKTOP_RUNTIME_VERIFY=1  re-hash the cached runtime before use
 *   DENEXT_DESKTOP_RUNTIME_ATTEST=1  also check a fresh download's build provenance (needs gh)
 *
 * The end user's Windows machine needs the Microsoft Edge WebView2 runtime for the window
 * (preinstalled on current Windows 10/11); that is a deploy-environment dependency, not
 * baked into the bundle. Outputs into ./dist/.
 */

import {
  buildDesktopBundle,
  buildDesktopMsi,
  desktopHasTool as has,
  desktopPackageArches,
  type DesktopPackageMeta,
  desktopRun as run,
  desktopToolGate,
  parseDesktopPackageArgs,
  prepareDesktopPackage,
} from "denext/desktop";

const TARGETS: Record<string, string> = {
  x86_64: "x86_64-pc-windows-msvc",
  arm64: "aarch64-pc-windows-msvc",
};
// Underscore-free labels for output paths: \`deno desktop\` derives a reverse-DNS bundle id
// from the output basename and rejects '_' (so a raw \`x86_64\` suffix drops resources).
const LABELS: Record<string, string> = { x86_64: "x64", arm64: "arm64" };
const hostArch = Deno.build.arch === "aarch64" ? "arm64" : "x86_64";
const DEFAULT_TIMESTAMP_URL = "http://timestamp.digicert.com";
const OS = "windows";

/** Build a Windows bundle directory for \`arch\` at dist/<name>-<label> (.ico icon). */
async function buildBundle(name: string, arch: "x86_64" | "arm64"): Promise<string> {
  return await buildDesktopBundle(import.meta.url, OS, {
    target: TARGETS[arch],
    out: \`dist/\${name}-\${LABELS[arch]}\`,
    icons: ["icons/app.ico", "desktop-icon.ico"],
  });
}

/** Authenticode-sign \`file\` (the bundle's .exe, or an .msi) when a certificate is configured;
 * else skip with a warning. */
async function sign(file: string): Promise<void> {
  const cert = Deno.env.get("DENEXT_WINDOWS_CERT");
  if (!cert) {
    console.warn(
      \`  no DENEXT_WINDOWS_CERT set — \${file} is not Authenticode-signed.\`,
    );
    return;
  }
  if (!(await has("signtool"))) {
    console.warn(
      \`  signtool not found (Windows SDK) — \${file} is not signed; sign on a Windows host/CI.\`,
    );
    return;
  }
  const timestamp = Deno.env.get("DENEXT_SIGN_TIMESTAMP_URL") ??
    DEFAULT_TIMESTAMP_URL;
  const args = [
    "sign",
    "/f",
    cert,
    "/fd",
    "sha256",
    "/tr",
    timestamp,
    "/td",
    "sha256",
  ];
  // signtool takes a .pfx password only as \`/p\` (no environment or file form), so it is
  // redacted from the failure message; keep it out of logs by setting it as a CI secret.
  const pass = Deno.env.get("DENEXT_WINDOWS_CERT_PASSWORD");
  if (pass) args.push("/p", pass);
  args.push(file);
  await run(["signtool", ...args], undefined, { secrets: pass ? [pass] : [] });
}

/** Build the .msi for a finished bundle with WiX; null when WiX can't run here and the .msi was
 * only a default (an asked-for .msi without WiX fails the run). */
async function msi(
  name: string,
  arch: "x86_64" | "arm64",
  dir: string,
  meta: DesktopPackageMeta,
  explicit: boolean,
): Promise<string | null> {
  const why = Deno.build.os !== "windows"
    ? "WiX builds an .msi on Windows only"
    : !(await has("wix"))
    ? "wix not found (WiX 5: dotnet tool install --global wix --version 5.0.2)"
    : undefined;
  if (!desktopToolGate(why, \`.msi for \${arch} (the .zip is built instead)\`, explicit)) return null;
  const out = \`dist/\${name}-\${LABELS[arch]}.msi\`;
  await buildDesktopMsi({ meta, bundleDir: dir, exe: \`\${name}-\${LABELS[arch]}.exe\`, arch, out });
  return out;
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

/** Ship the VC++ 2015-2022 runtime DLLs the deno desktop binary imports (VCRUNTIME140,
 * VCRUNTIME140_1, MSVCP140) next to the .exe, so the packaged app runs with NO redistributable
 * installed on the target (otherwise it dies at launch with a silent 0xC0000135 DLL-not-found).
 * Microsoft permits this app-local deployment. Sourced from System32 (the installed redist) when
 * packaging on Windows; a DLL that can't be found (e.g. packaging off Windows) is skipped with a
 * warning, and the target then needs the VC++ redist. System32 holds the HOST's architecture, so
 * a bundle for the other architecture gets none (its target needs the redist). */
async function bundleVcRuntime(dir: string, arch: string): Promise<void> {
  if (Deno.build.os !== "windows" || arch !== hostArch) {
    console.warn(
      "  not bundling the VC++ runtime (" + arch + " packaged on " +
        Deno.build.os + "/" +
        hostArch +
        ") — the target must install the VC++ 2015-2022 redistributable: " +
        "https://aka.ms/vs/17/release/vc_redist." +
        (arch === "arm64" ? "arm64" : "x64") + ".exe",
    );
    return;
  }
  const sys = \`\${Deno.env.get("SystemRoot") ?? "C:/Windows"}/System32\`;
  const dlls = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"];
  const missing: string[] = [];
  for (const dll of dlls) {
    try {
      await Deno.copyFile(\`\${sys}/\${dll}\`, \`\${dir}/\${dll}\`);
    } catch {
      missing.push(dll);
    }
  }
  if (missing.length === 0) {
    console.log(
      "  bundled the VC++ runtime app-local (the target needs no VC++ redistributable)",
    );
  } else {
    console.warn(
      "  could not bundle the VC++ runtime (" + missing.join(", ") +
        ") — package on Windows with the VC++ 2015-2022 redistributable installed, or the target " +
        "must install it: https://aka.ms/vs/17/release/vc_redist.x64.exe",
    );
  }
}

/** Build, sign and wrap one arch's bundle; returns what it wrote. */
async function packageArch(
  name: string,
  arch: "x86_64" | "arm64",
  signing: boolean,
  { plan, meta }: Awaited<ReturnType<typeof prepareDesktopPackage>>,
): Promise<string[]> {
  const dir = await buildBundle(name, arch);
  await bundleVcRuntime(dir, arch);
  if (signing) await sign(\`\${dir}/\${name}-\${LABELS[arch]}.exe\`);
  const out = [dir];
  const built = plan.formats.includes("msi")
    ? await msi(name, arch, dir, meta, plan.explicit)
    : null;
  if (built && signing) await sign(built);
  if (built) out.push(built);
  // A default .msi that could not be built falls back to the .zip.
  const msiSkipped = plan.formats.includes("msi") && !built;
  if (plan.formats.includes("zip") || msiSkipped) out.push(await zipBundle(name, arch, dir));
  return out;
}

async function main(): Promise<void> {
  const opts = parseDesktopPackageArgs(Deno.args, { arches: ["host", "x86_64", "arm64", "both"] });
  // --format, else desktop.installers.windows in denext.config.ts, else an .msi; the
  // .deno-desktop/app.json sync, the package metadata (name, version, deep links), the export.
  const prepared = await prepareDesktopPackage(import.meta.url, OS, opts);
  const name = prepared.name;

  const artifacts: string[] = [];
  for (const arch of desktopPackageArches(opts.arch)) {
    artifacts.push(...await packageArch(name, arch, opts.sign, prepared));
  }

  console.log("\\n  Built:");
  for (const a of artifacts) console.log("  " + a);
  console.log(
    "\\n  (the target needs the Microsoft Edge WebView2 runtime; the VC++ runtime is bundled" +
      " app-local, so no VC++ redistributable is required)",
  );
}

if (import.meta.main) await main();
`;
