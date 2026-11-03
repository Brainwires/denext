// The help text of `denext stack` (the verb's summary, usage, flags and positionals: what `--help`,
// `denext --help`, shell completions and the CLI reference print), implemented in ../stack.ts. Edit
// it here, then run `deno task gen:command-table` (or `deno task regen`). Not published:
// scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the verb's spec
// reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import { ACTION_NAMES } from "../stack.ts";
import { DOCKER_FLAGS } from "../generate-docker.ts";

/** `denext stack`. */
export const stackMeta: CommandMeta = {
  name: "stack",
  summary:
    "Start, stop, inspect and operate the local Docker stack (app, Postgres, MinIO), like supabase start",
  usage: [
    "Usage: denext stack <action> [flags]",
    "",
    "  up       Write the stack if missing (denext generate docker --stack, or your flags), fill",
    "           a missing .env with generated secrets, docker compose up -d --wait, then status",
    "           (--dev: the dev overlay; --build: rebuild the app image)",
    "  down     Stop it (--volumes also drops the database and storage data)",
    "  status   The API, REST, database and S3 URLs and the publishable key (--json;",
    "           --show-secrets adds the secret key and the passwords)",
    "  logs     docker compose logs [service] (--follow). Filters: --service <s> (repeatable),",
    "           --level debug|info|warn|error (that level and above), --since / --until",
    "           (2026-10-14T09:00:00Z or 30m), --grep <text> or --grep '/regex/i'",
    "  health   Each service's health check and the app's /_denext/health checks, as a table",
    "           (--json; --watch [seconds], default 5). Exits 1 when anything is unhealthy",
    "  passwd   New passwords: --postgres (the superuser from stdin or --generate, the app",
    "           role a fresh one; ALTER ROLE runs in the database first) and / or --dashboard",
    "           (DASHBOARD_PASSWORD). One password per line on stdin; never as an argument",
    "  roll     New publishable and secret keys; --include-secret also new JWT signing keys /",
    "           DENEXT_JWT_SECRET, which ends every issued token (confirm, or --yes).",
    "           --keep-old starts a rotation: the previous keys stay valid next to the new",
    "           ones (the legacy DENEXT_JWT_SECRET is left as it is); --drop-old finishes it",
    "  backup   [file] The database (pg_dump custom format, default under .denext/backups/);",
    "           --full: one .tar.gz with roles, extensions, the dump, settings, storage and a",
    "           MANIFEST.txt of the restore order",
    "  restore  <file> A dump or a full backup (detected); a database with tables needs --yes.",
    "           A full backup expands to at most --max-size (default: the free space where it",
    "           is extracted, minus a margin). Restore only a backup you trust: its SQL runs",
    "           as the database superuser",
    "",
    "passwd and roll edit .env in place, then --restart recreates the affected containers,",
    "--no-restart leaves them, and with neither a terminal is asked (else the command printed).",
    "--show-secrets prints the new secrets.",
  ].join("\n"),
  positionals: [
    { name: "action", help: ACTION_NAMES, required: true },
    {
      name: "target",
      help: "logs: a service; backup / restore: the file; health --watch: the seconds",
    },
  ],
  flags: [
    { name: "build", type: "boolean", help: "up: rebuild the app image" },
    { name: "volumes", type: "boolean", help: "down: remove the data volumes too" },
    { name: "follow", type: "boolean", help: "logs: keep following" },
    {
      name: "show-secrets",
      type: "boolean",
      help: "status / passwd / roll: print the secret key and passwords",
    },
    {
      name: "service",
      type: "string",
      repeatable: true,
      valueName: "<name>",
      help: "logs: only this service (repeatable)",
    },
    {
      name: "level",
      type: "string",
      valueName: "<level>",
      help: "logs: debug | info | warn | error and above",
    },
    { name: "since", type: "string", valueName: "<time>", help: "logs: from (timestamp or 30m)" },
    { name: "until", type: "string", valueName: "<time>", help: "logs: until (timestamp or 5m)" },
    {
      name: "grep",
      type: "string",
      valueName: "<text>",
      help: "logs: lines containing the text, or matching /regex/flags",
    },
    { name: "watch", type: "boolean", help: "health: repeat every [seconds] (default 5)" },
    {
      name: "dashboard",
      type: "boolean",
      help: "passwd: the dashboard password (DASHBOARD_PASSWORD); up: the dashboard service",
    },
    { name: "generate", type: "boolean", help: "passwd: generate strong passwords" },
    {
      name: "include-secret",
      type: "boolean",
      help: "roll: also the JWT signing keys / DENEXT_JWT_SECRET (ends every issued token)",
    },
    {
      name: "keep-old",
      type: "boolean",
      help: "roll: keep the previous keys valid next to the new ones (a rotation window)",
    },
    {
      name: "drop-old",
      type: "boolean",
      help: "roll: finish a rotation, keeping only the newest key of each kind",
    },
    { name: "restart", type: "boolean", help: "passwd / roll: restart the affected containers" },
    { name: "no-restart", type: "boolean", help: "passwd / roll: leave the containers running" },
    {
      name: "yes",
      type: "boolean",
      help: "roll --include-secret / restore: go ahead without asking",
    },
    { name: "full", type: "boolean", help: "backup: roles, settings, extensions and storage too" },
    {
      name: "max-size",
      type: "string",
      valueName: "<size>",
      help: "restore: the most a full backup may expand to, e.g. 20G (default: the free space " +
        "where it is extracted, minus a margin)",
    },
    {
      name: "storage-dir",
      type: "string",
      valueName: "<dir>",
      help: "backup / restore: the fs storage driver's dir in the app container",
    },
    // `--dashboard` is declared above (passwd's target, and up's docker switch alike).
    ...DOCKER_FLAGS.filter((f) => f.name !== "dashboard"),
  ],
};
