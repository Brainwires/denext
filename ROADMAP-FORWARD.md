# denext — Roadmap Forward (post-1.0 strategy)

> Status: strategy document, written 2026-08-15, denext **cutting 1.0.0** (a
> couple commits out). This is the product/go-to-market roadmap. The engineering
> checklist (formerly ROADMAP-1.0.md) has been **retired** — its slate shipped;
> the few deliberately-deferred items are absorbed into §2.5 below. This doc
> answers "why anyone adopts it, and in what order we earn that."
>
> It is grounded in four parallel research passes (Aug 2026): why developers
> leave/stay with Next.js; what the Deno platform uniquely enables + the Fresh
> landscape; an honest inventory of denext's adoption gaps; and what has
> actually made new JS frameworks break through (vs. the technically-excellent
> ones that died). Sources are cited inline where a claim is load-bearing.

---

## 1. The one decision everything hangs on

**Stop selling "Next.js, but on Deno." Start selling "the Next.js you know, with
nothing from npm underneath it."**

The research is unambiguous on why this matters:

- **"Next.js compatibility on Deno" is a race we lose to real Next.js.** As of
  late 2024 Deno Deploy runs genuine Next.js SSR via npm compat, and
  `deno
  desktop` (2.9) compiles a real Next.js app to a binary. So the
  informed reader's first reaction to a compatibility pitch is _"why a clone
  when I can run the real thing on Deno with the real ecosystem?"_
  Compatibility, framed as the headline, is a solution to a solved problem.
- **The one thing neither real-Next-on-Deno nor Fresh can offer is a zero-npm
  dependency tree.** Real-Next-on-Deno drags the full npm tree; Fresh ships
  Preact + npm-compat. denext's own-React reimplementation is the _only_ reason
  the zero-dependency claim is real — and 2025's npm supply-chain attacks
  (chalk/debug across ~2.6B weekly downloads; the Shai-Hulud worm) made it
  emotionally urgent, not just architecturally tidy.
- **Compatibility is the _on-ramp_, not the pitch.** Compatibility-as-migration
  is the single most reliable growth pattern in JS tooling (Vite off CRA's
  deprecation, Bun/Deno-2 off Node compat, Preact off the React alias). We keep
  it — as the thing that makes _trying_ denext free — while the wedge that makes
  people _want_ to is the auditable, tiny, dependency-free output.

**Positioning line to standardize** (README H1, JSR, the post):

> _A Next.js-compatible web framework for Deno with a zero-npm runtime — the
> familiar App Router API, ~10× smaller output, and a dependency tree you can
> actually audit. One unified stack, no Vercel lock-in._

Everything below serves this pivot.

---

## 2. Where we stand (honest baseline, cutting 1.0.0)

**Strong and mature:** own fiber reconciler (time-sliced, interruptible),
streaming SSR, App Router (parallel/intercepting/route groups), RSC/Flight soft
navigation, **PPR + `"use cache"`** (Next's newest surface), Server Actions,
Fast Refresh, dev error overlay, next/image (Next-16 aligned), next-intl,
Tailwind + CSS Modules, security hardening (default CSP, SSRF-safe image opt,
same-origin actions), strong TS types, and honest docs
([KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md)). ~915 tests over ~27.5k LOC.

**The adoption blockers — the "product plumbing" a Next dev assumes.** Several
have since shipped (see **[FEATURES.md](./FEATURES.md)**); what shipped and what
remains:

- ✅ **Auth** — `getSession()` signed-cookie sessions; cookies default to
  `secure`/`httpOnly`/`sameSite`; end-to-end in
  [`examples/notes`](./examples/notes).
- ✅ **DB story** — [DATABASE.md](./DATABASE.md): zero-npm `node:sqlite` + Deno
  KV (tested), Postgres/Drizzle documented, Prisma called out as untested.
  `examples/notes` uses SQLite for real. _Remaining:_ a proven Postgres example
  under load.
- ✅ **Deploy recipes** — Docker / Deno Deploy / self-host in
  [DEPLOYMENT.md](./DEPLOYMENT.md) §0.
- ✅ **App-testing** — `denext/testing` (`createTestApp` + `createTestClient`),
  with a CI test that drives `examples/notes` entirely JS-disabled.
- ✅ **Component-testing** — `denext/testing`'s `render`/`fireEvent`: mount a
  component with real hooks/effects/events in an in-memory DOM, with
  Testing-Library-style queries.
- ✅ **Docs site** — [`examples/docs`](./examples/docs), a denext app
  static-exported to pure HTML (0 KB JS per page); dogfoods the zero-JS claim.
  _Remaining:_ hosting + expanding coverage.
- ⚠️ **Plugin ecosystem** (contract exists, no third-party plugins) — still
  open.
- ✅ **Migration codemod** — `denext codemod` rewrites `next/*`+`react` imports
  to native denext (drop-in via `denext migrate` still works too). _Remaining:_
  a rendered-app conformance probe (the "90 pages probed clean" figure is still
  a module-_load_ probe, not a rendered app — verify or restate).
- ⚠️ **LLM-writability** — [AGENTS.md](./AGENTS.md) gives models the denext
  delta, but they still default to emitting Next; a growing adoption gate
  in 2026.

---

## 2.5 Post-1.0 engineering backlog

The 1.0 engineering slate shipped (see **[FEATURES.md](./FEATURES.md)** for
what's supported). What remains, deferred and documented in
KNOWN-LIMITATIONS.md:

- **PPR on Flight / client-island routes** — today they fall through to the
  normal render; needs a two-pass postpone-aware Flight renderer + client hole
  reconciliation.
- **Cache Components hardening** — bounded eviction for the SQLite/KV cache
  stores, and soft-expire (`expireByTag`) on the persistent backends (in-memory
  has both).
- **DevTools depth** — hooks/state + context inspection, override hooks/props,
  the Profiler tab, source links/owner stacks (version-sensitive; hard to
  CI-test).
- **Build-time deps** — migrate `lightningcss`/`swc`/`esbuild` off npm to
  first-party JSR builds (build-time only; no runtime-claim impact).
- **Typed routes** — generate a typed route map from the file-based manifest so
  `<Link href>`, `useParams`, `redirect`, and `router.push` are checked against
  the routes that actually exist (Next.js `experimental.typedRoutes`). A build
  step emits a `.d.ts` union of valid paths + per-route param shapes; broken
  links and missing params become compile errors, not 404s. Low risk (build-time
  only, no runtime cost).
- **Typed Server Actions / built-in RPC** — denext owns both sides of the
  RSC/action boundary, so it can infer a Server Action's input/output types
  **client↔server with zero codegen** (plus typed `revalidateTag`/cache tags,
  complementing typed routes above): tRPC-grade DX baked in, no library to add.
  Next.js types actions only within a module and has no first-party typed API
  layer — this is a pure-DX flagship the architecture uniquely enables. Medium
  effort.
- **RSC / cache glass-box devtools** — since denext owns the cache and Flight,
  ship a live panel: what's cached, which `revalidateTag` invalidated what, why
  a boundary re-rendered, the RSC/Suspense waterfall, with `<Live>` boundaries
  lighting up in real time. Next.js caching is famously opaque; making it
  observable turns objection #8 ("cloned the parts people hate — RSC/caching")
  into a selling point. Medium effort.
- **Full resumability (zero-hydration)** — see
  [RESUMABILITY.md](./RESUMABILITY.md) for the complete deferred plan: serialize
  handlers + state so the client never re-executes the tree (interactive at ~0
  ms, JS per subtree loaded on interaction). The biggest moat — React/Next
  structurally can't — but multi-month/research-grade (needs a build transform +
  a signals-based state model). Island-level lazy hydration is the stepping
  stone.

---

## 3. The objections, and how the roadmap answers each

The real question isn't "why switch" — it's "why would someone bounce in the
first thirty seconds." Ranked by fatality, with the roadmap item that blunts it.

| #  | "Not interested" reason                            | Fatality | Neutralized by                                                                |
| -- | -------------------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| 1  | It's a React _reimplementation_, not React (trust) | Fatal    | Parity-test matrix + honesty docs (Phase 3)                                   |
| 2  | Deno already runs _real_ Next.js — why a clone?    | Fatal    | The positioning pivot §1 + zero-npm demo (Phase 1)                            |
| 3  | Compatibility is a promise only partly kept        | High     | Tested compat matrix (Phase 0) + measured punch-list (§3.5)                   |
| 4  | No auth / DB / deploy recipes (batteries)          | High     | Phase 2 — **auth shipped (1.1: `denextAuth`)**; DB + deploy adapters next     |
| 5  | Solo / bus-factor / longevity                      | High     | Normalize + de-risk structurally (Phase 3)                                    |
| 6  | Deno itself is a gate (small market)               | High     | Ride Deno-2 growth; don't bet on it replacing Node                            |
| 7  | LLMs write Next, not denext                        | Med-High | `llms.txt` + model-ingestible docs (Phase 3)                                  |
| 8  | We cloned the parts people hate (RSC/caching)      | Med      | Make caching/RSC _observable_ (Phase 3)                                       |
| 9  | No hiring pool / Googleability                     | Med      | Time + docs + community (Phase 4)                                             |
| 10 | Migration is really greenfield                     | Med      | Measured NOT-YET (§3.5); `denext migrate` + punch-list make it real (Phase 2) |

Note the trap: denext structurally resembles the frameworks that _failed_ (Aleph
= "the Next for Deno," one dev, archived July 2025 pointing users to Fresh) on
two axes — runtime lock-in and a tautological "X for Deno" pitch. The escape
from Aleph's fate is exactly Deno-2's npm bridge + our compatibility on-ramp: we
are not asking anyone to abandon their ecosystem.

---

## 3.5 Drop-in reality check — measured, then DELIVERED (2026-08-16)

We built a reproducible harness (`examples/next-compat-feasibility/`:
`convert.ts`

- `verify-dropin.sh`) and drove a real third-party App Router app —
  **`shadcn-ui/next-template` @ `d117bd0`** (Radix + next-themes + Tailwind +
  lucide, no secrets) — through migrate → build → start/dev → render.

**Update (2026-08-16): drop-in is now REAL for App Router apps.** The
next-compat pipeline was integrated into denext core
(`denext build`/`start`/`dev` + a `denext migrate` CLI). An unmodified
shadcn-ui/next-template now SSR-renders and hydrates on denext's **single**
React (server bundle: 0 real-React signatures; client bundle: 0 real-React +
`hydrateRoot`), with the full `next/*` surface, correct metadata, and the full
denext suite green. See the commits on `v-1.0` and the delivered stages below.

**Update (2026-08-16, Stage 4b — DELIVERED): RSC/Flight boundary preserved in
compat.** The last boundary is closed. A compat route reaching a `"use client"`
island now renders its Server Components **server-side only** and hydrates
**just the islands** via a react→denext-rewritten flight bundle — so async
data-fetching Server Components (`await db.query()`) work in a compat route
(verified on shadcn-ui/next-template + an async server-component route: the
server-only code is absent from every client asset; islands hydrate under the
same stable client ids the server tags; 908 denext tests green, prod **and**
dev). Islands stay separately-loadable (each its own build entry → one shared
runtime chunk), which is what makes island identity hold across the react→denext
rewrite. The rest of this section records the original measured gaps (all now
closed).

**Original verdict (superseded): drop-in was NOT REAL YET.** The mechanism was
sound (conversion fully automatic; a forced-fix build reached SSR), but an
_unmodified_ clone stopped at **build**, then a short chain of small compat
gaps.

| stage                                | status (unmodified app)                   |
| ------------------------------------ | ----------------------------------------- |
| clone                                | ✅                                        |
| convert (`package.json`→`deno.json`) | ✅ **fully automatic, zero hand-editing** |
| `deno check`                         | ❌ React DOM type surface incomplete      |
| `denext build`                       | ❌ stops at blocker #1 below              |
| render                               | ⛔ (blocked by build)                     |

**The good news — conversion is the strong part.** `convert.ts` handled the
whole `package.json`→`deno.json` step with no hand-editing: aliased the
react/next family onto denext (via denext's own `deno.json` exports), added the
`denext`/`denext/client`/… self-specifiers denext's generated bundles import,
**translated `tsconfig.json` `paths`** (`@/*` → an absolute trailing-slash dir),
passed other deps through as `npm:name@version`, dropped dev-tooling +
denext-provided no-ops (`sharp`, `eslint-config-next`), and flags
hard-unsupported natives. This proves a **`denext migrate` command is warranted
and achievable**; `convert.ts` is a working prototype of it.

**The punch-list between denext and real drop-in** (ordered by when it bites —
all denext-side, all small):

1. **`sloppy-imports` not propagated (the #1 build blocker).** Next apps use
   extensionless imports everywhere. denext re-execs a child `deno run … build`
   and shells to `deno info --json` (`src/build/module-graph.ts`) and
   `deno bundle` — none with `--unstable-sloppy-imports` — and its merged temp
   config (`src/build/bundle.ts` `prepareConfig`) _drops the app's `unstable`
   field_. Fix: add the flag to child `run` + `info` + `bundle` and preserve
   `unstable`. Without this, **no unmodified Next app builds.**
2. **CSS side-effect imports crash SSR.** `import "@/styles/globals.css"` in a
   layout → `TypeError: Expected a JS/TS module … identified a Css module`.
   denext's server route dynamic-import must no-op CSS imports (universal in
   Next layouts).
3. **Bare `"next"` specifier unmapped.** `import { Metadata } from "next"` —
   denext ships only `next/*` shims; needs a bare-`next` barrel.
4. **`next/font/google` incomplete.** Real Next exposes every font family;
   denext ships a subset (`JetBrains_Mono` was missing). Generate the full set.
5. **React DOM prop types incomplete.** shadcn `button.tsx` fails type-check:
   missing `ButtonHTMLAttributes`, `forwardRef` generic arity, `displayName`,
   `VariantProps` flow. Types-only (runtime may work) but breaks editor typing
   for real component libs.

**Verified update (2026-08-15, after landing fixes).** Driving the harness fix →
re-run: items 1–4 are **fixed and verified** (build passes; CSS, bare-`next`,
and common fonts resolve at SSR), item 5 (types) remains at the `check` stage.
Fixing them exposed the **fundamental blocker** the earlier gaps were masking:

- **Dual-React at SSR.** An unmodified app now builds and renders the
  framework/CSS/fonts, then crashes with `useContext` on `null` from
  `node_modules/react/*`. An app npm React library (`next-themes`) imports the
  **real npm React** at SSR instead of denext, because Deno's managed npm
  resolution binds an npm package's internal `import "react"` to `node_modules`,
  ignoring the import-map alias → two Reacts, null dispatcher. denext's
  next-compat **build** already rewrites these for the **client bundle**; the
  same is needed for **server-loaded** modules (or a `denext migrate` that shims
  `node_modules/react` → denext). This is the core "compatibility" work and the
  real gate to unmodified drop-in for any app using npm React UI libraries.
- **Also learned:** Deno resolves an app module's imports via the deno.json
  discovered next to it, not denext's re-exec `--config` — so denext must mirror
  generated redirects (CSS shims, and eventually the react alias) into the app's
  own resolved config. (Fixed for CSS.)

**Strategy consequence:** the "point it at your Next repo and it just runs"
framing is **not true yet — do not put it in the post.** The honest,
still-strong line is _"an automated converter plus a short, known list of compat
fixes away."_ The single remaining hard problem is dual-React at SSR; closing it
(next-compat for server modules, or a react-shim `denext migrate`) is what makes
the try-with-zero-cost adoption move real. See Phase 1/2.

## 4. Phased plan

### Phase 0 — Before the post or the 1.0 cut (days)

Cheap moves that neutralize instant-dismissal objections.

1. **Adopt the positioning pivot (§1)** in README hero, JSR description, and the
   r/Deno post. Demote "compatible" to the on-ramp line.
2. **~~Reconcile ROADMAP-1.0.md~~ — DONE.** The engineering checklist has been
   **retired**: its slate shipped, and the few deferred items are absorbed into
   §2.5 above. (KNOWN-LIMITATIONS.md remains the honest current-state doc.)
3. **~~Verify the drop-in claim~~ — DONE (see §3.5).** Measured: unmodified
   drop-in is **not real yet**; it stops at build (sloppy-imports) then a short
   compat chain. Do not claim "just runs" in the post. The fixes are small and
   denext-side (§3.5 punch-list) → they become Phase-1/2 work, and closing them
   unlocks the killer demo.
4. **Publish a tested compatibility matrix** ("these exact libraries@versions,
   verified by e2e") to replace "a fair amount of Radix/shadcn." Precision kills
   the "I won't know until it breaks" objection.

### Phase 1 — Make the wedge concrete and demoable (the 1.0 story)

The wedge only lands if it's _shown_. Lead with one felt-pain number, backed by
a reproducible repo — the number is the wow, the repo is the credibility.

1. **The supply-chain / single-binary demo.** `deno compile` / `deno desktop` →
   a signed, tiny binary with an essentially-zero dependency tree, side-by-side
   against the same app on real Next.js (which drags the full npm tree). The
   **size + dependency-count delta is the proof point** — `deno desktop` gives
   competitors a single-binary story too, so the _delta_, not the capability, is
   what's defensible. Track it as a number in the bench suite. The productized
   form of this is a **`denext deploy` command with pluggable adapters** (single
   static binary via `deno compile`, a Docker image, Deno Deploy, a
   self-host/systemd unit) — one command from `app/` to a running server, with
   the concurrency ceiling and least-privilege permission set baked in. See the
   Phase 2 deploy row.
2. **A public, reproducible benchmark repo** — a real Next app ported to denext
   with the size/cold-start diff. This audience tears unbacked numbers apart;
   the repo is non-negotiable before the "~10×" claim goes in a title.
3. **The auditable narrative:** generate an SBOM / dependency count for a denext
   app vs. a Next app ("0 runtime npm deps vs. N hundred"). Post-2025, this is
   the emotionally urgent line. Productize it as **`denext audit`**: walk the
   resolved module graph, emit an SBOM (CycloneDX/SPDX) + a plain
   dependency-count headline, and flag anything reaching npm/remote hosts — the
   command that turns "zero-npm" from a claim into a report a security team can
   run in CI.
4. **Least-privilege by default:** ship and document a tight
   `deno run
   --allow-...` profile for `denext start`. The permission model
   only _means_ something because there's no dep tree demanding broad access —
   frame it as a consequence of the architecture. **`denext audit` also derives
   this set**: from the module graph it computes the minimal
   `--allow-net`/`--allow-read`/… flags an app actually needs and diffs them
   against what it's granted, so over-broad permissions surface as findings.

### Phase 2 — Close the adoption blockers (the batteries)

Without these, the honest market is "greenfield, SQLite, roll-your-own-auth,
operate-Deno-yourself" — too narrow to matter. Ranked.

| Priority  | Gap                               | Minimum viable close                                                                                                                                                                                                                                                                                                                                               |
| --------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P0** ✅ | Auth                              | **Shipped (1.1):** first-party `denextAuth` — OAuth 2.0 / OIDC (PKCE) with Google/GitHub/generic-OIDC presets + a Credentials provider, auto-mounted `/auth/*`, signed `__Host-` sessions, `auth()`/`requireAuth()` + client `useSession`/`signIn`/`signOut`. Remaining: a DB-backed session store option + more provider presets.                                 |
| **P0**    | Deploy adapters + `denext deploy` | Pluggable **deploy adapters** behind one `denext deploy` command: a single static binary (`deno compile`), a Docker image, Deno Deploy, and a self-host/systemd unit — plus the walkthrough docs. Bake in the _required_ concurrency ceiling and least-privilege permission set as defaults, not homework. The productized form of the Phase 1 single-binary demo. |
| **P0**    | Drop-in compat punch-list (§3.5)  | Land the 5 measured fixes — (1) propagate `--unstable-sloppy-imports` to child `run`/`info`/`bundle` + preserve `unstable`, (2) no-op CSS side-effect imports in SSR, (3) bare-`next` barrel, (4) complete `next/font/google`, (5) fill React DOM prop types. This is what makes drop-in real.                                                                     |
| **P0**    | `denext migrate` command          | Productionize `convert.ts`: `package.json`→`deno.json` (react/next aliases + denext self-specifiers + tsconfig `paths` + dep classification/flagging) and emit the next-compat page manifest. Prototype already works.                                                                                                                                             |
| **P0**    | Drop-in demo                      | Once the punch-list lands: a one-command "port this Next app in minutes" flow (StackBlitz or CLI) with a live size diff. The single highest-leverage adoption move.                                                                                                                                                                                                |
| **P1**    | Data layer                        | Prove _one_ real Postgres path (Drizzle or native driver) with an example; position Deno KV as an app data store, not just cache.                                                                                                                                                                                                                                  |
| **P1**    | App-testing                       | A blessed component-testing helper + "how to test your denext app" doc.                                                                                                                                                                                                                                                                                            |
| **P1**    | Docs site                         | Even a generated site from the existing (high-quality) markdown. README-scale hurts at framework-scale.                                                                                                                                                                                                                                                            |
| **P2**    | CSS-in-JS correctness             | `useInsertionEffect` pre-mutation timing (verify shipped) so emotion/styled-components are trustworthy.                                                                                                                                                                                                                                                            |
| **P2**    | Ecosystem seeding                 | Opinionated starters, `denext add`-style integrations, a showcase page.                                                                                                                                                                                                                                                                                            |

### Phase 3 — Blunt the structural objections (ongoing)

These never fully disappear; the goal is to stop them being _instant_
dismissals.

- **Trust in the reimplementation (#1):** grow parity tests _named after_ the
  APIs we advertise; where feasible, run React's own test patterns against
  denext. The parity count + honesty docs are the only weapon here.
- **LLM-writability (#7):** publish `llms.txt` and a compact, model-ingestible
  API reference + a "denext for LLMs" doc, so assistants stop emitting Next when
  pointed at a denext project. Cheap and increasingly decisive.
- **The "cloned the parts people hate" trap (#8):** differentiate where we can —
  make caching/RSC **observable** (a dev overlay showing cache layers and PPR
  holes). Same semantics, better visibility, is a genuine edge.
- **Longevity (#5):** see §5.

### Phase 4 — Go-to-market / launch

Technical quality is table stakes — every framework that _failed_ was
technically excellent. Execution is the differentiator.

1. **Lead with ONE felt-pain number in the title**, ship the benchmark repo the
   same day. (Preact = "3kB"; Astro = "ship less JS"; Bun = speed. A number is
   an identity.)
2. **Answer "why not just use real Next?" on the first screen** — the guaranteed
   top comment. One-line rebuttal: _familiar Next API, ~10× smaller output, zero
   npm runtime deps, native Deno with no unstable flags and no Vercel lock-in._
   Never claim 100% compatibility; over-claiming is how you lose the room.
3. **Launch to a known recipe.** Warm crowd first (r/Deno), then a Show HN:
   plain factual title, working demo in seconds, present replying as a human for
   the first ~2 hours, Tue–Thu US morning, never solicit upvotes. Own the
   solo-builder narrative — it drives ~3× the engagement of a dry technical
   post.
4. **Target the honest market:** greenfield, Deno-friendly, bundle-size- and
   supply-chain-conscious teams, plus a **security/enterprise** angle (SBOM,
   auditability) where zero-npm is a compliance tiebreaker.
5. **Be the evangelist.** Every winner had a visible, responsive
   maintainer-evangelist; the quality frameworks that died (Marko, Aleph) did
   not. Talks, build-in-public, fast issue responses _are_ the marketing.
6. **Start the durability flywheel immediately:** public roadmap, a visible
   release/changelog cadence, and 1–3 named early-adopter sites as fast as
   possible. Trust is earned through consistency signals, not promises.

---

## 5. The biggest single risk — and how to neutralize it

**The bus-factor / "solo + niche runtime + why-not-real-Next" trust cluster** —
the exact combination that killed Aleph. Don't hide it; disarm it:

- **Normalize it.** Single-maintainer critical infra is the norm — ~10 of the
  top 30 npm projects have a bus factor of one (Express included).
- **De-risk structurally.** MIT (forkable if you vanish); **zero npm runtime
  deps is itself a bus-factor _reduction_** — fewer external points of failure,
  market it as such; public roadmap; visible cadence; a personal-stake narrative
  ("I depend on this and am in it long-term").
- **Cap-the-ceiling counter.** Frame denext as riding Deno-2's growth and its
  npm bridge — _not_ betting on Deno replacing Node — so a smaller runtime
  audience isn't a dead end.

---

## 6. What NOT to do

- Don't lead with "simpler than Next" — we reproduce the very APIs (RSC,
  four-layer caching, `use client`) people call complex; that claim is
  unwinnable and "complex" rarely drives migration anyway.
- Don't lead with Next-security-FUD — it reads as fearmongering and triggers
  dismissal. Zero-npm is a _positive_ architecture story, not an attack.
- Don't ship the "~10×" number without the reproducible repo behind it.
- Don't claim 100% React/Next compatibility — compat layers never reach parity,
  and the over-claim is how credibility dies on HN.
- Don't stall in a long alpha/beta — momentum dies in perpetual pre-1.0 (Fresh
  2.0's multi-year alpha is the cautionary tale). Cut 1.0.

---

## 7. Success signals to watch (not vanity metrics)

- **Trying → the repo/StackBlitz "port in minutes" flow gets run** (the action
  that precedes every migration).
- **Named early-adopter sites** (the durability flywheel; Fresh's weakness is
  showcases are all Deno's own properties).
- **Issue-response cadence** and release regularity (consistency > promises).
- **Inbound "does X library work?"** — a signal the compat matrix is the right
  battleground; answer each with a test, not prose.
- **A security/enterprise inbound** citing SBOM/audit — proof the wedge landed.

---

## Appendix — research provenance

Four parallel research passes (Aug 2026):

1. _Why devs leave/stay with Next.js_ — the loud complaints (complexity,
   caching, RSC) rarely convert; migration is tipped by one concrete, measured
   pain (build clock, hosting bill, p95). denext's real wedges are operational.
2. _Deno platform + Fresh landscape_ — zero-npm is the only claim unique vs.
   both real-Next-on-Deno and Fresh; prove it via `deno compile`/`deno desktop`.
   Aleph (the prior "Next for Deno") archived July 2025.
3. _denext gap inventory_ — auth, DB, deploy recipes, app-testing are the
   adoption blockers; core rendering/compat/security/types are mature.
4. _What drives adoption_ — one sharp felt-pain number; a migration on-ramp; a
   visible evangelist; a reason-to-believe-it'll-last; interactive onboarding;
   ecosystem seeding; a coordinated launch. Anti-patterns: solving an unfelt
   pain, the uncanny valley, broken escape hatch, bus factor, runtime lock-in,
   endless betas.
