# Contributing to denext

## The checks

denext gates on one command:

```sh
deno task check      # deno fmt --check && deno lint && deno test  (the CI gate)
```

Two helpers make it painless:

```sh
deno task check:fix  # test-count badge + deno fmt + deno lint --fix, then a report-only deno lint
deno task hooks:install   # install the pre-commit hook (once per clone)
deno task release-check   # check + doc-lint + deno publish --dry-run (run before tagging)
```

- **`check:fix`** auto-fixes everything that _can_ be auto-fixed — formatting
  and the handful of fixable lint issues — then runs `deno lint` one more time
  to **report what it couldn't fix**. If that final lint fails, the remaining
  issues are correctness rules you must resolve by hand (below). It first
  refreshes the test-count badge (`deno task badge:tests`); the pre-commit hook
  stages `.github/badges/tests.json` when the count moved, so CI's
  `badge:tests --check` never trips on a forgotten badge.
- **`hooks:install`** points `core.hooksPath` at [`.githooks/`](./.githooks);
  the `pre-commit` hook runs `check:fix` (fast — no tests) so a commit can't
  land with a formatting or lint problem, then runs the **Fallow gate** (below).
  Run the full `deno task check` before pushing.
- **`deno task coverage:fallow`** — run it **before committing** (and again after
  large edits or a disk sweep of git-ignored files). It writes the measured
  per-function coverage map the Fallow gate scores CRAP with; without it fallow
  _estimates_ coverage and can block a commit on framework internals that tests
  reach only transitively. Details under _The Fallow gate_ below.
- **Formatting is `deno fmt`** (no Prettier, no npm), configured under `fmt` in
  `deno.json`; format files under `site` **from the repo root**
  (`deno fmt --config deno.json <paths>`), never from inside `site`.
- **Tests run in one process.** `deno test --parallel` runs every test file in the same process,
  so a test that sets or deletes an environment variable, or changes the working directory,
  changes it for every test running at that moment; restoring it in `finally` is too late for
  them. Pass the value explicitly, or run the subject in a child process with its own env and
  cwd (`inChild` from `tests/helpers/isolated.ts`). A file that must change process-wide state
  goes in `tests/serial-tests.ts`: `deno task test` (`scripts/test-run.ts`) runs those files one
  at a time after the parallel pass, and `tests/serial-tests.test.ts` fails on an unlisted one.
- **`deno task test:e2e`** and **`deno task test:migration-bed`** are the two
  network-bound suites `check` never runs; the nightly workflow
  (`.github/workflows/e2e.yml`) does. The e2e suite drives the examples in a real
  Chromium. The **migration beds** (`tests/migration-bed/`) clone SHA-pinned
  real-world apps, run `denext migrate` against your checkout, build, serve and
  render-assert routes — one `<app>.test.ts` per bed describing the app as data
  and calling `runBed` (see `_bed.ts`). A clone, dependency install or post-migrate setup
  command that fails for network reasons skips the bed; `denext migrate`, the build, serving
  and the route assertions are real failures. Bump a bed's SHA
  deliberately and say why in the commit (the pin comment names what the newer
  upstream needs).

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
Deno's own V8 profiles live under `coverage/profile/` so the two don't collide, and
`deno task test:coverage` no longer deletes it). A disk sweep of git-ignored files
removes it; that only matters when a commit touches a function with cyclomatic ≥ 10
in a transitively-tested module — regenerate then. Re-run the task after large edits — coverage is pinned
to source lines, and a function whose lines drifted falls back to the estimate. The full task map (trace an "unused" export, prove a symbol's
consumers, etc.) lives in [`AGENTS.md`](./AGENTS.md).

**Concurrent runs (agents, hooks, people).** `coverage:fallow` and `test:coverage` hold
denext's Cargo-style lock on `coverage/` (`scripts/locked.ts`, an OS lock in
`.denext/.denext-lock-coverage`): a second run prints
`Blocking waiting for file lock on output directory coverage` and waits for the first
instead of deleting its output. Seeing that line means another run is in progress — let it
finish; do not kill it or delete the lock file (the OS releases the lock when the holder
exits, so there is never a stale lock to clear). The same applies to `denext build` /
`export` / `dev` / packaging on one project; the lock map is in
[the CLI reference](https://denext.dev/docs/cli#build-locks) and
`src/build/project-locks.ts`. Call the `*:run` tasks directly only when you know nothing
else writes `coverage/`.

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

### The health score

The README badge is [`fallow health`](https://docs.fallow.tools/explanations/health)'s
score for the whole repository — `src/`, `packages/`, `examples/`, `bench/`,
`scripts/` and `tests/` alike, with the default thresholds (cyclomatic 20,
cognitive 15, CRAP 30, 60-line units), no `fallow-ignore` markers, no
`[health] ignore` and no per-file threshold overrides. `fallow.toml` only states
runtime facts static analysis can't see — file-convention entry points, generated
wasm glue, Deno import-map dependencies, and a few `ignoreExports` entries for
same-named exports that its duplicate-export check can't tell apart (each one is
explained inline). Reproduce it with:

```sh
deno task coverage:fallow                    # measured coverage (see above)
fallow health --coverage coverage/coverage-final.json   # the full report
fallow health --score                        # the score alone, hotspot-free
deno task badge:fallow                       # rewrite .github/badges/fallow.json
```

The score is `100 − penalties`. denext sits at **zero** for every code-quality
penalty — no complexity or CRAP findings, no dead files or exports, no function
over 60 lines, no unused or circular dependencies, no duplication above the
floor — and the two penalties that remain are structural, not fixable by editing
code:

- **Hotspots (−10).** A hotspot is a file in the top ⌈1 %⌉ by _relative_ churn ×
  complexity density over the last six months. The measure is relative, so in
  any repository where at least ten files changed three or more times the top ten
  always score above zero and the penalty is always the maximum. It decays with
  time (90-day half-life), never with refactoring. `fallow health --score`
  reports the score without it (and is what `--format badge` renders).
- **Coupling (−2.3).** The share of files whose fan-in exceeds the 95th
  percentile — a percentile cut-off puts ~5 % of files above it by construction.
  denext's hubs (`h`, the runtime hooks, the request context) are meant to be
  imported everywhere; splitting them would add indirection, not remove coupling.

So the honest ceiling for an actively developed repo is ≈ 88 (A), and the
number to watch is not the score but the finding counts: `fallow health` must
exit 0 with zero findings and `fallow dead-code` must report zero issues. The
[unit-size](#the-fallow-gate) rule is the one most likely to bite a new
contribution — a function over 60 lines (blank and comment lines count) is a
finding even when it is simple, so split long builders into named steps.

## Lint rules that can't be auto-fixed

The [denext lint plugin](./src/lint/denext-plugin.ts) adds **correctness** rules
— they flag bugs, not style. `deno lint --fix` and `deno fmt` can't resolve
them, because the fix is a semantic change only you should make. When one fires,
fix it by hand:

| Rule                          | What it means                                                                                                                                                                                                                      | How to fix                                                                                                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `denext/rules-of-hooks`       | A hook is called conditionally (in an `if`/loop/callback) or after an early `return`, so it won't run in the same order every render.                                                                                              | Move the hook to the **top level** of the component/hook, above any early return. Put the condition _inside_ the hook or after all hooks are called.                                                                                |
| `denext/hooks-in-component`   | A hook is called outside a component (`Capitalized`) or a custom hook (`useX`).                                                                                                                                                    | Call it from a component or a `useX` function. If it's shared logic, extract a `useSomething()` custom hook.                                                                                                                        |
| `denext/no-hooks-in-async`    | A hook is used in an `async` (server) component, which renders only on the server and never hydrates — the hook has no client effect.                                                                                              | Drop the hook (do the work with plain `await`), or split the interactive part into a `"use client"` child component.                                                                                                                |
| `denext/no-handlers-in-async` | A JSX `on*` prop in an `async` (server) component is given a function (an inline arrow/function, or a module-local one). Functions never cross the server→client boundary, so the handler is dropped and the element does nothing. | Pass a Server Action (`"use server"`) instead, or move the handler into a `"use client"` component. An imported name is not flagged (it may be a server action from a `"use server"` module).                                       |
| `denext/directive-placement`  | A `"use client"`/`"use server"` directive isn't the module's leading statement, or the module declares both.                                                                                                                       | Move the directive to the **very top** of the file (before imports). A module is either client **or** server — split it if it needs both. _(A redundant duplicate of a directive already at the top **is** auto-fixed by `--fix`.)_ |

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

| Package                       | Tag prefix               | Version lives in                         |
| ----------------------------- | ------------------------ | ---------------------------------------- |
| `@denext/denext`              | `v*`                     | `deno.json` **and** `mod.ts`             |
| `@denext/pages-router`        | `pages-router-v*`        | `packages/pages-router/deno.json`        |
| `@denext/photon`              | `photon-v*`              | `packages/photon/deno.json`              |
| `@denext/avif`                | `avif-v*`                | `packages/avif/deno.json`                |
| `@denext/og`                  | `og-v*`                  | `packages/og/deno.json`                  |
| `@denext/htmx`                | `htmx-v*`                | `packages/htmx/deno.json`                |
| `@denext/effect`              | `effect-v*`              | `packages/effect/deno.json`              |
| `@denext/openapi`             | `openapi-v*`             | `packages/openapi/deno.json`             |
| `@denext/graphql`             | `graphql-v*`             | `packages/graphql/deno.json`             |
| `@denext/react-router`        | `react-router-v*`        | `packages/react-router/deno.json`        |
| `@denext/content-collections` | `content-collections-v*` | `packages/content-collections/deno.json` |
| `@denext/lightningcss`        | `lightningcss-v*`        | `packages/lightningcss/deno.json`        |
| `@denext/swc`                 | `swc-v*`                 | `packages/swc/deno.json`                 |

A release is: **`deno task release <version>`** on `development`, then the
`development → main` merge. The script does the bump, the changelog roll, the
generated-doc refresh, the gate, the tag and the push; you do the merge and the
docs deploy.

**Prerequisites (one-time, per package).** The JSR package exists and is
**linked to this GitHub repo** in its JSR settings — that link is what lets
Actions publish via OIDC and records provenance. `@denext/denext` is linked;
each `packages/*` member must be created and linked once before its first tag
will publish. `publish.yml` is on `main` with `permissions: id-token: write`.

### Steps (root — `@denext/denext`)

1. **Start from a clean, pushed `development`** (`git status` clean; all work
   lands on `development` — never branch off it).
2. **Run the heavy CI jobs on that commit.** A push to `development` runs only
   ci.yml's fast jobs; `integration`, `next-compat` and `coverage` run on pull
   requests, `main` and a manual dispatch. Dispatch it and wait:
   `gh workflow run ci.yml --ref development`, then
   `gh run watch "$(gh run list --workflow=ci.yml --event=workflow_dispatch --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status`.
   The release script checks this itself (`scripts/release-ci.ts`): it refuses
   to start unless the newest ci.yml run on HEAD that ran those jobs has
   `check`, `integration`, `next-compat`, `coverage` and `ios-export-router`
   green (it needs `gh`, logged in).
3. **Cut:** `deno task release X.Y.Z` (add `--confirm` to skip the prompt,
   `--dry` to preview). The script: bumps every version spot (`deno task bump`
   — root `deno.json` + `mod.ts`, `ROADMAP.md`'s status line, every
   `packages/*/deno.json` peer pin, `examples/*/deno.json` JSR pins), rolls
   `CHANGELOG.md` `[Unreleased]` → `[X.Y.Z]` (a **stable** version also folds
   every `[X.Y.Z-rc.N]` section into that one entry, grouped, `### Breaking`
   first, and appends the link reference), regenerates the API reference, the
   MCP docs corpus + `llms*.txt` and the badges, refreshes `deno.lock`, runs
   `deno task check`, `deno task doc-lint` and `deno publish --dry-run`, shows
   the diff, then commits, tags `vX.Y.Z` and pushes — the tag triggers the
   publish.
4. **Before running it for a stable major/minor**, hand-edit the prose the bump
   does not: `ROADMAP.md`'s status paragraph, any `README.md` stage language, and
   any stage language on the docs-site pages (`site/app/docs/*/content.md`).
5. **Watch the publish and verify it went live:**
   `gh run watch "$(gh run list --workflow=publish.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status`,
   then `deno eval --min-dep-age=0 "console.log((await import('jsr:@denext/denext@X.Y.Z')).VERSION)"`.
6. **Merge `development` into `main`** — `main` must always equal the published
   release: `gh pr create --base main --head development` then
   `gh pr merge <n> --merge`. A tag without this merge is an incomplete release.
7. **Deploy the docs site** (`deno task docs:build` + the rsync in
   [the docs-site notes](./site/README.md)); it is not part of the script.

8. **Package managers (stable releases, by hand).** The `release` job attaches
   generated manifests to the GitHub release (`scripts/gen-package-manifests.ts`,
   from its `SHA256SUMS`): `denext.rb` (Homebrew), `denext.json` (Scoop) and
   `Brainwires.denext.yaml` + `.installer.yaml` + `.locale.en-US.yaml` (winget).
   Publishing them is an outward step nothing automates: commit `denext.rb` to
   the Homebrew tap repo (`Formula/denext.rb`), `denext.json` to the Scoop bucket
   (`bucket/denext.json`), and open a PR to `microsoft/winget-pkgs` with the
   three YAML files under `manifests/b/Brainwires/denext/<version>/` (validate
   with `winget validate` first). Skip release candidates. `install.sh` and
   `install.ps1` need nothing: they resolve the latest release themselves (the
   served copies under `site/public/` go live with the docs deploy).

If the script aborts (a failed gate), fix, **commit the fix**, and rerun — after
`git checkout -- .` of the half-prepared bump/changelog, or the rerun double-rolls
the changelog.

### Manual desktop checks before a final release

CI covers the desktop surface on every push to `development` (`desktop-ci.yml`, with the
per-file coverage floor, and the kitchen sink's real-window test in `desktop-window.yml`).
Before tagging, run `deno task coverage:desktop` once locally as well. What no hosted runner
can prove — a person at a fingerprint reader, a paid signing identity, a real display — is
checked by hand before a **final** (not an rc) version, and its result recorded in this table
before the tag. Each row is the user's (owner **user**); a row that has not passed is either
fixed or named in the release notes, never silently skipped.

| Check                                                                                                                                                                                                                                                                                                                                                                             | Owner | Result (3.1.0)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Security — Clerk `rotating_token_nonce`:** a real Clerk sign-in through the desktop OAuth flow settles whether the nonce is bound to the initiating client. If an intercepted nonce alone completes a sign-in (a custom-scheme hijack), the Clerk bridge moves to hosted auth with PKCE / a loopback redirect **before** the final release.                                     | user  | open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| examples/clerk with real accounts (its README → _Manual checks_): Google and GitHub sign-in on the web and in the packaged desktop app (macOS sheet; Windows / Linux browser + Cancel overlay + the "Make this app the handler" path), a passkey created and used on the `*.ts.net` HTTPS host, and `deno task test:desktop` against an instance that allows `denextclerk://app`. | user  | open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Passkey **success** on macOS with Touch ID: an entitled app (`desktop.macos.provisioningProfile` + `webcredentials:<rp-id>`, the RP serving `/.well-known/apple-app-site-association`) creates and then uses a passkey through the kitchen sink's Manual checks panel.                                                                                                            | user  | pass (2026-10-03): Developer ID–signed test app `dev.denext.passkeytest`, RP brainwires.net, Touch ID create + sign-in both SUCCESS with the same credential id.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Passkey **success** on Windows with Windows Hello: create, then sign in (kitchen sink › _Manual release checks_ › Passkey).                                                                                                                                                                                                                                                       | user  | skipped for 3.1.0 (2026-10-03): the only Windows test machine is a Windows Server 2025 VM with no TPM, so no Windows Hello and no platform authenticator. The WebAuthn path is unit-tested; the live ceremony waits for a Windows 11 machine or a vTPM VM (ROADMAP).                                                                                                                                                                                                                                                                                                                                       |
| macOS notifications from a **signed** app (an ad-hoc signature gets `UNErrorDomain` 1): shown, and a click reaches the app.                                                                                                                                                                                                                                                       | user  | open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Full-app update **signer match** with real identities: a Developer ID (macOS Team ID) and a real Authenticode certificate (Windows) — the same signer installs, a different signer is refused.                                                                                                                                                                                    | user  | macOS 2026-10-03, PARTIAL: a different signer (Apple Development, same Team ID) is refused, `os_signature` (Gatekeeper); a downgrade is refused; the same Developer ID is refused too while un-notarized (`os_signature`, Gatekeeper: unnotarized Developer ID), so the install path needs a notarized build (rerun with `DENEXT_NOTARY_PROFILE`). Windows: automated in the window test (`desktop-window.yml`) with throwaway self-signed certificates: signing and every PE file's signer on every Windows host, the trusted same-signer install and different-signer refusal on the elevated CI runner. |
| Windows 11 **Mica** / Acrylic backdrops look right on a real display (kitchen sink › _Manual release checks_ › Backdrop).                                                                                                                                                                                                                                                         | user  | partial (2026-10-03): on the Windows Server 2025 VM every backdrop applies (DWM reports Mica 2 / Acrylic 3 / Mica Alt 4, the page goes transparent), but the VM's Basic Display Adapter renders the materials as solid fallback colours (the taskbar is flat too), so translucency can only be judged on GPU-backed Windows 11 hardware.                                                                                                                                                                                                                                                                   |
| Real **HiDPI** displays (a Retina Mac, Windows at 150–200%): window size, position and placement restore (kitchen sink › _Manual release checks_ › HiDPI).                                                                                                                                                                                                                        | user  | pass (2026-10-03) on a Retina Mac (2×): the test pattern and text are sharp, Save / Restore placement matches. Windows 150–200% not run (the Windows VM has no scaled display).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| A real **MSI** install's deep links (admin account, with approval): a link clicked before the first launch, a scheme another app owns is left alone, uninstall removes the rows.                                                                                                                                                                                                  | user  | open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| macOS window **fullscreen** and **close-button** clicks through `Deno.BrowserWindow` (the window probe, with the Mac unlocked).                                                                                                                                                                                                                                                   | user  | open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| T3 Connect click-through: the passkey sign-in end to end in the T3 desktop app.                                                                                                                                                                                                                                                                                                   | user  | open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Releasing a workspace package

For any `packages/*` member (a codec, `@denext/htmx`, `@denext/openapi`, …) — publish
only that package, on its own tag:

1. On `development`, bump the version in **that package's** `deno.json`
   (members have no `mod.ts` VERSION constant — only the root does) and roll its own
   `CHANGELOG.md` by hand — the root release script bumps each member's `denext` peer
   pin but never touches a member's version or changelog. When a member's pin moved,
   push its tag only after the root publish shows as JSR latest.
2. Verify: `deno task check` and
   `deno publish --dry-run --config packages/<pkg>/deno.json`.
3. Commit and push, then tag with the package's prefix (triggers the publish):
   `git tag -a <pkg>-vX.Y.Z -m "@denext/<pkg> X.Y.Z" <commit>` (e.g.
   `photon-v1.1.0`) and `git push origin <pkg>-vX.Y.Z`.

### Gotchas

- **Clean tree required.** `deno publish` (and the workflow) refuse a dirty
  tree; CI does not use `--allow-dirty`.
- **Versions are immutable.** A published version can't be replaced — a mistake
  means bumping to the next patch.
- **Minimum-dependency-age.** For roughly the first 24 hours, importing the new
  version needs `--min-dep-age=0`; a `denext build` of a freshly scaffolded app
  hits the same policy inside `deno bundle` — `DENEXT_MIN_DEP_AGE=0` forwards it.
  A supply-chain delay, not an error.
- **Provenance requires the tag path.** Publishing manually from a laptop skips
  provenance — always release via the tag push so CI does it.
- `unanalyzable-dynamic-import` lines in publish output are **warnings**
  (denext's intentional runtime `import()` of user route modules), not blockers.

**Quick checklist:** clean+pushed development · ROADMAP/README prose edited ·
`deno task release X.Y.Z --confirm` green · publish workflow green ·
`jsr:@denext/denext@X.Y.Z` resolves · development → main PR merged · docs
deployed.

## Conventions

- **Zero-npm runtime:** nothing under
  `src/{jsx,runtime,client,server,compat,plugin}` may import npm — CI enforces
  this (`tests/no-npm-compat-guard.test.ts`).
- **Docs on public API:** exported symbols on the public entry points need JSDoc
  (`deno task doc-lint`) — the framework's entries AND every first-party package's
  published entrypoints (JSR scores "has docs for most symbols" per package; a raw
  re-export of a wasmbuild-generated function has none, so wrap it in a documented
  function instead). After regenerating a wasm package with `wasmbuild`, run
  `deno task docs:wasm` to re-add docs to the generated `free()` / `[Symbol.dispose]()`
  / `enum` members wasm-bindgen emits undocumented. `@denext/effect` and `@denext/graphql` are
  not in the gate: their public types are `npm:effect`'s / `npm:graphql`'s, which
  `deno doc --lint` reads as private.
- **No JSX syntax in published source.** `src/**` builds components with `h()` in
  `.ts` files — the `denext ui` views included — never `.tsx`: JSR rewrites the
  `jsxImportSource` compiler option into a per-file pragma, and the self-mapped
  `denext` it names would not resolve from `jsr:`.
  `tests/published-source-no-jsx.test.ts` guards it.
- **Commits:** stage per file (never `git add -A`); keep the working tree
  buildable.

## Where docs live

One topic, one Markdown source. Guides live in
`site/app/docs/<slug>/content.md` with a 13-line `page.tsx` wrapper and
render at `https://denext.dev/docs/<slug>`. Taxonomy files stay at the repo root
and are rendered from there by a wrapper:

- `FEATURES.md` (what ships + the `file:line` ledger) → `/docs/features`
- `KNOWN-DIFFERENCES.md` (deliberate divergences) → `/docs/differences`
- `KNOWN-LIMITATIONS.md` (real gaps) → `/docs/limitations`
- `ROADMAP.md` (still to do; not rendered)
- `CHANGELOG.md` (done) → `/docs/changelog`
- `POLICIES.md` (standing rules + the security policy) → `/docs/policies`
- `CONTRIBUTING.md` → `/docs/contributing`
- `AGENTS.md` (the agent guide — read from JSR at runtime by `denext mcp`, and
  the source of the MCP docs corpus and `llms*.txt`)

Never write a fact in two files: put it in the owning file and link it. From a
root file link the site (`https://denext.dev/docs/<slug>`); from a `content.md`
link `/docs/<slug>` and use absolute
`github.com/Brainwires/denext/blob/main/…` URLs for repo files. A new guide page
needs a `NAV` entry in `site/components/ui.tsx` or it gets no sidebar entry.
A root `docs/` folder is reserved for `deno doc --html` output (gitignored).

Some docs are **generated** and must never be hand-edited — regenerate them
instead: `deno task docs:cli` (the CLI reference), `deno task docs:examples`
(the examples index), `deno task docs:mcp` (the MCP reference),
`deno task gen:config-schema` (`denext.config.schema.json` +
`src/server/config-keys.generated.ts`) and `deno task gen:plugin-catalog`
(`src/plugin/catalog.json` — the first-party package catalog the plugins page,
`denext migrate` and the `denext ui` plugins panel all read; a new `packages/*`
needs a `"denext": { "catalog": { … } }` block in its `deno.json` to appear, and a
plugin package declares `denext.catalog.optionsType` there — the options interface
the generator embeds as the catalog's `optionsSchema`, failing when it is missing).
Both generators map TypeScript to JSON Schema through one module,
`scripts/lib/ts-to-schema.ts`: extend the mapper there, never in a generator.
Each has a drift test, so a stale artifact fails CI rather than shipping.

## Repo layout

```
src/jsx       JSX runtime, renderToString, renderToReadableStream
src/runtime   hooks, context, Suspense, error boundaries
src/router    segment parsing/matching + the filesystem manifest scanner
src/server    request handler, page pipeline, API dispatch, static, middleware
src/client    virtual-DOM reconciler, hydration, soft navigation
src/build     deno-bundle integration, dev server, prod server, desktop + mobile packaging
src/cli       the command framework and every `denext` verb (src/cli/commands)
src/compat    the React / Next / next-intl / Remix compat surface
src/desktop   the Deno Desktop runtime: bridge, capabilities, window, app, updaters, Clerk
src/mobile    denext/mobile: the Capacitor shell runtime and its desktop branches
src/react-native, src/expo, src/navigation   React Native mode, the expo-* shims, native-feel nav
src/mcp       the `denext mcp` server and its docs corpus
src/ui        the `denext ui` project GUI
src/plugin, src/lint, src/testing            plugin kit, lint plugin, denext/testing
packages/*    first-party JSR packages
site/         the docs site (guides in site/app/docs/<slug>/)
examples/*    runnable example apps
scripts/      generators, release + install scripts, CI helpers
tests/        the unit and integration suites (e2e under tests/e2e)
cli.ts        the `denext` CLI entry
mod.ts        the package entry
```

`src/jsx` + `src/runtime` + `src/client` are the React-equivalent (there is no
React in the tree) and `deno bundle` is the only bundler on the native path.

## Trying a local checkout in an app

Link the checkout with Deno's `links` rather than `file:` URLs: put
`"links": ["../denext"]` in the app's `deno.json` and keep its imports on
`jsr:@denext/denext@<this checkout's version>/…`, so denext's own bare imports
(`@std/*`, `ws`) resolve through the checkout's `deno.json`. A `file:` URL
import map works under `deno run`, but a compiled binary (`deno compile`, and so
`deno desktop`) resolves only the app's import map and fails at launch with
`Import "@std/path" not a dependency`; with `file:` URLs, add every denext bare
import to the app's `imports` too.

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
