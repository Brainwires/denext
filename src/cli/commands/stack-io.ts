// What every `denext stack` action shares: how it reaches Docker, the terminal and stdin (one
// injectable {@linkcode StackIo}, so tests script Docker), the compose file arguments, `.env`
// reading and `docker compose ps` parsing.

import { join } from "@std/path";
import type { CommandContext } from "../command.ts";
import { parseEnv } from "../../server/env.ts";

/** Options for {@linkcode StackIo.pipe}: what feeds `docker`'s stdin and where stdout goes. */
export interface PipeOptions {
  /** Text written to stdin (SQL, a password: never an argv value). */
  readonly input?: string;
  /** A file streamed to stdin. */
  readonly inputFile?: string;
  /** A file stdout is streamed into (binary-safe); without it stdout is captured as text. */
  readonly outputFile?: string;
}

/** How the verb reaches Docker, the terminal and the network (injectable for tests). */
export interface StackIo {
  /** Run `docker` with `args` in `cwd`; output streams through unless `capture`. */
  docker(
    args: string[],
    cwd: string,
    capture: boolean,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Write `docker-compose.yml` & co. (`denext generate docker`). */
  generate(ctx: CommandContext, dir: string): Promise<void>;
  log(line: string): void;
  error(line: string): void;
  /** Run `docker` with stdin fed and stdout captured or written to a file (stderr captured). */
  pipe?(
    args: string[],
    cwd: string,
    options: PipeOptions,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Run `docker`, handing each stdout line to `onLine`; resolves the exit code. */
  stream?(args: string[], cwd: string, onLine: (line: string) => void): Promise<number>;
  /** Whether a person is at the terminal (stdin is a TTY). */
  isTerminal?(): boolean;
  /** Ask a yes / no question on the terminal. */
  confirm?(question: string): Promise<boolean>;
  /** Read one secret: without echo on a terminal, else the next line of stdin. */
  readSecret?(prompt: string): Promise<string>;
  /** `fetch`, for the app's health probe. */
  fetch?(url: string, init?: RequestInit): Promise<Response>;
  /** Wait `ms` between `health --watch` rounds. */
  sleep?(ms: number): Promise<void>;
}

/**
 * The member `name` of `io`, or an error saying this run can't do it (a test's partial io).
 *
 * @param io The io.
 * @param name The member.
 * @returns The member, bound to `io`.
 */
export function ioMember<K extends keyof StackIo>(io: StackIo, name: K): NonNullable<StackIo[K]> {
  const member = io[name];
  if (typeof member !== "function") throw new Error(`denext stack: no ${String(name)} available`);
  return (member as (...args: unknown[]) => unknown).bind(io) as NonNullable<StackIo[K]>;
}

/** The compose files: the stack, plus the dev overlay with `--dev`. */
export function composeArgs(ctx: CommandContext): string[] {
  const files = ["-f", "docker-compose.yml"];
  if (ctx.flags.dev === true) files.push("-f", "compose.dev.yml");
  return ["compose", ...files];
}

/** Whether `path` exists. */
export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The project's `.env` values (empty when it has none). */
export async function readEnvFile(dir: string): Promise<Record<string, string>> {
  try {
    return parseEnv(await Deno.readTextFile(join(dir, ".env")));
  } catch {
    return {};
  }
}

/** One service of `docker compose ps --format json`. */
export interface PsRow {
  Service: string;
  State: string;
  Health?: string;
  ExitCode?: number;
  Publishers?: { URL?: string; TargetPort: number; PublishedPort: number }[];
}

/** `docker compose ps --format json`: one JSON array, or one object per line (older compose). */
export function parsePs(text: string): PsRow[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed) as PsRow[];
  return trimmed.split("\n").filter(Boolean).map((line) => JSON.parse(line) as PsRow);
}

/** The host port a service's `target` port (or its first published port) is published on. */
export function published(row: PsRow | undefined, target?: number): number | undefined {
  const pub = row?.Publishers?.find((p) =>
    p.PublishedPort > 0 && (target === undefined || p.TargetPort === target)
  );
  return pub?.PublishedPort;
}

/**
 * The stack's services as `docker compose ps --all` reports them.
 *
 * @param ctx The invocation (`--dev`).
 * @param dir The project.
 * @param io Docker.
 * @returns The rows.
 */
export async function psRows(ctx: CommandContext, dir: string, io: StackIo): Promise<PsRow[]> {
  const ps = await io.docker([...composeArgs(ctx), "ps", "--all", "--format", "json"], dir, true);
  if (ps.code !== 0) throw new Error(`docker compose ps failed: ${ps.stderr.trim()}`);
  return parsePs(ps.stdout);
}

/**
 * Refuse unless `service` is running.
 *
 * @param rows The stack's services.
 * @param service The one that must be running.
 */
export function requireRunning(rows: PsRow[], service: string): void {
  if (rows.find((r) => r.Service === service)?.State !== "running") {
    throw new Error(`the ${service} service is not running (denext stack up)`);
  }
}

/** A compose service name, safe to pass as an argument (never read as a flag). */
export const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** The message for a machine without Docker. */
export const NO_DOCKER = "docker is not on PATH: install Docker (with the compose plugin)";

/** Spawn `command`, or say Docker is missing. */
function spawnDocker(command: Deno.Command): Deno.ChildProcess {
  try {
    return command.spawn();
  } catch (error) {
    throw error instanceof Deno.errors.NotFound ? new Error(NO_DOCKER) : error;
  }
}

/** Text from a byte stream. */
async function text(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream ? await new Response(stream).text() : "";
}

/** Feed `stdin` from the options (then close it). */
async function feed(stdin: WritableStream<Uint8Array>, options: PipeOptions): Promise<void> {
  if (options.inputFile) {
    const file = await Deno.open(options.inputFile);
    await file.readable.pipeTo(stdin);
    return;
  }
  const writer = stdin.getWriter();
  await writer.write(new TextEncoder().encode(options.input ?? ""));
  await writer.close();
}

/**
 * Run `docker` with stdin fed from `options` and stdout captured or written to a file (the
 * default {@linkcode StackIo.pipe}).
 *
 * @param args The arguments.
 * @param cwd The project.
 * @param options stdin and stdout.
 * @returns The exit code, captured stdout (empty with `outputFile`) and stderr.
 */
async function dockerPipe(
  args: string[],
  cwd: string,
  options: PipeOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fed = options.input !== undefined || options.inputFile !== undefined;
  const child = spawnDocker(
    new Deno.Command("docker", {
      args,
      cwd,
      stdin: fed ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
    }),
  );
  const output = options.outputFile
    ? Deno.open(options.outputFile, { write: true, create: true, truncate: true, mode: 0o600 })
      .then((f) => child.stdout.pipeTo(f.writable)).then(() => "")
    : text(child.stdout);
  const [stdout, stderr, status] = await Promise.all([
    output,
    text(child.stderr),
    child.status,
    // A command that exits before reading all of stdin breaks the pipe: its exit code says why.
    fed ? feed(child.stdin, options).catch(() => {}) : Promise.resolve(),
  ]);
  return { code: status.code, stdout, stderr };
}

/**
 * Run `docker`, handing each stdout line to `onLine` (the default {@linkcode StackIo.stream}).
 *
 * @param args The arguments.
 * @param cwd The project.
 * @param onLine Called per line.
 * @returns The exit code.
 */
async function dockerStream(
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
): Promise<number> {
  const child = spawnDocker(
    new Deno.Command("docker", { args, cwd, stdout: "piped", stderr: "inherit" }),
  );
  let pending = "";
  for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line.replace(/\r$/, ""));
  }
  if (pending) onLine(pending);
  return (await child.status).code;
}

/** Piped stdin, read whole once and handed out a line at a time. */
let stdinLines: Promise<string[]> | undefined;

/**
 * One key of a hidden entry: Enter ends it, Ctrl-C cancels, Backspace / Delete drops the last
 * byte, anything else is kept.
 *
 * @param bytes The entry so far (changed in place).
 * @param key The key's byte (`undefined` at the end of input).
 * @returns Whether the entry is complete.
 */
export function hiddenKey(bytes: number[], key: number | undefined): boolean {
  if (key === undefined || key === 0x0d || key === 0x0a) return true;
  if (key === 0x03) throw new Error("cancelled");
  if (key === 0x7f || key === 0x08) bytes.pop();
  else bytes.push(key);
  return false;
}

/** Read a line on a terminal without echoing it. */
async function readHidden(prompt: string): Promise<string> {
  const encoder = new TextEncoder();
  await Deno.stderr.write(encoder.encode(prompt));
  Deno.stdin.setRaw(true);
  const bytes: number[] = [];
  const buf = new Uint8Array(1);
  try {
    while (!hiddenKey(bytes, await Deno.stdin.read(buf) === null ? undefined : buf[0])) {
      // the next key
    }
  } finally {
    Deno.stdin.setRaw(false);
    await Deno.stderr.write(encoder.encode("\n"));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Read one secret (the default {@linkcode StackIo.readSecret}): typed twice without echo on a
 * terminal, else the next line of stdin.
 *
 * @param prompt What to ask.
 * @returns The value.
 */
async function readSecretDefault(prompt: string): Promise<string> {
  if (Deno.stdin.isTerminal()) {
    const first = await readHidden(prompt);
    if (await readHidden("Again: ") !== first) throw new Error("the two entries differ");
    return first;
  }
  stdinLines ??= new Response(Deno.stdin.readable).text().then((t) => t.split(/\r?\n/));
  const lines = await stdinLines;
  const line = lines.shift();
  if (line === undefined || line === "") {
    throw new Error("no password on stdin (pipe one per line, or pass --generate)");
  }
  return line;
}

/** The default terminal, network and timer members of {@linkcode StackIo}. */
export const terminalIo: Pick<
  Required<StackIo>,
  "pipe" | "stream" | "isTerminal" | "confirm" | "readSecret" | "fetch" | "sleep"
> = {
  pipe: dockerPipe,
  stream: dockerStream,
  isTerminal: () => Deno.stdin.isTerminal(),
  confirm: (question) => Promise.resolve(globalThis.confirm(question)),
  readSecret: readSecretDefault,
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
