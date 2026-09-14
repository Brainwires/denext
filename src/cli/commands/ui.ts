// `denext ui` — the project-management GUI, served on loopback by the CLI (the `vue ui` model).
//
// It ships inside the package, works on a fresh clone, and never evaluates the project's own
// modules: every piece of work it does goes out as a `deno` subprocess (`src/ui/proc.ts`), so
// the verb is `loadsModules: false` and the bundler never enters its module graph.
//
// The server is stopped through an AbortController (SIGINT/SIGTERM, or a test's own signal) —
// this verb never calls `Deno.exit` from inside the running server, so a caller driving `run`
// directly gets a clean resolution instead of a torn-down process.

import type { CommandContext, CommandSpec } from "../command.ts";
import { installShutdown, projectDir } from "../shared.ts";
import { openBrowser } from "../../ui/open.ts";
import { DEFAULT_UI_PORT, startUiServer, type UiServer } from "../../ui/server.ts";

/**
 * The servers this verb currently has running. `run` resolves only when its server drains, so a
 * caller that drives it directly — a test, or an embedder that is not a terminal — needs a
 * handle to stop one without signalling the whole process.
 */
export const activeUiServers = new Set<UiServer>();

/** Print the human banner (suppressed by `--json` and `--quiet`). */
function banner(server: UiServer, dir: string, readOnly: boolean): void {
  console.log(
    `\n  denext ui  ▸  ${dir}\n` +
      `  ${server.url}\n` +
      (readOnly ? "  read-only — every change is refused\n" : "") +
      `  The link carries a one-time token; it is exchanged for a session cookie.\n` +
      `  Ctrl+C to stop.\n`,
  );
}

/** Resolve `--port`, defaulting to {@linkcode DEFAULT_UI_PORT}. */
function uiPort(ctx: CommandContext): number {
  const raw = ctx.flags.port;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_UI_PORT;
}

export const uiCommand: CommandSpec = {
  name: "ui",
  summary: "Open the project management UI in a browser (loopback only)",
  usage: "  denext ui                    Serve the UI for the current project and open it\n" +
    "  denext ui ./my-app --port 6000\n" +
    "  denext ui --read-only        Browse without offering any write\n" +
    "  denext ui --no-open --json   Print { url, port, token } and keep serving\n\n" +
    "  The UI binds 127.0.0.1 only. The printed URL carries a per-launch 256-bit token that\n" +
    "  is exchanged once for an HttpOnly, SameSite=Strict cookie; every mutation additionally\n" +
    "  needs a same-origin Origin and a derived CSRF token.",
  loadsModules: false,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [
    {
      name: "port",
      type: "number",
      default: DEFAULT_UI_PORT,
      valueName: "<port>",
      help: `Port to listen on (default ${DEFAULT_UI_PORT}; 0 picks a free one)`,
    },
    { name: "no-open", type: "boolean", help: "Don't launch a browser" },
    { name: "read-only", type: "boolean", help: "Refuse every mutation" },
    {
      name: "token",
      type: "string",
      valueName: "<token>",
      help: "Use this session token instead of minting one",
    },
    {
      name: "ui-dev",
      type: "boolean",
      help: "Internal: watch src/ui and reload open pages on change",
    },
  ],
  run: async (ctx) => {
    const dir = projectDir(ctx);
    const readOnly = ctx.flags["read-only"] === true;
    const controller = new AbortController();
    installShutdown(controller);
    const server = await startUiServer({
      dir,
      port: uiPort(ctx),
      token: typeof ctx.flags.token === "string" ? ctx.flags.token : undefined,
      readOnly,
      uiDev: ctx.flags["ui-dev"] === true,
      signal: controller.signal,
    });
    activeUiServers.add(server);
    if (ctx.global.json) {
      console.log(JSON.stringify({ url: server.url, port: server.port, token: server.token }));
    } else if (!ctx.global.quiet) {
      banner(server, dir, readOnly);
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
