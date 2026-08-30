# examples/notes — a real, small denext app

A notes app that answers "is this a toy?" in one read. It uses the pieces a real
app needs, and **every flow works with JavaScript disabled**:

- **Cookie-session auth** — sign in with a Server Action; the session is a
  signed, HMAC-verified cookie (`getSession`). Sign-out clears it.
- **A middleware gate** — `middleware.ts` verifies the session and redirects
  `/notes/*` to `/login` when signed out (a forged cookie can't pass).
- **SQLite via `node:sqlite`** — a real, file-backed SQL database with **zero
  npm** (Deno's built-in `DatabaseSync`). See `lib/db.ts`.
- **Create / edit / delete** — native `<form action={serverAction}>`; no client
  JS.
- **An error boundary that actually fires** — opening the edit page for a note
  you don't own throws an authorization error, caught by `app/error.tsx`. A
  missing note calls `notFound()` → `app/not-found.tsx`.
- **ISR on the public feed** — `app/page.tsx` exports `revalidate`, so the home
  page is served from a cached shell (stale-while-revalidate) in production.

The whole thing renders and functions with **no client runtime**: forms POST to
the Server Actions' generated endpoints and the server 303-redirects back. That
claim is asserted in CI — see `tests/integration/example-notes.test.ts`, which
drives the entire app through a fetch-only, cookie-aware client
(`denext/testing`) with no hydration. If any flow needed JavaScript, that test
would fail.

## Run it

```sh
deno task dev      # http://localhost:3000
# or, production:
deno task build && deno task start
```

Demo accounts (seeded on first run): `demo@denext.dev` and `alice@denext.dev`,
password `password`. The database is a `notes.db` file by default; set
`NOTES_DB=:memory:` for an ephemeral one, and `SESSION_SECRET` to a strong
secret in production.

## Testing an app like this

`denext/testing` is the app-testing story — an in-process, cookie-aware client
that submits the very forms your Server Components render:

```ts
import { createTestApp, createTestClient } from "denext/testing";

const client = createTestClient(await createTestApp("./"));
const page = await client.get("/login");
const res = await client.submit(client.form(page.text), { email, password });
// res.status === 303; the session cookie is now in client.cookies.
```

No build, no browser, no socket — it renders Server Components, runs Server
Actions and `middleware.ts`, and reads cookies exactly as production does.
