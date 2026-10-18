import type { LayoutProps } from "denext/server";

export const metadata = { title: "offline-sync backend" };

export default function RootLayout({ children }: LayoutProps) {
  return <div>{children}</div>;
}
