// Typed API client (src/build/api-types.ts + src/runtime/api-client.ts).
//
// Two halves:
//   1. The GENERATOR reconstructs each route handler's TypedRequest/TypedResponse body
//      types (via `deno doc`) into an `ApiSchema`. We assert the emitted source, then
//      `deno check` a real consumer to prove the schema type-checks a correct call AND
//      rejects the mistakes it's meant to catch (unknown path, wrong body, missing params).
//   2. The RUNTIME (`buildPath` / `apiRequest` / `createApiClient`) does param substitution
//      and the fetch round-trip — driven against a tiny in-process handler, no browser.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { scanRoutes } from "../src/router/manifest.ts";
import { generateApiTypes } from "../src/build/api-types.ts";
import { apiRequest, buildPath, createApiClient } from "../src/runtime/api-client.ts";

const REPO_CONFIG = new URL("../deno.json", import.meta.url).pathname;

/** Write a set of `{ relPath: source }` files under a fresh temp app dir. */
async function makeApp(files: Record<string, string>): Promise<{ dir: string; outDir: string }> {
  const dir = await Deno.makeTempDir({ prefix: "denext-api-types-" });
  const outDir = join(dir, ".denext");
  await Deno.mkdir(outDir, { recursive: true });
  for (const [rel, src] of Object.entries(files)) {
    const abs = join(dir, rel);
    await Deno.mkdir(join(abs, ".."), { recursive: true });
    await Deno.writeTextFile(abs, src);
  }
  return { dir, outDir };
}

/** Generate `.denext/api.ts` for a temp app and return the emitted source. */
async function generateFor(dir: string, outDir: string): Promise<string> {
  const manifest = await scanRoutes(join(dir, "app"));
  const src = await generateApiTypes(manifest, { outDir, configPath: REPO_CONFIG });
  await Deno.writeTextFile(join(outDir, "api.ts"), src);
  return src;
}

/** `deno check` one source file; resolve to its exit code (0 = type-checks clean). */
async function denoCheck(file: string): Promise<number> {
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: ["check", "--config", REPO_CONFIG, file],
    stdout: "null",
    stderr: "null",
  }).output();
  return code;
}

const HELLO_ROUTE = `
import { json, type TypedResponse } from "denext/server";
export function GET(): TypedResponse<{ message: string; runtime: "deno" }> {
  return json({ message: "hi", runtime: "deno" });
}
`;

const USER_ROUTE = `
import { json, type TypedRequest, type TypedResponse } from "denext/server";
export interface User { id: string; name?: string; tags: string[] }
export function GET(): TypedResponse<{ user: User; next: string | null }> {
  return json({ user: { id: "1", tags: [] }, next: null });
}
export async function POST(req: TypedRequest<{ name: string }>): Promise<TypedResponse<{ ok: true }>> {
  await req.json();
  return json({ ok: true }, { status: 201 });
}
export function DELETE(): Response { return new Response(null, { status: 204 }); }
`;

Deno.test("generateApiTypes: reconstructs params, request/response bodies, and 'unknown' for plain Response", async () => {
  const { dir, outDir } = await makeApp({
    "app/api/hello/route.ts": HELLO_ROUTE,
    "app/api/user/[id]/route.ts": USER_ROUTE,
  });
  try {
    const src = await generateFor(dir, outDir);
    // A `type` alias (not interface) so keyof stays literal yet satisfies the Record constraint.
    assertStringIncludes(src, "export type ApiSchema = {");
    // Static route: response body only, no params.
    assertStringIncludes(src, `"/api/hello": {`);
    assertStringIncludes(src, `GET: { response: { message: string; runtime: "deno" } };`);
    // Dynamic route: params inferred from the pattern; request + response bodies recovered.
    assertStringIncludes(src, `"/api/user/[id]": {`);
    assertStringIncludes(
      src,
      `POST: { params: { id: string }; body: { name: string }; response: { ok: true } };`,
    );
    // A nullable union renders as a union; a plain `Response` handler is `response: unknown`.
    assertStringIncludes(src, "next: string | null");
    assertStringIncludes(src, `DELETE: { params: { id: string }; response: unknown };`);
    // A named, exported local type is re-imported (aliased) rather than lost.
    assert(/import type \{ User as \w+ \} from/.test(src), "exported local type is imported");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generateApiTypes: renders arrays, nested objects, optional props, and index signatures", async () => {
  const { dir, outDir } = await makeApp({
    "app/api/shapes/route.ts": `
import { json, type TypedResponse } from "denext/server";
export function GET(): TypedResponse<{
  items: { id: number }[];
  meta?: { total: number };
  byId: { [key: string]: string };
}> {
  return json({ items: [], byId: {} });
}
`,
  });
  try {
    const src = await generateFor(dir, outDir);
    assertStringIncludes(src, "items: { id: number }[]");
    assertStringIncludes(src, "meta?: { total: number }");
    assertStringIncludes(src, "[key: string]: string");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generateApiTypes: empty when an app has no route handlers", async () => {
  const { dir, outDir } = await makeApp({
    "app/page.tsx": "export default function P() { return null; }",
  });
  try {
    const src = await generateFor(dir, outDir);
    assertStringIncludes(src, "// (no route handlers)");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "the generated ApiSchema type-checks a correct consumer and rejects mistakes",
  // Spawns `deno check` a few times — allow the extra time budget.
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const { dir, outDir } = await makeApp({
    "app/api/hello/route.ts": HELLO_ROUTE,
    "app/api/user/[id]/route.ts": USER_ROUTE,
  });
  try {
    await generateFor(dir, outDir);

    const write = async (name: string, body: string) => {
      const file = join(dir, name);
      await Deno.writeTextFile(
        file,
        `import { createApiClient } from "denext";\n` +
          `import type { ApiSchema } from "./.denext/api.ts";\n` +
          `const api = createApiClient<ApiSchema>();\n` + body,
      );
      return file;
    };

    await t.step("a correct consumer type-checks clean", async () => {
      const file = await write(
        "ok.ts",
        `
const hello = await api("/api/hello", "GET");
const _msg: string = hello.message;
const _rt: "deno" = hello.runtime;
const u = await api("/api/user/[id]", "GET", { params: { id: "1" } });
const _next: string | null = u.next;
const created = await api("/api/user/[id]", "POST", { params: { id: "1" }, body: { name: "Ada" } });
const _ok: true = created.ok;
void [_msg, _rt, _next, _ok];
`,
      );
      assertEquals(await denoCheck(file), 0);
    });

    // Each of these is a distinct mistake the schema must reject (non-zero exit). Checked in
    // small BATCHES — a `deno check` is heavy, and firing all of them at once starved a small
    // (2-core) CI runner enough to flake; a pool of 2 keeps the subprocess load bounded.
    const bad: Record<string, string> = {
      "unknown route path": `await api("/api/nope", "GET");`,
      "wrong method": `await api("/api/hello", "POST");`,
      "missing required params": `await api("/api/user/[id]", "GET");`,
      "wrong param name": `await api("/api/user/[id]", "GET", { params: { slug: "1" } });`,
      "missing required body": `await api("/api/user/[id]", "POST", { params: { id: "1" } });`,
      "wrong body field type":
        `await api("/api/user/[id]", "POST", { params: { id: "1" }, body: { name: 1 } });`,
      "misused response type":
        `const h = await api("/api/hello", "GET"); const n: number = h.message; void n;`,
    };
    await t.step("rejects every class of mistake", async () => {
      const entries = Object.entries(bad);
      const results: Array<readonly [string, number]> = [];
      const POOL = 2; // bounded concurrency, gentle on a small CI runner
      for (let i = 0; i < entries.length; i += POOL) {
        const batch = await Promise.all(
          entries.slice(i, i + POOL).map(async ([label, body]) => {
            const file = await write(`bad-${label.replace(/\W+/g, "-")}.ts`, body);
            return [label, await denoCheck(file)] as const;
          }),
        );
        results.push(...batch);
      }
      const slipped = results.filter(([, code]) => code === 0).map(([label]) => label);
      assertEquals(slipped, [], `these mistakes were NOT caught: ${slipped.join(", ")}`);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── Runtime: buildPath ─────────────────────────────────────────────────────

Deno.test("buildPath: substitutes params, spans catch-alls, and appends query", () => {
  assertEquals(buildPath("/api/hello"), "/api/hello");
  assertEquals(buildPath("/api/user/[id]", { id: "42" }), "/api/user/42");
  // A value is percent-encoded.
  assertEquals(buildPath("/api/user/[id]", { id: "a b" }), "/api/user/a%20b");
  // A catch-all value keeps its slashes (each segment encoded).
  assertEquals(buildPath("/files/[...path]", { path: "a/b c/d" }), "/files/a/b%20c/d");
  // An optional catch-all substitutes like a catch-all when present.
  assertEquals(buildPath("/docs/[[...slug]]", { slug: "x/y" }), "/docs/x/y");
  // Query params are appended.
  assertEquals(buildPath("/api/hello", undefined, { q: "hi", n: "1" }), "/api/hello?q=hi&n=1");
});

Deno.test("buildPath: throws a clear error when a required param is missing", () => {
  assertThrows(() => buildPath("/api/user/[id]", {}), Error, 'missing param "id"');
});

// ── Runtime: apiRequest / createApiClient ─────────────────────────────────────

/** Boot a tiny handler on an ephemeral port; returns its origin + a closer. */
async function tinyServer(
  handler: (req: Request) => Response | Promise<Response>,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const ac = new AbortController();
  const { promise, resolve } = Promise.withResolvers<number>();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: ({ port }) => resolve(port) },
    handler,
  );
  const port = await promise;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

Deno.test("apiRequest: GETs and parses JSON, and POSTs a JSON body", async () => {
  const srv = await tinyServer(async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/api/user/7") {
      return Response.json({ id: url.searchParams.get("q") ?? "7" });
    }
    if (req.method === "POST" && url.pathname === "/api/echo") {
      assertEquals(req.headers.get("content-type"), "application/json");
      return Response.json({ youSent: await req.json() }, { status: 201 });
    }
    return new Response("no", { status: 404 });
  });
  try {
    const got = await apiRequest("/api/user/[id]", "GET", {
      params: { id: "7" },
      query: { q: "9" },
    }, srv.origin);
    assertEquals(got, { id: "9" });
    const echoed = await apiRequest("/api/echo", "POST", { body: { a: 1 } }, srv.origin);
    assertEquals(echoed, { youSent: { a: 1 } });
  } finally {
    await srv.close();
  }
});

Deno.test("apiRequest: a 204 yields undefined; a non-2xx throws with method+status", async () => {
  const srv = await tinyServer((req) =>
    new URL(req.url).pathname === "/api/gone"
      ? new Response("nope", { status: 500 })
      : new Response(null, { status: 204 })
  );
  try {
    assertEquals(await apiRequest("/api/empty", "DELETE", {}, srv.origin), undefined);
    let err: Error | null = null;
    try {
      await apiRequest("/api/gone", "GET", {}, srv.origin);
    } catch (e) {
      err = e as Error;
    }
    assert(err, "a 500 should throw");
    assertStringIncludes(err!.message, "500");
    assertStringIncludes(err!.message, "GET");
  } finally {
    await srv.close();
  }
});

Deno.test("apiRequest: a hanging endpoint is bounded by the timeout (does not hang forever)", async () => {
  const ac = new AbortController();
  const { promise, resolve } = Promise.withResolvers<number>();
  // A server that never responds (holds the request open).
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: ({ port }) => resolve(port) },
    () => new Promise<Response>(() => {}),
  );
  const port = await promise;
  try {
    await assertRejects(
      () => apiRequest("/api/slow", "GET", { timeoutMs: 150 }, `http://127.0.0.1:${port}`),
    );
  } finally {
    ac.abort();
    await server.finished;
  }
});

Deno.test("createApiClient: dispatches through apiRequest with the bound base", async () => {
  const srv = await tinyServer((req) => Response.json({ path: new URL(req.url).pathname }));
  try {
    // deno-lint-ignore no-explicit-any
    const api = createApiClient<any>(srv.origin);
    const res = await api("/api/hello", "GET");
    assertEquals(res, { path: "/api/hello" });
  } finally {
    await srv.close();
  }
});
