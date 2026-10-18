// Root layout for the useApi-from-a-PPR-shell fixture (use-api-ppr.e2e.test.ts).
import type { LayoutProps } from "denext/server";

export const metadata = { title: "use-api-ppr fixture" };

export default function RootLayout({ children }: LayoutProps) {
  return <div class="app">{children}</div>;
}
