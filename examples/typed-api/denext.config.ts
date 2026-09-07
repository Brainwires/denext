import type { DenextConfig } from "denext/server";
import { openapi } from "@denext/openapi";

export default {
  // `@denext/openapi`: the same `defineApi` definitions that validate these routes describe
  // them — GET /openapi.json is the OpenAPI 3.1 document, GET /docs the reference page.
  // lib/schema.ts implements Standard JSON Schema, so every schema is fully described.
  plugins: [
    openapi({ info: { title: "Typed API example", version: "1.0.0" } }),
  ],
  // Live policy for this demo. The typed live primitives are default-deny like everything
  // on the socket; each opts in explicitly:
  // - `defineSubscription` (app/subscriptions.ts) needs no policy here: registering a
  //   definition IS the opt-in, and it validates + gates its own input.
  // - `createChannel` (app/channels.ts) carries its REQUIRED `authorize` inline.
  // - `useApi({ tags })` tag watches carry only tag NAMES (the client refetches over HTTP
  //   with its own cookies), so any same-origin viewer may watch them here.
  live: {
    canWatchTags: () => true,
  },
} satisfies DenextConfig;
