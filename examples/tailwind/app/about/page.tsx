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
      <p class="text-slate-400">
        Everything here is Tailwind utility classes, compiled by denext from a
        single{" "}
        <code class="rounded bg-white/10 px-1.5 py-0.5 text-sky-300">
          @import "tailwindcss";
        </code>{" "}
        line — no PostCSS config, no{" "}
        <code class="text-slate-300">npm install</code>.
      </p>
      <p class="text-slate-400">
        This page has no interactivity, so denext serves it as pure HTML: it
        downloads{" "}
        <strong class="text-slate-100">zero JavaScript</strong>. The interactive
        home page, by contrast, hydrates its counter. Same app, per-route cost.
      </p>
      <div class="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5 text-sm text-emerald-200">
        Tip: run <code class="text-emerald-100">deno task build</code> then{" "}
        <code class="text-emerald-100">deno task start</code>, open this page,
        and view source — there are no <code>&lt;script&gt;</code> tags.
      </div>
    </article>
  );
}
