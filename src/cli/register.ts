// Assemble the first-party command registry. Kept separate from `cli.ts` (the
// entrypoint that owns argv, env, and re-exec) so the set of verbs is one list —
// and so plugin-contributed commands can later be appended here through the plugin
// contract's `addCommand` seam.

import { CommandRegistry } from "./command.ts";
import {
  buildCommand,
  devCommand,
  exportCommand,
  probeCommand,
  startCommand,
} from "./commands/serve.ts";
import { codemodCommand, migrateCommand } from "./commands/migrate.ts";
import { createCommand, initCommand } from "./commands/create.ts";

/** Build a registry with every first-party denext verb registered. */
export function buildRegistry(): CommandRegistry {
  const reg = new CommandRegistry();
  reg.register(devCommand);
  reg.register(buildCommand);
  reg.register(exportCommand);
  reg.register(startCommand);
  reg.register(probeCommand);
  reg.register(migrateCommand);
  reg.register(codemodCommand);
  reg.register(createCommand);
  reg.register(initCommand);
  return reg;
}
