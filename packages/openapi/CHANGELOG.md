# Changelog

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
