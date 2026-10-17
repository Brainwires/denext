// Run by tests/tanstack-start-plugin.test.ts under examples/tanstack-start's config (so the
// app's npm packages resolve): TanStack's real compiler over a route module and a
// server-function module, as the plugin drives it. Prints what it produced as JSON.

import {
  loadStartToolchain,
  type ServerFnInfo,
} from "../../../packages/tanstack-start/src/toolchain.ts";
import { stripServerRouteOptions } from "../../../packages/tanstack-start/src/compile.ts";

const tc = await loadStartToolchain(Deno.args[0]);
const route = `import { createFileRoute } from "@tanstack/react-router";
import { db } from "./db.server.ts";
export const Route = createFileRoute("/api/x")({
  server: { handlers: { GET: () => Response.json(db.all()) } },
  headers: () => ({ "x-a": "1" }),
  component: () => null,
});
`;
const fns = `import { createServerFn } from "@tanstack/react-start";
import { secret } from "./secret.server.ts";
export const getSecret = createServerFn({ method: "POST" })
  .validator((d: string) => d)
  .handler(({ data }) => secret(data));
`;
const seen: Record<string, ServerFnInfo> = {};
const compile = async (env: "client" | "server") =>
  (await tc.createCompiler({
    env,
    root: "/p",
    onServerFnsById: (f) => Object.assign(seen, f),
    getKnownServerFns: () => seen,
    loadModule: () => Promise.resolve(),
    resolveId: () => Promise.resolve(null),
  }).compile({ code: fns, id: "/p/src/fns.ts", detectedKinds: tc.detectKinds(fns, env) }))?.code;
const client = await compile("client");
const ssr = await compile("server");
console.log(JSON.stringify({
  stripped: stripServerRouteOptions(route, "/p/src/routes/api/x.tsx", tc),
  untouched: stripServerRouteOptions("export const a = 1;", "/p/a.ts", tc),
  client,
  ssr,
  ids: Object.keys(seen),
  resolver: tc.resolverModule(seen),
}));
