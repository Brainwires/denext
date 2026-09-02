// A fast, dependency-free denext-correctness checker for a code snippet.
//
// It catches the mistakes an agent trained on Next.js makes when writing denext — the
// wrong import source (`react`, `next/*`), a misplaced `"use client"` directive, or an
// interactive component missing its client boundary — WITHOUT a type-checker or a
// subprocess, so it's instant and works on a fragment. It backs the `denext_check_snippet`
// MCP tool; the deeper, type-level check is `deno check` against the generated types.
//
// Regex-based by design: it reasons about import specifiers and directives, which are
// lexically unambiguous, and stays conservative elsewhere (hints, not errors) so it never
// flags valid denext code.

import { lookupImport } from "./next-denext-map.ts";

/** A single finding from {@link checkSnippet}. */
export interface Diagnostic {
  /** How serious: an `error` is wrong denext, a `warning` likely-wrong, an `info` a hint. */
  readonly severity: "error" | "warning" | "info";
  /** 1-based line the finding anchors to (0 when not line-specific). */
  readonly line: number;
  /** What's wrong and how to fix it. */
  readonly message: string;
  /** A short kebab-case rule id (e.g. `import-source`, `directive-placement`). */
  readonly rule: string;
}

/** Interactive hooks that require a `"use client"` boundary to run in the browser. */
const CLIENT_HOOKS = [
  "useState",
  "useReducer",
  "useEffect",
  "useLayoutEffect",
  "useRef",
  "useContext",
  "useSyncExternalStore",
];

/** The 1-based line number of a character offset in `code`. */
function lineAt(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) {
    if (code[i] === "\n") line++;
  }
  return line;
}

/** Every module specifier imported/re-exported by the snippet, with its line. */
function findSpecifiers(code: string): Array<{ specifier: string; line: number }> {
  const out: Array<{ specifier: string; line: number }> = [];
  // `import ... from "x"`, `export ... from "x"`, side-effect `import "x"`, and `import("x")`.
  const re =
    /(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const specifier = m[1] ?? m[2] ?? m[3];
    if (specifier) out.push({ specifier, line: lineAt(code, m.index) });
  }
  return out;
}

/** Flag each import that should be rewritten to a denext specifier. */
function checkImports(code: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const { specifier, line } of findSpecifiers(code)) {
    const { rule, message } = lookupImport(specifier);
    if (rule) out.push({ severity: "error", line, message, rule: "import-source" });
  }
  return out;
}

/** The first non-blank, non-comment line of `code` — where a directive must sit. */
function firstCodeOffset(code: string): number {
  // Strip line + block comments to find the first real statement offset.
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
  const m = /\S/.exec(stripped);
  return m ? m.index : -1;
}

/** A `"use client"`/`"use server"` directive must be the file's first statement. */
function checkDirective(code: string): Diagnostic | null {
  const m = /["'](use client|use server)["']\s*;?/.exec(code);
  if (!m) return null;
  const first = firstCodeOffset(code);
  if (first >= 0 && first < m.index) {
    return {
      severity: "warning",
      line: lineAt(code, m.index),
      message: `A "${
        m[1]
      }" directive must be the FIRST statement in the file (before imports), or it is ignored.`,
      rule: "directive-placement",
    };
  }
  return null;
}

/** Interactive hooks + event handlers with no client boundary → a hint. */
function checkClientBoundary(code: string): Diagnostic | null {
  if (/["'](use client)["']/.test(code)) return null;
  const usesHook = CLIENT_HOOKS.find((h) => new RegExp(`\\b${h}\\s*\\(`).test(code));
  const hasHandler = /\bon[A-Z]\w+\s*=/.test(code);
  if (usesHook && hasHandler) {
    return {
      severity: "info",
      line: 0,
      message:
        `This looks interactive (uses ${usesHook} + an event handler) but has no "use client" directive. ` +
        `Add "use client"; as the first line so it runs in the browser — a Server Component can't use state or handlers.`,
      rule: "client-boundary",
    };
  }
  return null;
}

/**
 * Check a denext code snippet for the common Next.js→denext mistakes.
 *
 * @param code The source text of a `.ts`/`.tsx` file or fragment.
 * @returns Diagnostics ordered by severity (errors first), then by line.
 */
export function checkSnippet(code: string): Diagnostic[] {
  const out = [...checkImports(code)];
  const directive = checkDirective(code);
  if (directive) out.push(directive);
  const boundary = checkClientBoundary(code);
  if (boundary) out.push(boundary);
  const rank = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.line - b.line);
}
