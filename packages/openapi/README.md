# @denext/openapi

An **OpenAPI 3.1 document and a docs page** for a [denext](https://denext.dev) app,
derived from the [`defineApi`](https://denext.dev/docs/typed-api) definitions its route
handlers already carry. Nothing to annotate twice: the schema that validates a request
is the schema that documents it.

```ts
// denext.config.ts
import { openapi } from "@denext/openapi";

export default {
  plugins: [openapi({ info: { title: "Todos", version: "1.0.0" } })],
};
```

That is the whole setup. The app now serves:

| URL             | What                                                           |
| --------------- | -------------------------------------------------------------- |
| `/openapi.json` | The OpenAPI 3.1 document (ETag'd, `no-cache`)                  |
| `/docs`         | A reference page — server-rendered, zero JavaScript by default |

and `denext build` writes `openapi.json` into the output directory.

## Install

```sh
denext plugin add @denext/openapi
```

Or by hand: add `"@denext/openapi": "jsr:@denext/openapi@^0.7.0"` to `deno.json`'s
`imports` and the plugin to `denext.config.ts` as above.

## What gets described

For every `route.ts` the router knows, each exported method handler becomes an operation.
A `defineApi` handler contributes everything it declares:

```ts
export const POST = defineApi({
  summary: "Create a todo",
  body: z.object({ title: z.string().min(1) }), // → requestBody (application/json)
  response: todo, // → 200 response schema
  errors: { duplicate: 409 }, // → 409 response, code enum ["duplicate"]
}, handler);
```

- `params` → path parameters (typed from the schema's properties; `[...rest]` is one
  `/`-joined parameter), `query` → one query parameter per property.
- A declared `params`, `query` or `body` schema adds the `400` validation response (a
  `body` also adds `bad_request` for a malformed one).
- The endpoint's middleware adds the responses it answers with: `requireSession()`'s 401 (and
  403 with a `role`), `requireBearer()`'s 401 with its `www-authenticate` header (and 403 with a
  `scope` or `role`), `rateLimit()`'s 429 with `retry-after`, `csrf()`'s 403 — and your own,
  tagged with `documentsErrors(mw, { quota_exceeded: 402 })` from `denext/server` (an error spec
  may list the `headers` it carries: `{ status, message?, headers? }`). A `default` response
  covers what only the framework answers (a 413 over the body cap, a redacted 500).
  Every error response uses the
  shared `ApiError` envelope schema (`components.schemas.ApiError`) with the status's
  codes as an enum, so a generated client can narrow on `error.code`.
- A plain handler (no `defineApi`) is still listed by path and method, with a lint
  warning.

### Routes from plugins

A plugin that serves routes of its own registers an `OpenApiSource` (`registerOpenApiSource`, or
the `Symbol.for("denext.openapi.sources")` map, so it needs no dependency on this package), and
the document lists its operations beside the route handlers. `@denext/backend`'s auto-REST does:
every relation and function of the default schema the `anon` and `authenticated` roles can use,
under `/rest/v1`, rows typed as `rest.<table>` schemas (`rest: { openapi: false }` opts out).
`openapi({ sources: [...] })` adds sources; `sources: false` leaves every registered one out. A
path an app route already describes keeps the app's operation (`path-collision`); a source that
throws is skipped with a `source-failed` warning.

### JSON Schema from your validator

Standard Schema has no JSON-Schema export of its own; its companion
[Standard JSON Schema](https://standardschema.dev/json-schema) does, and denext tries it
first: `schema["~standard"].jsonSchema.input()` for params / query / body and `.output()`
for the response. Implemented by **Zod ≥ 4.2**, **ArkType ≥ 2.1.28**, **Valibot** (via
`toStandardJsonSchema` from `@valibot/to-json-schema`), and others. Then:

- **TypeBox** schemas are JSON Schema already — used as-is.
- A `toJsonSchema()` method on the schema (older ArkType).
- Your own converter: `openapi({ toJsonSchema: (schema, side) => … })` — consulted first.

Anything else is emitted as `{}` (accepts anything) with an `opaque-schema` warning, so
the document is always valid and `denext openapi lint` tells you exactly what to fix.

## The docs page

`ui: "builtin"` (default) is a server-rendered reference: operations grouped by tag,
parameters, request body, responses and schemas as a compact tree. It ships **no
JavaScript** and its stylesheet is served from your origin, so it works under a strict
`script-src 'self'; style-src 'self'` CSP without changes.

For an interactive "try it" console:

```ts
import { DOCS_CDN, openapi } from "@denext/openapi";

openapi({ ui: "swagger" }); // Swagger UI, vendored, served from your origin
openapi({ ui: "scalar" }); // Scalar API Reference, vendored, served from your origin
openapi({ ui: "scalar", cdn: DOCS_CDN.scalar }); // opt back into a CDN
```

`swagger` serves Swagger UI (swagger-ui-dist 5.32.15, Apache-2.0 — `vendor/swagger-ui/`, with
its license and notice) from `<docs>/swagger-ui/`: no CDN, no inline script, and each file is
checked against the SHA-256 recorded in `swagger-ui.ts` before it is served. Every docs page
answers with its own strict `content-security-policy` (`'self'` only for `builtin` and
`swagger`).

`scalar` serves Scalar's API reference (@scalar/api-reference 1.72.4, MIT — `vendor/scalar/`,
with its license and a notice) the same way: the standalone bundle is checked against the SHA-256
recorded in `scalar-ui.ts` and served from `<docs>/scalar/standalone.<hash>.js` with
`cache-control: public, max-age=31536000, immutable` (a re-vendor changes the URL). Its page's
CSP names no other origin: `script-src 'self'` plus the SHA-256 hash of the page's one inline
start-up script, which turns off every call Scalar makes to its own services (web fonts,
telemetry, the agent chat, the hosted request proxy) so "try it" calls your API directly;
`connect-src` adds only the document's absolute `servers`. Scalar styles its components inline,
so `style-src` allows inline styles. The bundle adds about 4.4 MB to the package (1.3 MB
gzipped). Re-vendor with `deno run -A scripts/vendor-scalar.ts <version>` from the denext
repository.

## Authorization (the "Authorize" button)

Declare your schemes once with `securitySchemes`, then say which scheme each operation
needs. Swagger UI (and Scalar) render an **Authorize** button from the schemes, so a token
is entered once and sent with every request.

```ts
// denext.config.ts
openapi({
  securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
});
```

**Let the middleware document it (recommended)** — every endpoint that applies a documenting
middleware is marked secured automatically. One declaration both **enforces** (the middleware) and
**documents** (the tag); nothing is repeated and the two can't drift.

denext's own bearer middleware, `requireBearer(authConfig)`, is already tagged with
`[{ bearerAuth: [] }]`, so applying it is all it takes:

```ts
import { createApi, requireBearer } from "@denext/denext/server";
import { authConfig } from "./auth.ts"; // the config you pass to denextAuth()

const authed = createApi().use(requireBearer(authConfig, { scope: "pets:write" }));

export const GET = defineApi({ summary: "List" }, list); //  no middleware → public
export const POST = authed.define({ summary: "Create" }, create); // enforced AND marked secured
```

It verifies `Authorization: Bearer tok_…` against the tokens `issueApiToken` minted (hashed, in
your `AuthAdapter`), answers an identical 401 for absent/unknown/expired/revoked tokens and a 403
when the `scope`/`role` is missing, and hands the handler `ctx.token` / `ctx.user` / `ctx.session`.

For your own middleware — a different scheme, an API key, an mTLS header — tag it yourself with
`documentsSecurity`:

```ts
import { createApi, documentsSecurity } from "@denext/denext/server";

const keyed = createApi().use(documentsSecurity(requireApiKey(), [{ apiKey: [] }]));
```

A chain is the cartesian product of its middlewares' requirements (`(A | B)` then `C` documents
as `[{A,C}, {B,C}]`); an endpoint with no documenting middleware carries no requirement.

**Or put `security` on the definition** — when you want the lock without middleware, or to
override what the middleware documents (an explicit `security: []` forces "public"):

```ts
export const GET = defineApi({ summary: "List", security: [] }, list); // explicitly public
export const POST = authed.define({ summary: "Create", security: [{ bearerAuth: [] }] }, create);
```

**Or a document-wide default** — pass `security` to the plugin as an array (applies to
every operation) or a `(route) => …` function (per route):

```ts
openapi({
  securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
  security: (route) => route.routePath === "/api/login" ? [] : [{ bearerAuth: [] }],
});
```

`security` is **documentation only** — it draws the lock and tells Swagger which header to
send; `documentsSecurity` is likewise a doc tag. Neither enforces anything: the middleware you
apply is what actually rejects requests. Precedence: per-endpoint `security` →
middleware-documented (`documentsSecurity`) → document-level `security` → none.

## CI

```sh
denext openapi emit --out openapi.json   # regenerate the committed spec
denext openapi diff openapi.json         # exit 1 when an operation or schema changed
denext openapi lint --strict             # exit 1 when anything is undescribed
denext openapi types --out api-types.ts  # TypeScript types for a consumer outside the app
denext openapi client --lang python --out client.py   # a typed client in another language
```

## Clients in other languages

`denext openapi client --lang python|go|swift|kotlin [--out <file>] [--package <name>]` writes one
file with no dependency beyond the language's standard library — Python 3.11+ (`urllib` +
`json`; `TypedDict` / `Literal` types), Go (`net/http` + `encoding/json`; structs with `json`
tags, methods taking a `context.Context`), Swift (`URLSession` async/await; `Codable` types) and
Kotlin (`java.net.http`, JVM 11+; data classes with `toJson` / `fromJson` and a small JSON
reader/writer in the file). One method per operation; a non-2xx answer raises the language's
error type with the status and the envelope's `code`, `message` and `data`. From a script:
`emitClient(document, lang)` from `@denext/openapi/clients` (`modelFromOpenApi` gives the
language-neutral model the emitters share). Values the wire codec tags (a `Date`, a `Map`)
arrive in their tagged JSON form.

## Consume the API from another project

Inside the app, `createApiClient()` is already typed — `denext build`/`dev` write `.denext/api.ts`
straight from the route modules. That file re-reads the app's own sources, so it cannot leave
the repo. `denext openapi types` emits what can: one `.ts` with no imports, derived from the
document, holding two views of the same API:

- `paths` / `components` — the openapi-typescript shape, for openapi-fetch and friends;
- `ApiSchema` — denext's shape, keyed by route pattern and method. Hand it to the client from
  `jsr:@denext/denext` and a separate frontend gets the same typed calls the app has, wire codec
  and typed error codes included:

```ts
// a different repo — a Deno/TS frontend, a script, a worker
import { createApiClient, isApiClientError } from "jsr:@denext/denext";
import type { ApiSchema } from "./api-types.ts"; // `denext openapi types --out api-types.ts`

const api = createApiClient<ApiSchema>({ base: "https://api.example.com" });
const pet = await api("/api/pets/[id]", "GET", { params: { id: "1" } }); // typed response
try {
  await api("/api/pets", "POST", { body: { name: "", species: "cat" } });
} catch (err) {
  if (isApiClientError(err) && err.code === "duplicate") { /* narrowed to the declared codes */ }
}
```

Types only — no fetch wrapper is generated, deliberately: a plain `fetch` consumer sees plain
JSON except for values holding a Date, Map, Set, BigInt, URL, `undefined`, NaN, ±Infinity or -0, which
arrive `$`-tagged with an `x-denext-wire: 1` header; `createApiClient` decodes those (and
dedupes and batches), so it IS the client. An opaque schema (`{}`, see Lint codes) becomes
`unknown`; a recursive `$defs` reference is cut to `unknown` at the cycle. The document stamps
two extensions the emitter reads — `x-denext-path` (the route pattern) and `x-denext-errors`
(`{ code: status }`) — so a document from another producer still emits, keyed by `{id}` → `[id]`.

`@denext/openapi/spec` exports `buildOpenApi`, `diffSpecs` and `toJsonSchema` for scripts
that need no server:

```ts
import { buildOpenApi } from "@denext/openapi/spec";
import { scanRoutes } from "@denext/denext/server";

const { document, warnings } = await buildOpenApi({
  manifest: await scanRoutes("./app"),
  load: (file) => import(file),
  info: { title: "Todos", version: "1.0.0" },
});
```

## Options

| Option            | Default           | What                                                                      |
| ----------------- | ----------------- | ------------------------------------------------------------------------- |
| `path`            | `/openapi.json`   | Where the document is served (app-relative; `basePath` is stripped first) |
| `docs`            | `/docs`           | Where the docs page is served; `false` disables it                        |
| `expose`          | `"always"`        | `"always"` serves in every mode; `"dev"` serves only under `denext dev`   |
| `ui`              | `"builtin"`       | `builtin` \| `scalar` \| `swagger`                                        |
| `cdn`             | none (vendored)   | Scalar script URL / a Swagger dist base URL instead of the vendored copy  |
| `info`            | dir name, `0.0.0` | `title`, `version`, `description`                                         |
| `servers`         | —                 | `servers` entries                                                         |
| `securitySchemes` | —                 | `Record<string, OpenApiSecurityScheme>` → `components.securitySchemes`    |
| `security`        | —                 | `SecurityRequirement[]` (doc default) or `(route) => …` (per route)       |
| `toJsonSchema`    | —                 | `(schema, "input" \| "output") => JsonSchema \| undefined`                |
| `include`         | every API route   | `(route) => boolean`                                                      |
| `tags`            | segment after api | `(route) => string[]`                                                     |
| `authorize`       | open              | `(request) => boolean \| Promise<boolean>`; `false` → the app's own 404   |
| `outFile`         | `openapi.json`    | The build-output file; `false` skips the build step                       |
| `sources`         | registered ones   | More `OpenApiSource`s; `false` leaves out the registered ones too         |

## Endpoint details

- `GET`/`HEAD /openapi.json`: the document, pretty-printed, with an `ETag` (304 on
  `If-None-Match`), `cache-control: no-cache`, and an `x-denext-openapi-warnings: N` header
  (the lint count).
- `GET /docs` (builtin renderer): the page plus its stylesheet at `<docs>.css`, served
  same-origin (`max-age=3600`).
- Operations carry `x-denext-path` (the denext route pattern), `x-denext-errors` (`{ code:
  status }` for every code a call may fail with, builtins included) and, when the definition
  sets `maxBodyBytes`, `x-denext-max-body-bytes`.
- Lint codes: `opaque-schema`, `undescribed-route`, `missing-summary`, `catch-all-path`,
  `load-failed`, `path-collision`, `source-failed`.
- Subpaths: `@denext/openapi/spec` (`buildOpenApi`, `diffSpecs`, `toJsonSchema`,
  `pathVariants`, `API_ERROR_SCHEMA`), `@denext/openapi/command` (`createOpenapiCommand`,
  `formatWarning`), `@denext/openapi/types` (`emitTypes`); the root also exports
  `renderDocsHtml`, `renderSchema`, `docsCsp`, `DOCS_CSS`, `DOCS_CDN`, `SWAGGER_UI_ASSETS`,
  `SWAGGER_UI_VERSION`, `readSwaggerAsset`, `SCALAR_VERSION`, `SCALAR_ASSET`,
  `SCALAR_BUNDLE_NAME`, `SCALAR_BOOT`, `SCALAR_BOOT_HASH`, `readScalarBundle`.

## Security notes

- The document describes your API's shape. It is served in every mode by default; set
  `expose: "dev"` to serve it only under `denext dev`, or gate it with `authorize` when it
  is not public information — a refused request falls through to the app's ordinary 404, so
  there is no "forbidden" oracle.
- The builtin renderer escapes everything it prints and contains no script.
- The plugin reads `apiDefinitionOf` metadata only; it never executes a handler. It does
  LOAD every route module (`import`), so module top-level code runs — a route that opens a
  database connection at module scope opens it in `denext openapi emit` too.

## License

MIT
