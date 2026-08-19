// Signed-cookie sessions + secure cookie defaults.

import { assert, assertEquals } from "@std/assert";
import { cookies, createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { getSession } from "../src/server/session.ts";

const SECRET = "test-secret-value-please-rotate";

/** Run `fn` in a fresh request context for `url` (+ optional Cookie header). */
function inRequest<T>(url: string, cookie: string | null, fn: () => Promise<T>): Promise<T> {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  const ctx = createRequestContext(new Request(url, { headers }));
  return runWithContext(ctx, fn) as Promise<T>;
}

/** The `name=value` of the Set-Cookie written during a request. */
async function issueCookie(url: string, fn: () => Promise<void>): Promise<string> {
  const ctx = createRequestContext(new Request(url));
  await runWithContext(ctx, fn);
  const setCookie = ctx.outgoingHeaders.get("set-cookie")!;
  return setCookie.split(";")[0]; // "denext_session=<token>"
}

// NOTE: kept FIRST in this file on purpose. The weak-secret warning latches once
// per process; several later tests use short inline secrets ("old"/"new"/…), so this
// must run before them to observe the un-latched state deterministically (Part C).
Deno.test("getSession warns once on a too-short (brute-forceable) secret (Part C)", async () => {
  const calls: string[] = [];
  const original = console.warn;
  console.warn = (...a: unknown[]) => void calls.push(a.join(" "));
  try {
    await inRequest("http://x/", null, async () => {
      await getSession({ secret: "short" }); // < 32 chars → warns
    });
    await inRequest("http://x/", null, async () => {
      await getSession({ secret: "also-short" }); // second weak secret → NO second warning
    });
  } finally {
    console.warn = original;
  }
  const hits = calls.filter((m) => m.includes("session secret"));
  assertEquals(hits.length, 1, "the weak-secret warning fires exactly once per process");
  assert(hits[0].includes("forged"), "the warning explains the risk");
});

Deno.test("session round-trips: set → verified read in a later request", async () => {
  const cookie = await issueCookie("https://x/", async () => {
    const s = await getSession<{ userId: string }>({ secret: SECRET });
    assertEquals(s.data, null); // no session yet
    await s.set({ userId: "alice" });
  });

  const data = await inRequest("https://x/", cookie, async () => {
    const s = await getSession<{ userId: string }>({ secret: SECRET });
    return s.data;
  });
  assertEquals(data, { userId: "alice" });
});

Deno.test("a tampered session token is rejected", async () => {
  const cookie = await issueCookie("https://x/", async () => {
    const s = await getSession<{ userId: string }>({ secret: SECRET });
    await s.set({ userId: "alice" });
  });
  // Flip a character in the token value.
  const [name, value] = cookie.split("=");
  const tampered = `${name}=${value.slice(0, -2)}${value.slice(-2) === "aa" ? "bb" : "aa"}`;
  const data = await inRequest("https://x/", tampered, async () => {
    return (await getSession<{ userId: string }>({ secret: SECRET })).data;
  });
  assertEquals(data, null);
});

Deno.test("a session signed with a different secret is rejected", async () => {
  const cookie = await issueCookie("https://x/", async () => {
    await (await getSession<{ userId: string }>({ secret: "other-secret" })).set({ userId: "eve" });
  });
  const data = await inRequest("https://x/", cookie, async () => {
    return (await getSession<{ userId: string }>({ secret: SECRET })).data;
  });
  assertEquals(data, null);
});

Deno.test("secret rotation: an old-secret session still verifies while both are configured", async () => {
  const cookie = await issueCookie("https://x/", async () => {
    await (await getSession<{ n: number }>({ secret: "old" })).set({ n: 1 });
  });
  const data = await inRequest("https://x/", cookie, async () => {
    // New secret first (signs), old still verifies.
    return (await getSession<{ n: number }>({ secret: ["new", "old"] })).data;
  });
  assertEquals(data, { n: 1 });
});

Deno.test("clear() removes the session", async () => {
  const ctx = createRequestContext(
    new Request("https://x/", { headers: { cookie: "denext_session=whatever" } }),
  );
  await runWithContext(ctx, async () => {
    (await getSession({ secret: SECRET })).clear();
  });
  // Deleting writes a Set-Cookie that expires the cookie.
  const sc = ctx.outgoingHeaders.get("set-cookie") ?? "";
  assert(sc.includes("denext_session="));
});

// --- secure cookie defaults --------------------------------------------------

Deno.test("cookies().set defaults to httpOnly + SameSite=Lax, and Secure over HTTPS", () => {
  const ctx = createRequestContext(new Request("https://x/"));
  runWithContext(ctx, () => cookies().set("t", "1"));
  const sc = ctx.outgoingHeaders.get("set-cookie")!;
  assert(/HttpOnly/i.test(sc), `expected HttpOnly: ${sc}`);
  assert(/SameSite=Lax/i.test(sc), `expected SameSite=Lax: ${sc}`);
  assert(/Secure/i.test(sc), `expected Secure over https: ${sc}`);
});

Deno.test("cookies().set omits Secure on plain HTTP (localhost dev)", () => {
  const ctx = createRequestContext(new Request("http://localhost/"));
  runWithContext(ctx, () => cookies().set("t", "1"));
  const sc = ctx.outgoingHeaders.get("set-cookie")!;
  assert(!/Secure/i.test(sc), `expected no Secure on http: ${sc}`);
  assert(/HttpOnly/i.test(sc), `still httpOnly on http: ${sc}`);
});

Deno.test("cookies().set honors explicit overrides (client-readable cookie)", () => {
  const ctx = createRequestContext(new Request("https://x/"));
  runWithContext(
    ctx,
    () => cookies().set("theme", "dark", { httpOnly: false, sameSite: "Strict" }),
  );
  const sc = ctx.outgoingHeaders.get("set-cookie")!;
  assert(!/HttpOnly/i.test(sc), `explicit httpOnly:false honored: ${sc}`);
  assert(/SameSite=Strict/i.test(sc), `explicit sameSite honored: ${sc}`);
});
