// `denext stack health` and the filters of `denext stack logs`.
//
//   health [--json] [--watch [seconds]]   every service's compose health check (a one-shot that
//        exited 0 counts as done), then the app's own `/_denext/health` with its readiness
//        checks; exits 1 when anything is unhealthy. --watch repeats every N seconds (5).
//   logs [service] [--service s]… [--level l] [--since t] [--until t] [--grep text|/re/flags]
//        `docker compose logs`, time window passed through; level and text matched per line.

import type { CommandContext } from "../command.ts";
import {
  composeArgs,
  ioMember,
  type PsRow,
  psRows,
  published,
  SERVICE_NAME,
  type StackIo,
} from "./stack-io.ts";

/** One service's verdict. */
export interface ServiceHealth {
  name: string;
  state: string;
  /** The compose health status, `"completed"` for a one-shot that exited 0, or `"none"`. */
  health: string;
  ok: boolean;
}

/** The app's `/_denext/health` answer. */
export interface AppHealth {
  url: string;
  status: "ok" | "degraded" | "unreachable";
  httpStatus?: number;
  checks?: Record<string, string>;
}

/** What `health` reports (`--json` prints exactly this). */
export interface StackHealth {
  ok: boolean;
  checkedAt: string;
  services: ServiceHealth[];
  app?: AppHealth;
}

/**
 * A service's verdict from `docker compose ps`.
 *
 * @param row The service.
 * @returns Its health.
 */
export function serviceHealth(row: PsRow): ServiceHealth {
  const base = { name: row.Service, state: row.State };
  if (row.State === "exited" && row.ExitCode === 0) {
    return { ...base, health: "completed", ok: true };
  }
  const health = row.Health || "none";
  const ok = row.State === "running" && (health === "none" || health === "healthy");
  return { ...base, health, ok };
}

/**
 * The app's readiness: `GET /_denext/health` on its published port.
 *
 * @param io The network.
 * @param url The probe's URL.
 * @returns The verdict.
 */
async function appHealth(io: StackIo, url: string): Promise<AppHealth> {
  try {
    const res = await ioMember(io, "fetch")(url, { signal: AbortSignal.timeout(5000) });
    const body = await res.json().catch(() => ({})) as { checks?: Record<string, string> };
    return {
      url,
      status: res.ok ? "ok" : "degraded",
      httpStatus: res.status,
      ...(body.checks && Object.keys(body.checks).length ? { checks: body.checks } : {}),
    };
  } catch {
    return { url, status: "unreachable" };
  }
}

/**
 * The stack's health.
 *
 * @param rows The services.
 * @param app The app's probe, when the app is published.
 * @returns The report.
 */
export function stackHealth(rows: PsRow[], app: AppHealth | undefined): StackHealth {
  const services = rows.map(serviceHealth);
  const ok = services.length > 0 && services.every((s) => s.ok) &&
    (app === undefined || app.status === "ok");
  return { ok, checkedAt: new Date().toISOString(), services, ...(app ? { app } : {}) };
}

/** The report as a table. */
function healthTable(report: StackHealth): string[] {
  if (!report.services.length) return ["The stack is not running (denext stack up)."];
  const lines = [`  ${"SERVICE".padEnd(14)} ${"STATE".padEnd(10)} ${"HEALTH".padEnd(10)} OK`];
  for (const s of report.services) {
    lines.push(
      `  ${s.name.padEnd(14)} ${s.state.padEnd(10)} ${s.health.padEnd(10)} ${s.ok ? "yes" : "NO"}`,
    );
  }
  if (report.app) {
    const a = report.app;
    lines.push("", `  app ${a.url}: ${a.status}${a.httpStatus ? ` (${a.httpStatus})` : ""}`);
    for (const [name, verdict] of Object.entries(a.checks ?? {})) {
      lines.push(`    ${name.padEnd(16)} ${verdict}`);
    }
  }
  lines.push("", report.ok ? "Healthy." : "Unhealthy.");
  return lines;
}

/** One round: probe, then print. */
async function healthRound(ctx: CommandContext, dir: string, io: StackIo): Promise<StackHealth> {
  const rows = await psRows(ctx, dir, io);
  const port = published(rows.find((r) => r.Service === "web"));
  const app = port ? await appHealth(io, `http://127.0.0.1:${port}/_denext/health`) : undefined;
  const report = stackHealth(rows, app);
  if (ctx.global.json) io.log(JSON.stringify(report, null, ctx.flags.watch === true ? 0 : 2));
  else for (const line of healthTable(report)) io.log(line);
  return report;
}

/** `--watch [seconds]`: the seconds (the positional after the action), default 5. */
export function watchSeconds(ctx: CommandContext): number {
  const raw = ctx.positionals[1];
  if (raw === undefined) return 5;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) throw new Error(`--watch takes whole seconds ≥ 1, got ${raw}`);
  return Math.floor(n);
}

/**
 * `denext stack health`: resolves 1 when anything is unhealthy. `--watch` repeats until
 * interrupted.
 *
 * @param ctx The invocation.
 * @param dir The project.
 * @param io Docker and the network.
 * @returns The exit code.
 */
export async function healthAction(
  ctx: CommandContext,
  dir: string,
  io: StackIo,
): Promise<number> {
  if (ctx.flags.watch !== true) return (await healthRound(ctx, dir, io)).ok ? 0 : 1;
  const seconds = watchSeconds(ctx);
  const sleep = ioMember(io, "sleep");
  while (true) {
    if (!ctx.global.json && io.isTerminal?.()) io.log("\x1b[2J\x1b[H");
    if (!ctx.global.json) io.log(`denext stack health, every ${seconds}s (Ctrl-C stops)`);
    await healthRound(ctx, dir, io);
    await sleep(seconds * 1000);
  }
}

/** Log levels, lowest first; a line's level is the first word that names one. */
const LEVELS = ["debug", "info", "warn", "error"] as const;

/** Words that mean each level (Deno / denext, Postgres, MinIO, JSON and logfmt logs). */
const LEVEL_WORDS: Record<string, typeof LEVELS[number]> = {
  trace: "debug",
  debug: "debug",
  debug1: "debug",
  debug2: "debug",
  info: "info",
  log: "info",
  notice: "info",
  warn: "warn",
  warning: "warn",
  error: "error",
  err: "error",
  fatal: "error",
  panic: "error",
  critical: "error",
};

/**
 * The level of one log line: a JSON / logfmt `level`, or a level word (`ERROR:`, `[warn]`, …).
 * A line that names none (a stack trace's continuation) counts as `info`.
 *
 * @param line The line (with or without compose's `service |` prefix).
 * @returns The level.
 */
export function lineLevel(line: string): typeof LEVELS[number] {
  const message = line.replace(/^[^|]*\|\s?/, "");
  const keyed = /"?(?:level|severity|lvl)"?\s*[:=]\s*"?([A-Za-z]+\d?)/i.exec(message);
  const word = keyed?.[1] ??
    /\b(trace|debug[12]?|info|log|notice|warn(?:ing)?|error|err|fatal|panic|critical)\b/i
      .exec(message)?.[1];
  return LEVEL_WORDS[word?.toLowerCase() ?? ""] ?? "info";
}

/** A `--grep` value: `/re/flags` is a regular expression, anything else plain text. */
export function grepMatcher(pattern: string): (line: string) => boolean {
  const re = /^\/(.+)\/([dgimsuvy]*)$/.exec(pattern);
  if (!re) return (line) => line.includes(pattern);
  let compiled: RegExp;
  try {
    compiled = new RegExp(re[1], re[2].replace("g", ""));
  } catch (error) {
    throw new Error(`--grep: ${(error as Error).message}`);
  }
  return (line) => compiled.test(line);
}

/** A predicate for `--level` and `--grep`, or `undefined` when neither is set. */
export function logFilter(ctx: CommandContext): ((line: string) => boolean) | undefined {
  const level = ctx.flags.level;
  const grep = ctx.flags.grep;
  if (level === undefined && grep === undefined) return undefined;
  let min = 0;
  if (level !== undefined) {
    min = LEVELS.indexOf(String(level).toLowerCase().replace(/^warning$/, "warn") as never);
    if (min === -1) throw new Error(`--level: one of ${LEVELS.join(" | ")}, got ${level}`);
  }
  const text = grep === undefined ? undefined : grepMatcher(String(grep));
  return (line) => LEVELS.indexOf(lineLevel(line)) >= min && (text?.(line) ?? true);
}

/** The services `logs` asks for: the positional and every `--service`. */
function logServices(ctx: CommandContext): string[] {
  const named = [
    ...(ctx.positionals[1] ? [ctx.positionals[1]] : []),
    ...String(ctx.flags.service ?? "").split(",").filter(Boolean),
  ];
  for (const s of named) {
    if (!SERVICE_NAME.test(s)) throw new Error(`not a service name: ${s}`);
  }
  return named;
}

/**
 * The `docker compose logs` arguments for an invocation.
 *
 * @param ctx The invocation.
 * @returns The arguments.
 */
export function logsArgs(ctx: CommandContext): string[] {
  const args = [...composeArgs(ctx), "logs"];
  if (ctx.flags.follow === true) args.push("--follow");
  for (const key of ["since", "until"]) {
    const value = ctx.flags[key];
    if (value !== undefined && value !== "") args.push(`--${key}=${value}`);
  }
  return [...args, ...logServices(ctx)];
}

/**
 * `denext stack logs`.
 *
 * @param ctx The invocation.
 * @param dir The project.
 * @param io Docker.
 */
export async function logsAction(ctx: CommandContext, dir: string, io: StackIo): Promise<void> {
  const args = logsArgs(ctx);
  const filter = logFilter(ctx);
  if (!filter) {
    const logs = await io.docker(args, dir, false);
    if (logs.code !== 0) throw new Error(`docker compose logs exited ${logs.code}`);
    return;
  }
  args.splice(args.indexOf("logs") + 1, 0, "--no-color");
  const code = await ioMember(io, "stream")(args, dir, (line) => {
    if (filter(line)) io.log(line);
  });
  if (code !== 0) throw new Error(`docker compose logs exited ${code}`);
}
