// A resource route: no default export, just a `loader` returning a Response.
export function loader() {
  return Response.json({ ok: true });
}
