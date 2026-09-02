import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Databases",
  description:
    "Any database that runs on Deno runs on denext. SQLite and Deno KV are built in and zero-npm.",
};

export default function Database() {
  return (
    <DocsShell
      active="database"
      title="Databases"
      lead="Any database that runs on Deno runs on denext. SQLite and Deno KV are built in and zero-npm."
    >
      <h2>SQLite (node:sqlite, zero-npm)</h2>
      <p>
        Deno ships a built-in SQLite — a real, file-backed database with nothing to install. Open it
        once in a server-only module:
      </p>
      <Code lang="ts">
        {`// lib/db.ts
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(Deno.env.get("DB_PATH") ?? "app.db");
db.exec(\`CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT)\`);

export const listNotes = () => db.prepare("SELECT * FROM notes").all();
export const addNote = (t: string) =>
  db.prepare("INSERT INTO notes (title) VALUES (?)").run(t);`}
      </Code>
      <Code lang="tsx">
        {`// app/page.tsx — read it directly in a Server Component
import { listNotes } from "../lib/db.ts";
export default function Page() {
  return <ul>{listNotes().map((n) => <li key={n.id}>{n.title}</li>)}</ul>;
}`}
      </Code>

      <h2>Deno KV</h2>
      <Code lang="ts">
        {`const kv = await Deno.openKv();
await kv.set(["notes", crypto.randomUUID()], { title: "hi" });
for await (const e of kv.list({ prefix: ["notes"] })) use(e.value);`}
      </Code>

      <h2>Postgres, MySQL, Drizzle</h2>
      <p>
        Use any Deno-native or <code>npm:</code>{" "}
        driver (postgres, mysql2) for a networked database, and Drizzle over the built-in{" "}
        <code>better-sqlite3</code>{" "}
        compat. Keep the connection/pool a module singleton; do mutations in Server Actions.
      </p>

      <Callout kind="note">
        <strong>Prisma is supported</strong> via the Rust-free driver adapter (<code>
          @prisma/adapter-better-sqlite3
        </code>) over Deno's <code>node:sqlite</code>. See the full recipe in{" "}
        <code>DATABASE.md</code> and the working <code>examples/prisma/</code>{" "}
        (schema, generated client, adapter).
      </Callout>
    </DocsShell>
  );
}
