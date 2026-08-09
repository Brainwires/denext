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

function denoJson(): string {
  const config = {
    tasks: {
      dev: "deno run -A jsr:@denext/denext/cli dev .",
      build: "deno run -A jsr:@denext/denext/cli build .",
      start: "deno run -A jsr:@denext/denext/cli start .",
    },
    compilerOptions: {
      jsx: "react-jsx",
      jsxImportSource: "denext",
      // `deno.unstable` provides the Deno.Kv types referenced by denext/server's
      // optional KV cache adapter (type-only; no runtime unstable APIs required).
      lib: ["deno.window", "deno.unstable", "dom", "dom.iterable", "dom.asynciterable"],
    },
    imports: {
      "denext": dep,
      "denext/jsx-runtime": `${dep}/jsx-runtime`,
      "denext/jsx-dev-runtime": `${dep}/jsx-dev-runtime`,
      "denext/server": `${dep}/server`,
      "denext/client": `${dep}/client`,
    },
    lint: { plugins: [`${dep}/lint-plugin`] },
  };
  return JSON.stringify(config, null, 2) + "\n";
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
    lines.push(`  experimental: { compiler: true }, // auto-memoization (experimental)`);
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
  // Tailwind's compiled output is generated on build; keep it out of version control.
  const gitignore = opts.tailwind ? `.denext/\n${appBase}/globals.css\n` : ".denext/\n";
  const files: ScaffoldFile[] = [
    { path: "deno.json", content: denoJson() },
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
  return files;
}

/**
 * Scaffold a new denext project into `opts.dir`. Refuses to overwrite a
 * non-empty directory.
 *
 * @param opts Target directory and feature toggles.
 * @returns The relative paths written.
 */
export async function scaffoldProject(opts: ScaffoldOptions): Promise<string[]> {
  const files = scaffoldFiles(opts);
  if (opts.allowExisting) {
    // `init` into an existing dir: never clobber a file that already exists.
    for (const f of files) {
      if (await exists(join(opts.dir, f.path))) {
        throw new Error(`denext init: ${f.path} already exists; refusing to overwrite.`);
      }
    }
  } else {
    // `create`: the target must be empty or not yet exist.
    try {
      for await (const _ of Deno.readDir(opts.dir)) {
        throw new Error(`denext create: target directory ${opts.dir} is not empty.`);
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
