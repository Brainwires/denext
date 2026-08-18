/**
 * # denext
 *
 * A **Next.js-style web framework for [Deno](https://deno.com)** — file-based App
 * Router, server-side rendering, streaming, client hydration, Suspense, middleware,
 * and Server Actions — built on the Deno standard library with **zero runtime npm
 * dependencies**. denext ships its own tiny React-equivalent (JSX runtime, hooks,
 * context, reconciler), so there is no React to install and nothing to pull from npm.
 *
 * This is the framework's main entrypoint: it re-exports the JSX runtime, hooks,
 * context, Suspense, error boundaries, the `<Image>` / `<Script>` / font helpers,
 * client navigation, and the server renderer. Server-only APIs (`createApp`,
 * `serve`, middleware, caching, Server Actions, image optimization, `safeFetch`)
 * live in [`@denext/denext/server`](https://jsr.io/@denext/denext/doc/server/~).
 *
 * - **Full guide & source:** [github.com/Brainwires/denext](https://github.com/Brainwires/denext)
 * - **Security model:** [Security guide](https://github.com/Brainwires/denext#security)
 *
 * ## Why denext
 *
 * - **No npm, no React install** — a self-contained JSX runtime, hooks, and reconciler.
 * - **App Router parity** — layouts, nested / parallel / intercepting routes, loading
 *   and error boundaries, `generateMetadata`, ISR, Server Actions, and an RSC-style
 *   Flight boundary.
 * - **Security-first** — same-origin-only Server Actions, an SSRF-safe image optimizer
 *   with DNS-rebinding protection, a `safeFetch` for untrusted URLs, strict SSR
 *   escaping, and a continuously-run suite of exploit probes mirrored from real
 *   Next.js CVEs (it has fixed classes Next.js itself only patched later).
 * - **Tiny by default** — denext's own small React-equivalent means a first page
 *   load of ~16 KB gzip (vs ~137 KB for a comparable Next.js app — ~8.5× smaller;
 *   see `bench/REPORT.md`), one shared runtime chunk cached across navigations, and
 *   **zero JavaScript** for routes with no interactivity.
 * - **Deno-native** — `deno bundle` builds, Deno KV for a shared ISR cache, and
 *   least-privilege permissions.
 *
 * ## Quick start
 *
 * @example An interactive App Router page — `app/page.tsx`
 * ```tsx
 * import { useState } from "@denext/denext";
 *
 * export const metadata = { title: "Home" };
 *
 * export default function Home() {
 *   const [n, setN] = useState(0);
 *   return <button onClick={() => setN(n + 1)}>Clicked {n} times</button>;
 * }
 * ```
 *
 * @example Render a component to an HTML string (server)
 * ```tsx
 * import { renderToString } from "@denext/denext";
 *
 * function Hello({ name }: { name: string }) {
 *   return <h1>Hello {name}</h1>;
 * }
 *
 * const html = await renderToString(<Hello name="world" />);
 * ```
 *
 * Then run the dev server:
 *
 * ```sh
 * deno run -A jsr:@denext/denext/cli dev
 * ```
 *
 * ## Entrypoints
 *
 * - `@denext/denext` — JSX runtime, hooks, components, client navigation, SSR.
 * - `@denext/denext/server` — `createApp` / `serve`, middleware, caching, Server
 *   Actions, image optimization, and `safeFetch`.
 * - `@denext/denext/client` — the browser reconciler and hydration entry.
 * - `@denext/denext/cli` — the `dev` / `build` / `start` command line.
 * - `@denext/denext/jsx-runtime` — the automatic JSX runtime (compiler target).
 * - `@denext/denext/compiler-runtime` — runtime surface for the auto-memo compiler.
 * - `@denext/denext/lint-plugin` — Deno-native lint rules for denext code.
 *
 * @module
 */

// `jsx`/`jsxs`/`jsxDEV` are the automatic-runtime functions the compiler calls
// via `denext/jsx-runtime`; they are not part of the hand-written API, so this
// entrypoint exports only `h` and `Fragment`.
export { Fragment, h } from "./src/jsx/jsx-runtime.ts";
export type {
  Component,
  JSX,
  Key,
  VNode,
  VNodeChild,
  VNodeChildren,
  VProps,
} from "./src/jsx/types.ts";

export {
  escapeHtml,
  isValidAttrName,
  renderToString,
  serializeStyle,
} from "./src/jsx/render-to-string.ts";
export type { HeadCollector, RenderOptions } from "./src/jsx/render-to-string.ts";

export { renderToReadableStream, streamToString } from "./src/jsx/render-to-stream.ts";
export type { StreamOptions } from "./src/jsx/render-to-stream.ts";

export { createResource, Suspense, SuspenseList, use } from "./src/runtime/suspense.ts";
export type { SuspenseListProps, SuspenseProps } from "./src/runtime/suspense.ts";

export { dynamic } from "./src/runtime/dynamic.ts";
export type { DynamicLoader, DynamicOptions } from "./src/runtime/dynamic.ts";

export {
  ErrorBoundary,
  forbidden,
  ForbiddenError,
  notFound,
  NotFoundError,
  permanentRedirect,
  redirect,
  RedirectError,
  unauthorized,
  UnauthorizedError,
} from "./src/runtime/error-boundary.ts";
export type { ErrorBoundaryProps, ErrorFallbackProps } from "./src/runtime/error-boundary.ts";

// Client navigation (safe to import on the server; DOM access is lazy).
export {
  Link,
  navigate,
  prefetch,
  useLinkStatus,
  useLocale,
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
  useSelectedLayoutSegment,
  useSelectedLayoutSegments,
  useTranslations,
} from "./src/client/navigation.ts";
export type { LinkProps, LinkStatus, NavigateOptions, Router } from "./src/client/navigation.ts";

// Asset components (next/image, next/script, next/font-style ergonomics).
export { denextImageLoader, Image, IMAGE_ENDPOINT } from "./src/runtime/image.ts";
export type { ImageLoader, ImageLoaderProps, ImageProps } from "./src/runtime/image.ts";
export { Script } from "./src/runtime/script.ts";
export type { ScriptProps, ScriptStrategy } from "./src/runtime/script.ts";
export { FontFace, localFont } from "./src/runtime/font.ts";
export type { FontResult, FontSource, LocalFontOptions } from "./src/runtime/font.ts";
export { googleFont, googleFontUrl } from "./src/runtime/font-google.ts";
export type { GoogleFontOptions } from "./src/runtime/font-google.ts";

export {
  startTransition,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useErrorBoundary,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useMemoCache,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "./src/runtime/hooks.ts";
export { memo } from "./src/runtime/memo.ts";
export { Profiler } from "./src/runtime/profiler.ts";
export type { ProfilerOnRender, ProfilerPhase, ProfilerProps } from "./src/runtime/profiler.ts";
export type { PropsComparator } from "./src/runtime/memo.ts";
export type {
  Context,
  Dispatcher,
  EffectCleanup,
  ErrorBoundaryController,
  Ref,
  StateUpdater,
} from "./src/runtime/hooks.ts";

export { createContext } from "./src/runtime/context.ts";

export { useActionState, useFormState, useFormStatus } from "./src/runtime/actions.ts";
export type { FormStatus } from "./src/runtime/actions.ts";

export { actionEndpoint, isServerAction, serverAction } from "./src/runtime/server-action.ts";
export type { ServerActionRef } from "./src/runtime/server-action.ts";

export { clientOnly, isServer, serverOnly } from "./src/runtime/environment.ts";

// Public environment variables (isomorphic; only public-prefixed vars are ever
// exposed to the client). Load .env files with `loadEnv` from "denext/server".
export { isPublicEnvKey, PUBLIC_ENV_PREFIXES, publicEnv } from "./src/runtime/public-env.ts";

/** The denext framework version. */
export const VERSION = "1.0.0";
