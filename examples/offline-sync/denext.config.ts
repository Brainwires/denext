import type { DenextConfig } from "denext/server";

// The app: a client-only SPA (what a Capacitor shell packages). Its data lives in a local
// SQLite database through `openSqlite` from denext/mobile; backend/ is the API it syncs with,
// reached through the dev / start proxy below (and directly, by origin, from the shell).
export default {
  mode: "spa",
  spa: {
    entry: "./src/main.tsx",
    title: "Offline notes",
    proxy: { prefixes: ["/api"], target: "http://127.0.0.1:8788" },
    // The Capacitor shell loads files as they are: no .gz siblings.
    precompress: false,
  },
} satisfies DenextConfig;
