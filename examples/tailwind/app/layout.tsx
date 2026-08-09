// Root layout. denext supplies <html>/<head>/<body>; this renders the chrome.
// `./globals.css` is the Tailwind output denext compiles from styles/tailwind.css.
import "./globals.css";
import { Link } from "denext";
import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext + Tailwind",
  description: "A denext example styled with Tailwind CSS v4 — zero npm.",
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="min-h-screen bg-slate-950 text-slate-100 antialiased">
      <header class="border-b border-white/10">
        <nav class="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/" class="text-lg font-semibold tracking-tight">
            denext<span class="text-sky-400">+tw</span>
          </Link>
          <div class="flex gap-6 text-sm text-slate-400">
            <Link href="/" class="transition hover:text-slate-100">Home</Link>
            <Link href="/about" class="transition hover:text-slate-100">
              About
            </Link>
          </div>
        </nav>
      </header>
      <main class="mx-auto max-w-3xl px-6 py-16">{children}</main>
    </div>
  );
}
