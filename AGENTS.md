# Writing denext apps (for AI coding agents)

**denext is a complete, lightweight framework for Deno: write an app once and ship it to the web,
iOS, Android and the desktop. Its API is surface compatible with React and Next.js's App Router,
with its own small React core.** If you know Next.js, you already know denext — the file conventions,
hooks, and `app/` router are the same. This file lists ONLY what differs, so you
emit correct denext instead of Next.js.

## The 6 rules that make code denext, not Next

1. **Imports come from `denext`, not `react`.**
   `import { useState } from "denext"`. Server-only helpers come from
   `denext/server`; client-only from `denext/client`. There is **no `react` or
   `react-dom` package** — do not import them (in a _compat_ drop-in, `react` is
   aliased to denext, but new code should import `denext`).
2. **No `package.json`, no `npm install`.** A denext project has a
   **`deno.json`**. Dependencies are URL/`jsr:`/`npm:` imports in `deno.json`'s
   `imports` map. Run it with `denext task dev` / `denext task build` /
   `denext task start` (the `denext` command brings its own Deno — no Deno install needed; with
   Deno installed, `deno task dev` runs the same task; the least-privilege `start` must be launched
   on denext's toolchain — `denext task start`, or the image / unit `denext deploy prepare` writes —
   and stops with the fix on stock Deno). `denext create <dir>` scaffolds one (`--monorepo`: a Deno
   workspace, the app in `apps/web` importing shared `packages/ui` / `packages/shared` by name;
   `denext generate app <name>` adds another app; glob members such as `apps/*`, `packages/**` and `!` exclusions work, and `denext ui`
   / `desktop` / `mobile` at the root run on its app). Migrating a Next app? `denext migrate` does it in one pass
   — writes the `deno.json` alias map so `next/*`+`react` resolve to denext with
   your source unchanged (add `--codemod` to rewrite imports to native `denext`). A **`pages/` (Pages
   Router) app** is migrated too: migrate wires the `@denext/pages-router`
   plugin (`denext.config.ts` + `deno.json`) and rewrites
   `next/router`/`next/head`/`next/link` to the plugin's compat modules.
   A **TanStack Start** app (`@tanstack/react-start` + `tanstackStart()` in vite.config) is wired
   to the `@denext/tanstack-start` plugin, Start's options carried into `tanstackStart({ … })`.
   A **Fresh** app (Fresh 2's `jsr:@fresh/core`, or 1.x's `$fresh/`) keeps its `routes/` and
   `islands/`: migrate generates `app/` + `middleware.ts` around them (`denext/fresh/server` runs
   the handlers, middleware, layouts and `main.ts`'s app builder as Fresh does; `<Partial>`
   regions update in place under `f-client-nav` / `f-partial`; `csp()` merges into denext's
   policy; `import.meta.env` becomes `denext/fresh/env`, public variables only), marks islands `"use client"`, moves
   `static/` to `public/` and maps `fresh`, `preact` and `@preact/signals` to denext
   (`denext/fresh`, `denext/signals`) in its `deno.json`. A **Preact** app (Vite's
   `@preact/preset-vite`, preact-cli, WMR or esbuild) takes the SPA path with the same Preact
   layer (`preact` → `denext/preact`, `@preact/signals` → `denext/signals`, through `resolveAlias`
   for npm packages too); preact-iso maps to `denext/preact-iso`, `preact-render-to-string` to
   `denext/preact/render-to-string` (Preact's markup), `useErrorBoundary` catches, and Preact's
   `options.vnode` / `event` hooks run; preact-router / wouter-preact keep running on the aliases.
   A **Lustre** app (Gleam, `target = "javascript"` or lustre_dev_tools) keeps its Gleam source as
   it is: migrate writes `plugins: [gleam()]` and the `@gleam/` import map, an `app/` page whose
   island calls the entry's own `main`, and moves `priv/static/` to `public/`; Erlang-target code
   is reported, and `lustreElement` / `defineLustreView` are opt-in.
   A **React Router** app (`@denext/react-router`) keeps its route modules: `createContext` /
   `RouterContextProvider` / `MiddlewareFunction` come from `denext/remix` (what `react-router`
   maps to), every loader's and action's `context` is a `RouterContextProvider` (`context.get(key)`
   / `context.set(key, value)`), a route's `middleware` export runs outermost first around
   the request (`next()` resolves to the rendered document, a navigation's payload or the action's
   response), and migrate carries a custom server's `getLoadContext` into
   `load-context.ts` (`defineLoadContext` from `denext/remix/server`):
   https://denext.dev/docs/react-router#load-context-and-middleware.
   Guides: https://denext.dev/docs/migrating-fresh,
   https://denext.dev/docs/migrating-preact, https://denext.dev/docs/migrating-lustre, https://denext.dev/docs/tanstack-start;
   `denext/signals` (Preact Signals' API, usable in any app, not the resumability `useSignal`
   from `denext`): https://denext.dev/docs/signals.
   `denext migrate --check [--json]` previews it (changes, what won't migrate, a verdict) and
   writes nothing; problems denext handles are listed at https://denext.dev/docs/fixed.
   `--desktop` adds a Deno Desktop target; `--enable-capacitor [--app-id <id>] [--platform
   ios,android]` adds an iOS / Android one (a SPA, App Router or Expo app): `capacitor.config.ts`,
   the `mobile:*` tasks, `spa.precompress: false` + `mobile.icon`, Capacitor 8 installed with the
   app's package manager (the install, export and `cap add` run the project's own code: only with
   `--yes` or after a prompt, else printed to run by hand), and review items for what it can't know (a hosted-mode env switch, a
   backend URL a phone can reach, CORS for `capacitor://localhost` / `https://localhost`).
   `denext upgrade [--to <v>] [--dry-run | --check] [--allow-major] [--allow-downgrade]` moves
   the `jsr:@denext/denext` pin, the pinned CLI tasks and every first-party `@denext/*` package
   together (`--allow-major` also lets a package that imports no denext cross a major; an older
   `--to` needs `--allow-downgrade`). `create`, `migrate` and `upgrade` pin only versions
   Deno's minimum dependency age already lets in (never exempt `jsr:@denext/*` from it):
   https://denext.dev/docs/toolchain#supply-chain-hold. From 3.x: https://denext.dev/docs/changelog
3. **File conventions are the same as Next App Router:** `app/page.tsx`,
   `app/layout.tsx`, `app/loading.tsx`, `app/error.tsx`, `app/not-found.tsx`,
   `app/api/x/route.ts`, `app/blog/[slug]/page.tsx`, `middleware.ts`. Server
   Components by default; add `"use client"` at the top of a file for
   interactivity. Keep hooks and event handlers in that `"use client"` file and
   render it from the page — a `page.tsx`/layout that calls a hook itself turns
   the whole route into a client bundle (a compatibility path for migrated apps),
   and that build fails the moment the route reaches a server-only module such as
   `lib/db.ts`.
4. **Async Server Components work**
   (`export default async function Page() { const d =
   await db.query(); ... }`).
   Data fetching stays on the server.
5. **`next/*` still works in a drop-in** (aliased), but for NEW code prefer the
   denext equivalents (see the map). `cookies()`, `headers()`, `redirect()`,
   etc. come from **`denext/server`** (or the `denext/next/*` compat — e.g.
   `denext/next/navigation`, `denext/next/headers`), not `next/*`.
6. **Everything is a web standard.** `Request`/`Response`, `fetch`, `URL`,
   `crypto.subtle`, `Deno.env.get(...)`. Route handlers return a `Response`.

## Next.js → denext import map

| Next.js                                                | denext                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import { useState, useEffect, ... } from "react"`     | `from "denext"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `import { cookies, headers } from "next/headers"`      | `import { cookies, headers } from "denext/server"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `import { redirect, notFound } from "next/navigation"` | `from "denext"` — `redirect`, `permanentRedirect`, `notFound`, `forbidden`, `unauthorized`, `RedirectType` work in Server and Client Components alike (`denext migrate` rewrites `next/navigation` to `denext`). `denext/server` re-exports the same throwing helpers (`redirect` from `denext/server` throws, as in Next); its **middleware** helper that RETURNS a `Response` is `redirectResponse` (`return redirectResponse("/login", 307)` from `middleware.ts`), and inside middleware a thrown `redirect()` / `permanentRedirect()` is turned into that response (307 / 308) |
| `import Link from "next/link"`                         | `import { Link } from "denext"` (or `denext/client`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `import Image from "next/image"`                       | `import { Image } from "denext"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `unstable_cache`, `revalidatePath`, `revalidateTag`    | `from "denext/server"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Route handler `export async function GET(req) {}`      | identical — returns a `Response`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Common tasks

**A page with data (Server Component):**

```tsx
// app/page.tsx
export default async function Home() {
  const posts = await getPosts();
  return <ul>{posts.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}
```

**An interactive component:**

```tsx
// app/counter.tsx
"use client";
import { useState } from "denext";
export function Counter() {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>Clicked {n}</button>;
}
```

Branch on a value in JSX with `choose` from `denext` (Lit-style, lazy; own keys only):
`choose(status, { loading: () => <Spinner />, error: () => <Oops /> }, () => null)`.

In SPA mode a `client:*` directive defers the mount and code-splits the component:
`<Chart client:visible client:placeholder={<Spinner />} />` (`load`/`idle`/`visible`/`interaction`/
`media`/`only`); under `@types/react`, `ClientDirectives` from `denext/jsx-directives` types them.

A SPA can paint and take typing before its bundle runs: `spa.shell: { component:
"./src/AppShell.tsx", props?, bootScript?, platforms?, readyOn?, maxHoldMs? }` server-renders that
pure component (same markup and classes as the app's first screen; `AppShell.desktop.tsx` etc. per
target) into `#root` at build/export/dev, replacing `spa.loading`. Mark fields
`data-denext-shell-key="draft"`; the app renders off-screen and swaps in on its first settled
commit (or `shellReady()` from `denext` with `readyOn: "shellReady"`), and a keyed
`<input>`/`<textarea>` gets the typed text, caret and focus; an editor takes it with
`useShellHandoff(key)` / `consumeShellHandoff(key)`.

**A route handler (API):**

```ts
// app/api/hello/route.ts
export function GET(_req: Request): Response {
  return Response.json({ ok: true });
}
```

**A validated route handler + calling it with end-to-end types (no tRPC):** `defineApi`
takes Standard Schemas (Zod/Valibot/ArkType/TypeBox/hand-rolled) for `params` / `query` /
`body` / `response` plus the `errors` it may fail with; the handler gets parsed, typed input
and a schema mismatch is a structured 400 before it runs. `denext dev`/`build` generate
`.denext/api.ts` from the route modules' TYPES and register it, so `createApiClient()` and
`useApi` type-check every call — path, method, params, query, body, response, error codes.

```ts
// app/api/user/[id]/route.ts
import { createApi, defineApi, requireSession } from "denext/server";
import { z } from "zod";
export const GET = defineApi({
  params: z.object({ id: z.string() }),
  response: z.object({ id: z.string(), name: z.string() }), // strips undeclared keys, in prod too
  errors: { not_found: 404 },
}, async ({ params, fail }) => (await db.users.get(params.id)) ?? fail("not_found"));
export const PATCH = createApi().use(requireSession()).define({
  params: z.object({ id: z.string() }),
  body: z.object({ name: z.string().min(1) }),
  errors: { not_owner: 403 },
}, async ({ params, body, ctx, fail }) => {
  if (ctx.session.user.id !== params.id) fail("not_owner");
  return db.users.update(params.id, body);
});
```

```ts
// anywhere (server component, client component, or a test)
import { createApiClient, isApiClientError } from "denext";
import type {} from "./.denext/api.ts"; // registers the schema (type-only; nothing ships)
const api = createApiClient(); // typed against THIS app's routes
const user = await api("/api/user/[id]", "GET", { params: { id: "1" } }); // user is typed
try {
  await api("/api/user/[id]", "PATCH", { params: { id: "1" }, body: { name: "" } });
} catch (err) {
  if (isApiClientError(err) && err.code === "not_owner") { /* narrowed to the declared codes */ }
}
```

```tsx
// a client component — the hook; GETs in one tick ride ONE batched request
"use client";
import { useApi } from "denext";
export function User({ id }: { id: string }) {
  const { data, error, pending } = useApi("/api/user/[id]", "GET", { params: { id } });
  return pending ? <p>…</p> : error ? <p>{error.code}</p> : <p>{data?.name}</p>;
}
```

A call with a custom header goes alone unless both sides forward it (`apiBatch: { forwardHeaders:
["x-tenant"] }` + `createApiClient({ batch: { forwardHeaders: ["x-tenant"] } })`, each item its own
value; never `cookie` / `authorization` / proxy headers).

A `createApiClient()` / `useApi` call made during a render runs the route in-process under the
visitor's cookie and authorization. If the handler (or `middleware.ts` on that call) reads them —
`request.headers`, a `NextRequest`'s `cookies`, `cookies()` / `headers()` — the calling page is
per-visitor: an ISR render is not stored, and a Cache Components shell makes the enclosing
`<Suspense>` a per-request hole. Keep handlers a cached page calls free of visitor reads, or put
per-user calls under their own `<Suspense>`: https://denext.dev/docs/data#per-visitor-api-reads.

Add the `@denext/openapi` plugin (`plugins: [openapi()]` in `denext.config.ts`) and those same
definitions serve `GET /openapi.json` (OpenAPI 3.1) + a docs page at `GET /docs`, write
`openapi.json` at build, and back `denext openapi emit | diff | lint | types | client` — zero extra
annotation (`client --lang python|go|swift|kotlin` writes a dependency-free typed client; `denext
graphql client` does the same from a GraphQL schema).
Schemas that implement Standard JSON Schema (Zod ≥ 4.2, ArkType, Valibot) or TypeBox are
described in full; others are `{}` + a lint warning.
Need GraphQL? `@denext/graphql` mounts GraphQL Yoga at `/graphql` (any `GraphQLSchema`;
Pothos recommended, no decorators) and `fromChannel(channel, key)` turns a `createChannel`
into a subscription source behind the channel's `authorize` — the same push the Live socket
delivers, over SSE or WebSocket (`graphql-ws`); `schema: "./app/graphql/schema.ts"` reloads in dev.

A plain handler still works and is still typed: return `TypedResponse<T>` / take a
`TypedRequest<B>` from `denext/server`. A plain `route.ts` body is capped at 1 MiB
(`export const maxBodyBytes = N | false`); `redirect()`/`notFound()` inside one are HTTP
responses; a thrown `ApiError(status, code, { data })` is a typed JSON error envelope.
`createApi().use(…)` stacks middlewares from `denext/server`: `requireSession({ role })`,
`requireBearer({ scope })`, `rateLimit(…)`, `cors(policy)` (the app `cors` shape, scoped to the
method it guards: its preflight is answered before `middleware.ts`, and it replaces the route's
and the app's policy there) and `csrf()` (a cookie-carrying cross-origin mutation is a 403
`csrf_failed`, the Server Actions rule; `{ doubleSubmit: true }` also wants an `x-csrf-token`
header echoing its `denext-csrf` cookie).

**Typed live data (validated subscription + server push):**

```ts
// app/live.ts
"use server";
import { createChannel, defineSubscription } from "denext/server";
export const orderStatus = defineSubscription({
  input: z.object({ id: z.string() }), // validated on every subscribe
  tags: ({ id }) => [`order:${id}`], // server-derived; re-pushed on revalidateTag
  authorize: async ({ id }) => (await auth())?.user.id === (await db.orders.owner(id)),
  resolve: ({ id }) => db.orders.status(id),
});
export const orderEvents = createChannel<{ status: string }>({
  authorize: async (_ctx, key) => key === `user:${(await auth())?.user.id}`, // REQUIRED
});
// anywhere on the server: await orderEvents.publish(`user:${userId}`, { status: "shipped" });
```

```tsx
"use client";
import { useChannel, useSubscription } from "denext/live";
import { orderEvents, orderStatus } from "./live.ts";
const { data } = useSubscription(orderStatus, { id }, { initial });
const { data: event } = useChannel(orderEvents, `user:${userId}`);
```

A channel with `history: 50` logs each key's publishes: `useChannel(ch, key, { since: "0",
onMessage })` replays the key's history after `authorize`, and a reconnect resumes from its last
cursor (in memory per instance; `redisChannelTransport()` shares the log in Redis).

**Model–View–Update (Elm / Lustre style):** `denext/mvu` runs `update(msg, model) → [model,
effects]` in a component, with effects and subscriptions as data the runtime executes; the same
program held on the SERVER per Live connection is `defineLiveView` from `denext/live` (HTML first
paint, events over the socket, DOM patches back).

```tsx
// app/counter.tsx — a server module; render <Counter start={1} /> from a Server Component
import { defineLiveView } from "denext/live";
import { fx, subs } from "denext/mvu";
export const Counter = defineLiveView({
  id: "counter", // stable, app-unique
  init: (props: { start: number }) => [{ n: props.start, on: false }],
  update: (msg: { type: "inc" } | { type: "toggle" }, m) =>
    msg.type === "inc"
      ? [{ ...m, n: m.n + 1 }, [fx.task(() => db.save(m.n + 1))]]
      : [{ ...m, on: !m.on }],
  subscriptions: (m) => [m.on && subs.interval(1000, { type: "inc" })],
  view: (m, send) => <button type="button" onClick={send({ type: "inc" })}>{m.n}</button>,
  authorize: async () => (await auth()) !== null, // render, mount, resume, then every TTL
  // events: z.object({ value: z.string().max(200).optional() }) — validates send((p) => …) payloads
});
// In the browser instead: useMvu(() => [model], update, subscriptions) or <MvuView program={…} />.
```

`send(msg)` sends only a handler index (the message stays on the server); a reconnect within
`live.limits.viewResumeSeconds` resumes the model for the same viewer, else `init` re-runs. Set
`DENEXT_LIVE_VIEW_SECRET` (16+ characters) on every instance. Docs:
https://denext.dev/docs/live-views, https://denext.dev/docs/mvu

**A typed Server Action (the mutation side, also type-checked):** `defineAction` validates
`FormData` into a typed input (a parser, or a Zod/Valibot/any Standard Schema) and its `Out`
flows into `useActionState`.

```ts
// app/actions.ts
"use server";
import { ActionValidationError, defineAction } from "denext/server";
export const createPost = defineAction({
  input: (f) => ({ title: String(f.title ?? "").trim() }), // typed input: { title: string }
  handler: async ({ title }) => {
    if (!title) throw new ActionValidationError("bad", { title: "Title is required" });
    return { id: await db.posts.insert({ title }) }; // Out inferred: { id: string }
  },
});
```

```tsx
// app/new-post.tsx
"use client";
import { idleActionState, useActionState } from "denext";
import { createPost } from "./actions.ts";
export function NewPost() {
  const [state, action] = useActionState(createPost, idleActionState<{ id: string }>());
  return (
    <form action={action}>
      <input name="title" />
      {!state.ok && state.fieldErrors?.title} {/* typed */}
      {state.ok && `created ${state.data.id}`} {/* typed */}
    </form>
  );
}
```

Server Action ids are an HMAC under a secret `denext build` generates, so every build gets new ids;
a deploy that builds more than once (one image per region, say) sets `DENEXT_ACTION_ID_SECRET` (16+
characters) to one value for every build and instance. Only the `"use server"` exports some module
imports are callable: an export nothing imports answers 404 (`denext build` lists them; `denext dev`
keeps them callable with a warning).

**Errors as values (opt-in):** `denext/result` has `Result` / `ok` / `err` / `tryAsync` and an
exhaustive `match(x).with(pattern, fn)….exhaustive()` (a missing case is a compile error;
`assertNever(x)` does the same in a `switch` `default`). A `defineApi` handler may
`return err("code", init?)` instead of `fail()` (the code must be declared in `errors`), and a
`defineAction` handler `return err("message", { fieldErrors })`. React's throws stay: Suspense,
`notFound()` / `redirect()` and error boundaries (`tryAsync` re-throws them). Opt-in lint rules
`denext/exhaustive-switch` and `denext/no-throw` come from `denextLintPlugin(options)`. Docs:
https://denext.dev/docs/errors-as-values

**Reading cookies / a session (auth):**

```ts
import { redirect } from "denext";
import { auth, cookies, createApi, getSession, requireAuth, requireSession } from "denext/server";
// cookies are Secure (over HTTPS) + httpOnly + SameSite=Lax by DEFAULT; pass { httpOnly: false } to opt out.
const session = await getSession<{ userId: string }>({
  secret: Deno.env.get("SESSION_SECRET")!,
});
if (!session.data) redirect("/login");
await session.set({ userId: user.id }); // sign in

// With the `denextAuth({ … })` plugin the same three calls cover server, middleware and API:
const s = await auth(); // anywhere on the server; null while a second factor is pending
// middleware.ts — a Response to redirect (302 + ?error=forbidden), or null to continue:
export const middleware = (request: Request) => requireAuth(request, { role: "admin" });
// a route handler — requireSession({ role }) refuses with 403:
export const GET = createApi().use(requireSession({ role: "admin" })).define(/* … */);
```

**Clerk (hosted auth):** `@clerk/nextjs` runs unchanged in compat mode: `clerkMiddleware()` +
`createRouteMatcher` in `middleware.ts`, `<ClerkProvider>` in the root layout, `auth()` /
`currentUser()` from `@clerk/nextjs/server` in Server Components and route handlers. In a Deno Desktop
window the same provider signs in via `installClerkDesktopBridge({ nativeClerk: true })` from
`desktop.preload`; the Clerk instance's `allowed_origins` must include `desktop.app.origin`. In the Capacitor shell:
`installClerkMobileBridge({ scheme, nativeClerk: true })` from `denext/mobile/clerk` in
`instrumentation-client.ts`; `denext mobile add clerk --scheme <s>` sets it up (add
`capacitor://localhost` + `https://localhost` to `allowed_origins`). See
[`examples/clerk`](https://github.com/Brainwires/denext/tree/main/examples/clerk).

**next-auth (Auth.js v5 / NextAuth.js v4):** `NextAuth()`, `next-auth/react`, `next-auth/jwt`
and every `next-auth/providers/*` module but 3 run unchanged on `denextAuth` (the OAuth / OIDC
ones generated from `@auth/core` by `deno task gen:auth-providers`); `next-auth/providers/passkey`
turns on denext's passkeys and `signIn("passkey")` / `signIn("passkey", { action: "register" })`
from `next-auth/webauthn` drive them (through an Auth.js adapter the ceremony's challenge lives in
`cache.store`, so a shared store needs no sticky sessions). A provider's `checks` decide PKCE and
the OIDC `nonce`, as in Auth.js (`Reddit({ checks: ["state"] })`). Set `AUTH_URL`. See
https://denext.dev/docs/auth.

Persist users with an adapter (`sqliteAuthAdapter({ path })` on `node:sqlite`, or
`inMemoryAuthAdapter()`), and gate a machine-to-machine API with
`requireBearer({ scope: "pets:write" })` (it reads the config `denextAuth()` was built with;
pass `authConfig` first to be explicit) — it self-documents as `bearerAuth`
for `@denext/openapi` (declare the matching `securitySchemes: { bearerAuth: … }` once in the
`openapi()` options). `credentials()` with no `authorize` verifies against the adapter
(`getUserByEmail` + `getCredential` + the hasher). Passwordless: `providers: [magicLink(),
emailOtp()]` plus `sendVerificationRequest` (`smtpMailer({ host, user, pass, from })` from
`denext/server`, TLS required, or your own); a magic link opens a click-to-confirm page by
default, so a mail scanner's pre-fetch can't spend it (`magicLink({ confirm: false })` opts out). Passkeys: `passkeys: true` (or `{ rpId, rpName, userVerification }`) mounts
`/auth/passkey/*`, and `registerPasskey()` / `signInWithPasskey()` from `denext/client` (check
`passkeysSupported()`) sign in usernameless or complete a pending second factor; a native app
(with `native`) uses `/auth/native/passkey/*`, and `passkeys.androidApps: [{ packageName,
sha256CertFingerprints }]` accepts its `android:apk-key-hash:` origin (serve the same object as
`appLinks.android` for the `get_login_creds` assetlinks statement). An OAuth / OIDC
provider takes `responseMode: "form_post"` (the callback is then a POST). Second factor: an
enrolled user's sign-in comes back pending; your `pages.mfa` page renders when
`pendingMfaSession()` returns a session and posts `{ code }` to `/auth/mfa`; enrollment is
`/auth/mfa/enroll` → `/auth/mfa/confirm` (from a complete session it needs a recent sign-in,
`session.authTime`); `totpQrSvg(uri)` renders the enrollment QR code as SVG. TOTP secrets are
sealed at rest under `secret`; with `secret: [current, previous]` a factor sealed under the
retired one opens and is re-sealed on its next passing check, or at once with `denext auth reseal`
(`resealTotpFactors(config)` in a job); remove the retired secret once it reports zero remaining.
SSO: `saml()` signs in through a SAML 2.0 identity provider on `/auth/*`, and
`microsoftEntra({ tenant: "common" | "organizations" | "consumers", allowedTenants })` takes a
multi-tenant app (keyed on `tid` + `oid`). `passkeys: { attestation: { mds: {} } }` checks new
passkeys against the FIDO Metadata Service (OCSP, then CRL revocation; fail-closed unless
`attestation.revocation: "soft"`). A session ends `session.maxLifetime` after its sign-in (default 30 days) however often it
slides. `revokeSession(id)` with `currentSessionId()` (server-only) signs out one device, a
stateless session too (the adapter's revocation list). `events.apiTokenIssued` / `apiTokenRevoked` report every bearer token minted or retired
(id and owner, never the token). Full guide: https://denext.dev/docs/auth

Per-request facts from anywhere on the server (`denext/server`): `clientIp()` (the proxy's last
`x-forwarded-for` hop only with `trustForwardedHeaders` / `DENEXT_TRUST_PROXY=1`, else the socket
peer; a dynamic read like `headers()`), `requestId()` (the log / `x-request-id` correlation id —
an inbound one is reused only behind a trusted proxy) and `requestSignal()` (the disconnect /
timeout `AbortSignal` to thread into `fetch()`; `undefined` inside `use cache`). `denextAuth`
inherits the app's `trustForwardedHeaders` unless it sets its own. Per-address limits
(`rateLimit()`, auth's per-IP budgets, `live.limits.maxConnectionsPerIp`, `clientIpForLimits()`)
skip a loopback/private peer with no trusted hop; `rateLimitHeader: "cf-connecting-ip"` keys them on
the address a proxy writes there (Supabase's `GOTRUE_RATE_LIMIT_HEADER`; a request without it falls
back, never unlimited), believed only from a trusted proxy — a peer in `rateLimitTrustedProxies`
(CIDRs, e.g. Cloudflare's ranges), or with none listed a loopback/private peer under
`trustForwardedHeaders` (any other peer is keyed as itself) — and `rateLimitLocalAddresses: true`
counts such a peer as itself.

**A project-local CLI verb (no plugin):** put it in `denext.config.ts` and run it as a verb.

```ts
// denext.config.ts
export default {
  commands: [{ name: "seed", summary: "Load fixtures", run: (ctx) => seed() }],
};
// `denext seed` — same flag parsing, --help and did-you-mean as a built-in. List this
// project's own verbs with `denext commands [--json]`; they are in shell completions too.
// `denext --help` lists them from the cache `denext commands` wrote (`.denext/commands.json`,
// fingerprinted against denext.config.* / deno.json / deno.lock) without importing your
// config; before the first run, or once one of those files changes, it points at `denext commands`.
```

**One executable for the server:** `denext build --compile [--target <triple>] [--output <path>]`
builds, then `deno compile`s the app (server modules, `pages/`, `.denext/`, `public/`, `jobs/`, `services/`, migrations,
`compile.include`) into `dist/<name>`. `./app` serves like `denext start` (`--port` / `$PORT`), and
`./app job <name>` and `./app db migrate` run jobs and migrations. Stylesheet imports work with no
import map. No `.env` file is embedded: the environment, `.env` files and relative data paths are
read from the working directory, and state goes to `./.denext`. It bakes Docker's least-privilege
`--allow-*` plus `compile.permissions: { write, run, ffi, sys, netConnect, netListen }` (`"all"`
opts in to `--allow-all`; `netConnect` / `netListen` bake `--allow-net` split by direction,
`--allow-net-connect` / `--allow-net-listen`, on denext's Deno 3.0.0-rc.2+). Generated deploy files
(`generate docker`, `genericHost()`) and desktop packaging on the pinned runtime split it too: the
server listens only on its port or loopback. The runtime is the toolchain's own `denort` (SHA-256-pinned beside the CLI), so
`Deno.SQL` works in the binary. `--sign` (or `compile.sign`) code-signs it: macOS with `codesign`
(Hardened Runtime + V8's `allow-jit` entitlement) as `DENEXT_CODESIGN_IDENTITY`, then `notarytool`
with `DENEXT_NOTARY_PROFILE` or an API key (`DENEXT_NOTARY_KEY` / `_KEY_ID` / `_ISSUER`); Windows
with `signtool` or, from macOS / Linux, `osslsigncode` and `DENEXT_WINDOWS_CERT`. Env-only
credentials; `--sign` fails without them, `compile.sign` warns. Docs:
https://denext.dev/docs/deployment-targets

**Code health and concurrency:** `denext create --fallow` (or `denext fallow init` in an existing
app) adds the fallow gate denext itself uses — `fallow.toml` with the path-loaded files as entry
points, `deno task fallow:audit` / `coverage:fallow` / `hooks:install` (a pinned `npm:fallow`
through Deno, nothing global). Commands that write `.denext/`, `out/`, `dist/` or a coverage dir
take Cargo-style OS locks: `Blocking waiting for file lock on …` means another denext command
holds that directory — wait; never delete `.denext/.denext-lock*` (the OS releases a lock when its
holder exits).

**A GUI over the project:** `denext ui` serves a loopback (127.0.0.1) project-management
page — schema-driven `denext.config.ts` editing (a comment-preserving splice: outside the
value span it replaces, the file keeps its bytes), a Cron page (every schedule, when it
next fires, an editor with a shape builder, and run history when `jobs.history` is on),
plugins with option forms for the first-party ones and JSR search, every `generate` kind,
Docker files (with the self-hosted stack's toggles) plus in-place `docker-compose.yml`
editing, a Desktop panel that composes the
signing setup from the identities the keychain holds, a Setup page that readies a fresh
clone, a Dev page that starts and stops the dev server, a Tasks page for the scripts
`deno.json` declares, a Services page (the `services/` tree), a Database section (tables, a SQL
editor, RLS, migrations, storage, users, logs, realtime, Edge Functions, health) and the project's
own verbs. It works with JavaScript disabled, and
**project code never runs in the UI's process** — every project-touching operation,
including verb discovery (`denext commands --json`), is a `deno` subprocess.
`--read-only` prevents writes by the UI, not execution of your config inside that
discovery child. `--offline` keeps the UI and every process it starts off the network.
Docs: https://denext.dev/docs/ui

**A Capacitor shell:** `denext/mobile` (client-only) — `isNativeShell()`, `runtimePlatform()`
(`"ios" | "android" | "desktop" | "web"`), `useAppResume`, `openExternal`, `useKeyboardInset`,
`useBackSwipe`, `SAFE_AREA_CSS`, `installMomentumSafeScroll` / `useMomentumSafeScroll`. It talks
to Capacitor through `window.Capacitor`, so no `@capacitor/*` import. iOS momentum scrolling
survives virtualized-list scroll corrections automatically (the runtime installs the shim on iOS
WebKit; `momentumSafeScroll: false` opts out). Native capabilities with web fallbacks: `haptic`,
`readClipboard`/`writeClipboard`, `share`, `deviceInfo`, `networkStatus`/`useNetworkStatus`,
`useKeepAwake`, `hideSplash`, `secureStore` (NOT secret on the web; `{ accessibility }` sets the iOS Keychain class), `readFile`/`writeFile`/
`listDir`/`downloadToFile` (OPFS on the web), `pickImage`/`pickMedia` (several photos and
videos)/`pickDocument`/`scanBarcode`/`pickContact` (`null` when cancelled), `setQuickActions`/`useQuickAction`
(home-screen shortcuts), `openSqlite` (the
app's own `@sqlite.org/sqlite-wasm` on OPFS on the web; `encryptionKey` / `PRAGMA key` is SQLCipher
in the shell and refused on the web, `db.rekey(newKey)` changes it; syncing it with a server or PowerSync:
https://denext.dev/docs/powersync) and `showContextMenu` /
`useContextMenu` (native in the shell once `denext mobile add context-menu` installs the plugin:
`UIMenu` with the lifted preview on iOS, `PopupMenu` on Android; an in-page menu elsewhere,
Deno Desktop included); `denext mobile add <capability...> [--dry-run] [--list]`
installs their plugins, and `deep-links --scheme/--domain` / `push` add
`onDeepLink`/`useDeepLink` (filtered by `accept`, routed once) and
`requestPushPermission`/`registerForPush`/`onPushTapped` (no web push; your server sends via
APNs/FCM; Android needs `google-services.json`). Your own native code: `nativeModule<Spec,
Events>(name)` is a typed async client for the Capacitor plugin `name` (the desktop extension on
Deno Desktop, `null` on the web), `native-module --name <Name>` generates one (Swift + Kotlin +
`native/Native<Name>.ts`), and React Native mode's `TurboModuleRegistry` / `NativeModules` /
Expo `requireNativeModule` resolve to it (every call async; no JSI). Native views:
`<NativeViewSlot type="video" | "map" | …>` / `useNativeViewSlot` keep a native view on a DOM
box (children are the web fallback); `denext mobile add native-views` (built-in `video`) /
`native-map` (MapKit / osmdroid). `placement: "auto"` is `"embed"` (inside the page's scroll
view) on iOS except `video`, which is `"under"` (AVPlayerViewController with system controls,
the page painting over it), and `"over"` on Android; `scrollPassthrough` (`"vertical"` by
default for `video`) lets a drag on the view scroll the list. In React Native mode `expo-maps` /
`react-native-maps` → the map view, `expo-video` / `react-native-video` → the video view,
`expo-symbols` → `<SystemIcon>`. `auth-session --scheme myapp` adds
`openAuthSession(url, { callbackScheme })` (OAuth in an iOS ASWebAuthenticationSession / Android
Custom Tab / web popup finished by `completeAuthSession()`, and in a Deno Desktop window the
system browser with a loopback redirect; resolves the callback URL; the URL must carry PKCE S256,
else `pkce_required`, unless `pkce: "not-applicable"` + `reason`; `state` is yours).
App extensions: `denext mobile add share-extension | widget --name <N> [--configurable
<param:enum=a|b>] | live-activity --name <N>` generate the native targets behind
`onShareReceived`, `setWidgetData`/`reloadWidgets` and
`startLiveActivity`/`updateLiveActivity`/`endLiveActivity` (iOS only; they share an App Group).
Live reload on a device: `denext mobile dev --lan` points the app's `server.url` at
`denext dev` for the session (restored on exit); a non-loopback host loads the dev assets only
when opted in (`denext dev --lan`, `--host`, `allowedDevOrigins`), and a network bind requires its
per-run token from other machines (the printed URL carries `?__denext_dev=…`). Native plugins answer only
the app's own origin (plus `server.url` in a debug build): a hosted `server.url` or an
`allowNavigation` page that calls plugins needs `plugins: { DenextBridge: { allowedOrigins: […] } }`
(or `frameGuard: false`) in the Capacitor config. Docs:
https://denext.dev/docs/mobile

The momentum shim is not Capacitor-only: it installs for every iOS/iPadOS WebKit visitor,
Safari included, whenever `momentumSafeScroll` is on (the default).

More `denext mobile add` capabilities (a pinned Capacitor 8 plugin, or denext's own native plugin
for `permissions`, `accessibility`, `storage`, `system-icons` and `file-transfer`; `system-bars` uses Capacitor
core and `offline-screen` writes a page; web fallback where one exists): `keyboard`
(`useKeyboard`, `<KeyboardAvoidingView>`, `<KeyboardStickyView>`), `back`
(`onBack`/`useBackHandler`, `useBackProgress` for Android predictive back), `system-bars`
(`setSystemBars`, `useSystemBarsFollowTheme`; `useSafeAreaInsets()` needs nothing),
`permissions` (`checkPermission`/`requestPermission`/`usePermission` → granted | limited |
prompt | prompt-with-rationale | denied | blocked; `openAppSettings`), `local-notifications` (`scheduleNotification`; `deliveredNotifications` / `removeDeliveredNotifications({ threadId })` list and clear delivered ones, pushes too),
`biometrics` (`authenticateBiometric`; `secureStore.set(k, v, { requireBiometric: true })`, which the OS
enforces: a Keychain access control / an Android Keystore key, never readable by page script),
`social-login` (`signInWithApple`/`signInWithGoogle` → `signInNative`), `geolocation` /
`background-location`, `background-audio` (`setNowPlaying`/`onMediaControl`/`setAudioSession`:
background playback with lock-screen / notification controls; the Media Session API on the web),
`file-transfer` (`downloadToFile` / `uploadFile` with `onProgress`, `signal` and an `id` in a
`URLSession` background session / WorkManager, outliving the app; `pauseFileTransfer` /
`resumeFileTransfer` (range resume) / `cancelFileTransfer` / `fileTransfers` / `onFileTransfer`;
`fetch` streams + `XMLHttpRequest` on the web), `purchases` (RevenueCat), `app-review`, `app-update`,
`screen-orientation`, `media-library`, `privacy-screen`, `tracking` (ATT), `background`
(`defineBackgroundTask` in `background/`, no DOM), `restore` (Android process death),
`accessibility` (`useScreenReader`, `getFontScale` / `applyFontScale` for Dynamic Type),
`storage` (`openKeyValueStore`: durable SQLite, behind React Native mode's AsyncStorage / MMKV;
`--encrypted` adds SQLCipher for `openKeyValueStore(name, { encrypted: true })`, its key in
`secureStore`, refused with `ENCRYPTION_UNAVAILABLE` wherever it cannot encrypt, the web included;
`rekeyKeyValueStore(name)` rotates that key, crash-safe),
`system-icons` (`<SystemIcon>`: SF Symbols in the iOS shell, Material Symbols elsewhere),
`sentry` (`initCrashReporting`) and `offline-screen`; `useReducedMotion()` needs nothing. An exported multi-page app in the shell needs `export-routes` (Capacitor serves the root `index.html` for every extensionless path; any denext native plugin includes it, and `denext mobile doctor --release` checks it).
`dialog` / `toast` / `action-sheet` back React Native mode's `Alert` / `ToastAndroid` / `ActionSheetIOS`. `<PullToRefresh>` needs no plugin; `readSafeAreaInsets()` / `watchSafeAreaInsets(cb)` read the insets outside a component. Store tooling: `denext mobile privacy` (the iOS privacy
manifest), `denext mobile doctor --store | --release`, `denext mobile inspect`.
Ship without a hosted service: `denext mobile assets` (every icon + splash from one image; with
no `--icon` it takes `mobile.icon`, `assets/icon.png`, an Expo app config's icon (a sibling
monorepo app's too, read statically), the web manifest's icon, the apple-touch-icon, then a PNG
favicon, and says which; `migrate` records it as `mobile.icon`, `mobile build` replaces Capacitor's
placeholder icon), `denext mobile build ios|android [--release] [--flavor <name>]` (export → `cap sync` → a signed
`.ipa` / `.aab` in `dist/mobile/`; flavors in `mobile.flavors`), `denext mobile submit
ios|android [--dry-run]` (App Store Connect / Google Play). Teams already on fastlane keep it:
`denext mobile add fastlane [--ci]` writes `fastlane/` (Appfile from capacitor.config, Matchfile,
`ios|android build|beta|release` lanes that run `denext mobile build --release` and hand the
artifact to match / TestFlight / Play tracks; `flavor:` / `build_number:` pass through) and, with
`--ci`, a GitHub Actions workflow; `denext mobile doctor --release` checks it.
Run the lanes with `denext fastlane ios beta` (`denext create --fastlane` scaffolds them): denext's
managed fastlane, a pinned fastlane on a pinned portable Ruby installed on first use into the
toolchain cache (SHA-256-verified Ruby, checksum-locked gems; needs a C compiler once; macOS and
Linux, not Windows; `toolchain install --with fastlane`, `DENEXT_FASTLANE=<path>` overrides it;
plugins need a Gemfile and `bundle exec`).
Profile the installed app on an Android device: `denext profile --android [--package <appId>]
[--device <serial>]` reaches its debuggable WebView over adb and reports CPU, heap and leaks like
the local `denext profile` (https://denext.dev/docs/profile).
Credentials are env-only. App backend:
`cors` in config, `denextAuth({ native })` sessions, `createApiClient({ base, auth:
nativeSession(…) })`, `sendPush` from `denext/server`. Docs: https://denext.dev/docs/mobile,
https://denext.dev/docs/app-backend

**Platform-specific files:** `BigButton.ios.tsx`, `.android`, `.mobile` (any phone), `.macos` /
`.windows` / `.linux`, `.desktop` (any desktop OS) and `.web` beside a plain `BigButton.tsx`, as in
React Native. Import the plain module (`./BigButton`, `./BigButton.tsx`, or an alias such as
`@/components/BigButton`); each target's export picks its file (ios: `.ios` → `.mobile` → `.web`
→ plain) and drops the rest. `build`, `start` and a plain `export` are the `web` target; `denext dev`
serves `web` unless a shell names its target (`mobile dev`, `desktop dev`). `denext export
--platform <t>` (or `DENEXT_PLATFORM=<t>`), `denext mobile build` and `denext desktop build` /
`package` build the others. `createOtaHandler({ platforms })` serves each target its own export;
a shell refuses another target's UI (`platform_mismatch`). A small branch: `import { platform } from "denext/platform"` (`"web" | "ios" | …`), folded to the
target's name at build time on every path (`platform === "ios"` → `true` / `false`), so other
targets' branches are dead-code-eliminated. `.native` is opt-in (`platformExtensions: { native: true }`);
only the app's own modules take a variant; keep a plain file so type checking resolves.
Docs: https://denext.dev/docs/platform-files

**A long list:** `VirtualList` / `useVirtualList` from `denext` (rows measured as they render,
10M rows, exact `scrollToIndex`, `anchor="end"` for bottom-anchored lists, sticky headers,
grids, `onEndReached`, React Native's viewability and scroll props); `VirtualMasonry` from
`denext/virtual-masonry`, `useVirtualReorder` for drag-to-reorder. `lists: "denext"` (config)
makes every `@legendapp/list/react` import a LegendList built on `VirtualList`. Swipe actions:
`<SwipeableRow leading={[…]} trailing={[{ label, tone, onPress }]}>` from `denext` (transform-only,
VirtualList-safe, full swipe runs the first action, real buttons; RNGH `Swipeable` /
`ReanimatedSwipeable` resolve to it in React Native mode). Docs: https://denext.dev/docs/lists

**Native-feel navigation:** `denext/navigation` (client) — `StackLayout` in a `layout.tsx`
keeps pushed screens mounted with platform animations and the iOS swipe back, `TabsLayout`
keeps each tab's state, `Sheet` is a bottom sheet with detents; a page sets
`export const screenOptions = { title, presentation }`; `useStackNavigation()` pushes and
pops. On another router (TanStack Router, React Router, none): `<HistoryStack
history={tanstackHistory(router)} screens={[{ path: "/$id", render, options }]} />` (screens read
`useScreenMatch()`, not the router's hooks) and `HistoryTabs`; the back swipe starts anywhere
there (`fullScreenSwipe`, or a screen's `fullScreenGestureEnabled`). Docs:
https://denext.dev/docs/navigation-native

**Deno Desktop capabilities:** the same `denext/mobile` functions reach the desktop runtime when
`runtimePlatform() === "desktop"`, once enabled with `denext desktop add <capability...>`
(`secure-store`, `fs`, `sqlite`, `context-menu`, `shell`, `dialogs`, `notifications`,
`keep-awake`, `clipboard`, `device`, `auth-session`, `passkeys`, `global-shortcuts`, `launch-at-login`, `updates`; written to
`desktop.capabilities`), plus desktop-only
`openPath`, `revealInFileManager`, `moveToTrash`, `saveFile`, `pickFolder`, and
`desktopExtension<typeof ext>(name)` from `denext/desktop/client` for your own native code
(`desktopOs()` there returns the window's OS — `"darwin"` / `"windows"` / `"linux"` — with no capability).
The runtime answers `fs`, `sqlite`, `device`, `dialogs`, `shell`, `keep-awake`, `secure-store`
(macOS Keychain, written by the app's own process so another program gets macOS's prompt, not the
secret; items an older denext wrote through `/usr/bin/security` move over during the first launch
only; an unsigned build has no protection against another program's writes; Linux libsecret inside the runtime — no `secret-tool`; the `.deb` / `.rpm` depend
on `libsecret-1-0` / `libsecret` — Windows PasswordVault; on Linux a missing Secret Service provider
or a locked keyring rejects `backend_unavailable` with the reason) and your `defineDesktopExtension` modules (from
`denext/desktop`, listed in `desktop.capabilities.extensions`; a handler's
`ctx.runOnMainThread(fnPtr, context?)` calls a C function on the UI thread — full trust, grant `ffi`
in `desktop.extraPermissions`, `unsupported` on the stock runtime) — but only when `desktop.ts`
spreads `...(await resolveDesktopCapabilities(config, { base: import.meta.url }))` into
`runDesktop` (a new scaffold and a `migrate --desktop` entry do; an entry from before 2.11 must
add it, else every call answers `unavailable`). Under the pinned runtime `notifications` are the OS's own: scheduled
(repeating ones 16 occurrences ahead, topped up while the app runs), cancel / pending, category action
buttons, and clicks (the launch click too) routed to `onLocalNotificationTapped`;
`requestPermission("notifications")` / `requestPushPermission()` report the OS setting;
`deliveredNotifications()` / `removeDeliveredNotifications()` read and clear the OS notification centre
on macOS and Windows (on Linux, what denext posted this run). `context-menu`
is the native menu (submenus, `destructive` items in red, an item's `iconPng`, `null` on dismiss).
`share()` opens the OS share sheet over the window (macOS, Windows; `shareFromWindow({ files })` from
`denext/desktop/window` shares picked / app-folder files). `denext/desktop/app` (no `add`): `setAppMenu([...])` +
`onAppMenuItem(id => …)` with accelerators, roles, PNG `icon`s and `destructive` items, `createTray({ icon, tooltip, menu })`
(or the backend-owned `desktop.tray` with a `panel`, `getTray()`; `tray.on("contextmenu" | "auxclick" |
"mouseenter" | …, detail => …)` with button / modifiers / position and `tray.popUpMenu()` on runtime
3.0.0-denext.6), `setActivationPolicy("accessory" | "regular")` (`desktop.app.activationPolicy`: no Dock
icon from the first frame), `openWindow({ url, overlay, focusable: false, … })` and the overlay calls
(`setHitRegion`, `setIgnoreMouseEvents`, `setVisibleOnAllWorkspaces`) in `denext/desktop/window`,
`setBadge(n)`, `bounce()`, Handoff / Spotlight on macOS (`setUserActivity({ type, title, url, userInfo,
searchable })`, `onUserActivityContinued`; list the types in `desktop.macos.userActivityTypes`);
`setQuickActions` sets the macOS Dock menu. With no tray host (stock GNOME)
`createTray` rejects `unsupported` with `error.data.reason` (a hidden window is shown); `appCapabilities()`
reports `trayHost` / `secretService` / `sessionType` / `cookieEncryption` (`"basic"` — obfuscated,
not OS-protected — for an ad-hoc signed macOS CEF build; a team-signed one keeps its key in its own
`"<app id> Safe Storage"` keychain item, `"os"`) / `sandbox` / `fileChooser` / `windowBlur` / `passkeys` from the
runtime's probe (`"unknown"` before the runtime that added each), and `denext desktop doctor [--linux]`
lists what the session lacks, with fixes. `desktop.linux.requireSandbox: true` makes a Linux CEF app
exit 78 instead of running without Chromium's sandbox (a tarball / AppImage on Ubuntu 23.10+).
`desktop.windows.proxy: "direct"` keeps a Windows CEF window off a slow WPAD / PAC lookup (`"system"`, the
default, warms the resolver up at launch). A window hands at most 3 refused navigations a second to the
browser. `registerShortcut(accel, fn)`
needs `global-shortcuts`; `setLaunchAtLogin(on)` needs `launch-at-login`. DevTools are on in
`desktop dev` / `run` and off when packaged unless `desktop.inspectable: true`;
`denext desktop dev --inspect-renderer[=<addr>]` opens the window's page to a CDP client (CEF,
WebView2; a free loopback port by default, non-loopback refused). `denext desktop run` / `dev` build the app into a temp dir with the
packaging scripts' least-privilege flags and launch it (a bare `deno desktop` only compiles). An extension's
`--allow-*` goes in `desktop.extraPermissions`, never in `scripts/package-*.ts`. Under the stock
runtime these answer `unavailable` and the page keeps its web path. Under the pinned runtime `clipboard` reaches the OS clipboard
(`readClipboard({ format: "html" | "image" })`, `writeClipboard({ html, text? } | { image })` with
base64 PNG, `clipboardFormats()`) and `dialogs` uses the OS's own panels (MIME `types` → filters).
The window: `denext/desktop/window` (no `desktop add`) — `maximizeWindow` / `minimizeWindow` /
`restoreWindow` / `setFullScreen` + `onWindowStateChange`, `getWindowState` (persist `normalBounds`),
`setWindowBounds` / `setMinimumWindowSize` / `setMaximumWindowSize`, `getScreens` + `onDisplayChanged`,
`setTitleBarStyle` / `setWindowButtonPosition` / `setWindowBackdrop` (Mica / Acrylic / vibrancy),
`makeWindowDraggable(el)` for a hidden title bar (a double click does the user's title-bar action),
`getTitleBarPreferences()` / `onTitleBarPreferencesChange` (the user's button side and order,
double-click action, colour scheme — for an app-drawn title bar), `onCloseRequested(() => boolean)` (cancelable close),
`closeWindow` / `quitApp`, `onFileDrop` (read-only picked handles) and
`startFileDrag([{ directory: "cache", path } | { directory: { picked } }])`; first-window config is
`desktop.window` / `titleBar` / `backdrop` / `minSize` / `maxSize`. All but size, position, title and
show / hide need the pinned runtime (`unsupported` elsewhere; ask `windowCapabilities()`). React Native desktop
`View`'s `mouseDownCanMoveWindow`, `allowsVibrancy` and `draggedTypes` + `onDrop` work in the window. Node-API addons (an npm package's prebuilt `.node`) load in a
packaged app on macOS, Windows and Linux: import them in a `defineDesktopExtension` module and set
`desktop.extraPermissions: { ffi: ["*"] }` (`"*"` bakes the unscoped flag). A full-app update is
confirmed automatically once the new version's window loads; `desktop.update.autoConfirm: false`
leaves it to `confirmAppUpdate()`. Packaging is least-privilege: `scripts/package-*.ts` derive
`--allow-*` from `desktop.capabilities` instead of `-A` (`clipboard`, `global-shortcuts`,
`launch-at-login`, `notifications` and declared `desktop.app.deepLinks` bake an unscoped
`--allow-sys`, which the pinned runtime requires for them), and
`denext desktop package --regenerate-scripts` rewrites them from the current template (a `.bak`
and a diff for each changed file). Installers: `desktop.installers.{macos,linux,windows}` (or
`denext desktop package --format …`) — macOS `.dmg` (+ a signed `.pkg`), Linux `.tar.gz` + `.deb`
(+ `.rpm`, AppImage), Windows a per-user-or-machine `.msi` (+ `.zip`); an empty list builds just
the bundle.
A stable window origin: `desktop.app.origin: "myapp://app"` (a custom scheme; it requires
`desktop.app.identifier`) — the scripts write `.deno-desktop/app.json` + `compile.include` and the
packaged `laufey-launch.json` (its `bridgeOrigins` limits the window's native JS bridge to the app
origin; `desktop.app.bridgeOrigins` adds others). The window stays on that origin: a top-level
navigation anywhere else (a link, a script, a redirect, `window.open`) opens an `http(s)` URL in
the user's browser and drops any other, unless `desktop.app.allowedNavigationOrigins` lists it
(exact origins, such as an identity provider that signs in inside the window). It takes effect under denext's pinned Deno Desktop runtime, which
`denext desktop` and the package scripts download and SHA-256-verify (Deno 2.9.8 exactly: stock, or denext's Deno toolchain built from it; denext pins runtime 3.0.0-denext.6 and needs at least 2.9.7-denext.14, and the runtime takes its own version from 3.0.0-rc.1 on: `3.0.0-rc.N`, then `3.0.0-denext.N`, which denext orders above every rc; there is no upstream 3.0 (upstream stays on 2.9.x LTS, and denext's runtime is the forward line), and from 3.0.0-rc.3 denext tells its Deno by `Deno.build.denext` and the `denext <version> (Brainwires)` line of `deno --version`, never the version alone; what it changes and why: https://denext.dev/docs/desktop-runtime;
`DENEXT_DESKTOP_RUNTIME=stock` opts out on a stock Deno CLI only (`DENEXT_DENO=stock`; denext's Deno refuses it, because a stock runtime can't run what it compiles), and the stock runtime keeps the loopback origin); the gates
detect which one they run under. Packaging is per target, not per host: Linux and Windows apps
package from any host under the pinned runtime; macOS apps package on a Mac. `denext desktop run` /
`dev` build on denext's Deno toolchain, which always matches; only under an explicit
`DENEXT_DENO=stock | <path>` or `DENO_BIN` at a stock Deno of another version do they warn and use the stock runtime;
`package` refuses. A default installer that can't be built (missing tool, WiX other than 5,
a version MSI/Debian can't express) is skipped with a warning; an asked-for one fails.
`DENEXT_LOCK_TIMEOUT=<seconds>` bounds a build-lock wait. `runDesktop` resolves to `{ window, trust, emit, sidecar }`: `emit(cap, event, data)` pushes an OS event the page receives with `onDesktopEvent(cap, event, fn)` from `denext/desktop/client` (kept until the page subscribes).
Sidecars (an Electron app's spawned backend): `desktop.sidecars` (or `runDesktop({ sidecars })`,
`defineSidecar`) — `run: { module }` runs in a worker of the app's own runtime (no second binary;
`nodeModules` bundles a Node backend at packaging, native addons + `external` copied beside it),
`run: { exec }` spawns a program (one JSON line on stdin; exit on stdin EOF). `port: "auto"`, `ready`
(`http` / `stdout` / `signal` / `probe`), `restart` (backoff, `maxAttempts`), `shutdown.graceMs`,
`secrets` (`"$random"`), `bootstrap`, `expose`, `logs`, `proxy: true` (points `spa.proxy` at it),
`permissions` (baked). In the module: `globalThis.denextSidecar` (`port`, `bootstrap`, `secrets`,
`ready()`, `onShutdown`); `import.meta.main` is false. A child of itself (Electron's
`spawn(process.execPath, [script, "mcp-bridge"])`): `denextSidecar.spawnSelf(args)` (or
`childCommand(args)` → `{ command, args, env, stdio }` with `"ipc"`) re-runs the app's executable
headless on the same module (`denextSidecar.child` is true; the pinned runtime authorizes it without `permissions.run`, which the stock runtime and `deno run` need). `app.sidecar(name)` (`status`, `onStatus`,
`restart`, `stop`), `stopSidecars()`; page: `sidecarStatus` / `onSidecarStatus` / `restartSidecar` /
`sidecarInfo` from `denext/desktop/client`. `denext desktop add sidecar --name --entry
--node-modules` writes one. Docs: https://denext.dev/docs/desktop#desktop-sidecars
Under the pinned runtime: `desktop.preload` (Electron's preload: bundled and inlined first into every
top-level page; trusted, same world as the page); `desktop.app.deepLinks` / `singleInstance` deliver
links to `onDeepLink` and opened files to `onOpenFile` (read-only handles); `openAuthSession` takes a
custom-scheme callback (a declared scheme, PKCE S256 mandatory, exact redirect + `state`, owner-checked;
`claimDeepLinkScheme` only on a user action) — on macOS it runs in `ASWebAuthenticationSession` (a real
`cancelled`; `preferEphemeral` for a private session; a page cancel, the timeout or leaving the page closes the sheet), and where the system browser has the sign-in
(Windows, Linux, the loopback flow) denext shows a Cancel overlay (`cancelOverlay: false` to render
your own wired to `signal`); `installClerkDesktopBridge()` from `denext/desktop/clerk`
makes `@clerk/electron`'s React provider and `passkeys` run unchanged
(`denext desktop add secure-store auth-session passkeys`).
Native passkeys are macOS (needs the associated-domains entitlement: `desktop.macos: {
provisioningProfile, entitlements }` signs it in with the profile) and Windows; Linux has no OS
passkey API, so there USB security keys work natively under runtime 3.0.0-rc.1+ (libwebauthn beside
the host) and `denext/desktop/clerk` signs in through the browser otherwise. On Linux a `.deb` / `.rpm` install
(xdg-desktop-portal 1.19+, systemd user manager) posts scheduled notifications while the app is closed
and a click starts it; an AppImage or tarball delivers only while the app runs. OS limits:
https://denext.dev/docs/limitations
Under the pinned runtime the page's own WebSockets dial the runtime's loopback relay with its
per-launch token (`DENO_DESKTOP_WS_URL`, injected into the app's top-level page; where the engine
omits `Sec-Fetch-Dest`, the `Origin` check still holds, so only a same-origin frame could get it): denext's Live
client does this itself; for your own sockets use `desktopWebSocketUrl(path)` from
`denext/desktop/client` (never the bare relay origin: it answers 403). With `notifications` enabled, the web `new Notification(...)` /
`Notification.requestPermission()` / `onclick` work, backed by the OS (no icons or buttons).
`openAuthSession(url, { loopbackPort: 1455 })` uses a fixed loopback port for a provider with a
registered `http://localhost:<port>/…` redirect (`port_in_use` when taken). `desktop.denoFlags`
passes allow-listed `deno desktop` flags (never permission flags); npm resolution needs none:
a project with a package.json or node_modules, a pnpm workspace included, is built with
`--node-modules-dir=none --exclude-unused-npm` already. The bundle's name, identifier and icon come from
`desktop.app.name` / `identifier` / `icons.{macos,windows,linux}`, falling back to deno.json.
A denext backend (`denext start` / `denext dev`) accepts the app's own `desktop.app.origin` as
same-origin (Server Actions, the API batch, Live, `denextAuth` POSTs, the dev origin gate) by exact
match; a separate backend lists the origin in `allowedDevOrigins` (custom-scheme entries are allowed)
or `createApp({ allowedOrigins })`.
Docs: https://denext.dev/docs/desktop#desktop-capabilities

Over-the-air UI updates (Capacitor): `spa.ota: true` (or `denext ota manifest <dir>`) stamps
`_denext/ota.json`; `denext ota keygen` + `--sign` / `DENEXT_OTA_SIGNING_KEY` sign it (a signed
manifest expires: 30 days, `--expires-in <days>`; past it every shell refuses it, code `expired`,
so re-sign the live release; an app with a key embedded takes only its platform's stamped export,
`denext export --platform ios` or `ota manifest --platform ios`, code `platform_mismatch`, and
only a release signed for its own app: `--app-id <id>`, by default the Capacitor `appId` /
`desktop.app.identifier`, code `app_mismatch`);
`denext mobile add-ota [--public-key <file>]` installs the native plugin (and embeds the key);
`checkForUiUpdate` / `prepareUiUpdate` / `applyUiUpdate` / `otaBooted` from `denext/mobile`
drive it; `createOtaHandler` from `denext/server` serves the export. A downloaded UI is
re-verified at every launch and on each file's first serve: one changed on the device is refused
(the bundled UI is served, `onOtaRejected` fires, `otaStatus().tampered` names it), and
`denext mobile doctor --release` flags a plugin from before re-verification. Without an embedded public key,
an unsigned UI is accepted only from an origin pinned with `add-ota --ota-origin` (https) or a
loopback host; an unpinned `https` server is refused too (`insecure`). Whether a change can ship over the air:
`denext mobile fingerprint [--diff old.json] [--write]` hashes the native layer, and
`denext ota manifest --native-fingerprint auto` makes a binary with another fingerprint refuse
the UI (`native_mismatch`). A Deno Desktop app gets the same signed updates from
`denext/desktop/updater` (`checkForDesktopUpdate` / `prepareDesktopUpdate` /
`applyDesktopUpdate`), and full-app updates under the pinned runtime (`checkForAppUpdate` /
`downloadAppUpdate` / `installAppUpdateAndRelaunch` / `confirmAppUpdate`: a signed manifest from
`denext desktop publish-update`, no downgrades, the same code-signing identity required (on macOS: the same Team ID and a notarized build; on
Windows: on every PE file, which the package script signs), an atomic
bundle swap that rolls back if the new version never confirms). The manifest expires (`expiresAt`,
default 30 days, `expired`) and carries a growing `sequence` (`replayed`): re-sign it before it
expires with `denext desktop publish-update --resign` (`publish-update` warns when the manifest in
`--out` expires within 7 days); the artifact must be built as the version
published (`version_mismatch`).
One "update everything" button for every platform: `checkForUpdates(cfg?)` / `applyUpdates(cfg?,
onProgress)` from `denext/updates` (opt-in, client) run the phone's OTA (`cfg.ota`), a Deno Desktop
app's UI overlay (`desktop.update.ui = { feedUrl, publicKey }`, which `runDesktop` also serves) then
its full app through the `updates` capability (`denext desktop add updates`, download `percent`),
or a browser reload when `/_denext/ota.json`'s version (or `cfg.web.versionUrl`) changes. One
progress shape `{ target: "ui" | "app" | "web", stage, version?, percent?, error?, code? }`; a
phone UI for another binary is `needsStoreUpdate`; a desktop overlay alone is `restartRequired`;
a reload / relaunch never settles. Docs: https://denext.dev/docs/updates

**An Expo / React Native app on the web:** `reactNative: true` (with `mode: "spa"`) builds the
app's own source through `react-native-web` (`react-native` → react-native-web, `.web.*` first,
expo-router's routes); on the App Router (no `mode: "spa"`) Server and `"use client"` components
import `react-native` too, server-rendered with react-native-web's style sheet in the `<head>`
(no expo-router there). Every `expo-*` import resolves to a `denext/expo/*` shim over
`denext/mobile` (`denext/expo/manifest` lists what each omits; the synchronous JSI APIs are not
provided). React Native's mocked APIs (`Keyboard`, `BackHandler`, `StatusBar`, `Alert`,
`RefreshControl`, `Linking`, …) are replaced with shell-backed ones, `FlatList` / `SectionList` /
FlashList / LegendList run on `VirtualList`, expo-router's and React Navigation's stacks and
tabs on `denext/navigation`, Reanimated needs no Babel plugin, and popular native libraries
(react-native-webview, -keychain, -permissions, safe-area-context, …) resolve to denext
implementations (`reactNative: { aliases: { "<pkg>": false } }` restores one).
`Platform.OS` stays `"web"`; read `Platform.constants.denextShell`. `reactNative.desktopPackage: "react-native-macos" | "react-native-windows"` builds the app's own `react-native` imports as that desktop package. `denext migrate --from expo`
writes the `deno.json`, the config and a `capacitor.config.ts`, and reports native-only packages;
`denext mobile add app-config` carries the app config's usage strings, Android permissions and
`expo-build-properties` into the shell, and the shims over a plugin have their capability
(`text-to-speech`, `contacts`, `calendar`, `print`, `brightness`, `intent-launcher`; migrate
suggests them).
`denext dev` hot-swaps an edited component with its state kept (Fast Refresh); a top-level
`requireNativeModule` loads off-device and throws only when called. Native-only SDKs
(`@react-native-firebase/*`, `react-native-iap`, `@stripe/stripe-react-native`) have no alias:
https://denext.dev/docs/native-sdk-recipes. Unistyles 3 needs no setup (its wrapped components and
`useVariants`; `reactNative: { unistyles: false }` turns it off), Tamagui runs on its runtime
styles, and Metro's `require.context` with literal arguments is generated at build. Renderers built
on `react-reconciler` load (React Native Skia's `<Canvas>`, react-three-fiber, react-konva):
contexts and class components work inside their trees, and the providers above reach a
react-three-fiber `<Canvas>` / react-konva `<Stage>` (its-fine's bridge), not a Skia Canvas (as in
React): Skia imports CanvasKit's wasm with `?url`, and under a CSP needs
`'wasm-unsafe-eval'` in `scriptSrc` (React Native mode also needs `'unsafe-inline'` in `styleSrc`).
Docs: https://denext.dev/docs/react-native

**File storage (the `@denext/backend` plugin):** `plugins: [backend({ storage: { driver:
s3({ region, bucket, endpoint? }) | fs({ dir }), buckets: { avatars: { public?, maxBytes?, mime?,
authorize: ({ session, op, key }) => boolean } } } })]` (S3 / R2 / MinIO via SigV4, zero npm). Server:
`storage.bucket(n).createSignedUploadUrl / createSignedUrl(key, { transform }) / upload(key, body,
{ upsert?, cacheControl?, metadata? }) / download / info / exists / copy / move / listFolder / list /
remove` and `storage.createBucket / updateBucket / deleteBucket / emptyBucket` from
`@denext/backend/server` — inside a request `authorize` (`{ session, identity, op, key }`) runs and its
absence denies; outside a request only `{ service: true }` (which skips it) works. Browser:
`uploadFile(bucket, file, { onProgress })` / `getFileUrl` from `@denext/backend/client`. It also serves
Supabase's Storage API at `/storage/v1` — stock `supabase.storage` (supabase-js v2) works unchanged,
plus TUS uploads at `/storage/v1/upload/resumable` (`/sign` + `x-signature` for a signed upload),
`listV2`, and Supabase-style object versioning (`versioned: true` / `versioningStatus`, `versionId`
reads and deletes, lifecycle rules); with `backend({ supabase })` keys the secret key is the service
role. Object/bucket rows live in Supabase's `storage.objects` / `storage.buckets` (Postgres) or a
`node:sqlite` file; `storage: { rls: true }` authorizes with SQL policies on them
(`storage.foldername(name)`, `auth.uid()`). Set `DENEXT_STORAGE_SECRET` (≥ 32 chars). Docs:
https://denext.dev/docs/backend
Supabase clients: `backend({ supabase: true | { auth: { … } } })` installs the API keys
(`DENEXT_PUBLISHABLE_KEY` / `DENEXT_SECRET_KEY`, ES256 `DENEXT_JWT_SIGNING_KEYS`, legacy
`DENEXT_JWT_SECRET`; `denext backend keys` mints them) and serves GoTrue's `/auth/v1` over the
`denextAuth()` users, so stock `supabase.auth.*` works (password, OTP / magic link, phone via
`sendSms`, anonymous, OAuth incl. stored `custom:` providers, Web3 (`web3`), MFA with TOTP / SMS /
WebAuthn factors, passkeys, SAML SSO, the OAuth 2.1 server (`oauthServer`), admin API). `resolveIdentity()` from
`@denext/backend/server` resolves any request (access token → secret key → denext session → anon);
`db()` uses it.
Edge Functions: `backend({ functions: {} })` serves `functions/<name>/index.ts` (a Supabase
`Deno.serve(handler)` module, unchanged; `denext generate function <name>`) at
`/functions/v1/<name>` for `supabase.functions.invoke`, each in its own Worker; callers need a
valid identity (anon key, access token or session) unless `functions: { functions: { <name>: { verifyJwt: false } } }`.
With `postgres`, `vault: {}` (`vault.createSecret` / `vault.get`, AES-GCM under `DENEXT_VAULT_KEY`,
server-only; `vault: { sql: true }` adds `vault.create_secret()` / `vault.decrypted_secrets`
inside `vault.withKey(fn)` and `denext db push`), `queues: {}` (pgmq's SQL API + `pgmq_public`, no extension; `queue(name).send/read`,
`queueConsumer({ queue, handler })` as a job), `denext generate vector-search <table>` + `matchDocuments()` (pgvector)
and `webhooks: { hooks: { name: { url } } }` (`supabase_functions.http_request('name')` triggers,
delivered signed + retried) from `@denext/backend/server`; the plugin adds the Postgres half of
`denext db`: `diff | pull | dump | lint | inspect <report> | test` (pgTAP) `| types` (whole-schema
`Database` type, `supabase gen types`-shaped), and applies its own migrations first on `db push`;
also `denext storage ls | cp | mv | rm` (`ss:///bucket/key`), `denext functions new | list | serve |
delete`, `denext backend token --sub <id>` (a test bearer JWT) and `denext gen types | keys |
bearer-jwt`. `denext stack up | down | status | logs` runs the `generate docker` stack like
`supabase start` (writes it and a generated `.env` when missing; `status --show-secrets`), and
operates it: `health [--json] [--watch]`, `logs --level/--since/--until/--grep`, `passwd
--postgres|--dashboard [--generate]` (ALTER ROLE first; a password only from stdin), `roll
[--include-secret] [--keep-old | --drop-old]` (`--keep-old` keeps the previous keys valid until
`--drop-old`), `backup [--full]` / `restore <file> [--yes]` (`--restart` / `--no-restart`
after a `.env` change). Its `dashboard` service is `denext dashboard`: `denext ui`'s Database
section (tables and rows, a SQL editor, RLS policies, storage, auth users, realtime, Edge
Functions, logs, health) on
`127.0.0.1:3100` behind `DASHBOARD_PASSWORD` (rate-limited sign-in, a `__Host-`/`Secure` session cookie over https,
CSRF on every change); `--dashboard-logs` adds the relay its Logs page reads the stack through.

**A database (zero-npm, server-only module):**

```ts
// lib/db.ts — Deno's built-in SQLite; no install.
// KV / Postgres recipes: https://denext.dev/docs/database
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(Deno.env.get("DB_PATH") ?? "app.db");
export const listNotes = () => db.prepare("SELECT * FROM notes").all();
```

Open the connection once at module scope; do writes in Server Actions.
Prisma (SQLite / Postgres) with no npm driver: `new PrismaClient({ adapter: new
PrismaDenoSql(Deno.env.get("DATABASE_URL")!) })` with `PrismaDenoSql` from `denext/prisma-adapter`
(Prisma's `prisma-client` generator, `runtime = "deno"`; needs runtime 3.0.0-rc.1+);
`denext migrate` wires it (`--prisma-adapter deno-sql | npm | auto`).
Postgres (every replica sharing one database): `postgresClient(url)` from `denext/server` is a
tagged-template client on `Deno.SQL`, built into denext's managed Deno toolchain (on stock Deno:
`fromPostgresJs(postgres(url))` with `npm:postgres`); `postgresAuthAdapter`, `postgresSessionStore`,
`postgresRateLimitStore` and `postgresCacheStore` take `{ sql | url, schema? }` and create their
tables by migration on first use (under the migration lock). The same cache / session / rate-limit
stores ship on Redis 7+ (`redisCacheStore` / `redisSessionStore` / `redisRateLimitStore`, `{ client |
url, prefix? }`, on denext's zero-npm RESP client `redisClient(url)`) and Deno KV (`denoKvCacheStore`
/ `denoKvSessionStore` / `denoKvRateLimitStore`, `{ kv | path, prefix? }`); `cacheStoreContract` /
`sessionStoreContract` / `rateLimitStoreContract` from `denext/testing` test your own. Live across
replicas: `setChannelTransport(redisChannelTransport({ url }))` (channels, tag pushes and
`usePresence` rooms over Redis pub/sub). Behind PgBouncer in transaction mode,
pass `directUrl` too (`backend({ postgres })` reads `DATABASE_DIRECT_URL`): LISTEN, reserved
connections and migrations take the direct connection (`withDirectConnection(pooled, direct)`).
`DENEXT_BOOT_DDL=off` makes startup change no schema and fail with `BootSchemaError` while a
migration is missing; `denext db push` / `migration up` then apply denext's own schemas with the
app's. With `@denext/backend`, `backend({ postgres: {} })` (reads
`DATABASE_URL`) + `db()` from `@denext/backend/server` + `denextAuth({ adapter: backendAuthAdapter() })`.
`db()` is scoped by Supabase-compatible row-level security: each query runs as `authenticated`
(the request's user in `request.jwt.claims`, so policies use `auth.uid()` / `auth.jwt()`) or `anon`
(signed out, or outside a request), transaction-locally; `db({ as: { id } })` acts for a user in a
task, and `db.service()` bypasses RLS (maintenance only). Tables need `grant … to authenticated`.
Realtime from the database: `backend({ postgres, realtime: realtime({ tables: { notes: {} } }) })`
installs triggers that NOTIFY keys only; `useTableChanges("notes", { initial, filter?, events? })`
from `@denext/backend/client` keeps rows live (filters `eq neq lt lte gt gte in`), each change
re-read AS the subscriber under RLS (a delete only to subscribers who could see the row; once
per identity per burst, whatever the filters), and a reconnect within `replay.retentionSeconds`
(60) is replayed from the instance's journal (else `stale`);
`onTableChange(table, fn)` / `tableChanges(table, { as, onChange })` from `@denext/backend/server`,
and `revalidate: true` pushes `table:<name>` tags. The same option serves Supabase Realtime at
`/realtime/v1/websocket`: stock `supabase.channel()` — `postgres_changes`, broadcast (also
`realtime.send()` / `realtime.broadcast_changes()` in SQL, `broadcast()` on the server), presence
across instances, private channels under `realtime.messages` policies, replay — works unchanged;
tables also opt in by `alter publication supabase_realtime add table …`; `useBroadcast` /
`useRealtimePresence` from `@denext/backend/client` reach the same channels natively;
`realtime({ source: "logical" })` reads the WAL (pgoutput) instead of triggers + NOTIFY. Needs a
client with `listen` (`Deno.SQL`, or `fromPostgresJs`).
Auto-REST: `backend({ postgres: {}, rest: {} })` serves granted tables with RLS on (and
`security_invoker` views; others only when named in `rest.tables`) and the functions anon /
authenticated may EXECUTE, with PostgREST 12's wire format at `/rest/v1/<table>` and
`/rest/v1/rpc/<fn>` — embeds through foreign keys (`select=*,author:users(name),tags!inner(*)`),
`or` / `and` trees, every operator, aliases, casts, JSON paths, upserts, `PUT`, counts, CSV,
views, computed fields / relationships, aggregates (opt-in `rest.aggregates`), OpenAPI at `GET /rest/v1`,
`Accept-Profile` across `rest.schemas` — each statement through `db()` under RLS, behind a
per-client budget (`rest.rateLimit`, default 1200/min per user or address, never the secret key;
`429 over_request_rate_limit` + `Retry-After`; `false` turns it off). The stock
`@supabase/supabase-js` `from()` / `rpc()` / `schema()` work against it unchanged, and so does
`from("notes").select("id,body").eq("id", 1)` / `rpc()` from `@denext/backend/client`; the
generated `.denext/rest.ts` is `supabase gen types`-shaped (`createClient<Database>()`).
`denext generate migration <name>` (= `denext migration new`) writes
`migrations/<timestamp>_<name>.sql` with `-- migrate:up` / `-- migrate:down` sections and a
`jobs/migrate.ts` runner (`migrateSqlite` / `migratePostgres`; a Prisma or Drizzle project is
pointed at its own tool). The Supabase CLI's verbs, on SQLite or Postgres, no plugin needed:
`denext migration list | up [--to v] | down [--steps n | --to v | --force-reset --yes] | repair
--status applied|reverted <v> | squash | fetch`, `denext db migrate | rollback | status | push |
reset --yes | seed | link --url <pg-url>` (`--db-url <url>` / `--linked` pick another database; a
`supabase/migrations/` project keeps `supabase_migrations.schema_migrations`). `denext migrate`
is the framework migrator, not these; `generate seed` an idempotent `jobs/seed.ts`;
`generate ci` a GitHub Actions workflow; `generate docker` the Dockerfile and a compose stack
detected from the project (`--stack`: Postgres 17, MinIO with a bucket bootstrap when the storage
driver is `s3()`, a one-shot `denext job migrate`, `.env.example` listing every secret;
`--postgres`/`--no-postgres`, `--pgvector`, `--storage`, `--migrate`, `--expose-db`, `--dev`,
`--dry-run`, `--force`). `denext routes [--json]` lists the app's pages and API routes.

**Deploying (adapters):** `denext build` writes `.denext/deploy-manifest.json` (the typed
`DeployManifest` from `denext/deploy` / `denext/plugin-kit`: routes as `static` / `isr` /
`dynamic` / `route-handler` / `middleware`, assets + `Cache-Control`, the start command, jobs and
schedules, services, env vars, permissions, images, `--compile` output). `deploy: { adapter:
fly({ app }) }` in `denext.config.ts` runs that adapter's `prepare` after every build; presets from
`denext/deploy`: `docker()`, `fly()`, `denoDeploy()` (a `denext.deploy.ts` entry: `Deno.cron` at
top level via `registerCronSchedules`, cache on Deno KV), `genericHost()` (systemd + nginx/Caddy)
and `staticHost()` (refuses, listing every route that needs a server). `denext deploy prepare
[--preset <name>] [--dry-run]` writes the files; `denext deploy` also pushes (`FLY_API_TOKEN` /
`DENO_DEPLOY_TOKEN` from the environment only). A plugin adds one with `addDeployAdapter`, and
lists the routes and files it serves in the manifest with `addDeployRoutes` / `addDeployAssets`
(`@denext/tanstack-start` lists a Start app's pages, server routes, server functions and `/_tss/`
client files). `genericHost({ drainMs })` / `fly({ drainMs })` (else `DENEXT_SHUTDOWN_DRAIN_MS`
when `prepare` runs) size the systemd unit's `TimeoutStopSec` and Fly's `kill_timeout` to the
drain plus 20 s, so a long drain isn't killed midway. Deno's
`deno deploy` is `denext deno deploy`. Docs: https://denext.dev/docs/deploy#deploy-adapters

**A scheduled / background job (cron):** put it in `jobs/<name>.ts`; schedule it in
`denext.config.ts` (`scheduledJobs`) or per-job; run it on demand with `runJob(name)`
or `denext job <name>`. Uses `Deno.cron` where available (Deno Deploy), else a userland
tick — no npm cron dependency. **Cron expressions are evaluated in UTC** (matching `Deno.cron`),
weekdays are **POSIX** (`0–6`, `0` = Sunday; denext translates them to names for `Deno.cron`),
and a schedule never fires on startup nor overlaps a still-running instance of the same task.
`jobs: { history: true }` records every run to `.denext/jobs.db` (`historyMaxRuns` per job,
14 days); the Cron page of `denext ui` shows it. `jobs: { history: { store } }` takes any
`JobHistoryStore` — `postgresJobHistoryStore({ url })` shares one history across replicas.
`defineJob({ retry: { attempts, backoff } })`
re-runs a failed task (exponential from 1 s by default; the handler's context has `attempt`).

```ts
// jobs/cleanup.ts
import { defineJob } from "denext/server";
export default defineJob({
  description: "purge expired sessions",
  schedule: "0 3 * * *", // optional; or list it in config.scheduledJobs
  handler: async ({ payload }) => {
    await db.exec("DELETE FROM sessions WHERE expires_at < now()");
  },
});
// denext.config.ts → scheduledJobs: { "0 0 * * 1": ["digest", "warm-cache"] }
// anywhere on the server: import { runJob } from "denext/server"; await runJob("cleanup");
```

**Shutdown:** on SIGTERM, `denext start` drains in-flight requests, stops `services/`, runs the
plugin teardowns, then `instrumentation.ts`'s `onShutdown()`. Close app-owned resources there,
for example `export async function onShutdown() { await sql.end(); }`. The process exits by
`DENEXT_SHUTDOWN_DRAIN_MS` even if a pool, timer or socket stays open.

**Idle memory trim:** on denext's Deno from runtime 3.0.0-rc.5 the production server (the process
`denext start` starts, the `build --compile` binary, the generated Docker image / systemd unit)
runs a full GC and `malloc_trim(0)` once its event loop has been idle for a second (glibc Linux;
at most once per idle period, 10 s apart, then only after 16 MB of growth). Never for `dev`, tests
or jobs. Opt out with `start: { idleTrim: false }` or `DENEXT_IDLE_TRIM=0`.
`start: { limits: { memory: "384m", cpuSeconds, deadlineSeconds } }` caps the same processes
(runtime 3.0.0-rc.2+; `--max-memory` / `--max-cpu-time` / `--max-time`, exit 137 / 152 / 124 for
the supervisor to restart; only on the process that serves, never a CLI re-run before it; baked
into a compiled binary, whose `job` / `db` then run under them too; never `dev` or tests; not
applied on stock Deno, with a warning): https://denext.dev/docs/deployment-targets#resource-limits

**Long-lived server work (supervised services):** `services/<name>.ts` default-exports
`defineService({ start(ctx) })` from `denext/server` — `start`'s promise is the service's life (a
throw is a crash; hold a resource with `await ctx.stopped`; `ctx.signal` aborts on stop). The
server runs them under a root supervisor that restarts a crash with exponential backoff + jitter,
gives up past `intensity` restarts within `period` (ms) — failing to its parent, or at the top to
`instrumentation.ts`'s `onServiceError` and the `/_denext/health` `services` check — and stops them
in reverse order after the drain. `supervise({ children, strategy: "one_for_one" | "one_for_all" |
"rest_for_one", intensity, period, backoff })` nests trees; `jobService(name)` /
`sidecarService(handle)` adapt a job loop or a Deno Desktop sidecar; `supervisionStatus()` and
`denext ui`'s Services page show state, restart counts and the last error. Opt-in restarts for
Live: `defineSubscription({ restart: true })` and `createChannel({ publisher })`. Restart
semantics, NOT process isolation: no preemption, a shared heap, and a blocking loop still blocks
everything. Docs: https://denext.dev/docs/services

**A content collection (typed MD/MDX/YAML/JSON — the `@denext/content-collections` plugin):** add
`plugins: [contentCollections()]` to `denext.config.ts`, declare collections in `content.config.ts`
with a Standard Schema + a loader, then query them typed from a Server Component. The plugin
validates entries and generates types — live in `denext dev`, and at `denext build`.

```ts
// content.config.ts
import { defineCollection, defineContentConfig, glob } from "@denext/content-collections/config";
import { z } from "zod";
export default defineContentConfig({
  collections: {
    blog: defineCollection({
      loader: glob({ pattern: "**/*.md", base: "content/blog" }),
      schema: z.object({ title: z.string(), date: z.string(), draft: z.boolean().default(false) }),
    }),
  },
});
```

```tsx
// app/page.tsx — server-only query, typed to the schema
import "../.denext/content.ts"; // registers the collection types (generated)
import { getCollection } from "@denext/content-collections/runtime";
export default async function Blog() {
  const posts = await getCollection("blog", (p) => !p.data.draft); // p.data is typed
  return <ul>{posts.map((p) => <li key={p.id}>{p.data.title}</li>)}</ul>;
}
// Render an entry's body: `<Content entry={post} />` (or `await renderContent(post)`) from the
// same module — `.md` through the first-party renderer (raw HTML escaped; `contentCollections({
// markdown: { html: "sanitize" } })` keeps allowlisted HTML), `.mdx` through a module compiled
// at build.
// CLI: `denext content build | list | validate` (validate exits 1 on a schema failure — a CI gate).
```

**Gleam:** `denext add gleam:<package>` compiles a Gleam package to
JavaScript in a `gleam/` project and maps `@gleam/` in `deno.json`; import it typed as
`@gleam/<package>/<module>.mjs`. `plugins: [gleam()]` (from `denext/gleam`) recompiles your own
`gleam/src/**/*.gleam` at dev and build. The compiler is denext's pinned Gleam (no Erlang needed),
downloaded and SHA-256-verified on first need beside the Deno toolchain; `denext toolchain install
--with gleam` fetches it ahead for offline work, `DENEXT_GLEAM=<path>` runs another one.
`denext create my-app --template lustre` starts an app with one Lustre counter used as an island
(`lustreIsland`), a custom element (`lustreElement`) and a server view (`defineLustreView`).

**A compile-time feature flag (dead-code-eliminated):** `feature("KEY")` from `denext/feature`
folds to a boolean literal at build time for any KEY in `features` — denext's
`feature()` (cf. Bun's `bun:bundle`). `feature()` always returns the configured value; the untaken
branch is dead-code eliminated where it folds (native App Router client modules, `.ts` / `.js`
included, SPA, dev), and read at runtime on the compat drop-in App Router path. Keep the argument a
string literal; a key not listed reads `false`. Flag names/states are embedded in the client bundle (don't encode secrets).

```tsx
import { feature } from "denext/feature";
export function Checkout() {
  return feature("NEW_CHECKOUT") ? <NewCheckout /> : <LegacyCheckout />;
}
// denext.config.ts → features: { NEW_CHECKOUT: false }
```

**Inspect / shrink the client bundle:** `denext analyze` breaks the bundle down by chunk + role;
`denext analyze --md` writes a markdown report (each chunk's top modules) to pipe into CI.
Imports of one export from a `"sideEffects": false` dep (lucide-react, Radix) are tree-shaken
automatically on the esbuild path. `optimizePackageImports` (Next's key, top-level) goes further:
barrel imports of listed packages are rewritten to the defining modules, so the barrel is never
loaded. A built-in list (lucide-react, date-fns, lodash-es, …) is on by default; add packages,
drop one with `"!pkg"`, or disable it with `false`. Listing a package asserts it is side-effect
free. A package whose own `package.json` declares `sideEffects` (`false`, or an array naming none of
the barrel's modules) is rewritten unlisted too, so a lazy route's modules stay out of the startup
chunks (`"!*"` turns that automatic mode off). Applied by the esbuild bundles only (not unbundled
dev or the native `deno bundle` path).

**Testing an app (no browser, JS-disabled path):**

```ts
import { createTestApp, createTestClient } from "denext/testing";
const client = createTestClient(await createTestApp("./"));
const res = await client.submit(
  client.form((await client.get("/login")).text),
  {
    email,
    password,
  },
);
// res.status, client.cookies — a cookie jar persists the session across requests.
```

`createTestApp` also runs the plugins' prepare and build steps (emitted files are served),
registers `jobs/` (`runJob(name)` works) and starts `services/`; `await using app = await
createTestApp(dir)` stops them (`{ services: false }`, `jobs` or `buildSteps` leaves one out).

**Testing a component (hooks/effects/events, no browser):**

```ts
import { fireEvent, render } from "denext/testing";
import { h } from "denext/jsx-runtime";
const screen = await render(h(Counter, null)); // async — await it
await screen.fireEvent.click(screen.getByRole("button"));
// getByRole/getByText/getByLabelText/getByTestId; fireEvent.change wires to onChange.
```

A test that needs a fake clock or a module mock imports `vitest` (`vi.useFakeTimers()`,
`vi.mock()`, `vi.stubEnv`) and runs under `denext test` — the toolchain's `deno test` has
Vitest's API; stock Deno can't resolve `vitest`, so name such files `*.vitest.ts` if a plain
`deno test` also runs. `denext test` runs the `*.vitest.ts` files as a second pass, and
`denext test --coverage` reports both passes as one.

**Conformance-probing every route (CI gate):**

```ts
import { formatReport, probeApp } from "denext/testing";
const report = await probeApp("./"); // renders every route, asserts valid HTML docs
if (!report.ok) throw new Error(formatReport(report)); // or run `denext doctor`
```

**Config:** `denext.config.ts` exports `{ ... }` (redirects, rewrites, headers,
i18n, images, `cacheComponents`, `streaming`, `live`, `reactCompiler`, `features`, `plugins`,
`tailwind`, `csp` (strict by default; `frameSrc` / `mediaSrc` / `workerSrc` / `fontSrc` /
`scriptSrc` / `styleSrc` / `imgSrc` / `connectSrc` opt-ins, e.g. `{ frameSrc:
["https://js.stripe.com"] }`), `compress` (gzip, on by default; `{ encodings: ["br", "gzip"] }`
adds brotli; `false`, or `export const compress = false` in a route), `cors`, `cdnCacheHeaders`
(opt-in: ISR pages answer `Cache-Control: public, s-maxage=…` for a CDN, never for a request
with a cookie or `Authorization`, a negotiated locale or a `middleware.ts` match, unless
`{ evenWithMiddleware: true }`), `compatibilityMode`,
`optimizePackageImports`, `resolveAlias` (module aliases; `{ to, except: ["pkg"] }` keeps a package's own
imports, as Metro's `resolveRequest`), `momentumSafeScroll`, `desktop`, `mobile`, `appLinks`;
`mode: "spa"` + `spa: { entry, … }` for SPA mode). Not `next.config.js`.
Every key: https://denext.dev/docs/config

SPA Vite build parity (`denext migrate` sets what vite.config had): `spa.assetsDir: "assets"`
serves and exports the client under `/assets/` as `name-HASH8.ext`; `spa.viteManifest: true`
writes `.vite/manifest.json`; `spa.tanstackRouter: { autoCodeSplitting: true }` splits routes;
a failed chunk load dispatches cancelable `vite:preloadError` (+ `denext:chunkError`); a plugin
build step's `emitFile()` (or `viteEmitterPlugin(vitePlugin)`) publishes files at the site root.

**Writing a plugin:** a `DenextPlugin` (`{ name, setup(ctx) }` from
`denext/plugin-kit`, the semver-stable toolkit) hooks six seams — `addRouteSynthesizer` (add/adjust routes),
`addRequestHandler` (claim unmatched requests), `addBuildStep` (emit assets at build and export;
its `emitFile({ fileName, source })` publishes a file at the site root like Vite's
`this.emitFile` (`{ name, source }` publishes it as `assets/[name]-[hash][extname]`), and `viteEmitterPlugin(vitePlugin)` runs a Vite `generateBundle` emitter as one),
`addPrepareStep` (codegen the app imports — runs at build AND dev startup, and re-runs on
`watch`-glob changes in dev), `addTeardown` (dispose on drain), and `addCommand` (contribute a
CLI verb); a router plugin whose pages come from its own route tree also calls
`ctx.servesRoutes?.()`, so the app needs no `app/`. In dev a prepare step's re-run gets the edited
files as `changed`, and `ctx.reportDevError?.(title, err)` shows a failure in the dev error overlay. Declare it as `plugins: [myPlugin()]`. See
the [plugin guide](https://denext.dev/docs/plugins) and
[`examples/plugin-aliases`](https://github.com/Brainwires/denext/tree/main/examples/plugin-aliases).

## What's different to keep in mind

- **Pages Router** is not built in — it's the opt-in `@denext/pages-router`
  plugin (`plugins: [pagesRouter()]` in `denext.config.ts`).
- **Cache Components / PPR** are a stable **opt-in**: `cacheComponents: true`
  (top-level) in `denext.config.ts`. Not `experimental.cacheComponents` — that
  Next.js spelling still works but dev-warns, as do Next's
  `experimental.reactCompiler` and `experimental.optimizePackageImports`.
  `reactCompiler`, `asyncContext`, `features` and `nodeResolve` are top-level
  fields; denext's own `experimental.compiler` / `asyncContext` / `features` /
  `nodeResolve` were removed in 3.0 and are a config error.
- **denext's Deno toolchain**: the verbs that run project code (`dev`, `build`, `export`,
  `start`, `test`, `check`, `job`, `analyze`, `profile`, `doctor`, `desktop run|dev|build|package`,
  `mobile dev|build`,
  project verbs) re-run themselves on denext's pinned Deno build (a `3.0.0-rc.N` release built from Deno
  2.9.8: `Deno.SQL`, Vitest/Jest compat in `deno test`), downloaded and SHA-256-verified into
  `<DENO_DIR>/denext-deno/` on first need; the `deno` on PATH is never replaced (every API, flag
  and env var it adds over Deno 2.9.8, by version: https://denext.dev/docs/runtime-reference). `DENEXT_DENO=stock`
  opts out (deprecated: denext 5.0 drops stock Deno; every stock path — `DENEXT_DENO=stock`,
  `DENEXT_DESKTOP_RUNTIME=stock`, the npm esbuild, `createTestApp()` under a stock `deno test` —
  prints one notice per process tree with the fix, `DENEXT_NO_DEPRECATION_WARNINGS=1` hides it),
  `DENEXT_DENO=<path>` uses a given binary; when the toolchain can't be had (offline on
  first use, no build for the host, a failed download) the command stops with the fix
  (`denext toolchain install`) — denext never runs another Deno on its own. Downloads of the
  toolchain and the Deno Desktop runtime give up on a stalled connection after 10 s with no response
  (`DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS`) or 20 s with no data (`DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS`;
  `0` removes either) and retry on a new connection (`DENEXT_DOWNLOAD_ATTEMPTS`, 4 in all; none
  starts after `DENEXT_DOWNLOAD_TOTAL_TIMEOUT_MS`, 120 s), and `DENEXT_CHILD_DEADLINE_MS` replaces the build's `deno info` (the
  esbuild loader's too) / `deno bundle` deadlines (120 s / 300 s; `0`: none) for a cold cache on a slow link. Every other verb that
  starts `deno` (`fmt`, `lint`, `add`, `ui`, `mcp`, `create`, …) hands it the toolchain too.
  `denext task <name>` is Deno's `deno task` on the toolchain, and every
  `deno` inside it (its own steps, and any a script it starts finds on PATH) is the toolchain too; a
  plain `deno task` still runs stock Deno. `denext toolchain install|status|path|link|unlink`;
  `denext toolchain uninstall <version>|--all` and `prune` remove cached versions (the pinned one
  only with `--force`; `--dry-run`, `--json`).
  The compiled `denext` binary needs no Deno on the machine at all: every verb that spawns Deno
  runs it on the toolchain (with no toolchain it refuses, naming `denext toolchain install`;
  `DENEXT_DENO=stock` opts in to a `deno` on PATH), and the installer runs `toolchain install` (+ `toolchain link`
  when no `deno` is on PATH; `DENEXT_NO_DENO_LINK=1` skips it). The toolchain type-checks with
  native TypeScript 7 (`DENEXT_NATIVE_CHECK=0` keeps TypeScript 6) and its `deno lsp` runs
  TypeScript 7 too (the runtime's own default; `create` / `migrate` / `upgrade` also write
  `"deno.unstable": ["tsgo-lsp"]` for older runtimes; `DENO_UNSTABLE_TSGO_LSP=0` keeps
  TypeScript 6), and in a `package.json` project without a `deno.json` it runs npm
  packages as Node.js does (hoisted `node_modules`, Node's export conditions, extensionless and
  `tsconfig` `paths` imports, git / tarball dependencies, the project's own lifecycle scripts);
  everywhere it runs a CommonJS `.js` file as CommonJS and serves `better-sqlite3` over the built-in
  SQLite: https://denext.dev/docs/toolchain. A dependency's approved lifecycle script runs jailed
  (no network, writes only under `node_modules`; on by default from runtime 3.0.0-rc.5):
  `migrate` / `create` / `add` write the `supplyChain.jailScripts.packages` exceptions known
  packages (puppeteer, sharp, Prisma's engines, electron, …) need (into the workspace root's
  deno.json, the only one Deno reads; download hosts instead of `net: true` from runtime
  3.0.0-rc.6, which denext's 3.0.0-denext.6 pin includes) and `denext doctor` flags a missing one; never turn the jail off for them:
  https://denext.dev/docs/toolchain#supply-chain-lifecycle-script-jail.
- **Every Deno verb works through `denext`**: a verb denext doesn't define runs on the toolchain
  exactly like `denext deno <verb>` (`denext compile …`, `denext run …`, `denext x …`, `denext
  bench`), and `denext main.ts` / `denext https://…/x.ts` is `deno run`. Precedence: denext's
  built-in verbs, then the project's own (`commands:` / plugins), then Deno's. A script or a Deno
  verb never imports `denext.config.ts` first (only a name that may be a project verb does); a
  project verb may not be named `run`, `x`, `eval`, `serve`, `compile`, `install`, `uninstall`,
  `upgrade` or `task` (refused), and one named after another Deno verb (`bench`, `doc`, …) runs
  in its place only once `denext commands` has listed it (`.denext/commands.json`, matching the
  current config / `deno.json` / `deno.lock`; one notice). `task` is Deno's; background work is
  `denext job`. `info <module>` is
  Deno's info; `audit` runs denext's checks and `deno audit`. For Deno's meaning of a verb denext
  keeps (`test`, `fmt`, `upgrade`, `desktop`, `deploy`, `create`, `init`, `completions`): `denext deno <verb>`.
- **Zero runtime npm**: nothing the framework ships to the runtime pulls npm
  (CI-enforced). esbuild is not an npm import either: denext vendors esbuild's JS API and runs the
  esbuild 0.25.5 binary its Deno toolchain ships (verified by SHA-256), else
  (`DENEXT_DENO=stock`, stock Deno) the official `@esbuild/<platform>` binary, integrity-checked;
  `ESBUILD_BINARY_PATH` overrides both. The build-time toolchain still uses a few opt-in npm tools —
  `sass` / `@mdx-js/mdx` / `ws` / `@tanstack/router-plugin`; the CSS + swc-AST tooling is
  the first-party `@denext/lightningcss` / `@denext/swc` wasm. Your app may still
  use `npm:`/`jsr:` libraries.
- Run checks with `deno task check` (fmt `--check` + lint + tests; type-checking
  happens transitively via `deno test`, there's no separate type-check step).
  `deno task
  check:fix` auto-fixes formatting + fixable lint, then reports the
  rest. The `denext/*` lint rules (rules-of-hooks, hooks-in-component,
  no-hooks-in-async, no-handlers-in-async, directive-placement) are **correctness** rules with **no
  auto-fix** — resolve them by hand;
  [the contributing guide](https://denext.dev/docs/contributing) says how.

When unsure, write it the Next.js App Router way and change only the imports per
the map above — that is almost always correct denext.

## Tooling for AI agents (MCP + llms.txt)

denext ships tooling so agents get it right the first time:

- **MCP server** — `denext mcp` (or, with nothing installed,
  `deno run -A jsr:@denext/denext/cli mcp`). It speaks
  MCP over stdio; configure it as an MCP server in your client. Tools:
  `denext_check_snippet` (lint a code string for Next-isms before you write it),
  `denext_explain_error` (a `deno check` / `deno lint` / build diagnostic explained in plain
  language with a fix — the same explanation `denext check` and the dev overlay print; `--raw`
  or `DENEXT_RAW_DIAGNOSTICS=1` gives Deno's original),
  `denext_import_map` (map a Next/React import to denext), `denext_generate` (scaffold —
  takes `force` and `dryRun`),
  `denext_doctor`, `denext_codemod`, `denext_list_routes` (an app's pages + API routes),
  `denext_dev_logs` (the RUNNING dev server's recent events — server errors, server +
  browser console, completed requests, and HMR — so you can see what actually happened at
  runtime), `denext_render` (render a route or component server-side, no browser, and get
  the HTML/error — SEE what your edit produces), `denext_route_map` (the full render
  tree at a path: layouts, boundaries, server/client split), `denext_component_tree` /
  `denext_why_render` / `denext_hook_state` (the LIVE component tree from a running dev
  page — props, named hooks, why a component re-rendered; these need `denext task dev`
  AND the app open in a browser, and each answer states how stale its snapshot is. Each call
  asks the open pages for a fresh tree over the dev server's reload stream and waits for it, so
  the first call has one too. String values arrive redacted as `string(n)`),
  `denext_migrations` / `denext_gen_types` (the project's migrations — list, up, down — and its
  database types, run as CLI children), `denext_ui_overview` + one `denext_ui_<panel>` per
  `denext ui` panel (config, plugins, generate, docker, dev, tasks, database, commands, …: its
  JSON twin, through a `denext ui` child's own loopback / token / CSRF chain; a change goes out
  only as a preview, `fields.op: "preview"`, or with `apply: true`; `denext mcp --ui-read-only`
  refuses every change), `denext_profile` (build
  unminified, serve, and profile a route in headless Chromium — CPU self-time by
  function + heap growth + a leak check; pass `interact` to profile a re-render, `budget`
  to gate a regression), `denext_search_docs` (BM25
  over ALL of the denext docs, offline — every docs-site page by section plus the API reference;
  `kind: "guide" | "api"` narrows it) and `denext_read_docs` (a whole page, one `slug#anchor`
  section, or `api:<module>/<name>` as Markdown — use it instead of fetching denext.dev), and the codebase tools `denext_index_codebase` /
  `denext_query_codebase` / `denext_find_definition` / `denext_find_references`.
  `denext mcp --disable rag,docs` hides tool groups or individual tools to trim an
  agent's context. Resources: `denext://guide`, `denext://import-map`, `denext://docs`
  (`denext://docs/<slug>`). Install it in a project with `denext create --mcp` (pre-checked in the
  picker) or `denext mcp init`: a `deno task mcp` that runs the denext the project pins, registered
  in `.mcp.json` (Claude Code), `.vscode/mcp.json` and `.cursor/mcp.json` (`--clients all` adds
  `.gemini/settings.json` and `.codex/config.toml`).
- **`llms.txt`** — [denext.dev/llms.txt](https://denext.dev/llms.txt) (concise) and
  [llms-full.txt](https://denext.dev/llms-full.txt) (this guide + an API summary).
- **Docs pages worth pointing an agent at:** the generated [CLI reference](https://denext.dev/docs/cli), [Troubleshooting](https://denext.dev/docs/troubleshooting) (symptom → cause → fix), the [changelog](https://denext.dev/docs/changelog) (every change per version), the [Project UI](https://denext.dev/docs/ui) and the [examples index](https://denext.dev/docs/examples).

---

## Releasing: `main` always equals the published release

All work lands on `development`, and releases are cut there with
`deno task release <version>` (which tags `v<version>` and pushes). The script
first refuses unless ci.yml's heavy jobs (`integration`, `next-compat`, `coverage`,
with `check`, `backend-integration`, `ios-export-router`, `windows-resolve`, `windows-tests`, `macos-tests`, `cargo-audit` and `bundle-budget`, and no other job failed) are green on HEAD: a push to `development`
skips them, so dispatch ci.yml on the commit first
(`gh workflow run ci.yml --ref development`, then wait for it). Only a finished push or dispatch run
of exactly HEAD counts (never a `pull_request` run, which tests a merge ref). It also refuses unless the newest
desktop-ci.yml run on HEAD (Windows / macOS / Linux desktop suites, installers, install.ps1 /
install.sh) finished with every job green (`DESKTOP_CI_JOBS` in `scripts/release-ci.ts` names the
ones that must exist): a push runs desktop-ci only when its `paths` filter matches, so dispatch it
too (`gh workflow run desktop-ci.yml --ref development`). It refuses as well unless the newest
e2e.yml run on HEAD ran every job green (`E2E_JOBS`: `e2e`, `migration-beds`, `timer-stress`,
`no-deno`; a one-job `-f job=…` dispatch doesn't count) and the newest desktop-window.yml run on HEAD
(a real packaged window on Linux, macOS arm64 / x64 and Windows; `DESKTOP_WINDOW_JOBS`) is green:
e2e runs only on a dispatch and desktop-window only when its `paths` filter matches, so dispatch
both (`gh workflow run e2e.yml --ref development`, `gh workflow run desktop-window.yml --ref
development`). Last, the newest native-plugins.yml run on HEAD must have built both apps green
(`NATIVE_PLUGINS_JOBS`: `android`, `ios`; a push runs it only when a native template or installer
changes, so dispatch it: `gh workflow run native-plugins.yml --ref development`). Wait for all
five. Active `development` runs ahead of `main` by design. A release that stopped resumes with the
same command (or `--resume-from <step>`), but only with the gate-pass marker the release records
when the CI gate and its local gate pass, for exactly the tree it publishes (`--regate` re-runs
both); never make the `release:` commit by hand.

**`main` must always be exactly what is published.** So **cutting a version is not
done until `development` is merged into `main`** — the release flow is: tag
`v<version>` → verify the JSR publish succeeded → open a `development → main` PR
(`gh pr create --base main --head development`, same flow as PRs #5–#11) → **merge
it** (`gh pr merge <n> --merge`). "Cut a version" _implies_ this merge; do it as part
of the release, not as a separate maintainer step. A tag without `main` merged to it
is an incomplete release. The PR may batch several rc tags since the previous merge;
that's fine.

---

## Before committing: measured coverage first

Run `deno task coverage:fallow` before `git commit` whenever `coverage/coverage-final.json`
is missing (it is git-ignored, so a fresh clone or a disk sweep removes it) or when your change
touches a function with cyclomatic complexity ≥ 10. The fallow gate below scores CRAP with that
measured map; without it fallow estimates coverage from the import graph and can block a commit
on internals that tests reach only transitively (the fiber reconciler, the request pipeline).
The task runs the unit suite (~10 min) and needs no other setup. See
[CONTRIBUTING.md](./CONTRIBUTING.md) → _The Fallow gate_.

<!-- fallow:setup-hooks:start -->

## Fallow local gate

Before any `git commit` or `git push`, run `fallow audit --format json --quiet --explain --gate-marker agent` (add `--coverage coverage/coverage-final.json` when that file exists — `deno task coverage:fallow` generates it, and it turns fallow's estimated CRAP coverage into measured coverage; see CONTRIBUTING.md). If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking.

Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict. Inherited findings on touched files are reported under `attribution` and annotated with `introduced: false`, but do not block the commit. Set `[audit] gate = "all"` in `fallow.toml` to gate every finding in changed files.

For non-skill agents, treat the task map below as the local onboarding source: run the listed fallow command before destructive edits, before commits, and before pull request handoff.

## Fallow task map

| When the agent is about to...                                     | Run                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| delete an "unused" export or file                                 | `fallow dead-code --trace <file>:<export>`                                           |
| prove a TypeScript symbol's exact consumers before refactoring    | `fallow dead-code --type-aware --symbol-impact <file>:<export-or-class.method>`      |
| delete an "unused" dependency                                     | `fallow dead-code --trace-dependency <name>`                                         |
| commit or open a PR                                               | `fallow audit --base <ref>`                                                          |
| prioritize refactoring                                            | `fallow health --hotspots --targets`                                                 |
| ask who owns code                                                 | `fallow health --ownership`                                                          |
| check untested-but-reachable code                                 | `fallow health --coverage-gaps`                                                      |
| consolidate duplication                                           | `fallow dupes --trace dup:<fingerprint>`                                             |
| find feature flags                                                | `fallow flags`                                                                       |
| check which architecture rules apply to a file before changing it | `fallow guard <files>`                                                               |
| surface security candidates                                       | `fallow security`                                                                    |
| understand a finding                                              | `fallow explain <issue-type>`                                                        |
| scope a monorepo                                                  | `--workspace <glob> / --changed-workspaces <ref>` (global flags, prefix any command) |

<!-- fallow:setup-hooks:end -->
