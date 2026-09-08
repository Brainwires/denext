// A migrated app imports this DSL from `@react-router/dev/routes` (denext aliases it to the
// line below in deno.json). This in-repo example imports the denext package directly so the
// plugin resolves it under the framework checkout — the route components below still import
// bare `react-router`, unchanged.
import { index, layout, prefix, route } from "@denext/react-router/routes";

// The same config-routing DSL as React Router v7 — the plugin evaluates this file, generates a
// denext route wrapper per entry, and adds them to the App Router.
export default [
  index("routes/home.tsx"),
  route("about", "routes/about.tsx"),
  layout("routes/shell.tsx", [
    ...prefix("teams", [
      index("routes/teams/list.tsx"),
      route(":id", "routes/teams/team.tsx"),
    ]),
  ]),
  route("api/health", "routes/api/health.ts"),
  route("boom", "routes/boom.tsx"),
];
