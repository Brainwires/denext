# Offline sync example (`openSqlite` + a sync backend)

A local-first notes app: every read and write goes to a **SQLite database on the
device** (`openSqlite` from `denext/mobile`), so the app works offline, and a
small sync loop reconciles it with a denext backend when the network is there.
It follows PowerSync's client model (a local write and its queued upload in one
transaction, uploads in order, server changes applied only once the queue is
empty), and the backend's upload route takes PowerSync's upload shape, so the
same route serves a real PowerSync client. The
[PowerSync recipe](https://denext.dev/docs/powersync) covers running PowerSync
itself on denext, and what `openSqlite` can and cannot do there.

## Run it

```sh
deno task backend   # the API on http://127.0.0.1:8788 (backend/)
denext task dev     # the app on http://localhost:3000; /api is proxied to the backend
```

In a browser, `openSqlite` runs the app's own `@sqlite.org/sqlite-wasm`
(persisted to OPFS); install it first with `npm install` (this folder's
`package.json` lists only that package). Without it the app says what to
install.

In the Capacitor shell (`denext migrate --enable-capacitor`, then
`denext mobile add sqlite`), the database is a file in the app's storage through
`@capacitor-community/sqlite`. Set `SYNC_ORIGIN` in `src/config.ts` to the
backend's public https origin before `denext export`; the backend's `cors`
already lets the shell's WebView origins call it.

## How it's wired

| File                               | What it does                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `src/sync-client.ts`               | The local tables, the upload queue (`crud_queue`), `sync()`                    |
| `src/app.tsx`                      | The UI: `openSqlite("offline-sync.db")`, sync on an interval and when online   |
| `src/protocol.ts`                  | The wire format and its validation, shared by both sides                       |
| `backend/app/api/data/route.ts`    | `POST /api/data`: applies an upload batch in one transaction                   |
| `backend/app/api/changes/route.ts` | `GET /api/changes?since=N`: rows changed after a checkpoint, deletions as such |
| `backend/lib/store.ts`             | The server's SQLite (`node:sqlite`), one version sequence, tombstones          |

Tests: `tests/examples-offline-sync.test.ts` (two devices, offline writes,
conflicts, validation) and `tests/integration/example-offline-sync.test.ts` (the
SPA and the backend built, synced over HTTP).
