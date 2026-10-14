// One app replica for tests/backend-auth-replicas-integration.test.ts: the real request pipeline
// with `denextAuth` over `backendAuthAdapter()` and `@denext/backend` (Postgres + `/auth/v1` with
// a SAML provider), served on 127.0.0.1 on a free port. Run as its own process, so two replicas
// share nothing but the database:
//
//   REPLICA_DB_URL=postgres://… REPLICA_KEYS='{…}' REPLICA_IDP_METADATA='<md:…>' \
//     [REPLICA_STRIP=1] deno run -A auth-replica.ts
//
// REPLICA_STRIP=1 removes the adapter's own `rateLimits` store and `claimSamlMessageId`, so the
// limiters and the SAML replay cache must find the backend's Postgres by themselves.
// Prints `READY <port>`; closing its stdin shuts it down cleanly.

import { applyPlugins, getPluginRequestHandler, runPluginTeardown } from "../../src/plugin/mod.ts";
import { createApp } from "../../src/server/app.ts";
import { scanRoutes } from "../../src/router/manifest.ts";
import type { DenextConfig } from "../../src/server/config.ts";
import type { ModuleLoader } from "../../src/server/types.ts";
import { denextAuth } from "../../src/server/auth/mod.ts";
import { credentials } from "../../src/server/auth/providers.ts";
import { backend, backendAuthAdapter } from "../../packages/backend/mod.ts";

const url = Deno.env.get("REPLICA_DB_URL");
if (!url) throw new Error("REPLICA_DB_URL is required");
const keys = JSON.parse(Deno.env.get("REPLICA_KEYS") ?? "{}");
const metadataXml = Deno.env.get("REPLICA_IDP_METADATA") ?? "";
const load = ((path: string) => import(path)) as unknown as ModuleLoader;

const adapter = backendAuthAdapter();
if (Deno.env.get("REPLICA_STRIP") === "1") {
  delete adapter.rateLimits;
  delete adapter.claimSamlMessageId;
}

let handler: (request: Request) => Response | Promise<Response> = () =>
  new Response("starting", { status: 503 });
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen: () => {} },
  (request) => handler(request),
);
const origin = `http://127.0.0.1:${server.addr.port}`;

const root = await Deno.makeTempDir({ prefix: "dnx-auth-replica-" });
await Deno.mkdir(`${root}/app`);
await applyPlugins({
  projectRoot: root,
  appDir: `${root}/app`,
  config: {
    plugins: [
      denextAuth({
        secret: "auth-replica-secret-at-least-32-characters!",
        canonicalOrigin: origin,
        trustForwardedHeaders: false,
        providers: [credentials()],
        adapter,
        sendVerificationRequest: () => {},
      }),
      backend({
        postgres: { url },
        supabase: {
          ...keys,
          auth: {
            saml: { providers: [{ id: "acme", domains: ["example.com"], metadataXml }] },
          },
        },
      }),
    ],
  } as DenextConfig,
  mode: "prod",
  load,
});
const manifest = await scanRoutes(`${root}/app`);
handler = createApp({
  getManifest: () => manifest,
  load,
  matchExternal: getPluginRequestHandler(),
});
console.log(`READY ${server.addr.port}`);

// Shut down when the parent closes stdin.
for await (const _ of Deno.stdin.readable) { /* drain */ }
await runPluginTeardown();
await server.shutdown();
await Deno.remove(root, { recursive: true }).catch(() => {});
Deno.exit(0);
