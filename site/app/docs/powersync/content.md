---
title: Offline sync and PowerSync
slug: powersync
lead: Keep an app's data in SQLite on the device so it works offline, and sync it with your backend. Two ways on denext, a small sync loop over openSqlite (examples/offline-sync) and PowerSync's own SDK, and which database each one owns.
---

A local-first app reads and writes a database on the device, so every screen is instant and works
without a network, and syncs that database with the server in the background. On denext the
device database is SQLite: `openSqlite` from `denext/mobile` opens one through
`@capacitor-community/sqlite` in the Capacitor shell (`denext mobile add sqlite`) and through the
app's own `@sqlite.org/sqlite-wasm` on the Origin Private File System in a browser
([Mobile](/docs/mobile)).

There are two ways to sync it:

| Approach                                     | Device database                                            | Server side                                                  | Verified by denext                                                         |
| -------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Your own sync loop (`examples/offline-sync`) | `openSqlite`                                               | denext route handlers (`POST /api/data`, `GET /api/changes`) | Yes: unit and integration tests, built in CI                               |
| PowerSync                                    | PowerSync's own (`@powersync/web`, `@powersync/capacitor`) | The PowerSync Service + your upload route on denext          | The upload route's shape only; PowerSync's SDK is not built in denext's CI |

## What `openSqlite` cannot do: host a PowerSync database

PowerSync's client SDK needs its core SQLite extension (`powersync-sqlite-core`, the
`powersync_*` functions its views, triggers and sync steps call) loaded into every connection to
its database. Each PowerSync SDK brings its own SQLite with that extension:

- **Browser:** `@powersync/web` runs its own wa-sqlite build with the extension, in web workers.
  `openSqlite`'s web engine is the official `@sqlite.org/sqlite-wasm`, which has no PowerSync
  extension and cannot load one.
- **iOS and Android:** `@powersync/capacitor` (beta) uses the same `@capacitor-community/sqlite`
  plugin as `openSqlite`, plus a small native plugin of its own that links the extension (iOS
  registers it for every connection after the SDK calls `registerCore`; Android loads it into the
  SDK's own connections with `load_extension`). PowerSync's adapter owns that database's read and
  write connections and their locking.

So `openSqlite` is not a PowerSync database driver. Read and write PowerSync's tables through
PowerSync's API (`db.getAll`, `db.watch`, `db.execute`), and use `openSqlite` only for data that
is not synced, **in a different database file**. In the shell both go through one native plugin,
and `openSqlite` resets the plugin's connections the first time a page opens a database (to drop
the ones a reload left behind): call `openSqlite` once before PowerSync opens its database, or not
at all.

## Your own sync loop: `examples/offline-sync`

[`examples/offline-sync`](https://github.com/Brainwires/denext/tree/main/examples/offline-sync)
is a notes app whose data lives in `openSqlite("offline-sync.db")`, with a sync loop in
`src/sync-client.ts` that follows PowerSync's client model:

- **A write and its upload in one transaction.** `add` / `edit` / `remove` change the local table
  and append the operation to `crud_queue` (PowerSync's `ps_crud`) together, so the UI never waits
  on the network and a crash cannot keep one without the other.
- **Uploads in order, removed only when applied.** `sync()` posts the queue in batches; a batch
  leaves the queue once the backend answers 2xx. A network failure or a 5xx keeps it (the device
  is offline); a 4xx is an `UploadRejectedError` the app shows, and the batch stays queued.
- **Server changes only on an empty queue.** As in PowerSync, rows from the server are applied
  only when nothing local is waiting, so a pending local change is never replaced by an older
  server copy. Deletions arrive as tombstones.

```ts
// src/app.tsx (excerpt)
import { openSqlite } from "denext/mobile";
import { createSyncClient } from "./sync-client.ts";

const db = await openSqlite("offline-sync.db");
const notes = await createSyncClient(db, { origin: "https://api.example.com" });
await notes.add("written offline"); // local at once, queued for upload
const { uploaded, downloaded, offline } = await notes.sync();
```

The backend is a denext app of two route handlers (`backend/`): `POST /api/data` applies a batch
in one transaction, and `GET /api/changes?since=N` returns the rows changed after a checkpoint.
Its `cors` lets the shell's WebView origins (`capacitor://localhost`, `https://localhost`) call
it ([App backend](/docs/app-backend#cors-for-app-origins)). An app with users checks the session
in both routes and scopes every row to its owner.

What it leaves out, and PowerSync handles: partial sync (sync rules or streams per user),
streaming instead of polling, and conflict handling beyond last-write-wins.

## PowerSync in a denext app

The upload half of a PowerSync app is an ordinary denext route, and it can be the same
`POST /api/data` as the example: the body is the shape PowerSync's backend demos post,
`{ batch: [{ op: "PUT" | "PATCH" | "DELETE", table, id, data }] }`. In a PowerSync deployment the
route writes to the database the PowerSync Service replicates from (Postgres, MongoDB, MySQL or
SQL Server), and the Service streams the changes to devices; there is no `/api/changes`.

**Not verified by denext:** PowerSync's web SDK runs its database in web workers with its own
WebAssembly build. denext's CI does not build an app with `@powersync/web` or
`@powersync/capacitor`, so whether the SPA build bundles their workers unchanged is untested;
follow PowerSync's bundler notes, and report what breaks.

### On the device

```sh
npm install @powersync/web @powersync/capacitor
denext mobile add sqlite   # @capacitor-community/sqlite, which @powersync/capacitor drives
```

```ts
// src/powersync.ts
import {
  type AbstractPowerSyncDatabase,
  column,
  type PowerSyncBackendConnector,
  Schema,
  Table,
} from "@powersync/web";
import { PowerSyncDatabase } from "@powersync/capacitor"; // the web SDK in a browser

const API = "https://api.example.com";

export const db = new PowerSyncDatabase({
  schema: new Schema({ notes: new Table({ body: column.text, updated_at: column.integer }) }),
  database: { dbFilename: "powersync.sqlite" }, // not a file openSqlite opens
});

const connector: PowerSyncBackendConnector = {
  async fetchCredentials() {
    const res = await fetch(`${API}/api/powersync/token`, { credentials: "include" });
    if (!res.ok) throw new Error(`token: ${res.status}`);
    return await res.json(); // { endpoint, token }
  },
  async uploadData(database: AbstractPowerSyncDatabase) {
    const tx = await database.getNextCrudTransaction();
    if (!tx) return;
    const batch = tx.crud.map((e) => ({ op: e.op, table: e.table, id: e.id, data: e.opData }));
    const res = await fetch(`${API}/api/data`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ batch }),
    });
    if (!res.ok) throw new Error(`upload: ${res.status}`); // PowerSync retries
    await tx.complete();
  },
};

await db.connect(connector);
const notes = await db.getAll("SELECT * FROM notes ORDER BY updated_at DESC");
```

### On the backend

PowerSync authenticates a device with a JWT your backend signs and the PowerSync Service checks
against your public keys (its `client_auth` setting, a JWKS URL). Both are denext routes; the key
pair comes from the environment (an ES256 private JWK with a `kid`):

```ts
// app/api/powersync/token/route.ts
import { auth } from "denext/server";

const jwk = JSON.parse(Deno.env.get("POWERSYNC_PRIVATE_JWK")!); // { kty: "EC", crv: "P-256", d, x, y, kid }
const key = await crypto.subtle.importKey(
  "jwk",
  jwk,
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  [
    "sign",
  ],
);
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const part = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session) return new Response(null, { status: 401 });
  const endpoint = Deno.env.get("POWERSYNC_URL")!;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${part({ alg: "ES256", kid: jwk.kid, typ: "JWT" })}.${
    part({ sub: session.user.id, aud: endpoint, iat: now, exp: now + 300 })
  }`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned),
  ); // WebCrypto's ECDSA signature is already JOSE's r || s
  return Response.json({ endpoint, token: `${unsigned}.${b64url(new Uint8Array(signature))}` });
}
```

```ts
// app/api/powersync/jwks/route.ts: the public half, for PowerSync's client_auth.jwks_uri
const { d: _private, ...publicJwk } = JSON.parse(Deno.env.get("POWERSYNC_PRIVATE_JWK")!);
export function GET(): Response {
  return Response.json({ keys: [{ ...publicJwk, alg: "ES256", use: "sig" }] });
}
```

The upload route writes the batch to the source database in one transaction, under the signed-in
user. With Postgres, `postgresClient()` from `denext/server` (or `db()` from
[`@denext/backend`](/docs/backend), which applies row-level security):

```ts
// app/api/data/route.ts
import { auth, postgresClient } from "denext/server";

const sql = postgresClient(Deno.env.get("DATABASE_URL"));

export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  if (!session) return new Response(null, { status: 401 });
  const { batch } = await request.json(); // validate it: see examples/offline-sync/src/protocol.ts
  await sql.begin(async (tx) => {
    for (const op of batch) {
      if (op.table !== "notes") throw new Error("unknown table");
      if (op.op === "DELETE") {
        await tx`DELETE FROM notes WHERE id = ${op.id} AND owner_id = ${session.user.id}`;
      } else {
        await tx`INSERT INTO notes (id, owner_id, body, updated_at)
          VALUES (${op.id}, ${session.user.id}, ${op.data.body}, ${op.data.updated_at})
          ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, updated_at = EXCLUDED.updated_at
          WHERE notes.owner_id = ${session.user.id}`;
      }
    }
  });
  return Response.json({ ok: true });
}
```

A PATCH carries only the changed columns, so a real route updates only those. Answer 2xx only
once the batch is stored; PowerSync keeps the transaction queued and retries until it is.

## On a device

The sync loop's tests run the client over SQLite in Deno and the backend in process and over
HTTP; `openSqlite`'s native path is tested against a stand-in for the plugin. Neither the example
nor PowerSync's SDK has been run on an iPhone or an Android phone by denext yet.
