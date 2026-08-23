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
    // `dev`/`build` compile, write `.denext`, and spawn tooling (Tailwind, esbuild),
    // so they use broad permissions. `start` only serves, so it runs least-privilege:
    // net + read + env (add `--allow-write=.denext` if you enable the SQLite cache).
    dev: "deno run -A jsr:@denext/denext/cli dev .",
    build: "deno run -A jsr:@denext/denext/cli build .",
    start:
      "deno run --allow-net --allow-read --allow-env jsr:@denext/denext/cli start .",
  };
  // Both native targets ship the static export (SSG) from `out/`.
  if (opts.desktop || opts.capacitor) {
    tasks.export = "deno run -A jsr:@denext/denext/cli export .";
  }
  if (opts.desktop) {
    // `deno desktop` wraps the Deno.serve() in desktop.ts in a native window.
    tasks.desktop = "deno task export && deno desktop desktop.ts";
    // The packaging script exports, then builds (embedding `out/`) + code-signs, with
    // opt-in multi-arch (--arch universal|both) and notarization (env vars). See its
    // header + the macOS distribution docs.
    tasks["desktop:package"] = "deno run -A scripts/package-macos.ts";
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
      ...(opts.desktop
        ? { "@std/http/file-server": "jsr:@std/http@^1/file-server" }
        : {}),
      ...(opts.capacitor ? { "@capacitor/cli": "npm:@capacitor/cli@^7" } : {}),
      // React + Next compatibility: alias those specifiers to denext.
      ...(opts.nextCompat
        ? {
          "react": `${dep}/react`,
          "react-dom": `${dep}/react-dom`,
          "react-dom/client": `${dep}/react-dom/client`,
          "react-dom/server": `${dep}/react-dom/server`,
          "react-dom/server.browser": `${dep}/react-dom/server.browser`,
          "react-dom/server.edge": `${dep}/react-dom/server.edge`,
          "react-dom/test-utils": `${dep}/react-dom/test-utils`,
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

// Closing the window (macOS red traffic-light / Cmd-W) should quit the whole app.
// \`deno desktop\` only auto-exits when no windows are open AND there are no live async
// tasks — but the \`Deno.serve()\` below is a permanently-live task, so without this the
// close button appears to do nothing (the process lingers). Adopt the initial window
// (the first \`new Deno.BrowserWindow()\` adopts it) and exit on its \`close\` event.
try {
  // \`Deno.BrowserWindow\` exists only under \`deno desktop\`; not in the ambient types.
  // deno-lint-ignore no-explicit-any
  const BrowserWindow = (Deno as any).BrowserWindow;
  if (typeof BrowserWindow === "function") {
    new BrowserWindow().addEventListener("close", () => Deno.exit(0));
  }
} catch { /* not under \`deno desktop\` (e.g. plain \`deno run\`) — no-op */ }

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
  const headLink = opts.tailwind
    ? ""
    : `\n  head: \`<link rel="stylesheet" href="/styles.css">\`,`;
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
  const buttonCls = tw
    ? ' class="mt-4 rounded bg-black px-4 py-2 text-white"'
    : "";
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
    files.push({
      path: "scripts/package-macos.ts",
      content: macosPackageScript(),
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

/** The scaffolded macOS packaging script (scripts/package-macos.ts). Builds one or
 * more arch .apps, code-signs, and (with a Developer ID identity + notarytool profile)
 * notarizes + staples. See the macOS distribution docs. */
function macosPackageScript(): string {
  return `#!/usr/bin/env -S deno run -A
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
const hostArch = Deno.build.arch === "aarch64" ? "arm64" : "x86_64";

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
  return \`\${app}/Contents/MacOS/\${new TextDecoder().decode(p.stdout).trim()}\`;
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
  await Deno.remove(zip).catch(() => {});
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

async function main(): Promise<void> {
  if (Deno.build.os !== "darwin") {
    console.error(
      "package-macos.ts must run on macOS (it shells out to codesign/notarytool).",
    );
    Deno.exit(1);
  }
  const opts = parseOpts(Deno.args);
  const identity = Deno.env.get("DENEXT_CODESIGN_IDENTITY") || undefined;
  const entitlements = Deno.env.get("DENEXT_ENTITLEMENTS") || undefined;
  const notaryProfile = Deno.env.get("DENEXT_NOTARY_PROFILE") || undefined;
  const name = await appName();

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

  if (opts.export) await run(["deno", "task", "export"]);
  await Deno.mkdir("dist", { recursive: true });

  const artifacts: string[] = [];
  if (opts.arch === "universal") {
    const arm = "dist/.tmp-arm64.app";
    const x86 = "dist/.tmp-x86_64.app";
    await buildApp(arm, TARGETS.arm64);
    await buildApp(x86, TARGETS.x86_64);
    const uni = \`dist/\${name}.app\`;
    await mergeUniversal(arm, x86, uni);
    await Deno.remove(arm, { recursive: true }).catch(() => {});
    await Deno.remove(x86, { recursive: true }).catch(() => {});
    artifacts.push(uni);
  } else if (opts.arch === "both") {
    for (const a of ["arm64", "x86_64"] as const) {
      const app = \`dist/\${name}-\${a}.app\`;
      await buildApp(app, TARGETS[a]);
      artifacts.push(app);
    }
  } else {
    const a = opts.arch === "host" ? hostArch : opts.arch;
    const app = \`dist/\${name}.app\`;
    await buildApp(app, opts.arch === "host" ? undefined : TARGETS[a]);
    artifacts.push(app);
  }

  for (const app of artifacts) {
    // A lipo-merged (universal) bundle always needs re-signing; for others we re-sign
    // only when a real identity is provided (deno desktop already applied ad-hoc).
    if (identity || opts.arch === "universal") {
      await sign(app, identity, entitlements);
    }
    if (notaryProfile && identity) await notarize(app, notaryProfile);
    if (opts.dmg) await makeDmg(app);
  }

  console.log("\\n✓ Packaged:");
  for (const a of artifacts) console.log("  " + a);
  if (!identity) {
    console.log(
      "  (ad-hoc — not distributable; see the macOS distribution doc)",
    );
  } else if (!notaryProfile) {
    console.log(
      "  (signed, NOT notarized — set DENEXT_NOTARY_PROFILE to notarize)",
    );
  } else console.log("  (signed + notarized + stapled — ready to distribute)");
}

if (import.meta.main) await main();
`;
}
