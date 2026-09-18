// The `denext ui` gates, against EVERY route in the table rather than the handful the security
// suite picks by hand: each mutating `[path, method]` `UI_ROUTES` accepts must be refused without
// a CSRF token, without an Origin, with a wrong Origin, when the browser says the request is
// cross-site, and under `--read-only` — before its handler runs. And every route that answers a
// GET must leave the project directory byte for byte as it found it: a read never writes.
//
// The table is read from `src/ui/routes.ts`, so a route added later is covered the day it
// appears, and a route that slips out of the central chain (`server.ts`) fails here by name.

import { assert, assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { join, relative } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import { UI_ROUTES } from "../src/ui/routes.ts";
import { startUiServer, type UiServer } from "../src/ui/server.ts";
import { isMutation, UI_CSRF_HEADER } from "../src/ui/security.ts";

/** A started server and the credentials a browser would be holding after the handshake. */
interface Session {
  readonly server: UiServer;
  /** The origin the server itself printed — never a spelling reconstructed here. */
  readonly base: string;
  readonly dir: string;
  /** The `Cookie` header value the handshake set. */
  readonly cookie: string;
  /** The CSRF token the landing page carries. */
  readonly csrf: string;
}

/**
 * Start a server on a throwaway project and go through the front door the way a browser does:
 * follow the printed `?t=` URL, keep the cookie the 302 sets, land where it points, and read the
 * CSRF token off that page's `<meta>`. Nothing here builds the cookie from the launch token or
 * derives the CSRF token itself, so the test holds whatever the handshake actually hands out.
 */
async function session(options: { readOnly?: boolean } = {}): Promise<Session> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_guards_" });
  await Deno.writeTextFile(join(dir, "deno.json"), '{ "tasks": { "hello": "echo hi" } }');
  await Deno.writeTextFile(join(dir, "denext.config.ts"), "export default {};\n");
  const server = await startUiServer({ dir, port: 0, ...options });
  const base = new URL(server.url).origin;
  const hello = await fetch(server.url, { redirect: "manual" });
  await hello.body?.cancel();
  assertEquals(hello.status, 302, "the handshake redirects");
  const cookie = (hello.headers.get("set-cookie") ?? "").split(";")[0];
  assert(cookie.includes("="), "the handshake sets the session cookie");
  const landing = new URL(hello.headers.get("location") ?? "/", base);
  const page = await fetch(landing, { headers: { cookie } });
  assertEquals(page.status, 200, "the page the handshake lands on renders");
  const meta = /<meta name="denext-csrf" content="([^"]+)">/.exec(await page.text());
  assert(meta, "the landing page carries the CSRF token");
  return { server, base, dir, cookie, csrf: meta[1] };
}

async function stop(s: Session): Promise<void> {
  await s.server.shutdown();
  await Deno.remove(s.dir, { recursive: true }).catch(() => {});
}

/** A refusal's body is the hardened envelope, and says why. */
async function refusal(res: Response, status: number, reason: string, what: string) {
  assertEquals(res.status, status, `${what}: status`);
  const body = await res.json();
  assertEquals(body.ok, false, `${what}: envelope`);
  assertEquals(body.reason, reason, `${what}: reason`);
}

/** Every `[path, method]` pair in the table that changes state. */
const MUTATIONS: readonly (readonly [string, string])[] = Object.entries(UI_ROUTES)
  .flatMap(([path, route]) =>
    route.methods.filter(isMutation).map((method) => [path, method] as const)
  );

/** Every path in the table that answers a read. */
const READS: readonly string[] = Object.entries(UI_ROUTES)
  .filter(([, route]) => route.methods.includes("GET"))
  .map(([path]) => path);

/**
 * The one file a read is allowed to leave behind. `/commands` lists the project's verbs by
 * running `denext commands --json` in a child, and that verb caches what it found next to the
 * project (`src/cli/command-cache.ts`) so `denext --help` can list the verbs without importing
 * the config again. It is the CLI's own scratch, not a project file — anything else is a write.
 */
const CLI_SCRATCH = new Set([join(".denext", "commands.json")]);

/**
 * A manifest of `root`: every file's relative path and content hash, sorted — compared whole, so
 * a failure names the file that appeared, vanished or changed.
 */
async function manifest(root: string): Promise<string> {
  const lines: string[] = [];
  for await (const entry of walk(root, { includeDirs: false, includeSymlinks: true })) {
    if (CLI_SCRATCH.has(relative(root, entry.path))) continue;
    const bytes = entry.isSymlink
      ? new TextEncoder().encode(await Deno.readLink(entry.path))
      : await Deno.readFile(entry.path);
    const digest = encodeHex(await crypto.subtle.digest("SHA-256", bytes));
    lines.push(`${relative(root, entry.path)} ${digest}`);
  }
  return lines.sort().join("\n");
}

Deno.test("the route table names mutations to guard and reads to check", () => {
  // The rest of this file iterates these; an empty table would pass vacuously.
  assert(MUTATIONS.length >= 20, `expected every panel's mutations, saw ${MUTATIONS.length}`);
  assert(READS.length >= 10, `expected every panel's reads, saw ${READS.length}`);
  for (const [path, method] of MUTATIONS) {
    assert(!["GET", "HEAD"].includes(method), `${path}: ${method} is a read`);
  }
});

Deno.test("every mutating route is refused at the gates, before its handler", async (t) => {
  const s = await session();
  try {
    for (const [path, method] of MUTATIONS) {
      await t.step(`${method} ${path}`, async () => {
        const url = s.base + path;
        const valid = { cookie: s.cookie, origin: s.base, [UI_CSRF_HEADER]: s.csrf };

        // No CSRF token, everything else in order.
        await refusal(
          await fetch(url, { method, headers: { cookie: s.cookie, origin: s.base } }),
          403,
          "bad csrf token",
          "no CSRF token",
        );
        // No Origin at all: a mutation with nothing to check defaults to deny.
        await refusal(
          await fetch(url, { method, headers: { cookie: s.cookie, [UI_CSRF_HEADER]: s.csrf } }),
          403,
          "bad origin",
          "no Origin",
        );
        // Another origin, with a stolen-looking but valid token.
        await refusal(
          await fetch(url, { method, headers: { ...valid, origin: "http://evil.test" } }),
          403,
          "forbidden origin",
          "wrong Origin",
        );
        // The browser itself says the page that sent this is not ours.
        await refusal(
          await fetch(url, { method, headers: { ...valid, "sec-fetch-site": "cross-site" } }),
          403,
          "forbidden origin",
          "cross-site",
        );
      });
    }
  } finally {
    await stop(s);
  }
});

Deno.test("--read-only refuses every mutating route with the read-only reason", async (t) => {
  const s = await session({ readOnly: true });
  try {
    for (const [path, method] of MUTATIONS) {
      await t.step(`${method} ${path}`, async () => {
        // Fully credentialed — the cookie, a same-origin Origin, the CSRF token — so the only
        // thing standing between this request and the handler is the flag.
        const res = await fetch(s.base + path, {
          method,
          headers: { cookie: s.cookie, origin: s.base, [UI_CSRF_HEADER]: s.csrf },
        });
        await refusal(res, 403, "read-only", "read-only");
      });
    }
  } finally {
    await stop(s);
  }
});

Deno.test("a GET on every route leaves the project directory byte for byte as it was", async (t) => {
  const s = await session();
  try {
    const before = await manifest(s.dir);
    for (const path of READS) {
      await t.step(`GET ${path}`, async () => {
        const res = await fetch(s.base + path, { headers: { cookie: s.cookie } });
        assert(res.status < 500, `GET ${path}: ${res.status}`);
        // The event stream never ends on its own; everything else is read to completion so the
        // handler has finished whatever it does before the tree is measured.
        if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
          await res.body?.cancel();
        } else {
          await res.text();
        }
        assertEquals(await manifest(s.dir), before, `GET ${path} changed the project directory`);
      });
    }
  } finally {
    await stop(s);
  }
});
