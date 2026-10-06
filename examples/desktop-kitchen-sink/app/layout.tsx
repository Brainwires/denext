// Root layout: denext supplies <html>/<head>/<body>; this renders the chrome.
import type { LayoutProps } from "denext/server";
import { NavigationTest } from "./navigation.tsx";
// Through the import map (`@/` in deno.json): the desktop export resolves the alias, then the
// target's file (`PlatformBadge.desktop.tsx`).
import { PlatformBadge } from "@/components/PlatformBadge.tsx";

export const metadata = {
  title: "denext kitchen sink",
  description: "Every Deno Desktop capability, exercised",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <main class="content">
      {children}
      <PlatformBadge />
      {/* The window test's navigation phase: on every page, so it resumes after a full load. */}
      <NavigationTest />
    </main>
  );
}
