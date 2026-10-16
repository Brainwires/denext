// The `fly` deploy preset: the Docker image (the `docker` preset's files) plus a `fly.toml` at the
// project root — the port, `SIGTERM` with a kill timeout above denext's drain, an HTTP health
// check on `/_denext/health`, and the secrets the app needs listed (never their values).
// `denext deploy` runs `fly deploy` when `flyctl` (or `fly`) is on PATH and `FLY_API_TOKEN` is
// set.

import type { DeployAdapter, DeployContext } from "../adapter.ts";
import type { DeployManifest } from "../manifest.ts";
import { writeDockerFiles } from "./docker.ts";
import { appName, header, marker, requiredSecrets } from "./shared.ts";

/** Options for {@linkcode fly}. */
export interface FlyPresetOptions {
  /** The Fly app (default: the project directory's name). */
  app?: string;
  /** `primary_region` (default `"iad"`). */
  region?: string;
  /** The port the image listens on (default 3000). */
  port?: number;
  /** The machine's memory (default `"512mb"`). */
  memory?: string;
  /** The `denoland/deno` image tag (default: the Deno version running the build). */
  denoTag?: string;
}

/** The kill timeout: above the default 10 s drain, so `SIGTERM` lets in-flight requests finish. */
const KILL_TIMEOUT = "30s";

/** Whether anything must keep running between requests (schedules, services). */
function alwaysOn(manifest: DeployManifest): boolean {
  return manifest.schedules.length > 0 || manifest.services.length > 0;
}

/**
 * The `fly.toml` for the app.
 *
 * @param manifest The deploy manifest.
 * @param options The preset options, with the app name resolved.
 * @returns The file's contents.
 */
function renderFlyToml(
  manifest: DeployManifest,
  options: FlyPresetOptions & { app: string },
): string {
  const port = options.port ?? manifest.server.port;
  const secrets = requiredSecrets(manifest);
  const on = alwaysOn(manifest);
  return `${header("fly", "#")}
app = "${options.app}"
primary_region = "${options.region ?? "iad"}"
kill_signal = "SIGTERM"
kill_timeout = "${KILL_TIMEOUT}"
${
    secrets.length
      ? `\n# Secrets the app needs — set them with \`fly secrets set NAME=value\`:\n#   ${
        secrets.join(", ")
      }\n`
      : ""
  }
[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "${port}"
  DENEXT_LOG = "json"
  ${manifest.server.drain.env} = "${manifest.server.drain.ms}"

[http_service]
  internal_port = ${port}
  force_https = true
  # ${
    on
      ? "Jobs or services run in the server: keep a machine running."
      : "No jobs or services: idle machines may stop."
  }
  auto_stop_machines = "${on ? "off" : "stop"}"
  auto_start_machines = true
  min_machines_running = ${on ? 1 : 0}

  [[http_service.checks]]
    grace_period = "15s"
    interval = "15s"
    method = "GET"
    path = "${manifest.server.healthPath}"
    timeout = "3s"

[[vm]]
  memory = "${options.memory ?? "512mb"}"
`;
}

/** Warn about what Fly changes for this app. */
function flyWarnings(ctx: DeployContext): void {
  const { manifest } = ctx;
  if (manifest.schedules.length) {
    ctx.warn(
      "fly: every machine runs the schedules — keep one machine (`fly scale count 1`) or a " +
        "shared job runner (https://denext.dev/docs/multi-instance)",
    );
  }
  if (manifest.cache.store === "default") {
    ctx.warn(
      "fly: the cache lives on the machine's disk and starts cold on every deploy; set " +
        "cache.store to a shared store for more than one machine",
    );
  }
}

/** `fly deploy` with the token from the environment. */
async function flyDeploy(ctx: DeployContext): Promise<void> {
  const fly = await ctx.which("flyctl", "fly");
  if (!fly) {
    throw new Error(
      "denext: deploy (fly) needs flyctl on PATH (https://fly.io/docs/flyctl/install/)",
    );
  }
  if (!ctx.env("FLY_API_TOKEN")) {
    throw new Error(
      "denext: deploy (fly) reads its credentials from FLY_API_TOKEN — set it (`fly tokens create deploy`)",
    );
  }
  if (await ctx.run([fly, "deploy", "--config", "fly.toml", "--remote-only"]) !== 0) {
    throw new Error("denext: fly deploy failed");
  }
}

/**
 * The Fly.io preset: the Docker image and a `fly.toml`.
 *
 * @param options The Fly options.
 * @returns The adapter.
 */
export function fly(options: FlyPresetOptions = {}): DeployAdapter {
  return {
    name: "fly",
    prepare: async (ctx) => {
      await writeDockerFiles(ctx, options);
      const app = appName(options.app, ctx.projectDir);
      await ctx.writeFile("fly.toml", renderFlyToml(ctx.manifest, { ...options, app }), {
        in: "project",
        marker: marker("fly"),
      });
      flyWarnings(ctx);
    },
    deploy: flyDeploy,
  };
}
