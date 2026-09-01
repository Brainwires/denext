# Changelog

## 2.0.10

Initial release. First-class [htmx](https://htmx.org) support for denext as a
plugin.

- `htmx()` plugin — serves the vendored htmx runtime (v2.0.10) from `'self'` at
  `/_denext/htmx/htmx.min.js` in dev/prod, and emits it into the export output
  for static sites.
- `<Htmx/>` component — the deferred `<script>` tag for your layout.
- `hx()` — typed, autocompleting spread helper for `hx-*` attributes (raw
  attributes work unchanged; this is DX only).
- `isHtmxRequest` / `htmxRequest` — parse incoming `HX-*` request headers.
- `htmlResponse(vnode, init)` — render a fragment `Response` and set `HX-*`
  response directives (retarget, reswap, trigger, redirect, push-url, …).
- `denext htmx` CLI verb (`info`, `eject`) via the plugin `addCommand` seam.
- `HtmxAttributes` / `HtmxSwap` types (`@denext/htmx/types`).

The package version tracks the htmx version it vendors.
