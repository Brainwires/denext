// Root layout — denext supplies <html>/<head>/<body>; this adds the stylesheet.
import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "Loopy",
  description: "Loopy, a paper-clip desktop companion that talks in speech bubbles.",
  head: `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return <>{children}</>;
}
