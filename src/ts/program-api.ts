// TypeScript's program API (a checker over a project: symbols, types, signatures), for denext's
// own tooling only: the parity extractors in scripts/parity/ read React's, Next.js's and React
// Native's declarations through it. This is the one module that names it, so a TypeScript move is
// a change here, nothing else. Not published (deno.json `publish.exclude`): the framework itself
// never loads TypeScript, so it stays free of npm at run time.
//
// This is TypeScript 7.1's API (`typescript/async`, `typescript/ast`: the subpaths 7.0 shipped
// under `unstable/`), an IPC client that spawns the native compiler (the sync client needs raw pipe
// descriptors Deno's `node:child_process` doesn't expose). Until 7.1.0 is out it is pinned to one
// dated 7.1 nightly, old enough for Deno's minimum dependency age; every pin below names the same
// version (tests/ts-program-api.test.ts holds them to `TYPESCRIPT_API_VERSION`), so the move to the
// stable release is one replace of that string across this file.

// deno-lint-ignore no-import-prefix -- the types of the API exported below (no import map in scope)
import type * as Api from "npm:typescript@7.1.0-dev.20261102.1/async";

export * as ts from "npm:typescript@7.1.0-dev.20261102.1/async";
export { SyntaxKind } from "npm:typescript@7.1.0-dev.20261102.1/ast";

/** The exact `typescript` version the API above is pinned to (a parity install's dependency). */
export const TYPESCRIPT_API_VERSION = "7.1.0-dev.20261102.1";

/**
 * Open the project `config` (a tsconfig.json path) in a new snapshot of `api`'s compiler session.
 * The snapshot lives until `api.close()`.
 *
 * @param api A program API session (`new ts.API({ cwd })`).
 * @param config The project's tsconfig.json path.
 * @returns The configured project: its `program` and `checker`.
 */
export async function openConfiguredProject(api: Api.API, config: string): Promise<Api.Project> {
  const snapshot = await api.createSnapshot({ openProjects: [config] });
  const project = snapshot.getConfiguredProject(config);
  if (!project) throw new Error(`typescript did not open ${config}`);
  return project;
}
