// The web impls by id, each loaded on demand so a cell only parses its own library.

import { lazy } from "denext";
import type { Component } from "denext";
import type { ImplProps } from "./types.ts";

type Loader = () => Promise<{ default: (p: ImplProps) => unknown }>;

const LOADERS: Record<string, Loader> = {
  dom: () => import("./dom.tsx"),
  cv: () => import("./cv.tsx"),
  legend: () => import("./legend.tsx"),
  tanstack: () => import("./tanstack.tsx"),
  virtua: () => import("./virtua.tsx"),
  "rnw-flatlist-denext": () => import("./rnw-flatlist.tsx"),
  "rnw-flatlist-rnw": () => import("./rnw-flatlist-rnw.tsx"),
  denext: () => import("./placeholder.tsx"),
};

const cache = new Map<string, Component<ImplProps>>();

/** The lazy component for impl `id` (render it under a Suspense boundary). */
export function implComponent(id: string): Component<ImplProps> | null {
  const load = LOADERS[id];
  if (!load) return null;
  let c = cache.get(id);
  if (!c) {
    c = lazy<ImplProps>(
      load as () => Promise<{ default: Component<ImplProps> }>,
    );
    cache.set(id, c);
  }
  return c;
}

/** What an impl could not do, or does differently, per kind (`kind` absent = every kind). */
const NOTES: readonly { impl: string; kind?: string; note: string }[] = [
  { impl: "virtua", kind: "sections", note: "no sticky headers (virtua has none)" },
  {
    impl: "dom",
    kind: "chat",
    note: "prepend relies on browser scroll anchoring (overflow-anchor)",
  },
  {
    impl: "cv",
    kind: "chat",
    note: "prepend relies on browser scroll anchoring (overflow-anchor)",
  },
  { impl: "tanstack", kind: "chat", note: "prepend re-anchored by the handle" },
];

/** Notes the ready marker carries for an impl/kind. */
export function implNotes(id: string, kind: string): string[] {
  return NOTES.filter((n) => n.impl === id && (n.kind ?? kind) === kind).map((n) => n.note);
}
