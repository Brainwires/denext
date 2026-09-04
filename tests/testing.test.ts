// Unit tests for the app-testing helper (denext/testing): cookie jar, form
// extraction, submission, and redirect following — over a hand-written handler so
// they exercise the client in isolation from the framework.

import { assert, assertEquals } from "@std/assert";
import { createTestClient, type TestHandler } from "denext/testing";

/** A 303 to `location`, optionally setting a cookie. */
function seeOther(location: string, cookie?: string): Response {
  const headers = new Headers({ location });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

const FORM_PAGE = `<h1>Sign in</h1>
       <form action="/submit" method="post">
         <input type="hidden" name="csrf" value="tok123" />
         <input name="email" value="pre@fill.com" />
         <textarea name="bio">hello &amp; welcome</textarea>
         <input type="checkbox" name="subscribe" />
         <input type="checkbox" name="terms" value="yes" checked />
         <button type="submit">Go</button>
       </form>
       <form action="/search" method="get">
         <input name="q" />
       </form>`;

/** Fixed routes the client drives; anything else falls through to the echo below. */
const ROUTES: Record<string, (req: Request, url: URL) => Response> = {
  "/form": () => new Response(FORM_PAGE, { headers: { "content-type": "text/html" } }),
  "/submit": (req) =>
    req.method === "POST" ? seeOther("/done", "sid=abc; Path=/; HttpOnly") : new Response("ok"),
  "/done": (req) => new Response(`session=${req.headers.get("cookie") ?? ""}`, { status: 200 }),
  "/logout": () => seeOther("/form", "sid=; Path=/; Max-Age=0"),
  "/hop1": () => new Response(null, { status: 302, headers: { location: "/hop2" } }),
  "/hop2": () => new Response(null, { status: 302, headers: { location: "/end" } }),
  "/end": () => new Response("arrived", { status: 200 }),
  "/search": (_req, url) => Response.json({ q: url.searchParams.get("q") }),
};

/** A tiny handler covering the surfaces the client drives. */
const handler: TestHandler = (req) => {
  const url = new URL(req.url);
  const route = ROUTES[url.pathname];
  if (route) return route(req, url);
  // Echo back the received body + origin/host for assertions.
  if (req.method === "POST") {
    return req.text().then((body) =>
      Response.json({ body, origin: req.headers.get("origin"), host: req.headers.get("host") })
    );
  }
  return new Response("ok");
};

Deno.test("cookie jar persists Set-Cookie and replays it", async () => {
  const client = createTestClient(handler);
  const submit = await client.post("/submit");
  assertEquals(submit.status, 303);
  assertEquals(client.cookies.get("sid"), "abc");

  const done = await client.get("/done");
  assertEquals(done.text, "session=sid=abc");
});

Deno.test("cookie jar honors deletion (Max-Age=0)", async () => {
  const client = createTestClient(handler);
  await client.post("/submit");
  assert(client.cookies.get("sid"));
  await client.get("/logout");
  assertEquals(client.cookies.get("sid"), undefined);
});

Deno.test("form() parses fields including hidden, textarea, and checkboxes", async () => {
  const client = createTestClient(handler);
  const page = await client.get("/form");
  const form = client.form(page.text);
  assertEquals(form.action, "http://localhost/submit");
  assertEquals(form.method, "POST");
  assertEquals(form.fields.csrf, "tok123");
  assertEquals(form.fields.email, "pre@fill.com");
  assertEquals(form.fields.bio, "hello & welcome"); // entity-decoded
  assertEquals(form.fields.terms, "yes"); // checked checkbox contributes its value
  assert(!("subscribe" in form.fields), "an unchecked checkbox contributes nothing");
});

Deno.test("form() `has` selector disambiguates multiple forms", async () => {
  const client = createTestClient(handler);
  const page = await client.get("/form");
  assertEquals(client.form(page.text, { has: "q" }).action, "http://localhost/search");
  assertEquals(client.form(page.text, { has: "email" }).action, "http://localhost/submit");
});

Deno.test("submit() posts urlencoded with overrides and same-origin headers", async () => {
  const client = createTestClient(handler);
  // Point the form at the echo endpoint to inspect what was sent.
  const form = { action: "http://localhost/echo", method: "POST", enctype: "", fields: { a: "1" } };
  const res = await client.submit(form, { b: "2" });
  const echoed = res.json() as { body: string; origin: string; host: string };
  const params = new URLSearchParams(echoed.body);
  assertEquals(params.get("a"), "1");
  assertEquals(params.get("b"), "2");
  assertEquals(echoed.origin, "http://localhost");
  assertEquals(echoed.host, "localhost");
});

Deno.test("submit() of a GET form builds a query string", async () => {
  const client = createTestClient(handler);
  const page = await client.get("/form");
  const res = await client.submit(client.form(page.text, { has: "q" }), { q: "denext" });
  assertEquals(res.json(), { q: "denext" });
});

Deno.test("redirects: not followed by default, followed when enabled", async () => {
  const manual = createTestClient(handler);
  const r1 = await manual.get("/hop1");
  assertEquals(r1.status, 302);
  assertEquals(r1.location, "/hop2");

  const auto = createTestClient(handler, { followRedirects: true });
  const r2 = await auto.get("/hop1");
  assertEquals(r2.status, 200);
  assertEquals(r2.text, "arrived");
  assertEquals(r2.redirects.length, 2);
});
