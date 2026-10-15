// The registry the `denext` entrypoint dispatches from: every first-party verb, described by
// `command-table.generated.ts` and loaded only when it runs (see lazy-command.ts). The eager
// `buildRegistry()` (register.ts) stays the source of truth the table is generated from.

import { CommandRegistry } from "./command.ts";
import { COMMAND_TABLE } from "./command-table.generated.ts";
import { lazyCommand } from "./lazy-command.ts";

/** Build a registry of every first-party verb whose implementations load on first use. */
export function buildLazyRegistry(): CommandRegistry {
  const reg = new CommandRegistry();
  for (const [meta, load] of COMMAND_TABLE) reg.register(lazyCommand(meta, load, reg));
  return reg;
}
