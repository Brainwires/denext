// `denext dashboard` — `denext ui`'s Database section behind DASHBOARD_PASSWORD — driven on
// loopback the way a browser with JavaScript disabled drives it, the `db-admin` child answered
// in-process (every envelope recorded). The security contract, one test per guard: it binds
// loopback; nothing but the login page answers without a session (a page is sent to sign in, the
// API and every POST are 401s, and no child runs); a sign-in needs a same-origin form carrying
// the login form's own token; the session cookie is HttpOnly, Secure and SameSite=Strict; failed
// sign-ins are limited per peer and overall, and while limited even the right password waits;
// the password is checked as MACs, so its length does not matter and a locked gate never says
// yes; every mutation needs the session's CSRF token and a same-origin Origin; signing out ends
// the session, as do 30 idle minutes and 12 hours; the Host must be loopback or a configured
// origin's; only the Database section is served; a body over the cap is a 413; no secret is
// rendered; and nothing writes project files.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { startUiServer, type UiServer } from "../packages/ui/src/server.ts";
import {
  DASH_COOKIE,
  DASH_LOGIN_COOKIE,
  DASH_SECURE_PREFIX,
  DashboardGate,
  dashboardLogin,
  LoginLimiter,
} from "../packages/ui/src/dashboard.ts";
import { UI_CSRF_FIELD, uiOriginAllowed } from "../src/ui/security.ts";
import { type DbChildRunner, setDbChildRunner } from "../packages/ui/src/features/database.ts";
import type { DbEnvelope, DbReply } from "../src/ui/database/protocol.ts";

const PASSWORD = "correct horse battery staple";

/** One running dashboard on a temp project, the child recorded. */
interface Dash {
  server: UiServer;
  base: string;
  dir: string;
  sent: DbEnvelope[];
  restore: () => void;
}

/** Start a dashboard (the child answers `sql` and `overview`; anything else is refused). */
async function dashboard(password: string | null = PASSWORD): Promise<Dash> {
  const dir = await Deno.makeTempDir({ prefix: "denext_dash_" });
  const sent: DbEnvelope[] = [];
  const runner: DbChildRunner = (envelope) => {
    sent.push(envelope);
    const op = envelope.request.op;
    if (op === "sql") {
      return Promise.resolve({
        ok: true,
        mode: "read",
        columns: ["n"],
        cells: [["1"]],
        rowCount: 1,
        truncated: false,
        ms: 1,
      } as DbReply);
    }
    if (op === "overview") {
      return Promise.resolve({
        ok: true,
        connection: "postgres://app:•••@db:5432/app",
        source: "env",
        storage: false,
        authSchema: null,
        tables: [],
        truncated: false,
      } as DbReply);
    }
    return Promise.resolve({ ok: false, code: "bad_request", reason: "unanswered" });
  };
  const previous = setDbChildRunner(runner);
  const server = await startUiServer({ dir, port: 0, dashboard: { password } });
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    dir,
    sent,
    restore: () => void setDbChildRunner(previous),
  };
}

/** Stop it and remove its project. */
async function stop(d: Dash): Promise<void> {
  d.restore();
  await d.server.shutdown();
  await Deno.remove(d.dir, { recursive: true });
}

/** The login form's cookie and token, as a browser gets them from `GET /login`. */
async function loginForm(d: Dash): Promise<{ cookie: string; token: string }> {
  const res = await fetch(`${d.base}/login`);
  const html = await res.text();
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${DASH_LOGIN_COOKIE}=`))!;
  const token = new RegExp(`name="${UI_CSRF_FIELD}" value="([^"]+)"`).exec(html)![1];
  return { cookie: cookie.split(";")[0], token };
}

/** Post the login form. */
async function postLogin(
  d: Dash,
  password: string,
  form: { cookie: string; token: string },
  headers: Record<string, string> = { origin: d.base },
): Promise<Response> {
  return await fetch(`${d.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: form.cookie, ...headers },
    body: new URLSearchParams({ [UI_CSRF_FIELD]: form.token, password }),
  });
}

/** Sign in: the session cookie, and the CSRF token the pages publish. */
async function signIn(d: Dash): Promise<{ cookie: string; csrf: string }> {
  const res = await postLogin(d, PASSWORD, await loginForm(d));
  await res.body?.cancel();
  assertEquals(res.status, 303);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${DASH_COOKIE}=`))!
    .split(";")[0];
  const page = await (await fetch(`${d.base}/database/sql`, { headers: { cookie } })).text();
  const csrf = /name="denext-csrf" content="([^"]+)"/.exec(page)![1];
  return { cookie, csrf };
}

/** Post a form with the session (and, unless told otherwise, its token and a same origin). */
async function post(
  d: Dash,
  path: string,
  fields: Record<string, string>,
  session: { cookie: string; csrf?: string },
  origin = d.base,
): Promise<Response> {
  const body = new URLSearchParams(fields);
  if (session.csrf) body.set(UI_CSRF_FIELD, session.csrf);
  return await fetch(`${d.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: session.cookie, origin },
    body,
  });
}

Deno.test("dashboard: binds loopback by default and links to its login page on 127.0.0.1", async () => {
  const d = await dashboard();
  try {
    assertEquals(d.server.hostname, "127.0.0.1");
    assertEquals(d.server.url, `${d.base}/login`);
  } finally {
    await stop(d);
  }
});

Deno.test("dashboard: without a session a page is sent to sign in; API and POSTs are 401s", async () => {
  const d = await dashboard();
  try {
    for (const path of ["/", "/database", "/database/sql", "/database/users", "/database/logs"]) {
      const res = await fetch(`${d.base}${path}`, { redirect: "manual" });
      await res.body?.cancel();
      assertEquals([path, res.status, res.headers.get("location")], [path, 303, "/login"]);
    }
    const api = await fetch(`${d.base}/api/database`);
    assertEquals(api.status, 401);
    await api.body?.cancel();
    const run = await post(d, "/database/sql", { sql: "drop table x", mode: "write" }, {
      cookie: "",
    });
    assertEquals(run.status, 401);
    await run.body?.cancel();
    // A forged or stale cookie is no session either.
    const forged = await fetch(`${d.base}/api/database`, {
      headers: { cookie: `${DASH_COOKIE}=${"A".repeat(43)}` },
    });
    assertEquals(forged.status, 401);
    await forged.body?.cancel();
    assertEquals(d.sent, [], "no child ran");
  } finally {
    await stop(d);
  }
});

Deno.test("dashboard over plain-http loopback: HttpOnly, SameSite=Strict, no Secure, no prefix", async () => {
  const d = await dashboard();
  try {
    const res = await postLogin(d, PASSWORD, await loginForm(d));
    await res.body?.cancel();
    assertEquals([res.status, res.headers.get("location")], [303, "/database"]);
    const set = res.headers.getSetCookie().find((c) => c.startsWith(`${DASH_COOKIE}=`))!;
    const attrs = set.split(";").map((a) => a.trim());
    for (const attr of ["HttpOnly", "SameSite=Strict", "Path=/"]) {
      assert(attrs.includes(attr), `${attr} in ${set}`);
    }
    // A browser need not bend its rules: no `Secure` on a cookie set over plain http.
    assert(!attrs.includes("Secure"), set);
    const id = attrs[0].slice(DASH_COOKIE.length + 1);
    assert(id.length >= 43, "a 256-bit session id");
    // The login form's own cookie: HttpOnly and Strict, scoped to /login, cleared at sign-in.
    const login = (await fetch(`${d.base}/login`)).headers.getSetCookie()[0];
    assertStringIncludes(login, `${DASH_LOGIN_COOKIE}=`);
    assertStringIncludes(login, "; HttpOnly; SameSite=Strict; Path=/login; Max-Age=600");
    const page = await fetch(`${d.base}/database`, { headers: { cookie: attrs[0] } });
    assertEquals(page.status, 200);
    assertStringIncludes(await page.text(), "denext\u00a0dashboard");
  } finally {
    await stop(d);
  }
});

/** The `name=value` of the Set-Cookie `name` (exactly) in `res`, with its attributes. */
function setCookie(res: Response, name: string): string[] {
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  assert(set, `${name} set (got ${res.headers.getSetCookie().join(" | ")})`);
  return set.split(";").map((a) => a.trim());
}

/** Sign in through `gate` at `origin` (the request URL the dashboard sees is `inner`). */
async function signInVia(gate: DashboardGate, inner: string, origin: string, prefix: string) {
  const form = await dashboardLogin(new Request(`${inner}/login`), new URL(`${inner}/login`), gate);
  const pre = setCookie(form, `${prefix}${DASH_LOGIN_COOKIE}`);
  const token = new RegExp(`name="${UI_CSRF_FIELD}" value="([^"]+)"`).exec(await form.text())![1];
  const post = new Request(`${inner}/login`, {
    method: "POST",
    headers: {
      // A server's request always has a Host; a constructed one needs it spelled out.
      host: new URL(inner).host,
      cookie: pre[0],
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ [UI_CSRF_FIELD]: token, password: PASSWORD }),
  });
  return { pre, res: await dashboardLogin(post, new URL(`${inner}/login`), gate) };
}

Deno.test("dashboard over https, or a TLS proxy's https --origin: __Host-, Secure, Path=/", async () => {
  // Behind a TLS proxy the dashboard sees plain http on the proxy's host; the configured
  // https origin is what makes the cookie Secure.
  const proxied = new DashboardGate({ password: PASSWORD, origins: ["https://dash.example.com"] });
  for (
    const [gate, inner, origin] of [
      [proxied, "http://dash.example.com", "https://dash.example.com"],
      [
        new DashboardGate({ password: PASSWORD }),
        "https://127.0.0.1:3100",
        "https://127.0.0.1:3100",
      ],
    ] as const
  ) {
    const { pre, res } = await signInVia(gate, inner, origin, DASH_SECURE_PREFIX);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) {
      assert(pre.includes(attr), `${attr} in the login cookie (${inner})`);
    }
    assertEquals(res.status, 303, inner);
    const session = setCookie(res, `${DASH_SECURE_PREFIX}${DASH_COOKIE}`);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) {
      assert(session.includes(attr), `${attr} in the session cookie (${inner})`);
    }
    assert(!session.some((a) => a.startsWith("Domain")), "a __Host- cookie names no Domain");
    // The session is read under its secure name only.
    const id = session[0].slice(`${DASH_SECURE_PREFIX}${DASH_COOKIE}=`.length);
    const read = (name: string) =>
      gate.session(new Request(`${inner}/database`, { headers: { cookie: `${name}=${id}` } }));
    assert(read(`${DASH_SECURE_PREFIX}${DASH_COOKIE}`));
    assertEquals(read(DASH_COOKIE), null);
  }
  // The same gate, reached on its loopback address over http, sets the plain cookie.
  const { res } = await signInVia(proxied, "http://127.0.0.1:3100", "http://127.0.0.1:3100", "");
  assert(!setCookie(res, DASH_COOKIE).includes("Secure"));
});

Deno.test("dashboard: a plain-http origin off this machine is refused at startup", async () => {
  for (const origin of ["http://dash.example.com", "http://10.0.0.5:3100"]) {
    let message = "";
    try {
      new DashboardGate({ password: PASSWORD, origins: [origin] });
    } catch (error) {
      message = (error as Error).message;
    }
    assertStringIncludes(message, "plain http", origin);
    const dir = await Deno.makeTempDir({ prefix: "denext_dash_http_" });
    try {
      let refused = false;
      try {
        const server = await startUiServer({
          dir,
          port: 0,
          dashboard: { password: PASSWORD, origins: [origin] },
        });
        await server.shutdown();
      } catch {
        refused = true;
      }
      assert(refused, `startUiServer refuses --origin ${origin}`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
  // A loopback http origin (an SSH tunnel to this machine, say) stays allowed.
  new DashboardGate({ password: PASSWORD, origins: ["http://localhost:8080"] });
});

Deno.test("dashboard: a sign-in needs the login form's token and a same-origin request", async () => {
  const d = await dashboard();
  try {
    const form = await loginForm(d);
    const cases: [string, Promise<Response>][] = [
      ["no form cookie", postLogin(d, PASSWORD, { cookie: "", token: form.token })],
      ["another form's token", postLogin(d, PASSWORD, { cookie: form.cookie, token: "x" })],
      ["a cross-site Origin", postLogin(d, PASSWORD, form, { origin: "https://evil.example" })],
      // A same-origin fetch metadata header passes the first gate; the sign-in's own Origin
      // check is what refuses a foreign Origin beside it.
      [
        "same-origin metadata, a foreign Origin",
        postLogin(d, PASSWORD, form, {
          origin: "https://evil.example",
          "sec-fetch-site": "same-origin",
        }),
      ],
      [
        "Sec-Fetch-Site: cross-site",
        postLogin(d, PASSWORD, form, { origin: d.base, "sec-fetch-site": "cross-site" }),
      ],
    ];
    for (const [label, pending] of cases) {
      const res = await pending;
      await res.body?.cancel();
      assertEquals(res.status, 403, label);
      assertEquals(res.headers.getSetCookie().some((c) => c.startsWith(`${DASH_COOKIE}=`)), false);
    }
  } finally {
    await stop(d);
  }
});

Deno.test("dashboard: failed sign-ins are rate limited; while limited even the password waits", async () => {
  const d = await dashboard();
  try {
    const form = await loginForm(d);
    for (let i = 0; i < 5; i++) {
      const wrong = await postLogin(d, `wrong ${i}`, form);
      assertEquals(wrong.status, 401);
      assert(!(await wrong.text()).includes(`wrong ${i}`), "a typed password is never echoed");
    }
    const limited = await postLogin(d, "wrong again", form);
    await limited.body?.cancel();
    assertEquals(limited.status, 429);
    assert(Number(limited.headers.get("retry-after")) > 0);
    const right = await postLogin(d, PASSWORD, form);
    await right.body?.cancel();
    assertEquals(right.status, 429, "no check runs while limited, so the limit is no oracle");
  } finally {
    await stop(d);
  }
});

Deno.test("LoginLimiter: per peer, overall, per window; a success clears only that peer", () => {
  const limiter = new LoginLimiter(2, 3, 1_000);
  limiter.fail("a", 0);
  assertEquals(limiter.retryAfter("a", 0), 0);
  limiter.fail("a", 0);
  assertEquals(limiter.retryAfter("a", 0), 1);
  assertEquals(limiter.retryAfter("b", 0), 0, "another peer still may");
  limiter.fail("b", 0);
  assertEquals(limiter.retryAfter("c", 0), 1, "the overall budget is spent");
  assertEquals(limiter.retryAfter("a", 1_001), 0, "the window passed");
  limiter.fail("a", 2_000);
  limiter.reset("a");
  assertEquals(limiter.retryAfter("a", 2_000), 0);
});

Deno.test("the password check: MACs compared, any length, never true while locked", async () => {
  const gate = new DashboardGate({ password: PASSWORD });
  assertEquals(gate.locked, false);
  assertEquals(await gate.check(PASSWORD), true);
  for (const guess of ["", "c", PASSWORD.slice(0, -1), PASSWORD + "x", "x".repeat(10_000)]) {
    assertEquals(await gate.check(guess), false, JSON.stringify(guess.slice(0, 20)));
  }
  // A missing or too-short password locks the gate: nothing — not even "" — matches.
  for (const password of [null, "", "short"]) {
    const locked = new DashboardGate({ password });
    assertEquals(locked.locked, true);
    assertEquals(await locked.check(password ?? ""), false);
  }
});

Deno.test("dashboard: every mutation needs the session's CSRF token and a same origin", async () => {
  const d = await dashboard();
  try {
    const session = await signIn(d);
    const noToken = await post(d, "/database/sql", { sql: "select 1" }, { cookie: session.cookie });
    assertEquals(noToken.status, 403);
    assertEquals((await noToken.json()).reason, "bad csrf token");
    const badToken = await post(d, "/database/sql", { sql: "select 1" }, {
      cookie: session.cookie,
      csrf: "forged",
    });
    assertEquals(badToken.status, 403);
    await badToken.body?.cancel();
    const crossSite = await post(
      d,
      "/database/sql",
      { sql: "select 1" },
      session,
      "https://evil.example",
    );
    assertEquals(crossSite.status, 403);
    await crossSite.body?.cancel();
    assertEquals(d.sent, [], "nothing ran");
    const ok = await post(d, "/database/sql", { sql: "select 1", mode: "read" }, session);
    assertEquals(ok.status, 200);
    assertStringIncludes(await ok.text(), "<td>1</td>");
    assertEquals(d.sent.map((e) => e.request), [{ op: "sql", text: "select 1", mode: "read" }]);
  } finally {
    await stop(d);
  }
});

Deno.test("dashboard: signing out ends the session (a POST with the token)", async () => {
  const d = await dashboard();
  try {
    const session = await signIn(d);
    const getOut = await fetch(`${d.base}/logout`, {
      headers: { cookie: session.cookie },
      redirect: "manual",
    });
    assertEquals(getOut.status, 405, "a GET cannot sign anyone out");
    await getOut.body?.cancel();
    const noToken = await post(d, "/logout", {}, { cookie: session.cookie });
    assertEquals(noToken.status, 403);
    await noToken.body?.cancel();
    const out = await post(d, "/logout", {}, session);
    await out.body?.cancel();
    assertEquals([out.status, out.headers.get("location")], [303, "/login"]);
    assertStringIncludes(out.headers.getSetCookie()[0], `${DASH_COOKIE}=; `);
    const after = await fetch(`${d.base}/database`, {
      headers: { cookie: session.cookie },
      redirect: "manual",
    });
    await after.body?.cancel();
    assertEquals(after.status, 303, "the old cookie is no session");
  } finally {
    await stop(d);
  }
});

Deno.test("sessions end after 30 idle minutes and 12 hours however busy", async () => {
  const gate = new DashboardGate({ password: PASSWORD });
  const req = (id: string) =>
    new Request("http://127.0.0.1/", {
      headers: { cookie: `${DASH_COOKIE}=${id}` },
    });
  const id = await gate.open(0);
  assert(gate.session(req(id), 29 * 60_000));
  assertEquals(gate.session(req(id), 60 * 60_000), null, "30 idle minutes");
  const busy = await gate.open(0);
  for (let t = 0; t < 12 * 60; t += 20) assert(gate.session(req(busy), t * 60_000));
  assertEquals(gate.session(req(busy), 12 * 60 * 60_000 + 1), null, "12 hours");
  assertEquals(gate.session(req("unknown"), 0), null);
});

Deno.test("the password is compared as two equal-length MACs, never as itself", async () => {
  const calls: [string, string][] = [];
  const record = (a: string, b: string) => {
    calls.push([a, b]);
    return a === b;
  };
  const gate = new DashboardGate({ password: PASSWORD }, new LoginLimiter(), record);
  for (const guess of ["", "x", PASSWORD, "y".repeat(5_000)]) await gate.check(guess);
  // A locked gate still does the same work.
  await new DashboardGate({ password: null }, new LoginLimiter(), record).check("anything");
  assertEquals(calls.length, 5);
  for (const [a, b] of calls) {
    assert(/^[0-9a-f]{64}$/.test(a) && /^[0-9a-f]{64}$/.test(b), "two SHA-256 MACs");
    assert(!a.includes(PASSWORD) && !b.includes(PASSWORD));
  }
});

/** A raw HTTP/1.1 GET with a Host header of our choosing (fetch always sends the real one). */
async function rawStatus(port: number, host: string, path: string): Promise<number> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    await conn.write(
      new TextEncoder().encode(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
      ),
    );
    const buf = new Uint8Array(1024);
    const n = await conn.read(buf);
    return Number(
      /^HTTP\/1\.1 (\d{3})/.exec(new TextDecoder().decode(buf.subarray(0, n ?? 0)))?.[1],
    );
  } finally {
    conn.close();
  }
}

Deno.test("dashboard: another Host is refused before the login page (DNS rebinding)", async () => {
  const d = await dashboard();
  try {
    const port = d.server.port;
    assertEquals(await rawStatus(port, `127.0.0.1:${port}`, "/login"), 200);
    assertEquals(await rawStatus(port, `localhost:${port}`, "/login"), 200);
    assertEquals(await rawStatus(port, `attacker.example:${port}`, "/login"), 403);
    assertEquals(await rawStatus(port, `attacker.example:${port}`, "/database"), 403);
  } finally {
    await stop(d);
  }
});

Deno.test("dashboard: the Host must be loopback or a configured origin's", () => {
  const gate = new DashboardGate({ password: PASSWORD, origins: ["https://dash.example.com"] });
  const allowed = (url: string, headers: Record<string, string> = {}) =>
    uiOriginAllowed(new Request(url, { headers }), new URL(url), (u) => gate.hostAllowed(u));
  assertEquals(allowed("http://127.0.0.1:3100/database"), true);
  assertEquals(allowed("http://localhost:3100/database"), true);
  assertEquals(allowed("http://dash.example.com/database"), true);
  assertEquals(allowed("http://attacker.example:3100/database"), false, "DNS rebinding");
  assertEquals(
    allowed("http://127.0.0.1:3100/database", { "sec-fetch-site": "cross-site" }),
    false,
  );
  // Behind the TLS proxy a mutation's Origin must be the public origin, not the inner http one.
  assertEquals(
    gate.canonicalOrigin(new URL("http://dash.example.com/x")),
    "https://dash.example.com",
  );
  assertEquals(gate.canonicalOrigin(new URL("http://127.0.0.1:3100/x")), "http://127.0.0.1:3100");
  let threw = false;
  try {
    new DashboardGate({ password: PASSWORD, origins: ["ftp://x"] });
  } catch {
    threw = true;
  }
  assert(threw, "only an http(s) origin");
});

Deno.test("dashboard: only the Database section is served — nothing that runs the project", async () => {
  const d = await dashboard();
  try {
    const { cookie } = await signIn(d);
    for (const path of ["/config", "/plugins", "/generate", "/tasks", "/dev", "/commands"]) {
      const res = await fetch(`${d.base}${path}`, { headers: { cookie } });
      await res.body?.cancel();
      assertEquals(res.status, 404, path);
    }
    const run = await post(d, "/tasks/run", { task: "x" }, await signIn(d));
    assertEquals(run.status, 404);
    await run.body?.cancel();
    const page = await (await fetch(`${d.base}/database`, { headers: { cookie } })).text();
    for (const href of ["/config/routing", "/plugins", "/tasks", "/dev", "/commands"]) {
      assert(!page.includes(`href="${href}"`), `no link to ${href}`);
    }
  } finally {
    await stop(d);
  }
});

Deno.test("dashboard: locked without a password — the page says how, a sign-in is a 503", async () => {
  for (const password of [null, "too-short"]) {
    const d = await dashboard(password);
    try {
      const page = await (await fetch(`${d.base}/login`)).text();
      assertStringIncludes(page, "denext stack passwd --dashboard");
      const res = await postLogin(d, password ?? "", await loginForm(d));
      await res.body?.cancel();
      assertEquals(res.status, 503);
    } finally {
      await stop(d);
    }
  }
});

Deno.test("dashboard: no secret is rendered, and nothing writes project files", async () => {
  const d = await dashboard();
  try {
    const session = await signIn(d);
    for (const path of ["/database", "/database/sql", "/database/policies"]) {
      const body = await (await fetch(`${d.base}${path}`, { headers: { cookie: session.cookie } }))
        .text();
      assert(!body.includes(PASSWORD), `${path} never shows the password`);
      assert(!/postgres:\/\/[^:]+:[^•@\s]+@/.test(body), `${path} masks a connection password`);
    }
    const rls = await post(d, "/database/policies", { op: "apply", schema: "public", table: "t" }, {
      ...session,
    });
    assertEquals(rls.status, 501, "enabling RLS writes a migration file: not from the dashboard");
    await rls.body?.cancel();
    const files = [];
    for await (const entry of Deno.readDir(d.dir)) files.push(entry.name);
    assertEquals(files, []);
  } finally {
    await stop(d);
  }
});

Deno.test("dashboard: a body over the cap is a 413 before anything parses it", async () => {
  const d = await dashboard();
  try {
    const session = await signIn(d);
    const res = await fetch(`${d.base}/api/database/sql`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: d.base,
        "content-type": "application/json",
        "x-denext-ui-csrf": session.csrf,
      },
      body: new Uint8Array(16 * 1024 * 1024 + 1),
    });
    assertEquals(res.status, 413);
    await res.body?.cancel();
    assertEquals(d.sent, []);
  } finally {
    await stop(d);
  }
});

Deno.test("dashboard: Realtime, Edge Functions and Health sit behind the same gate", async () => {
  const d = await dashboard();
  try {
    for (
      const path of [
        "/database/realtime",
        "/database/realtime/presence?topic=lobby",
        "/database/functions",
        "/database/health",
      ]
    ) {
      const res = await fetch(`${d.base}${path}`, { redirect: "manual" });
      await res.body?.cancel();
      assertEquals([path, res.status, res.headers.get("location")], [path, 303, "/login"]);
    }
    const api = await fetch(`${d.base}/api/database/health`);
    assertEquals(api.status, 401);
    await api.body?.cancel();
    const session = await signIn(d);
    const page = await fetch(`${d.base}/database/health`, { headers: { cookie: session.cookie } });
    assertEquals(page.status, 200);
    assertStringIncludes(await page.text(), 'href="/database/health" aria-current="page"');
    const forged = await post(d, "/database/realtime", {
      op: "apply",
      action: "add",
      schema: "public",
      table: "t",
    }, { cookie: session.cookie });
    assertEquals(forged.status, 403, "the opt-in needs the CSRF token");
    await forged.body?.cancel();
    assertEquals(d.sent.filter((e) => e.request.op === "realtimePublication"), []);
  } finally {
    await stop(d);
  }
});

Deno.test("dashboard: no event stream — the page tells ui.js not to open one", async () => {
  const d = await dashboard();
  try {
    const session = await signIn(d);
    const page = await (await fetch(`${d.base}/database`, { headers: { cookie: session.cookie } }))
      .text();
    assertStringIncludes(page, '<meta name="denext-events" content="off">');
    const stream = await fetch(`${d.base}/_ui/events`, { headers: { cookie: session.cookie } });
    assertEquals(stream.status, 404, "the dashboard routes no /_ui/events");
    await stream.body?.cancel();
    const script =
      await (await fetch(`${d.base}/_ui/ui.js`, { headers: { cookie: session.cookie } }))
        .text();
    // The EventSource is opened only when the page does not say "off".
    assertStringIncludes(
      script,
      `document.querySelector('meta[name="denext-events"]')?.content === "off"`,
    );
    assert(!/^const events = new EventSource/m.test(script), "never opened unconditionally");
  } finally {
    await stop(d);
  }
  // denext ui keeps its stream: its pages carry no such meta.
  const dir = await Deno.makeTempDir({ prefix: "denext_dash_events_" });
  const ui = await startUiServer({ dir, port: 0 });
  try {
    const res = await fetch(ui.url, { redirect: "manual" });
    await res.body?.cancel();
    const cookie = res.headers.getSetCookie()[0].split(";")[0];
    const home = await (await fetch(`http://127.0.0.1:${ui.port}/`, { headers: { cookie } }))
      .text();
    assert(!home.includes("denext-events"));
  } finally {
    await ui.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});
