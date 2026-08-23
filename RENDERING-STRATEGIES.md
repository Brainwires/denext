# Rendering Strategies in denext

How denext's rendering support compares to Next.js's App Router. **Short version:** every
Next.js rendering strategy is implemented in code — SSR, SSG/static, ISR, CSR, Streaming,
and PPR. The differences from Next.js are in **defaults and gating**, not missing features.

---

## Summary

| Strategy                       | Status                               | Notes                                                           |
| ------------------------------ | ------------------------------------ | --------------------------------------------------------------- |
| **Static / SSG**               | ✅ Full                              | Build-time pre-render of all pages                              |
| **SSR / Dynamic**              | ✅ Full                              | Per-request server render pipeline                              |
| **ISR**                        | ✅ Full                              | `revalidate`, tag/path revalidation, stale-while-revalidate     |
| **CSR / client-only**          | ✅ Full                              | `mode: "spa"` + `"use client"` islands                          |
| **Streaming SSR**              | ⚠️ Implemented, gated                | Opt-in behind `experimental.streaming`; disabled for CSP routes |
| **PPR (Partial Prerendering)** | ⚠️ Implemented, experimental + gated | Rides on `experimental.cacheComponents`; excludes Flight routes |

---

## Per-strategy detail

### 1. Static rendering / SSG — ✅ Supported

Pages are pre-rendered at build time. `generateStaticParams` is enumerated to expand
dynamic routes, and fully-static routes ship 0 KB of JS.

- `src/build/export.ts` — `staticExport()` pre-renders all pages; `generateStaticParams`
  handling; static-route classification.
- `export const dynamic = "force-static"` forces this path (`src/server/segment-config.ts`).

### 2. SSR / Dynamic rendering — ✅ Supported

Per-request server rendering, composing layouts, `loading`, and error boundaries.

- `src/server/app.ts` — buffered render pipeline.
- `src/server/render-page.ts` — `renderPage()` composition.
- `export const dynamic = "force-dynamic"` forces per-request rendering.

### 3. ISR (Incremental Static Regeneration) — ✅ Supported

Time-based and on-demand revalidation, backed by real cache stores.

- `revalidate` (seconds, or `false` for indefinite) honored via `src/server/segment-config.ts`.
- Stale-while-revalidate page cache in `src/server/cache.ts`.
- `revalidateTag`, `revalidatePath`, `unstable_cache` in `src/server/cache.ts` and
  `src/compat/next/cache.ts`.
- Cache backends: `src/server/sqlite-cache.ts`, `src/server/kv-cache.ts`.

### 4. CSR / client-only — ✅ Supported

Two distinct routes to client rendering:

- **Whole-app SPA** — `mode: "spa"` bundles a single client entry, no SSR/SSG/Flight
  (`src/build/spa.ts`, `src/build/export.ts` → `exportSpa`).
- **Client islands** — `"use client"` components inside the App Router, hydrated via Flight
  (`src/server/app.ts`).

### 5. Streaming SSR — ⚠️ Implemented, but gated

The streaming renderer is complete, but _incremental streaming as the response mode_ is opt-in.

- Renderer: `src/jsx/render-to-stream.ts` — `renderToReadableStream`, `renderShell` +
  `drainHoles`.
- `loading.tsx` → Suspense fallback (`src/server/render-page.ts`).
- **Gating:** incremental streaming requires `experimental.streaming` **and** is skipped for
  any route that emits a CSP — those fall back to buffered SSR (correct output, just not
  streamed) with a one-time warning (`src/server/app.ts`, `src/server/config.ts`).
- Because denext defaults to a strict CSP, streaming is effectively off unless you opt into
  both.

### 6. PPR (Partial Prerendering) — ⚠️ Implemented, experimental + gated

A full two-pass Partial Prerendering renderer exists (static shell + per-request hole resume),
shipped under Next 16's newer name, **Cache Components**.

- Renderer: `src/jsx/render-to-ppr.ts` — `prerenderToShell()`, `resumeShellHoles()`,
  `spliceShellHoles()`.
- Wired into the request pipeline in `src/server/app.ts`.
- **Gating:**
  - No standalone `ppr` / `experimental.ppr` config flag exists. It rides on
    **`experimental.cacheComponents`** (`src/server/config.ts`).
  - Only applies to pages that are already **cacheable** (opted in via `revalidate` /
    `force-static`).
  - **Not** applied to Flight / client-island routes — those explicitly fall through to
    normal rendering.

### 7. Route Segment Config exports — ✅ Supported (partial honoring)

Read by `readSegmentConfig` in `src/server/segment-config.ts`.

**Fully honored:**

- `dynamic` — `"auto"` | `"force-dynamic"` | `"force-static"` | `"error"`
- `dynamicParams`
- `revalidate`

**Accepted for source-compatibility but informational (no runtime effect):**

- `runtime`, `preferredRegion`, `maxDuration`, `fetchCache`

These are no-ops because denext runs in a single Deno runtime.

---

## Honest caveats

- **`dynamic = "error"`** is accepted but downgraded to `"auto"` behavior — it does **not**
  actually throw on dynamic-API use (`src/server/segment-config.ts`).
- **`fetchCache`** (per-route fetch-level cache control) is a no-op — ISR/`revalidate` caching
  works, but fine-grained `fetch()` cache directives are not independently honored.
- **`runtime = "edge"`** has no effect — there is no separate Edge runtime; everything runs in
  one Deno runtime. (This is the runtime-_environment_ axis, not a rendering strategy.)
- **SPA mode** (`mode: "spa"`) intentionally has no SSR/SSG/Flight
  (`KNOWN-LIMITATIONS.md`).

---

## Bottom line

On rendering **capability**, denext covers the entire Next.js App Router spectrum: SSR, SSG,
ISR, CSR, Streaming, and PPR are all really present in code. The distinction from Next.js is in
**defaults and gating** — Streaming (as a response mode) and PPR are experimental opt-ins
(and Streaming yields to CSP), whereas the settled strategies (SSR/SSG/ISR/CSR) work out of the
box. So: _does denext support all the rendering strategies Next.js does?_ — **Yes, with the
caveat that the two newest ones are opt-in/experimental rather than on by default.**

---

## Reference files

- `src/jsx/render-to-ppr.ts` — PPR / Cache Components renderer
- `src/jsx/render-to-stream.ts` — streaming SSR renderer
- `src/server/segment-config.ts` — route segment config parsing/honoring
- `src/server/app.ts` — request render pipeline (SSR, streaming, PPR, Flight)
- `src/server/render-page.ts` — page/layout/loading/error composition
- `src/server/cache.ts` — ISR page cache + tag/path revalidation
- `src/server/config.ts` — `experimental.streaming`, `experimental.cacheComponents`
- `src/build/export.ts` — static export / SSG + SPA export
- `src/build/spa.ts` — SPA mode bundling
- `FEATURES.md`, `KNOWN-LIMITATIONS.md`, `ROADMAP.md` — feature framing & scope docs
