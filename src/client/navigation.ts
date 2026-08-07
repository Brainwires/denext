// Client-side (soft) navigation: intercept internal link clicks, fetch the
// target page's server-rendered HTML, swap it into the hydration root, update
// history + <head>, and re-run the route bundle to hydrate the new content.
//
// This module is browser-only in practice; all DOM/history/fetch access is
// inside functions so it can be imported safely on the server.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { hydrateRoot } from "./reconciler.ts";
import { useEffect, useState } from "../runtime/hooks.ts";
import { ROOT_ID } from "../server/document.ts";

// ---- Reactive location store ----------------------------------------------

interface LocationState {
  pathname: string;
  search: string;
}

const listeners = new Set<() => void>();
let current: LocationState = readLocation();

function readLocation(): LocationState {
  if (typeof location === "undefined") return { pathname: "/", search: "" };
  return { pathname: location.pathname, search: location.search };
}

function emit(): void {
  current = readLocation();
  for (const l of listeners) l();
}

export function subscribeLocation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLocationState(): LocationState {
  return current;
}

// ---- Soft navigation -------------------------------------------------------

let navCounter = 0;

/** Options controlling a soft (client-side) navigation. */
export interface NavigateOptions {
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
  /** Scroll to the top after navigating (defaults to true). */
  scroll?: boolean;
  /** Internal: set when responding to popstate (don't push history). */
  history?: boolean;
}

/**
 * Perform a soft navigation to `href`: fetch the target page, swap its markup
 * into the hydration root, update history and `<head>`, and re-hydrate. Falls
 * back to a full-page navigation on cross-origin URLs or network failure.
 */
export async function navigate(
  href: string,
  options: NavigateOptions = {},
): Promise<void> {
  const url = new URL(href, location.href);

  // Cross-origin: fall back to a full navigation.
  if (url.origin !== location.origin) {
    location.href = href;
    return;
  }

  let html: string;
  try {
    const res = await fetch(url.href, { headers: { "x-denext-nav": "1" } });
    if (!res.ok && res.status !== 404) throw new Error(`status ${res.status}`);
    html = await res.text();
  } catch {
    // Network/parse failure: hard navigate so the user isn't stuck.
    location.href = href;
    return;
  }

  const parsed = new DOMParser().parseFromString(html, "text/html");
  const newRoot = parsed.getElementById(ROOT_ID);
  const container = document.getElementById(ROOT_ID);
  if (!newRoot || !container) {
    location.href = href;
    return;
  }

  // Update history first so the bundle sees the correct URL.
  if (options.history === false) {
    // popstate: the browser already changed the URL; leave history alone.
  } else if (options.replace) {
    history.replaceState({}, "", url.href);
  } else {
    history.pushState({}, "", url.href);
  }

  // <title> and hydration data.
  const newTitle = parsed.querySelector("title");
  if (newTitle) document.title = newTitle.textContent ?? "";
  syncDataScript(parsed);

  // Swap the server-rendered markup in.
  container.innerHTML = newRoot.innerHTML;

  emit();
  if (options.scroll !== false) globalThis.scrollTo?.(0, 0);

  // Re-run the route's client bundle to hydrate the swapped markup.
  const moduleScript = parsed.querySelector<HTMLScriptElement>(
    'script[type="module"][src]',
  );
  if (moduleScript) {
    const src = new URL(moduleScript.getAttribute("src")!, url.href);
    src.searchParams.set("nav", String(navCounter++));
    const script = document.createElement("script");
    script.type = "module";
    script.src = src.href;
    document.body.appendChild(script);
  }
}

/** Copy the incoming page's hydration data script into the live document. */
function syncDataScript(parsed: Document): void {
  const incoming = parsed.getElementById("__denext_data");
  if (!incoming) return;
  let live = document.getElementById("__denext_data");
  if (!live) {
    live = document.createElement("script");
    live.id = "__denext_data";
    (live as HTMLScriptElement).type = "application/json";
    document.body.appendChild(live);
  }
  live.textContent = incoming.textContent;
}

// ---- Link interception -----------------------------------------------------

function shouldIntercept(event: MouseEvent, anchor: HTMLAnchorElement): boolean {
  if (event.defaultPrevented) return false;
  if (event.button !== 0) return false; // left click only
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const target = anchor.getAttribute("target");
  if (target && target !== "_self") return false;
  if (anchor.hasAttribute("download")) return false;
  if (anchor.getAttribute("rel") === "external") return false;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin) return false;
  return true;
}

/** Install global click + popstate handlers (idempotent per page load). */
export function installNavigation(): void {
  const w = globalThis as unknown as { __denextNav?: boolean };
  if (typeof document === "undefined" || w.__denextNav) return;
  w.__denextNav = true;

  document.addEventListener("click", (event) => {
    const anchor = (event.target as Element | null)?.closest?.("a");
    if (!anchor) return;
    if (!shouldIntercept(event as MouseEvent, anchor as HTMLAnchorElement)) return;
    event.preventDefault();
    navigate((anchor as HTMLAnchorElement).href);
  });

  globalThis.addEventListener("popstate", () => {
    navigate(location.href, { history: false });
  });
}

/** Hydrate the root and enable client-side navigation. Used by route bundles. */
export function startClient(container: Element, tree: VNode): void {
  hydrateRoot(container, tree);
  installNavigation();
}

// ---- Link component + router hooks -----------------------------------------

/** Props for the {@link Link} client-side navigating anchor component. */
export interface LinkProps {
  /** Destination URL for the link. */
  href: string;
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
  /** Scroll to the top after navigating (defaults to true). */
  scroll?: boolean;
  /** Anchor contents. */
  children?: VNodeChildren;
  /** Any additional attributes forwarded to the underlying `<a>` element. */
  [key: string]: unknown;
}

/** A client-side navigating anchor. */
export function Link(props: LinkProps): VNode {
  const { href, replace, scroll, children, ...rest } = props;
  return h(
    "a",
    {
      ...rest,
      href,
      onClick: (event: MouseEvent) => {
        if (
          event.button === 0 && !event.metaKey && !event.ctrlKey &&
          !event.shiftKey && !event.altKey
        ) {
          event.preventDefault();
          navigate(href, { replace, scroll });
        }
      },
    },
    children,
  );
}

/** Imperative navigation API returned by {@link useRouter}. */
export interface Router {
  /** Navigate to `href`, pushing a new history entry. */
  push(href: string): void;
  /** Navigate to `href`, replacing the current history entry. */
  replace(href: string): void;
  /** Go back one entry in the history stack. */
  back(): void;
  /** Go forward one entry in the history stack. */
  forward(): void;
  /** Re-fetch and re-render the current route. */
  refresh(): void;
}

/** Access the imperative {@link Router} for programmatic navigation. */
export function useRouter(): Router {
  return {
    push: (href) => void navigate(href),
    replace: (href) => void navigate(href, { replace: true }),
    back: () => history.back(),
    forward: () => history.forward(),
    refresh: () => void navigate(location.href, { history: false }),
  };
}

/** Reactive current pathname; re-renders the component on navigation. */
export function usePathname(): string {
  const [pathname, setPathname] = useState(getLocationState().pathname);
  useEffect(
    () => subscribeLocation(() => setPathname(getLocationState().pathname)),
    [],
  );
  return pathname;
}

/** Reactive current search params. */
export function useSearchParams(): URLSearchParams {
  const [search, setSearch] = useState(getLocationState().search);
  useEffect(
    () => subscribeLocation(() => setSearch(getLocationState().search)),
    [],
  );
  return new URLSearchParams(search);
}

/**
 * The active route path segments (reactive). In this build it returns the full
 * pathname split into segments rather than the slice below the calling layout's
 * level — a simplification of Next.js's layout-relative behavior.
 */
export function useSelectedLayoutSegments(): string[] {
  return usePathname().split("/").filter((s) => s.length > 0);
}

/** The first active route segment (reactive), or null at the root. */
export function useSelectedLayoutSegment(): string | null {
  const segments = useSelectedLayoutSegments();
  return segments.length > 0 ? segments[0] : null;
}
