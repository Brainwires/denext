// Root layout: denext supplies <html>/<head>/<body>.
import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "Multiwindow",
  description: "Keyed windows, a window menu and per-window counters that outlive their window",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return <main className="workspace">{children}</main>;
}
