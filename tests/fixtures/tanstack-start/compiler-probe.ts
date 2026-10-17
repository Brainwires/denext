// Run by tests/tanstack-start-plugin.test.ts under examples/tanstack-start's config (so the
// app's npm packages resolve): TanStack's real compiler over a route module and a
// server-function module, as the plugin drives it. Prints what it produced as JSON.

import {
  loadStartToolchain,
  type ServerFnInfo,
} from "../../../packages/tanstack-start/src/toolchain.ts";
import { stripServerRouteOptions } from "../../../packages/tanstack-start/src/compile.ts";
import { browserServerModule } from "../../../packages/tanstack-start/src/use-server.ts";

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
// A "use server" module that also declares a server function, with server code beside it.
const mixed = `"use server";
import { createServerFn } from "@tanstack/react-start";
import { readFileSync } from "node:fs";
import "./setup.server.ts";
const SECRET = "MIXED_SECRET";
const effect = globalThis.setTimeout(() => {}, 0), other = "OTHER_SECRET";
async function stamp() { "use cache"; return SECRET.length; }
export const getStamp = createServerFn({ method: "GET" }).handler(async () => stamp());
const hidden = createServerFn().handler(() => SECRET);
export { hidden as renamed };
export async function plainAction() { return readFileSync("/etc/hosts", "utf8") + other; }
export default function Page() { return SECRET; }
console.log("SIDE_EFFECT", SECRET, effect);
`;
const seen: Record<string, ServerFnInfo> = {};
const compile = async (env: "client" | "server", code = fns, id = "/p/src/fns.ts") =>
  (await tc.createCompiler({
    env,
    root: "/p",
    onServerFnsById: (f) => Object.assign(seen, f),
    getKnownServerFns: () => seen,
    loadModule: () => Promise.resolve(),
    resolveId: () => Promise.resolve(null),
  }).compile({ code, id, detectedKinds: tc.detectKinds(code, env) }))?.code;
const client = await compile("client");
const ssr = await compile("server");
console.log(JSON.stringify({
  stripped: stripServerRouteOptions(route, "/p/src/routes/api/x.tsx", tc),
  untouched: stripServerRouteOptions("export const a = 1;", "/p/a.ts", tc),
  client,
  ssr,
  ids: Object.keys(seen),
  resolver: tc.resolverModule(seen),
  useServer: browserServerModule(
    (await compile("client", mixed, "/p/src/mixed.ts"))!,
    "/p/src/mixed.ts",
    tc,
  ),
}));
