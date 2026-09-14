// The project's `deno.json` as the UI sees it: the file's own bytes (so an edit can be spliced
// back comment-preservingly), the parsed document, and the task table.
//
// One reader for both callers: `routes.ts` asks "which task names may `/tasks/run` spawn?"
// (the names alone), while the wizard needs the file's path and text for the merge preview in
// step 3 and each task's command line for step 8. It lives here rather than in `routes.ts`
// because a feature module importing `routes.ts` would close an import cycle
// (`routes.ts` → `features/wizard.ts`). Nothing here evaluates project code: `deno.json` is
// *data*.

import { parse as parseJsonc } from "@std/jsonc";
import { join } from "@std/path";

/** The config file names probed, in precedence order. */
const NAMES = ["deno.json", "deno.jsonc"] as const;

/** A project's Deno configuration file, as read (never re-serialised). */
export interface DenoConfigFile {
  /** The file name that was found (`deno.json` or `deno.jsonc`). */
  readonly name: string;
  /** Its absolute path. */
  readonly path: string;
  /** The file's text, byte-for-byte. */
  readonly source: string;
  /** The parsed document, or `null` when the text is not a JSONC object. */
  readonly data: Record<string, unknown> | null;
}

/**
 * Read the project's `deno.json` / `deno.jsonc`.
 *
 * @param dir The project directory.
 * @returns The file (with its text and parsed form), or `null` when the project has neither.
 */
export async function readDenoConfig(dir: string): Promise<DenoConfigFile | null> {
  for (const name of NAMES) {
    const path = join(dir, name);
    const source = await readText(path);
    if (source === null) continue;
    return { name, path, source, data: parseObject(source) };
  }
  return null;
}

/** A file's text, or `null` when it does not exist / cannot be read. */
async function readText(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/** `source` parsed as a JSONC object, or `null` when it is malformed or not an object. */
function parseObject(source: string): Record<string, unknown> | null {
  try {
    const parsed = parseJsonc(source);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The project's declared tasks as `name → command`. Deno's object task form
 * (`{ description, command }`) is flattened to its command; anything else becomes `""`.
 *
 * @param config The already-read config file, or `null`.
 * @returns The task table (empty when there are no tasks).
 */
export function taskMap(config: DenoConfigFile | null): Record<string, string> {
  const tasks = config?.data?.tasks;
  if (tasks === null || typeof tasks !== "object" || Array.isArray(tasks)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(tasks as Record<string, unknown>)) {
    out[name] = commandOf(value);
  }
  return out;
}

/** One task entry's command line (`""` for a shape Deno accepts but the UI cannot show). */
function commandOf(value: unknown): string {
  if (typeof value === "string") return value;
  const command = (value as { command?: unknown } | null)?.command;
  return typeof command === "string" ? command : "";
}
