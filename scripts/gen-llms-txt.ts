// Generate `llms.txt` + `llms-full.txt` for the docs site (served at denext.dev/llms.txt).
//
// The llms.txt convention (https://llmstxt.org) gives an LLM a curated, low-noise entry
// point to a project's docs: `llms.txt` is a concise index; `llms-full.txt` is the full
// text an agent can load wholesale. denext's are built from the authoring guide (AGENTS.md)
// + the generated API reference (reference.json) so they never drift from the real surface.
//
//   deno task docs:llms     # regenerate both files
//   deno task docs:build    # docs:api + docs:llms + export the site
//
// Output → apps/web/public/, which the static export copies to the site root.

import { TOOLS } from "../src/mcp/tools.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const OUT_DIR = `${ROOT}apps/web/public`;
const SITE = "https://denext.dev";
const REPO = "https://github.com/Brainwires/denext";

interface RefSymbol {
  name: string;
  kind: string;
  signature: string;
  doc: string;
}
interface RefGroup {
  module: string;
  symbols: RefSymbol[];
}

/** The concise index (`llms.txt`). */
export function llmsIndex(): string {
  return `# denext

> denext is Next.js's App Router, reimplemented for Deno with its own small React. If you
> know Next.js you already know denext — the same file conventions, hooks, and \`app/\`
> router. This file helps AI tools emit correct denext instead of Next.js.

## What differs from Next.js (read first)

- Imports come from \`denext\`, not \`react\` — \`import { useState } from "denext"\`. There is
  **no \`react\`/\`react-dom\` package** (a drop-in aliases them; new code imports \`denext\`).
- **No \`package.json\`/npm** — a \`deno.json\` with URL/\`jsr:\`/\`npm:\` imports; run with
  \`deno task dev|build|start\`.
- Server-only helpers (\`cookies\`, \`headers\`, \`redirect\`, \`revalidatePath\`) come from
  \`denext/server\`; client-only from \`denext/client\`.
- File conventions are **identical to the Next.js App Router** (\`app/page.tsx\`,
  \`app/layout.tsx\`, \`app/api/x/route.ts\`, \`app/blog/[slug]/page.tsx\`, \`middleware.ts\`).
- Route handlers return a web \`Response\`; use \`Request\`/\`fetch\`/\`URL\`/\`Deno.env.get\`.
- Calls to your own API are type-checked: return \`TypedResponse<T>\` from a handler and use
  \`createApiClient<ApiSchema>()\` (types from \`./.denext/api.ts\`).

## Docs

- [Full guide for AI tools](${SITE}/llms-full.txt): the complete rules, import map, common
  tasks, and an API-surface summary — load this to write denext.
- [API reference](${SITE}/docs/api): every public symbol with signatures.
- [Guide (source)](${REPO}/blob/main/AGENTS.md): AGENTS.md in the repo.
- [GitHub](${REPO}): source, examples, and issues.

## Tooling for agents

- **MCP server** — \`deno run -A jsr:@denext/denext/cli mcp\`. Tools (derived from the live
  registry so this never drifts): ${TOOLS.map((t) => `\`${t.name}\``).join(", ")}. It can lint a
  snippet for Next-isms, map imports, scaffold, run doctor/codemod, list an app's routes, read a
  running dev server's errors + console, and render a route/component server-side.
- **Migrate** a Next.js / Remix / Pages-Router app in one pass: \`denext migrate\`.
`;
}

/** A one-line-per-symbol API summary grouped by module. */
function apiSummary(groups: RefGroup[]): string {
  const blocks = groups.map((g) => {
    const lines = g.symbols.map((s) => {
      const doc = s.doc ? ` — ${s.doc.split("\n")[0]}` : "";
      return `- \`${s.signature || s.name}\`${doc}`;
    });
    return `### \`${g.module}\`\n\n${lines.join("\n")}`;
  });
  return blocks.join("\n\n");
}

/** The full text (`llms-full.txt`): the authoring guide + the API summary. */
export async function llmsFull(): Promise<string> {
  const guide = await Deno.readTextFile(`${ROOT}AGENTS.md`);
  let api = "";
  try {
    const ref = JSON.parse(
      await Deno.readTextFile(`${ROOT}apps/web/app/docs/api/reference.json`),
    ) as { groups: RefGroup[] };
    api = `\n\n---\n\n# API reference (summary)\n\nEvery public symbol, grouped by module. ` +
      `Full signatures + docs at ${SITE}/docs/api.\n\n${apiSummary(ref.groups)}\n`;
  } catch {
    // No reference.json yet (run `deno task docs:api` first) — ship the guide alone.
  }
  return `# denext — full guide for AI tools\n\n` +
    `> Generated from AGENTS.md + the API reference. The concise index is at ${SITE}/llms.txt.\n\n` +
    guide + api;
}

if (import.meta.main) {
  await Deno.mkdir(OUT_DIR, { recursive: true });
  await Deno.writeTextFile(`${OUT_DIR}/llms.txt`, llmsIndex());
  await Deno.writeTextFile(`${OUT_DIR}/llms-full.txt`, await llmsFull());
  console.log(`Wrote ${OUT_DIR}/llms.txt and llms-full.txt`);
}
