// examples/offline-sync: two devices with local SQLite databases sync through the example's
// backend route handlers (in process, no build). The device side is the example's own sync
// client over node:sqlite standing in for `openSqlite` (same `exec` / `run` / `query` slice);
// `openSqlite`'s own native and web paths are covered by tests/expo-sqlite.test.ts.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { fromFileUrl } from "@std/path";
import { createTestApp } from "denext/testing";
import type { SqliteDatabase } from "../src/mobile/sqlite.ts";
import {
  type BindValue,
  createSyncClient,
  type SyncDb,
  UploadRejectedError,
} from "../examples/offline-sync/src/sync-client.ts";
import { MAX_BATCH, parseUpload } from "../examples/offline-sync/src/protocol.ts";

Deno.env.set("OFFLINE_SYNC_DB", ":memory:");
const BACKEND = fromFileUrl(new URL("../examples/offline-sync/backend", import.meta.url));

// `openSqlite`'s database is what the example passes: it must satisfy the client's slice.
const _openSqliteFits: (db: SqliteDatabase) => SyncDb = (db) => db;

/** A local database: node:sqlite behind `openSqlite`'s async face. */
function localDb(): SyncDb & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  const bind = (params?: readonly BindValue[]) => (params ?? []) as never[];
  return {
    raw,
    exec: (sql) => Promise.resolve(raw.exec(sql)),
    run: (sql, params) => Promise.resolve(raw.prepare(sql).run(...bind(params))),
    query: <T>(sql: string, params?: readonly BindValue[]) =>
      Promise.resolve(raw.prepare(sql).all(...bind(params)) as T[]),
  };
}

/** A device: its database, its client, and a switch for its network. */
async function device(app: (r: Request) => Response | Promise<Response>, prefix: string) {
  const net = { online: true, requests: 0 };
  let n = 0;
  const db = localDb();
  const client = await createSyncClient(db, {
    batchSize: 2,
    newId: () => `${prefix}-${++n}`,
    fetch: (input, init) => {
      net.requests++;
      if (!net.online) return Promise.reject(new TypeError("network is down"));
      return Promise.resolve(app(new Request(new URL(String(input), "http://backend.test"), init)));
    },
  });
  return { db, client, net };
}

Deno.test("offline-sync: writes queue offline, upload in order, and reach the other device", async () => {
  await using app = await createTestApp(BACKEND);
  const a = await device(app, "a");
  const b = await device(app, "b");

  // Offline: the writes land locally at once and wait in the queue.
  a.net.online = false;
  const first = await a.client.add("first");
  await a.client.add("second");
  await a.client.edit(first, "first, edited");
  await a.client.add("doomed");
  await a.client.remove("a-3");
  assertEquals((await a.client.list()).map((n) => n.body).sort(), ["first, edited", "second"]);
  assertEquals(await a.client.pending(), 5);
  const offline = await a.client.sync();
  assertEquals(offline, { uploaded: 0, downloaded: 0, pending: 5, offline: true });

  // Online: five operations in batches of two, then the server's view comes back.
  a.net.online = true;
  const synced = await a.client.sync();
  assertEquals([synced.uploaded, synced.pending, synced.offline], [5, 0, false]);
  assertEquals(await a.client.pending(), 0);

  // The other device downloads the result of all five, the deletion included.
  const pulled = await b.client.sync();
  assertEquals(pulled.offline, false);
  assertEquals((await b.client.list()).map((n) => n.body).sort(), ["first, edited", "second"]);

  // b deletes one; a learns of it on its next sync (a tombstone, not a missing row).
  await b.client.remove(first);
  await b.client.sync();
  await a.client.sync();
  assertEquals((await a.client.list()).map((n) => n.body), ["second"]);
});

Deno.test("offline-sync: a pending local change is not overwritten by an older server copy", async () => {
  await using app = await createTestApp(BACKEND);
  const a = await device(app, "c");
  const b = await device(app, "d");
  const id = await a.client.add("v1");
  await a.client.sync();
  await b.client.sync();

  // b edits offline; a edits and syncs meanwhile.
  b.net.online = false;
  await b.client.edit(id, "b's edit");
  await a.client.edit(id, "a's edit");
  await a.client.sync();
  // b still offline: a sync attempt changes nothing locally.
  await b.client.sync();
  assertEquals((await b.client.list()).find((n) => n.id === id)?.body, "b's edit");
  // Back online: b's queued edit uploads first, so it is the last write and wins everywhere.
  b.net.online = true;
  await b.client.sync();
  await a.client.sync();
  assertEquals((await a.client.list()).find((n) => n.id === id)?.body, "b's edit");
  assertEquals((await b.client.list()).find((n) => n.id === id)?.body, "b's edit");
});

Deno.test("offline-sync: a refused batch stays queued and surfaces; the backend validates", async () => {
  await using app = await createTestApp(BACKEND);
  const a = await device(app, "e");
  // A body over the limit, written straight into the queue (the UI never produces one).
  await a.db.exec(
    `INSERT INTO crud_queue (op, tbl, row_id, data) VALUES ('PUT', 'notes', 'e-x', '${
      JSON.stringify({ body: "x".repeat(10_001), updated_at: 1 })
    }')`,
  );
  const err = await assertRejects(() => a.client.sync(), UploadRejectedError);
  assertEquals(err.status, 400);
  assertEquals(await a.client.pending(), 1);

  const post = (body: unknown) =>
    app(
      new Request("http://backend.test/api/data", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  // Each refusal's body is read: an unread one holds the request's deadline timer open.
  const status = async (res: Response) => (await res.body?.cancel(), res.status);
  assertEquals(await status(await post("{not json")), 400);
  assertEquals(await status(await post({ batch: [{ op: "PUT", table: "users", id: "1" }] })), 400);
  assertEquals(
    await status(await app(new Request("http://backend.test/api/changes?since=-1"))),
    400,
  );
  // PowerSync's upload shape is accepted as is.
  const ok = await post({
    batch: [{ op: "PUT", table: "notes", id: "ps-1", data: { body: "from PowerSync" } }],
  });
  assertEquals(ok.status, 200);
  assert(typeof (await ok.json()).checkpoint === "number");
});

Deno.test("offline-sync: parseUpload's limits", () => {
  assertEquals("error" in parseUpload(null), true);
  assertEquals("error" in parseUpload({ batch: "x" }), true);
  const big = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({
    op: "DELETE",
    table: "notes",
    id: `n${i}`,
  }));
  assertEquals("error" in parseUpload({ batch: big }), true);
  assertEquals("error" in parseUpload({ batch: [{ op: "PATCH", table: "notes", id: "x" }] }), true);
  assertEquals(
    "error" in parseUpload({ batch: [{ op: "PUT", table: "notes", id: "bad id!", data: {} }] }),
    true,
  );
  assertEquals(
    parseUpload({ batch: [{ op: "DELETE", table: "notes", id: "ok_1" }] }),
    { batch: [{ op: "DELETE", table: "notes", id: "ok_1" }] },
  );
});
