import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { loadInstrumentation, runRegister } from "../src/server/instrumentation.ts";
import { resolveProject } from "../src/build/paths.ts";
import { createApp } from "../src/server/app.ts";
import { actionEndpoint, serverAction } from "../src/runtime/server-action.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";

async function tempModule(contents: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_instr_" });
  const path = join(dir, "instrumentation.ts");
  await Deno.writeTextFile(path, contents);
  return path;
}

// ---- loadInstrumentation ---------------------------------------------------

Deno.test("loadInstrumentation reads named exports", async () => {
  const path = await tempModule(
    "export function register() {}\nexport function onRequestError() {}\n",
  );
  const instr = await loadInstrumentation(path);
  assertEquals(typeof instr.register, "function");
  assertEquals(typeof instr.onRequestError, "function");
});

Deno.test("loadInstrumentation reads a default-export object", async () => {
  const path = await tempModule(
    "export default { register() {}, onRequestError() {} };\n",
  );
  const instr = await loadInstrumentation(path);
  assertEquals(typeof instr.register, "function");
  assertEquals(typeof instr.onRequestError, "function");
});

Deno.test("loadInstrumentation tolerates null and unloadable modules", async () => {
  assertEquals(await loadInstrumentation(null), {});
  const gone = await loadInstrumentation("/no/such/instrumentation.ts");
  assertEquals(gone, {});
});

Deno.test("runRegister swallows a throwing register()", async () => {
  let ran = false;
  await runRegister({
    register: () => {
      ran = true;
      throw new Error("boom");
    },
  });
  assert(ran); // called, and the throw did not propagate
});

// ---- resolveProject convention ---------------------------------------------

Deno.test("resolveProject discovers a root instrumentation module", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_proj_" });
  try {
    assertEquals((await resolveProject(dir)).instrumentationPath, null);
    await Deno.writeTextFile(join(dir, "instrumentation.ts"), "export function register(){}\n");
    assertEquals(
      (await resolveProject(dir)).instrumentationPath,
      join(dir, "instrumentation.ts"),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- onRequestError wiring -------------------------------------------------

function manifest(): RouteManifest {
  return {
    pages: [{
      kind: "page",
      pattern: parsePattern("x"),
      routePath: "/x",
      filePath: "page.tsx",
      layoutChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      templateChain: [],
    }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

Deno.test("onRequestError is invoked once for an unhandled page error, with Next-shaped context", async () => {
  // deno-lint-ignore no-explicit-any
  const calls: Array<{ message: string; request: any; ctx: any }> = [];
  const app = createApp({
    getManifest: manifest,
    load: () =>
      Promise.resolve({
        default: () => {
          throw new Error("render failed");
        },
      }),
    onRequestError: (error, request, context) => {
      calls.push({ message: (error as Error).message, request, ctx: context });
    },
  });

  const res = await app(new Request("http://localhost/x?q=1"));
  assertEquals(res.status, 500);
  assertStringIncludes(await res.text(), "Internal Server Error");
  assertEquals(calls.length, 1); // reported exactly once (no double-fire)
  assertEquals(calls[0].message, "render failed");
  // The context matches Next.js's onRequestError shape.
  assertEquals(calls[0].ctx.routePath, "/x");
  assertEquals(calls[0].ctx.routerKind, "App Router");
  assertEquals(calls[0].ctx.routeType, "render");
  assertEquals(calls[0].ctx.renderSource, "server-rendering");
  assertEquals(calls[0].ctx.renderType, "dynamic");
  // `request` is Next's plain { path, method, headers } object — NOT a Request — so
  // instrumentation reading request.path/.method works unchanged.
  assert(!(calls[0].request instanceof Request));
  assertEquals(calls[0].request.path, "/x?q=1");
  assertEquals(calls[0].request.method, "GET");
  assertEquals(typeof calls[0].request.headers, "object");
});

Deno.test("M2: a throwing Server Action is reported to onRequestError", async () => {
  serverAction("m2_boom", () => {
    throw new Error("action blew up");
  });
  const calls: string[] = [];
  const app = createApp({
    getManifest: manifest,
    load: () => Promise.resolve({}),
    onRequestError: (error) => {
      calls.push((error as Error).message);
    },
  });
  const req = new Request("http://localhost" + actionEndpoint("m2_boom"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      host: "localhost",
      "x-denext-action": "1",
    },
    body: JSON.stringify({ args: [] }),
  });
  const res = await app(req);
  await res.text();
  assertEquals(res.status, 500);
  assertEquals(calls, ["action blew up"], "the action error must reach onRequestError");
});

Deno.test("a throwing onRequestError does not break the error response", async () => {
  const app = createApp({
    getManifest: manifest,
    load: () =>
      Promise.resolve({
        default: () => {
          throw new Error("render failed");
        },
      }),
    onRequestError: () => {
      throw new Error("instrumentation is broken");
    },
  });
  const res = await app(new Request("http://localhost/x"));
  assertEquals(res.status, 500); // still a clean 500
  assertStringIncludes(await res.text(), "Internal Server Error");
});
