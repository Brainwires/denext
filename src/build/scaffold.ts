// Project scaffolding for `denext create`. Generates a clean minimal starter
// (deno.json wired to the published JSR package, an app/ with a layout + an
// interactive home page), optionally with Tailwind, a `src/` layout, and the
// experimental compiler enabled.

import { join } from "@std/path";
import { VERSION } from "../../mod.ts";

/** Options controlling what {@linkcode scaffoldProject} generates. */
export interface ScaffoldOptions {
  /** Absolute target directory (created if missing; must be empty). */
  dir: string;
  /** Wire up Tailwind (input CSS, config, `import "./globals.css"`). */
  tailwind?: boolean;
  /** Use a `src/` directory layout (`src/app` instead of `app`). */
  srcDir?: boolean;
  /** Enable the experimental auto-memo compiler in `denext.config.ts`. */
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
  nextCompat?: boolean;
  /**
   * Allow scaffolding into an existing, non-empty directory (`denext init` into
   * `.`). Existing files are never overwritten — a conflict is an error.
   */
  allowExisting?: boolean;
}

/** A generated file: repo-relative path + contents. */
export interface ScaffoldFile {
  path: string;
  content: string;
}

const dep = `jsr:@denext/denext@^${VERSION}`;

function denoJson(opts: ScaffoldOptions): string {
  const tasks: Record<string, string> = {
    dev: "deno run -A jsr:@denext/denext/cli dev .",
    build: "deno run -A jsr:@denext/denext/cli build .",
    start: "deno run -A jsr:@denext/denext/cli start .",
  };
  // Both native targets ship the static export (SSG) from `out/`.
  if (opts.desktop || opts.capacitor) {
    tasks.export = "deno run -A jsr:@denext/denext/cli export .";
  }
  if (opts.desktop) {
    // `deno desktop` wraps the Deno.serve() in desktop.ts in a native window.
    tasks.desktop = "deno task export && deno desktop desktop.ts";
    tasks["desktop:package"] = "deno task export && deno desktop --output ./dist/app desktop.ts";
  }
  if (opts.capacitor) {
    const cap = "deno run -A --node-modules-dir npm:@capacitor/cli";
    tasks["mobile:sync"] = `deno task export && ${cap} sync`;
    tasks["mobile:ios"] = `${cap} open ios`;
    tasks["mobile:android"] = `${cap} open android`;
  }

  const config: Record<string, unknown> = {
    tasks,
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
    imports: {
      "denext": dep,
      "denext/jsx-runtime": `${dep}/jsx-runtime`,
      "denext/jsx-dev-runtime": `${dep}/jsx-dev-runtime`,
      "denext/server": `${dep}/server`,
      "denext/client": `${dep}/client`,
      // Native-target deps as bare, versioned specifiers (the lint plugin forbids
      // inline `jsr:`/`npm:` in source).
      ...(opts.desktop ? { "@std/http/file-server": "jsr:@std/http@^1/file-server" } : {}),
      ...(opts.capacitor ? { "@capacitor/cli": "npm:@capacitor/cli@^7" } : {}),
      // React + Next compatibility: alias those specifiers to denext.
      ...(opts.nextCompat
        ? {
          "react": `${dep}/react`,
          "react-dom": `${dep}/react-dom`,
          "react-dom/client": `${dep}/react-dom/client`,
          "react/jsx-runtime": `${dep}/react/jsx-runtime`,
          "react/jsx-dev-runtime": `${dep}/react/jsx-dev-runtime`,
          "react-is": `${dep}/react-is`,
          "next/": `${dep}/next/`,
          "next-intl": `${dep}/next-intl`,
          "next-intl/": `${dep}/next-intl/`,
          "better-sqlite3": `${dep}/better-sqlite3`,
        }
        : {}),
    },
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
  return `// Entry for \`deno desktop\` — it wraps this Deno.serve() handler in a native
// window. Serves the static export in \`out/\`; run \`deno task export\` first, or
// use \`deno task desktop\`, which exports then launches the window.
import { serveDir } from "@std/http/file-server";

Deno.serve((req) => serveDir(req, { fsRoot: "out", quiet: true }));
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
        "@capacitor/cli": "^7.0.0",
        "@capacitor/core": "^7.0.0",
        "@capacitor/ios": "^7.0.0",
        "@capacitor/android": "^7.0.0",
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

function page(opts: ScaffoldOptions): string {
  const tw = opts.tailwind;
  const sectionCls = tw ? ' class="mx-auto max-w-xl p-8"' : "";
  const h1Cls = tw ? ' class="text-3xl font-bold"' : "";
  const buttonCls = tw ? ' class="mt-4 rounded bg-black px-4 py-2 text-white"' : "";
  // A dynamic class expression driven by the hydrated flag.
  const statusExpr = tw
    ? `{hydrated ? "text-green-600" : "text-gray-500"}`
    : `{hydrated ? "on" : "off"}`;
  return `// Home page. Uses hooks, so it renders on the server AND hydrates into an
// interactive counter — proving the SSR + hydration round-trip.

import { useEffect, useState } from "denext";
import type { PageProps } from "denext/server";

export const metadata = { title: "denext — home" };

export default function Home(_props: PageProps) {
  const [count, setCount] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  return (
    <section${sectionCls}>
      <h1${h1Cls}>Hello from denext 👋</h1>
      <p>
        Status:{" "}
        <span class=${statusExpr}>
          {hydrated ? "hydrated ✅" : "server-rendered (not yet hydrated)"}
        </span>
      </p>
      <button${buttonCls} type="button" onClick={() => setCount((c) => c + 1)}>
        Clicked {count} {count === 1 ? "time" : "times"}
      </button>
    </section>
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
      `  experimental: { compiler: true }, // auto-memoization (experimental)`,
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
  const ignore = [".denext/"];
  if (opts.tailwind) ignore.push(`${appBase}/globals.css`);
  if (opts.desktop || opts.capacitor) ignore.push("out/"); // static export
  if (opts.desktop) ignore.push("dist/"); // packaged desktop binaries
  if (opts.capacitor) ignore.push("node_modules/", "ios/", "android/"); // Capacitor
  const gitignore = ignore.join("\n") + "\n";

  const files: ScaffoldFile[] = [
    { path: "deno.json", content: denoJson(opts) },
    { path: ".gitignore", content: gitignore },
    { path: `${appBase}/layout.tsx`, content: layout(opts) },
    { path: `${appBase}/page.tsx`, content: page(opts) },
  ];
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
  }
  if (opts.capacitor) {
    files.push({ path: "capacitor.config.ts", content: capacitorConfig() });
    files.push({ path: "package.json", content: packageJson() });
  }
  return files;
}

/**
 * Scaffold a new denext project into `opts.dir`. Refuses to overwrite a
 * non-empty directory.
 *
 * @param opts Target directory and feature toggles.
 * @returns The relative paths written.
 */
export async function scaffoldProject(
  opts: ScaffoldOptions,
): Promise<string[]> {
  const files = scaffoldFiles(opts);
  if (opts.allowExisting) {
    // `init` into an existing dir: never clobber a file that already exists.
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
  for (const f of files) {
    const abs = join(opts.dir, f.path);
    await Deno.mkdir(join(abs, ".."), { recursive: true });
    await Deno.writeTextFile(abs, f.content);
  }
  return files.map((f) => f.path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
