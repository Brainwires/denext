// Where the backend is. `""` is the page's own origin: `denext task dev` / `start` proxy `/api`
// to backend/ (spa.proxy in denext.config.ts). In the Capacitor shell the page is served from
// the app itself, so set this to the backend's public https origin before `denext export`.
export const SYNC_ORIGIN = "";
