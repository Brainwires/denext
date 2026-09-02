// Shared helpers for the generated API reference pages (module index + per-symbol detail).
// All server-side, zero client JS.

import reference from "../app/docs/api/reference.json" with { type: "json" };

/** One documented export, as emitted by scripts/gen-api-reference.ts. */
export interface ApiSymbol {
  name: string;
  slug: string;
  kind: string;
  signature: string;
  doc: string;
  docFull: string;
  params: { name: string; doc: string }[];
  returns: string;
  examples: string[];
  denextOnly: boolean;
}
export interface ApiGroup {
  module: string;
  symbols: ApiSymbol[];
}

export const GROUPS = reference.groups as ApiGroup[];

/** A module name → a URL-safe single segment (`denext/server` → `denext-server`). */
export const moduleSlug = (m: string) => m.replace(/\//g, "-");

export const groupForSlug = (seg: string) => GROUPS.find((g) => moduleSlug(g.module) === seg);

/**
 * The kinds, in display order, with their section heading and a stable anchor id. deno doc
 * reports callable `const`s as `variable`; we surface those under "Values".
 */
export const KIND_ORDER: { kind: string; label: string; id: string }[] = [
  { kind: "function", label: "Functions", id: "functions" },
  { kind: "class", label: "Classes", id: "classes" },
  { kind: "interface", label: "Interfaces", id: "interfaces" },
  { kind: "typeAlias", label: "Type aliases", id: "type-aliases" },
  { kind: "enum", label: "Enums", id: "enums" },
  { kind: "variable", label: "Values", id: "values" },
  { kind: "namespace", label: "Namespaces", id: "namespaces" },
];

/** A short human label for one symbol's kind (the `.api-kind` chip). */
export function kindLabel(kind: string): string {
  switch (kind) {
    case "function":
      return "function";
    case "typeAlias":
      return "type";
    case "interface":
      return "interface";
    case "class":
      return "class";
    case "enum":
      return "enum";
    case "variable":
      return "value";
    case "namespace":
      return "namespace";
    default:
      return kind;
  }
}

/** Group a module's (already alphabetically-sorted) symbols by kind, in display order. */
export function byKind(
  symbols: ApiSymbol[],
): { kind: string; label: string; id: string; symbols: ApiSymbol[] }[] {
  const out: { kind: string; label: string; id: string; symbols: ApiSymbol[] }[] = [];
  for (const k of KIND_ORDER) {
    const inKind = symbols.filter((s) => s.kind === k.kind);
    if (inKind.length) out.push({ ...k, symbols: inKind });
  }
  // Any kind we didn't explicitly order (shouldn't happen) lands in a trailing "Other".
  const known = new Set(KIND_ORDER.map((k) => k.kind));
  const rest = symbols.filter((s) => !known.has(s.kind));
  if (rest.length) out.push({ kind: "other", label: "Other", id: "other", symbols: rest });
  return out;
}

/** Resolve a symbol name to its detail-page href (first module that exports it), or null. */
const NAME_INDEX: Map<string, { module: string; slug: string }> = (() => {
  const m = new Map<string, { module: string; slug: string }>();
  for (const g of GROUPS) {
    for (const s of g.symbols) {
      if (!m.has(s.name)) m.set(s.name, { module: g.module, slug: s.slug });
    }
  }
  return m;
})();

export function hrefForName(name: string): string | null {
  const hit = NAME_INDEX.get(name);
  return hit ? `/docs/api/${moduleSlug(hit.module)}/${hit.slug}` : null;
}
