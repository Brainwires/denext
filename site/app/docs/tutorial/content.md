---
title: "Tutorial: a notes app, end to end"
slug: tutorial
lead: Build the repository's examples/notes app step by step — SQLite, a Server Component list, a Server Action form that works without JavaScript, signed-cookie sessions, ISR, an in-process test, a "use client" island that crosses the boundary, and a production build.
---

Everything below is a real, running application: [examples/notes](https://github.com/Brainwires/denext/blob/main/examples/notes)
in this repository. It signs users in, stores notes in SQLite, lists them per user
and on a public feed, and **every flow works with JavaScript disabled**. Each code
block on this page is copied verbatim from a file in that directory — a test in the
repository pins the two together, so the tutorial cannot drift from the code it
describes. (Step 8 adds two files the example deliberately does not ship; a second
test type-checks and runs them against a copy of the example.) Read it top to bottom
to build the app, or clone the directory and follow along.

## 1. Create the project

A denext project is a directory with a `deno.json` — there is no `package.json` and
no install step. `tasks` gives you the three commands you will use, `compilerOptions`
points JSX at denext's runtime, and `imports` maps the `denext` specifiers your code
will import. Because this example lives inside the repository, its import map resolves
to the local checkout; a standalone app maps `denext` to `jsr:@denext/denext` instead,
which `denext create my-app` writes for you — see
[Getting started](/docs/getting-started). A `denext.config.ts` is optional and this
app has none; [Configuration](/docs/config) lists every field.

```json
// examples/notes/deno.json
{
  "tasks": {
    "dev": "deno run -A ../../cli.ts dev .",
    "build": "deno run -A ../../cli.ts build .",
    "start": "deno run -A ../../cli.ts start ."
  },
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "denext",
    "lib": [
      "deno.window",
      "deno.unstable",
      "dom",
      "dom.iterable",
      "dom.asynciterable"
    ]
  },
  "imports": {
    "denext": "../../mod.ts",
    "denext/jsx-runtime": "../../src/jsx/jsx-runtime.ts",
    "denext/jsx-dev-runtime": "../../src/jsx/jsx-runtime.ts",
    "denext/server": "../../src/server/mod.ts",
    "denext/client": "../../src/client/mod.ts",
    "denext/live": "../../src/live.ts",
    "denext/testing": "../../src/testing/mod.ts"
  },
  "lint": {
    "plugins": ["../../src/lint/denext-plugin.ts"]
  }
}
```

## 2. The database module

The data layer is Deno's built-in `node:sqlite` — a real, file-backed SQL database
with zero npm dependencies. The module body runs once per server process, so the
`DatabaseSync` handle is a module singleton and the schema is created on startup
rather than per request. `NOTES_DB=:memory:` swaps in an ephemeral database, which is
what the test in step 7 uses. Deno KV, Postgres, Drizzle and Prisma are all options
too — [Databases](/docs/database) covers them.

```ts
// examples/notes/lib/db.ts
import { DatabaseSync } from "node:sqlite";
import { hashPassword } from "./crypto.ts";

/** A user row (never expose `password_hash` to a view). */
export interface User {
  id: number;
  email: string;
}

/** A note row, joined with its author's email for display. */
export interface Note {
  id: number;
  user_id: number;
  author: string;
  title: string;
  body: string;
  visibility: "public" | "private";
  updated_at: string;
}

const DB_PATH = Deno.env.get("NOTES_DB") ?? "notes.db";
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
```

Every query is a small prepared statement. These two back the two lists in the app —
the public feed and one user's notes:

```ts
// examples/notes/lib/db.ts
const NOTE_COLUMNS =
  "n.id, n.user_id, u.email AS author, n.title, n.body, n.visibility, n.updated_at";

/** Public notes from everyone, newest first — the home feed. */
export function listPublicNotes(): Note[] {
  return db.prepare(
    `SELECT ${NOTE_COLUMNS} FROM notes n JOIN users u ON u.id = n.user_id
     WHERE n.visibility = 'public' ORDER BY n.updated_at DESC, n.id DESC`,
  ).all() as unknown as Note[];
}

/** Every note owned by `userId`, newest first. */
export function listUserNotes(userId: number): Note[] {
  return db.prepare(
    `SELECT ${NOTE_COLUMNS} FROM notes n JOIN users u ON u.id = n.user_id
     WHERE n.user_id = ? ORDER BY n.updated_at DESC, n.id DESC`,
  ).all(userId) as unknown as Note[];
}
```

## 3. List notes in a Server Component

`app/page.tsx` is the `/` route. It is a Server Component by default — there is no
`"use client"` in it and it ships no client JavaScript — so it calls the database
function directly, with no fetch, no API route and no serialization in between. The
file conventions are the App Router's, unchanged: [Routing](/docs/routing) for the
rest of them, [Data fetching](/docs/data) for async components and caching.

```tsx
// examples/notes/app/page.tsx
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
```

## 4. Add a note with a Server Action

`app/actions.ts` opens with `"use server"`, which makes every exported async function
in the file a Server Action: it runs on the server, and denext generates a
same-origin-checked endpoint for it.

```ts
// examples/notes/app/actions.ts
"use server";

// Every exported async function here is a Server Action. Each `<form action={fn}>`
// posts to a generated, same-origin-checked endpoint and works with JavaScript
// disabled — denext renders the endpoint URL into the form and 303-redirects back
// after the action runs.

import { redirect, RedirectType } from "denext";
import { verifyPassword } from "../lib/crypto.ts";
import { createNote, deleteNote, findUserByEmail, getNote, updateNote } from "../lib/db.ts";
import { currentUser, session } from "../lib/auth.ts";
```

`create` takes the `FormData`, requires a signed-in user, writes the row, and
redirects back to the list:

```ts
// examples/notes/app/actions.ts
/** Create a note owned by the current user. */
export async function create(formData: FormData): Promise<void> {
  const user = await requireUser();
  const title = field(formData, "title");
  if (title) {
    createNote(
      user.id,
      title,
      field(formData, "body"),
      visibilityOf(formData.get("visibility")),
    );
  }
  // `RedirectType.push` (Next parity): a soft navigation PUSHES a history entry, so Back
  // returns to the form instead of skipping it (the default replaces the entry).
  redirect("/notes", RedirectType.push);
}
```

The page that renders the form is the whole of `app/notes/page.tsx`: a create form and
one delete form per note, each passing the function itself as `action`. denext renders
the generated endpoint into the form's `action` attribute, so a browser with JavaScript
turned off posts it natively and the server answers with a 303 back to `/notes` — the
no-JS path is the same code path, not a fallback.

```tsx
// examples/notes/app/notes/page.tsx
import { currentUser } from "../../lib/auth.ts";
import { listUserNotes } from "../../lib/db.ts";
import { create, remove } from "../actions.ts";

export default async function MyNotes() {
  const user = await currentUser();
  // middleware guarantees a session, but satisfy the types (and defend in depth).
  const notes = user ? listUserNotes(user.id) : [];
  return (
    <section>
      <h1>My notes</h1>

      <form action={create} method="post" class="stack card">
        <h2>New note</h2>
        <label>
          Title
          <input
            name="title"
            required
            maxLength={80}
            placeholder="A short title"
          />
        </label>
        <label>
          Body
          <textarea name="body" rows={3} placeholder="Write something…" />
        </label>
        <label class="checkbox">
          <input type="checkbox" name="visibility" value="public" />
          Public (show on the home feed)
        </label>
        <button type="submit">Add note</button>
      </form>

      {notes.length === 0 ? <p class="empty">No notes yet — add one above.</p> : (
        <ul class="feed">
          {notes.map((n) => (
            <li key={n.id} class="card">
              <h2>{n.title}</h2>
              <p>{n.body}</p>
              <footer class="row">
                <span
                  class={n.visibility === "public" ? "tag pub" : "tag priv"}
                >
                  {n.visibility}
                </span>
                <span class="grow" />
                <a href={`/notes/${n.id}/edit`} class="linkbtn">Edit</a>
                <form action={remove} method="post" class="inline">
                  <input type="hidden" name="id" value={String(n.id)} />
                  <button type="submit" class="linkbtn danger">Delete</button>
                </form>
              </footer>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

This app re-reads SQLite on every render, so it needs no cache invalidation. A route
that caches its data calls `revalidatePath` or `revalidateTag` from `denext/server`
at the end of the action instead; [Server Actions](/docs/server-actions) covers that,
along with `defineAction` for validated, typed input and `useActionState` for
progressive enhancement with JavaScript on.

## 5. Sign in with a session

`lib/auth.ts` wraps `getSession` from `denext/server` — an HMAC-signed, `httpOnly`
cookie. Only a `userId` goes in the cookie; the user row is loaded from SQLite per
request, so a stale or forged cookie cannot become a user. The secret comes from the
environment, with a development fallback that keeps the demo runnable.

```ts
// examples/notes/lib/auth.ts
import { getSession } from "denext/server";
import { getUser, type User } from "./db.ts";

/** What we keep in the signed session cookie. */
interface SessionData {
  userId: number;
}

/**
 * The session secret. In a real app this is a strong, rotated secret from the
 * environment; the fallback keeps the demo runnable with no setup.
 */
function sessionSecret(): string {
  return Deno.env.get("SESSION_SECRET") ?? "dev-insecure-secret-change-me";
}

/** The current session handle (signed, HMAC-verified). */
export function session() {
  return getSession<SessionData>({ secret: sessionSecret() });
}

/** The logged-in user for this request, or `null`. */
export async function currentUser(): Promise<User | null> {
  const s = await session();
  if (!s.data) return null;
  return getUser(s.data.userId) ?? null;
}
```

The `login` action verifies the password, writes the session, and redirects to the
page the visitor was heading for:

```ts
// examples/notes/app/actions.ts
/** Sign in: verify credentials, store the user id in the session, redirect. */
export async function login(formData: FormData): Promise<void> {
  const next = safeNext(formData.get("next"));
  const user = await authenticate(
    field(formData, "email").toLowerCase(),
    String(formData.get("password") ?? ""),
  );
  if (!user) redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  await (await session()).set({ userId: user!.id });
  redirect(next);
}
```

`middleware.ts` is the gate. It verifies the session before routing — not merely that
a cookie is present — and redirects `/notes/*` to the login page when there is none.
See [Authentication](/docs/auth) for sessions, providers and password hashing, and
[Middleware](/docs/middleware) for the matcher and the request context.

```ts
// examples/notes/middleware.ts
import { type MiddlewareContext, next, redirectResponse } from "denext/server";
import { session } from "./lib/auth.ts";

export default async function middleware(
  _request: Request,
  ctx: MiddlewareContext,
) {
  const path = ctx.url.pathname;
  const gated = path === "/notes" || path.startsWith("/notes/");
  if (gated) {
    const s = await session();
    if (!s.data) {
      return redirectResponse(`/login?next=${encodeURIComponent(path)}`, 307);
    }
  }
  return next();
}

export const config = {
  matcher: "/:path*",
};
```

## 6. Cache with ISR

The public feed is the same for everyone, so it does not need to re-query on every
request. One segment export opts the route into incremental static regeneration: the
page is served from a cached shell and regenerated at most once every 10 seconds,
stale-while-revalidate. It applies to the production server (`deno task start`) —
`deno task dev` always re-renders. [Rendering](/docs/rendering) explains the other
segment options, and [Data fetching](/docs/data) explains invalidating a cache on
demand.

```tsx
// examples/notes/app/page.tsx
// Public home feed. `export const revalidate` opts this route into ISR: it renders
// to a cached shell that is regenerated at most once every 10s (stale-while-
// revalidate), so the feed is cheap under load. Active in `deno task start` (prod).

import { listPublicNotes } from "../lib/db.ts";

export const revalidate = 10; // seconds
```

## 7. Test it without a browser

`denext/testing` runs the whole app in-process: no build, no browser, no socket.
`createTestApp` loads the app directory, and `createTestClient` wraps it in a
cookie-aware client that renders Server Components, runs `middleware.ts` and executes
Server Actions exactly as production does.

```ts
// examples/notes/README.md
import { createTestApp, createTestClient } from "denext/testing";

const client = createTestClient(await createTestApp("./"));
const page = await client.get("/login");
const res = await client.submit(client.form(page.text), { email, password });
// res.status === 303; the session cookie is now in client.cookies.
```

The app's real suite is
[tests/integration/example-notes.test.ts](https://github.com/Brainwires/denext/blob/main/tests/integration/example-notes.test.ts).
It sets `NOTES_DB=:memory:` and a fixed `SESSION_SECRET` before the app loads, then
drives every flow through the rendered HTML — `client.form(page.text)` parses the form
the page just rendered and `client.submit` posts it, so a flow that needed hydration
would fail here:

```ts
// tests/integration/example-notes.test.ts
async function stepSignIn(client: TestClient): Promise<void> {
  const page = await client.get("/login");
  const res = await client.submit(client.form(page.text)); // defaults = demo creds
  assertEquals(res.status, 303);
  assertStringIncludes(res.location ?? "", "/notes");
  assert(client.cookies.get("denext_session"), "a signed session cookie is now set");
}
```

The steps read as the product's own acceptance criteria — which is the point of a
test that only speaks HTTP:

```ts
// tests/integration/example-notes.test.ts
Deno.test("examples/notes: full app works with JavaScript disabled", async (t) => {
  const client = createTestClient(await createTestApp(APP));

  await t.step("home feed shows public notes but not private ones", () => stepHomeFeed(client));
  await t.step("middleware gates /notes when signed out", () => stepGateSignedOut(client));
  await t.step("bad credentials are rejected", () => stepBadCredentials());
  await t.step("sign in through the rendered form (no JS)", () => stepSignIn(client));
  await t.step("the gate now lets the signed-in user through", () => stepGateSignedIn(client));
  await t.step("create a note via the form, then see it listed", () => stepCreateNote(client));
  await t.step(
    "editing a note you don't own hits the error boundary",
    () => stepEditForeignNote(client),
  );
  await t.step("a missing note renders not-found (404)", () => stepMissingNote(client));
  await t.step("sign out, and the gate closes again", () => stepSignOut(client));
});
```

Run it with `deno test -A tests/integration/example-notes.test.ts`. Component-level
tests (`render`, `fireEvent`) and the route conformance probe live on
[Testing](/docs/testing).

## 8. Cross the boundary: a client island

Everything so far ships **no JavaScript** — every file under `app/` is a Server
Component, and the forms post natively. That is the default, and it is the right
default. Now add the two things only JavaScript can do: show the "Add note" button as
pending while the action runs, and make a deleted note disappear before the server
confirms. Both need hooks, and hooks live on the other side of the boundary: in a file
that opens with `"use client"` — a **client island** the page renders. The page stays a
Server Component; the island is the one file the browser runs.

The rule for what the page may hand an island: props travel as data, so they must be
serialisable (the `notes` array is), and a **Server Action crosses as a reference** — the
island receives `create`/`remove` and can pass them straight to `<form action>`, which
keeps the no-JS path intact. A plain function does not cross: `onClick={() => …}` from a
Server Component is dropped, and in dev the renderer warns naming the component and the
prop. [Getting started](/docs/getting-started#server-and-client) has the full list.

The create form becomes an island. `useFormStatus` reads the _nearest enclosing_ form's
in-flight state, so it is called from a child of the `<form>`, not beside it:

```tsx
// app/notes/note-form.tsx (new in this step — not in examples/notes)
"use client";

// The create form as a client island. `action` is the `create` Server Action the page
// hands in — a reference that crosses the boundary — so with JavaScript off the form
// still posts natively to the action's endpoint, exactly as before. With JavaScript on,
// `useFormStatus` reads the enclosing form's in-flight state and disables the button.

import { useFormStatus } from "denext";

export function NoteForm({ action }: { action: (formData: FormData) => Promise<void> }) {
  return (
    <form action={action} method="post" class="stack card">
      <h2>New note</h2>
      <label>
        Title
        <input name="title" required maxLength={80} placeholder="A short title" />
      </label>
      <label>
        Body
        <textarea name="body" rows={3} placeholder="Write something…" />
      </label>
      <label class="checkbox">
        <input type="checkbox" name="visibility" value="public" />
        Public (show on the home feed)
      </label>
      <SubmitButton />
    </form>
  );
}

/** `useFormStatus` is scoped to the nearest enclosing <form>, so it lives in a child. */
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Adding…" : "Add note"}
    </button>
  );
}
```

The list becomes the second island. `useOptimistic(notes, reducer)` returns the list to
render and a function that applies the reducer to it _now_; the value holds until the
real `notes` prop changes — here, when the action redirects back to `/notes`. Each delete
form keeps `action={remove}` (the Server Action, so it still renders an endpoint URL and
posts natively without JavaScript) and gains an `onSubmit` that only exists once the
island has hydrated. The `Note` type comes from `lib/db.ts` as a **type-only** import,
which is erased — nothing of the database module ships:

```tsx
// app/notes/note-list.tsx (new in this step — not in examples/notes)
"use client";

// The list as a client island. `notes` arrives as plain data and `remove` as a Server
// Action reference. Each delete form keeps `action={remove}` — the no-JS path is
// unchanged — and, once hydrated, `onSubmit` hides the note optimistically while the
// action runs. The page re-renders with the real list when the action redirects.

import { useOptimistic } from "denext";
import type { Note } from "../../lib/db.ts"; // type-only: nothing of lib/db.ts ships

export function NoteList(
  { notes, remove }: { notes: Note[]; remove: (formData: FormData) => Promise<void> },
) {
  const [shown, hide] = useOptimistic(
    notes,
    (current: Note[], id: number) => current.filter((n) => n.id !== id),
  );
  if (shown.length === 0) return <p class="empty">No notes yet — add one above.</p>;
  return (
    <ul class="feed">
      {shown.map((n) => (
        <li key={n.id} class="card">
          <h2>{n.title}</h2>
          <p>{n.body}</p>
          <footer class="row">
            <span class={n.visibility === "public" ? "tag pub" : "tag priv"}>
              {n.visibility}
            </span>
            <span class="grow" />
            <a href={`/notes/${n.id}/edit`} class="linkbtn">Edit</a>
            <form action={remove} method="post" class="inline" onSubmit={() => hide(n.id)}>
              <input type="hidden" name="id" value={String(n.id)} />
              <button type="submit" class="linkbtn danger">Delete</button>
            </form>
          </footer>
        </li>
      ))}
    </ul>
  );
}
```

The page shrinks to the part that belongs on the server — the session, the query, and
the wiring. It is still `async`, still imports `lib/db.ts` at value level (a Server
Component may), and still has no `"use client"`:

```tsx
// app/notes/page.tsx (replaces the step-4 version — not in examples/notes)
// The signed-in user's notes. Still a Server Component: it reads the session and the
// database, then hands two islands their data and the Server Actions they call.

import { currentUser } from "../../lib/auth.ts";
import { listUserNotes } from "../../lib/db.ts";
import { create, remove } from "../actions.ts";
import { NoteForm } from "./note-form.tsx";
import { NoteList } from "./note-list.tsx";

export default async function MyNotes() {
  const user = await currentUser();
  const notes = user ? listUserNotes(user.id) : [];
  return (
    <section>
      <h1>My notes</h1>
      <NoteForm action={create} />
      <NoteList notes={notes} remove={remove} />
    </section>
  );
}
```

Run `deno task dev`, open `/notes`, and the route now ships one small bundle — the two
islands and the runtime — while the page, the session and SQLite stay on the server.
The step-7 test still passes unchanged: with JavaScript off the same forms post to the
same endpoints. Two things to keep in mind as you add islands of your own:

- **Do not put the hooks in `page.tsx`.** A page or layout that calls a hook itself, with
  no `"use client"` boundary, makes denext bundle and hydrate the _whole route_ — page,
  layouts and everything they import. That is a compatibility path for apps written that
  way; here it would try to ship `lib/db.ts`, and the build (and `deno task dev`) refuse
  it, naming the module and the route. The fix is always this chapter's shape.
- **Mark server-only modules.** `lib/db.ts` is server-only by nature (`node:sqlite`,
  `Deno.env`); call `serverOnly()` from `denext` at its top (or `import "server-only"` in a
  migrated app) so the intent is explicit and the build failure names the marker.

## 9. Build and run

`deno task dev` serves the app with hot reloading at `http://localhost:3000`;
`deno task build` emits the production output and `deno task start` serves it, with
ISR and error redaction active. The demo accounts are seeded on first run —
`demo@denext.dev` and `alice@denext.dev`, password `password` — and in production you
set `SESSION_SECRET` to a strong secret and `NOTES_DB` to the database path.

```sh
# examples/notes/README.md
deno task dev      # http://localhost:3000
# or, production:
deno task build && deno task start
```

From there it is a Deno process behind whatever you already run: Deno Deploy, a
container, systemd, or a single `deno serve`. [Deploying](/docs/deploy) has the
targets, the environment variables, and the static-export path.
