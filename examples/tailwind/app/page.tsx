// Home page. Uses a hook, so denext server-renders it AND hydrates it into an
// interactive component — all styled with Tailwind utility classes.
import { useState } from "denext";
import type { PageProps } from "denext/server";

export const metadata = { title: "denext + Tailwind — Home" };

const FEATURES: Array<[string, string]> = [
  ["Zero npm", "Tailwind v4 standalone, downloaded and run by denext."],
  ["Tiny bundles", "~7.5 KB first load; static pages ship 0 JS."],
  ["Secure by default", "Same-origin Server Actions, SSRF-safe images."],
];

export default function Home(_props: PageProps) {
  const [count, setCount] = useState(0);

  return (
    <section class="space-y-12">
      <div class="space-y-4">
        <span class="inline-block rounded-full bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-300 ring-1 ring-inset ring-sky-500/20">
          Tailwind CSS v4 · zero npm
        </span>
        <h1 class="text-4xl font-bold tracking-tight sm:text-5xl">
          Next.js-style DX, <span class="text-sky-400">Deno-native</span> speed.
        </h1>
        <p class="max-w-xl text-lg text-slate-400">
          This page is server-rendered and hydrated by denext's own tiny
          React-equivalent — styled entirely with Tailwind utilities that denext
          compiles for you from one <code class="text-sky-300">@import</code>
          {" "}
          line.
        </p>
      </div>

      <div class="flex items-center gap-4">
        <button
          type="button"
          onClick={() => setCount((c) => c + 1)}
          class="rounded-lg bg-sky-500 px-5 py-2.5 font-medium text-white shadow-lg shadow-sky-500/20 transition hover:bg-sky-400 active:scale-95"
        >
          Clicked {count} {count === 1 ? "time" : "times"}
        </button>
        <span class="text-sm text-slate-500">← hydrated &amp; interactive</span>
      </div>

      <div class="grid gap-4 sm:grid-cols-3">
        {FEATURES.map(([title, body]) => (
          <div
            key={title}
            class="rounded-xl border border-white/10 bg-white/5 p-5"
          >
            <h3 class="font-semibold">{title}</h3>
            <p class="mt-1 text-sm text-slate-400">{body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
