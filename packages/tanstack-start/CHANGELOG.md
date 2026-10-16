# Changelog — @denext/tanstack-start

All notable changes to this package are documented here. It follows its own semver, independent
of `@denext/denext`.

## [0.1.0] - Unreleased

Initial release: Start-style server rendering for a TanStack Router app. The plugin generates the
route tree with TanStack's generator, renders every page through TanStack Router's SSR (loaders on
the server, the root route's `shellComponent` as the document, the router state dehydrated), and
hydrates it in the browser with `RouterClient` from a client bundle it builds.
