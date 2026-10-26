// The `denext ui` / `denext dashboard` defaults the CLI names before it loads the UI: the verbs'
// help text and the dashboard's banner read them, and `@denext/ui` (loaded on first use, see
// src/cli/ui-package.ts) re-exports them, so both sides agree without the CLI loading the UI.

/** The port `denext ui` tries first (falling forward when it is taken). */
export const DEFAULT_UI_PORT = 5177;

/** The shortest `DASHBOARD_PASSWORD` the dashboard accepts; a shorter one leaves it locked. */
export const DASH_MIN_PASSWORD = 12;

/** The port the stack's dashboard log relay (`denext dashboard-logs`) listens on by default. */
export const DEFAULT_RELAY_PORT = 3101;
