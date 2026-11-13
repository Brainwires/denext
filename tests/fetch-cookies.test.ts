// Cookie sessions for server-side fetches (src/server/fetch-cookies.ts): `safeFetch({ cookieJar })`
// across redirect hops, the OAuth provider fetch sharing one jar between a sign-in's calls, and
// `denext/testing`'s client over a URL-aware store. The runtime's own `Deno.CookieJar` (denext's
// Deno with `--unstable-cookies`) is exercised when the process has it; elsewhere a stand-in jar
// with the same two methods is.

import { assert, assertEquals } from "@std/assert";
import {
  addRequestCookies,
  type FetchCookieJar,
  runtimeCookieJar,
  storeResponseCookies,
} from "../src/server/fetch-cookies.ts";
import { makeSafeFetch, type Resolver, type Transport } from "../src/server/safe-fetch.ts";
import { makeHostPinnedFetch } from "../src/server/auth/flow.ts";
import { CookieJar, createTestClient, type TestCookieStore } from "../src/testing/client.ts";

const dec = new TextDecoder();
const enc = new TextEncoder();

/** A stand-in jar: cookies keyed by host and name; `Domain=` refused (a jar's rule). */
class HostJar implements TestCookieStore {
  cookies = new Map<string, Map<string, string>>();
  getCookieString(url: string | URL): string | null {
    const m = this.cookies.get(new URL(url).host);
    return m?.size ? [...m].map(([n, v]) => `${n}=${v}`).join("; ") : null;
  }
  setCookie(setCookie: string, url: string | URL): void {
    if (/;\s*domain=/i.test(setCookie)) throw new TypeError("Cookie rejected");
    const [pair] = setCookie.split(";");
    const eq = pair.indexOf("=");
    const host = new URL(url).host;
    const m = this.cookies.get(host) ?? new Map<string, string>();
    m.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    this.cookies.set(host, m);
  }
  getCookies(): { name: string; value: string }[] {
    return [...this.cookies.values()].flatMap((m) =>
      [...m].map(([name, value]) => ({ name, value }))
    );
  }
  clear(): void {
    this.cookies.clear();
  }
}

/** A raw HTTP response with repeated headers allowed. */
function raw(status: number, headers: [string, string][], body = ""): Uint8Array {
  const head = [`HTTP/1.1 ${status} X`, ...headers.map(([k, v]) => `${k}: ${v}`)];
  head.push(`content-length: ${enc.encode(body).byteLength}`);
  return enc.encode(`${head.join("\r\n")}\r\n\r\n${body}`);
}

Deno.test("safeFetch cookieJar: each hop's cookies are stored and sent; an explicit header wins", async () => {
  const resolver: Resolver = () => Promise.resolve(["93.184.216.34"]);
  const sent: string[] = [];
  const transport: Transport = (opts) => {
    const text = dec.decode(opts.request);
    sent.push(text);
    if (text.startsWith("GET /start ")) {
      return Promise.resolve(raw(302, [
        ["location", "/next"],
        ["set-cookie", "sid=abc; Path=/"],
        ["set-cookie", "wide=1; Domain=example.org"], // refused by the jar: dropped
      ]));
    }
    return Promise.resolve(raw(200, [["set-cookie", "seen=yes"]], "ok"));
  };
  const sf = makeSafeFetch({ resolver, transport });
  const jar = new HostJar();
  const res = await sf("https://example.com/start", { cookieJar: jar });
  assertEquals(await res.text(), "ok");
  const cookie = (i: number) => sent[i].match(/\r\ncookie: ([^\r]*)\r\n/i)?.[1] ?? null;
  assertEquals(cookie(0), null, "an empty jar sends none");
  assertEquals(cookie(1), "sid=abc", "the redirect hop's cookie is sent on the next hop");
  assertEquals(jar.getCookieString("https://example.com/"), "sid=abc; seen=yes");
  await sf("https://example.com/other", { cookieJar: jar, headers: { cookie: "mine=1" } });
  assertEquals(cookie(2), "mine=1", "an explicit Cookie header bypasses the jar");
  // without a jar nothing is kept
  await sf("https://example.com/other");
  assertEquals(cookie(3), null);
});

Deno.test("fetch cookies: a closed or refusing jar never fails the request", () => {
  const broken: FetchCookieJar = {
    getCookieString() {
      throw new Error("BadResource");
    },
    setCookie() {
      throw new Error("BadResource");
    },
  };
  const headers = new Headers();
  addRequestCookies(broken, headers, "https://example.com/");
  assertEquals(headers.has("cookie"), false);
  const res = new Headers([["set-cookie", "a=1"]]);
  storeResponseCookies(broken, res, "https://example.com/");
});

Deno.test("OAuth provider fetch: one sign-in's calls share the cookie session", async () => {
  const seen: (string | null)[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
    seen.push(request.headers.get("cookie"));
    const path = new URL(request.url).pathname;
    if (path === "/token") {
      return Response.json({ access_token: "at" }, { headers: { "set-cookie": "lb=node-2" } });
    }
    return Response.json({ sub: "u1" });
  });
  const host = `127.0.0.1:${server.addr.port}`;
  try {
    const jar = new HostJar();
    const doFetch = makeHostPinnedFetch([host], "dev-idp", true, jar);
    await (await doFetch(`http://${host}/token`, { method: "POST", headers: {}, body: "x" }))
      .json();
    await (await doFetch(`http://${host}/userinfo`, { method: "GET", headers: {} })).json();
    assertEquals(seen, [null, "lb=node-2"]);
    // no jar: no session, as before
    const plain = makeHostPinnedFetch([host], "dev-idp", true);
    await (await plain(`http://${host}/userinfo`, { method: "GET", headers: {} })).json();
    assertEquals(seen[2], null);
  } finally {
    await server.shutdown();
  }
});

Deno.test("denext/testing: a client over a URL-aware store keeps cookies per host", async () => {
  const handler = (request: Request): Response => {
    const url = new URL(request.url);
    if (url.pathname === "/login") {
      return new Response("in", { headers: { "set-cookie": "session=s1; Path=/" } });
    }
    return new Response(request.headers.get("cookie") ?? "none");
  };
  const store = new HostJar();
  const client = createTestClient(handler, { cookieJar: store });
  await client.get("/login");
  assertEquals((await client.get("/me")).text, "session=s1");
  assertEquals(client.cookies.get("session"), "s1");
  // another host gets nothing from this one's cookies
  assertEquals((await client.get("http://other.test/me")).text, "none");
  client.cookies.set("seeded", "1");
  assertEquals(client.cookies.header("http://localhost/x"), "session=s1; seeded=1");
  client.cookies.clear();
  assertEquals((await client.get("/me")).text, "none");
  // the default jar is unchanged: keyed by name, sent everywhere
  const plain = new CookieJar();
  plain.set("a", "1");
  assertEquals(plain.header(), "a=1");
});

Deno.test("runtimeCookieJar: null without --unstable-cookies", () => {
  // No test pass enables the flag, so this process has no runtime jar.
  const has = typeof (Deno as unknown as { CookieJar?: unknown }).CookieJar === "function";
  using jar = runtimeCookieJar();
  assertEquals(jar !== null, has);
});

/** Whether this process runs on denext's Deno (the toolchain), which carries `Deno.CookieJar`. */
const onDenextDeno = Boolean((Deno.build as { denext?: string }).denext);

Deno.test({
  name: "runtimeCookieJar: the runtime's jar under --unstable-cookies applies the browser's rules",
  // Stock Deno has no `Deno.CookieJar` at all; on denext's Deno a missing jar is a failure.
  ignore: !onDenextDeno,
  async fn() {
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--unstable-cookies",
        new URL("./fixtures/fetch-cookies/runtime-jar-probe.ts", import.meta.url).pathname,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = dec.decode(out.stderr);
    assert(out.success, stderr);
    const line = dec.decode(out.stdout).trim().split("\n").pop()!;
    assertEquals(JSON.parse(line), {
      jar: true,
      // `wide` (Domain=example.com, wider than localhost) is refused; `scoped` stays on /admin.
      me: "session=s1",
      admin: ["scoped=1", "session=s1"],
      other: "none",
    });
  },
});
