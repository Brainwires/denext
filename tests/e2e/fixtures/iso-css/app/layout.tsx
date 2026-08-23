// Root layout for the isomorphic per-route-CSS fixture: two interactive
// (non-Flight) routes, each importing its own stylesheet. Exercised by
// iso-css.e2e.test.ts to prove a soft nav swaps the per-route <link>.

import { Link } from "denext";
import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "iso-css fixture",
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="app">
      <nav>
        <Link href="/" data-testid="to-home">Home</Link>
        <Link href="/about" data-testid="to-about">About</Link>
      </nav>
      <main>{children}</main>
    </div>
  );
}
