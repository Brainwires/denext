// Root layout — required by the App Router. This example is Pages-Router-first,
// but keeps one App Router route (`/app-page`) to show the two coexist: App
// Router routes always win; the Pages Router claims everything else.

import type { LayoutProps } from "@denext/denext/server";

export const metadata = {
  title: "denext pages-router example",
  description: "A Pages Router app running on denext via @denext/pages-router",
};

export default function RootLayout({ children }: LayoutProps) {
  return <div class="app-router">{children}</div>;
}
