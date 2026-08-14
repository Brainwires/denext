# denext × motion + react-spring

Two real npm animation libraries — [`motion`](https://motion.dev) (motion.dev) and
[`@react-spring/web`](https://react-spring.dev) — **co-existing in one project**,
both running on denext's single React. Each is server-rendered to its initial state
and animates after hydration.

```sh
deno task example:animation          # build once, serve
deno task example:animation --dev    # rebuild on each request
```

Open <http://localhost:3003> — the motion card animates in on load (hover it to
scale); the react-spring card is a squishy pressable (press and hold it).

## What it exercises

- **`motion`** (framer-motion under the hood): `motion.div` with `initial`/`animate`/
  `whileHover`.
- **`@react-spring/web`**: `useSpring` + imperative `api.start`, driven by pointer
  events — a low-friction spring on `scale` for a squishy press-and-release.
- Both on denext's single React via the next-compat build — proving two independent
  animation libraries interoperate in the same bundle.

Getting these to run surfaced (and fixed) two real React-compat gaps in denext:
`useInsertionEffect` (motion injects styles with it) and `Context.Consumer`
(react-spring's `makeContext` assigns to `.Consumer`).
