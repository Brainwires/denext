// Assemble the first-party command registry. Kept separate from `cli.ts` (the
// entrypoint that owns argv, env, and re-exec) so the set of verbs is one list —
// and so plugin-contributed commands can later be appended here through the plugin
// contract's `addCommand` seam.

import { CommandRegistry } from "./command.ts";
import { buildCommand, devCommand, exportCommand, startCommand } from "./commands/serve.ts";
import { codemodCommand, migrateCommand } from "./commands/migrate.ts";
import { createCommand, initCommand } from "./commands/create.ts";
import { checkCommand, fmtCommand, lintCommand, testCommand } from "./commands/toolchain.ts";
import { doctorCommand, infoCommand } from "./commands/doctor.ts";
import { addCommand, removeCommand, updateCommand } from "./commands/deps.ts";
import { auditCommand } from "./commands/audit.ts";

/** Build a registry with every first-party denext verb registered. */
export function buildRegistry(): CommandRegistry {
  const reg = new CommandRegistry();
  // Serve + build lifecycle.
  reg.register(devCommand);
  reg.register(buildCommand);
  reg.register(exportCommand);
  reg.register(startCommand);
  // Toolchain (deno passthrough).
  reg.register(testCommand);
  reg.register(lintCommand);
  reg.register(fmtCommand);
  reg.register(checkCommand);
  // Dependencies.
  reg.register(addCommand);
  reg.register(removeCommand);
  reg.register(updateCommand);
  // Diagnostics + supply chain.
  reg.register(doctorCommand);
  reg.register(infoCommand);
  reg.register(auditCommand);
  // Migration + scaffolding.
  reg.register(migrateCommand);
  reg.register(codemodCommand);
  reg.register(createCommand);
  reg.register(initCommand);
  return reg;
}
