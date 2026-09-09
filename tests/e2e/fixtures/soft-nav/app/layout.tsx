// The layout owns a stateful client island. A soft navigation swaps the page slot but
// must NOT remount the layout — so the island's count survives the nav.
import { Link } from "denext";
import { NavCounter } from "./nav-counter.tsx";

export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <NavCounter />
          <Link href="/">home</Link>
          <Link href="/other">other</Link>
          <Link href="/slow">slow</Link>
        </nav>
        <main>{children as never}</main>
      </body>
    </html>
  );
}
