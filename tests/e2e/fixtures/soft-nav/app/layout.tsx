// A Next-convention root layout (<html>/<head>/<body>) that owns a stateful client island. A
// soft navigation swaps the page slot but must NOT remount the layout — so the island's count
// survives the nav.
import { Link } from "denext";
import { NavCounter } from "./nav-counter.tsx";

export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <head>
        <title>soft-nav fixture</title>
        <meta name="description" content="A Next-convention root layout" />
        <style>{"nav { display: flex; gap: 8px; }"}</style>
      </head>
      <body className="fixture">
        <nav>
          <NavCounter />
          <Link href="/">home</Link>
          <Link href="/other">other</Link>
          <Link href="/slow">slow</Link>
          <Link href="/islands">islands</Link>
        </nav>
        <main>{children as never}</main>
      </body>
    </html>
  );
}
