// Where a repo-root Markdown file is published on the docs site.
//
// Several root guides are rendered verbatim by a docs route (single source of truth — no
// duplicated copy). Their relative links (`./AGENTS.md`, `./src/lint/denext-plugin.ts`) are
// written for GitHub, so the renderer rewrites them: a file that HAS a docs route becomes that
// route (an example's directory or README its `/docs/examples/<name>` page), everything else
// becomes a GitHub blob/tree URL. See `rewriteDocLinks` in `markdown.ts`.

import examplesIndex from "../app/docs/examples/examples.json" with { type: "json" };

/** Repo-relative Markdown path → the docs-site route that renders it. */
export const DOC_URLS: Readonly<Record<string, string>> = {
  "CONTRIBUTING.md": "/docs/contributing",
  "CHANGELOG.md": "/docs/changelog",
  "DEPLOYMENT.md": "/docs/deploy",
  "DATABASE.md": "/docs/database",
  "PLUGINS.md": "/docs/plugins",
  "ARCHITECTURE.md": "/docs/architecture",
  "CVE-DEFENSE-GUIDE.md": "/docs/security",
  "KNOWN-LIMITATIONS.md": "/docs/limitations",
  "KNOWN-DIFFERENCES.md": "/docs/differences",
  "FEATURES.md": "/docs/features",
  "POLICIES.md": "/docs/policies",
  "README-NEXT-MIGRATION.md": "/docs/migrating",
  "README-REMIX-MIGRATION.md": "/docs/migrating-remix",
};

/** The examples the site gives a page of its own (`/docs/examples/<name>`). */
const EXAMPLE_NAMES: ReadonlySet<string> = new Set(
  examplesIndex.examples.map((e: { name: string }) => e.name),
);

/**
 * The docs route for a repo path that IS an example — its directory (`examples/notes`) or its
 * README (`examples/notes/README.md`) — or `null` for any other path.
 */
export function exampleRoute(path: string): string | null {
  const m = /^examples\/([^/]+)(?:\/README\.md)?$/.exec(path);
  return m && EXAMPLE_NAMES.has(m[1]) ? `/docs/examples/${m[1]}` : null;
}

/** Base URL for linking a repo FILE on GitHub (`${GITHUB_BLOB}/src/mod.ts`). */
export const GITHUB_BLOB = "https://github.com/Brainwires/denext/blob/main";

/** Base URL for linking a repo DIRECTORY on GitHub (`${GITHUB_TREE}/examples/notes`). */
export const GITHUB_TREE = "https://github.com/Brainwires/denext/tree/main";

/** The repository itself (what a link to the repo root, `../../` from an example, means). */
export const GITHUB_REPO = "https://github.com/Brainwires/denext";
