// A soft navigation's `<ViewTransition>` callbacks: the layout's crumb persists across the
// navigation, so its boundary runs `onUpdate` when the route changes its text; the logo's boundary
// is untouched and runs nothing; a `ref` receives the crumb boundary's ViewTransitionInstance.
import { Link } from "denext";
import { Crumb } from "./crumb.tsx";

export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <head>
        <title>vt-nav fixture</title>
      </head>
      <body>
        <nav>
          <Link href="/">home</Link>
          <Link href="/other">other</Link>
        </nav>
        <Crumb />
        <main>{children as never}</main>
      </body>
    </html>
  );
}
