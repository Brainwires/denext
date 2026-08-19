# Contributing to denext

## The checks

denext gates on one command:

```sh
deno task check      # deno fmt --check && deno lint && deno test  (the CI gate)
```

Two helpers make it painless:

```sh
deno task check:fix  # deno fmt + deno lint --fix, then a report-only deno lint
deno task hooks:install   # install the pre-commit hook (once per clone)
```

- **`check:fix`** auto-fixes everything that _can_ be auto-fixed — formatting and
  the handful of fixable lint issues — then runs `deno lint` one more time to
  **report what it couldn't fix**. If that final lint fails, the remaining issues
  are correctness rules you must resolve by hand (below).
- **`hooks:install`** points `core.hooksPath` at [`.githooks/`](./.githooks); the
  `pre-commit` hook runs `check:fix` (fast — no tests) so a commit can't land with
  a formatting or lint problem. Run the full `deno task check` before pushing.

## Lint rules that can't be auto-fixed

The [denext lint plugin](./src/lint/denext-plugin.ts) adds **correctness** rules —
they flag bugs, not style. `deno lint --fix` and `deno fmt` can't resolve them,
because the fix is a semantic change only you should make. When one fires, fix it
by hand:

| Rule                         | What it means                                                                                                                         | How to fix                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `denext/rules-of-hooks`      | A hook is called conditionally (in an `if`/loop/callback) or after an early `return`, so it won't run in the same order every render. | Move the hook to the **top level** of the component/hook, above any early return. Put the condition _inside_ the hook or after all hooks are called.                                                                                |
| `denext/hooks-in-component`  | A hook is called outside a component (`Capitalized`) or a custom hook (`useX`).                                                       | Call it from a component or a `useX` function. If it's shared logic, extract a `useSomething()` custom hook.                                                                                                                        |
| `denext/no-hooks-in-async`   | A hook is used in an `async` (server) component, which renders only on the server and never hydrates — the hook has no client effect. | Drop the hook (do the work with plain `await`), or split the interactive part into a `"use client"` child component.                                                                                                                |
| `denext/directive-placement` | A `"use client"`/`"use server"` directive isn't the module's leading statement, or the module declares both.                          | Move the directive to the **very top** of the file (before imports). A module is either client **or** server — split it if it needs both. _(A redundant duplicate of a directive already at the top **is** auto-fixed by `--fix`.)_ |

If a report is a genuine false positive, scope an ignore to the line rather than
disabling the rule repo-wide:

```ts
// deno-lint-ignore denext/rules-of-hooks -- <why this is safe>
```

## Releasing (publish to JSR)

This repo is a Deno **workspace**: the root `@denext/denext` plus independently
versioned packages under `packages/*` (`@denext/photon`, `@denext/avif`,
`@denext/og`, `@denext/sqlite`, `@denext/pages-router`). Each publishes **on its own
tag** — a release never re-cuts every package, only the one you tag. Publishing is
tokenless (GitHub OIDC + the package's jsr.io↔repo link); the workflow is
[`.github/workflows/publish.yml`](./.github/workflows/publish.yml).

To cut a release: **bump the `version` in that package's `deno.json`**, commit, then
push its tag (JSR rejects re-publishing an existing version):

| Package                 | Bump                              | Tag                                                                  |
| ----------------------- | --------------------------------- | -------------------------------------------------------------------- |
| `@denext/denext` (root) | `deno.json`                       | `git tag v1.0.1 && git push origin v1.0.1`                           |
| `@denext/pages-router`  | `packages/pages-router/deno.json` | `git tag pages-router-v0.3.1 && git push origin pages-router-v0.3.1` |
| `@denext/photon`        | `packages/photon/deno.json`       | `photon-v1.1.0`                                                      |
| `@denext/avif`          | `packages/avif/deno.json`         | `avif-v0.2.0`                                                        |
| `@denext/og`            | `packages/og/deno.json`           | `og-v0.9.0`                                                          |
| `@denext/sqlite`        | `packages/sqlite/deno.json`       | `sqlite-v1.0.0`                                                      |

The tag prefix routes to `deno publish --config <that package's deno.json>`, which
scopes the publish to exactly that package. **One-time per package:** create it on
jsr.io under the `@denext` scope and link it to this GitHub repo (Settings → GitHub
repository) — that link is what makes the tokenless OIDC publish work.

## Conventions

- **Zero-npm runtime:** nothing under `src/{jsx,runtime,client,server,compat,plugin}`
  may import npm — CI enforces this (`tests/no-npm-compat-guard.test.ts`).
- **Docs on public API:** exported symbols on the public entry points need JSDoc
  (`deno task doc-lint`).
- **Commits:** stage per file (never `git add -A`); keep the working tree buildable.
