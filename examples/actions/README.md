# actions — denext Server Actions

A guestbook demonstrating **Server Actions** (`"use server"`) two ways.

## What it shows

- **`"use server"` module** (`app/actions.ts`) — every exported function becomes a
  Server Action: it runs only on the server and gets a secure POST endpoint.
- **Progressive enhancement** (`<form action={submitEntry}>`) — the Server
  Component page renders the action's endpoint URL into the form, so it works with
  **JavaScript disabled**. A native submit runs the action server-side and
  303-redirects back; the mutation shows up on the next render.
- **CSRF protection** — the action endpoint enforces a same-origin check; a
  cross-origin POST is refused.
- **The React 19 form hooks** (`app/live-form.tsx`, a `"use client"` island):
  - `useActionState(addEntry, …)` — wraps the same action so its return value
    becomes state (inline validation errors, no reload),
  - `useFormStatus()` — a pending/disabled submit button.

## Server/Client boundary

`app/page.tsx` is a Server Component that reads the guestbook and renders it. It
composes a `"use client"` island (`live-form.tsx`) which imports the `"use
server"` action — denext discovers this boundary from the import graph, ships the
island's code to the browser, keeps the action's code server-only, and wires the
client's calls to the secure endpoint.

## Run

```sh
# from this directory
deno task dev             # http://localhost:3000
deno task build && deno task start
```
