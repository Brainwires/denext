// Assemble the first-party command registry. Kept separate from `cli.ts` (the
// entrypoint that owns argv, env, and re-exec) so the set of verbs is one list —
// and so plugin-contributed commands can later be appended here through the plugin
// contract's `addCommand` seam.

import { CommandRegistry } from "./command.ts";
import { buildCommand, devCommand, exportCommand, startCommand } from "./commands/serve.ts";
import { codemodCommand, migrateCommand } from "./commands/migrate.ts";
import { createCommand, initCommand } from "./commands/create.ts";
import { generateCommand } from "./commands/generate.ts";
import { fallowCommand } from "./commands/fallow.ts";
import { taskCommand } from "./commands/task.ts";
import { jobCommand } from "./commands/job.ts";
import { routesCommand } from "./commands/routes.ts";
import { checkCommand, fmtCommand, lintCommand, testCommand } from "./commands/toolchain.ts";
import { doctorCommand, infoCommand } from "./commands/doctor.ts";
import { addCommand, removeCommand, updateCommand } from "./commands/deps.ts";
import { upgradeCommand } from "./commands/upgrade.ts";
import { denoCommand, toolchainCommand } from "./commands/deno-toolchain.ts";
import { auditCommand } from "./commands/audit.ts";
import { analyzeCommand } from "./commands/analyze.ts";
import { profileCommand } from "./commands/profile.ts";
import { desktopCommand } from "./commands/desktop.ts";
import { mobileCommand, otaCommand } from "./commands/mobile.ts";
import { pluginCommand } from "./commands/plugin.ts";
import { patchCommand } from "./commands/patch.ts";
import { mcpCommand } from "./commands/mcp.ts";
import { uiCommand } from "./commands/ui.ts";
import { dbAdminCommand } from "./commands/db-admin.ts";
import { dbCommand } from "./commands/db.ts";
import { migrationCommand } from "./commands/migration.ts";
import { makeCompletionsCommand } from "./commands/completions.ts";
import { makeCommandsCommand } from "./commands/commands.ts";

/** Build a registry with every first-party denext verb registered. */
export function buildRegistry(): CommandRegistry {
  const reg = new CommandRegistry();
  // Serve + build lifecycle.
  reg.register(devCommand);
  reg.register(buildCommand);
  reg.register(exportCommand);
  reg.register(startCommand);
  reg.register(jobCommand);
  reg.register(routesCommand);
  // Toolchain (deno passthrough). `task` is Deno's `deno task`.
  reg.register(taskCommand);
  reg.register(testCommand);
  reg.register(lintCommand);
  reg.register(fmtCommand);
  reg.register(checkCommand);
  // denext's managed Deno toolchain, and running it directly.
  reg.register(toolchainCommand);
  reg.register(denoCommand);
  // Dependencies.
  reg.register(addCommand);
  reg.register(removeCommand);
  reg.register(updateCommand);
  reg.register(upgradeCommand);
  // Diagnostics + supply chain.
  reg.register(doctorCommand);
  reg.register(infoCommand);
  reg.register(auditCommand);
  reg.register(analyzeCommand);
  reg.register(profileCommand);
  // Migration + scaffolding.
  reg.register(migrateCommand);
  reg.register(codemodCommand);
  reg.register(createCommand);
  reg.register(initCommand);
  reg.register(generateCommand);
  reg.register(fallowCommand);
  // The database: migrations (Postgres or SQLite) and the Supabase CLI's `db` verbs.
  reg.register(migrationCommand);
  reg.register(dbCommand);
  // Desktop packaging.
  reg.register(desktopCommand);
  // Capacitor mobile: over-the-air UI manifest + native plugin install.
  reg.register(mobileCommand);
  reg.register(otaCommand);
  reg.register(pluginCommand);
  reg.register(patchCommand);
  // Project management UI (loopback GUI).
  reg.register(uiCommand);
  // Its Database section's child process (hidden: a protocol, not a command to type).
  reg.register(dbAdminCommand);
  // AI-agent tooling (MCP server over stdio).
  reg.register(mcpCommand);
  // Both bound to the assembled registry, so they enumerate the real verb set: `commands`
  // merges the PROJECT's verbs into it (the one verb that imports the project's config), and
  // `completions` reads whatever the registry holds when it runs.
  reg.register(makeCommandsCommand(reg));
  reg.register(makeCompletionsCommand(reg));
  return reg;
}
