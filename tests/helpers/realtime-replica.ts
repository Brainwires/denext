// One app replica for the Supabase Realtime integration suite: a real denext request pipeline
// (createApp + the plugin seam) with `denextAuth` and `@denext/backend` (Postgres + realtime),
// served on 127.0.0.1 on a free port. Run as its own process so two replicas share nothing but the
// database, as two instances of a deployed app do:
//
//   REPLICA_DB_URL=postgres://… REPLICA_REALTIME='{"tables":{…}}' \
//     [REPLICA_SUPABASE='{"publishableKey":…}'] deno run -A realtime-replica.ts
//
// Prints `READY <port>` once listening; closing its stdin shuts it down cleanly (plugin
// teardown: sockets closed, presences untracked). Killing it models a crashed instance.

import { applyPlugins, getPluginRequestHandler, runPluginTeardown } from "../../src/plugin/mod.ts";
import { createApp } from "../../src/server/app.ts";
import { scanRoutes } from "../../src/router/manifest.ts";
import type { DenextConfig } from "../../src/server/config.ts";
import type { ModuleLoader } from "../../src/server/types.ts";
import { denextAuth } from "../../src/server/auth/mod.ts";
import { backend } from "../../packages/backend/mod.ts";
import { authConfig } from "./realtime-harness.ts";

const url = Deno.env.get("REPLICA_DB_URL");
if (!url) throw new Error("REPLICA_DB_URL is required");
const realtime = JSON.parse(Deno.env.get("REPLICA_REALTIME") ?? '{"tables":{}}');
// The Supabase keys (`backend({ supabase })`), as JSON, when the suite installs them.
const supabaseKeys = Deno.env.get("REPLICA_SUPABASE");
const supabase = supabaseKeys ? JSON.parse(supabaseKeys) : undefined;
const load = ((path: string) => import(path)) as unknown as ModuleLoader;

const root = await Deno.makeTempDir({ prefix: "dnx-replica-" });
await Deno.mkdir(`${root}/app`);
await applyPlugins({
  projectRoot: root,
  appDir: `${root}/app`,
  config: {
    plugins: [
      denextAuth(authConfig),
      backend({ postgres: { url }, realtime, ...(supabase ? { supabase } : {}) }),
    ],
  } as DenextConfig,
  mode: "prod",
  load,
});
const manifest = await scanRoutes(`${root}/app`);
const handler = createApp({
  getManifest: () => manifest,
  load,
  matchExternal: getPluginRequestHandler(),
});
const server = Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: ({ port }) => console.log(`READY ${port}`),
}, handler);

// Shut down when the parent closes stdin.
for await (const _ of Deno.stdin.readable) { /* drain */ }
await runPluginTeardown();
await server.shutdown();
await Deno.remove(root, { recursive: true }).catch(() => {});
Deno.exit(0);
