import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext + Lustre",
  head: `<link rel="stylesheet" href="/styles.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return <main>{children}</main>;
}
