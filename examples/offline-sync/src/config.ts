// Where the backend is. `""` is the page's own origin: `denext task start` proxies `/api` to
// backend/ (spa.proxy in denext.config.ts); `denext task dev` does not, so there the page's
// `/api` calls don't reach the backend. In the Capacitor shell the page is served from the app
// itself, so set this to the backend's public https origin before `denext export`.
export const SYNC_ORIGIN = "";
