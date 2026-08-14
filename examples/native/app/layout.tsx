// Root layout — denext supplies <html>/<head>/<body>; this renders the chrome.
import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext native",
  description: "One denext app, shipped to desktop and mobile.",
  head:
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
    `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return <div class="wrap">{children}</div>;
}
