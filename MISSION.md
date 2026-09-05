# denext — Mission

> **Replace React and Next.js with a superior framework, written in Deno.**

Not a clone and not a port. denext gives developers the React and Next.js App
Router API they already know — that familiarity is the on-ramp, the thing that
makes _trying_ it free — and then beats the originals on the axes that actually
hurt. "Superior" is concrete, and it's the whole job:

1. **A smaller, auditable, zero-npm runtime.** Two wins in one architecture. It
   ships **less JavaScript** — its own small React-compatible core instead of the
   full framework, ~7× smaller output, **0 KB JS on a static route**, and
   single-binary-capable builds — _and_ it carries **no npm tree** (deps from JSR +
   WASM, web standards all the way down), so the whole thing is auditable end to
   end. Smaller bundles are the felt-pain plug; the zero-npm supply-chain story is
   the claim neither real-Next-on-Deno nor Fresh can make — and 2025's npm attacks
   made it urgent, not just tidy. **First-party Rust→WASM is on-brand, not an
   exception.** denext's own codecs — `@denext/photon`, `@denext/avif`, `@denext/og` —
   ship as JSR packages built from source _we_ own and audit; they are **not** npm
   dependencies, and owning the Rust source and the `.wasm` we vendor makes the stack
   _more_ auditable, not less. (Where the runtime already gives us a real engine — e.g.
   Deno's built-in `node:sqlite` — we use it directly.) Zero-npm means no opaque npm tree
   — it never meant "no compiled code."
2. **Secure by default — off Next's framework-CVE treadmill.** Next ships a steady
   stream of framework-level CVEs — middleware auth-bypass (CVE-2025-29927), SSRF
   via image optimization, cache poisoning, DoS. denext closes those classes **by
   construction**: a **strict hash-based CSP by default** (even on streamed
   responses), **SSRF-safe image optimization**, **same-origin, CSRF-defended
   Server Actions**, **signed `httpOnly`/`secure`/`sameSite` cookies**, and a
   **least-privilege Deno permission sandbox** around the whole runtime — on top of
   the zero-npm tree (Pillar 1) that erases the supply-chain CVE surface entirely.
   Fewer moving parts, fewer footguns, far fewer 2 a.m. patch scrambles. For a
   security-conscious or enterprise team, this alone is the reason to switch.
3. **Capabilities React's architecture structurally can't ship.** Owning the
   reconciler, the Flight boundary, and the cache lets denext do what Next can't
   without a rewrite: **Live Server Components** (server-push over WebSocket),
   **resumability** (interactive with no up-front hydration), and **true islands**
   (per-component lazy hydration). Superior isn't only "smaller" — it's "does more."
4. **One cargo-class tool for all of React.** SPA, App Router, unmodified-Next
   migrations, and desktop — a single binary from `create` to a packaged app, with
   DX good enough to choose on its own. This is the whole of **2.0**; see
   [ROADMAP.md](./ROADMAP.md).
5. **Honest compatibility as the on-ramp — never the headline.** We reproduce the
   React/Next _surface_ so migration is nearly free, and we **never claim 100%
   parity**. Compat gets people in the door; superiority is why they stay.

---

The familiar API is the on-ramp; being genuinely **smaller, more secure, more
capable, and nicer to use** is the mission. Lead with the felt pain (bundle size,
the CVE treadmill) to get in the door; close with the capabilities and the one-tool
DX to make it memorable.

**See also:**
[ROADMAP.md](./ROADMAP.md) — the pending engineering gap to this mission (the 2.1 cycle) ·
[FEATURES.md](./FEATURES.md) — what's already shipped ·
[ARCHITECTURE.md](./ARCHITECTURE.md) — the deliberate under-the-surface choices ·
[KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) — the honest surface gaps ·
[KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md) — deliberate behavioral differences ·
[SECURITY.md](./SECURITY.md) — how to report a vulnerability.
