// The `deno-deploy` deploy preset: an entrypoint for Deno Deploy at the project root
// (`denext.deploy.ts`) that registers the build's schedules with `Deno.cron` at its top level
// (where Deno Deploy records an app's crons), puts the page and data cache on Deno KV when the
// config names no store (the platform has no persistent disk), and starts the production server.
// `.denext/deploy/deno-deploy/app.json` holds the app settings Deno Deploy builds with (install,
// build, entrypoint), and `denext deploy` runs `deno deploy` with `DENO_DEPLOY_TOKEN` from the
// environment.

import { parse as parseJsonc } from "@std/jsonc";
import { join } from "@std/path";
import type { DeployAdapter, DeployContext } from "../adapter.ts";
import type { DeployManifest } from "../manifest.ts";
import { header, marker, requiredSecrets } from "./shared.ts";

/** Options for {@linkcode denoDeploy}. */
export interface DenoDeployPresetOptions {
  /** The Deno Deploy organization (`--org`). */
  org?: string;
  /** The Deno Deploy app (`--app`). */
  app?: string;
  /** Deploy straight to production (default `true`); `false` makes a preview deployment. */
  prod?: boolean;
  /**
   * Put the page and data cache on Deno KV (`denoKvCacheStore()`). Default: when the config
   * names no `cache.store`. The app needs a KV database attached on Deno Deploy.
   */
  kv?: boolean;
  /** The entrypoint's file name at the project root (default `denext.deploy.ts`). */
  entrypoint?: string;
}

/** The entrypoint's default file name. */
const ENTRYPOINT = "denext.deploy.ts";

/** How a module of denext's is imported from the project: its own import map, else JSR. */
function denextSpecifier(imports: Record<string, unknown>, sub: string, version: string): string {
  const own = imports[`denext/${sub}`];
  if (typeof own === "string") return own;
  const root = imports["denext"];
  if (typeof root === "string" && /^(jsr|npm|https?):/.test(root)) return `${root}/${sub}`;
  return `jsr:@denext/denext@^${version}/${sub}`;
}

/** The project's `deno.json(c)` import map (empty when unreadable). */
async function projectImports(projectDir: string): Promise<Record<string, unknown>> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      const json = parseJsonc(await Deno.readTextFile(join(projectDir, name))) as {
        imports?: Record<string, unknown>;
      };
      return json?.imports ?? {};
    } catch { /* next */ }
  }
  return {};
}

/** Whether the entry installs the Deno KV cache store. */
function usesKv(manifest: DeployManifest, options: DenoDeployPresetOptions): boolean {
  return options.kv ?? manifest.cache.store === "default";
}

/**
 * The entrypoint module.
 *
 * @param manifest The deploy manifest.
 * @param options The preset options.
 * @param specifier How a denext module is imported (`"server"` → its specifier).
 * @returns The module's source.
 */
function renderDenoDeployEntry(
  manifest: DeployManifest,
  options: DenoDeployPresetOptions,
  specifier: (sub: string) => string,
): string {
  const kv = usesKv(manifest, options);
  const serverNames = [
    ...(kv ? ["denoKvCacheStore"] : []),
    "registerCronSchedules",
    ...(kv ? ["setCacheStore"] : []),
  ];
  const schedules = manifest.schedules.map((s) =>
    `  { cron: ${JSON.stringify(s.cron)}, job: ${JSON.stringify(s.job)} },`
  );
  return `${header("deno-deploy", "//")}
//
// Deno Deploy's entrypoint for this app: it registers the schedules with Deno.cron at the top
// level (where Deno Deploy records an app's crons; the server's own scheduler then skips them),
${
    kv
      ? "// puts the page and data cache on Deno KV (no persistent disk; attach a KV database), "
      : "// keeps the cache store denext.config names, "
  }and
// starts the production server on the build \`deno task build\` made.
import { ${serverNames.join(", ")} } from "${specifier("server")}";
import { runStandalone } from "${specifier("standalone")}";

registerCronSchedules([${schedules.length ? `\n${schedules.join("\n")}\n` : ""}]);
${kv ? "setCacheStore(denoKvCacheStore());\n" : ""}
await runStandalone(new URL("./", import.meta.url), ["start"]);
`;
}

/**
 * The app settings Deno Deploy builds with (the one-time `deno deploy create` flags).
 *
 * @param options The preset options.
 * @returns The JSON document.
 */
function renderDenoDeployApp(options: DenoDeployPresetOptions): string {
  const entrypoint = options.entrypoint ?? ENTRYPOINT;
  const settings = {
    runtimeMode: "dynamic",
    installCommand: "deno install",
    buildCommand: "deno task build",
    entrypoint,
    create: [
      "deno",
      "deploy",
      "create",
      "--source",
      "local",
      ...(options.org ? ["--org", options.org] : []),
      ...(options.app ? ["--app", options.app] : []),
      "--runtime-mode",
      "dynamic",
      "--entrypoint",
      entrypoint,
      "--install-command",
      "deno install",
      "--build-command",
      "deno task build",
    ],
  };
  return JSON.stringify(settings, null, 2) + "\n";
}

/** Warn about what Deno Deploy cannot do for this app. */
function denoDeployWarnings(ctx: DeployContext): void {
  const { manifest } = ctx;
  if (manifest.services.length) {
    ctx.warn(
      "deno-deploy: services/ run inside each isolate, which the platform starts and stops on " +
        "demand — long-lived work belongs on a server target",
    );
  }
  if (manifest.env.some((v) => v.name === "DATABASE_URL")) {
    ctx.warn(
      "deno-deploy: the platform runs stock Deno (no Deno.SQL) — give Postgres a postgres.js " +
        "client (https://denext.dev/docs/database#postgres)",
    );
  }
  if (manifest.compile) ctx.warn("deno-deploy: the build --compile executable is not used here");
  const secrets = requiredSecrets(manifest);
  if (secrets.length) {
    ctx.log(`set these in the app's environment (deno deploy env add): ${secrets.join(", ")}`);
  }
}

/** `deno deploy` with the token from the environment. */
async function denoDeployPush(ctx: DeployContext, options: DenoDeployPresetOptions): Promise<void> {
  if (!ctx.env("DENO_DEPLOY_TOKEN")) {
    throw new Error(
      "denext: deploy (deno-deploy) reads its credentials from DENO_DEPLOY_TOKEN — create an " +
        "organization token in the Deno Deploy dashboard and set it",
    );
  }
  const deno = Deno.execPath();
  const args = [
    deno,
    "deploy",
    "--non-interactive",
    ...(options.org ? ["--org", options.org] : []),
    ...(options.app ? ["--app", options.app] : []),
    ...(options.prod === false ? [] : ["--prod"]),
  ];
  if (await ctx.run(args) !== 0) throw new Error("denext: deno deploy failed");
}

/**
 * The Deno Deploy preset: an entrypoint that maps the schedules onto `Deno.cron` and the cache
 * onto Deno KV, plus the app settings.
 *
 * @param options The Deno Deploy options.
 * @returns The adapter.
 */
export function denoDeploy(options: DenoDeployPresetOptions = {}): DeployAdapter {
  return {
    name: "deno-deploy",
    prepare: async (ctx) => {
      const imports = await projectImports(ctx.projectDir);
      const entry = renderDenoDeployEntry(
        ctx.manifest,
        options,
        (sub) => denextSpecifier(imports, sub, ctx.manifest.denext),
      );
      await ctx.writeFile(options.entrypoint ?? ENTRYPOINT, entry, {
        in: "project",
        marker: marker("deno-deploy"),
      });
      await ctx.writeFile("app.json", renderDenoDeployApp(options));
      denoDeployWarnings(ctx);
    },
    deploy: (ctx) => denoDeployPush(ctx, options),
  };
}
