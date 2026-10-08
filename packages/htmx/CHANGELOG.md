# Changelog

## 2.0.12

- **The runtime reaches a static export.** The build step publishes `htmx.min.js` with `emitFile`
  at the plugin's `path`, so `denext export` serves it from the site root and `denext start`
  serves a build's copy from the emitted files. It used to be written under `.denext/`, where an
  export never picked it up. On a denext without `emitFile` (before 3.4) the step writes under
  the build output as before.

## 2.0.11

- Requires denext ≥ 2.0.0-rc.7: the plugin no longer imports `FRAGMENT` from the `denext/server` barrel (removed there in rc.7), so it links against rc.7's trimmed public surface.

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
