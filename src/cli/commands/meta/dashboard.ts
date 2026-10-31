// The help text of `denext dashboard` and `denext dashboard-logs` (the verb's summary, usage, flags
// and positionals: what `--help`, `denext --help`, shell completions and the CLI reference print),
// implemented in ../dashboard.ts. Edit it here, then run `deno task gen:command-table` (or `deno
// task regen`). Not published: scripts/gen-command-table.ts packs it into
// src/cli/command-meta.packed.ts, and the verb's spec reads it back with `...commandMeta("<verb>")`
// (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import { DEFAULT_DASHBOARD_PORT } from "../dashboard.ts";

/** `denext dashboard`. */
export const dashboardMeta: CommandMeta = {
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
};

/** `denext dashboard-logs`. */
export const dashboardLogsMeta: CommandMeta = {
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
};
