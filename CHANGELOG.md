# Changelog

All notable changes to **denext** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Project scaffolding**: `deno.json` with a self-contained JSX toolchain
  (`jsxImportSource: "denext"`), standard-library-only import map, and dev/start/
  build/test tasks. No runtime npm dependencies.
- **JSX runtime** (`src/jsx/`): a self-contained mini virtual DOM. `jsx`/`jsxs`/
  `jsxDEV`/`Fragment` for the automatic runtime, plus a classic `h()` helper. No
  React dependency.
- **Server-side rendering** (`src/jsx/render-to-string.ts`): `renderToString`
  supporting function components (sync and async), fragments, context providers,
  correct HTML escaping, void elements, boolean attributes, style-object
  serialization, and `dangerouslySetInnerHTML`.
- **Hooks** (`src/runtime/hooks.ts`): swappable-dispatcher `useState`,
  `useReducer`, `useEffect`, `useMemo`, `useCallback`, `useRef`, `useContext`,
  shared between server and (upcoming) client runtimes.
- **Context** (`src/runtime/context.ts`): `createContext` with provider/consumer
  resolution during rendering.
- **File-based router** (`src/router/`): Next.js App Router-style conventions —
  `page`, `layout`, `route` files; static, dynamic (`[slug]`), catch-all
  (`[...rest]`), and optional catch-all (`[[...rest]]`) segments; route groups
  (`(group)`); specificity-ordered matching; filesystem manifest scanner.
- **HTTP server** (`src/server/`): request handler dispatching to API routes,
  server-rendered pages, static assets, or a 404. Includes:
  - Page render pipeline composing the layout chain around a page and merging
    layout + page `metadata` (title/description/meta/head).
  - Full HTML document assembly with `<head>` metadata and a hydration bootstrap
    (serialized route data + client module script).
  - API dispatch by HTTP method (`GET`/`POST`/… exports) with automatic `HEAD`
    from `GET` and `405` + `Allow` for unsupported methods.
  - Static file serving from `public/` with path-traversal protection and
    content-type detection.
  - `serve()` helper over `Deno.serve`, and an injectable module loader.
- **Client runtime** (`src/client/`): a small virtual-DOM reconciler with real
  hooks and in-place DOM patching. Includes:
  - `createRoot` (fresh mount) and `hydrateRoot` (adopts server markup in place,
    binding events without recreating nodes; self-heals on mismatch).
  - Full hooks on the client (`useState`/`useReducer`/`useEffect` with
    dependency tracking + cleanup, `useMemo`/`useRef`/`useContext`).
  - Keyed children reconciliation that preserves element identity across
    reorders; microtask-batched updates with a `flushSync` escape hatch.
  - Context provider/consumer resolution through the live instance tree.
  - `bootstrap.ts` browser entry that rebuilds the server's tree from the
    embedded hydration payload and hydrates `#__denext`.
  - Injectable `document` (`setDocument`) so the reconciler stays DOM-agnostic
    and testable without a third-party DOM.
- **Tests**: coverage for the JSX runtime, SSR renderer, route-segment matching,
  the manifest scanner, the request handler, static serving, and the client
  reconciler — including hydration, keyed reordering, effects, and context
  (44 passing). Ships a tiny in-memory DOM shim for the reconciler tests.

[Unreleased]: https://example.com/denext/tree/main
