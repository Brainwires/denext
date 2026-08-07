# Releasing a new version

denext publishes to [JSR](https://jsr.io/@denext/denext) via a GitHub Actions
workflow ([`.github/workflows/publish.yml`](./.github/workflows/publish.yml))
that runs on every `v*` tag and publishes **with build provenance** (OIDC).

So a release is: **bump → verify → commit → tag → push tag.** Pushing the tag is
what triggers the publish.

## Prerequisites (one-time)

- The JSR package `@denext/denext` exists and is **linked to this GitHub repo**
  in JSR package settings. That link is what allows Actions to publish via OIDC
  and is what records provenance.
- `publish.yml` is on `main` with `permissions: id-token: write`.

## Steps

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
