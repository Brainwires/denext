// The help text of `denext migrate` and `denext codemod` (the verb's summary, usage, flags and
// positionals: what `--help`, `denext --help`, shell completions and the CLI reference print),
// implemented in ../migrate.ts. Edit it here, then run `deno task gen:command-table` (or `deno task
// regen`). Not published: scripts/gen-command-table.ts packs it into
// src/cli/command-meta.packed.ts, and the verb's spec reads it back with `...commandMeta("<verb>")`
// (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";

/** `denext migrate`. */
export const migrateMeta: CommandMeta = {
  name: "migrate",
  summary:
    "Migrate a Next.js, Remix, React Router, TanStack Start, Vite, CRA, Expo, Fresh, Preact, " +
    "Lustre or React app (config files)",
  positionals: [{ name: "dir", help: "App directory to migrate (default: .)" }],
  flags: [
    {
      name: "from",
      type: "string",
      valueName: "<framework>",
      help: "Force source: next | remix | react-router | vite | cra | generic | expo | " +
        "tanstack-start | fresh | preact | lustre",
    },
    {
      name: "check",
      type: "boolean",
      help: "Report what migrate would change and what won't migrate; writes nothing " +
        "(needs read access, plus --allow-run to evaluate next.config; add --json for the " +
        "machine-readable report)",
    },
    { name: "desktop", type: "boolean", help: "Also scaffold a desktop entry" },
    {
      name: "enable-capacitor",
      type: "boolean",
      help: "Also add an iOS/Android Capacitor target: capacitor.config.ts, the mobile:* tasks " +
        "and config keys, and install the pinned Capacitor 8 packages (SPA, App Router, Expo). " +
        "The install, `denext export` and `npx cap add` run the project's own code, so they " +
        "run only with --yes or after a prompt; otherwise migrate prints them to run yourself",
    },
    {
      name: "app-id",
      type: "string",
      valueName: "<id>",
      help: "With --enable-capacitor: the app id (reverse-DNS, e.g. com.example.app); else " +
        "derived from the desktop identifier or the package name",
    },
    {
      name: "platform",
      type: "string",
      valueName: "<ios,android>",
      help: "With --enable-capacitor: export, then run `npx cap add` for these platforms",
    },
    {
      name: "backend",
      type: "string",
      valueName: "<url>",
      help: "Backend URL for SPA proxy",
    },
    {
      name: "proxy",
      type: "string",
      valueName: "<paths>",
      help: "Comma-separated proxy prefixes",
    },
    {
      name: "codemod",
      type: "boolean",
      help: "Also rewrite source imports to native denext",
    },
    {
      name: "yes",
      alias: "y",
      type: "boolean",
      help: "Answer yes to migrate's prompts: apply the codemod, and run --enable-capacitor's " +
        "install, export and `cap add` (they run the project's own code: trusted projects only)",
    },
    {
      name: "prisma-adapter",
      type: "string",
      valueName: "<auto|deno-sql|npm>",
      help: "A Prisma app's SQLite / Postgres driver adapter: deno-sql (denext/prisma-adapter " +
        "over Deno.SQL, no npm driver), npm (@prisma/adapter-better-sqlite3 / -pg), or auto " +
        "(deno-sql when the runtime supports it; the default)",
    },
    {
      name: "denext-local-path",
      type: "string",
      valueName: "<path>",
      help: "Point the generated config at a LOCAL denext checkout (file://) instead of JSR — " +
        "for testing an unreleased/dev denext against a real app",
    },
  ],
};

/** `denext codemod`. */
export const codemodMeta: CommandMeta = {
  name: "codemod",
  summary: "(advanced) Rewrite next/*+react imports to native denext",
  positionals: [{ name: "dir", help: "App directory (default: .)" }],
  flags: [{
    name: "write",
    type: "boolean",
    help: "Apply without prompting (CI)",
  }],
};
