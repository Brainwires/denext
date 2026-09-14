# examples/openapi

`@denext/openapi` in one app: a tiny pet store defined with `defineApi` + **Zod**, which the
plugin turns — with no extra annotation — into an **OpenAPI 3.1** document at `/openapi.json`, an
interactive **Swagger UI** at `/docs`, and an `openapi.json` file written by `deno task build`.

```sh
deno task dev          # http://localhost:3000 — Swagger UI at /docs, spec at /openapi.json
```

```sh
# the document
curl -s localhost:3000/openapi.json | jq .info

# reads are public
curl -s localhost:3000/api/pets

# writes need a bearer token — log in first (username "demo", password "denext")
TOKEN=$(curl -s localhost:3000/api/login -X POST \
  -H 'content-type: application/json' -d '{"username":"demo","password":"denext"}' | jq -r .token)
curl -s localhost:3000/api/pets -X POST -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Nimbus","species":"bird"}'

# a schema mismatch is a structured 400 (once past auth)
curl -s localhost:3000/api/pets -X POST -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":""}'
```

## Types for a consumer outside this app

```sh
deno task openapi:types    # writes lib/api-types.gen.ts (committed; regenerate after changing an API)
```

`lib/api-types.gen.ts` is what a **separate** frontend or script uses: openapi-typescript-style
`paths`/`components`, plus denext's `ApiSchema`, which makes the client from JSR fully typed there:

```ts
import { createApiClient } from "jsr:@denext/denext";
import type { ApiSchema } from "./api-types.gen.ts";
const api = createApiClient<ApiSchema>({ base: "http://localhost:3000" });
const pets = await api("/api/pets", "GET", { query: { species: "cat" } }); // typed
```

## Login & the Authorize button

The config declares a bearer scheme (`securitySchemes`), so **Swagger UI shows an "Authorize"
button**. Which operations need it is decided by **which builder each handler uses** — there is no
`security` written on any definition:

- `defineApi(...)` → **public** (no lock): the reads `GET /api/pets`, `GET /api/pets/{id}`, and
  `POST /api/login`.
- `authed.define(...)` → **protected** (locked): the writes `POST`/`PATCH`/`DELETE`.

`authed` is `createApi().use(requireBearer(authConfig, { scope: "pets:write" }))` — denext's
**first-party** bearer middleware from `denext/server`, which already carries
`documentsSecurity(…, [{ bearerAuth: [] }])`. So applying it does two things at once: it
**enforces** the token (401 without one, 403 without the scope) and **documents** the requirement
(the lock). One declaration, no repetition, and the doc can't drift from what's enforced.

The tokens themselves are first-party too (`lib/auth.ts`):

```ts
const { token } = await issueApiToken(authConfig, {
  userId,
  name: "swagger-ui",
  scopes: ["pets:write"],
  expiresInSeconds: 3600,
});
```

`issueApiToken` returns `tok_` + 256 bits of entropy **once** and stores only its SHA-256 in the
configured `AuthAdapter` (here `inMemoryAuthAdapter()`; use `sqliteAuthAdapter({ path })` to keep
tokens across restarts). Verification is a hash lookup, and unknown / expired / revoked tokens all
get the same 401. Inside a protected handler the token's identity is on the context:
`ctx.token` (id, name, scopes, expiry), `ctx.user` (the adapter user) and `ctx.session` — the same
shape `requireSession()` provides, so a handler works under either credential.

To use it in `/docs`: expand **`POST /api/login`** → Try it out → send
`{"username":"demo","password":"denext"}`, copy the `token`, click **Authorize** (top right),
paste it, and every locked operation now sends `Authorization: Bearer <token>`.

Because `denext.config.ts` also registers `denextAuth(authConfig)`, the management endpoints are
mounted as well: a **cookie-signed-in** user can `POST /auth/tokens` to mint one, `GET /auth/tokens`
to list them (redacted) and `DELETE /auth/tokens/:id` to revoke one. Those three never accept a
bearer token as the credential — a leaked token can't mint or revoke another.

This is a demo store — the account is hardcoded and the adapter is in-memory, not for production.

## The docs renderer

`denext.config.ts` sets `ui: "swagger"`. Three renderers are available — swap the one line:

- `"swagger"` — Swagger UI, loaded from unpkg (interactive "try it").
- `"scalar"` — Scalar API Reference, loaded from jsDelivr (interactive).
- `"builtin"` — a server-rendered, zero-JavaScript reference page (the default; strict-CSP
  clean, no CDN). `examples/typed-api` shows this one.

denext ships **no CSP by default**, so the CDN-loaded UIs work as-is. Under `csp: "strict"` allow
the CDN host (and prefer `builtin`, whose page needs no CDN and no inline styles).

## Why Zod

Zod ≥ 4.2 implements [Standard JSON Schema](https://standardschema.dev/json-schema), so every
parameter, request body, and response is described **in full** in the document. Any Standard
Schema that does the same (ArkType, Valibot via `@valibot/to-json-schema`) or TypeBox works too;
a schema without a JSON-Schema export shows up as `{}` plus a build-time lint warning. Zod is the
only npm dependency here — denext's own runtime stays zero-npm.

## Security

The document describes your API. When that should not be public, set `expose: "dev"` (served only
under `denext dev`) or an `authorize` gate. See `../../packages/openapi`.
