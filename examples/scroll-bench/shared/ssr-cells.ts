/**
 * The server-rendered list benchmark's catalogue: the impls of the `ssr/` App Router app, the
 * kinds and sizes they run at, the route of a cell and its query parser. Shared by the app
 * (ssr/app/list/<impl>/page.tsx) and the Chromium harness (harness/ssr-measure.ts).
 *
 * Plain TypeScript: no React, no platform imports.
 */

import type { ChatBlock, ChatItem, Item, Kind, Span } from "./data.ts";
import { KINDS } from "./scenarios.ts";

/** How an impl makes each row's control interactive (or `none`: no control). */
export type Interactivity =
  | "none"
  | "islands"
  | "resumable"
  | "delegated"
  | "script"
  | "virtual";

/**
 * The impl's family, also a `--impls` alias of the harness: `static` pages carry no client
 * component, `islands` pages carry Flight + island payloads for their rows' controls, and
 * `virtual` lists are a VirtualList.
 */
export type SsrGroup = "static" | "islands" | "virtual";

export interface SsrImplDef {
  id: string;
  label: string;
  group: SsrGroup;
  interactivity: Interactivity;
  /** The list is a `VirtualList` (only its first window is server-rendered). */
  virtual: boolean;
  /** Where the list sits: at the top of the page, or below a tall intro (`client:visible`). */
  belowFold?: boolean;
  /** Not an ssr/ route: measured from the SPA export (web/out), as a reference. */
  spa?: boolean;
}

export const SSR_IMPLS: readonly SsrImplDef[] = [
  {
    id: "static",
    label: "all rows as HTML",
    group: "static",
    interactivity: "none",
    virtual: false,
  },
  {
    id: "static-cv",
    group: "static",
    label: "all rows as HTML + content-visibility",
    interactivity: "none",
    virtual: false,
  },
  {
    id: "static-cv-islands",
    group: "islands",
    label: "static-cv + one client:load island per row",
    interactivity: "islands",
    virtual: false,
  },
  {
    id: "static-cv-resumable",
    group: "islands",
    label: "static-cv + one resumable island per row (resumable route)",
    interactivity: "resumable",
    virtual: false,
  },
  {
    id: "static-cv-delegated",
    group: "islands",
    label: "static-cv + one delegated click island for the whole list",
    interactivity: "delegated",
    virtual: false,
  },
  {
    id: "static-cv-script",
    group: "static",
    label: "static-cv + the same delegated handler as a plain public/ script (no island)",
    interactivity: "script",
    virtual: false,
  },
  {
    id: "virtual-island",
    group: "virtual",
    label: "VirtualList, SSR first window, one client:load island",
    interactivity: "virtual",
    virtual: true,
  },
  {
    id: "virtual-island-visible",
    group: "virtual",
    label: "VirtualList below the fold, one client:visible island",
    interactivity: "virtual",
    virtual: true,
    belowFold: true,
  },
  {
    id: "virtual-island-find",
    group: "virtual",
    label: "virtual-island + findInPage",
    interactivity: "virtual",
    virtual: true,
  },
  {
    id: "virtual-spa",
    group: "virtual",
    label: "the SPA's denext VirtualList impl (web/out), reference",
    interactivity: "none",
    virtual: true,
    spa: true,
  },
];

/** The kinds run here (`sections` is the SPA's sticky-header case; not a static-list one). */
export const SSR_KINDS: readonly Kind[] = ["fixed", "chat", "images"];

export const SSR_SIZES: readonly number[] = [
  100,
  500,
  1_000,
  2_000,
  5_000,
  10_000,
  50_000,
  100_000,
];

/** The largest `n` a route accepts (a bench, not a public endpoint: keep one request bounded). */
export const SSR_MAX_N = 1_000_000;

export interface SsrQuery {
  kind: Kind;
  n: number;
  seed: number;
}

/** An integer query value, else `fallback`. */
function intParam(v: string | null, fallback: number): number {
  const x = Math.floor(Number(v ?? fallback));
  return Number.isFinite(x) ? x : fallback;
}

/** `?kind=…&n=…&seed=…` → a cell (defaults: fixed, 1000 rows, seed 1; n clamped). */
export function parseSsrQuery(q: URLSearchParams): SsrQuery {
  const kind = q.get("kind") as Kind;
  return {
    kind: KINDS.includes(kind) ? kind : "fixed",
    n: Math.max(1, Math.min(SSR_MAX_N, intParam(q.get("n"), 1000))),
    seed: intParam(q.get("seed"), 1),
  };
}

/** The path + query of a cell (`/list/<impl>?kind=…&n=…&seed=1`; the SPA's own query shape). */
export function ssrCellPath(impl: string, kind: Kind, n: number, seed = 1): string {
  if (impl === "virtual-spa") return `/?list=denext&kind=${kind}&n=${n}&seed=${seed}`;
  return `/list/${impl}?kind=${kind}&n=${n}&seed=${seed}`;
}

/** `--impls` values → impl ids: a group name (`static`, `islands`, `virtual`) is its members. */
export function expandImpls(ids: readonly string[]): string[] {
  return ids.flatMap((id) => {
    const members = SSR_IMPLS.filter((d) => d.group === id).map((d) => d.id);
    return members.length ? members : [id];
  });
}

export const findSsrImpl = (id: string): SsrImplDef | undefined =>
  SSR_IMPLS.find((d) => d.id === id);

type PerType = { [K in Item["type"]]: (item: Extract<Item, { type: K }>) => string };
const byType = (table: PerType) => (item: Item): string =>
  (table[item.type] as (i: Item) => string)(item);

const words = (s: string) => s.trim().split(/\s+/).slice(0, 6).join(" ");
/** A plain span carries only `text` (no bold / href / code flag). */
const isPlain = (s: Span) => Object.keys(s).length === 1 && s.text.trim() !== "";
const firstPlainText = (item: ChatItem) =>
  item.blocks.flatMap((b) => (b.type === "p" ? b.spans : [])).find(isPlain)?.text ?? "";

/**
 * A short phrase of an item's own text, for the find-in-page probe: the subtitle of a row, the
 * first words of a chat message's first plain run of text, an image's caption. Words only (no
 * markup boundaries), so `window.find` matches it inside one text node.
 */
export const probeText: (item: Item) => string = byType({
  row: (i) => words(i.subtitle),
  header: (i) => i.title,
  image: (i) => words(i.caption),
  chat: (i) => words(firstPlainText(i)),
});

const blockText = (b: ChatBlock) =>
  b.type === "p" ? b.spans.map((s) => s.text).join("") : b.lines.join("\n");

/** An item's whole text (what `VirtualList`'s `findInPage` stubs carry). */
export const itemText: (item: Item) => string = byType({
  row: (i) => `${i.title} ${i.subtitle} ${i.time}`,
  header: (i) => i.title,
  image: (i) => i.caption,
  chat: (i) => i.blocks.map(blockText).join("\n"),
});
