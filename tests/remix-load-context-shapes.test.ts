// `denext migrate --from remix`: the shapes a custom server's `getLoadContext` takes besides an
// object method returning a literal — a `const` arrow with a parenthesized body, a function
// declaration, a quoted key, a React Router 7 `RouterContextProvider` filled by `.set()` calls,
// and a function that returns nothing the migration can read. Each still yields a module (or a
// located note), never a crash.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { loadContextModule } from "../packages/migrate/src/remix-load-context.ts";

/** The planned `load-context.ts` (and notes) for a `server/index.ts` holding `server`. */
async function plan(server: string) {
  const dir = await Deno.makeTempDir({ prefix: "denext-load-context-shapes-" });
  try {
    await Deno.mkdir(join(dir, "server"));
    await Deno.writeTextFile(join(dir, "server", "index.ts"), server);
    return await loadContextModule(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("load context: a const arrow with a parenthesized object body", async () => {
  const r = await plan(
    `import { createRequestHandler } from "@remix-run/express";\n` +
      `const getLoadContext = (req, res) => ({ ip: req.ip, "quoted": res.locals.q, [k]: 1 });\n` +
      `createRequestHandler({ getLoadContext });\n`,
  );
  assert(r?.module, JSON.stringify(r));
  assertStringIncludes(r.module.code, "defineLoadContext");
  assertStringIncludes(r.module.code, "ip");
  assertStringIncludes(r.module.code, "quoted");
});

Deno.test("load context: a function declaration returning from a block", async () => {
  const r = await plan(
    `function getLoadContext(req) {\n  const x = 1;\n  return ({ host: req.get("host"), x });\n}\n` +
      `export { getLoadContext };\n`,
  );
  assert(r?.module, JSON.stringify(r));
  assertStringIncludes(r.module.code, "host");
});

Deno.test("load context: a quoted getLoadContext key holding a function expression", async () => {
  const r = await plan(
    `createRequestHandler({ "getLoadContext": function (req, res) { return { ua: req.headers["user-agent"] }; } });\n`,
  );
  assert(r?.module, JSON.stringify(r));
  assertStringIncludes(r.module.code, "ua");
});

Deno.test("load context: a RouterContextProvider filled by .set() calls", async () => {
  const r = await plan(
    `import { RouterContextProvider } from "react-router";\n` +
      `import { userCtx, ipCtx } from "./ctx.ts";\n` +
      `createRequestHandler({\n  getLoadContext(req) {\n` +
      `    const context = new RouterContextProvider();\n` +
      `    context.set(userCtx, req.user);\n    context.set(ipCtx, req.ip);\n` +
      `    other.set(userCtx, 1);\n    context.get(userCtx);\n` +
      `    return context;\n  },\n});\n`,
  );
  assert(r?.module, JSON.stringify(r));
  assertStringIncludes(r.module.code, "RouterContextProvider");
  assertStringIncludes(r.module.code, ".set(");
});

Deno.test("load context: a provider returned directly, and a body that returns nothing readable", async () => {
  const direct = await plan(
    `createRequestHandler({ getLoadContext: () => new RouterContextProvider() });\n`,
  );
  assert(direct?.module, JSON.stringify(direct));
  const opaque = await plan(
    `createRequestHandler({ getLoadContext: (req) => { return build(req); } });\n`,
  );
  // Nothing the migration can re-create: it says so instead of guessing.
  assert(opaque?.module, JSON.stringify(opaque));
  assertStringIncludes(opaque.module.code, "could not read the object getLoadContext returns");
  assertEquals(opaque.warnings.some((w) => w.includes("need porting by hand")), true);
});
