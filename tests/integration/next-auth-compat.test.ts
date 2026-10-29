// `next-auth` on the next-compat build, with no import map: the server bundle (auth.ts, the
// `[...nextauth]` route, a Server Component) and the client bundle (a component using
// `useSession` / `signIn`, and a `node_modules` library importing `next-auth/react` itself)
// all resolve `next-auth*` to denext's shim through the compat aliases — never the `next-auth`
// package installed next to them (a decoy here, which throws). The app builds and serves, the
// client entry carries the shim, and a Credentials sign-in through the served routes is read
// back by the Server Component. The real-browser hydration is tests/e2e/next-auth-compat.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { stopNextCompat } from "../../src/build/next-compat.ts";
import { serveEphemeral } from "../../src/build/prod-server.ts";
import { DECOY_MARKER, writeNextAuthCompatFixture } from "../helpers/next-auth-compat-fixture.ts";
import { buildInChild } from "../helpers/bounded-build.ts";

/** Every client script a page references, fetched, plus the chunks they import. */
async function clientCode(origin: string, html: string): Promise<string> {
  const seen = new Set<string>();
  const queue = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  let all = "";
  while (queue.length) {
    const src = queue.shift()!;
    const url = new URL(src, origin).href;
    if (seen.has(url) || !url.startsWith(origin)) continue;
    seen.add(url);
    const res = await fetch(url);
    const js = await res.text();
    all += js;
    for (const m of js.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+\.js)"/g)) {
      queue.push(new URL(m[1], url).href);
    }
  }
  return all;
}

/** A tiny cookie jar for `fetch`. */
function jar() {
  const cookies = new Map<string, string>();
  return {
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    take(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [pair] = line.split(";");
        const at = pair.indexOf("=");
        cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
    },
  };
}

Deno.test({
  name: "next-compat build: next-auth and next-auth/react resolve to the shim, app and library",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_nextauth_compat_" });
  try {
    await writeNextAuthCompatFixture(dir);
    await buildInChild(dir);
    const server = await serveEphemeral(dir);
    try {
      const home = await fetch(`${server.origin}/`);
      assertEquals(home.status, 200);
      const html = await home.text();
      assertStringIncludes(html, "SERVER:anonymous");
      assertStringIncludes(html, "CLIENT:loading:-");
      assertStringIncludes(html, "BADGE:loading");
      assert(!html.includes(DECOY_MARKER));
      const js = await clientCode(server.origin, html);
      assertStringIncludes(js, "/api/auth", "the shim's client is in the bundle");
      assertStringIncludes(js, "BADGE:", "the library is in the bundle");
      assert(!js.includes(DECOY_MARKER), "the real next-auth package was bundled");

      // A Credentials sign-in through the served handlers, read back by the Server Component.
      const browser = jar();
      const csrfRes = await fetch(`${server.origin}/api/auth/csrf`);
      browser.take(csrfRes);
      const { csrfToken } = await csrfRes.json();
      const signIn = await fetch(`${server.origin}/api/auth/callback/credentials`, {
        method: "POST",
        redirect: "manual",
        headers: {
          cookie: browser.header(),
          origin: server.origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          csrfToken,
          email: "ada@example.com",
          password: "pw",
          callbackUrl: "/",
        }),
      });
      await signIn.body?.cancel();
      assertEquals(signIn.status, 302);
      browser.take(signIn);
      const after = await fetch(`${server.origin}/`, { headers: { cookie: browser.header() } });
      assertStringIncludes(await after.text(), "SERVER:ada@example.com");
      const session = await fetch(`${server.origin}/api/auth/session`, {
        headers: { cookie: browser.header() },
      });
      assertEquals((await session.json()).user.name, "Ada");
    } finally {
      await server.close();
    }
  } finally {
    await stopNextCompat();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
