// Home page: a Server Component styled with Tailwind utility classes. The counter is a
// "use client" component (./counter.tsx), so only it hydrates; the rest ships as HTML.
import type { PageProps } from "denext/server";
import { Counter } from "./counter.tsx";

export const metadata = { title: "denext + Tailwind — Home" };

const FEATURES: Array<[string, string]> = [
  ["Zero npm", "Tailwind v4 standalone, downloaded and run by denext."],
  ["Tiny bundles", "~7.5 KB first load; static pages ship 0 JS."],
  ["Secure by default", "Same-origin Server Actions, SSRF-safe images."],
];

export default function Home(_props: PageProps) {
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
          Server-rendered, then hydrated.
        </p>
        <p class="max-w-xl text-slate-400">
          Styled with Tailwind. Compiled by denext.
        </p>
      </div>

      <Counter />

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
