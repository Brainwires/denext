# Releasing a new version

denext publishes to [JSR](https://jsr.io/@denext/denext) via a GitHub Actions
workflow ([`.github/workflows/publish.yml`](./.github/workflows/publish.yml)) that
publishes **with build provenance** (OIDC, no token).

This repo is a Deno **workspace**: the root `@denext/denext` plus independently
versioned packages under `packages/*`. **Each publishes on its own tag prefix** —
a release never re-cuts every package, only the one you tag. The tag routes to
`deno publish --config <that package's deno.json>`, which scopes the publish to
exactly that package.

| Package                | Tag prefix        | Version lives in                  |
| ---------------------- | ----------------- | --------------------------------- |
| `@denext/denext`       | `v*`              | `deno.json` **and** `mod.ts`      |
| `@denext/pages-router` | `pages-router-v*` | `packages/pages-router/deno.json` |
| `@denext/photon`       | `photon-v*`       | `packages/photon/deno.json`       |
| `@denext/avif`         | `avif-v*`         | `packages/avif/deno.json`         |
| `@denext/og`           | `og-v*`           | `packages/og/deno.json`           |
| `@denext/sqlite`       | `sqlite-v*`       | `packages/sqlite/deno.json`       |

So a release is: **bump → verify → commit → tag → push tag.** Pushing the tag is
what triggers the publish. The detailed steps below are for the **root**; for a
workspace package see [Releasing a workspace package](#releasing-a-workspace-package).

## Prerequisites (one-time, per package)

- The JSR package exists and is **linked to this GitHub repo** in its JSR package
  settings. That link is what allows Actions to publish via OIDC and records
  provenance. `@denext/denext` is linked; each `packages/*` member must be created
  and linked once before its first tag will publish.
- `publish.yml` is on `main` with `permissions: id-token: write`.

## Steps (root — `@denext/denext`)

**1. Start from a clean `main`.**

```sh
git checkout main && git pull
git status            # working tree MUST be clean
```

**2. Bump the version in both places (they must match).**

- `deno.json` → `"version": "X.Y.Z"`
- `mod.ts` → `export const VERSION = "X.Y.Z";`

SemVer: patch = fixes, minor = new features, major = breaking changes.

**3. Update `CHANGELOG.md`.**

- Rename the `[Unreleased]` heading to `## [X.Y.Z] - YYYY-MM-DD`.
- Add a link reference at the bottom:
  `[X.Y.Z]: https://jsr.io/@denext/denext@X.Y.Z`.

**4. Verify locally** (this is exactly what CI enforces):

```sh
deno task release-check
```

which runs `deno task check` (fmt --check + lint + test), `deno task doc-lint`,
and `deno publish --dry-run`. All three must pass. (The dry-run needs a clean
tree — commit step 5 first if it complains, then re-run.)

**5. Commit the release.**

```sh
git commit -am "release: X.Y.Z — <one-line summary>"
git push origin main
```

**6. Tag and push the tag — this triggers the publish.**

```sh
git tag -a vX.Y.Z -m "denext X.Y.Z — <summary>"
git push origin vX.Y.Z
```

**7. Watch CI and verify it went live.**

```sh
gh run watch "$(gh run list --workflow=publish.yml --limit 1 \
  --json databaseId -q '.[0].databaseId')" --exit-status

# confirm it resolves (see the fresh-version note below):
deno eval --min-dep-age=0 \
  "console.log((await import('jsr:@denext/denext@X.Y.Z')).VERSION)"
```

## Releasing a workspace package

For a codec (`@denext/photon`, `@denext/avif`, `@denext/og`, `@denext/sqlite`) or
the plugin (`@denext/pages-router`) — publish only that package, on its own tag:

**1.** From a clean `main`, bump the version in **that package's** `deno.json`
(members have no `mod.ts` VERSION constant — only the root does). Update its own
`CHANGELOG.md` if it has one (e.g. `packages/pages-router/CHANGELOG.md`).

**2. Verify** the whole workspace still passes and the package publishes clean:

```sh
deno task check
deno publish --dry-run --config packages/<pkg>/deno.json
```

**3. Commit, then tag with the package's prefix** (this triggers the publish):

```sh
git commit -am "release(<pkg>): X.Y.Z — <summary>" && git push origin main
git tag -a <pkg>-vX.Y.Z -m "@denext/<pkg> X.Y.Z"   # e.g. photon-v1.1.0
git push origin <pkg>-vX.Y.Z
```

The workflow routes the tag prefix to `deno publish --config packages/<pkg>/deno.json`,
so **only** that package is published. Everything under [Gotchas](#gotchas) applies.

## Gotchas

- **Clean tree required.** `deno publish` (and the workflow) refuse a dirty tree;
  commit first. CI does not use `--allow-dirty`.
- **Versions are immutable.** A published version cannot be replaced — a mistake
  means bumping to the next patch. (That's why `0.1.1`'s module-doc issue was
  fixed by shipping `0.1.2`, not by republishing.)
- **Minimum-dependency-age.** For roughly the first 24 hours, importing the new
  version needs `--min-dep-age=0` (or a `deno.json` setting). It's a
  supply-chain delay, not an error.
- **Provenance requires the tag path.** Publishing manually with `deno publish`
  from a laptop skips provenance. Always release via the tag push so CI does it.
- `unanalyzable-dynamic-import` lines in the publish output are **warnings**
  (denext's intentional runtime `import()` of user route modules), not blockers.

## Quick checklist

```
[ ] clean main, pulled
[ ] version bumped in deno.json + mod.ts (match)
[ ] CHANGELOG heading + link updated
[ ] deno task release-check passes
[ ] commit + push main
[ ] git tag -a vX.Y.Z && git push origin vX.Y.Z
[ ] publish workflow green
[ ] jsr:@denext/denext@X.Y.Z resolves
```
