// `denext dashboard` — the self-hosted stack's Studio-style dashboard: `denext ui`'s Database
// section (tables and rows, the SQL editor, policies, migrations, storage, auth users, logs)
// served behind the dashboard password (`DASHBOARD_PASSWORD`, set with `denext stack passwd
// --dashboard`) instead of a launch token. The stack runs it as its `dashboard` service; it runs
// as well next to the stack on the host. The gate is `@denext/ui`'s `src/dashboard.ts`
// (packages/ui), loaded on the first run (src/cli/ui-package.ts).
//
// `denext dashboard-logs` (hidden) is the stack's log relay: the one container that reaches the
// Docker socket, answering the dashboard's two GETs for its own project's logs
// (`@denext/ui`'s `src/logs/relay.ts`).
//
// Like `denext ui`, neither verb evaluates the project's modules: the database work runs in
// `denext db-admin` children.

import { join } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { projectDir } from "../shared.ts";
import { installShutdown } from "../shutdown.ts";
import { parseEnv } from "../../server/env.ts";
import { DASH_MIN_PASSWORD, DEFAULT_RELAY_PORT } from "../../ui/constants.ts";
import { loadUiPackage } from "../ui-package.ts";

/** The port the dashboard listens on unless `--port` says otherwise. */
const DEFAULT_DASHBOARD_PORT = 3100;

/** The variable the password is read from (Supabase's self-hosted name). */
const PASSWORD_ENV = "DASHBOARD_PASSWORD";

/** The variable naming the stack's log relay. */
const LOGS_URL_ENV = "DASHBOARD_LOGS_URL";

/** The variable naming the running app (realtime, functions and health read it). */
const APP_URL_ENV = "DASHBOARD_APP_URL";

/** An environment variable, or `undefined` (unset, empty, or no permission). */
function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The dashboard password: the environment's `DASHBOARD_PASSWORD`, else the project's `.env`'s.
 *
 * @param dir The project.
 * @returns The password, or `null` when neither sets one.
 */
export async function dashboardPassword(dir: string): Promise<string | null> {
  const fromEnv = env(PASSWORD_ENV);
  if (fromEnv) return fromEnv;
  try {
    return parseEnv(await Deno.readTextFile(join(dir, ".env")))[PASSWORD_ENV] || null;
  } catch {
    return null;
  }
}

/** A port flag, or `fallback`. */
function portFlag(ctx: CommandContext, fallback: number): number {
  const raw = ctx.flags.port;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < 65536
    ? raw
    : fallback;
}

/** The `--host` to bind (loopback unless one is given). */
function hostFlag(ctx: CommandContext): string {
  return typeof ctx.flags.host === "string" && ctx.flags.host !== "" ? ctx.flags.host : "127.0.0.1";
}

/** The dashboard's banner. */
function banner(url: string, dir: string, hostname: string, locked: boolean): string {
  return `\n  denext dashboard  ▸  ${dir}\n  ${url}\n` +
    (hostname === "127.0.0.1"
      ? ""
      : `  bound to ${hostname} — keep it behind a firewall or a TLS proxy\n`) +
    (locked
      ? `  LOCKED: set ${PASSWORD_ENV} (${DASH_MIN_PASSWORD}+ characters) with ` +
        "`denext stack passwd --dashboard`\n"
      : `  Sign in with ${PASSWORD_ENV}. Ctrl+C to stop.\n`);
}

export const dashboardCommand: CommandSpec = {
  name: "dashboard",
  summary: "Serve the stack's database dashboard behind DASHBOARD_PASSWORD (loopback by default)",
  usage: "  denext dashboard                  Serve it on 127.0.0.1:3100\n" +
    "  denext dashboard --read-only      Browse without offering any write\n" +
    "  denext dashboard --host 0.0.0.0 --origin https://dash.example.com\n" +
    "                                    Behind a TLS reverse proxy at that origin\n\n" +
    "  The password comes from DASHBOARD_PASSWORD (the environment, else the project's .env),\n" +
    "  never from an argument. Sign-ins are rate limited; the session cookie is HttpOnly and\n" +
    "  SameSite=Strict (__Host- and Secure over https); every change needs a same-origin\n" +
    "  request and a CSRF token. A plain-http --origin off this machine is refused.",
  loadsModules: false,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [
    {
      name: "port",
      type: "number",
      valueName: "<port>",
      help: `Port to listen on (default ${DEFAULT_DASHBOARD_PORT})`,
    },
    {
      name: "host",
      type: "string",
      valueName: "<address>",
      help: "Address to bind (default 127.0.0.1; the stack's container binds 0.0.0.0)",
    },
    {
      name: "origin",
      type: "string",
      valueName: "<url>",
      repeatable: true,
      help: "A public origin it is also reached at, behind a reverse proxy (repeatable)",
    },
    { name: "read-only", type: "boolean", help: "Refuse every change" },
  ],
  run: async (ctx) => {
    const dir = projectDir(ctx);
    const controller = new AbortController();
    installShutdown(controller);
    const password = await dashboardPassword(dir);
    const hostname = hostFlag(ctx);
    const origins = typeof ctx.flags.origin === "string"
      ? ctx.flags.origin.split(",").map((o) => o.trim()).filter(Boolean)
      : [];
    const logsUrl = env(LOGS_URL_ENV);
    const appUrl = env(APP_URL_ENV);
    const { relayToken, secretKey, startUiServer } = await loadUiPackage("denext dashboard");
    const server = await startUiServer({
      dir,
      port: portFlag(ctx, DEFAULT_DASHBOARD_PORT),
      strictPort: true,
      hostname,
      readOnly: ctx.flags["read-only"] === true,
      dashboard: { password, origins },
      ...(logsUrl && password ? { logs: { url: logsUrl, token: await relayToken(password) } } : {}),
      ...(appUrl ? { app: { url: appUrl, key: await secretKey(dir) } } : {}),
      signal: controller.signal,
    });
    const locked = password === null || password.length < DASH_MIN_PASSWORD;
    if (ctx.global.json) {
      console.log(JSON.stringify({ url: server.url, port: server.port, locked }));
    } else if (!ctx.global.quiet) console.log(banner(server.url, dir, hostname, locked));
    await server.finished;
  },
};

export const dashboardLogsCommand: CommandSpec = {
  name: "dashboard-logs",
  summary: "The stack's log relay for the dashboard (reads the Docker socket)",
  hidden: true,
  usage: "denext dashboard-logs [--host 0.0.0.0] [--port 3101] [--socket /var/run/docker.sock]",
  loadsModules: false,
  flags: [
    { name: "port", type: "number", valueName: "<port>", help: "Port to listen on" },
    { name: "host", type: "string", valueName: "<address>", help: "Address to bind" },
    { name: "socket", type: "string", valueName: "<path>", help: "The Docker socket" },
  ],
  run: async (ctx) => {
    const controller = new AbortController();
    installShutdown(controller);
    const password = env(PASSWORD_ENV);
    const usable = password !== undefined && password.length >= DASH_MIN_PASSWORD;
    const socket = typeof ctx.flags.socket === "string" && ctx.flags.socket
      ? ctx.flags.socket
      : "/var/run/docker.sock";
    const { relayToken, socketGet, startLogsRelay } = await loadUiPackage("denext dashboard-logs");
    const relay = startLogsRelay({
      hostname: hostFlag(ctx),
      port: portFlag(ctx, DEFAULT_RELAY_PORT),
      token: usable ? await relayToken(password) : null,
      engine: socketGet(socket),
      self: env("HOSTNAME") ?? "",
      signal: controller.signal,
    });
    if (!ctx.global.quiet) {
      console.log(
        `denext dashboard-logs on port ${relay.port}` +
          (usable ? "" : ` (locked: ${PASSWORD_ENV} is not set)`),
      );
    }
    await relay.finished;
  },
};
