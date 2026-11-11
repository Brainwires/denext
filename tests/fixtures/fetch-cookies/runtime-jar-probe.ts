// Run by tests/fetch-cookies.test.ts on denext's Deno with `--unstable-cookies`: the runtime's
// own `Deno.CookieJar` behind `runtimeCookieJar()` and `denext/testing`'s client. Prints one JSON
// line of what each request was sent.

import { runtimeCookieJar } from "../../../src/server/fetch-cookies.ts";
import { createTestClient } from "../../../src/testing/client.ts";

using jar = runtimeCookieJar();
if (!jar) {
  console.log(JSON.stringify({ jar: false }));
} else {
  // The browser's rules: Path scoping, and a Domain wider than the host is refused (dropped).
  const client = createTestClient((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/login") {
      const headers = new Headers();
      headers.append("set-cookie", "session=s1; Path=/");
      headers.append("set-cookie", "scoped=1; Path=/admin");
      headers.append("set-cookie", "wide=1; Domain=example.com");
      return new Response("in", { headers });
    }
    return new Response(request.headers.get("cookie") ?? "none");
  }, { cookieJar: jar });
  await client.get("/login");
  const me = (await client.get("/me")).text;
  const admin = (await client.get("/admin/x")).text;
  const other = (await client.get("http://other.test/me")).text;
  console.log(JSON.stringify({ jar: true, me, admin: admin.split("; ").sort(), other }));
}
