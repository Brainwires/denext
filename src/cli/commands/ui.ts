// `denext ui` — the project-management GUI, served on loopback by the CLI (the `vue ui` model).
//
// It ships inside the package, works on a fresh clone, and never evaluates the project's own
// modules: every piece of work it does — including discovering the verbs the project
// contributes, which is `denext commands --json` in a child — goes out as a `deno` subprocess
// (`src/ui/proc.ts`), so the verb is `loadsModules: false` and neither the bundler nor the
// user's config ever enters this process's module graph.
//
// The server is stopped through an AbortController (SIGINT/SIGTERM, or a test's own signal) —
// this verb never calls `Deno.exit` from inside the running server, so a caller driving `run`
// directly gets a clean resolution instead of a torn-down process.

import type { CommandContext, CommandSpec } from "../command.ts";
import { installShutdown, projectDir } from "../shared.ts";
import { openBrowser } from "../../ui/open.ts";
import {
  DEFAULT_UI_PORT,
  startUiServer,
  type UiServer,
  type UiServerOptions,
} from "../../ui/server.ts";

/**
 * The servers this verb currently has running. `run` resolves only when its server drains, so a
 * caller that drives it directly — a test, or an embedder that is not a terminal — needs a
 * handle to stop one without signalling the whole process.
 */
export const activeUiServers = new Set<UiServer>();

/**
 * The human banner (suppressed by `--json` and `--quiet`).
 *
 * @param url The handshake URL the server is serving.
 * @param dir The project directory.
 * @param modes `--read-only` and `--offline`, each announced on its own line when on.
 * @returns The banner text, ready for `console.log`.
 */
export function uiBanner(
  url: string,
  dir: string,
  modes: { readonly readOnly: boolean; readonly offline: boolean },
): string {
  return `\n  denext ui  ▸  ${dir}\n` +
    `  ${url}\n` +
    (modes.readOnly ? "  read-only — every change is refused\n" : "") +
    (modes.offline
      ? "  offline — nothing the UI starts reaches the network; deno task, denext dev and\n" +
        "  plugin add/remove are refused\n"
      : "") +
    "  The link carries a single-use token; it is exchanged for a session cookie and then\n" +
    "  refused, so the URL in your shell history is not a second way in.\n" +
    `  Ctrl+C to stop.\n`;
}

/**
 * The port `--port` asked for, or `undefined` when the flag was not given. An explicit port is
 * a requirement, not a hint: the caller gets {@linkcode DEFAULT_UI_PORT} with a bounded
 * fall-forward, and an explicit one fails loudly when it is taken.
 */
function uiPort(ctx: CommandContext): number | undefined {
  const raw = ctx.flags.port;
  const ok = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < 65536;
  return ok ? raw as number : undefined;
}

/**
 * The {@linkcode startUiServer} options a parsed `denext ui` invocation asks for — `--offline`
 * among them, which keeps the UI and every process it starts off the network (it combines freely
 * with `--read-only`).
 *
 * @param ctx The parsed command line.
 * @param signal The shutdown signal (SIGINT/SIGTERM, or a test's own).
 * @returns The options to start the server with.
 */
export function uiServerOptions(ctx: CommandContext, signal: AbortSignal): UiServerOptions {
  const port = uiPort(ctx);
  return {
    dir: projectDir(ctx),
    port: port ?? DEFAULT_UI_PORT,
    strictPort: port !== undefined,
    token: typeof ctx.flags.token === "string" ? ctx.flags.token : undefined,
    readOnly: ctx.flags["read-only"] === true,
    offline: ctx.flags.offline === true,
    uiDev: ctx.flags["ui-dev"] === true,
    signal,
  };
}

export const uiCommand: CommandSpec = {
  name: "ui",
  summary: "Open the project management UI in a browser (loopback only)",
  usage: "  denext ui                    Serve the UI for the current project and open it\n" +
    "  denext ui ./my-app --port 6000   That exact port, or a clear error if it is taken\n" +
    "  denext ui --read-only        Browse without offering any write\n" +
    "  denext ui --offline          Keep the UI and every process it starts off the network\n" +
    "  denext ui --no-open --json   Print { url, port, token } and keep serving\n\n" +
    "  The UI binds and is opened at 127.0.0.1 only (never localhost, whose cookies every\n" +
    "  local server shares). The printed URL carries a per-launch 256-bit token that is\n" +
    "  exchanged ONCE for an HttpOnly, SameSite=Strict cookie holding a separate, freshly\n" +
    "  minted secret — the query token is then refused, so a copied link cannot open a\n" +
    "  second session. Every mutation additionally needs a same-origin Origin and a CSRF\n" +
    "  token derived from the cookie.\n" +
    "  Note: with --open, the token is visible in the browser-launcher's argv on this machine.",
  loadsModules: false,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [
    {
      name: "port",
      type: "number",
      valueName: "<port>",
      help: `Port to listen on (default ${DEFAULT_UI_PORT}, which falls forward when busy; an ` +
        "explicit --port is required exactly, and 0 picks a free one)",
    },
    { name: "no-open", type: "boolean", help: "Don't launch a browser" },
    { name: "read-only", type: "boolean", help: "Refuse every mutation" },
    {
      name: "offline",
      type: "boolean",
      help: "Never reach the network: no JSR search; denext verbs and doctor run with " +
        "--deny-net --cached-only, deno install with --cached-only; deno task, denext dev and " +
        "plugin add/remove are refused (combines with --read-only)",
    },
    {
      name: "token",
      type: "string",
      valueName: "<token>",
      help: "Use this session token instead of minting one (at least 22 characters)",
    },
    {
      name: "ui-dev",
      type: "boolean",
      help: "Internal: watch src/ui and reload open pages on change",
    },
  ],
  run: async (ctx) => {
    const controller = new AbortController();
    const options = uiServerOptions(ctx, controller.signal);
    installShutdown(controller);
    const server = await startUiServer(options);
    activeUiServers.add(server);
    if (ctx.global.json) {
      console.log(JSON.stringify({ url: server.url, port: server.port, token: server.token }));
    } else if (!ctx.global.quiet) {
      console.log(uiBanner(server.url, options.dir, {
        readOnly: options.readOnly === true,
        offline: options.offline === true,
      }));
    }
    if (ctx.flags["no-open"] !== true && !(await openBrowser(server.url))) {
      console.log(`  Couldn't launch a browser — open ${server.url} yourself.`);
    }
    try {
      await server.finished;
    } finally {
      activeUiServers.delete(server);
    }
  },
};
