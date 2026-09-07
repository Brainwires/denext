import type { DenextConfig } from "denext/server";
import { graphql } from "@denext/graphql";

export default {
  // `@denext/graphql`: GraphQL Yoga at /graphql (GraphiQL in dev), a Pothos schema, and a
  // subscription that rides the `messages` channel — the same push `useChannel` receives.
  plugins: [
    graphql({
      schema: () => import("./app/graphql/schema.ts").then((m) => m.schema),
      context: ({ signal }) => ({ signal }),
    }),
  ],
} satisfies DenextConfig;
