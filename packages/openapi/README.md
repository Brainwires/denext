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

Or by hand: add `"@denext/openapi": "jsr:@denext/openapi@^0.1.0"` to `deno.json`'s
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
  `body` also adds `bad_request` for a malformed one); every operation gets a `default`
  response for what the definition cannot name (middleware 401/429, 413, a redacted 500).
  Every error response uses the
  shared `ApiError` envelope schema (`components.schemas.ApiError`) with the status's
  codes as an enum, so a generated client can narrow on `error.code`.
- A plain handler (no `defineApi`) is still listed by path and method, with a lint
  warning.

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
openapi({ ui: "scalar" }); // Scalar API Reference, from cdn.jsdelivr.net
openapi({ ui: "swagger" }); // Swagger UI, from unpkg.com
openapi({ ui: "scalar", cdn: "/vendor/scalar.js" }); // self-hosted
```

Those load from a CDN by default — allow that host in your `csp`, or self-host the
bundle and point `cdn` at it.

## CI

```sh
denext openapi emit --out openapi.json   # regenerate the committed spec
denext openapi diff openapi.json         # exit 1 when an operation or schema changed
denext openapi lint --strict             # exit 1 when anything is undescribed
```

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

| Option         | Default           | What                                                                      |
| -------------- | ----------------- | ------------------------------------------------------------------------- |
| `path`         | `/openapi.json`   | Where the document is served (app-relative; `basePath` is stripped first) |
| `docs`         | `/docs`           | Where the docs page is served; `false` disables it                        |
| `expose`       | `"always"`        | `"always"` serves in every mode; `"dev"` serves only under `denext dev`   |
| `ui`           | `"builtin"`       | `builtin` \| `scalar` \| `swagger`                                        |
| `cdn`          | per renderer      | Scalar script URL / Swagger dist base URL                                 |
| `info`         | dir name, `0.0.0` | `title`, `version`, `description`                                         |
| `servers`      | —                 | `servers` entries                                                         |
| `toJsonSchema` | —                 | `(schema, "input" \| "output") => JsonSchema \| undefined`                |
| `include`      | every API route   | `(route) => boolean`                                                      |
| `tags`         | segment after api | `(route) => string[]`                                                     |
| `authorize`    | open              | `(request) => boolean \| Promise<boolean>`; `false` → the app's own 404   |
| `outFile`      | `openapi.json`    | The build-output file; `false` skips the build step                       |

## Endpoint details

- `GET`/`HEAD /openapi.json`: the document, pretty-printed, with an `ETag` (304 on
  `If-None-Match`), `cache-control: no-cache`, and an `x-denext-openapi-warnings: N` header
  (the lint count).
- `GET /docs` (builtin renderer): the page plus its stylesheet at `<docs>.css`, served
  same-origin (`max-age=3600`).
- Operations carry `x-denext-max-body-bytes` when the definition sets `maxBodyBytes`.
- Lint codes: `opaque-schema`, `undescribed-route`, `missing-summary`, `catch-all-path`,
  `load-failed`, `path-collision`.
- Subpaths: `@denext/openapi/spec` (`buildOpenApi`, `diffSpecs`, `toJsonSchema`,
  `pathVariants`, `API_ERROR_SCHEMA`), `@denext/openapi/command` (`createOpenapiCommand`,
  `formatWarning`); the root also exports `renderDocsHtml`, `renderSchema`, `DOCS_CSS`,
  `DOCS_CDN`.

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
