# Changelog

## 0.3.0

- Pre-release hardening of `emitTypes` (found by the 2.4.2 audit): `ApiSchema.params` are always
  `string`/`string[]` (the client's constraint; a coerced `z.number()` param made the whole file
  fail `createApiClient<ApiSchema>`), members + `additionalProperties` emit an intersection
  instead of a TS2411 index signature, a nullable item type is parenthesised before `[]`, `TRACE`
  is not keyed in `ApiSchema`, a document without `paths` or with a non-string `description` does
  not throw, and `info.title`/`info.version` cannot end the header comment (line terminators,
  incl. U+2028, are folded).

- **`denext openapi types [--out <file>]` + `emitTypes(document)`** (`@denext/openapi/types`).
  TypeScript for a consumer OUTSIDE the app — a separate frontend, a script — as one `.ts` with
  no imports: openapi-typescript-style `paths`/`components` interfaces, and denext's `ApiSchema`
  keyed by route pattern and method so `createApiClient<ApiSchema>({ base })` from
  `jsr:@denext/denext` is a fully typed client there (wire codec, dedupe, batching, error-code
  narrowing). Types only, by design; the header states the wire format. JSON Schema subset:
  `$ref` (components + inline `$defs`, recursion cut to `unknown`), `type` incl. arrays and
  `null`, `enum`/`const`, objects with `required`/`additionalProperties`, arrays with
  `items`/`prefixItems`, `oneOf`/`anyOf`/`allOf`, `nullable`, `description` → JSDoc; an opaque
  schema is `unknown`.
- **Operation extensions** `x-denext-path` (the denext route pattern) and `x-denext-errors`
  (`{ code: status }`, builtins included), which the emitter reads. `diff` treats them as
  ordinary keys.
- **Fixed: `denext openapi <action>` on an app whose routes import an npm package.** The verb
  never asked the CLI for its module gate, so those route modules failed to load in-process
  (`load-failed` … "not a dependency and not in import map") and the emitted document had no
  operations — the `examples/openapi` app (Zod) included. The command now declares
  `loadsModules` with the working directory as the project, and runs under the merged
  framework+app config like `build`/`doctor`.

## 0.2.0

- **Security schemes → the Swagger "Authorize" button.** New `securitySchemes` option emits
  `components.securitySchemes`, and `security` sets the requirement — as a document-wide array,
  a `(route) => …` function, a `security` field on a `defineApi` definition, or (recommended) a
  middleware tagged with denext's `documentsSecurity`, so applying the auth middleware both
  enforces and documents the requirement with nothing on the definition. Operations on one path
  can differ (a public `GET`, a protected `POST`). Precedence: per-endpoint → middleware-documented
  → document-level → none. Documentation only; enforce the token with middleware. New exported
  types `OpenApiSecurityScheme` and `SecurityRequirement`.

## 0.1.0

Initial release. An OpenAPI 3.1 document and a docs page for a denext app, derived from
the `defineApi` definitions its route handlers already carry (requires denext ≥ 2.1.0-rc.1).

- `openapi()` plugin — serves `GET /openapi.json` and `GET /docs` (request handler; core
  routes always win), writes `openapi.json` into the build output (build step), and
  contributes the `denext openapi emit | diff <file> | lint` verb (command seam).
- Schemas become JSON Schema through the Standard JSON Schema interface
  (`~standard.jsonSchema.input/output` — Zod ≥ 4.2, ArkType ≥ 2.1.28, Valibot's
  `toStandardJsonSchema`), TypeBox's native JSON Schema, a `toJsonSchema()` method, or a
  `toJsonSchema` converter option; anything else is `{}` plus an `opaque-schema` lint
  warning.
- Every declared error code is a response on its status with the shared `ApiError`
  envelope schema and the code as an enum; a validated endpoint gets its `400`.
- Docs renderers: `builtin` (server-rendered, zero JavaScript, strict-CSP clean — the
  default), `scalar`, `swagger` (CDN-loaded, interactive).
- `buildOpenApi` / `diffSpecs` / `toJsonSchema` exported from `@denext/openapi/spec` for
  CI scripts that need no server.
