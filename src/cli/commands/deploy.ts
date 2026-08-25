// `denext deploy` — build the app, then hand it to a deploy adapter (Deno Deploy by
// default). The entrypoint is `--entry`, else auto-detected from the project root
// (main.ts/server.ts/serve.ts/…). `--dry-run` prints the plan without deploying;
// `--list` shows available providers. Real deployment needs the provider's own auth
// (e.g. `DENO_DEPLOY_TOKEN`) — denext never handles the token.

import { join } from "@std/path";
import type { CommandSpec } from "../command.ts";
import { projectDir, runBuildStep } from "../shared.ts";
import { build } from "../../build/build.ts";
import {
  detectEntrypoint,
  ENTRY_CANDIDATES,
  listAdapters,
  resolveAdapter,
} from "../../build/deploy.ts";

export const deployCommand: CommandSpec = {
  name: "deploy",
  summary: "Build and deploy the app (Deno Deploy by default)",
  loadsModules: true,
  passthrough: true, // forward extra provider flags
  usage: "  denext deploy --project my-app --prod\n" +
    "  denext deploy --entry server.ts --dry-run\n" +
    "  denext deploy --list",
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [
    { name: "provider", type: "string", valueName: "<name>", help: "Deploy provider" },
    { name: "project", type: "string", valueName: "<name>", help: "Provider project/site name" },
    { name: "entry", type: "string", valueName: "<file>", help: "Server entrypoint to deploy" },
    { name: "prod", type: "boolean", help: "Deploy to production (not a preview)" },
    { name: "skip-build", type: "boolean", help: "Deploy without rebuilding first" },
    { name: "dry-run", type: "boolean", help: "Print the plan without deploying" },
    { name: "list", type: "boolean", help: "List available deploy providers" },
  ],
  run: async (ctx) => {
    if (ctx.flags.list === true) {
      console.log("\n  Deploy providers:");
      for (const a of listAdapters()) console.log(`    ${a.name.padEnd(14)} ${a.summary}`);
      console.log("");
      return;
    }

    const dir = projectDir(ctx);
    const adapter = resolveAdapter(ctx.flags.provider as string | undefined);

    // Resolve the entrypoint before building, so a misconfig fails fast.
    const entry = (ctx.flags.entry as string | undefined) ?? await detectEntrypoint(dir);
    if (!entry) {
      console.error(
        `denext: no deploy entrypoint found in ${dir}.\n` +
          `  Looked for: ${ENTRY_CANDIDATES.join(", ")}.\n` +
          "  Pass --entry <file>, or add a server entry that serves the built app.\n" +
          "  (For a static site, `denext export` produces out/ for any static host.)",
      );
      Deno.exit(1);
    }
    try {
      await Deno.stat(join(dir, entry));
    } catch {
      console.error(`denext: deploy entrypoint not found: ${join(dir, entry)}`);
      Deno.exit(1);
    }

    console.log(`\n  denext deploy  ▸  ${dir}  (${adapter.name})\n`);
    if (ctx.flags["skip-build"] !== true) {
      console.log("  Building for production…");
      await runBuildStep(() => build(dir), "deploy build");
    }

    await adapter.deploy({
      projectDir: dir,
      entrypoint: entry,
      prod: ctx.flags.prod === true,
      project: ctx.flags.project as string | undefined,
      dryRun: ctx.flags["dry-run"] === true,
      args: ctx.rest,
    });
    console.log("");
  },
};
