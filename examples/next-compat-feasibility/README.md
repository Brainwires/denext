# denext conversion feasibility — dependency validation

Two probes that answer one question for a real Next.js app: **would its
dependency tree run on denext?** They validate dependencies only — they do not
convert the app.

> **Going further than the probes:** `convert.ts` + `verify-dropin.sh` actually
> _convert and run_ a real third-party app end-to-end (clone → `package.json`→
> `deno.json` → build → render), recording exactly where drop-in holds. See
> [The drop-in verifier](#the-drop-in-verifier-convertts--verify-dropinsh)
> below. Its successor is the **migration beds** (`tests/migration-bed/`; from
> the repo root: `denext task test:migration-bed`): SHA-pinned real apps
> cloned, run through `denext migrate`, built, served and render-asserted on
> every e2e.yml run — the same walk, with the real `migrate` command and a
> failing test instead of a report table.

> **Status update (superseded):** the punch-list findings below —
> including the "dual-React at SSR" blocker (#6) — have since been **resolved**.
> `denext migrate` shipped as a real CLI command (`denext migrate <app>`), and
> the next-compat build rewrites `react`→denext for **server-loaded** modules
> too, so an unmodified Next.js App Router app now builds and runs on denext's
> single React. The stage table and verdict below are a **dated point-in-time
> record** (the `convert.ts` prototype that motivated `denext migrate`); see
> [Migrating from Next.js](https://denext.dev/docs/migrating) for the current,
> authoritative status of the next-compat drop-in path.

- **`probe-server.ts`** — imports each server-only Node dependency under Deno's
  `node:` compatibility layer. A clean import means no top-level Node-API
  incompatibility (the biggest, cheapest blocker to rule out).
- **`probe-client.ts`** — bundles each client React library through denext's
  next-compat esbuild pipeline (`react`/`react-dom`/`react-is` aliased to
  denext's single React) against the app's installed `node_modules`. A clean
  bundle means the library and its transitive deps resolve onto denext's React
  with no duplicate-React or missing-export breakage.

Run both from the denext repo root:

```sh
# server deps (edit PACKAGES in the file to match the app)
denext run -A --node-modules-dir=auto examples/next-compat-feasibility/probe-server.ts

# client deps (pass the app's root dir; it must already have node_modules)
denext run -A --config deno.json examples/next-compat-feasibility/probe-client.ts /path/to/app
```

## Results — a large production app (Next 15.5 / React 19)

Run against a real-world Next.js codebase — **90 pages, 188 API routes, 201
`use server` files, 192 client components**, middleware, i18n, a Capacitor
native app, and Docker deploy.

### Server-only Node deps — 12/12 load ✅

`stripe` · `twilio` · `openai` · `@aws-sdk/client-s3` (673 exports) ·
`nodemailer` · `imapflow` · `mailparser` · `jose` · `bcryptjs` · `web-push` ·
`tar` · `@simplewebauthn/server`

> Loading proves module init; raw-socket runtime behavior (e.g. `imapflow`'s
> IMAP TLS, `nodemailer` SMTP) still warrants a live smoke test during
> conversion.

### Client React libs — 25/25 bundle ✅

`recharts` (v3) · `sonner` · `vaul` · `cmdk` · `embla-carousel-react` ·
`input-otp` · `react-day-picker` · `react-resizable-panels` · `next-themes` ·
`react-markdown` · `prism-react-renderer` · `@simplewebauthn/browser` ·
`@stripe/stripe-js` · `class-variance-authority` · `tailwind-merge` ·
`tailwindcss-animate` · `@radix-ui/react-select` ·
`@radix-ui/react-dropdown-menu` · `@dnd-kit/sortable` ·
`@hookform/resolvers/zod` · `react-is` · `katex` · `fabric` ·
`@techstark/opencv-js` · `scribe.js-ocr`

(The full set of ~30 `@radix-ui/*` packages, `react-hook-form`, `lucide-react`,
and `@dnd-kit/core` were validated separately — see the `next-compat*` examples
and the e2e suite.)

`@techstark/opencv-js` and `scribe.js-ocr` `require("fs")`/`import "node:path"`
inside Node-only code paths; next-compat now stubs Node built-ins for the
**browser** target (the esbuild parallel to webpack's
`resolve.fallback: { fs: false }`), so they bundle.

### Remaining note — 1 native dep

| Dependency       | Issue                                      | Path forward                                                                 |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `better-sqlite3` | Native addon; will **not** load under Deno | Use denext's `better-sqlite3` → `node:sqlite` compat shim (already shipped). |

## Verdict

**Ready to attempt a conversion.** The dependency surface is fully compatible:
every server SDK loads under Deno's node: compat, and **all 25/25** client
libraries bundle on denext's single React with zero code changes.
`better-sqlite3` (the one native dependency) maps to the existing `node:sqlite`
shim.

The remaining unknowns are architectural, not dependency-based: 188 API routes +
201 server actions + middleware + i18n + the Capacitor target are a large
surface to port and must be validated with live dev/prod testing during the
conversion itself.

## The drop-in verifier (`convert.ts` + `verify-dropin.sh`)

Where the probes stop at "deps would load/bundle," this harness answers the real
question — **can you clone an unmodified third-party Next.js app and run it on
denext?** — reproducibly.

- **`convert.ts`** — the prototype `package.json` → `deno.json` converter that
  motivated the now-shipped `denext migrate` CLI. Aliases the react/next family
  onto denext (via denext's own `deno.json` exports), adds the `denext/*`
  self-specifiers the generated bundles import, translates `tsconfig.json`
  `paths` (e.g. `@/*`), passes other deps through as `npm:name@version`, drops
  dev-tooling + denext no-ops (`sharp`, `eslint-config-next`), flags
  hard-unsupported natives, and emits a next-compat page manifest from the App
  Router tree.
  From the repo root (`--denext .` points at this checkout):
  ```sh
  denext run -A examples/next-compat-feasibility/convert.ts \
    --app /path/to/next-app --denext . --write
  ```
- **`verify-dropin.sh`** — clone (`APP_REF`, default `main`; pin a SHA to
  reproduce) → `npm install` → `convert.ts` → `deno check` → `denext build` →
  start + curl the homepage on port 8912. Every stage is logged under
  `$TMPDIR/denext-dropin/<app>/logs`; the verdict lands in `REPORT.md` next to
  the script. It needs `git`, `curl` and a `deno` on `PATH` (or `DENO_BIN`;
  `denext runtime link` provides one); `npm` is optional. `SKIP_SETUP=1` reuses
  an earlier clone, `OUT` moves the work dir, `DENEXT` points at another
  checkout.
  ```sh
  bash examples/next-compat-feasibility/verify-dropin.sh
  # swap the app:
  APP_NAME=commerce APP_REPO=https://github.com/vercel/commerce.git APP_REF=<sha> \
    bash examples/next-compat-feasibility/verify-dropin.sh
  ```

A `deno-wrap.sh` shim once injected `--unstable-sloppy-imports` into denext's
child `deno` calls; punch-list item #1 below made it unnecessary, and it has been
removed.

### Recorded result (historical)

Target: `shadcn-ui/next-template` @ `d117bd0`. Conversion is **fully
automatic**. Progress driven by fixing each reproduced failure and re-running
(the table is the record at the time; item 6 has since been resolved, see the
status update above):

| Punch-list item                                                                                 | Status                                                                                        |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1. Propagate `--unstable-sloppy-imports` to child `run`/`info`/`bundle` (+ preserve `unstable`) | ✅ fixed — `build` now PASSES                                                                 |
| 2. CSS imports (`@/…css` / `./…css`) resolve to shims at SSR                                    | ✅ fixed — canonical paths + alias-form redirects + mirror into the app's own resolved config |
| 3. Bare-`next` barrel (`import { Metadata } from "next"`)                                       | ✅ fixed — `src/compat/next/index.ts`                                                         |
| 4. `next/font/google` families (e.g. `JetBrains_Mono`)                                          | ✅ common families added (full generation is a follow-up)                                     |
| 5. React DOM prop types for the compat path                                                     | ⏳ `check` stage (types-only)                                                                 |
| **6. Dual-React at SSR (the fundamental boundary)**                                             | ❌ **open** — see below                                                                       |

**The blocker at the time (dual-React at SSR, since resolved).** With the above fixed, an
unmodified app builds and renders the framework/CSS/fonts, then crashes with
`Cannot read properties of null (reading 'useContext')` originating in
`node_modules/react/*/cjs/react.development.js`. Cause: an app npm React library
(here `next-themes`) imports the **real npm React** at SSR rather than denext,
because Deno's managed npm resolution binds an npm package's internal
`import "react"` to `node_modules/react`, ignoring the import-map alias. Result:
two Reacts, null dispatcher. denext's next-compat **build** already rewrites
these imports for the **client bundle**; the equivalent is needed for
**server-loaded** modules (or a `denext migrate` that shims `node_modules/react`
→ denext). This is the core "compatibility" work and is the gate to true
unmodified drop-in for any app using npm React UI libraries.

**Verdict at the time:** the pipeline (convert → build → serve framework SSR +
CSS + fonts) worked end-to-end; unmodified drop-in of an app that uses **npm
React UI libraries** was blocked only by the dual-React SSR boundary (#6), which
the next-compat build now handles. Re-run `verify-dropin.sh` to refresh
`REPORT.md`.
