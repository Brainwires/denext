// The help text of `denext job` (the verb's summary, usage, flags and positionals: what `--help`,
// `denext --help`, shell completions and the CLI reference print), implemented in ../job.ts. Edit
// it here, then run `deno task gen:command-table` (or `deno task regen`). Not published:
// scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the verb's spec
// reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext job`. */
export const jobMeta: CommandMeta = {
  name: "job",
  summary: "Run a background job by name, list them (--list), or install them in the OS scheduler",
  loadsModules: true,
  flags: [
    { name: "list", alias: "l", type: "boolean", help: "List the app's jobs and exit" },
    {
      name: "history",
      type: "boolean",
      help: "Print the run history (jobs.history) through its configured store",
    },
    {
      name: "clear-history",
      type: "boolean",
      help: "Delete every recorded run through the configured history store",
    },
    {
      name: "read-only",
      type: "boolean",
      help: "With --history: read without changing anything; refuses --clear-history",
    },
    {
      name: "payload",
      type: "string",
      valueName: "<json>",
      help: "JSON passed to the job's ctx.payload",
    },
    {
      name: "if-due",
      type: "string",
      valueName: "<cron;cron…>",
      help: "Run only when this UTC minute matches one of the expressions, else exit 0 " +
        "(what installed entries pass where local time has DST)",
    },
    {
      name: "dry-run",
      type: "boolean",
      help: "install: print the files and scheduler commands; change nothing",
    },
    {
      name: "uninstall",
      type: "boolean",
      help: "install: remove this project's entries (all, or the named jobs')",
    },
    {
      name: "user",
      type: "boolean",
      help: "install: the user's scheduler (default): LaunchAgents, systemd --user / crontab, " +
        "a task that runs while logged on",
    },
    {
      name: "system",
      type: "boolean",
      help: "install: the machine's scheduler (LaunchDaemons, /etc/systemd/system, a task " +
        "that runs logged off), still as the installing user; needs root / admin",
    },
  ],
  positionals: [{
    name: "name",
    help: "Job name (its path under jobs/, e.g. cleanup), or `install` followed by job names",
  }],
  usage: "denext job <name> [--payload '<json>']\ndenext job --list [--json]\n" +
    "denext job --history [--read-only] [--json]\ndenext job --clear-history [--json]\n" +
    "denext job install [<name>...] [--dry-run] [--uninstall] [--user | --system] [--json]\n" +
    "  Installs the scheduled jobs (each job's `schedule` + config scheduledJobs) as OS\n" +
    "  scheduler entries that run `denext job <name>` in this directory: launchd on macOS,\n" +
    "  systemd timers on Linux (crontab without a systemd user manager), Task Scheduler on\n" +
    "  Windows. Schedules stay UTC; a re-install replaces this project's entries.",
};
