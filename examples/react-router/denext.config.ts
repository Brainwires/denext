import type { DenextConfig } from "denext/server";
import { reactRouter } from "@denext/react-router";

// `@denext/react-router`: run a React Router v7 framework-mode app on denext with the app's
// source untouched. The plugin reads `app/routes.ts`, generates denext route wrappers under
// `.denext/react-router/`, and feeds them to the App Router — so Flight, streaming SSR,
// per-segment error boundaries, and soft navigation are all denext's.
export default {
  plugins: [reactRouter()],
} satisfies DenextConfig;
