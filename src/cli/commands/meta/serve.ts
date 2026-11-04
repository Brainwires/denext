// The help text of `denext dev`, `denext build`, `denext export` and `denext start` (the verb's
// summary, usage, flags and positionals: what `--help`, `denext --help`, shell completions and the
// CLI reference print), implemented in ../serve.ts. Edit it here, then run `deno task
// gen:command-table` (or `deno task regen`). Not published: scripts/gen-command-table.ts packs it
// into src/cli/command-meta.packed.ts, and the verb's spec reads it back with
// `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import { RAW_DIAGNOSTICS_ENV } from "../../../build/explain/mod.ts";
import type { FlagSpec } from "../../command.ts";
import { COMPILE_TARGETS } from "../../../build/compile-app.ts";
import { SERVE_FLAGS } from "../start-options.ts";

/** The `--raw` flag of the verbs that explain diagnostics. */
export const RAW_FLAG: FlagSpec = {
  name: "raw",
  type: "boolean",
  help:
    `Print diagnostics exactly as Deno reports them, without explanations (also ${RAW_DIAGNOSTICS_ENV}=1)`,
};

/** `denext dev`. */
export const devMeta: CommandMeta = {
  name: "dev",
  summary: "Start the dev server",
  loadsModules: true,
  flags: [
    ...SERVE_FLAGS,
    {
      name: "lan",
      type: "boolean",
      help: "Bind the machine's LAN IPv4, allow it, and print its URL as a QR code",
    },
    {
      name: "allowed-dev-origin",
      type: "string",
      repeatable: true,
      valueName: "<origin>",
      help: "Also let this origin or host load the dev assets (repeatable, or comma-separated)",
    },
    RAW_FLAG,
  ],
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  usage: "Without --port, an open port is auto-selected starting at 3000.\n" +
    "With --port, that exact port is required and the server errors if it is taken.\n" +
    "The dev assets (/_denext/*) answer only loopback hosts plus allowedDevOrigins. An\n" +
    "explicit --host allows the host it binds (0.0.0.0: this machine's addresses); --lan\n" +
    "binds the LAN IPv4 alone (not localhost), allows it and prints a QR code for a phone;\n" +
    "--allowed-dev-origin adds entries to the config's allowedDevOrigins for this run.\n" +
    "A non-loopback bind (--lan, --host) prints its URL with a session token\n" +
    "(?__denext_dev=…): other machines need it for every request; this one does not.",
};

/** `denext build`. */
export const buildMeta: CommandMeta = {
  name: "build",
  envTier: "production",
  summary: "Build for production",
  loadsModules: true,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [
    RAW_FLAG,
    {
      name: "compile",
      type: "boolean",
      help: "Also compile the app's server into one executable (deno compile on the toolchain)",
    },
    {
      name: "target",
      type: "string",
      valueName: "<triple>",
      help: `With --compile: the target (${COMPILE_TARGETS.join(", ")}; default: this machine)`,
    },
    {
      name: "output",
      alias: "o",
      type: "string",
      valueName: "<path>",
      help: "With --compile: the executable's path (default: dist/<name>)",
    },
    {
      name: "sign",
      type: "boolean",
      help: "With --compile: code-sign the executable (codesign + notarytool for macOS, " +
        "signtool / osslsigncode for Windows; credentials from DENEXT_* env)",
    },
  ],
  usage: "Writes .denext/deploy-manifest.json and runs denext.config's deploy.adapter (its\n" +
    "prepare) after the build: https://denext.dev/docs/deploy#deploy-adapters\n\n" +
    "--compile builds, then embeds the build, public/, the server modules, jobs/, services/ and the\n" +
    "migrations into one executable that serves the app as `denext start` does (`./app`,\n" +
    "`./app job <name>`, `./app db migrate`). It bakes the Docker image's least-privilege\n" +
    "--allow-* plus denext.config's compile.permissions, and embeds no .env file: the binary\n" +
    "reads its environment at run time. --sign (or compile.sign) code-signs it, and notarizes a\n" +
    "macOS binary when notary credentials are set. Docs: https://denext.dev/docs/deployment-targets",
};

/** `denext export`. */
export const exportMeta: CommandMeta = {
  name: "export",
  envTier: "production",
  summary: "Static export (SSG) to out/",
  loadsModules: true,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [{
    name: "sourcemaps",
    type: "string",
    valueName: "hidden",
    help: "hidden: build source maps, keep them out of out/ (moved to .denext/sourcemaps for a " +
      "crash reporter's upload; also DENEXT_SOURCEMAPS=hidden)",
  }, {
    name: "platform",
    type: "string",
    valueName: "<target>",
    help: "The target whose platform files (Button.ios.tsx, .android, .mobile, .macos/.windows/" +
      ".linux, .desktop, .web) the export resolves: web (default), ios, android, macos, windows, " +
      "linux (also DENEXT_PLATFORM)",
  }],
};

/** `denext start`. */
export const startMeta: CommandMeta = {
  name: "start",
  envTier: "production",
  summary: "Serve a production build",
  loadsModules: true,
  flags: SERVE_FLAGS,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
};
