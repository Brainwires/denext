// Whether a test can use Docker: the CLI with Compose, and a daemon that runs Linux containers.
//
// The probe runs at module load (a test's `ignore`), so it must answer quickly whatever state the
// daemon is in. `docker info` waits on the daemon with no deadline of its own: a hung Docker
// Desktop kept it, and the whole suite with it, waiting for hours. Each step here is bounded;
// past the deadline the child's process tree is killed and Docker counts as unavailable, so the
// tests that need it are skipped.

import { runBounded } from "./bounded-command.ts";

/** How long one probe step may take before Docker counts as unavailable. */
export const DOCKER_PROBE_TIMEOUT_MS = 5_000;

/** Options for {@linkcode dockerReady}. */
export interface DockerProbeOptions {
  /** The `docker` executable (default `docker`, from `PATH`). */
  readonly docker?: string;
  /** Each step's deadline, in ms (default {@linkcode DOCKER_PROBE_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
}

/**
 * Whether Docker can run the Linux images the integration tests use: `docker compose version`
 * succeeds and `docker info` reports a Linux engine (a Windows-containers engine, such as
 * GitHub's windows-latest runner, has no manifest for them). A step that fails, is missing, or
 * runs past its deadline (killed) is a no.
 *
 * @param options The executable and the per-step deadline.
 */
export async function dockerReady(options: DockerProbeOptions = {}): Promise<boolean> {
  const docker = options.docker ?? "docker";
  const timeoutMs = options.timeoutMs ?? DOCKER_PROBE_TIMEOUT_MS;
  // A short drain: a probe that exited has written its one line.
  const step = (args: string[]) => runBounded(docker, args, { timeoutMs, drainMs: 1_000 });
  try {
    const compose = await step(["compose", "version"]);
    if (!compose.success) return false;
    const info = await step(["info", "--format", "{{.OSType}}"]);
    return info.success && info.stdout.trim() === "linux";
  } catch {
    return false; // not installed
  }
}
