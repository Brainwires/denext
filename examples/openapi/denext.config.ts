import type { DenextConfig } from "denext/server";
import { openapi } from "@denext/openapi";

export default {
  // `@denext/openapi`: the OpenAPI 3.1 document is derived from this app's `defineApi`
  // definitions — no extra annotation. It serves the spec at `/openapi.json`, an interactive
  // docs page at `/docs`, and writes `openapi.json` into the build output.
  plugins: [
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
      // The docs renderer. `swagger` (Swagger UI, from unpkg) and `scalar` (Scalar, from
      // jsDelivr) are interactive ("try it"); `builtin` (the default) is a server-rendered,
      // zero-JavaScript reference page that needs no CDN. Swap this one line to compare them.
      ui: "swagger",
      // Declare the bearer-token scheme ONCE here → Swagger UI shows an "Authorize" button. Log
      // in at POST /api/login (username "demo", password "denext"), paste the returned token into
      // Authorize, and every protected request carries `Authorization: Bearer <token>`.
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "opaque token" },
      },
      // WHICH scheme each operation needs is declared per endpoint via `security` on the
      // definition (see app/api/**/route.ts) — so reads are public and writes are protected on the
      // same path. You could instead set a project-wide default here, e.g.
      //   security: (route) => route.routePath === "/api/login" ? [] : [{ bearerAuth: [] }],
      // which any per-endpoint `security` overrides.
    }),
  ],
  // denext ships NO Content-Security-Policy by default, so the CDN-loaded Swagger/Scalar
  // bundles just work. If you turn CSP on (`csp: "strict"`), the CDN UIs need their host
  // allowed and Swagger's runtime-injected styles make it awkward — prefer `ui: "builtin"`
  // (strict-CSP clean) there, or add the CDN host:
  //   csp: { scriptSrc: ["https://unpkg.com"], styleSrc: ["https://unpkg.com"], imgSrc: ["data:"] }
} satisfies DenextConfig;
