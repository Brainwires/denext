// The `denext ui` panels as data: each panel's root path and what it does. The overview's cards
// (./routes.ts) and the MCP front end (`denext mcp`'s `denext_ui_*` tools, ../mcp/ui.ts) both
// read this list, so a panel added to the UI is a card and an agent tool at once. Kept free of
// the panels' handlers, so the MCP server can read it without loading the UI.

/** One `denext ui` panel. */
export interface UiPanel {
  /** Its root path (its JSON twin is `/api` + this); every page under it belongs to it. */
  readonly path: string;
  /** The tool-name suffix (`denext_ui_<id>`). */
  readonly id: string;
  /** What it does, one line (the overview card's text). */
  readonly lead: string;
}

/** Every panel, in navigation order (the overview at `/` is not one). */
export const UI_PANELS: readonly UiPanel[] = [
  {
    path: "/setup",
    id: "setup",
    lead: "Check what this project needs to run, and write the missing pieces.",
  },
  {
    path: "/config",
    id: "config",
    lead: "Edit denext.config.ts through schema-driven widgets, one view per subject.",
  },
  { path: "/plugins", id: "plugins", lead: "Browse the catalog; add or remove plugins." },
  {
    path: "/generate",
    id: "generate",
    lead: "Scaffold pages, routes, layouts, components, actions.",
  },
  {
    path: "/docker",
    id: "docker",
    lead: "Edit docker-compose.yml in place, or regenerate the Docker files with a diff.",
  },
  { path: "/desktop", id: "desktop", lead: "Set up code signing for a packaged desktop build." },
  {
    path: "/dev",
    id: "dev",
    lead: "Start and stop the project's dev server, and watch its output.",
  },
  {
    path: "/tasks",
    id: "tasks",
    lead: "Run the scripts your deno.json declares, streaming their output.",
  },
  {
    path: "/services",
    id: "services",
    lead: "The supervised services/ tree: running, restarting or failed, with restart counts.",
  },
  {
    path: "/database",
    id: "database",
    lead: "Browse and edit the Postgres tables, run SQL, and manage policies, migrations, " +
      "storage, auth users and logs.",
  },
  { path: "/commands", id: "commands", lead: "Run this project's own denext verbs." },
];

/**
 * The panel a UI path belongs to (its root, or a page under it), or null.
 *
 * @param path A UI path without the `/api` prefix (`/config/routing`, `/tasks/run`).
 */
export function panelOf(path: string): UiPanel | null {
  return UI_PANELS.find((p) => path === p.path || path.startsWith(p.path + "/")) ?? null;
}
