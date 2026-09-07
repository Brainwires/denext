// Route-relative paths (Remix): `<Link to="new">` inside the `users.$username_.notes` layout
// resolves against THAT ROUTE's own pathname (`/users/kody/notes/new`), not the browser URL's
// parent — and `..` climbs a route level. A route's pathname is derived from its Remix id
// (the module path under `app/`, in flat or remix-flat-routes spelling) plus its params.

/** The URL pathname the route `id` matched, given its params (`routes/users+/$username` → `/users/kody`). */
export function remixRoutePathname(id: string, params: Record<string, string>): string {
  if (id === "root" || id === "") return "/";
  // Protect `[escaped]` groups (`sitemap[.]xml`) from the segment split, restore after.
  const escapes: string[] = [];
  const stem = id.replace(/^routes\//, "").replace(/\[([^\]]*)\]/g, (_m, inner: string) => {
    escapes.push(inner);
    return `\uE000${escapes.length - 1}\uE000`;
  });
  const out: string[] = [];
  for (const raw of stem.split(/[/.]/)) {
    const seg = raw.replace(/\+$/, "") // a remix-flat-routes folder
      .replace(/\uE000(\d+)\uE000/g, (_m, k: string) => escapes[Number(k)]);
    out.push(...routeSegmentParts(seg, params));
  }
  return "/" + out.filter((s) => s !== "").join("/");
}

/** Route-id parts that add nothing to the URL. */
const NON_URL_PARTS = new Set(["", "route", "_layout", "_index", "index"]);

/** The URL segment(s) one route-id part contributes: a literal, a param value, or a splat. */
function routeSegmentParts(raw: string, params: Record<string, string>): string[] {
  if (NON_URL_PARTS.has(raw)) return [];
  const seg = raw.endsWith("_") && raw.length > 1 ? raw.slice(0, -1) : raw; // layout break-out
  if (seg.startsWith("_")) return []; // pathless layout
  if (seg === "$") return (params["*"] ?? "").split("/");
  if (seg.startsWith("$")) return [params[seg.slice(1)] ?? ""];
  return [seg];
}

/**
 * Resolve a Remix `to` against the current route's pathname: absolute paths and URLs pass
 * through; `?search`/`#hash` attach to `routePathname`; a relative path (`new`, `../edit`)
 * resolves as if the route were a directory, so `new` appends and `..` climbs.
 */
export function resolveRoutePath(to: string, routePathname: string): string {
  if (to === "" || to.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(to)) return to;
  if (to.startsWith("?") || to.startsWith("#")) return routePathname + to;
  const base = routePathname.endsWith("/") ? routePathname : routePathname + "/";
  const u = new URL(to, "http://denext.local" + base);
  // `..` from `/a/b/` resolves to `/a/` — a route pathname has no trailing slash unless `to`
  // asked for one (`new/`); the root stays `/`.
  const keepSlash = /\/(?:[?#].*)?$/.test(to);
  const pathname = !keepSlash && u.pathname.length > 1 ? u.pathname.replace(/\/$/, "") : u.pathname;
  return pathname + u.search + u.hash;
}
