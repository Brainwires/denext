// The `docker` deploy preset: the files `denext generate docker` writes (Dockerfile, compose
// file, .dockerignore and, with the stack, .env.example), from the same templates and the same
// detection, at the project root where `docker build` looks for them. A file without the
// generator's marker (hand-written, or edited with the marker removed) is left alone.
// `denext deploy` builds the image and, with `push: true`, pushes it.

import { relative } from "@std/path";
import type { DeployAdapter, DeployContext } from "../adapter.ts";
import { appName } from "./shared.ts";

/** Options for {@linkcode docker}. */
export interface DockerPresetOptions {
  /** The port the image exposes and the server binds (default 3000). */
  port?: number;
  /** The `denoland/deno` image tag (default: the Deno version running the build). */
  denoTag?: string;
  /** The self-hosted stack too: Postgres, storage and migrations behind docker compose. */
  stack?: boolean;
  /** The image `denext deploy` builds (`registry.example.com/team/app:tag`; default: the app's name). */
  image?: string;
  /** Push the image after building it (`denext deploy`); registry login is `docker login`'s. */
  push?: boolean;
}

/**
 * Write the Docker files for the app (shared with the `fly` preset).
 *
 * @param ctx The deploy context.
 * @param options The image options.
 */
export async function writeDockerFiles(
  ctx: DeployContext,
  options: Pick<DockerPresetOptions, "port" | "denoTag" | "stack">,
): Promise<void> {
  const { resolveDocker } = await import("../../build/docker-detect.ts");
  const { dockerPlan, DOCKER_SENTINEL } = await import("../../build/docker-template.ts");
  const resolved = await resolveDocker(ctx.projectDir, {
    target: ctx.manifest.mode === "spa" ? "spa" : "server",
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.denoTag ? { denoTag: options.denoTag } : {}),
    ...(options.stack ? { all: true } : {}),
  });
  for (const warning of resolved.warnings) ctx.warn(warning);
  for (const file of await dockerPlan(ctx.projectDir, resolved.options)) {
    const path = relative(ctx.projectDir, file.path).replaceAll("\\", "/");
    await ctx.writeFile(path, file.contents, { in: "project", marker: DOCKER_SENTINEL });
  }
}

/** `docker build` (then `docker push` when asked). */
async function buildAndPush(ctx: DeployContext, options: DockerPresetOptions): Promise<void> {
  const docker = await ctx.which("docker");
  if (!docker) throw new Error("denext: deploy (docker) needs the docker CLI on PATH");
  const image = options.image ?? appName(undefined, ctx.projectDir);
  if (await ctx.run([docker, "build", "-t", image, "."]) !== 0) {
    throw new Error(`denext: docker build failed (image ${image})`);
  }
  if (!options.push) {
    ctx.log(`built ${image}; run it with: docker run -p 3000:3000 --env-file .env ${image}`);
    return;
  }
  if (await ctx.run([docker, "push", image]) !== 0) {
    throw new Error(`denext: docker push failed (image ${image}) — is \`docker login\` done?`);
  }
}

/**
 * The Docker preset: the production image `denext generate docker` writes (and its compose
 * stack, with `stack: true`).
 *
 * @param options The image options.
 * @returns The adapter.
 */
export function docker(options: DockerPresetOptions = {}): DeployAdapter {
  return {
    name: "docker",
    prepare: (ctx) => writeDockerFiles(ctx, options),
    deploy: (ctx) => buildAndPush(ctx, options),
  };
}
