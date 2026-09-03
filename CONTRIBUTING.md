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

- **`check:fix`** auto-fixes everything that _can_ be auto-fixed — formatting
  and the handful of fixable lint issues — then runs `deno lint` one more time
  to **report what it couldn't fix**. If that final lint fails, the remaining
  issues are correctness rules you must resolve by hand (below).
- **`hooks:install`** points `core.hooksPath` at [`.githooks/`](./.githooks);
  the `pre-commit` hook runs `check:fix` (fast — no tests) so a commit can't
  land with a formatting or lint problem, then runs the **Fallow gate** (below).
  Run the full `deno task check` before pushing.

### The Fallow gate

Every commit is gated by [`fallow`](https://github.com/fallow-rs/fallow), a
static analyzer that scopes dead-code, complexity, and duplication findings to
the changeset and returns a verdict. The `pre-commit` hook runs:

```sh
fallow audit --quiet --explain --gate-marker git --no-css   # exits 1 on a "fail" verdict
```

`--no-css` drops **styling** analytics from the gate: token-drift and
duplicate-block findings are advisory (they never affect the verdict) and mostly
flag vendored fixtures and standalone example stylesheets. Inspect them any time
with `fallow health --css`.

**Fallow is required** — install it once (it is not an `npm`/`deno`
dependency of the project):

```sh
npm i -g fallow          # or: cargo install fallow-cli
```

By default the audit gates **new-only**: only findings _introduced_ by your
changeset block the commit; pre-existing findings on touched files are reported
but don't block.

**Measured coverage for CRAP.** Fallow's CRAP score (complexity × untested-ness)
needs per-function coverage; without a coverage file it _estimates_ coverage from
the import graph, which under-scores internals that tests reach only transitively
(the fiber reconciler is driven through `createRoot()`, never imported by a test)
and then flags any function with cyclomatic ≥ 10 there. Before committing to such
code, generate the real numbers once:

```sh
deno task coverage:fallow   # unit suite → lcov → coverage/coverage-final.json
```

Fallow auto-discovers `coverage/coverage-final.json`, so every `fallow audit` —
the pre-commit hook (which also passes it explicitly), an agent's gate, a manual
run — scores with the measured numbers while the file exists (it is git-ignored;
Deno's own V8 profiles live under `coverage/profile/` so the two don't collide). Re-run the task after large edits — coverage is pinned
to source lines, and a function whose lines drifted falls back to the estimate. The full task map (trace an "unused" export, prove a symbol's
consumers, etc.) lives in [`AGENTS.md`](./AGENTS.md).

If a report is a **genuine false positive**, scope the suppression as narrowly
as possible — prefer a per-line/file marker over widening config:

```ts
// fallow-ignore-next-line unused-export -- <why this is safe>
// fallow-ignore-file code-duplication   -- <why, at top of file>
```

For non-code assets that static analysis can't see used — e.g. **fixtures read
as text** rather than `import`ed (`tests/fixtures/**`), which fallow flags as
"unused files" — add an ignore pattern to a `fallow.toml` at the repo root
rather than annotating each file. Run `fallow explain <issue-type>` for the
rationale and fix guidance on any finding, and `fallow audit --explain` to see
what a failing commit tripped on.

## Lint rules that can't be auto-fixed

The [denext lint plugin](./src/lint/denext-plugin.ts) adds **correctness** rules
— they flag bugs, not style. `deno lint --fix` and `deno fmt` can't resolve
them, because the fix is a semantic change only you should make. When one fires,
fix it by hand:

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

denext publishes to [JSR](https://jsr.io/@denext/denext) via a GitHub Actions
workflow ([`.github/workflows/publish.yml`](./.github/workflows/publish.yml))
that publishes **with build provenance** (OIDC, no token).

This repo is a Deno **workspace**: the root `@denext/denext` plus independently
versioned packages under `packages/*`. **Each publishes on its own tag prefix**
— a release never re-cuts every package, only the one you tag. The tag routes to
`deno publish --config <that package's deno.json>`, scoping the publish to
exactly that package.

| Package                | Tag prefix        | Version lives in                  |
| ---------------------- | ----------------- | --------------------------------- |
| `@denext/denext`       | `v*`              | `deno.json` **and** `mod.ts`      |
| `@denext/pages-router` | `pages-router-v*` | `packages/pages-router/deno.json` |
| `@denext/photon`       | `photon-v*`       | `packages/photon/deno.json`       |
| `@denext/avif`         | `avif-v*`         | `packages/avif/deno.json`         |
| `@denext/og`           | `og-v*`           | `packages/og/deno.json`           |
| `@denext/htmx`         | `htmx-v*`         | `packages/htmx/deno.json`         |

A release is: **bump → verify → commit → tag → push tag.** Pushing the tag
triggers the publish.

**Prerequisites (one-time, per package).** The JSR package exists and is
**linked to this GitHub repo** in its JSR settings — that link is what lets
Actions publish via OIDC and records provenance. `@denext/denext` is linked;
each `packages/*` member must be created and linked once before its first tag
will publish. `publish.yml` is on `main` with `permissions: id-token: write`.

### Steps (root — `@denext/denext`)

1. **Start from a clean `main`:** `git checkout main && git pull`; `git status`
   must be clean.
2. **Bump the version in both places (they must match):** `deno.json` →
   `"version": "X.Y.Z"` and `mod.ts` → `export const VERSION = "X.Y.Z";`.
   SemVer: patch = fixes, minor = new features, major = breaking.
3. **Update `CHANGELOG.md`:** rename the `[Unreleased]` heading to
   `## [X.Y.Z] - YYYY-MM-DD` and add a link reference at the bottom
   (`[X.Y.Z]: https://jsr.io/@denext/denext@X.Y.Z`).
4. **Verify locally** (exactly what CI enforces): `deno task release-check` —
   runs `deno task check` (fmt --check + lint + test), `deno task doc-lint`, and
   `deno publish --dry-run`. All three must pass (the dry-run needs a clean tree
   — commit step 5 first if it complains).
5. **Commit:**
   `git commit -am "release: X.Y.Z — <summary>" && git push origin main`.
6. **Tag and push the tag — this triggers the publish:**
   `git tag -a vX.Y.Z -m "denext X.Y.Z — <summary>" && git push origin vX.Y.Z`.
7. **Watch CI and verify it went live:**
   `gh run watch "$(gh run list --workflow=publish.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status`,
   then confirm it resolves:
   `deno eval --min-dep-age=0 "console.log((await import('jsr:@denext/denext@X.Y.Z')).VERSION)"`.

### Releasing a workspace package

For a codec (`@denext/photon`/`avif`/`og`), `@denext/htmx`, or
`@denext/pages-router` — publish only that package, on its own tag:

1. From a clean `main`, bump the version in **that package's** `deno.json`
   (members have no `mod.ts` VERSION constant — only the root does). Update its
   own `CHANGELOG.md` if it has one.
2. Verify: `deno task check` and
   `deno publish --dry-run --config packages/<pkg>/deno.json`.
3. Commit, then tag with the package's prefix (triggers the publish):
   `git commit -am "release(<pkg>): X.Y.Z — <summary>" && git push origin main`,
   then `git tag -a <pkg>-vX.Y.Z -m "@denext/<pkg> X.Y.Z"` (e.g.
   `photon-v1.1.0`) and `git push origin <pkg>-vX.Y.Z`.

### Gotchas

- **Clean tree required.** `deno publish` (and the workflow) refuse a dirty
  tree; CI does not use `--allow-dirty`.
- **Versions are immutable.** A published version can't be replaced — a mistake
  means bumping to the next patch.
- **Minimum-dependency-age.** For roughly the first 24 hours, importing the new
  version needs `--min-dep-age=0`. It's a supply-chain delay, not an error.
- **Provenance requires the tag path.** Publishing manually from a laptop skips
  provenance — always release via the tag push so CI does it.
- `unanalyzable-dynamic-import` lines in publish output are **warnings**
  (denext's intentional runtime `import()` of user route modules), not blockers.

**Quick checklist:** clean+pulled main · version bumped in `deno.json`+`mod.ts`
· CHANGELOG heading+link · `deno task release-check` passes · commit+push main ·
tag +push · publish workflow green · `jsr:@denext/denext@X.Y.Z` resolves.

## Conventions

- **Zero-npm runtime:** nothing under
  `src/{jsx,runtime,client,server,compat,plugin}` may import npm — CI enforces
  this (`tests/no-npm-compat-guard.test.ts`).
- **Docs on public API:** exported symbols on the public entry points need JSDoc
  (`deno task doc-lint`).
- **Commits:** stage per file (never `git add -A`); keep the working tree
  buildable.

## The build must run from a remote framework (JSR), not just a local checkout

denext's own build tooling (`src/build/*`) runs in **two** modes:

1. **Local checkout** — `deno run cli.ts …`, where framework modules are
   `file://`.
2. **From JSR** — a consumer runs `deno run -A jsr:@denext/denext/cli build .`
   (this is what `denext migrate` writes into `deno.json` tasks). Here **every
   framework module's `import.meta.url` is
   `https://jsr.io/@denext/denext/<ver>/…`**, not `file://`.

Mode 2 is the real consumer path, so the build must never assume the framework
is on the local filesystem. In particular:

- **NEVER** `fromFileUrl(import.meta.url)` or
  `fromFileUrl(new URL("…", import.meta.url))` in build code — it throws
  `URL must be a file URL: received "https:"` from JSR. This is what broke every
  migrated app's first `deno task build` until it was fixed.
- **NEVER** `Deno.readTextFile(join(frameworkRoot(), "…"))` to read a framework
  file, and **NEVER** `join(frameworkRoot(), …)` to build a sub-path (it
  corrupts a URL's `//`).
- **DO** use the scheme-agnostic helpers in `src/build/bundle.ts`, which work in
  both modes: `frameworkRootUrl()`, `frameworkFileUrl(rel)`,
  `readFrameworkText(rel)` / `readFrameworkJson(rel)` (fetch when remote), and
  `frameworkImports()`. `frameworkRoot()` remains only for the narrow case of a
  `startsWith` prefix check (it returns the remote URL when not local).
- The esbuild [`@luca/esbuild-deno-loader`] resolves `https://`/`jsr:`
  specifiers, so pass framework module refs as URLs (not `file://` paths) and
  give it a **local** temp config when it needs one (see `prebuildDenextRuntime`
  writing `frameworkImports()` to a temp `deno.json`).

**Testing the remote path locally (no JSR publish!):** `http://` triggers the
identical non-`file://` code path as JSR's `https://`. Serve the repo and build
a throwaway app through it:

```sh
deno run --allow-read --allow-net jsr:@std/http/file-server --port 8799 .   # serve the repo
# in another shell, against a minimal app dir $APP:
deno run --reload --no-lock -A --config=$PWD/deno.json \
  http://127.0.0.1:8799/cli.ts build "$APP"
```

A green build here means it will build from JSR too. **Always run this before
cutting a release that touches `src/build/*`** — the normal test suite uses a
local (`file://`) framework and cannot catch a re-introduced `file://`
assumption.
