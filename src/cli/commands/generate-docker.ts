// `denext generate docker` — the flags, the detection report and the diffs. The templates and
// the detection live in `src/build/docker-*.ts`; this module turns the command line into a
// {@linkcode DockerRequest}, says which stack services are on and why, and shows what a skipped
// (already existing) file would change, the way the `denext ui` Docker panel previews it.

import { join, relative } from "@std/path";
import type { CommandContext, FlagSpec } from "../command.ts";
import {
  dockerPortAndTag,
  type DockerRequest,
  type ResolvedDocker,
  resolveDocker,
  STACK_FEATURE_HELP,
  STACK_FEATURES,
  type StackOverrides,
} from "../../build/docker-detect.ts";
import {
  generateArtifact,
  type GenerateOptions,
  type GeneratePreviewFile,
  type GenerateResult,
} from "../../build/generate.ts";
import { createUnifiedDiff } from "../../build/patch-diff.ts";

/** The docker-only flags (`--postgres` / `--no-postgres`, …, `--stack`, `--port`, …). */
export const DOCKER_FLAGS: readonly FlagSpec[] = [
  ...STACK_FEATURES.flatMap((f): FlagSpec[] => [
    { name: f, type: "boolean", help: `docker: ${STACK_FEATURE_HELP[f]}` },
    { name: `no-${f}`, type: "boolean", help: `docker: leave the ${f} service out` },
  ]),
  {
    name: "stack",
    altNames: ["all"],
    type: "boolean",
    help: "docker: every service the project needs (detected), and Postgres regardless",
  },
  {
    name: "expose-db",
    type: "boolean",
    help: "docker: publish Postgres on 127.0.0.1:5432 (off: only the app reaches it)",
  },
  {
    name: "dev",
    type: "boolean",
    help: "docker: also write compose.dev.yml (denext dev on a bind mount)",
  },
  {
    name: "port",
    type: "number",
    valueName: "<port>",
    help: "docker: the port the app listens on (default 3000)",
  },
  {
    name: "deno-tag",
    type: "string",
    valueName: "<tag>",
    help: "docker: the denoland/deno image tag (default: this Deno's version)",
  },
];

/** Whether the command line used any docker-only flag. */
export function usesDockerFlags(flags: CommandContext["flags"]): boolean {
  return DOCKER_FLAGS.some((f) => flags[f.name] !== undefined && flags[f.name] !== false);
}

/**
 * The {@linkcode DockerRequest} a command line asks for.
 *
 * @param ctx The command context.
 * @param target The `server` | `spa` name-slot override (empty: detect).
 * @returns The request.
 * @throws When a switch is given both ways, or the port / tag is invalid.
 */
function dockerRequest(ctx: CommandContext, target: string): DockerRequest {
  const flags = ctx.flags;
  const { port, tag } = dockerPortAndTag(flags.port, flags["deno-tag"]);
  return {
    target,
    overrides: overridesOf(flags),
    all: flags.stack === true,
    ...(port !== undefined ? { port } : {}),
    ...(tag !== undefined ? { denoTag: tag } : {}),
    exposeDb: flags["expose-db"] === true,
    dev: flags.dev === true,
  };
}

/** The per-service switches: `--x` → on, `--no-x` → off; both is a contradiction. */
function overridesOf(flags: CommandContext["flags"]): StackOverrides {
  const overrides: StackOverrides = {};
  for (const f of STACK_FEATURES) {
    const on = flags[f] === true;
    const off = flags[`no-${f}`] === true;
    if (on && off) throw new Error(`--${f} and --no-${f} contradict each other`);
    if (on || off) overrides[f] = on;
  }
  return overrides;
}

/**
 * The report: the image, then each stack service — on or off, and why (detected, or a flag).
 *
 * @param resolved What `resolveDocker` produced.
 * @param request What was asked for.
 * @returns The lines to print.
 */
function detectionReport(resolved: ResolvedDocker, request: DockerRequest): string[] {
  const { options } = resolved;
  const lines = [`   docker: ${options.mode} image; stack services:`];
  for (const f of STACK_FEATURES) {
    const on = options[f] === true;
    lines.push(`     ${f.padEnd(9)} ${on ? "on " : "off"}  (${whyOf(f, on, resolved, request)})`);
  }
  for (const w of resolved.warnings) lines.push(`   ! ${w}`);
  return lines;
}

/** Why one stack service is on or off: the flag, the detection, or what implied it. */
function whyOf(
  f: typeof STACK_FEATURES[number],
  on: boolean,
  { options, detection }: ResolvedDocker,
  request: DockerRequest,
): string {
  const asked = request.overrides?.[f];
  if (asked !== undefined) return `--${asked ? "" : "no-"}${f}`;
  const reason = detection.reasons[f];
  if (reason) return reason;
  if (!on) return "not detected";
  return f === "postgres" && options.pgvector ? "needed by pgvector" : "--stack";
}

/**
 * Whether the project's `.gitignore` keeps `.env` out of git (a `.env`, `.env*` or `*.env` line).
 *
 * @param dir The project root.
 * @returns False when there is no `.gitignore` or it does not mention `.env`.
 */
async function gitignoresEnv(dir: string): Promise<boolean> {
  try {
    const text = await Deno.readTextFile(join(dir, ".gitignore"));
    return text.split(/\r?\n/).some((l) =>
      /^\/?(\.env|\.env\*|\.env\.\*|\*\.env)\s*$/.test(l.trim())
    );
  } catch {
    return false;
  }
}

/**
 * Print a unified diff for every planned file whose on-disk contents differ — the files a run
 * skipped (exists, no `--force`), or everything on a `--dry-run`. Identical files print nothing.
 *
 * @param dir The project root (paths are shown relative to it).
 * @param files The planned files.
 * @param only Restrict to these absolute paths (the skipped ones), or every file when absent.
 * @returns How many of the files differ from disk.
 */
async function printDiffs(
  dir: string,
  files: readonly GeneratePreviewFile[],
  only?: readonly string[],
): Promise<number> {
  let changed = 0;
  for (const file of files) {
    if (only && !only.includes(file.path)) continue;
    let existing = "";
    try {
      existing = await Deno.readTextFile(file.path);
    } catch { /* absent: the whole file is the diff */ }
    const diff = createUnifiedDiff(existing, file.contents, relative(dir, file.path) || file.path);
    if (diff === "") continue;
    changed++;
    console.log(diff.trimEnd());
  }
  return changed;
}

/** The flags and the project, resolved — or the reason they can't be (printed, exit 1). */
async function resolveOrExit(
  ctx: CommandContext,
  dir: string,
  target: string,
): Promise<{ request: DockerRequest; resolved: ResolvedDocker }> {
  try {
    const request = dockerRequest(ctx, target);
    return { request, resolved: await resolveDocker(dir, request) };
  } catch (error) {
    console.error(`denext generate docker: ${(error as Error).message.replace(/^denext: /, "")}`);
    return Deno.exit(1);
  }
}

/** `--dry-run`: every file's diff, then what a run would write and skip. */
async function reportDryRun(dir: string, plan: GenerateResult): Promise<void> {
  await printDiffs(dir, plan.preview ?? []);
  for (const p of plan.written) console.log(`   would write ${p}`);
  for (const p of plan.skipped) console.log(`   • exists, would skip (--force overwrites): ${p}`);
}

/**
 * What a run wrote, then the diff of each existing file it skipped. Exits 1 when it wrote nothing
 * and a skipped file differs (the regeneration did not happen); an identical re-run is fine.
 */
async function reportWrite(dir: string, plan: GenerateResult, result: GenerateResult) {
  for (const p of result.written) console.log(`   + ${p}`);
  const changed = await printDiffs(dir, plan.preview ?? [], result.skipped);
  for (const p of result.skipped) console.log(`   • exists, skipped: ${p}`);
  if (changed === 0) return;
  console.log(
    `   ${changed} existing file(s) differ (diff above): rerun with --force to overwrite.`,
  );
  if (result.written.length === 0) Deno.exit(1);
}

/** After a stack is written: how to start it, and a warning when git would see `.env`. */
async function printNextSteps(dir: string): Promise<void> {
  console.log("   next: cp .env.example .env, fill in every secret, docker compose up -d --build");
  if (!(await gitignoresEnv(dir))) {
    console.log("   ! .gitignore does not ignore .env — add a `.env` line before you fill it in.");
  }
}

/**
 * `generate docker`: resolve the flags against the project, report the detected stack, then
 * write (or, with `--dry-run`, only diff) the files, showing the diff of every existing file a
 * run skipped.
 *
 * @param ctx The command context (the flags).
 * @param dir The project root.
 * @param target The `server` | `spa` name-slot override (empty: detect).
 * @param options `force` / `dryRun`.
 */
export async function runDocker(
  ctx: CommandContext,
  dir: string,
  target: string,
  options: Pick<GenerateOptions, "force" | "dryRun">,
): Promise<void> {
  const { request, resolved } = await resolveOrExit(ctx, dir, target);
  for (const line of detectionReport(resolved, request)) console.log(line);
  const docker = resolved.options;
  const force = options.force === true;
  const plan = await generateArtifact(dir, "docker", target, { force, dryRun: true, docker });
  if (options.dryRun) return await reportDryRun(dir, plan);
  await reportWrite(dir, plan, await generateArtifact(dir, "docker", target, { force, docker }));
  if (docker.postgres || docker.storage || docker.migrate) await printNextSteps(dir);
}
