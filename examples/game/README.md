# denext × Three.js — "Rivet Rumble"

A small 3D game built on **[Three.js](https://threejs.org)** (WebGL — plain
JavaScript, not WASM) running on denext, bundled through the same next-compat
esbuild path that handles `motion` / `recharts`. It's an **original barrel-climber**
(an homage to the arcade climb-and-dodge genre) — climb the staggered girders,
hop the barrels the ape rolls at you, and rescue the cat at the top.

```sh
deno task example:game          # build once, serve → http://localhost:3005
deno task example:game --dev    # rebuild on each request
```

Controls: **← →** move · **↑ ↓** ladders · **Space** jump (plus on-screen touch
controls on mobile).

## What it shows

- **A real, heavy npm library on denext.** `three` is imported normally and runs
  client-side; SSR renders the shell, and a `useEffect` boots the WebGL scene after
  hydration. Vanilla Three.js is used imperatively — **not** react-three-fiber,
  which needs `react-reconciler` (denext has its own reconciler).
- **React owns the state, the library owns the surface.** denext/React renders the
  HUD, overlays, and touch controls and holds the score/lives/game-state; the engine
  (`app/engine.ts`) owns the canvas, physics, and render loop. They talk through a
  small callback API — the common real-world pattern for embedding a canvas library.
- **Procedural audio** (`app/audio.ts`) — all sound is synthesized with the Web
  Audio API (oscillators + noise + a short original chiptune loop). No audio files.

## Files

```
serve.ts          builds the page (next-compat) + serves it and /assets/*
app/page.tsx      the React HUD, overlays, touch controls, and game wiring
app/engine.ts     the Three.js game: level, physics, barrels, render loop
app/audio.ts      Web Audio sound effects + music
public/assets/    textures + backdrop (bg.jpg, barrel.png, girder.png)
```

## Assets & attribution

Everything here is original. Characters are built from low-poly primitives; the
textures and night backdrop in `public/assets/` were generated with an image model
and are used as generic materials. No third-party game's characters, sprites,
levels, or music are reproduced. `.denext/`, `node_modules/`, and build output are
generated and git-ignored.
