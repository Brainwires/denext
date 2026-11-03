// The help text of `denext ui` (the verb's summary, usage, flags and positionals: what `--help`,
// `denext --help`, shell completions and the CLI reference print), implemented in ../ui.ts. Edit it
// here, then run `deno task gen:command-table` (or `deno task regen`). Not published:
// scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the verb's spec
// reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import { DEFAULT_UI_PORT } from "../../../ui/server.ts";

/** `denext ui`. */
export const uiMeta: CommandMeta = {
  name: "ui",
  summary: "Open the project management UI in a browser (loopback only)",
  usage: "  denext ui                    Serve the UI for the current project and open it\n" +
    "  denext ui ./my-app --port 6000   That exact port, or a clear error if it is taken\n" +
    "  denext ui --read-only        Browse without offering any write\n" +
    "  denext ui --offline          Keep the UI and the processes it starts off the network\n" +
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
};
