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

## Login & the Authorize button

The config declares a bearer scheme (`securitySchemes`), so **Swagger UI shows an "Authorize"
button**. Security is decided **per endpoint** with a `security` field on each definition, so
operations on the same path differ: `GET /api/pets` and `GET /api/pets/{id}` are public
(`security: []`), while `POST`/`PATCH`/`DELETE` require the token (`security: [{ bearerAuth: [] }]`).

To use it in `/docs`: expand **`POST /api/login`** → Try it out → send
`{"username":"demo","password":"denext"}`, copy the `token`, click **Authorize** (top right),
paste it, and every locked operation now sends `Authorization: Bearer <token>`.

`security` only **documents** the requirement (the lock); it is **enforced** separately by the
`requireBearer()` middleware in `lib/auth.ts` (`authed.define(...)` runs it before the handler).
This is a demo store — the credentials and tokens are in-memory, not for production.

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
