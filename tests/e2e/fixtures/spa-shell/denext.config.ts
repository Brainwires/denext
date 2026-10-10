// `spa.shell` fixture: a prerendered static shell the user can type into before the client bundle
// has loaded. The app renders off-screen, takes over the typed text, selection and focus, and calls
// `shellReady()` to replace the shell in one commit (tests/e2e/spa-shell.e2e.test.ts,
// tests/integration/spa-shell-export.test.ts).
import type { DenextConfig } from "denext/server";

export default {
  mode: "spa",
  spa: {
    entry: "./src/main.tsx",
    title: "denext spa.shell fixture",
    csp: "strict",
    shell: {
      component: "./src/AppShell.tsx",
      props: { placeholder: "Ask anything" },
      bootScript: "./src/boot.ts",
      readyOn: "shellReady",
      maxHoldMs: 30_000,
    },
  },
} satisfies DenextConfig;
