// TypeScript's program API (a checker over a project: symbols, types, signatures), for denext's
// own tooling only: the parity extractors in scripts/parity/ read React's, Next.js's and React
// Native's declarations through it. This is the one module that names it, so the move from
// TypeScript 7.0's unstable IPC client to 7.1's stable API is a change here (and its callers'
// calls), nothing else. Not published (deno.json `publish.exclude`): the framework itself never
// loads TypeScript, so it stays free of npm at run time.
//
// 7.0's API is an IPC client that spawns the native compiler (`typescript/unstable/async`; the
// sync client needs raw pipe descriptors Deno's `node:child_process` doesn't expose), pinned to
// 7.0.x until the API settles.

export * as ts from "npm:typescript@~7.0.2/unstable/async";
export { SyntaxKind } from "npm:typescript@~7.0.2/unstable/ast";

/** The `typescript` version range the API above is pinned to (a parity install's dependency). */
export const TYPESCRIPT_API_RANGE = "~7.0.2";
