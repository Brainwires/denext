// The `fly` deploy preset: the Docker image (the `docker` preset's files) plus a `fly.toml` at the
// project root — the port, `SIGTERM` with a kill timeout above denext's drain, an HTTP health
// check on `/_denext/health`, and the secrets the app needs listed (never their values).
// `denext deploy` runs `fly deploy` when `flyctl` (or `fly`) is on PATH and `FLY_API_TOKEN` is
// set.

import type { DeployAdapter, DeployContext } from "../adapter.ts";
import type { DeployManifest } from "../manifest.ts";
import { writeDockerFiles } from "./docker.ts";
import { memoryLimitBytes } from "../../server/config-validate/limits.ts";
import { appName, drainMsOf, header, marker, requiredSecrets, stopTimeoutSec } from "./shared.ts";
import { tlsEnvNames } from "../../build/start-tls-deploy.ts";

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
  /**
   * The shutdown drain (ms; `0`: as long as Fly allows). Default: `DENEXT_SHUTDOWN_DRAIN_MS` in
   * the environment `prepare` runs in, else 10 s. `kill_timeout` is the drain plus 20 s (Fly's
   * most is 300 s).
   */
  drainMs?: number;
}

/** The machine's memory when the preset sets none. */
const DEFAULT_VM_MEMORY = "512mb";

/** Fly's longest `kill_timeout` (seconds). */
const FLY_MAX_KILL_TIMEOUT_S = 300;

/** The kill timeout: above the drain, so `SIGTERM` lets in-flight requests finish. */
function killTimeout(drainMs: number): string {
  return `${Math.min(stopTimeoutSec(drainMs) ?? FLY_MAX_KILL_TIMEOUT_S, FLY_MAX_KILL_TIMEOUT_S)}s`;
}

/** The port, checked: it goes into fly.toml unquoted. */
function flyPort(port: unknown): number {
  if (Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535) {
    return port as number;
  }
  throw new Error(`denext: deploy (fly) option port ${JSON.stringify(port)} is not a TCP port`);
}

/** A TOML basic string (JSON's escapes are TOML's), so an option can't end its line. */
const toml = (value: string): string => JSON.stringify(String(value));

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
  options: FlyPresetOptions & { app: string; drain: number },
): string {
  const port = flyPort(options.port ?? manifest.server.port);
  const secrets = requiredSecrets(manifest);
  const on = alwaysOn(manifest);
  return `${header("fly", "#")}
app = ${toml(options.app)}
primary_region = ${toml(options.region ?? "iad")}
kill_signal = "SIGTERM"
kill_timeout = "${killTimeout(options.drain)}"
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
${manifest.server.tls ? "" : PROXY_ENV}  ${manifest.server.drain.env} = "${options.drain}"
${manifest.server.tls ? tlsService(manifest, port, on) : httpService(manifest, port, on)}
[[vm]]
  memory = ${toml(options.memory ?? DEFAULT_VM_MEMORY)}
`;
}

/** Behind Fly's HTTP proxy: trust it, and key the per-address limits on the address it sends. */
const PROXY_ENV =
  `  # fly-proxy connects from a private address: trust it, and key the per-address limits
  # (rateLimit(), auth's per-IP budgets, Live's per-IP cap) on the client address it sends.
  DENEXT_TRUST_PROXY = "1"
  DENEXT_RATE_LIMIT_HEADER = "fly-client-ip"
`;

/** Fly's HTTP service: its edge terminates TLS and checks `/_denext/health`. */
function httpService(manifest: DeployManifest, port: number, on: boolean): string {
  return `
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
`;
}

/**
 * With `start.tls` the server terminates TLS itself, so Fly passes the connection through as
 * TCP (no handlers: no HTTP proxy, no forwarded headers) on 443, and checks the port is open.
 */
function tlsService(manifest: DeployManifest, port: number, on: boolean): string {
  const names = manifest.server.tls ? tlsEnvNames(manifest.server.tls) : [];
  return `
# start.tls: the server serves HTTPS itself, so Fly passes TLS through untouched (raw TCP). Put
# the PEM files on the machine (a [[files]] entry from a secret, or a volume) and set
# ${names.join(", ")} to their paths.
[[services]]
  protocol = "tcp"
  internal_port = ${port}
  auto_stop_machines = "${on ? "off" : "stop"}"
  auto_start_machines = true
  min_machines_running = ${on ? 1 : 0}

  [[services.ports]]
    port = 443

  [[services.tcp_checks]]
    grace_period = "15s"
    interval = "15s"
    timeout = "3s"
`;
}

/** A Fly `[[vm]] memory` value in bytes (`"512mb"`, `"1gb"`, a number of megabytes), or `null`. */
function vmMemoryBytes(memory: string): number | null {
  const m = /^\s*(\d+)\s*(mb|gb)?\s*$/i.exec(memory);
  if (!m) return null;
  return Number(m[1]) * 1024 ** ((m[2] ?? "mb").toLowerCase() === "gb" ? 3 : 2);
}

/**
 * The warning when `start.limits.memory` (the server's heap limit) is not below the machine's
 * memory: the kernel's OOM killer would end the server before the heap limit could.
 */
function heapLimitWarning(manifest: DeployManifest, vmMemory: string): string | null {
  const flag = (manifest.server.limits ?? []).find((f) => f.startsWith("--max-memory="));
  const heap = flag ? memoryLimitBytes(flag.slice("--max-memory=".length)) : null;
  const vm = vmMemoryBytes(vmMemory);
  if (heap === null || vm === null || heap < vm) return null;
  return `fly: start.limits.memory (${flag}) is not below the machine's memory (${vmMemory}); ` +
    "the OOM killer ends the server first — lower the limit or raise the preset's memory";
}

/** Warn about what Fly changes for this app. */
function flyWarnings(ctx: DeployContext, vmMemory: string): void {
  const { manifest } = ctx;
  const heap = heapLimitWarning(manifest, vmMemory);
  if (heap) ctx.warn(heap);
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
      const drain = drainMsOf(ctx.manifest, ctx.env, options.drainMs);
      await ctx.writeFile("fly.toml", renderFlyToml(ctx.manifest, { ...options, app, drain }), {
        in: "project",
        marker: marker("fly"),
      });
      flyWarnings(ctx, options.memory ?? DEFAULT_VM_MEMORY);
    },
    deploy: flyDeploy,
  };
}
