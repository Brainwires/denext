// Root layout: denext supplies <html>/<head>/<body>; this renders the chrome.
import type { LayoutProps } from "denext/server";
import { NavigationTest } from "./navigation.tsx";

export const metadata = {
  title: "denext kitchen sink",
  description: "Every Deno Desktop capability, exercised",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <main class="content">
      {children}
      {/* The window test's navigation phase: on every page, so it resumes after a full load. */}
      <NavigationTest />
    </main>
  );
}
