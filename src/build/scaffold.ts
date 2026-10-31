// Project scaffolding for `denext create`. Generates a clean minimal starter
// (deno.json wired to the published JSR package, an app/ with a layout, a Server
// Component home page and a `"use client"` counter island, plus the `.vscode` files
// that turn on the Deno LSP), optionally with Tailwind, a `src/` layout, and the
// auto-memo compiler enabled.

import { basename, join, relative, SEPARATOR } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { confineWrites, mfs } from "./migrate-io.ts";
import { assertInsideProject, OutsideProjectError } from "./project-confine.ts";
import { DESKTOP_RUNTIME_CONFIG_FILE, desktopRuntimeConfigText } from "./desktop-app-config.ts";
import { CAPACITOR_BUILD_IGNORES, CAPACITOR_VERSION } from "./capacitor-pins.ts";
import { addFastlaneToProject } from "./mobile-fastlane.ts";
import { VERSION } from "../../mod.ts";
import { reactCompatImportMap } from "./react-specifiers.ts";
import { FALLOW_GITIGNORE, fallowFiles, fallowTasks } from "./fallow-template.ts";
import { markdownTable, wrapProse } from "./scaffold-markdown.ts";
import {
  LINUX_PACKAGE_SCRIPT,
  MACOS_PACKAGE_SCRIPT,
  WINDOWS_PACKAGE_SCRIPT,
} from "./desktop-package-scripts.packed.ts";
import {
  addTsgoLspSetting,
  DENO_UNSTABLE_SETTING,
  needsTsgoLspSetting,
  TSGO_LSP_FEATURE,
  tsgoLspByDefault,
} from "../ts/lsp-settings.ts";
import {
  MCP_AGENTS_SECTION,
  MCP_README_ROWS,
  mcpTaskCommand,
  writeMcpClientConfigs,
} from "./mcp-template.ts";
import {
  LUSTRE_CONFIG_IMPORT,
  LUSTRE_CONFIG_LINES,
  LUSTRE_GITIGNORE,
  LUSTRE_IMPORTS,
  lustreTemplateFiles,
} from "./scaffold-lustre.ts";

/** Options controlling what {@linkcode scaffoldProject} generates. */
/** Named starter templates `denext create --template <name>` can choose. */
export const SCAFFOLD_TEMPLATES = ["default", "minimal", "lustre"] as const;
export type ScaffoldTemplate = (typeof SCAFFOLD_TEMPLATES)[number];

export interface ScaffoldOptions {
  /** Absolute target directory (created if missing; must be empty). */
  dir: string;
  /**
   * Starter template: `"default"` (a Server Component page rendering a `"use client"`
   * counter island — the SSR + hydration round-trip), `"minimal"` (a bare page) or `"lustre"`
   * (a Gleam project with one Lustre counter used as an island, a custom element and a server
   * component, compiled by the `gleam()` plugin). Defaults to `"default"`.
   */
  template?: ScaffoldTemplate;
  /**
   * Write `.vscode/settings.json` (`"deno.enable": true`, plus `"deno.unstable": ["tsgo-lsp"]`
   * for the TypeScript 7 language server unless `DENEXT_TSGO_LSP=0`) and
   * `.vscode/extensions.json` (recommending the Deno extension) so the editor resolves the
   * `denext` import map the way `deno` does. Defaults to `true`; `denext create --no-vscode` turns it off. Merged
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
   * Add fastlane lanes over `denext mobile build` (what `denext mobile add fastlane` writes:
   * `fastlane/Appfile`, `Fastfile`, `Matchfile`, `.gitignore` and a `Gemfile`), run with
   * `denext fastlane`. Implies {@linkcode capacitor}.
   */
  fastlane?: boolean;
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
  /**
   * The scope (`@acme`) of the shared packages when this app is a member of a monorepo
   * (`denext create --monorepo`, see ./scaffold-monorepo.ts): the layout imports
   * `<scope>/ui/styles.css`, the page renders `<scope>/ui`'s `Card` and the counter its `Button`
   * (and `<scope>/shared`'s `pluralize`), and `deno.json` leaves the fields only a workspace root
   * may set (`allowScripts`, `unstable`) and the shared `lint` to the root's.
   */
  monorepoScope?: string;
}

/** The scaffolded project's README: what the tasks do, where routes live, where to read more. */
function readme(opts: ScaffoldOptions, appBase: string): string {
  const name = basename(opts.dir) || "my-app";
  const rows: (readonly string[])[] = [
    ["`denext task dev`", "Dev server with per-module HMR at http://localhost:3000"],
    ["`denext task build`", "Production build into `.denext/`"],
    ["`denext task start`", "Serve the production build (least-privilege permissions)"],
    ["`denext task test`", "Run the tests on denext's Deno toolchain (Vitest/Jest compat)"],
  ];
  if (opts.desktop || opts.capacitor) {
    rows.push(["`denext task export`", "Static export into `out/` (the native shells ship this)"]);
  }
  if (opts.fallow) rows.push(...FALLOW_README_ROWS);
  if (opts.mcp) rows.push(...MCP_README_ROWS);
  const item = (text: string) => wrapProse(text, "- ", "  ");
  const where = [
    item(
      `\`${appBase}/page.tsx\`, \`${appBase}/layout.tsx\` — routes are files, exactly like the ` +
        "Next.js App Router (`app/blog/[slug]/page.tsx`, `app/api/x/route.ts`, `loading.tsx`, " +
        "`error.tsx`, `middleware.ts`). They are Server Components: they can be `async`, read " +
        "the database directly, and ship no JavaScript.",
    ),
    templateReadmeItem(opts, appBase),
    item(
      "`denext.config.ts` — redirects, rewrites, headers, images, i18n, CSP, `cacheComponents`.",
    ),
    item(
      "Imports come from `denext` (hooks, `Link`, `Image`, `redirect`), `denext/server` " +
        "(`cookies`, `headers`, `getSession`, caching) and `denext/client`.",
    ),
    opts.vscode === false ? "" : item(
      "`.vscode/` — turns on the Deno language server on its TypeScript 7 backend (and " +
        "recommends the Deno extension), so the editor resolves `denext` exactly as " +
        '`deno check` does. `"deno.unstable": []` there keeps TypeScript 6.',
    ),
  ].join("");
  return `# ${name}

${
    wrapProse(
      "A [denext](https://denext.dev) app — write it once, ship it to the web, iOS, Android and " +
        "the desktop.",
    )
  }
## Tasks

${markdownTable(["Command", "What it does"], rows)}
${
    wrapProse(
      "`denext task` runs a task on denext's own Deno toolchain, so the " +
        "[`denext` command](https://denext.dev/docs/getting-started) is all you need. With Deno " +
        "installed, `deno task <name>` runs the same task. The first `dev`/`build` downloads the " +
        "framework from JSR (a few seconds); later runs are cached.",
    )
  }
## Where things live

${where}
## Learn more

${item("Guide + API: https://denext.dev/docs")}${
    item("Ask an agent: `denext mcp` exposes the docs and route tools over MCP.")
  }${
    item(
      "`denext doctor` checks the toolchain; `denext generate page|component|route|test` scaffolds.",
    )
  }`;
}

/** The README's entry for the template's own files: the island, the Lustre project, or none. */
function templateReadmeItem(opts: ScaffoldOptions, appBase: string): string {
  if (opts.template === "lustre") return lustreReadmeItem(appBase);
  if (opts.template === "minimal") return "";
  return wrapProse(
    `\`${appBase}/counter.tsx\` — a \`"use client"\` island: the one file that ships to the ` +
      "browser. Hooks and event handlers live in files like this one; the page passes it " +
      "serialisable props (and Server Actions).",
    "- ",
    "  ",
  );
}

/** The README's entry for the `lustre` template's Gleam project and counters. */
function lustreReadmeItem(appBase: string): string {
  return wrapProse(
    "`gleam/src/counter.gleam` — a Lustre counter in Gleam, rendered three ways by " +
      `\`${appBase}/page.tsx\`: an island (\`counter-island.tsx\`), a custom element ` +
      "(`counter-element.tsx`) and a server component over Live (`counter-view.ts`). The " +
      "`gleam()` plugin compiles it with denext's pinned Gleam (downloaded on first use) and " +
      "Lustre comes from Hex, so the first `dev` / `build` needs the network. See " +
      "https://denext.dev/docs/gleam.",
    "- ",
    "  ",
  );
}

/** The README task rows `--fallow` adds. */
const FALLOW_README_ROWS: readonly (readonly [string, string])[] = [
  ["`denext task fallow:audit`", "fallow's changed-code gate (dead code, duplication, complexity)"],
  [
    "`denext task hooks:install`",
    "Run that gate before every `git commit` (`.githooks/pre-commit`)",
  ],
];

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
/** The `denext` import a scaffold pins (`jsr:@denext/denext@^<this version>`). */
export const SCAFFOLD_DENEXT_DEP: string = dep;
/** The version-pinned CLI specifier generated `deno task`s run. */
export const SCAFFOLD_DENEXT_CLI: string = cli;
/** The Capacitor release `--capacitor` scaffolds (CLI, core and both native platforms). */
const CAPACITOR = CAPACITOR_VERSION;
/**
 * What `--capacitor` gitignores: `node_modules/` (Capacitor's CLI and platforms are npm
 * packages) and the native build outputs a migrated app ignores too.
 */
const CAPACITOR_IGNORES = ["node_modules/", ...CAPACITOR_BUILD_IGNORES];

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
    // Through the CLI rather than a bare `deno test`: `deno task` runs a task's `deno` on the
    // Deno that started it (stock), while `denext test` runs on denext's Deno toolchain.
    test: `deno run -A ${cli} test`,
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
    // The exe cross-builds from any OS; signing needs signtool (a configured cert without it
    // fails the run; --no-sign builds unsigned).
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
    "denext/auth": `${dep}/auth`,
    "denext/client": `${dep}/client`,
    "denext/testing": `${dep}/testing`,
    // Deploy adapters: `deploy: { adapter: fly({ app }) }` in denext.config.ts.
    "denext/deploy": `${dep}/deploy`,
    // `denext generate test` writes tests against @std/assert.
    "@std/assert": "jsr:@std/assert@^1",
    // The `lustre` template: the Lustre helpers and the Gleam build's import prefix.
    ...(opts.template === "lustre" ? { "denext/gleam": `${dep}/gleam`, ...LUSTRE_IMPORTS } : {}),
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
 * The unstable features a generated `deno.json` turns on. `no-legacy-abort`: Deno.serve's
 * `request.signal` aborts only when a response is NOT delivered, and Deno prints no legacy-abort
 * notice on the first request — what `denext start` / `dev` get from the toolchain's
 * `--unstable-no-legacy-abort`, here for every `deno` that reads the config (a least-privilege
 * `start` task included, which cannot re-run itself with the flag). Stock Deno 2.9 accepts the key
 * without a warning. denext's runtime from 3.0.0-rc.5 has that behavior by default and accepts
 * the key as a no-op; it stays for a project run on stock Deno 2.9.x or an older toolchain.
 */
export const DENEXT_UNSTABLE: readonly string[] = ["no-legacy-abort"];

/**
 * The `deno.json` fields only a project's (or a workspace's) root config may set: the one npm
 * lifecycle script in the framework's dependency graph denied — `@parcel/watcher`'s (through
 * `sass`), which falls back to a native build its prebuilt optional dependency makes unneeded, so
 * Deno stops printing its "Ignored build scripts" box on every command and every Docker build —
 * and denext's unstable features.
 */
export const DENO_ROOT_FIELDS: Readonly<Record<string, unknown>> = {
  allowScripts: { deny: ["npm:@parcel/watcher"] },
  unstable: [...DENEXT_UNSTABLE],
};

/**
 * A scaffold's `compilerOptions`: denext's JSX, and the libs its modules type-check against.
 * `deno.unstable` provides the Deno.Kv types referenced by denext/server's optional KV cache
 * adapter (type-only; no runtime unstable APIs required).
 */
export const SCAFFOLD_COMPILER_OPTIONS: Readonly<Record<string, unknown>> = {
  jsx: "react-jsx",
  jsxImportSource: "denext",
  lib: ["deno.window", "deno.unstable", "dom", "dom.iterable", "dom.asynciterable"],
};

/**
 * A scaffold's top-level `exclude`: what no subcommand (`test`, `lint`, `fmt`, `check`) should
 * walk. `.deno/` is where Deno runtime 3.0.0-rc.5's type-check leaves an `npm-compat` copy of
 * `@jsr/*` packages, their `_test.ts` files included, which `deno test`'s default discovery would
 * otherwise run.
 */
export const SCAFFOLD_EXCLUDE: readonly string[] = [".deno/"];

/** A scaffold's `lint`: denext's lint plugin, at the scaffold's version. */
export const SCAFFOLD_LINT: Readonly<Record<string, unknown>> = {
  plugins: [`${dep}/lint-plugin`],
};

/**
 * A `deno.json` `unstable` list: the entries already there (when `existing` is an array of
 * strings), then `extra`, then {@linkcode DENEXT_UNSTABLE}, each once, in that order — so a
 * regenerated config keeps the features its author added.
 *
 * @param existing The config's current `unstable` value (anything; non-strings are dropped).
 * @param extra Features the writer needs besides denext's own (`sloppy-imports`).
 * @returns The merged list.
 */
export function withDenextUnstable(existing: unknown, extra: readonly string[] = []): string[] {
  const current = Array.isArray(existing)
    ? existing.filter((v): v is string => typeof v === "string")
    : [];
  return [...new Set([...current, ...extra, ...DENEXT_UNSTABLE])];
}

export function denoJson(opts: ScaffoldOptions): string {
  const member = opts.monorepoScope !== undefined;
  const config: Record<string, unknown> = {
    tasks: scaffoldTasks(opts),
    // A workspace member may not set these (Deno warns): the monorepo root carries them.
    ...(member ? {} : DENO_ROOT_FIELDS),
    compilerOptions: SCAFFOLD_COMPILER_OPTIONS,
    imports: scaffoldImports(opts),
    // A monorepo lints every member with the root's plugin.
    ...(member ? {} : { lint: SCAFFOLD_LINT }),
    exclude: [...SCAFFOLD_EXCLUDE],
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
// absent; a backend reverse proxy is \`spa.proxy\`. Both arrive through
// \`.deno-desktop/config.json\`, the runtime part of \`denext.config.ts\` that every export, build
// and \`denext desktop\` command rewrites: the config module itself (and any plugin it imports)
// is never compiled into the app.
import config from "./.deno-desktop/config.json" with { type: "json" };
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

- **macOS** \`app.icns\` · **Windows** \`app.ico\` · **Linux** \`app.png\` (512×512+)
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
  // A monorepo member also takes the shared UI package's stylesheet (an export of that package).
  const uiCss = opts.monorepoScope ? `import "${opts.monorepoScope}/ui/styles.css";\n` : "";
  const cssImport = uiCss + (opts.tailwind ? `import "./globals.css";\n` : "");
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
  if (opts.monorepoScope) return minimalMemberPage(opts.monorepoScope, sectionCls, h1Cls);
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

/** The `minimal` template's home page in a monorepo: the shared `Card` around the greeting. */
function minimalMemberPage(scope: string, sectionCls: string, h1Cls: string): string {
  return `// Home page (minimal template). \`Card\` comes from the workspace's shared UI package.

import type { PageProps } from "denext/server";
import { Card } from "${scope}/ui";

export const metadata = { title: "denext — home" };

export default function Home(_props: PageProps) {
  return (
    <section${sectionCls}>
      <h1${h1Cls}>Hello from denext 👋</h1>
      <Card title="packages/ui">Edit app/page.tsx to get started.</Card>
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
${
    opts.monorepoScope
      ? `import { Card } from "${opts.monorepoScope}/ui";\n`
      : ""
  }import { Counter } from "./counter.tsx";

export const metadata = { title: "denext — home" };

export default function Home(_props: PageProps) {
  return (
    <section${sectionCls}>
      <h1${h1Cls}>Hello from denext 👋</h1>
${
    opts.monorepoScope ? memberPageBody() : `      <p>
        This page is a Server Component; the button below is a client island.
      </p>
      <Counter />`
  }
    </section>
  );
}
`;
}

/**
 * The default page's body in a monorepo: the shared package's `Card` (rendered on the server)
 * around the island (whose button is the same package's, hydrated in the browser).
 */
function memberPageBody(): string {
  return `      <Card title="Shared components">
        <p>
          This page is a Server Component rendering the shared Card; the button
          below is the shared Button inside a client island.
        </p>
        <Counter />
      </Card>`;
}

/**
 * The `default` template's `"use client"` island: hooks and an event handler, so it
 * renders on the server AND hydrates — the counter proves the round-trip.
 */
function counter(opts: ScaffoldOptions): string {
  const tw = opts.tailwind;
  const scope = opts.monorepoScope;
  // Written the way `deno fmt` lays it out: the Tailwind classes push the tag past 80 columns.
  const buttonOpen = tw
    ? `<button
        class="mt-4 rounded bg-black px-4 py-2 text-white"
        type="button"
        onClick={() => setCount((c) => c + 1)}
      >`
    : `<button type="button" onClick={() => setCount((c) => c + 1)}>`;
  // A monorepo member's island uses the shared packages: `Button` and `pluralize`.
  const button = scope
    ? `<Button onClick={() => setCount((c) => c + 1)}>
        Clicked {count} {pluralize(count, "time")}
      </Button>`
    : `${buttonOpen}
        Clicked {count} {count === 1 ? "time" : "times"}
      </button>`;
  const shared = scope
    ? `import { Button } from "${scope}/ui";\nimport { pluralize } from "${scope}/shared";\n`
    : "";
  // A dynamic class expression driven by the hydrated flag.
  const statusExpr = tw
    ? `{hydrated ? "text-green-600" : "text-gray-500"}`
    : `{hydrated ? "on" : "off"}`;
  return `"use client";

// A client island. \`"use client"\` marks the boundary: this file (and what it
// imports) is bundled for the browser, hooks and event handlers work, and the
// Server Component that renders it passes plain serialisable props.

import { useEffect, useState } from "denext";
${shared}
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
      ${button}
    </div>
  );
}
`;
}

const GLOBAL_CSS_PLAIN = `:root {
  font-family: system-ui, sans-serif;
}
.app {
  min-height: 100vh;
}
.topbar {
  padding: 1rem;
  border-bottom: 1px solid #eee;
}
.brand {
  font-weight: 700;
  text-decoration: none;
  color: inherit;
}
.content {
  padding: 1rem;
}
.on {
  color: #16a34a;
}
.off {
  color: #6b7280;
}
`;

const TAILWIND_INPUT = `@import "tailwindcss";\n`;

/**
 * A monorepo member's Tailwind input: Tailwind scans the app's own folder, so the shared packages
 * (`../../packages` from `apps/<name>`, relative to this stylesheet) are named as a source too.
 */
const TAILWIND_MEMBER_INPUT = `@import "tailwindcss";\n@source "../../../packages";\n`;

/** The `desktop` section a desktop scaffold writes into `denext.config.ts`. */
const SCAFFOLD_DESKTOP_CONFIG = { app: { identifier: "com.example.denext" } } as const;

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
      `    app: { identifier: "${SCAFFOLD_DESKTOP_CONFIG.app.identifier}" },`,
      `    // capabilities: { fs: true, secureStore: true, shell: true },  // denext desktop add <cap>`,
      `  },`,
    );
  }
  if (opts.template === "lustre") lines.push(...LUSTRE_CONFIG_LINES);
  const lustreImport = opts.template === "lustre" ? `${LUSTRE_CONFIG_IMPORT}\n` : "";
  return `import type { DenextConfig } from "denext/server";
${lustreImport}
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
  const files: ScaffoldFile[] = [
    { path: "deno.json", content: denoJson(opts) },
    { path: ".gitignore", content: scaffoldGitignore(opts, appBase) },
    { path: "README.md", content: readme(opts, appBase) },
    { path: `${appBase}/layout.tsx`, content: layout(opts) },
  ];
  files.push(...templateFiles(opts, appBase), styleFile(opts));
  // `desktop.capabilities` and the rest of the desktop settings live in `./denext.config.ts`, so
  // a desktop scaffold always needs the config file even without tailwind/compiler.
  if (opts.tailwind || opts.compiler || opts.desktop || opts.template === "lustre") {
    files.push({ path: "denext.config.ts", content: denextConfig(opts) });
  }
  if (opts.desktop) files.push(...desktopScaffoldFiles());
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

/** The template's own files: the page (and the default template's island), or the Lustre set. */
function templateFiles(opts: ScaffoldOptions, appBase: string): ScaffoldFile[] {
  if (opts.template === "lustre") return lustreTemplateFiles(appBase, opts.tailwind === true);
  if (opts.template === "minimal") {
    return [{ path: `${appBase}/page.tsx`, content: minimalPage(opts) }];
  }
  return [
    { path: `${appBase}/page.tsx`, content: page(opts) },
    { path: `${appBase}/counter.tsx`, content: counter(opts) },
  ];
}

/** The stylesheet: Tailwind's input (naming a monorepo's packages as a source), or plain CSS. */
function styleFile(opts: ScaffoldOptions): ScaffoldFile {
  if (!opts.tailwind) return { path: "public/styles.css", content: GLOBAL_CSS_PLAIN };
  const content = opts.monorepoScope ? TAILWIND_MEMBER_INPUT : TAILWIND_INPUT;
  return { path: "styles/tailwind.css", content };
}

/** The scaffold's `.gitignore`: generated / build outputs to keep out of version control. */
function scaffoldGitignore(opts: ScaffoldOptions, appBase: string): string {
  // `.denext/` (build output), `out/` (`denext export`), `.deno/` (the native TypeScript 7
  // check's and the tsgo language server's project cache), `/tsconfig.json` (the root config the
  // tsgo language server's `deno sync-types` generates to extend `.deno/tsconfig.json`; a denext
  // app keeps its compiler options in deno.json), env files with secrets.
  const ignore = [
    ".denext/",
    "out/",
    ".deno/",
    "/tsconfig.json",
    ".env*.local",
    "*.local",
    "patches/.work/",
  ];
  if (opts.tailwind) ignore.push(`${appBase}/globals.css`);
  if (opts.desktop) ignore.push("dist/"); // packaged desktop binaries
  if (opts.capacitor) ignore.push(...CAPACITOR_IGNORES);
  if (opts.fallow) ignore.push(...FALLOW_GITIGNORE);
  if (opts.template === "lustre") ignore.push(...LUSTRE_GITIGNORE);
  return ignore.join("\n") + "\n";
}

/** A desktop scaffold's entry, its first runtime config, the icons note and packaging scripts. */
function desktopScaffoldFiles(): ScaffoldFile[] {
  return [
    { path: "desktop.ts", content: desktopEntry() },
    // The entry's first config slice (the sync step rewrites it from denext.config.ts), so the
    // entry type-checks before the first export.
    {
      path: DESKTOP_RUNTIME_CONFIG_FILE,
      content: desktopRuntimeConfigText({ desktop: SCAFFOLD_DESKTOP_CONFIG }),
    },
    { path: "icons/README.md", content: desktopIcons() },
    { path: "scripts/package-macos.ts", content: MACOS_PACKAGE_SCRIPT },
    { path: "scripts/package-linux.ts", content: LINUX_PACKAGE_SCRIPT },
    { path: "scripts/package-windows.ts", content: WINDOWS_PACKAGE_SCRIPT },
  ];
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
  options: ScaffoldOptions,
): Promise<string[]> {
  const opts = options.fastlane ? { ...options, capacitor: true } : options;
  const files = scaffoldFiles(opts);
  await refuseToClobber(files, opts);
  // `init` writes into an existing (maybe cloned) directory: its symlinks never lead a write out.
  return await confineWrites(opts.dir, async () => {
    const written = await writeScaffoldFiles(opts.dir, files);
    if (opts.fastlane) {
      // The same files `denext mobile add fastlane` writes, from the capacitor.config just written.
      written.push(...(await addFastlaneToProject({ dir: opts.dir })).written);
    }
    written.push(...await writeProjectConfigs(opts));
    return written;
  });
}

/**
 * Write `files` under `dir` (creating their folders).
 *
 * @param dir The project directory.
 * @param files The files, with `dir`-relative paths.
 * @returns Their paths, as given.
 */
export async function writeScaffoldFiles(dir: string, files: ScaffoldFile[]): Promise<string[]> {
  for (const f of files) {
    const abs = join(dir, f.path);
    await assertInsideProject(dir, abs);
    await Deno.mkdir(join(abs, ".."), { recursive: true });
    await Deno.writeTextFile(abs, f.content, f.mode ? { mode: f.mode } : undefined);
  }
  return files.map((f) => f.path);
}

/**
 * The editor and agent configs merged into a project (or a monorepo's root): the `.vscode` files
 * unless `opts.vscode` is `false`, and the MCP client configs with `opts.mcp`. Merged rather than
 * written, since `init` may meet files that already list settings or servers.
 *
 * @param opts The scaffold options (`dir`, `vscode`, `mcp`).
 * @returns The paths written, relative to `opts.dir` and `/`-separated.
 */
export async function writeProjectConfigs(opts: ScaffoldOptions): Promise<string[]> {
  const written: string[] = [];
  if (opts.vscode !== false) {
    const vscode: string[] = [];
    await ensureVscodeDeno(opts.dir, vscode);
    // `/`-separated like every other scaffolded path, on Windows too.
    written.push(...vscode.map((p) => relative(opts.dir, p).split(SEPARATOR).join("/")));
  }
  if (opts.mcp) {
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
 * Writes `.vscode/settings.json` (`"deno.enable": true`, and `"deno.unstable": ["tsgo-lsp"]` —
 * the TypeScript 7 language server, see src/ts/lsp-settings.ts — when the settings name no
 * `deno.unstable` and `DENEXT_TSGO_LSP` is not `0`) and `.vscode/extensions.json`
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
 * @param options `tsgoLsp`: whether to write the TypeScript 7 language-server setting (default:
 *   unless `DENEXT_TSGO_LSP=0`).
 */
export async function ensureVscodeDeno(
  dir: string,
  written: string[],
  options: { tsgoLsp?: boolean } = {},
): Promise<void> {
  const vscodeDir = join(dir, ".vscode");
  const tsgoLsp = options.tsgoLsp ?? tsgoLspByDefault();

  // settings.json → turn on the Deno LSP for this workspace folder, on its TypeScript 7 (tsgo)
  // backend unless the settings already choose (`deno.unstable`) or DENEXT_TSGO_LSP=0.
  const settingsPath = join(vscodeDir, "settings.json");
  const text = await mfs.readTextFile(settingsPath).catch(() => null);
  const settings = (text === null ? null : parseVscodeJson(text)) ?? {};
  if (settings["deno.enable"] !== true) {
    settings["deno.enable"] = true;
    if (tsgoLsp && needsTsgoLspSetting(settings)) {
      settings[DENO_UNSTABLE_SETTING] = [TSGO_LSP_FEATURE];
    }
    await writeVscodeJson(vscodeDir, settingsPath, settings, written);
  } else if (tsgoLsp && text !== null) {
    // Already on the Deno LSP: add only the backend entry, leaving the rest of the file's bytes.
    const next = addTsgoLspSetting(text);
    if (next !== null) await writeVscodeText(vscodeDir, settingsPath, next, written);
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
  const text = await mfs.readTextFile(path).catch(() => null);
  return text === null ? null : parseVscodeJson(text);
}

/** A `.vscode/*.json` file's object (JSONC), or null when it is not one. */
function parseVscodeJson(text: string): Record<string, unknown> | null {
  try {
    const value = parseJsonc(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Write a `.vscode/*.json` file (mkdir + symlink-safe overwrite), pushing it to `written`. */
function writeVscodeJson(
  vscodeDir: string,
  path: string,
  obj: Record<string, unknown>,
  written: string[],
): Promise<void> {
  return writeVscodeText(vscodeDir, path, JSON.stringify(obj, null, 2) + "\n", written);
}

/** Write a `.vscode/*` file's text (mkdir + symlink-safe overwrite), pushing it to `written`. */
async function writeVscodeText(
  vscodeDir: string,
  path: string,
  text: string,
  written: string[],
): Promise<void> {
  try {
    await mfs.mkdir(vscodeDir, { recursive: true });
    // Same symlink guard as migrate's `ensureGitignore`: unlink first so a symlinked target
    // (possible in a cloned third-party repo) isn't followed out of tree.
    await mfs.remove(path).catch(() => {});
    await mfs.writeTextFile(path, text);
  } catch (error) {
    // A `.vscode` linked out of the project (shared editor settings, or a planted link) is left
    // alone: the editor setup is a convenience, not worth refusing the whole run over.
    if (error instanceof OutsideProjectError) return;
    throw error;
  }
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
