// A purely STATIC page — no hooks, no event handlers. denext detects this at
// build time and ships ZERO JavaScript for it (no bundle, no hydration script),
// yet it is still fully styled by Tailwind (CSS is not JS). View source: no
// <script> tags.
import type { PageProps } from "denext/server";

export const metadata = { title: "denext + Tailwind — About" };

export default function About(_props: PageProps) {
  return (
    <article class="space-y-6">
      <h1 class="text-3xl font-bold tracking-tight">About this example</h1>
      <p class="text-slate-400">Styled with Tailwind. No PostCSS, no npm.</p>
      <p class="text-slate-400">denext compiles it from one import line.</p>
      <p class="text-slate-400">This page has no interactivity.</p>
      <p class="text-slate-400">So denext ships zero JavaScript for it.</p>
      <p class="text-slate-400">Still fully styled, though: CSS is not JS.</p>
      <div class="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5 text-sm text-emerald-200">
        View source on this page: there are no script tags.
      </div>
    </article>
  );
}
