/**
 * The scenario catalogue: which list implementations exist in which app, which (kind, n) cells
 * each runs, the deep links that drive both apps, and the logcat markers they print. Shared by
 * the web app, the React Native app and the adb harness, so all three agree.
 *
 * Plain TypeScript: no React, no platform imports.
 */

import type { Kind } from "./data.ts";

export type AppId = "denext" | "rn";

export const KINDS: readonly Kind[] = ["fixed", "chat", "images", "sections"];

export const SIZES: readonly number[] = [
  1_000,
  10_000,
  100_000,
  1_000_000,
  10_000_000,
];

/** The largest `n` per kind (10M only for `fixed`). */
export const MAX_N: Record<Kind, number> = {
  fixed: 10_000_000,
  chat: 1_000_000,
  images: 1_000_000,
  sections: 1_000_000,
};

/** Where a list starts: chat opens at its newest message (the bottom), the rest at the top. */
export const ANCHOR: Record<Kind, "start" | "end"> = {
  fixed: "start",
  chat: "end",
  images: "start",
  sections: "start",
};

export interface ImplDef {
  app: AppId;
  id: string;
  label: string;
  /** Largest `n` the impl is run at (above it the cell is recorded as skipped). */
  maxN?: number;
  /** Only these kinds (default: all). */
  kinds?: readonly Kind[];
  /** Placeholder: renders "not yet implemented" and reports skipped. */
  placeholder?: boolean;
  /** How the impl consumes the data. */
  data: "all-dom" | "count" | "index-array" | "sections";
}

export const IMPLS: readonly ImplDef[] = [
  // denext (web, in the Capacitor WebView)
  {
    app: "denext",
    id: "dom",
    label: "plain DOM",
    maxN: 10_000,
    data: "all-dom",
  },
  {
    app: "denext",
    id: "cv",
    label: "DOM + content-visibility",
    maxN: 100_000,
    data: "all-dom",
  },
  {
    app: "denext",
    id: "legend",
    label: "@legendapp/list (web)",
    data: "index-array",
  },
  {
    app: "denext",
    id: "tanstack",
    label: "@tanstack/react-virtual",
    data: "count",
  },
  { app: "denext", id: "virtua", label: "virtua", data: "index-array" },
  {
    app: "denext",
    id: "rnw-flatlist",
    label: "react-native-web FlatList",
    data: "index-array",
  },
  {
    app: "denext",
    id: "denext",
    label: "denext VirtualList (Phase 2)",
    placeholder: true,
    data: "count",
  },
  // React Native (native Android views)
  { app: "rn", id: "flatlist", label: "FlatList", data: "index-array" },
  {
    app: "rn",
    id: "flash",
    label: "@shopify/flash-list v2",
    data: "index-array",
  },
  { app: "rn", id: "legend", label: "@legendapp/list", data: "index-array" },
  {
    app: "rn",
    id: "sectionlist",
    label: "SectionList",
    kinds: ["sections"],
    data: "sections",
  },
];

export const findImpl = (app: AppId, id: string): ImplDef | undefined =>
  IMPLS.find((d) => d.app === app && d.id === id);

export type CellPlan = { run: true } | { run: false; reason: string };

/** Whether a (app, impl, kind, n) cell runs, or why it is skipped. */
export function cellPlan(
  app: AppId,
  impl: string,
  kind: Kind,
  n: number,
): CellPlan {
  const def = findImpl(app, impl);
  if (!def) return { run: false, reason: `unknown impl ${app}/${impl}` };
  if (def.placeholder) return { run: false, reason: "not yet implemented" };
  if (def.kinds && !def.kinds.includes(kind)) {
    return { run: false, reason: `${impl} runs only ${def.kinds.join(", ")}` };
  }
  if (n > MAX_N[kind]) {
    return { run: false, reason: `${kind} is capped at ${MAX_N[kind]}` };
  }
  if (def.maxN !== undefined && n > def.maxN) {
    return { run: false, reason: `${impl} is capped at n=${def.maxN}` };
  }
  return { run: true };
}

// ─── deep links ──────────────────────────────────────────────────────────────────────────

export const SCHEMES: Record<AppId, string> = {
  denext: "denextscrollbench",
  rn: "rnscrollbench",
};

export const PACKAGES: Record<AppId, string> = {
  denext: "com.brainwires.denext.scrollbench",
  rn: "com.brainwires.rnscrollbench",
};

export interface RunParams {
  list: string;
  kind: Kind;
  n: number;
  seed: number;
}

export type ActionOp =
  | "append"
  | "prepend"
  | "scrollToIndex"
  | "scrollToEnd"
  | "scrollToStart"
  | "fps";

export interface ActionParams {
  op: ActionOp;
  /** Items to append/prepend. */
  k?: number;
  /** Target position for scrollToIndex. */
  i?: number;
  /** fps: turn the meter on (true) or off. */
  on?: boolean;
}

export type BenchLink =
  | { type: "run"; params: RunParams }
  | { type: "action"; params: ActionParams };

const OPS: readonly ActionOp[] = [
  "append",
  "prepend",
  "scrollToIndex",
  "scrollToEnd",
  "scrollToStart",
  "fps",
];

/** A query string (`a=1&b=2`, leading `?` optional) as a map. Not URLSearchParams: React
 * Native's polyfill of it does not implement `get()` on every version. */
function parseQuery(query: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of query.replace(/^\?/, "").split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = eq < 0 ? part : part.slice(0, eq);
    const v = eq < 0 ? "" : part.slice(eq + 1);
    const dec = (x: string) => {
      try {
        return decodeURIComponent(x.replaceAll("+", " "));
      } catch {
        return x;
      }
    };
    out.set(dec(k), dec(v));
  }
  return out;
}

type Query = Map<string, string>;

const intParam = (q: Query, k: string): number | undefined => {
  const v = q.get(k);
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v.replaceAll("_", ""));
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

/** Run parameters from a query string (`?list=…&kind=…&n=…[&seed=…]`), or null. */
export function parseRunParams(query: string | Query): RunParams | null {
  const q = typeof query === "string" ? parseQuery(query) : query;
  const list = q.get("list");
  const kind = (q.get("kind") ?? null) as Kind | null;
  const n = intParam(q, "n");
  if (!list || !kind || !KINDS.includes(kind) || n === undefined || n < 0) {
    return null;
  }
  return { list, kind, n, seed: intParam(q, "seed") ?? 1 };
}

/** Action parameters from a query string (`?op=append&k=50`), or null. */
function parseActionParams(query: string | Query): ActionParams | null {
  const q = typeof query === "string" ? parseQuery(query) : query;
  const op = (q.get("op") ?? null) as ActionOp | null;
  if (!op || !OPS.includes(op)) return null;
  const on = q.get("on") ?? null;
  return {
    op,
    k: intParam(q, "k"),
    i: intParam(q, "i"),
    on: on === null ? undefined : on === "1" || on === "true",
  };
}

/**
 * Parse `<scheme>://run?…` or `<scheme>://action?…` (either app's scheme). Hand-parsed, not
 * `new URL`: React Native's URL polyfill does not parse custom-scheme hosts.
 */
export function parseLink(url: string): BenchLink | null {
  const m = url.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)\/?(?:\?([^#]*))?/i);
  if (!m) return null;
  const q = parseQuery(m[3] ?? "");
  if (m[2] === "run") {
    const params = parseRunParams(q);
    return params ? { type: "run", params } : null;
  }
  if (m[2] === "action") {
    const params = parseActionParams(q);
    return params ? { type: "action", params } : null;
  }
  return null;
}

export function runQuery(p: RunParams): string {
  return `list=${encodeURIComponent(p.list)}&kind=${p.kind}&n=${p.n}&seed=${p.seed}`;
}

export const runLink = (app: AppId, p: RunParams): string => `${SCHEMES[app]}://run?${runQuery(p)}`;

export function actionLink(app: AppId, a: ActionParams): string {
  const q: string[] = [`op=${a.op}`];
  if (a.k !== undefined) q.push(`k=${a.k}`);
  if (a.i !== undefined) q.push(`i=${a.i}`);
  if (a.on !== undefined) q.push(`on=${a.on ? 1 : 0}`);
  return `${SCHEMES[app]}://action?${q.join("&")}`;
}

// ─── logcat markers ──────────────────────────────────────────────────────────────────────

/**
 * Both apps print one line per event with `console.log(`${MARKER} ${JSON}`)`. In the Capacitor
 * app it reaches logcat through the `Capacitor/Console` tag (capacitor.config.json sets
 * `loggingBehavior: "production"`), in the RN app through `ReactNativeJS`.
 */
export const MARKER = {
  ready: "SCROLLBENCH_READY",
  skipped: "SCROLLBENCH_SKIPPED",
  action: "SCROLLBENCH_ACTION",
  error: "SCROLLBENCH_ERROR",
} as const;

export interface ReadyInfo {
  app: AppId;
  list: string;
  kind: Kind;
  n: number;
  /** ms from process/page start to the first painted frame with content. */
  ms: number;
  /** Rows mounted at ready (DOM nodes / native cells). */
  mounted?: number;
  /** How the impl got its data (see {@link ImplDef.data}). */
  data?: string;
  /** Anything notable (e.g. "no sticky headers"). */
  notes?: string[];
}

export interface ActionInfo {
  op: ActionOp;
  ok: boolean;
  ms: number;
  count?: number;
  reason?: string;
}

/** Parse one marker line out of a logcat line; null when it holds none. */
export function parseMarkerLine(
  line: string,
): { marker: keyof typeof MARKER; data: Record<string, unknown> } | null {
  for (
    const [key, tag] of Object.entries(MARKER) as [
      keyof typeof MARKER,
      string,
    ][]
  ) {
    const at = line.indexOf(tag + " ");
    if (at < 0) continue;
    const rest = line.slice(at + tag.length + 1);
    const start = rest.indexOf("{");
    const end = rest.lastIndexOf("}");
    if (start < 0 || end < start) return { marker: key, data: {} };
    try {
      return { marker: key, data: JSON.parse(rest.slice(start, end + 1)) };
    } catch {
      return { marker: key, data: { raw: rest.trim() } };
    }
  }
  return null;
}
