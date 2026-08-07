// Client runtime public surface.

export { createRoot, flushSync, hydrateRoot, type Root, setDocument } from "./reconciler.ts";

// Re-export hooks and context so client components import from one place.
export {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "../runtime/hooks.ts";
export { createContext } from "../runtime/context.ts";
export { createResource, Suspense, use } from "../runtime/suspense.ts";
export { ErrorBoundary, notFound } from "../runtime/error-boundary.ts";
export { Fragment, h, jsx, jsxs } from "../jsx/jsx-runtime.ts";

export {
  Link,
  navigate,
  startClient,
  usePathname,
  useRouter,
  useSearchParams,
} from "./navigation.ts";
export type { LinkProps, Router } from "./navigation.ts";
