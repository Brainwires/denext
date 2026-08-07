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
- **Tests**: coverage for the JSX runtime, SSR renderer, route-segment matching,
  and the manifest scanner (28 passing).

[Unreleased]: https://example.com/denext/tree/main
