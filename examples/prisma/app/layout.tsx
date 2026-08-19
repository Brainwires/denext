import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext — Prisma ORM example",
  description: "Prisma over node:sqlite on denext, Rust-free, zero native addons",
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
