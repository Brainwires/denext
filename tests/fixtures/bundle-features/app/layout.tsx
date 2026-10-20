import type { LayoutProps } from "denext/server";

export default function RootLayout({ children }: LayoutProps) {
  return <main>{children}</main>;
}
