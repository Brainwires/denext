// `desktop.denoFlags` for the commands that run `deno desktop`: the scaffolded package scripts read
// them beside their own `import.meta.url` ({@linkcode desktopDenoFlagArgs}). A project with a
// package.json or node_modules (a pnpm workspace member included) needs none for npm resolution:
// `deno desktop` already gets `--node-modules-dir=none --exclude-unused-npm` from `desktopNpmArgs`.
// The allow-list itself is `src/desktop/deno-flags.ts`.

import { desktopDenoFlags } from "../desktop/deno-flags.ts";
import { loadConfigBeside } from "./desktop-installers.ts";

/**
 * The project's `desktop.denoFlags`, checked, for a scaffolded packaging script: reads
 * `denext.config.ts` next to `entryUrl`'s folder (a script in `scripts/` → `../`), like
 * `desktopPackageFlags`. A project without a config gets `[]`; a refused flag throws.
 *
 * @param entryUrl The packaging script's `import.meta.url`.
 * @returns The flags, ready to splice into the `deno desktop` argv before the entry.
 */
export async function desktopDenoFlagArgs(entryUrl: string): Promise<string[]> {
  // No denext.config.ts (or it exports no config): no extra flags.
  return desktopDenoFlags(await loadConfigBeside(entryUrl));
}
