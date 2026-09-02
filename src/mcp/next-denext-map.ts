// The canonical Next.js/React → denext import mapping, as data.
//
// This is the machine-readable form of the "Next.js → denext import map" table in
// AGENTS.md — the single source of truth shared by the snippet checker
// (`src/mcp/check.ts`), the `denext_import_map` MCP tool, and the llms.txt generator
// (`scripts/gen-llms-txt.ts`). Keep it in sync with AGENTS.md when the surface changes.

/** One import-rewrite rule: a Next.js/React specifier and its denext replacement. */
export interface ImportRule {
  /** The Next.js / React module specifier as written in a Next app. */
  readonly from: string;
  /** The denext specifier new code should import from instead. */
  readonly to: string;
  /** Named exports this rule specifically covers (empty = the whole module / default). */
  readonly names?: readonly string[];
  /** Short note on the mapping (server vs client nuance, etc.). */
  readonly note?: string;
}

/**
 * The import rules, most-specific specifier first so a prefix match (e.g.
 * `next/navigation`) is tried before a broad one (`next`).
 */
export const IMPORT_RULES: readonly ImportRule[] = [
  {
    from: "react",
    to: "denext",
    note:
      "Hooks and core APIs come from denext. There is no `react` package (a drop-in aliases it).",
  },
  {
    from: "react-dom",
    to: "denext/client",
    note: "Client rendering (createRoot/hydrateRoot) is in denext/client.",
  },
  {
    from: "react-dom/client",
    to: "denext/client",
  },
  {
    from: "next/headers",
    to: "denext/server",
    names: ["cookies", "headers", "draftMode"],
  },
  {
    from: "next/navigation",
    to: "denext/server",
    names: ["redirect", "permanentRedirect", "notFound", "forbidden", "unauthorized"],
    note:
      "Server helpers come from denext/server. On the client, `redirect` is from denext (or useRouter().push) and `notFound` from denext/client.",
  },
  {
    from: "next/link",
    to: "denext",
    names: ["default"],
    note: '`import { Link } from "denext"` (or denext/client). It is a named export, not default.',
  },
  {
    from: "next/image",
    to: "denext",
    names: ["default"],
    note: '`import { Image } from "denext"` — a named export.',
  },
  {
    from: "next/script",
    to: "denext",
    names: ["default"],
  },
  {
    from: "next/font/google",
    to: "denext",
    names: ["Inter", "default"],
    note: "Use `googleFont` from denext (or the `next/font/google` compat alias in a drop-in).",
  },
  {
    from: "next/cache",
    to: "denext/server",
    names: ["unstable_cache", "revalidatePath", "revalidateTag"],
  },
  {
    from: "next/server",
    to: "denext/server",
    names: ["NextRequest", "NextResponse", "userAgent"],
  },
  {
    from: "next",
    to: "denext",
    note:
      "There is no `next` package. Map the specific import per this table; most land on denext or denext/server.",
  },
];

/** The result of resolving a specifier: the matched rule (if any) and a message. */
export interface ImportLookup {
  /** The queried specifier. */
  readonly specifier: string;
  /** The matched rule, or null when the specifier is already denext / unknown. */
  readonly rule: ImportRule | null;
  /** A human-readable explanation (the mapping, or that it's already fine). */
  readonly message: string;
}

/**
 * Resolve a Next.js/React import specifier to its denext equivalent.
 *
 * @param specifier The module specifier as written in a Next app (e.g. `"next/navigation"`).
 * @returns The matched rule and an explanatory message; `rule` is null when the specifier
 *   is already a denext specifier or isn't part of the mapping.
 */
export function lookupImport(specifier: string): ImportLookup {
  const spec = specifier.trim();
  if (spec === "denext" || spec.startsWith("denext/")) {
    return { specifier: spec, rule: null, message: `"${spec}" is already a denext import.` };
  }
  const rule = IMPORT_RULES.find((r) => r.from === spec) ??
    IMPORT_RULES.find((r) => spec === r.from || spec.startsWith(`${r.from}/`));
  if (!rule) {
    return {
      specifier: spec,
      rule: null,
      message:
        `"${spec}" has no denext mapping — it's not a Next.js/React core import, so leave it as-is.`,
    };
  }
  const note = rule.note ? ` ${rule.note}` : "";
  return {
    specifier: spec,
    rule,
    message: `Import from "${rule.to}" instead of "${spec}".${note}`,
  };
}
