# denext conversion feasibility — dependency validation

Two probes that answer one question for a real Next.js app: **would its dependency
tree run on denext?** They validate dependencies only — they do not convert the app.

> **Going further than the probes:** `convert.ts` + `verify-dropin.sh` actually
> _convert and run_ a real third-party app end-to-end (clone → `package.json`→
> `deno.json` → build → render), recording exactly where drop-in holds. See
> [The drop-in verifier](#the-drop-in-verifier-convertts--verify-dropinsh) below.

- **`probe-server.ts`** — imports each server-only Node dependency under Deno's
  `node:` compatibility layer. A clean import means no top-level Node-API
  incompatibility (the biggest, cheapest blocker to rule out).
- **`probe-client.ts`** — bundles each client React library through denext's
  next-compat esbuild pipeline (`react`/`react-dom`/`react-is` aliased to denext's
  single React) against the app's installed `node_modules`. A clean bundle means the
  library and its transitive deps resolve onto denext's React with no duplicate-React
  or missing-export breakage.

```sh
# server deps (edit PACKAGES in the file to match the app)
deno run -A --node-modules-dir=auto examples/next-compat-feasibility/probe-server.ts

# client deps (run from the denext repo root; pass the app's root dir)
deno run -A --config deno.json examples/next-compat-feasibility/probe-client.ts /path/to/app
```

## Results — a large production app (Next 15.5 / React 19)

Run against a real-world Next.js codebase — **90 pages, 188 API routes, 201
`use server` files, 192 client components**, middleware, i18n, a Capacitor native
app, and Docker deploy.

### Server-only Node deps — 12/12 load ✅

`stripe` · `twilio` · `openai` · `@aws-sdk/client-s3` (673 exports) · `nodemailer` ·
`imapflow` · `mailparser` · `jose` · `bcryptjs` · `web-push` · `tar` ·
`@simplewebauthn/server`

> Loading proves module init; raw-socket runtime behavior (e.g. `imapflow`'s IMAP
> TLS, `nodemailer` SMTP) still warrants a live smoke test during conversion.

### Client React libs — 25/25 bundle ✅

`recharts` (v3) · `sonner` · `vaul` · `cmdk` · `embla-carousel-react` · `input-otp` ·
`react-day-picker` · `react-resizable-panels` · `next-themes` · `react-markdown` ·
`prism-react-renderer` · `@simplewebauthn/browser` · `@stripe/stripe-js` ·
`class-variance-authority` · `tailwind-merge` · `tailwindcss-animate` ·
`@radix-ui/react-select` · `@radix-ui/react-dropdown-menu` · `@dnd-kit/sortable` ·
`@hookform/resolvers/zod` · `react-is` · `katex` · `fabric` · `@techstark/opencv-js` ·
`scribe.js-ocr`

(The full set of ~30 `@radix-ui/*` packages, `react-hook-form`, `lucide-react`, and
`@dnd-kit/core` were validated separately — see the `next-compat*` examples and the
e2e suite.)

`@techstark/opencv-js` and `scribe.js-ocr` `require("fs")`/`import "node:path"` inside
Node-only code paths; next-compat now stubs Node built-ins for the **browser** target
(the esbuild parallel to webpack's `resolve.fallback: { fs: false }`), so they bundle.

### Remaining note — 1 native dep

| Dependency       | Issue                                      | Path forward                                                                 |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `better-sqlite3` | Native addon; will **not** load under Deno | Use denext's `better-sqlite3` → `node:sqlite` compat shim (already shipped). |

## Verdict

**Ready to attempt a conversion.** The dependency surface is fully compatible: every
server SDK loads under Deno's node: compat, and **all 25/25** client libraries bundle
on denext's single React with zero code changes. `better-sqlite3` (the one native
dependency) maps to the existing `node:sqlite` shim.

The remaining unknowns are architectural, not dependency-based: 188 API routes + 201
server actions + middleware + i18n + the Capacitor target are a large surface to port
and must be validated with live dev/prod testing during the conversion itself.

## The drop-in verifier (`convert.ts` + `verify-dropin.sh`)

Where the probes stop at "deps would load/bundle," this harness answers the real
question — **can you clone an unmodified third-party Next.js app and run it on
denext?** — reproducibly.

- **`convert.ts`** — prototype `package.json` → `deno.json` converter (and the
  spec for a future `denext migrate`). Aliases the react/next family onto denext
  (via denext's own `deno.json` exports), adds the `denext/*` self-specifiers the
  generated bundles import, translates `tsconfig.json` `paths` (e.g. `@/*`),
  passes other deps through as `npm:name@version`, drops dev-tooling + denext
  no-ops (`sharp`, `eslint-config-next`), flags hard-unsupported natives, and
  emits a next-compat page manifest from the App Router tree.
  ```sh
  deno run -A examples/next-compat-feasibility/convert.ts \
    --app /path/to/next-app --denext . --write
  ```
- **`verify-dropin.sh`** — clone (pinned) → `npm install` → `convert.ts` →
  `deno check` → `denext build` → start + curl the homepage. Every stage is
  logged; the verdict lands in `REPORT.md` next to the script.
  ```sh
  bash examples/next-compat-feasibility/verify-dropin.sh
  # swap the app:
  APP_NAME=commerce APP_REPO=https://github.com/vercel/commerce.git \
    bash examples/next-compat-feasibility/verify-dropin.sh
  ```

`deno-wrap.sh` is a temporary bridge that injects `--unstable-sloppy-imports`
into denext's child `deno` calls; it exists only until that flag is propagated
natively (punch-list item #1 below) and should then be deleted.

### Latest result

Target: `shadcn-ui/next-template` @ `d117bd0`. Conversion is **fully automatic**.
Progress driven by fixing each reproduced failure and re-running:

| Punch-list item                                                                                 | Status                                                                                        |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1. Propagate `--unstable-sloppy-imports` to child `run`/`info`/`bundle` (+ preserve `unstable`) | ✅ fixed — `build` now PASSES                                                                 |
| 2. CSS imports (`@/…css` / `./…css`) resolve to shims at SSR                                    | ✅ fixed — canonical paths + alias-form redirects + mirror into the app's own resolved config |
| 3. Bare-`next` barrel (`import { Metadata } from "next"`)                                       | ✅ fixed — `src/compat/next/index.ts`                                                         |
| 4. `next/font/google` families (e.g. `JetBrains_Mono`)                                          | ✅ common families added (full generation is a follow-up)                                     |
| 5. React DOM prop types for the compat path                                                     | ⏳ `check` stage (types-only)                                                                 |
| **6. Dual-React at SSR (the fundamental boundary)**                                             | ❌ **open** — see below                                                                       |

**The remaining hard blocker (dual-React at SSR).** With the above fixed, an
unmodified app builds and renders the framework/CSS/fonts, then crashes with
`Cannot read properties of null (reading 'useContext')` originating in
`node_modules/react/*/cjs/react.development.js`. Cause: an app npm React library
(here `next-themes`) imports the **real npm React** at SSR rather than denext,
because Deno's managed npm resolution binds an npm package's internal
`import "react"` to `node_modules/react`, ignoring the import-map alias. Result:
two Reacts, null dispatcher. denext's next-compat **build** already rewrites these
imports for the **client bundle**; the equivalent is needed for **server-loaded**
modules (or a `denext migrate` that shims `node_modules/react` → denext). This is
the core "compatibility" work and is the gate to true unmodified drop-in for any
app using npm React UI libraries.

**Verdict:** the pipeline (convert → build → serve framework SSR + CSS + fonts)
now works end-to-end; unmodified drop-in of an app that uses **npm React UI
libraries** is blocked only by the dual-React SSR boundary (#6). Re-run
`verify-dropin.sh` after each fix to watch the stage table advance.
