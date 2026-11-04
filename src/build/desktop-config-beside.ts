// The project config a scaffolded `scripts/package-*.ts` reads, beside its `scripts/` folder: the
// first of the loader's config names that exists (`denext.config.ts`, `.mts`, `.js`, `.mjs`), as
// `denext export` resolves it. Every packaging step (the baked `--allow-*` flags, the embedded
// extensions, `app.json`, `laufey-launch.json`, the installers, the signing setup) reads the same
// config through it, so none of them packages the app without its `desktop` block while another
// one reads it. A project without a config gets `undefined` (the defaults); a config that fails to
// load fails the run instead of being taken for an absent one.

import { fromFileUrl, join } from "@std/path";
import { CONFIG_FILES } from "./config-files.ts";

/** Whether a module failed to load because the file itself is missing (only then is it absent). */
function isMissingModule(err: unknown): boolean {
  return err instanceof Error && /Module not found|Cannot find module/i.test(err.message);
}

/**
 * The project's `denext.config.*` default export, for the script at `entryUrl` (the project is its
 * parent's parent: `scripts/package-linux.ts` → `./`).
 *
 * @param entryUrl `import.meta.url` of a script in the project's `scripts/` folder.
 * @returns The config, or `undefined` when the project has none (or it exports none).
 * @throws {Error} When a config exists but fails to load.
 */
export async function loadConfigBeside(entryUrl: string): Promise<unknown> {
  const root = new URL("../", entryUrl);
  let name = CONFIG_FILES[0];
  if (root.protocol === "file:") {
    const dir = fromFileUrl(root);
    const found = await firstExisting(dir);
    if (found === undefined) return undefined;
    name = found;
  }
  try {
    const mod = await import(new URL(name, root).href);
    return (mod as { default?: unknown }).default;
  } catch (err) {
    if (root.protocol !== "file:" && isMissingModule(err)) return undefined;
    throw err;
  }
}

/** The first config file name in `dir`, in the loader's order, or `undefined`. */
async function firstExisting(dir: string): Promise<string | undefined> {
  for (const name of CONFIG_FILES) {
    const info = await Deno.stat(join(dir, name)).catch(() => null);
    if (info?.isFile) return name;
  }
  return undefined;
}
