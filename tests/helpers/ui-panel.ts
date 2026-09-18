// The loopback harness the `denext ui` panel suites share: a real server on a temp project,
// driven the way a browser with JavaScript disabled would drive it — real form posts, a session
// obtained through the `?t=` handshake, never the launch token.
//
// Extracted so a second panel suite does not carry a copy of it. The session half lives in
// `ui-session.ts`; this is the project-and-request half.

import { join } from "@std/path";
import { startUiServer, type UiServer } from "../../src/ui/server.ts";
import { UI_CSRF_HEADER } from "../../src/ui/security.ts";
import { uiHandshake } from "./ui-session.ts";

/** One running UI server, with the session a browser would hold. */
export interface Harness {
  /** The server under test. */
  server: UiServer;
  /** Its loopback origin. */
  base: string;
  /** The temp project directory it serves. */
  dir: string;
  /** The CSRF token derived from the session cookie. */
  csrf: string;
  /** The session cookie the handshake minted (never the launch token). */
  headers: Record<string, string>;
}

/**
 * Start the UI on a temp dir, optionally seeded with files.
 *
 * @param files Project files to write, by relative path.
 * @param opts `readOnly` / `offline`, as the CLI flags set them.
 * @param prefix The temp directory prefix, so a suite's dirs are recognisable.
 * @returns The harness.
 */
export async function uiOn(
  files: Record<string, string> = {},
  opts: { readOnly?: boolean; offline?: boolean } = {},
  prefix = "denext_ui_panel_",
): Promise<Harness> {
  const dir = await Deno.makeTempDir({ prefix });
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    await Deno.mkdir(join(abs, ".."), { recursive: true });
    await Deno.writeTextFile(abs, content);
  }
  const server = await startUiServer({ dir, port: 0, ...opts });
  const { cookie, csrf } = await uiHandshake(server);
  return { server, dir, base: `http://127.0.0.1:${server.port}`, csrf, headers: { cookie } };
}

/**
 * Shut the server down and remove its project directory.
 *
 * @param h The harness.
 */
export async function stopUi(h: Harness): Promise<void> {
  await h.server.shutdown();
  await Deno.remove(h.dir, { recursive: true });
}

/**
 * Post one operation the way a no-JS form would: the session cookie, a same-origin `Origin`,
 * the CSRF header, and no redirect following.
 *
 * @param h The harness.
 * @param fields The form fields.
 * @param path Where to post.
 * @returns The response.
 */
export function postTo(
  h: Harness,
  fields: Record<string, string>,
  path: string,
): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return fetch(`${h.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { ...h.headers, origin: h.base, [UI_CSRF_HEADER]: h.csrf },
    body: form,
  });
}

/**
 * Publish a `.denext/dev.json` naming a port nothing listens on — a dev server that looks
 * running and never answers, which is what makes the stale path testable without one.
 *
 * @param dir The project directory.
 * @returns The path of the file written.
 */
export async function fakeDevJson(dir: string): Promise<string> {
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  await Deno.mkdir(join(dir, ".denext"), { recursive: true });
  const path = join(dir, ".denext", "dev.json");
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      origin: `http://127.0.0.1:${port}`,
      port,
      hostname: "127.0.0.1",
      pid: 2147483646, // never signalled: the origin never answers
      startedAt: Date.now(),
    }),
  );
  return path;
}

/**
 * Whether a path exists.
 *
 * @param path The path to stat.
 * @returns Whether it is there.
 */
export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
