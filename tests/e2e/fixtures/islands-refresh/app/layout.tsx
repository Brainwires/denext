// No client component in the layout: a page whose only client parts are `client:*` islands
// inlines no root Flight tree and boots root-less.
import { Link } from "denext";

export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">home</Link>
          <Link href="/other">other</Link>
        </nav>
        <main>{children as never}</main>
      </body>
    </html>
  );
}
