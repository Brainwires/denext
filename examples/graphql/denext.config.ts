import type { DenextConfig } from "denext/server";
import { graphql } from "@denext/graphql";

export default {
  // `@denext/graphql`: GraphQL Yoga at /graphql (GraphiQL in dev), a Pothos schema, and a
  // subscription that rides the `messages` channel — the same push `useChannel` receives —
  // over SSE or WebSocket (`graphql-ws`). The schema is named by its module path, so an edit
  // under app/graphql/ reloads it in `denext dev` without a restart.
  plugins: [
    graphql({
      schema: "./app/graphql/schema.ts",
      context: ({ signal }) => ({ signal }),
    }),
  ],
} satisfies DenextConfig;
