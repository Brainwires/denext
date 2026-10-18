// examples/offline-sync built: the SPA (the app a Capacitor shell packages) and its backend.
// The backend is built, served, and synced against over real HTTP by a device database, and it
// answers the shell's origins' CORS preflight. The in-process cases are in
// tests/examples-offline-sync.test.ts.

import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { fromFileUrl, join } from "@std/path";
import { walk } from "@std/fs";
import { build } from "../../src/build/build.ts";
import { startProdOrigin } from "../helpers/prod-origin.ts";
import { type BindValue, createSyncClient } from "../../examples/offline-sync/src/sync-client.ts";

const APP = fromFileUrl(new URL("../../examples/offline-sync", import.meta.url));
const BACKEND = join(APP, "backend");

/** A device database over node:sqlite (openSqlite's slice). */
function localDb() {
  const raw = new DatabaseSync(":memory:");
  const bind = (params?: readonly BindValue[]) => (params ?? []) as BindValue[];
  return {
    exec: (sql: string) => Promise.resolve(raw.exec(sql)),
    run: (sql: string, params?: readonly BindValue[]) =>
      Promise.resolve(raw.prepare(sql).run(...bind(params))),
    query: <T>(sql: string, params?: readonly BindValue[]) =>
      Promise.resolve(raw.prepare(sql).all(...bind(params)) as T[]),
  };
}

Deno.test({
  name: "examples/offline-sync: the SPA builds, and devices sync through the built backend",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // The app: a client bundle carrying the UI and the sync client.
    await build(APP);
    let bundled = false;
    for await (const entry of walk(join(APP, ".denext"), { exts: [".js"] })) {
      const text = await Deno.readTextFile(entry.path);
      if (text.includes("Offline notes") && text.includes("crud_queue")) bundled = true;
    }
    assert(bundled, "the SPA bundle holds the app and its sync client");

    // The backend, built and served.
    Deno.env.set("OFFLINE_SYNC_DB", ":memory:");
    await build(BACKEND);
    const ac = new AbortController();
    const { origin, server } = await startProdOrigin(BACKEND, ac.signal);
    try {
      const a = await createSyncClient(localDb(), { origin });
      const b = await createSyncClient(localDb(), { origin });
      const id = await a.add("over HTTP");
      assertEquals((await a.sync()).uploaded, 1);
      await b.sync();
      assertEquals((await b.list()).find((n) => n.id === id)?.body, "over HTTP");

      // The Capacitor shell's WebView origin may call it.
      const preflight = await fetch(`${origin}/api/data`, {
        method: "OPTIONS",
        headers: {
          origin: "capacitor://localhost",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
      await preflight.body?.cancel();
      assertEquals(preflight.headers.get("access-control-allow-origin"), "capacitor://localhost");
    } finally {
      ac.abort();
      await server.finished;
    }
  },
});
