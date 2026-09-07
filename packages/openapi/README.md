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
- Any declared schema adds the `400` validation response. Every error response uses the
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
| `path`         | `/openapi.json`   | Where the document is served (prefixed with `basePath`)                   |
| `docs`         | `/docs`           | Where the docs page is served; `false` disables it                        |
| `ui`           | `"builtin"`       | `builtin` \| `scalar` \| `swagger`                                        |
| `cdn`          | per renderer      | Scalar script URL / Swagger dist base URL                                 |
| `info`         | dir name, `0.0.0` | `title`, `version`, `description`                                         |
| `servers`      | —                 | `servers` entries                                                         |
| `toJsonSchema` | —                 | `(schema, "input" \| "output") => JsonSchema \| undefined`                |
| `include`      | every API route   | `(route) => boolean`                                                      |
| `tags`         | segment after api | `(route) => string[]`                                                     |
| `authorize`    | open              | `(request) => boolean` — `false` hides the endpoints behind the app's 404 |
| `outFile`      | `openapi.json`    | The build-output file; `false` skips the build step                       |

## Security notes

- The document describes your API's shape. Gate it with `authorize` when that is not
  public information — a refused request falls through to the app's ordinary 404, so
  there is no "forbidden" oracle.
- The builtin renderer escapes everything it prints and contains no script.
- The plugin reads `apiDefinitionOf` metadata only; it never executes a handler.

## License

MIT
