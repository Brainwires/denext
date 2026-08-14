// Root layout — mirrors examples/hello/app/layout.tsx. Server component; renders
// the shared chrome (header nav + footer) around each route's content. Next
// supplies <html>/<body> here (denext supplies them from the framework).
import "./globals.css";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata = {
  title: "denext example",
  description: "A demo app built with denext",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app">
          <header className="topbar">
            <Link className="brand" href="/">denext</Link>
            <nav>
              <Link href="/">Home</Link>
              <Link href="/about">About</Link>
              <Link href="/blog/hello-world">Blog</Link>
            </nav>
          </header>
          <main className="content">{children}</main>
          <footer className="foot">Built on Deno · no npm dependencies</footer>
        </div>
      </body>
    </html>
  );
}
