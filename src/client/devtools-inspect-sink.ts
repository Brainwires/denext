// DevTools → MCP bridge, page side: push the inspector's component tree to the dev server.
//
// An MCP client (an agent) cannot reach into the browser, and denext deliberately has no
// pull channel from the dev server into the page. So the page PUSHES: after every commit
// (trailing-throttled) the sink serializes the inspector tree, strips it down to what is
// safe and useful out-of-process, and POSTs it to `/_denext/dev-inspect`, where the dev
// server keeps the latest snapshot per page URL for `denext_component_tree`,
// `denext_why_render` and `denext_hook_state` to read.
//
// Four properties this module must keep:
//   * **Silent.** Every failure path is swallowed — a dev-server that is gone, a body the
//     server refuses, a serialization error. The app must never notice the sink exists.
//   * **Bounded.** Depth, node count and body BYTES are capped here, on the producing
//     side, so a pathological tree can neither wedge the page nor flood the dev server
//     (which caps again, independently — this is browser-supplied data).
//   * **Idle until asked.** Walking the fiber tree on every commit costs real time
//     (~20 % of a commit at 500 components), and on most dev pages nobody is reading. So
//     the sink ARMS lazily: until the dev server says an MCP read has happened it does no
//     walk at all, only a cheap `?probe=1` GET at most every 10 s (see
//     {@link installInspectSink}).
//   * **Redacted.** A snapshot leaves the page and is retained out-of-process, so string
//     CONTENTS never go with it — a `useState(password)` becomes `string(8)`, not the
//     password (see {@link SnapshotValue}).
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

/**
 * How often an UNARMED page re-asks the dev server whether anyone is reading. A commit
 * inside this window costs nothing at all (no fetch, and above all no fiber walk).
 */
const PROBE_INTERVAL_MS = 10_000;

/** How deep the posted tree goes before it is cut off. */
const MAX_DEPTH = 50;

/** How many component nodes the posted tree may carry. */
const MAX_NODES = 2000;

/** The posted body's UTF-8 byte budget (the dev server refuses anything larger with a 413). */
const MAX_BYTES = 256 * 1024;

/**
 * The `pagehide` flush's byte budget. A browser REFUSES a `keepalive` fetch (and a
 * `sendBeacon`) whose body is over 64 KiB — and refuses it unobservably, as a rejected
 * promise the sink must swallow. So the final flush only goes out when it fits; a larger
 * tree is left to the last throttled post, which had no such limit.
 */
const MAX_KEEPALIVE_BYTES = 60 * 1024;

/** Longest page URL recorded with a snapshot. */
const MAX_URL = 2048;

/** Every cap here counts UTF-8 bytes, so the page and the dev server agree on "too big". */
const ENCODER = new TextEncoder();

/** The POST headers; the dev server matches the media type exactly. */
const JSON_HEADERS = { "content-type": "application/json" };

/**
 * A serialized value as a SNAPSHOT carries it — an {@link SerializedValue} with two
 * things removed:
 *
 *   * `raw` (the panel's live-edit seed), and
 *   * for a string, the value ITSELF. A snapshot leaves the page, is retained by the dev
 *     server and is read by any MCP client, so a string's contents are replaced by its
 *     length: `preview` reads `string(8)` and {@link SnapshotValue.length} carries 8. A
 *     password, token or draft typed into a dev page therefore never leaves it. Numbers,
 *     booleans and null keep their previews (they are the useful, non-secret cases), and
 *     objects/arrays keep their SHAPE summary (`{name, email}`, `Array(3)`).
 */
export interface SnapshotValue {
  /** A short human preview — `42`, `string(8)`, `{a, b}`, `Array(3)`, `ƒ onClick`. */
  preview: string;
  /** The value's coarse type tag, as the inspector reported it. */
  type: SerializedValue["type"];
  /** For an object/array: its number of enumerable entries. */
  size?: number;
  /** For a string: how many characters the redacted value had. */
  length?: number;
  /** One level of child entries, each itself redacted. */
  entries?: Array<{ key: string; value: SnapshotValue }>;
}

/** A hook cell as a snapshot carries it — its values redacted (see {@link SnapshotValue}). */
export interface SnapshotHook extends Omit<InspectHook, "value" | "deps"> {
  /** The cell's current value, redacted. */
  value: SnapshotValue;
  /** Its dependency array, redacted, when it has one. */
  deps?: SnapshotValue[];
}

/** A context read as a snapshot carries it — its value redacted. */
export interface SnapshotContext {
  /** The context's symbol description, or `Context`. */
  name: string;
  /** The value visible to this component, redacted. */
  value: SnapshotValue;
}

/**
 * One component in a posted snapshot: an {@link InspectNode} with the live-edit
 * affordances removed — no `propEntries` (the panel's per-prop override rows), no raw or
 * string values, and no host/text/fragment nodes (their component descendants are
 * re-parented onto the nearest component ancestor, so the tree reads as a component tree).
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
  /** A shallow, redacted preview of the component's props. */
  props: SnapshotValue;
  /** Its hook cells, in call order, named when the dev metadata resolved. */
  hooks: SnapshotHook[];
  /** The contexts it read on its last render. */
  contexts: SnapshotContext[];
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

/** `s`'s length in UTF-8 BYTES — what every cap here (and the dev server's) counts. */
function utf8Len(s: string): number {
  return ENCODER.encode(s).length;
}

/**
 * How long the string behind a `"string"` preview was. The inspector keeps the value in
 * `raw`; when it is already gone, the escaped preview's length (minus its quotes) is the
 * closest honest estimate.
 */
function stringLength(v: SerializedValue): number {
  if (typeof v.raw === "string") return v.raw.length;
  return Math.max(0, v.preview.length - 2);
}

/**
 * A serialized value as the snapshot carries it: no `raw`, and no string CONTENTS.
 *
 * @param v The inspector's serialized value.
 * @returns The redacted value (see {@link SnapshotValue}).
 */
function redactValue(v: SerializedValue): SnapshotValue {
  const { raw: _raw, entries, preview, type, size } = v;
  if (type === "string") {
    const length = stringLength(v);
    return { preview: `string(${length})`, type, length };
  }
  const out: SnapshotValue = { preview, type };
  if (size !== undefined) out.size = size;
  if (entries) {
    out.entries = entries.map((e) => ({ key: e.key, value: redactValue(e.value) }));
  }
  return out;
}

/** A hook cell with every value redacted. */
function redactHook(h: InspectHook): SnapshotHook {
  return {
    ...h,
    value: redactValue(h.value),
    ...(h.deps ? { deps: h.deps.map(redactValue) } : {}),
  };
}

/** A context read with its value redacted. */
function redactContext(c: InspectContext): SnapshotContext {
  return { name: c.name, value: redactValue(c.value) };
}

/** Roughly how many UTF-8 bytes this node (without its children) costs in the body. */
function costOf(node: InspectSnapshotNode): number {
  try {
    return utf8Len(JSON.stringify(node)) + 2;
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
    props: redactValue(node.props),
    hooks: node.hooks.map(redactHook),
    contexts: node.contexts.map(redactContext),
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
 * Build the snapshot to post: the inspector's component tree, redacted and cut to the
 * depth/node/byte caps.
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

/**
 * The snapshot as a body that FITS. The walk budgets bytes as it goes, so this normally
 * serializes once; if the encoded body is still over the cap (a pathological tree whose
 * container overhead outran the per-node estimate) root nodes are dropped until it fits
 * and `truncated` says so — the body is never silently abandoned for being large.
 *
 * @param api The inspector API.
 * @returns The JSON body, or null when even an empty snapshot would not fit.
 */
function serialize(api: DenextDevtoolsApi): string | null {
  const snapshot = buildSnapshot(api);
  let body = JSON.stringify(snapshot);
  while (utf8Len(body) > MAX_BYTES && snapshot.nodes.length > 0) {
    snapshot.nodes.pop();
    snapshot.truncated = true;
    body = JSON.stringify(snapshot);
  }
  return utf8Len(body) > MAX_BYTES ? null : body;
}

/** Fire-and-forget POST of an already-serialized body; every failure is swallowed. */
function send(body: string, keepalive: boolean): void {
  void fetch(DEV_INSPECT_PATH, { method: "POST", headers: JSON_HEADERS, body, keepalive })
    .then((res) => res.body?.cancel())
    .catch(() => {});
}

/**
 * The `pagehide` flush: the page is going away, so the request has to outlive it — a
 * `sendBeacon` where the browser has one, else a `keepalive` fetch. BOTH refuse a body
 * over 64 KiB, so anything larger is skipped and the last throttled post stands.
 */
function sendFinal(body: string): void {
  if (utf8Len(body) > MAX_KEEPALIVE_BYTES) return;
  const nav = (globalThis as {
    navigator?: { sendBeacon?: (url: string, data: Blob) => boolean };
  }).navigator;
  try {
    if (nav?.sendBeacon?.(DEV_INSPECT_PATH, new Blob([body], { type: "application/json" }))) {
      return;
    }
  } catch {
    // No Blob, or a beacon that refused — fall through to the keepalive fetch.
  }
  send(body, true);
}

/**
 * POST the snapshot; every failure is swallowed (the app must never see the sink).
 *
 * @param api The inspector API.
 * @param final Whether this is the `pagehide` flush (keepalive + its 64 KiB ceiling).
 */
function post(api: DenextDevtoolsApi, final = false): void {
  try {
    const body = serialize(api);
    if (body === null) return;
    if (final) sendFinal(body);
    else send(body, false); // NOT keepalive: a >64 KiB keepalive body is rejected outright
  } catch {
    // No fetch, no location, an unserializable tree — nothing to do about it here.
  }
}

/**
 * Ask the dev server whether anything has read a snapshot yet. Cheap by construction: no
 * fiber walk, a bodyless GET, and the answer is a single boolean.
 *
 * @returns Whether the dev server is armed (an MCP read has happened, or
 * `DENEXT_DEV_INSPECT=1` armed it at startup).
 */
async function probeArmed(): Promise<boolean> {
  try {
    const res = await fetch(`${DEV_INSPECT_PATH}?probe=1`);
    if (!res.ok) {
      await res.body?.cancel();
      return false;
    }
    const data = await res.json() as { armed?: unknown };
    return data?.armed === true;
  } catch {
    return false; // no dev server, or one that does not know the endpoint
  }
}

/**
 * Start pushing inspector snapshots to the dev server.
 *
 * **Lazy arming.** Nothing is walked until someone is reading. At install (and then on a
 * commit, at most every 10 s) the page asks the dev server `?probe=1`; while the answer is
 * `false` a commit costs nothing. The dev server answers `true` from the first MCP read
 * onwards — so the FIRST `denext_component_tree` on a page may legitimately answer "the
 * DevTools sink has posted nothing yet", and the next call (after the page's next commit)
 * has the tree. Export `DENEXT_DEV_INSPECT=1` before `deno task dev` to arm it from the
 * start. Once armed, commits are posted with a trailing 1.5 s throttle (a burst posts
 * once) plus a final flush on `pagehide`.
 *
 * Render-reason tracking is switched on here, not by the panel, so `denext_why_render`
 * answers even when the panel was never opened — as ONE hold on the refcounted
 * `enableRenderReasons`, taken when the sink arms and released by the disposer, so opening
 * and closing the panel can never wipe the history the sink is accruing.
 *
 * @param api The inspector API from `installInspector()`.
 * @returns A disposer that unsubscribes, releases the render-reason hold and cancels any
 * pending post.
 */
export function installInspectSink(api: DenextDevtoolsApi): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armed = false;
  let disposed = false;
  let probedAt = Date.now();
  const arm = (ok: boolean): void => {
    if (!ok || armed || disposed) return;
    armed = true;
    api.enableRenderReasons();
    post(api); // the reader is waiting — don't make it wait for the next commit too
  };
  const probe = (): void => {
    probedAt = Date.now();
    void probeArmed().then(arm);
  };
  probe();
  const unsubscribe = api.subscribe(() => {
    if (!armed) {
      if (Date.now() - probedAt >= PROBE_INTERVAL_MS) probe();
      return; // nobody is reading: no walk, no serialization, no post
    }
    if (timer !== undefined) return; // a post is already scheduled — coalesce into it
    timer = setTimeout(() => {
      timer = undefined;
      post(api);
    }, THROTTLE_MS);
  });
  const onHide = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (armed) post(api, true);
  };
  const target = globalThis as { addEventListener?: typeof addEventListener };
  target.addEventListener?.("pagehide", onHide);
  return () => {
    disposed = true;
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (armed) {
      armed = false;
      api.disableRenderReasons(); // release this sink's hold (the panel may still hold one)
    }
    (globalThis as { removeEventListener?: typeof removeEventListener })
      .removeEventListener?.("pagehide", onHide);
  };
}
