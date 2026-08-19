import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext — Drizzle ORM example",
  description: "Drizzle ORM over node:sqlite on denext, zero native addons",
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
