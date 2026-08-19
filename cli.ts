#!/usr/bin/env -S deno run -A
/**
 * The denext command-line interface: `dev`, `build`, `start`, and `version`.
 *
 * Run it directly (`deno run -A jsr:@denext/denext/cli dev .`), install it as a
 * global command (`deno install -A -g -n denext jsr:@denext/denext/cli`), or
 * compile a standalone binary (`deno compile -A --output denext cli.ts`).
 *
 * @module
 */

import { fromFileUrl, resolve } from "@std/path";
import { startDevServer } from "./src/build/dev-server.ts";
import { startProdServer } from "./src/build/prod-server.ts";
import { build } from "./src/build/build.ts";
import { staticExport } from "./src/build/export.ts";
import { resolveProject } from "./src/build/paths.ts";
import { buildAppCss } from "./src/build/css.ts";
import { tailwindPaths } from "./src/build/tailwind.ts";
import { denoExecutable } from "./src/build/bundle.ts";
import { loadEnv } from "./src/server/env.ts";
import { scaffoldProject } from "./src/build/scaffold.ts";
import { migrateProject } from "./src/build/migrate.ts";
import { runCodemod } from "./src/build/codemod.ts";
import { formatReport, probeApp } from "./src/testing/conformance.ts";
import { multiSelect } from "./src/build/multi-select.ts";
import { VERSION } from "./mod.ts";

/** Commands that load user modules and therefore need the CSS import map. */
const MODULE_COMMANDS = new Set(["dev", "build", "export", "start", "probe"]);

/** Termination signals to trap for graceful shutdown (platform-dependent). */
const SHUTDOWN_SIGNALS: Deno.Signal[] = Deno.build.os === "windows"
  ? ["SIGINT", "SIGBREAK"]
  : ["SIGINT", "SIGTERM"];

/**
 * Abort `controller` on the first termination signal (and stop trapping, so the
 * process exits once the server drains). Passing the controller's signal to the
 * server makes Deno.serve stop accepting and wait for in-flight requests.
 */
function installShutdown(controller: AbortController): void {
  const onSignal = () => {
    controller.abort();
    for (const sig of SHUTDOWN_SIGNALS) {
      try {
        Deno.removeSignalListener(sig, onSignal);
      } catch { /* not installed */ }
    }
  };
  for (const sig of SHUTDOWN_SIGNALS) {
    try {
      Deno.addSignalListener(sig, onSignal);
    } catch { /* signal unsupported on this platform */ }
  }
}

/**
 * Deno cannot `import()` a `.css` module and offers no runtime loader hook, so
 * when a project uses CSS we generate a merged deno config (redirecting each
 * `.css` to a JS shim) and re-exec the CLI with `--config` so the module loader
 * can resolve those imports. A guard env var stops infinite re-exec. Returns
 * `true` if it re-exec'd (the caller should stop).
 */
/**
 * The `--allow-*` flags to give the CSS re-exec child: mirror the parent's coarse
 * permission grants (a parent run with `-A` grants all → all pass through; a scoped
 * parent passes through only what it holds). Path-scoped grants can't be enumerated
 * by the Deno API, so they aren't reconstructed.
 */
async function childPermissionFlags(): Promise<string[]> {
  const names: Deno.PermissionName[] = ["read", "write", "net", "env", "run", "sys", "ffi"];
  const flags: string[] = [];
  for (const name of names) {
    try {
      if ((await Deno.permissions.query({ name })).state === "granted") {
        flags.push(`--allow-${name}`);
      }
    } catch { /* permission name unknown to this Deno version */ }
  }
  return flags;
}

async function maybeReexecForCss(command: string, dir: string): Promise<boolean> {
  if (!MODULE_COMMANDS.has(command)) return false;
  if (Deno.env.get("DENEXT_CSS_ACTIVE")) return false;
  const paths = await resolveProject(dir);
  const css = await buildAppCss({
    projectDir: dir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    minify: command !== "dev",
    tailwind: tailwindPaths(dir, paths.config?.tailwind),
  });
  if (!css) return false; // no CSS in the project — run normally

  const self = import.meta.url;
  if (!self.startsWith("file://")) {
    // A compiled binary cannot re-exec itself to apply the CSS import map, so
    // `.css` imports would fail at runtime. Warn loudly rather than fail silently.
    console.error(
      "denext: WARNING — this project imports CSS, but a compiled binary cannot " +
        'apply the CSS import map. `import "./x.css"` will fail at runtime; run via ' +
        "`deno run -A jsr:@denext/denext/cli` for CSS support.",
    );
    return false;
  }

  // Propagate the parent's actual permission grants instead of a blanket `-A`, so
  // an operator who scoped `start` down (e.g. `--allow-net --allow-read --allow-env`,
  // no run/write/ffi/sys) doesn't get full permissions silently restored by the
  // re-exec. Coarse grants only — Deno exposes no way to enumerate path-scoped
  // grants, so a tightly path-scoped deployment should pre-build CSS to avoid the
  // re-exec entirely (see the security docs).
  const child = new Deno.Command(denoExecutable(), {
    args: [
      "run",
      // sloppy-imports so the re-exec'd process can load Next.js app route
      // modules that use extensionless imports at runtime (permissive fallback).
      "--unstable-sloppy-imports",
      ...await childPermissionFlags(),
      "--config",
      css.configPath,
      fromFileUrl(self),
      ...Deno.args,
    ],
    env: { DENEXT_CSS_ACTIVE: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  // Forward termination signals so the child server drains before exiting.
  const forward = () => {
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
  };
  for (const sig of SHUTDOWN_SIGNALS) {
    try {
      Deno.addSignalListener(sig, forward);
    } catch { /* unsupported */ }
  }
  const { code } = await child.status;
  Deno.exit(code);
}

function parseArgs(argv: string[]): {
  command: string;
  dir: string;
  port?: number;
  hostname?: string;
} {
  const positional: string[] = [];
  let port: number | undefined;
  let hostname: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") {
      port = Number(argv[++i]);
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--host" || arg === "--hostname") {
      hostname = argv[++i];
    } else if (arg.startsWith("--host=")) {
      hostname = arg.slice("--host=".length);
    } else {
      positional.push(arg);
    }
  }
  const command = positional[0] ?? "help";
  const dir = resolve(positional[1] ?? ".");
  return { command, dir, port, hostname };
}

/**
 * Print the codemod's planned source-import rewrites, then apply them — either
 * because `force` is set (`--yes`/`--write`), or after an interactive y/N confirm.
 * In a non-interactive shell without `force`, it stays a dry run and says so.
 */
async function applyCodemod(target: string, force: boolean): Promise<void> {
  const report = await runCodemod(target); // dry run — compute the plan first
  let rewrites = 0;
  let warnings = 0;
  for (const f of report.files) {
    if (f.rewrites.length === 0 && f.warnings.length === 0) continue;
    console.log(`  ${f.path}`);
    for (const r of f.rewrites) {
      rewrites++;
      console.log(`    ${r.from} → ${r.to}${r.note ? `  (${r.note})` : ""}`);
    }
    for (const w of f.warnings) {
      warnings++;
      console.log(`    ⚠️  ${w.specifier}: ${w.message}`);
    }
  }
  console.log(
    `\n  ${rewrites} import rewrite(s), ${warnings} warning(s) across ${report.files.length} file(s) (of ${report.scanned} scanned).`,
  );
  if (rewrites === 0) {
    console.log("  No next/*+react imports to rewrite.\n");
    return;
  }
  let apply = force;
  if (!apply) {
    if (Deno.stdin.isTerminal()) {
      apply = confirm(`  Rewrite these ${rewrites} import(s) to native denext?`);
    } else {
      console.log("  Dry run — re-run with --write (or `denext migrate --yes`) to apply.\n");
      return;
    }
  }
  if (apply) {
    await runCodemod(target, { write: true });
    console.log(`  ✔ Rewrote ${rewrites} import(s).\n`);
  } else {
    console.log("  Skipped — source left as-is (the compat alias still resolves next/*+react).\n");
  }
}

async function main(): Promise<void> {
  const { command, dir, port, hostname } = parseArgs(Deno.args);
  // An explicit --port is a hard requirement; an unspecified port auto-selects
  // (starting from 3000) if the default is taken.
  const strictPort = port !== undefined;
  const effectivePort = port ?? 3000;

  // Load .env / .env.local from the project directory into the environment
  // before serving, building, or exporting, so server code sees them and the
  // public-prefixed subset can reach the client.
  if (
    command === "dev" || command === "build" || command === "export" ||
    command === "start" || command === "probe"
  ) {
    await loadEnv({ dir });
    // Re-exec with a CSS import map when the project uses CSS (Deno can't import
    // `.css` directly). No-op for CSS-free projects and inside the child process.
    if (await maybeReexecForCss(command, dir)) return;
  }

  switch (command) {
    case "dev": {
      const paths = await resolveProject(dir);
      await ensureAppDir(paths.appDir);
      const controller = new AbortController();
      installShutdown(controller);
      startDevServer({
        paths,
        port: effectivePort,
        hostname,
        strictPort,
        signal: controller.signal,
      });
      break;
    }
    case "build": {
      await ensureAppDir((await resolveProject(dir)).appDir);
      console.log(`\n  denext build  ▸  ${dir}\n`);
      await runBuildStep(() => build(dir), "build");
      break;
    }
    case "export": {
      await ensureAppDir((await resolveProject(dir)).appDir);
      console.log(`\n  denext export (static)  ▸  ${dir}\n`);
      const result = await runBuildStep(() => staticExport(dir), "export");
      console.log(
        `\n  Exported ${result.pages} page(s) to ${result.outDir}` +
          (result.skipped.length
            ? `\n  Skipped ${result.skipped.length} dynamic route(s) without generateStaticParams.`
            : ""),
      );
      break;
    }
    case "probe": {
      await ensureAppDir((await resolveProject(dir)).appDir);
      console.log(`\n  denext probe (conformance)  ▸  ${dir}\n`);
      // Render every route in process and assert each is a valid HTML document
      // with no server crash. A non-conforming route exits non-zero (CI gate).
      const report = await probeApp(dir);
      console.log(formatReport(report));
      if (!report.ok) Deno.exit(1);
      break;
    }
    case "start": {
      const controller = new AbortController();
      installShutdown(controller);
      await startProdServer({
        projectDir: dir,
        port: effectivePort,
        hostname,
        strictPort,
        signal: controller.signal,
      });
      break;
    }
    case "migrate": {
      const target = resolve(dir);
      console.log(`\n  denext migrate  ▸  ${target}\n`);
      const r = await migrateProject(target);
      console.log(`  Wrote ${r.wrote}`);
      console.log(`  - aliased to denext (${r.aliased.length}): ${r.aliased.join(", ") || "—"}`);
      console.log(
        `  - npm passthrough (${r.passthrough.length}): ${r.passthrough.join(", ") || "—"}`,
      );
      console.log(`  - dropped (${r.dropped.length}): ${r.dropped.join(", ") || "—"}`);
      if (r.flagged.length) {
        console.log(`  ⚠️  unsupported native deps: ${r.flagged.join(", ")}`);
      }
      if (r.pagesRouter) {
        console.log(
          "  ⚠️  pages/ router detected — denext is App Router only; those routes won't run.",
        );
      }
      // A migration is config + source in one pass. `--drop-in` stops after the
      // config conversion (source keeps importing next/*+react, resolved by the
      // compat alias); otherwise rewrite the source to native denext imports,
      // confirming first (or `--yes` to skip the prompt).
      const dropIn = Deno.args.includes("--drop-in");
      if (dropIn) {
        console.log("\n  Drop-in mode: source unchanged (next/*+react resolve via the alias).");
        console.log(
          "  Next: `deno install` then `denext dev`. Run `denext codemod` to go native.\n",
        );
      } else {
        const yes = Deno.args.includes("--yes") || Deno.args.includes("-y");
        console.log("\n  Rewriting source imports to native denext:\n");
        await applyCodemod(target, yes);
        console.log("  Next: `deno install` (npm deps) then `denext dev`.\n");
      }
      break;
    }
    case "codemod": {
      // The source-rewrite half of `migrate`, standalone (advanced). `--write`
      // applies without a prompt (CI); otherwise it confirms interactively.
      const target = resolve(dir);
      console.log(`\n  denext codemod  ▸  ${target}\n`);
      await applyCodemod(target, Deno.args.includes("--write"));
      break;
    }
    case "create":
      await runCreate(Deno.args.slice(1), "create");
      break;
    case "init":
      await runCreate(Deno.args.slice(1), "init");
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(`denext ${VERSION}`);
      break;
    default:
      printHelp();
  }
}

/**
 * Scaffold a project. `create <dir>` generates into a new/empty directory;
 * `init [dir]` generates into an existing directory (defaults to `.`, never
 * overwriting existing files). Both accept `--tailwind`, `--src-dir`,
 * `--compiler`, `--desktop`, `--capacitor`, `--next-compat`, and `--yes`; on a
 * TTY the options are chosen in a multi-select (flags pre-check them). Bypasses
 * the app-dir / CSS re-exec checks (no project exists yet).
 */
async function runCreate(argv: string[], mode: "create" | "init"): Promise<void> {
  const flags = new Set(argv.filter((a) => a.startsWith("-")));
  const positional = argv.find((a) => !a.startsWith("-"));
  const target = positional ?? (mode === "init" ? "." : undefined);
  if (!target) {
    console.error(
      "denext create: missing target directory.\n" +
        "  denext create my-app [--tailwind] [--src-dir] [--compiler] [--desktop] [--capacitor] [--next-compat]\n" +
        "  denext init            (scaffold into the current directory)",
    );
    Deno.exit(1);
  }
  const dir = resolve(target);
  const yes = flags.has("--yes") || flags.has("-y");

  // Feature toggles. A matching flag pre-selects the feature; on a TTY (and
  // without --yes) the remaining choice is made in a single multi-select.
  const FEATURES: Array<{ key: string; flag: string; label: string }> = [
    { key: "tailwind", flag: "--tailwind", label: "Tailwind CSS" },
    { key: "srcDir", flag: "--src-dir", label: "src/ directory layout" },
    { key: "compiler", flag: "--compiler", label: "Auto-memo compiler (experimental)" },
    { key: "desktop", flag: "--desktop", label: "Native desktop app (deno desktop)" },
    { key: "capacitor", flag: "--capacitor", label: "iOS / Android (Capacitor)" },
    { key: "nextCompat", flag: "--next-compat", label: "React + Next import aliases" },
  ];
  let selected = new Set(FEATURES.filter((f) => flags.has(f.flag)).map((f) => f.key));
  if (!yes && Deno.stdin.isTerminal()) {
    selected = multiSelect(
      "  Select features  (↑/↓ move · space toggle · enter confirm)",
      FEATURES,
      selected,
    );
  }
  const on = (k: string): boolean => selected.has(k);

  console.log(`\n  Scaffolding a denext app in ${dir}\n`);
  const written = await scaffoldProject({
    dir,
    tailwind: on("tailwind"),
    srcDir: on("srcDir"),
    compiler: on("compiler"),
    desktop: on("desktop"),
    capacitor: on("capacitor"),
    nextCompat: on("nextCompat"),
    allowExisting: mode === "init",
  });
  for (const p of written) console.log(`   + ${p}`);
  const cd = mode === "init" ? "" : `    cd ${target}\n`;
  const notes = [
    on("tailwind") ? "  Tailwind is compiled automatically by denext dev/build." : "",
    on("desktop") ? "  Desktop: `deno task desktop` (needs Deno 2.9+ `deno desktop`)." : "",
    on("capacitor")
      ? "  Mobile: `deno install`, then `deno task mobile:sync` (needs Xcode/Android Studio)."
      : "",
    on("nextCompat")
      ? '  React/Next aliases added: `import ... from "react"`/`"next/*"` resolves to denext.'
      : "",
  ].filter(Boolean);
  console.log(
    `\n  Done. Next steps:\n${cd}    deno task dev\n` +
      (notes.length ? "\n" + notes.join("\n") + "\n" : ""),
  );
}

/**
 * Run a build/export step, turning a failure into a clean, `denext:`-prefixed
 * error (printed without a stack by the top-level handler) rather than dumping a
 * raw framework stack trace for what is usually a problem in the user's code. An
 * already-formatted `denext:` error (config load/validation) passes through.
 */
async function runBuildStep<T>(step: () => Promise<T>, label: string): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("denext:")) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`denext: ${label} failed — ${detail}`, { cause: err });
  }
}

async function ensureAppDir(appDir: string): Promise<void> {
  try {
    const info = await Deno.stat(appDir);
    if (!info.isDirectory) throw new Error();
  } catch {
    console.error(
      `denext: no app directory found at ${appDir}\n` +
        `Create an app/ folder with a page.tsx to get started.`,
    );
    Deno.exit(1);
  }
}

function printHelp(): void {
  console.log(`denext ${VERSION} — a Next.js-style framework for Deno

Usage:
  denext create <dir> [--tailwind] [--src-dir] [--compiler] [--desktop] [--capacitor] [--next-compat]
                                                       Scaffold a new app
  denext init         [--tailwind] [--src-dir] [--compiler] [--desktop] [--capacitor] [--next-compat]
                                                       Scaffold into .
  denext dev   [dir] [--port 3000] [--host localhost]   Start the dev server
  denext build [dir]                                    Build for production
  denext export [dir]                                   Static export (SSG) to out/
  denext start [dir] [--port 3000]                      Serve a production build
  denext probe [dir]                                    Conformance-probe every route (CI gate)
  denext migrate [dir] [--yes] [--drop-in]              Migrate a Next.js app (deno.json + imports)
  denext codemod [dir] [--write]                        (advanced) Rewrite imports only
  denext version                                        Print the version

[dir] defaults to the current directory and must contain an app/ folder
(except 'create', which generates one). 'create' prompts for options when run
interactively; pass flags (or --yes) to skip the prompts.
Without --port, the server auto-selects an open port starting at 3000.
With --port, that exact port is required and the server errors if it is taken.`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // Print known, expected failures cleanly (no stack trace); an unexpected
    // error still throws with its stack so real bugs stay debuggable.
    if (error instanceof Deno.errors.AddrInUse) {
      console.error(error.message);
      Deno.exit(1);
    }
    // denext's own thrown errors (config load/validation, a failed build/export)
    // carry an already-formatted, user-facing message prefixed "denext:".
    if (error instanceof Error && error.message.startsWith("denext:")) {
      console.error(error.message);
      Deno.exit(1);
    }
    // A missing file / denied permission is a user/environment problem, not a bug.
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.PermissionDenied
    ) {
      console.error(`denext: ${error.message}`);
      Deno.exit(1);
    }
    throw error;
  }
}
