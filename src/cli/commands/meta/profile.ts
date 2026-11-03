// The help text of `denext profile` (the verb's summary, usage, flags and positionals: what
// `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../profile.ts. Edit it here, then run `deno task gen:command-table` (or `deno task regen`). Not
// published: scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the
// verb's spec reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext profile`. */
export const profileMeta: CommandMeta = {
  name: "profile",
  summary: "Profile CPU self-time + heap for a route (with an optional budget gate)",
  loadsModules: true,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [
    { name: "route", type: "string", valueName: "<path>", default: "/", help: "Route to profile" },
    {
      name: "interact",
      type: "string",
      valueName: "<file>",
      help: "JS file evaluated in the page to exercise it each iteration",
    },
    { name: "iterations", type: "number", default: 1, help: "Repeat the interaction N times" },
    { name: "sampling", type: "number", default: 100, help: "CPU sampling interval (µs)" },
    { name: "top", type: "number", default: 20, help: "Max self-time rows to show" },
    {
      name: "budget",
      type: "string",
      valueName: "<file>",
      help: "Fail (exit 1) if the run exceeds this recorded budget",
    },
    {
      name: "write-budget",
      type: "string",
      valueName: "<file>",
      help: "Write the current run as a baseline budget file",
    },
    { name: "minify", type: "boolean", help: "Profile a minified build (default: unminified)" },
    {
      name: "android",
      type: "boolean",
      help: "Profile the installed app's WebView on an Android device over adb (remote CDP)",
    },
    {
      name: "device",
      type: "string",
      valueName: "<serial>",
      help: "With --android: the adb serial, when several devices are attached",
    },
    {
      name: "package",
      type: "string",
      valueName: "<appId>",
      help: "With --android: the app whose WebView to profile (default: the Capacitor appId)",
    },
    {
      name: "filter",
      type: "string",
      valueName: "<text>",
      help: "Show only functions whose name or source contains this (a component, module, package)",
    },
    {
      name: "out",
      type: "string",
      valueName: "<file>",
      help: "Save the run as JSON (to --compare a later run against)",
    },
    {
      name: "compare",
      type: "string",
      valueName: "<file>",
      help: "Compare with a run saved by --out: CPU, heap and per-function deltas",
    },
  ],
};
