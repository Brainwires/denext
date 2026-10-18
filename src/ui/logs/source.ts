// Where the Logs page reads from, and how a page of lines is cut, filtered and redacted.
//
// Two sources, one shape. On a machine with Docker — `denext ui`, or `denext dashboard` run next
// to the stack — `docker compose logs` (argv only, never a shell). Inside the stack, where the
// dashboard's container has no Docker, the `dashboard-logs` relay (`relay.ts`): the only
// container that reaches the Docker socket, answering GETs for the project's own service logs
// behind a bearer token derived from the dashboard password.
//
// Every line is redacted before it is rendered: a `postgres://` password, and the value of every
// secret-looking variable the process (or the project's `.env`) holds — a log is not a place a
// dashboard should show a key from.

import { join } from "@std/path";
import { lineLevel, type ServiceHealth, serviceHealth } from "../../cli/commands/stack-health.ts";
import { parsePs } from "../../cli/commands/stack-io.ts";
import { parseEnv } from "../../server/env.ts";
import { findComposeFile } from "../../build/docker-template.ts";
import { maskSecrets } from "../database/protocol.ts";

/** One log line. */
export interface LogLine {
  /** The compose service it came from. */
  readonly service: string;
  /** When (RFC 3339), when the source stamped it. */
  readonly time?: string;
  /** The text. */
  readonly text: string;
}

/** What one page of logs asks for. */
export interface LogQuery {
  /** The service, or `""` for every one. */
  readonly service: string;
  /** The last this many lines (per service, then the newest this many overall). */
  readonly tail: number;
  /** How far back, in seconds (none: as far as `tail` reaches). */
  readonly sinceSeconds?: number;
}

/** A place logs come from. */
export interface LogSource {
  /** What the page says it reads. */
  readonly label: string;
  /** The services there are. */
  services(signal?: AbortSignal): Promise<string[]>;
  /** The lines `query` asks for, oldest first. */
  read(query: LogQuery, signal?: AbortSignal): Promise<LogLine[]>;
  /** Each service's health check, as `denext stack health` reads it. */
  health(signal?: AbortSignal): Promise<ServiceHealth[]>;
}

/** The longest a source may take, in ms. */
export const LOG_DEADLINE_MS = 20_000;

/** A compose service name (the shape `denext stack logs` accepts). */
export const LOG_SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** The longest log line rendered. */
const MAX_LINE_CHARS = 4_000;

// ── docker compose (a machine with Docker) ─────────────────────────────────

/** Runs `docker` with `args` in `cwd`: its exit code and stdout. */
export type DockerRunner = (
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The real runner: `docker`, argv only. */
const realDocker: DockerRunner = async (args, cwd, signal) => {
  let out: Deno.CommandOutput;
  try {
    // `output()` throws a missing binary synchronously, so a `.catch()` on it never sees one.
    out = await new Deno.Command("docker", {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
      signal,
    }).output();
  } catch (error) {
    throw error instanceof Deno.errors.NotFound
      ? new Error("docker is not on PATH: logs need Docker (or the stack's dashboard-logs relay)")
      : error;
  }
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  return { code: out.code, stdout: text(out.stdout), stderr: text(out.stderr) };
};

let dockerRunner: DockerRunner = realDocker;

/**
 * Swap the `docker` runner (tests script it).
 *
 * @internal
 * @param next The runner.
 * @returns The runner installed before.
 */
export function setDockerRunner(next: DockerRunner): DockerRunner {
  const previous = dockerRunner;
  dockerRunner = next;
  return previous;
}

/** A `docker compose` call that must succeed. */
async function compose(
  dir: string,
  file: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const out = await dockerRunner(["compose", "-f", file, ...args], dir, signal);
  if (out.code !== 0) {
    const why = out.stderr.trim().split("\n").pop() ?? "";
    throw new Error(`docker compose ${args[0]} exited ${out.code}${why ? `: ${why}` : ""}`);
  }
  return out.stdout;
}

/** `30m` for a number of seconds — what `docker compose logs --since` takes. */
function relative(seconds: number): string {
  return `${Math.max(1, Math.trunc(seconds / 60))}m`;
}

/**
 * `docker compose logs` for the project's compose file.
 *
 * @param dir The project.
 * @param file The compose file, relative to `dir`.
 * @returns The source.
 */
export function composeSource(dir: string, file: string): LogSource {
  return {
    label: `docker compose logs (${file})`,
    async services(signal) {
      const text = await compose(dir, file, ["config", "--services"], signal);
      return text.split("\n").map((s) => s.trim()).filter((s) => LOG_SERVICE_NAME.test(s)).sort();
    },
    async read(query, signal) {
      const services = query.service ? [query.service] : await this.services(signal);
      const lines: LogLine[] = [];
      for (const service of services) {
        if (!LOG_SERVICE_NAME.test(service)) continue;
        const args = ["logs", "--no-color", "--timestamps", "--no-log-prefix"];
        args.push(`--tail=${query.tail}`);
        if (query.sinceSeconds) args.push(`--since=${relative(query.sinceSeconds)}`);
        const text = await compose(dir, file, [...args, service], signal);
        for (const line of text.split("\n")) if (line !== "") lines.push(stamped(service, line));
      }
      return newest(lines, query.tail);
    },
    async health(signal) {
      const text = await compose(dir, file, ["ps", "--all", "--format", "json"], signal);
      return parsePs(text).map(serviceHealth).sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

/** A timestamped compose line split into its time and text. */
function stamped(service: string, line: string): LogLine {
  const match = /^(\d{4}-\d\d-\d\dT\S+)\s(.*)$/.exec(line);
  return match ? { service, time: match[1], text: match[2] } : { service, text: line };
}

/** The newest `max` lines, oldest first (a stable sort by time; unstamped lines keep place). */
function newest(lines: LogLine[], max: number): LogLine[] {
  const sorted = lines.map((line, index) => ({ line, index })).sort((a, b) => {
    const ta = a.line.time ?? "";
    const tb = b.line.time ?? "";
    return ta === tb ? a.index - b.index : ta < tb ? -1 : 1;
  }).map((x) => x.line);
  return sorted.slice(Math.max(0, sorted.length - max));
}

// ── the stack's relay ──────────────────────────────────────────────────────

/** The `HMAC-SHA256` label the relay's bearer token is derived under. */
const RELAY_TOKEN_LABEL = "denext dashboard-logs v1";

/**
 * The bearer token the dashboard presents to the relay: HMAC-SHA256 of a fixed label under the
 * dashboard password, so both containers derive it and neither carries a second secret.
 *
 * @param password The dashboard password.
 * @returns The token (base64url).
 */
export async function relayToken(password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(RELAY_TOKEN_LABEL)),
  );
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The stack's `dashboard-logs` relay.
 *
 * @param url Its base URL (`http://dashboard-logs:3101`).
 * @param token The bearer token ({@linkcode relayToken}).
 * @returns The source.
 */
export function relaySource(url: string, token: string): LogSource {
  const base = url.replace(/\/+$/, "");
  const get = async <T>(path: string, signal?: AbortSignal): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    const body = await res.json().catch(() => null) as T & { ok?: boolean; reason?: string };
    if (!res.ok || !body || body.ok === false) {
      throw new Error(`the logs relay answered ${res.status}: ${body?.reason ?? "no reason"}`);
    }
    return body;
  };
  return {
    label: "the stack's dashboard-logs relay",
    async services(signal) {
      return (await get<{ services: string[] }>("/v1/services", signal)).services;
    },
    async read(query, signal) {
      const params = new URLSearchParams({ tail: String(query.tail) });
      if (query.service) params.set("service", query.service);
      if (query.sinceSeconds) params.set("since", String(query.sinceSeconds));
      const lines = (await get<{ lines: LogLine[] }>(`/v1/logs?${params}`, signal)).lines;
      return newest(lines, query.tail);
    },
    async health(signal) {
      return (await get<{ services: ServiceHealth[] }>("/v1/health", signal)).services;
    },
  };
}

/** How the server reaches the stack's relay (dashboard mode inside the stack). */
export interface RelayConfig {
  /** The relay's base URL. */
  readonly url: string;
  /** The bearer token. */
  readonly token: string;
}

/**
 * Where this server reads logs: the relay when one is configured, else `docker compose` for the
 * project's compose file, else nowhere.
 *
 * @param dir The project.
 * @param relay The stack's relay, when the server was started with one.
 * @returns The source, or `null` with no compose file and no relay.
 */
export async function pickLogSource(
  dir: string,
  relay: RelayConfig | undefined,
): Promise<LogSource | null> {
  if (relay) return relaySource(relay.url, relay.token);
  const file = await findComposeFile(dir);
  return file === null ? null : composeSource(dir, file);
}

// ── filtering and redaction ────────────────────────────────────────────────

/** The levels the page filters by, lowest first. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/** A variable whose value is a secret (and is therefore never shown in a log line). */
const SECRET_NAME = /PASSWORD|SECRET|TOKEN|(?:^|_)KEYS?$|_KEY_|PRIVATE/i;

/** The shortest value redacted (a shorter one would mask ordinary words). */
const MIN_SECRET_CHARS = 8;

/**
 * The secret values a log line must never show: every secret-looking variable of `env`.
 *
 * @param envs The environments to read (the process's, the project's `.env`).
 * @returns The values, longest first.
 */
export function secretValues(...envs: Record<string, string>[]): string[] {
  const out = new Set<string>();
  for (const env of envs) {
    for (const [name, value] of Object.entries(env)) {
      if (!SECRET_NAME.test(name)) continue;
      for (const part of [value, ...value.split(",")]) {
        const v = part.trim();
        if (v.length >= MIN_SECRET_CHARS) out.add(v);
      }
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * The secrets of this process's environment and the project's `.env`.
 *
 * @param dir The project.
 * @returns The values ({@linkcode secretValues}).
 */
export async function knownSecrets(dir: string): Promise<string[]> {
  let processEnv: Record<string, string> = {};
  try {
    processEnv = Deno.env.toObject();
  } catch { /* no env permission: nothing to read */ }
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnv(await Deno.readTextFile(join(dir, ".env")));
  } catch { /* no .env */ }
  return secretValues(processEnv, fileEnv);
}

/**
 * A line with every known secret and connection-string password masked.
 *
 * @param text The line.
 * @param secrets The values to mask ({@linkcode secretValues}).
 * @returns The redacted line, cut to a readable length.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = maskSecrets(text);
  for (const secret of secrets) if (out.includes(secret)) out = out.replaceAll(secret, "•••");
  return out.length > MAX_LINE_CHARS ? `${out.slice(0, MAX_LINE_CHARS)}…` : out;
}

/** What the page filters a page of lines by. */
export interface LogFilter {
  /** The lowest level shown. */
  readonly level: typeof LOG_LEVELS[number];
  /** Text a line must contain (case-insensitive; plain text, never a pattern). */
  readonly text: string;
}

/**
 * The lines that pass the filter, redacted.
 *
 * @param lines The lines read.
 * @param filter The level and text.
 * @param secrets The values to mask.
 * @returns What the page shows.
 */
export function filterLines(
  lines: readonly LogLine[],
  filter: LogFilter,
  secrets: readonly string[],
): LogLine[] {
  const min = LOG_LEVELS.indexOf(filter.level);
  const needle = filter.text.toLowerCase();
  const out: LogLine[] = [];
  for (const line of lines) {
    if (LOG_LEVELS.indexOf(lineLevel(line.text)) < min) continue;
    const text = redact(line.text, secrets);
    if (needle && !text.toLowerCase().includes(needle)) continue;
    out.push({ ...line, text });
  }
  return out;
}
