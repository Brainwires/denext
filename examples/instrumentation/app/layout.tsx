import type { LayoutProps } from "denext/server";

export const metadata = {
  title: "denext — instrumentation example",
  description: "Next-style instrumentation.ts: register() + onRequestError on denext",
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
