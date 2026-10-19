// The notes UI over the local database. Every read and write is local (instant, and it works
// offline); the sync loop runs on an interval, when the device comes back online, and on
// demand.

import { useEffect, useState } from "denext";
import { openSqlite } from "denext/mobile";
import type { Note } from "./protocol.ts";
import { createSyncClient, type SyncClient, type SyncResult } from "./sync-client.ts";
import { SYNC_ORIGIN } from "./config.ts";

/** How often the loop syncs while the app is open. */
const SYNC_EVERY_MS = 10_000;

export function App() {
  const [client, setClient] = useState<SyncClient | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState("opening the local database…");
  const [draft, setDraft] = useState("");

  async function refresh(c: SyncClient): Promise<void> {
    setNotes(await c.list());
    setPending(await c.pending());
  }

  async function sync(c: SyncClient): Promise<void> {
    try {
      const r: SyncResult = await c.sync();
      setStatus(
        r.offline
          ? "offline: changes stay queued on this device"
          : `synced (${r.uploaded} up, ${r.downloaded} down)`,
      );
    } catch (err) {
      setStatus(String((err as Error).message ?? err));
    }
    await refresh(c);
  }

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let opened: SyncClient | null = null;
    const online = () => opened && sync(opened);
    (async () => {
      try {
        const db = await openSqlite("offline-sync.db");
        opened = await createSyncClient(db, { origin: SYNC_ORIGIN });
        if (stop) return;
        setClient(opened);
        setStatus(`local database: ${db.backend}`);
        await refresh(opened);
        await sync(opened);
        timer = setInterval(() => opened && sync(opened), SYNC_EVERY_MS);
        addEventListener("online", online);
      } catch (err) {
        setStatus(String((err as Error).message ?? err));
      }
    })();
    return () => {
      stop = true;
      clearInterval(timer);
      removeEventListener("online", online);
    };
  }, []);

  async function add(event: { preventDefault(): void }): Promise<void> {
    event.preventDefault();
    if (!client || !draft.trim()) return;
    await client.add(draft.trim());
    setDraft("");
    await refresh(client);
    sync(client);
  }

  async function remove(id: string): Promise<void> {
    if (!client) return;
    await client.remove(id);
    await refresh(client);
    sync(client);
  }

  return (
    <main
      style={{
        fontFamily: "system-ui",
        maxWidth: "36rem",
        margin: "2rem auto",
      }}
    >
      <h1>Offline notes</h1>
      <p data-testid="status">
        {status} · {pending} queued
      </p>
      <form onSubmit={add}>
        <input
          aria-label="New note"
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        />
        <button type="submit" disabled={!client}>Add</button>
        <button
          type="button"
          disabled={!client}
          onClick={() => client && sync(client)}
        >
          Sync now
        </button>
      </form>
      <ul>
        {notes.map((note) => (
          <li key={note.id}>
            {note.body}{" "}
            <button type="button" onClick={() => remove(note.id)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
