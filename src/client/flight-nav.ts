// The Flight soft-navigation runtime: parse a Flight navigation payload through the app-wide
// client registry and commit it through the retained root.
//
// Kept OFF the shared runtime chunk: the generated Flight entry is the only caller of
// `setFlightParser`, so an app with no Flight route never imports this module and ships none of
// it (the same import-gate discipline as `denext/lazy` and the Activity/ViewTransition installs).
// navigation.ts reaches it only through the `setFlightNavigator` seam.

import type { VNode, VNodeChild } from "../jsx/types.ts";
import type { FlightNavPayload } from "../server/document.ts";
import type { Root } from "./reconciler.ts";
import {
  emit,
  type NavigateOptions,
  resumabilityReboot,
  retainedRoot,
  retainRoot,
  scrollAfterNav,
  setFlightNavigator,
  setRootlessPrepare,
  updateHistory,
  withViewTransition,
  writeDataIsland,
} from "./navigation.ts";

/** `startClient` flags a root-less islands page here (navigation.ts). */
const globalWin = globalThis as { __dnxRootless?: boolean };

/**
 * Register the Flight-payload parser used by soft navigation, which installs the Flight
 * soft-nav runtime. Called once by the generated Flight entry with a closure over the app-wide
 * client registry (loading a route's island chunks before it reconstructs the tree).
 */
export function setFlightParser(
  parse: (flight: unknown) => VNodeChild | Promise<VNodeChild>,
): void {
  setFlightNavigator(async (body, url, href, options) => {
    // No root to render into (and not a root-less page this runtime can mount one for): hard
    // navigate rather than leave the user on the old route.
    if (!retainedRoot && !canMountRootless()) {
      location.href = href;
      return;
    }
    // Parse first (the parser may load this route's island chunks — async), then commit the
    // DOM synchronously inside the view transition: an async transition callback is aborted by
    // the browser when it outlives the transition ("invalid state").
    const prepared = await prepareFlightNav(parse, body, href);
    if (prepared) withViewTransition(() => commitFlightNav(prepared, url, href, options));
  });
}

/** A parsed soft-navigation Flight payload, ready to commit. */
interface PreparedFlightNav {
  payload: FlightNavPayload;
  tree: VNode;
}

/**
 * Parse a Flight soft-navigation payload and reconstruct its tree — awaiting the parser,
 * which may first load the route's island chunks (code-split islands). Any failure
 * (malformed payload, reconstruction error) hard-navigates and returns null, so the user is
 * never stuck on the old route; nothing is committed until {@link commitFlightNav}.
 */
async function prepareFlightNav(
  parse: (flight: unknown) => VNodeChild | Promise<VNodeChild>,
  body: string,
  href: string,
): Promise<PreparedFlightNav | null> {
  try {
    const payload = JSON.parse(body) as FlightNavPayload;
    const tree = await parse(payload.flight) as VNode;
    return { payload, tree };
  } catch {
    location.href = href; // malformed payload / reconstruction failure: hard navigate
    return null;
  }
}

/**
 * Commit a prepared Flight navigation: update history, title, and the `#__denext_data`
 * island, then reconcile the new tree through the retained root in place (preserving
 * unaffected-subtree state). Synchronous, so it can run inside a view transition.
 */
function commitFlightNav(
  { payload, tree }: PreparedFlightNav,
  url: URL,
  href: string,
  options: NavigateOptions,
): void {
  // A refresh of the current route (a Server Action's `refresh()`, a revalidation), read before
  // history moves: a root-less islands page adopts its markup instead of re-mounting it.
  const sameRoute = url.pathname === location.pathname;
  // Update history first so route hooks read the correct URL after render.
  updateHistory(url, options);

  // <title> + the hydration-data island, so useParams()/useTranslations() etc.
  // re-read the new route's params/messages (and a later hard reload matches).
  if (payload.title != null) document.title = payload.title;
  writeDataIsland(payload.data);

  emit();
  scrollAfterNav(url, options);

  try {
    if (retainedRoot) retainedRoot.render(tree);
    else mountRootlessPage(tree, sameRoute);
  } catch {
    // The render threw after we committed history/title — recover with a hard nav
    // so the document isn't left half-updated.
    location.href = href;
    return;
  }

  // Resumability: hand the new route's islands + signal state to the re-boot hook so
  // it can render/wire them. The route Flight carried its islands as empty foreign
  // hosts, so the reconciled wrappers are empty and the hook mounts each island from
  // its own Flight. The hook is null until the resumability runtime has loaded (an
  // app without islands never registers it, and pays nothing here).
  resumabilityReboot?.(payload.islands, payload.signalState);
}

/** Whether this is a root-less islands page the resumability runtime can mount a root for. */
function canMountRootless(): boolean {
  return !retainedRoot && !!globalWin.__dnxRootless && !!rootlessMount;
}

/**
 * The first Flight navigation of a root-less islands page (its document inlined no root Flight;
 * see `startClient`): the resumability runtime's {@link rootlessMount} renders `tree` — adopting
 * the current markup and its live islands for a refresh of the same route, else into a fresh
 * root. That root is retained, so later navigations reconcile in place as on any Flight page.
 */
function mountRootlessPage(tree: VNode | null, adopt: boolean): void {
  globalWin.__dnxRootless = false;
  retainRoot(rootlessMount!(tree, adopt));
}

/**
 * Renders a root-less islands page's first Flight navigation into a root (see
 * {@link mountRootlessPage}) — registered by the resumability runtime, which owns the island
 * roots it must keep (a refresh adopts them) or unmount (another route). Injected like
 * `resumabilityReboot`, keeping that code off the shared chunk.
 */
let rootlessMount: ((tree: VNode | null, adopt: boolean) => Root) | null = null;

/**
 * Register the root-less page mount (called by the resumability runtime). Also installs the
 * isomorphic-navigation hook that gives a root-less page a fresh root before a re-run entry
 * renders into it.
 */
export function setRootlessMount(fn: (tree: VNode | null, adopt: boolean) => Root): void {
  rootlessMount = fn;
  setRootlessPrepare(() => {
    if (canMountRootless()) mountRootlessPage(null, false);
  });
}
