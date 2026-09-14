// DevTools → MCP bridge, page side: push the inspector's component tree to the dev server.
//
// An MCP client (an agent) cannot reach into the browser, and denext deliberately has no
// pull channel from the dev server into the page. So the page PUSHES: after every commit
// (trailing-throttled) the sink serializes the inspector tree, strips it down to what is
// safe and useful out-of-process, and POSTs it to `/_denext/dev-inspect`, where the dev
// server keeps the latest snapshot per page URL for `denext_component_tree`,
// `denext_why_render` and `denext_hook_state` to read.
//
// Three properties this module must keep:
//   * **Silent.** Every failure path is swallowed — a dev-server that is gone, a body the
//     server refuses, a serialization error. The app must never notice the sink exists.
//   * **Bounded.** Depth, node count and body bytes are capped here, on the producing
//     side, so a pathological tree can neither wedge the page nor flood the dev server
//     (which caps again, independently — this is browser-supplied data).
//   * **Dev-only.** It is reachable exclusively from `installDevtools`, which no
//     production entry imports, and the endpoint it posts to exists only on the dev
//     server (and only behind its same-origin gate).
//
// It runs whether or not the panel is open: an agent inspecting a page the developer
// never opened the panel on is the normal case.

import type {
  DenextDevtoolsApi,
  InspectContext,
  InspectHook,
  InspectNode,
  RenderReason,
  SerializedValue,
  SourceLocation,
} from "./devtools-inspect.ts";

/**
 * Browser → dev-server inspector sink (POST; the MCP bridge GETs the same path).
 *
 * A copy of `src/build/dev-server/state.ts`'s `DEV_INSPECT_PATH` VALUE on purpose: this is
 * client code and must never import from `src/build/`. Deliberately NOT exported — a test
 * asserts the URL the sink actually posts to against the dev server's constant, which is
 * the property that matters (and leaves one canonical export of that name in the repo).
 */
const DEV_INSPECT_PATH = "/_denext/dev-inspect";

/** Trailing-edge throttle: a burst of commits produces ONE post, this long after the first. */
const THROTTLE_MS = 1500;

/** How deep the posted tree goes before it is cut off. */
const MAX_DEPTH = 50;

/** How many component nodes the posted tree may carry. */
const MAX_NODES = 2000;

/** The posted body's byte budget (the dev server refuses anything larger with a 413). */
const MAX_BYTES = 256 * 1024;

/** Longest page URL recorded with a snapshot. */
const MAX_URL = 2048;

/**
 * One component in a posted snapshot: an {@link InspectNode} with the live-edit
 * affordances removed — no `propEntries` (the panel's per-prop override rows), no raw
 * values, and no host/text/fragment nodes (their component descendants are re-parented
 * onto the nearest component ancestor, so the tree reads as a component tree).
 */
export interface InspectSnapshotNode {
  /** The fiber id, as the panel and the inspector API use it. */
  id: number;
  /** Display name — component name, `Suspense`, `ErrorBoundary`, … */
  name: string;
  /** The React key, if any. */
  key: string | null;
  /** Capability/role badges (`memo`, `Suspense`, `ErrorBoundary`, …), when any apply. */
  badges?: string[];
  /** A shallow preview of the component's props. */
  props: SerializedValue;
  /** Its hook cells, in call order, named when the dev metadata resolved. */
  hooks: InspectHook[];
  /** The contexts it read on its last render. */
  contexts: InspectContext[];
  /** Where it was declared, when the Fast Refresh registry and dev metadata knew. */
  source?: SourceLocation;
  /** Whether the hook labels resolved (see {@link InspectNode.hooksNamed}). */
  hooksNamed?: boolean;
  /** Why it last rendered — present once render-reason tracking has seen a commit. */
  reason?: RenderReason;
  /** Child components, in order. */
  children: InspectSnapshotNode[];
}

/** One page's component tree as the sink posted it. */
export interface InspectSnapshot {
  /** The page it was taken on — `location.pathname + location.search`. */
  url: string;
  /** The page clock (`Date.now()`) at serialization; staleness is measured server-side. */
  at: number;
  /** Whether a cap (depth, node count or byte budget) cut the tree short. */
  truncated: boolean;
  /** The root components, in order. */
  nodes: InspectSnapshotNode[];
}

/** The walk's remaining budget; `truncated` records whether any cap actually bit. */
interface Budget {
  nodes: number;
  bytes: number;
  truncated: boolean;
}

/** A serialized value with the primitive `raw` (and any nested entries') stripped. */
function stripRaw(v: SerializedValue): SerializedValue {
  const { raw: _raw, entries, ...rest } = v;
  return entries
    ? { ...rest, entries: entries.map((e) => ({ key: e.key, value: stripRaw(e.value) })) }
    : rest;
}

/** A hook cell with every serialized value stripped of its raw primitive. */
function stripHook(h: InspectHook): InspectHook {
  return {
    ...h,
    value: stripRaw(h.value),
    ...(h.deps ? { deps: h.deps.map(stripRaw) } : {}),
  };
}

/** Roughly how many bytes this node (without its children) costs in the posted body. */
function costOf(node: InspectSnapshotNode): number {
  try {
    return JSON.stringify(node).length + 2;
  } catch {
    return MAX_BYTES; // unserializable — treat as unaffordable
  }
}

/** The node minus its children, with every live-edit affordance and raw value removed. */
function shellOf(node: InspectNode, api: DenextDevtoolsApi): InspectSnapshotNode {
  const reason = api.getRenderReason(node.id);
  return {
    id: node.id,
    name: node.name,
    key: node.key,
    ...(node.badges ? { badges: node.badges } : {}),
    props: stripRaw(node.props),
    hooks: node.hooks.map(stripHook),
    contexts: node.contexts.map((c) => ({ name: c.name, value: stripRaw(c.value) })),
    ...(node.source ? { source: node.source } : {}),
    ...(node.hooksNamed === undefined ? {} : { hooksNamed: node.hooksNamed }),
    ...(reason ? { reason } : {}),
    children: [],
  };
}

/**
 * Serialize `nodes` (and their descendants) into snapshot nodes, dropping host/text/
 * fragment nodes by splicing their children into `out`, until a cap bites.
 *
 * @param nodes The inspector nodes to walk.
 * @param out Where the resulting component nodes are appended.
 * @param api The inspector API (read for per-node render reasons).
 * @param depth The component depth reached so far.
 * @param budget Remaining node/byte allowance; mutated, and flagged when a cap bites.
 * @returns Whether the walk may continue (false once the budget is spent).
 */
function walk(
  nodes: InspectNode[],
  out: InspectSnapshotNode[],
  api: DenextDevtoolsApi,
  depth: number,
  budget: Budget,
): boolean {
  for (const node of nodes) {
    if (node.kind !== "component") {
      if (!walk(node.children, out, api, depth, budget)) return false;
      continue;
    }
    if (depth >= MAX_DEPTH || budget.nodes <= 0) {
      budget.truncated = true;
      return false;
    }
    const shell = shellOf(node, api);
    const cost = costOf(shell);
    if (cost > budget.bytes) {
      budget.truncated = true;
      return false;
    }
    budget.nodes--;
    budget.bytes -= cost;
    out.push(shell);
    if (!walk(node.children, shell.children, api, depth + 1, budget)) return false;
  }
  return true;
}

/** The page URL a snapshot is keyed by (path + query, length-clamped). */
function pageUrl(): string {
  try {
    const loc = (globalThis as { location?: Location }).location;
    return ((loc?.pathname ?? "/") + (loc?.search ?? "")).slice(0, MAX_URL);
  } catch {
    return "/";
  }
}

/**
 * Build the snapshot to post: the inspector's component tree, stripped of raw values and
 * cut to the depth/node/byte caps.
 *
 * @param api The inspector API.
 * @returns The snapshot (`truncated` when a cap bit).
 */
export function buildSnapshot(api: DenextDevtoolsApi): InspectSnapshot {
  const budget: Budget = { nodes: MAX_NODES, bytes: MAX_BYTES - 512, truncated: false };
  const nodes: InspectSnapshotNode[] = [];
  try {
    walk(api.getInspectorTree(), nodes, api, 0, budget);
  } catch {
    budget.truncated = true; // a throwing getter mid-walk: post what we have
  }
  return { url: pageUrl(), at: Date.now(), truncated: budget.truncated, nodes };
}

/** POST the snapshot; every failure is swallowed (the app must never see the sink). */
function post(api: DenextDevtoolsApi): void {
  try {
    const body = JSON.stringify(buildSnapshot(api));
    if (body.length > MAX_BYTES) return; // would be refused (413) — drop it silently
    void fetch(DEV_INSPECT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).then((res) => res.body?.cancel()).catch(() => {});
  } catch {
    // No fetch, no location, an unserializable tree — nothing to do about it here.
  }
}

/**
 * Start pushing inspector snapshots to the dev server.
 *
 * Subscribes to commits with a trailing 1.5 s throttle (a burst of commits posts once)
 * plus a final post on `pagehide`, so an agent reading `/_denext/dev-inspect` sees the
 * tree as of the page's last settled state. Render-reason tracking is switched on here,
 * not by the panel, so `denext_why_render` answers even when the panel was never opened.
 *
 * @param api The inspector API from `installInspector()`.
 * @returns A disposer that unsubscribes and cancels any pending post.
 */
export function installInspectSink(api: DenextDevtoolsApi): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  api.enableRenderReasons();
  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    post(api);
  };
  const unsubscribe = api.subscribe(() => {
    api.enableRenderReasons(); // re-arm if the panel was opened and closed since
    if (timer !== undefined) return; // a post is already scheduled — coalesce into it
    timer = setTimeout(() => {
      timer = undefined;
      post(api);
    }, THROTTLE_MS);
  });
  const onHide = (): void => flush();
  const target = globalThis as { addEventListener?: typeof addEventListener };
  target.addEventListener?.("pagehide", onHide);
  return () => {
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    (globalThis as { removeEventListener?: typeof removeEventListener })
      .removeEventListener?.("pagehide", onHide);
  };
}
