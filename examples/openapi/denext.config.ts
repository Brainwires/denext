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
      servers: [{ url: "http://localhost:3000" }],
      // The docs renderer. `swagger` (Swagger UI, from unpkg) and `scalar` (Scalar, from
      // jsDelivr) are interactive ("try it"); `builtin` (the default) is a server-rendered,
      // zero-JavaScript reference page that needs no CDN. Swap this one line to compare them.
      ui: "swagger",
    }),
  ],
  // denext ships NO Content-Security-Policy by default, so the CDN-loaded Swagger/Scalar
  // bundles just work. If you turn CSP on (`csp: "strict"`), the CDN UIs need their host
  // allowed and Swagger's runtime-injected styles make it awkward — prefer `ui: "builtin"`
  // (strict-CSP clean) there, or add the CDN host:
  //   csp: { scriptSrc: ["https://unpkg.com"], styleSrc: ["https://unpkg.com"], imgSrc: ["data:"] }
} satisfies DenextConfig;
