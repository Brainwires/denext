// `@denext/backend` Edge Functions: options, discovery, and the request path through the real
// pipeline — each function in a Deno Worker of its own, loaded the way Supabase's edge runtime
// loads it (`Deno.serve(handler)` in any call shape, or a default-exported handler), JWT
// verification on by default (today: denext auth's session), `verifyJwt: false`, the CORS
// preflight passed through, the CSRF rule for cookie writes, sub-paths, env, streaming, the body
// cap, the wall-clock limit, and a worker that throws or fails to boot.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  discoverFunctions,
  FunctionHost,
  functionsDir,
  resolveFunctions,
} from "../packages/backend/src/functions.ts";
import { backend } from "../packages/backend/mod.ts";
import { applyPlugins, resetPlugins } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { cookieFor, functionsApp } from "./_functions-app.ts";

const USER = "6d1c4c6e-7a1e-4d43-9a0f-3c1f0c0a0001";

const ECHO = `
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const type = req.headers.get("content-type") ?? "";
  let body = null;
  if (type.startsWith("application/json")) body = await req.json();
  else if (type.startsWith("multipart/form-data")) body = Object.fromEntries(await req.formData());
  else if (req.method !== "GET" && req.method !== "HEAD") body = await req.text();
  return Response.json({
    method: req.method,
    path: url.pathname,
    search: url.search,
    type,
    body,
    region: req.headers.get("x-region"),
    supabaseUrl: Deno.env.get("SUPABASE_URL"),
    greeting: Deno.env.get("GREETING") ?? null,
    hasPath: Deno.env.has("PATH"),
  });
});
`;

Deno.test("resolveFunctions: defaults and validation", () => {
  const resolved = resolveFunctions({});
  assertEquals(
    [resolved.basePath, resolved.verifyJwt, resolved.timeoutMs, resolved.maxBodyBytes],
    ["/functions/v1", true, 150_000, 20 * 1024 * 1024],
  );
  assertEquals(resolveFunctions({ basePath: "/fn/", url: "https://x.test/" }).basePath, "/fn");
  assertEquals(resolveFunctions({ url: "https://x.test/" }).url, "https://x.test");
  assertThrows(() => resolveFunctions({ basePath: "fn" }), TypeError);
  assertThrows(() => resolveFunctions({ dir: "" }), TypeError);
  assertThrows(() => resolveFunctions({ functions: { "bad name": {} } }), TypeError);
  assertThrows(() => resolveFunctions({ timeoutMs: 0 }), TypeError);
  assertThrows(
    () => resolveFunctions({ functions: { a: { timeoutMs: -1 } } }),
    TypeError,
  );
  assertThrows(
    () => resolveFunctions({ env: { A: 1 as unknown as string } }),
    TypeError,
  );
  assertThrows(
    () =>
      resolveFunctions({ functions: { a: { env: null as unknown as Record<string, string> } } }),
    TypeError,
  );
  const per = resolveFunctions({ functions: { a: { verifyJwt: false, timeoutMs: 5 } } });
  assertEquals(per.functions.a, { verifyJwt: false, timeoutMs: 5, env: {} });
});

Deno.test("discoverFunctions: <name>.ts, <name>/index.ts; _shared, tests and bad names skipped", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/hello`);
    await Deno.writeTextFile(`${dir}/hello/index.ts`, "");
    await Deno.mkdir(`${dir}/js-one`);
    await Deno.writeTextFile(`${dir}/js-one/index.js`, "");
    await Deno.mkdir(`${dir}/empty`);
    await Deno.mkdir(`${dir}/_shared`);
    await Deno.writeTextFile(`${dir}/_shared/cors.ts`, "");
    await Deno.writeTextFile(`${dir}/plain.ts`, "");
    await Deno.writeTextFile(`${dir}/plain.test.ts`, "");
    await Deno.writeTextFile(`${dir}/types.d.ts`, "");
    await Deno.writeTextFile(`${dir}/README.md`, "");
    await Deno.writeTextFile(`${dir}/.hidden.ts`, "");
    await Deno.writeTextFile(`${dir}/bad name.ts`, "");
    const found = await discoverFunctions(dir);
    assertEquals([...found.keys()], ["hello", "js-one", "plain"]);
    assertEquals(found.get("hello"), `${dir}/hello/index.ts`);
    assertEquals((await discoverFunctions(`${dir}/missing`)).size, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("functionsDir: configured, functions/, then supabase/functions/", async () => {
  const root = await Deno.makeTempDir();
  try {
    assertEquals(await functionsDir(root, undefined), `${root}/functions`);
    assertEquals(await functionsDir(root, "edge"), `${root}/edge`);
    await Deno.mkdir(`${root}/supabase/functions`, { recursive: true });
    assertEquals(await functionsDir(root, undefined), `${root}/supabase/functions`);
    await Deno.mkdir(`${root}/functions`);
    assertEquals(await functionsDir(root, undefined), `${root}/functions`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "functions: invoke shapes, JWT verification, CORS preflight, CSRF, sub-paths and env",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const app = await functionsApp({
      "functions/echo/index.ts": ECHO,
      "functions/open.ts": `export default (req: Request) => new Response("open " + req.method);`,
      "functions/obj.ts": `export default { fetch: (_req: Request) => new Response("obj") };`,
      "functions/opts.ts": `Deno.serve({ port: 1234 }, () => new Response("opts"));`,
      "functions/handler-opt.ts": `Deno.serve({ handler: () => new Response("handler-opt") });`,
      "functions/cors.ts": `
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type" };
Deno.serve((req) => req.method === "OPTIONS"
  ? new Response("ok", { headers: cors })
  : new Response("hi", { headers: cors }));`,
      "functions/_shared/util.ts": `export const x = 1;`,
    }, {
      functions: {
        env: { GREETING: "hello" },
        functions: { open: { verifyJwt: false }, obj: { verifyJwt: false } },
      },
    });
    try {
      const cookie = await cookieFor(USER);
      // No identity: 401 before the function runs.
      const denied = await app.call("/functions/v1/echo", { method: "POST", body: "x" });
      assertEquals(denied.status, 401);
      assertEquals((await denied.json()).code, "UNAUTHORIZED");
      // Signed in: JSON body, the URL the function sees, x-region, env.
      const echoed = await app.call("/functions/v1/echo/sub/path?q=1", {
        method: "POST",
        cookie,
        headers: { "content-type": "application/json", "x-region": "us-east-1" },
        body: JSON.stringify({ a: 1 }),
      });
      assertEquals(echoed.status, 200);
      const got = await echoed.json();
      assertEquals(got.method, "POST");
      assertEquals(got.path, "/echo/sub/path");
      assertEquals(got.search, "?q=1");
      assertEquals(got.body, { a: 1 });
      assertEquals(got.region, "us-east-1");
      assertEquals(got.supabaseUrl, "https://app.test");
      assertEquals(got.greeting, "hello");
      assertEquals(got.hasPath, true);
      // Text and form bodies.
      const text = await (await app.call("/functions/v1/echo", {
        method: "POST",
        cookie,
        headers: { "content-type": "text/plain" },
        body: "plain",
      })).json();
      assertEquals(text.body, "plain");
      const form = new FormData();
      form.set("field", "value");
      const formed = await (await app.call("/functions/v1/echo", {
        method: "POST",
        cookie,
        body: form,
      })).json();
      assertEquals(formed.body, { field: "value" });
      // GET carries no body.
      const got2 = await (await app.call("/functions/v1/echo", { cookie })).json();
      assertEquals([got2.method, got2.body], ["GET", null]);
      // A cross-site write riding the cookie is refused.
      const csrf = await app.call("/functions/v1/echo", {
        method: "POST",
        cookie,
        crossSite: true,
        body: "x",
      });
      assertEquals(csrf.status, 403);
      await csrf.body?.cancel();
      // verifyJwt: false — anyone, any method; the default-export shapes.
      assertEquals(
        await (await app.call("/functions/v1/open", { method: "DELETE" })).text(),
        "open DELETE",
      );
      assertEquals(await (await app.call("/functions/v1/obj")).text(), "obj");
      // Deno.serve(options, handler) and Deno.serve({ handler }).
      assertEquals(await (await app.call("/functions/v1/opts", { cookie })).text(), "opts");
      assertEquals(
        await (await app.call("/functions/v1/handler-opt", { cookie })).text(),
        "handler-opt",
      );
      // A preflight is never JWT-checked: the function answers it.
      const preflight = await app.call("/functions/v1/cors", {
        method: "OPTIONS",
        headers: { "access-control-request-method": "POST" },
      });
      assertEquals(preflight.status, 200);
      assertEquals(preflight.headers.get("access-control-allow-origin"), "*");
      await preflight.body?.cancel();
      // Unknown functions, private entries and malformed names are 404s.
      for (
        const path of ["/functions/v1/nope", "/functions/v1/_shared", "/functions/v1/%E0%A4%A"]
      ) {
        const missing = await app.call(path, { cookie });
        assertEquals(missing.status, 404, path);
        assertEquals((await missing.json()).code, "NOT_FOUND");
      }
      // Other paths pass through to the app.
      assertEquals((await app.call("/functions/v2/echo")).status, 404);
    } finally {
      await app.close();
    }
  },
});

Deno.test({
  name: "functions: streaming, body cap, timeout, throwing handler, boot failure, crash recovery",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const app = await functionsApp({
      "functions/stream.ts": `
Deno.serve(() => {
  let n = 0;
  const body = new ReadableStream({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, 5));
      if (n === 3) return controller.close();
      controller.enqueue(new TextEncoder().encode("data: " + n++ + "\\n\\n"));
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
});`,
      "functions/slow.ts": `
export default async (req: Request) => {
  await new Promise((resolve) => { const t = setTimeout(resolve, 5000); req.signal.addEventListener("abort", () => { clearTimeout(t); resolve(null); }); });
  return new Response("late");
};`,
      "functions/throws.ts": `Deno.serve(() => { throw new Error("boom"); });`,
      "functions/on-error.ts":
        `Deno.serve({ handler: () => { throw new Error("x"); }, onError: () => new Response("handled", { status: 418 }) });`,
      "functions/not-response.ts": `export default () => "nope";`,
      "functions/no-handler.ts": `export const x = 1;`,
      "functions/bad-import.ts": `import "./missing.ts"; Deno.serve(() => new Response("x"));`,
      "functions/crash.ts": `
let calls = 0;
Deno.serve((req) => {
  calls++;
  if (new URL(req.url).searchParams.has("crash")) {
    setTimeout(() => { throw new Error("uncaught"); }, 0);
    return new Promise(() => {});
  }
  return new Response("calls " + calls);
});`,
      "functions/empty.ts": `Deno.serve(() => new Response(null, { status: 204 }));`,
    }, {
      functions: {
        verifyJwt: false,
        maxBodyBytes: 16,
        functions: { slow: { timeoutMs: 100 } },
      },
    });
    try {
      const streamed = await app.call("/functions/v1/stream");
      assertEquals(streamed.headers.get("content-type"), "text/event-stream");
      assertEquals(await streamed.text(), "data: 0\n\ndata: 1\n\ndata: 2\n\n");
      const big = await app.call("/functions/v1/stream", { method: "POST", body: "x".repeat(64) });
      assertEquals(big.status, 413);
      await big.body?.cancel();
      const slow = await app.call("/functions/v1/slow");
      assertEquals(slow.status, 504);
      assertEquals((await slow.json()).code, "WORKER_TIMEOUT");
      const thrown = await app.call("/functions/v1/throws");
      assertEquals(thrown.status, 500);
      assertEquals((await thrown.json()).code, "WORKER_ERROR");
      assertEquals((await app.call("/functions/v1/on-error")).status, 418);
      assertEquals((await app.call("/functions/v1/not-response")).status, 500);
      for (const name of ["no-handler", "bad-import"]) {
        const boot = await app.call(`/functions/v1/${name}`);
        assertEquals(boot.status, 503, name);
        assertEquals((await boot.json()).code, "BOOT_ERROR");
      }
      assertEquals(await (await app.call("/functions/v1/crash")).text(), "calls 1");
      const crashed = await app.call("/functions/v1/crash?crash");
      assertEquals(crashed.status, 500);
      await crashed.body?.cancel();
      // A fresh worker: its module state starts over.
      assertEquals(await (await app.call("/functions/v1/crash")).text(), "calls 1");
      const empty = await app.call("/functions/v1/empty");
      assertEquals([empty.status, empty.body], [204, null]);
    } finally {
      await app.close();
    }
  },
});

Deno.test({
  name: "functions: a client that goes away aborts the function's request",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const app = await functionsApp({
      // `?until=S/A` answers once the function has seen S requests start and A of them aborted
      // (a long poll inside the worker), so the test waits on the events themselves, not a clock.
      "functions/wait.ts": `
let started = 0;
let aborted = 0;
const waiters = [];
const changed = () => { for (const wake of waiters.splice(0)) wake(); };
const state = () => started + "/" + aborted;
Deno.serve(async (req) => {
  const params = new URL(req.url).searchParams;
  if (params.has("count")) return new Response(state());
  const until = params.get("until");
  if (until !== null) {
    const [s, a] = until.split("/").map(Number);
    while (started < s || aborted < a) await new Promise((wake) => waiters.push(wake));
    return new Response(state());
  }
  started++;
  changed();
  await new Promise((resolve) =>
    req.signal.addEventListener("abort", () => { aborted++; changed(); resolve(null); })
  );
  return new Response("done");
});`,
    }, { functions: { verifyJwt: false, timeoutMs: 60_000 } });
    try {
      const count = async () => await (await app.call("/functions/v1/wait?count")).text();
      const until = async (want: string) =>
        assertEquals(await (await app.call(`/functions/v1/wait?until=${want}`)).text(), want);
      const controller = new AbortController();
      const pending = app.call("/functions/v1/wait", { signal: controller.signal });
      await until("1/0"); // the function is running
      controller.abort();
      const res = await pending.catch(() => null);
      if (res) await res.body?.cancel().catch(() => {});
      await until("1/1"); // the abort reached the function's `req.signal`
      // A request already aborted never reaches the function.
      const gone = new AbortController();
      gone.abort();
      const skipped = await app.call("/functions/v1/wait", { signal: gone.signal }).catch(() =>
        null
      );
      if (skipped) await skipped.body?.cancel().catch(() => {});
      assertEquals(await count(), "1/1");
    } finally {
      await app.close();
    }
  },
});

Deno.test({
  name: "functions: dev restarts workers after an edit and finds new functions",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const app = await functionsApp(
      {
        "functions/v.ts": `Deno.serve(() => new Response("one"));`,
      },
      { functions: { verifyJwt: false } },
      "dev",
    );
    try {
      assertEquals(await (await app.call("/functions/v1/v")).text(), "one");
      await Deno.writeTextFile(
        `${app.root}/functions/v.ts`,
        `Deno.serve(() => new Response("two"));`,
      );
      await Deno.writeTextFile(
        `${app.root}/functions/w.ts`,
        `Deno.serve(() => new Response("w"));`,
      );
      let text = "";
      for (let i = 0; i < 50 && text !== "two"; i++) {
        await new Promise((r) => setTimeout(r, 100));
        text = await (await app.call("/functions/v1/v")).text();
      }
      assertEquals(text, "two");
      assertEquals(await (await app.call("/functions/v1/w")).text(), "w");
    } finally {
      await app.close();
    }
  },
});

Deno.test("functions: permissions need Deno's worker options in deno.json", async () => {
  const root = await Deno.makeTempDir();
  const load = ((path: string) => import(path)) as unknown as ModuleLoader;
  try {
    resetPlugins();
    const config = {
      plugins: [backend({ functions: { functions: { a: { permissions: "none" } } } })],
    } as DenextConfig;
    await assertRejects(
      () => applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "prod", load }),
      TypeError,
      "worker-options",
    );
    resetPlugins();
    await Deno.writeTextFile(`${root}/deno.json`, `{ "unstable": ["worker-options"] }`);
    await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "prod", load });
  } finally {
    resetPlugins();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "FunctionHost: a worker's permissions are passed to the Worker constructor",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const seen: unknown[] = [];
    const host = new FunctionHost("p", "/tmp/p.ts", { net: false }, (url, options) => {
      seen.push(options);
      return new Worker(url, { type: "module" });
    });
    const response = await host.call(
      { url: "https://x.test/p", method: "GET", headers: [], body: null },
      {},
      1000,
    );
    assertEquals(response.status, 503); // /tmp/p.ts does not exist
    await response.body?.cancel();
    assert(!host.running);
    assertStringIncludes(JSON.stringify(seen[0]), `"permissions":{"net":false}`);
    host.stop();
  },
});

Deno.test({
  name: "denext generate function: the scaffold runs as an Edge Function",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const app = await functionsApp({}, { functions: { verifyJwt: false } }, "dev");
    try {
      const { generateArtifact } = await import("../src/build/generate.ts");
      const { written } = await generateArtifact(app.root, "function", "hello-world");
      assertEquals(written, [`${app.root}/functions/hello-world/index.ts`]);
      await assertRejects(() => generateArtifact(app.root, "function", "a/b"), Error, "slug");
      const res = await app.call("/functions/v1/hello-world", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "denext" }),
      });
      assertEquals(await res.json(), { message: "Hello denext!" });
      const preflight = await app.call("/functions/v1/hello-world", { method: "OPTIONS" });
      assertEquals(preflight.headers.get("access-control-allow-origin"), "*");
      await preflight.body?.cancel();
    } finally {
      await app.close();
    }
  },
});

Deno.test("denext functions list: names, routes, files and verifyJwt", async () => {
  const { createFunctionsCommand, listFunctions } = await import(
    "../packages/backend/src/functions-command.ts"
  );
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/functions/hello`, { recursive: true });
    await Deno.writeTextFile(`${root}/functions/hello/index.ts`, "");
    await Deno.writeTextFile(`${root}/functions/hook.ts`, "");
    const config = resolveFunctions({ functions: { hook: { verifyJwt: false } } });
    assertEquals(await listFunctions(root, config), [
      {
        name: "hello",
        path: "functions/hello/index.ts",
        route: "/functions/v1/hello",
        verifyJwt: true,
      },
      { name: "hook", path: "functions/hook.ts", route: "/functions/v1/hook", verifyJwt: false },
    ]);
    const lines: string[] = [];
    const errors: string[] = [];
    let code = 0;
    const io = {
      log: (l: string) => lines.push(l),
      error: (l: string) => errors.push(l),
      exit: (c: number) => (code = c),
    };
    const command = createFunctionsCommand(config, io);
    const run = (positionals: string[], flags: Record<string, boolean> = {}, cwd = root) =>
      command.run({ positionals, flags, global: { cwd } as never, rest: [] });
    await run(["list"]);
    assertStringIncludes(lines.join("\n"), "hook");
    assertStringIncludes(lines.join("\n"), "(public)");
    lines.length = 0;
    await run([], { json: true });
    assertEquals(JSON.parse(lines.join("\n")).length, 2);
    lines.length = 0;
    await run(["list"], {}, `${root}/functions/hello`);
    assertStringIncludes(lines[0], "No Edge Functions");
    await run(["sideways"]);
    assertEquals(code, 1);
    assertStringIncludes(errors[0], "unknown action");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name: "denext functions new / serve / delete / download / deploy",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { createFunctionsCommand } = await import(
      "../packages/backend/src/functions-command.ts"
    );
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${root}/supabase/functions`, { recursive: true });
      const config = resolveFunctions({ verifyJwt: false });
      const lines: string[] = [];
      const errors: string[] = [];
      let answered = "";
      const io = {
        log: (l: string) => lines.push(l),
        error: (l: string) => errors.push(l),
        exit: () => {},
        wait: async (server: Deno.HttpServer<Deno.NetAddr>) => {
          const { port } = server.addr;
          const res = await fetch(`http://127.0.0.1:${port}/functions/v1/hello`, {
            method: "POST",
            body: JSON.stringify({ name: "serve" }),
          });
          answered = await res.text();
          const missing = await fetch(`http://127.0.0.1:${port}/other`);
          assertEquals(missing.status, 404);
          await missing.body?.cancel();
          await server.shutdown();
        },
      };
      const command = createFunctionsCommand(config, io);
      const run = (positionals: string[], flags: Record<string, unknown> = {}) =>
        command.run({ positionals, flags, global: { cwd: root } as never, rest: [] } as never);
      // `new` writes into the project's functions directory (supabase/functions here).
      await run(["new", "hello"]);
      assertEquals(lines[0], "Created supabase/functions/hello/index.ts (/functions/v1/hello)");
      assertStringIncludes(
        await Deno.readTextFile(`${root}/supabase/functions/hello/index.ts`),
        "Deno.serve",
      );
      await run(["new", "hello"]);
      assertStringIncludes(errors.at(-1)!, "denext functions new");
      await run(["new", "bad name"]);
      assertStringIncludes(errors.at(-1)!, "slug");
      // `serve`: only the functions host, on its own port.
      await run(["serve"], { port: 0 });
      assertStringIncludes(lines.at(-1)!, "Serving /functions/v1/<name> at http://127.0.0.1:");
      assertEquals(JSON.parse(answered), { message: "Hello serve!" });
      // download / deploy: nothing to do.
      await run(["deploy"]);
      assertStringIncludes(errors.at(-1)!, "ship inside the app");
      await run(["download"]);
      assertStringIncludes(errors.at(-1)!, "no hosted platform");
      // delete
      await run(["delete", "hello"]);
      assertStringIncludes(errors.at(-1)!, "--yes");
      await run(["delete", "nope"], { yes: true });
      assertStringIncludes(errors.at(-1)!, "no function named");
      await run(["delete", "hello"], { yes: true });
      assertEquals(lines.at(-1), "Deleted supabase/functions/hello");
      await Deno.writeTextFile(`${root}/supabase/functions/solo.ts`, "export default () => 1;");
      await run(["delete", "solo"], { yes: true });
      assertEquals(lines.at(-1), "Deleted supabase/functions/solo.ts");
      assertEquals([...Deno.readDirSync(`${root}/supabase/functions`)], []);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "functions: with Supabase keys, the anon key passes; a refused credential is a 401",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const KEY = "sb_publishable_functions_unit_key_000000";
    const app = await functionsApp(
      { "functions/me.ts": `Deno.serve(() => new Response("ok"));` },
      {
        supabase: { publishableKey: KEY, jwtSecret: "functions-unit-jwt-secret-at-least-32-chars" },
        functions: {},
      },
    );
    try {
      assertEquals(
        await (await app.call("/functions/v1/me", { headers: { apikey: KEY } })).text(),
        "ok",
      );
      const forged = await app.call("/functions/v1/me", {
        headers: { apikey: KEY, authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad" },
      });
      assertEquals(forged.status, 401);
      await forged.body?.cancel();
      const none = await app.call("/functions/v1/me");
      assertEquals([none.status, (await none.json()).message], [
        401,
        "Missing authorization header",
      ]);
    } finally {
      await app.close();
    }
  },
});

Deno.test({
  name: "FunctionHost.retire: in-flight requests finish, then the worker stops",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        `${dir}/slow.ts`,
        `Deno.serve(async () => { await new Promise((r) => setTimeout(r, 200)); return new Response("late"); });`,
      );
      const host = new FunctionHost("slow", `${dir}/slow.ts`, undefined);
      const call = { url: "https://x.test/slow", method: "GET", headers: [], body: null };
      // Retired while it is still starting: the call waits for it, then it stops.
      const first = host.call(call, {}, 5000);
      host.retire();
      assert(host.running, "still serving");
      assertEquals(await (await first).text(), "late");
      assert(!host.running, "stopped after the last request");
      const idle = new FunctionHost("slow", `${dir}/slow.ts`, undefined);
      idle.retire();
      assert(!idle.running);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "FunctionHost: a worker busy in synchronous code is replaced after a timeout; a cooperative one is kept",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir();
    const spawned: Worker[] = [];
    const terminated: Worker[] = [];
    let acked: () => void = () => {};
    try {
      await Deno.writeTextFile(
        `${dir}/spin.ts`,
        `
let calls = 0;
Deno.serve(async (req) => {
  calls++;
  const params = new URL(req.url).searchParams;
  if (params.has("spin")) while (true) { /* a busy loop: never yields */ }
  if (params.has("wait")) {
    await new Promise((resolve) => req.signal.addEventListener("abort", resolve));
    return new Response("aborted");
  }
  return new Response("calls " + calls);
});`,
      );
      const host = new FunctionHost("spin", `${dir}/spin.ts`, undefined, (url, options) => {
        const worker = new Worker(url, options);
        spawned.push(worker);
        worker.addEventListener("message", (event) => {
          if ((event as MessageEvent).data?.t === "aborted") acked();
        });
        const terminate = worker.terminate.bind(worker);
        worker.terminate = () => {
          terminated.push(worker);
          terminate();
        };
        return worker;
      });
      const req = (query: string) => ({
        url: `https://x.test/spin${query}`,
        method: "GET",
        headers: [] as [string, string][],
        body: null,
      });

      // A cooperative function that times out acknowledges the abort: its worker is kept.
      const ack = new Promise<void>((resolve) => acked = resolve);
      const waited = await host.call(req("?wait"), {}, 100);
      assertEquals([waited.status, (await waited.json()).code], [504, "WORKER_TIMEOUT"]);
      await ack;
      assertEquals(await (await host.call(req(""), {}, 5000)).text(), "calls 2");
      assertEquals([spawned.length, terminated.length], [1, 0]);

      // `while (true) {}` cannot answer: after the grace period the worker is terminated, and a
      // request queued behind the loop fails with the timeout too.
      const spinning = host.call(req("?spin"), {}, 100);
      const queued = host.call(req(""), {}, 60_000);
      const spun = await spinning;
      assertEquals([spun.status, (await spun.json()).code], [504, "WORKER_TIMEOUT"]);
      const behind = await queued;
      assertEquals([behind.status, (await behind.json()).code], [504, "WORKER_TIMEOUT"]);
      assertEquals(terminated, [spawned[0]]);
      assert(!host.running, "the busy worker is gone");

      // The next call gets a fresh worker (its module state starts over).
      assertEquals(await (await host.call(req(""), {}, 5000)).text(), "calls 1");
      assertEquals(spawned.length, 2);
      host.stop();
      assertEquals(terminated, spawned);
    } finally {
      for (const worker of spawned) worker.terminate();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
