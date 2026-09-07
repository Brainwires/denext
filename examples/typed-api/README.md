# Typed API, end to end — no tRPC

Everything the typed-API surface ships, in one small app:

- **`defineApi`** ([`app/api/todos/route.ts`](./app/api/todos/route.ts)) — route
  handlers whose `query` / `body` / `params` / `response` are Standard Schemas
  (a ~100-line hand-rolled one in [`lib/schema.ts`](./lib/schema.ts) that also implements Standard JSON Schema;
  Zod/Valibot/ArkType/TypeBox drop in). A mismatch is a structured 400 before
  the handler runs; `fail("duplicate")` is a typed 409; a declared `response`
  schema strips undeclared keys — in production too.
- **`createApiClient()` / `useApiLive`** ([`app/todos.tsx`](./app/todos.tsx)) —
  typed against the generated `.denext/api.ts` (path, method, params, query,
  body, response, **error codes**), no `deno doc`, no hand-written client.
  Concurrent GETs in one tick ride ONE `POST /_denext/api-batch`; equal
  in-flight GETs share one request; a Date / Map / BigInt survives the wire.
  `useApiLive({ tags })` refetches when the server revalidates the tag.
- **`defineSubscription` / `useSubscription`**
  ([`app/subscriptions.ts`](./app/subscriptions.ts),
  [`app/live-todos.tsx`](./app/live-todos.tsx)) — a live query whose input the
  SERVER validates, whose tags are server-derived, and whose failures arrive as
  structured errors. Registering it is the live opt-in.
- **`createChannel` / `useChannel`** ([`app/channels.ts`](./app/channels.ts)) —
  server push: `publish("all", event)` from the route handler or the action
  reaches every subscribed tab. `authorize` is required by construction;
  payloads are validated at the publisher.
- **`defineAction`** ([`app/actions.ts`](./app/actions.ts)) — the no-JS `<form>`
  path, same store, same invalidation, same channel publish.

## Run it

```sh
deno task dev     # or: deno task build && deno task start
```

Open two tabs. Add or toggle a todo in one: the list refetches (tag watch), the
counts re-push (validated subscription) and the event toast updates (channel) in
the other — one WebSocket, no polling. Try `curl`:

```sh
curl -s localhost:3000/api/todos | jq
curl -s -X POST localhost:3000/api/todos -H 'content-type: application/json' -d '{"title":5}' | jq
#   → 400 { "error": { "code": "validation", "fieldErrors": { "title": "must be a non-empty string" } } }
```

## Where the types come from

`denext dev` / `denext build` write `.denext/api.ts`, which imports each route
module's TYPE and registers the schema
(`declare module "denext" { interface RegisteredApi { … } }`). A type-only
`import type {} from "./.denext/api.ts"` anywhere in the app is enough for
`createApiClient()` and `useApi` to be typed against your routes.

## OpenAPI + docs

`denext.config.ts` wires [`@denext/openapi`](../../packages/openapi): the same `defineApi`
definitions serve `GET /openapi.json` (an OpenAPI 3.1 document — every schema fully described,
because `lib/schema.ts` implements Standard JSON Schema) and a server-rendered reference at
`GET /docs`; `deno task build` writes `.denext/openapi.json`.
