// Root layout: denext supplies <html>/<head>/<body>.
import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "RTC Viewer (native)",
  description: "Controls for the native WebRTC viewer",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return <main className="content">{children}</main>;
}
