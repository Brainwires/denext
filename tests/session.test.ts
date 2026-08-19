// Signed-cookie sessions + secure cookie defaults.

import { assert, assertEquals, assertRejects } from "@std/assert";
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

Deno.test("hostPrefix: true issues an origin-locked __Host- cookie (Secure, Path=/, no Domain)", async () => {
  const ctx = createRequestContext(new Request("https://x/"));
  await runWithContext(ctx, async () => {
    await (await getSession<{ userId: string }>({ secret: SECRET, hostPrefix: true }))
      .set({ userId: "alice" });
  });
  const sc = ctx.outgoingHeaders.get("set-cookie")!;
  assert(sc.startsWith("__Host-denext_session="), `renamed with the prefix: ${sc}`);
  assert(/Secure/i.test(sc), `__Host- forces Secure: ${sc}`);
  assert(/Path=\//i.test(sc), `__Host- forces Path=/: ${sc}`);
  assert(!/Domain=/i.test(sc), `__Host- must carry no Domain: ${sc}`);
  assert(/HttpOnly/i.test(sc), `still httpOnly: ${sc}`);
});

Deno.test("hostPrefix works over http://localhost (localhost is a secure context)", async () => {
  const ctx = createRequestContext(new Request("http://localhost/"));
  await runWithContext(ctx, async () => {
    await (await getSession({ secret: SECRET, hostPrefix: true })).set({ n: 1 });
  });
  const sc = ctx.outgoingHeaders.get("set-cookie")!;
  // The __Host- prefix forces Secure even though the request is plain http — which
  // is fine on localhost, where browsers store Secure cookies.
  assert(sc.startsWith("__Host-denext_session="), sc);
  assert(/Secure/i.test(sc), `__Host- forces Secure even on http: ${sc}`);
});

Deno.test("hostPrefix session round-trips under the prefixed name", async () => {
  const cookie = await issueCookie("https://x/", async () => {
    await (await getSession<{ userId: string }>({ secret: SECRET, hostPrefix: true }))
      .set({ userId: "alice" });
  });
  assert(cookie.startsWith("__Host-denext_session="), cookie);
  const data = await inRequest("https://x/", cookie, async () => {
    return (await getSession<{ userId: string }>({ secret: SECRET, hostPrefix: true })).data;
  });
  assertEquals(data, { userId: "alice" });
});

Deno.test("a cookieName already prefixed with __Host- is enforced without the flag", async () => {
  const ctx = createRequestContext(new Request("https://x/"));
  await runWithContext(ctx, async () => {
    await (await getSession({ secret: SECRET, cookieName: "__Host-app_sess" })).set({ n: 1 });
  });
  const sc = ctx.outgoingHeaders.get("set-cookie")!;
  assert(sc.startsWith("__Host-app_sess="), sc);
  assert(/Secure/i.test(sc) && /Path=\//i.test(sc) && !/Domain=/i.test(sc), sc);
});

Deno.test("a tampered session token is rejected", async () => {
  const cookie = await issueCookie("https://x/", async () => {
    const s = await getSession<{ userId: string }>({ secret: SECRET });
    await s.set({ userId: "alice" });
  });
  // Tamper the token by flipping its FIRST character. (Flipping the last base64url
  // char is unreliable: a 32-byte HMAC → 43 chars whose final char carries only 4
  // meaningful bits, so some flips decode to identical bytes and the signature still
  // verifies — a data-dependent flake. The first char is always 6 full bits, so
  // changing it always changes the decoded payload/signature.)
  const [name, value] = cookie.split("=");
  const flipped = value[0] === "a" ? "b" : "a";
  const tampered = `${name}=${flipped}${value.slice(1)}`;
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

Deno.test("an expired session token reads as no session", async () => {
  // Issue with a 1-second lifetime, then read it back with the clock pushed past
  // expiry. The signature is still valid, but `parsed.e <= Date.now()` must gate it.
  const cookie = await issueCookie("https://x/", async () => {
    await (await getSession<{ userId: string }>({ secret: SECRET, maxAge: 1 })).set({
      userId: "alice",
    });
  });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 5_000; // 5s later — past the 1s expiry
    const data = await inRequest("https://x/", cookie, async () => {
      return (await getSession<{ userId: string }>({ secret: SECRET, maxAge: 1 })).data;
    });
    assertEquals(data, null, "a token whose expiry has passed is not honored");
  } finally {
    Date.now = realNow;
  }
});

Deno.test("a custom maxAge is reflected as Max-Age in the Set-Cookie", async () => {
  const ctx = createRequestContext(new Request("https://x/"));
  await runWithContext(ctx, async () => {
    await (await getSession({ secret: SECRET, maxAge: 3600 })).set({ n: 1 });
  });
  const sc = ctx.outgoingHeaders.get("set-cookie")!;
  assert(/Max-Age=3600\b/i.test(sc), `expected Max-Age=3600: ${sc}`);
});

Deno.test("an empty secret is rejected", async () => {
  await assertRejects(
    () => inRequest("https://x/", null, () => getSession({ secret: "" })),
    Error,
    "non-empty",
  );
  await assertRejects(
    () => inRequest("https://x/", null, () => getSession({ secret: [] })),
    Error,
    "non-empty",
  );
  await assertRejects(
    () => inRequest("https://x/", null, () => getSession({ secret: ["ok-secret", ""] })),
    Error,
    "non-empty",
  );
});

Deno.test("structurally malformed session tokens read as null, never throw", async () => {
  // A valid signature over a payload that is not base64url/JSON must hit the
  // JSON.parse catch and yield null — not propagate a decode error.
  const goodSig = await inRequest("https://x/", null, async () => {
    // Reach into set() to obtain a real signature for a junk payload by signing a
    // known-good session, then swapping only the payload half.
    const ctx = createRequestContext(new Request("https://x/"));
    let token = "";
    await runWithContext(ctx, async () => {
      await (await getSession({ secret: SECRET })).set({ ok: true });
    });
    token = ctx.outgoingHeaders.get("set-cookie")!.split(";")[0].split("=").slice(1).join("=");
    return token.slice(token.lastIndexOf(".") + 1);
  });

  const cases: Record<string, string> = {
    "no dot separator": "denext_session=notoken",
    "leading dot (empty payload)": `denext_session=.${goodSig}`,
    "valid sig over non-JSON payload": `denext_session=!!!notb64!!!.${goodSig}`,
  };
  for (const [label, cookie] of Object.entries(cases)) {
    const data = await inRequest("https://x/", cookie, async () => {
      return (await getSession({ secret: SECRET })).data;
    });
    assertEquals(data, null, `${label} → null`);
  }
});

Deno.test("sameSite:None and a custom path propagate to the Set-Cookie", async () => {
  const ctx = createRequestContext(new Request("https://x/"));
  await runWithContext(ctx, async () => {
    await (await getSession({ secret: SECRET, sameSite: "None", path: "/app" })).set({ n: 1 });
  });
  const sc = ctx.outgoingHeaders.get("set-cookie")!;
  assert(/SameSite=None/i.test(sc), `expected SameSite=None: ${sc}`);
  assert(/Path=\/app\b/i.test(sc), `expected Path=/app: ${sc}`);
});

Deno.test("__Host- forces Path=/ and warns in dev when a non-root path is requested", async () => {
  const g = globalThis as { __denextDev?: boolean };
  g.__denextDev = true;
  const calls: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void calls.push(a.join(" "));
  try {
    const ctx = createRequestContext(new Request("https://x/"));
    await runWithContext(ctx, async () => {
      await (await getSession({ secret: SECRET, hostPrefix: true, path: "/admin" })).set({ n: 1 });
    });
    const sc = ctx.outgoingHeaders.get("set-cookie")!;
    assert(/Path=\//i.test(sc) && !/Path=\/admin/i.test(sc), `__Host- forces Path=/: ${sc}`);
    assert(
      calls.some((m) => m.includes("__Host-") && m.includes("Path=/")),
      "dev warns that the requested path is ignored",
    );
  } finally {
    console.warn = origWarn;
    delete g.__denextDev;
  }
});

Deno.test("a non-decodable base64url signature is rejected without throwing", async () => {
  // fromBase64Url is called on the signature inside verify(); an undecodable sig
  // must be caught (return false), not surface as an exception.
  const payload = "eyJkIjp7Im4iOjF9LCJlIjo5OTk5OTk5OTk5OTk5fQ"; // base64url-ish payload
  const cookie = `denext_session=${payload}.@@@notbase64@@@`;
  const data = await inRequest("https://x/", cookie, async () => {
    return (await getSession({ secret: SECRET })).data;
  });
  assertEquals(data, null);
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
