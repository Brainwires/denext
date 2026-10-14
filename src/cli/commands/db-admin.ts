// `denext db-admin` — the child process behind `denext ui`'s Database section. Hidden: it is a
// protocol, not a command anyone types.
//
// The UI never opens the project's database or storage itself: that needs the project's config
// (`backend({ postgres, storage })`, a `sql` client the app built), and the UI process never
// evaluates project code. So each page spawns this verb with a JSON envelope on stdin
// (`src/ui/database/protocol.ts`); it loads the project (`.env` included — `loadsModules`), sets
// its plugins up so `@denext/backend` installs its client and storage, answers the one request,
// prints the reply as JSON and exits.

import { resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { runPluginTeardown } from "../../plugin/mod.ts";
import type { DbEnvelope, DbReply } from "../../ui/database/protocol.ts";
import { openConnection } from "../db-admin/connection.ts";
import { failureOf, handleDbRequest } from "../db-admin/handle.ts";
import { setUpProject } from "../db/project.ts";

/** The most a request may carry on stdin. */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/** Read stdin whole (bounded). */
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of Deno.stdin.readable) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new TypeError("request too large");
    chunks.push(chunk);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(all);
}

/** Read an environment variable, or `undefined` without permission. */
function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Answer the envelope on stdin.
 *
 * @param projectDir The project.
 * @returns The reply.
 */
async function answer(projectDir: string): Promise<DbReply> {
  let envelope: DbEnvelope;
  try {
    envelope = JSON.parse(await readStdin()) as DbEnvelope;
    await setUpProject(projectDir);
  } catch (error) {
    return failureOf(error);
  }
  try {
    return await handleDbRequest(envelope, { projectDir, connect: () => openConnection(env) });
  } finally {
    await runPluginTeardown();
  }
}

export const dbAdminCommand: CommandSpec = {
  name: "db-admin",
  summary: "The database child process behind denext ui (JSON on stdin)",
  hidden: true,
  loadsModules: true,
  moduleDir: (ctx) => resolve(ctx.global.cwd ?? "."),
  usage: "denext db-admin --json --cwd <dir> < request.json",
  run: async (ctx: CommandContext) => {
    const reply = await answer(resolve(ctx.global.cwd ?? "."));
    // Pretty-printed: the UI finds the document by its bare `{` / `}` lines.
    console.log(JSON.stringify(reply, null, 2));
    // A plugin may leave a timer or a pool behind; the answer is out, so stop here.
    Deno.exit(0);
  },
};
