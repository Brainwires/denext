// Public home feed. `export const revalidate` opts this route into ISR: it renders
// to a cached shell that is regenerated at most once every 10s (stale-while-
// revalidate), so the feed is cheap under load. Active in `deno task start` (prod).

import { listPublicNotes } from "../lib/db.ts";

export const revalidate = 10; // seconds

export default function Home() {
  const notes = listPublicNotes();
  return (
    <section>
      <h1>Public notes</h1>
      <p class="lede">
        Everyone's public notes, served from SQLite via an ISR-cached page. Sign in to write your
        own — the demo accounts are <code>demo@denext.dev</code> and{" "}
        <code>alice@denext.dev</code>, password <code>password</code>.
      </p>
      {notes.length === 0 ? <p class="empty">No public notes yet.</p> : (
        <ul class="feed">
          {notes.map((n) => (
            <li key={n.id} class="card">
              <h2>{n.title}</h2>
              <p>{n.body}</p>
              <footer>
                by {n.author} · {n.updated_at}
              </footer>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
