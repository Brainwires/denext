import { denextAuth, type DenextConfig } from "denext/server";
import { openapi } from "@denext/openapi";
import { authConfig } from "./lib/auth.ts";

export default {
  // `@denext/openapi`: the OpenAPI 3.1 document is derived from this app's `defineApi`
  // definitions — no extra annotation. It serves the spec at `/openapi.json`, an interactive
  // docs page at `/docs`, and writes `openapi.json` into the build output.
  plugins: [
    // First-party auth. It stores this demo's bearer API tokens (hashed) in the adapter
    // `lib/auth.ts` configures, and mounts `/auth/*` — including `POST /auth/tokens`,
    // `GET /auth/tokens` and `DELETE /auth/tokens/:id`, where a signed-in user manages
    // their own tokens. `POST /api/login` is the shortcut this demo's Swagger flow uses.
    denextAuth(authConfig),
    openapi({
      info: {
        title: "Pets API",
        version: "1.0.0",
        description: "A tiny pet store, defined with `defineApi` + Zod.",
      },
      // No `servers` → Swagger UI sends "Try it out" requests to the page's own origin, so it
      // works however you open the docs (localhost, 127.0.0.1, a LAN IP, a deployed host). Add
      // `servers: [{ url: "https://api.example.com" }]` to point a published doc at a real host —
      // just note that a cross-origin host needs CORS on the API for "Try it out" to reach it.
      // The docs renderer. `swagger` (Swagger UI) and `scalar` (Scalar) are interactive ("try
      // it"), both served from copies vendored in `@denext/openapi` (no CDN; `cdn: DOCS_CDN.*`
      // opts into one); `builtin` (the default) is a server-rendered, zero-JavaScript reference
      // page. Swap this one line to compare them.
      ui: "swagger",
      // Declare the bearer-token scheme ONCE here → Swagger UI shows an "Authorize" button. Log
      // in at POST /api/login (username "demo", password "denext"), paste the returned token into
      // Authorize, and every protected request carries `Authorization: Bearer <token>`.
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "tok_… (opaque)" },
      },
      // WHICH operations need it follows from the builder each route uses (app/api/**/route.ts):
      // `defineApi(...)` is public, `authed.define(...)` enforces the token and documents the
      // requirement (`documentsSecurity` in lib/auth.ts) — so reads are public and writes are
      // protected on the same path. A document-wide default can be set here instead, e.g.
      //   security: (route) => route.routePath === "/api/login" ? [] : [{ bearerAuth: [] }],
      // (documentation only: enforcement stays with the route's middleware).
    }),
  ],
  // The docs page answers with its own Content-Security-Policy, fitted to the renderer it serves
  // (the vendored files are `'self'`), so the app's strict default CSP needs no change. Only a
  // `cdn` override names another origin, and the docs page's policy allows that one itself.
} satisfies DenextConfig;
