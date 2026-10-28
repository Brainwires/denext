// A request's async context must never outlive the request through a lazily loaded module.
//
// Deno (2.9.7) leaves the async context of the code that called `import()` active after a module
// loads for the first time: the next task the runtime starts on its own — a `Deno.serve` handler
// for another request, the test runner's next test — inherits it, and a module evaluated for the
// first time inside a request runs its top-level code (and any timer it starts) in that request.
// Minimal repro, outside denext:
//
//   const als = new AsyncLocalStorage();
//   Deno.test("a", () => als.run("REQ", () => import("./fresh.mjs")));
//   Deno.test("b", () => console.log(als.getStore())); // "REQ"
//
// denext loads shared modules in the root context (src/server/root-context.ts) and starts every
// request and scheduled job outside any request. Each "loads inside a request" test below is
// followed by a test asserting the runner's next task sees no request context: the leak shows
// up only in the NEXT runtime-started task, not in the test that triggered it.

import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  createRequestContext,
  currentContext,
  runWithContext,
} from "../src/server/request-context.ts";
import { inRootContext } from "../src/server/root-context.ts";
import { defaultLoader } from "../src/server/mod.ts";
import { baseLoaderFor } from "../src/build/dev-server/loaders.ts";
import type { DevState } from "../src/build/dev-server/state.ts";
import { transformImageBytes } from "../src/server/image-optimizer.ts";
import { swcParse } from "../src/build/swc-ast.ts";
import { tagClientModules } from "../src/runtime/client-reference.ts";
import { createApp } from "./helpers/released-app.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { serveWithPortFallback } from "../src/server/serve-utils.ts";
import { clearJobs, defineJob, registerJob, scheduleJobs } from "../src/server/jobs.ts";
import { samplePng } from "./fixtures/sample-image.ts";

const dir = await Deno.makeTempDir({ prefix: "dnx-root-ctx-" });
let fresh = 0;

/**
 * Write a module never loaded before whose top-level code starts a timer: `seen` resolves to the
 * URL of the request its timer callback sees (null when none).
 */
async function freshModule(): Promise<string> {
  const path = join(dir, `m${++fresh}.mjs`);
  await Deno.writeTextFile(
    path,
    `export const seen = new Promise((resolve) => setTimeout(() => resolve(
      globalThis.__denextCurrentRequestContext?.()?.request?.url ?? null), 0));
     export function f() {}\n`,
  );
  return path;
}

/** Run `fn` inside a request to `path`. */
function inRequest<T>(path: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext(createRequestContext(new Request(`https://app.test${path}`)), fn);
}

/** The assertion every "next test" makes: the runtime started it outside any request. */
function assertNoAmbientRequest(): void {
  assertEquals(currentContext()?.request.url, undefined);
}

Deno.test("root context: inRootContext hides the request and restores it afterwards", async () => {
  await inRequest("/a", async () => {
    assertEquals(inRootContext(() => currentContext()), undefined);
    assertEquals(
      await inRootContext(async () => (await Promise.resolve(), currentContext())),
      undefined,
    );
    assertEquals(currentContext()?.request.url, "https://app.test/a");
  });
});

Deno.test("root context: the module loader imports a new module inside a request", async () => {
  const path = await freshModule();
  await inRequest("/load", async () => {
    const mod = await defaultLoader(path) as { seen: Promise<string | null> };
    // The importer resumes in its own request; the module's top-level timer does not.
    assertEquals(currentContext()?.request.url, "https://app.test/load");
    assertEquals(await mod.seen, null);
  });
});

Deno.test("root context: … and the next task sees no request (module loader)", () => {
  assertNoAmbientRequest();
});

Deno.test("root context: the dev loader imports a new module inside a request", async () => {
  const path = await freshModule();
  const load = baseLoaderFor({ generation: 1 } as DevState);
  await inRequest("/dev", async () => {
    const mod = await load(path) as { seen: Promise<string | null> };
    assertEquals(await mod.seen, null);
  });
});

Deno.test("root context: … and the next task sees no request (dev loader)", () => {
  assertNoAmbientRequest();
});

Deno.test("root context: a wasm codec loads for the first time inside a request", async () => {
  await inRequest("/_denext/image", async () => {
    const res = await transformImageBytes(samplePng(), { width: 16 }, {
      images: { deviceSizes: [16], imageSizes: [] },
    });
    assertEquals(res.headers.get("content-type"), "image/webp");
    await res.body?.cancel();
  });
});

Deno.test("root context: … and the next task sees no request (image codec)", () => {
  assertNoAmbientRequest();
});

Deno.test("root context: a memoized wasm tool initializes inside a request", async () => {
  await inRequest("/transform", async () => {
    const parse = await swcParse();
    assert(await parse("const a = 1;"));
  });
});

Deno.test("root context: … and the next task sees no request (memoized wasm init)", () => {
  assertNoAmbientRequest();
});

Deno.test("root context: an island module is imported to be tagged inside a request", async () => {
  const path = await freshModule();
  await inRequest("/page", async () => {
    await tagClientModules([["root-ctx-island", { url: toFileUrl(path).href }]]);
  });
  const mod = await import(toFileUrl(path).href) as { seen: Promise<string | null> };
  assertEquals(await mod.seen, null);
});

Deno.test("root context: … and the next task sees no request (island tagging)", () => {
  assertNoAmbientRequest();
});

Deno.test("root context: every app request starts outside any earlier request", async () => {
  const appDir = join(dir, "app");
  await Deno.mkdir(appDir, { recursive: true });
  const manifest = await scanRoutes(appDir);
  const logged: Array<string | undefined> = [];
  const app = createApp({
    getManifest: () => manifest,
    load: defaultLoader,
    onRequest: () => logged.push(currentContext()?.request.url),
  });
  // Dispatched from inside a stale request (what the runtime does after a leak): the request's
  // own wrappers — here its `onRequest` log line — see no request, not the stale one.
  const res = await inRequest("/stale", () => app(new Request("https://app.test/missing")));
  await res.body?.cancel();
  assertEquals(res.status, 404);
  assertEquals(logged, [undefined]);
});

Deno.test("root context: a server's next request never sees the request that loaded a module", async () => {
  const path = await freshModule();
  const controller = new AbortController();
  let port = 0;
  const server = serveWithPortFallback(
    {
      port: 18_977,
      hostname: "127.0.0.1",
      signal: controller.signal,
      onListen: (i) => port = i.port,
    },
    (request) => {
      if (new URL(request.url).pathname === "/load") {
        // App code importing a module itself, inside its request.
        return runWithContext(createRequestContext(request), async () => {
          await import(toFileUrl(path).href);
          return new Response("loaded");
        });
      }
      return new Response(String(currentContext()?.request.url ?? "none"));
    },
  );
  try {
    assertEquals(await (await fetch(`http://127.0.0.1:${port}/load`)).text(), "loaded");
    assertEquals(await (await fetch(`http://127.0.0.1:${port}/probe`)).text(), "none");
  } finally {
    controller.abort();
    await server.finished;
  }
});

Deno.test("root context: a scheduled job runs outside the context the runtime fires it in", async () => {
  clearJobs();
  let saw: unknown = "unset";
  registerJob("root-ctx-job", defineJob({ handler: () => void (saw = currentContext()) }));
  const fired: Array<() => unknown> = [];
  const denoAny = Deno as { cron?: unknown };
  const had = "cron" in denoAny;
  const prev = denoAny.cron;
  denoAny.cron = (_n: string, _s: string, handler: () => unknown) => void fired.push(handler);
  try {
    scheduleJobs([{ cron: "0 3 * * *", job: "root-ctx-job" }]);
  } finally {
    if (had) denoAny.cron = prev;
    else delete denoAny.cron;
  }
  try {
    await inRequest("/stale", async () => await fired[0]());
    assertEquals(saw, undefined);
  } finally {
    clearJobs();
  }
});

Deno.test("root context: cleanup", async () => {
  await Deno.remove(dir, { recursive: true });
});
