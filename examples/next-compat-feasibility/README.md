# denext conversion feasibility — dependency validation

Two probes that answer one question for a real Next.js app: **would its dependency
tree run on denext?** They validate dependencies only — they do not convert the app.

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
