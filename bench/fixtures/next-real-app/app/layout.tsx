// Shared layout — mirrors bench/fixtures/denext-app/app/layout.tsx.
import type { ReactNode } from "react";

const linkStyle = {
  marginRight: "1rem",
  color: "#6d28d9",
  textDecoration: "none",
  fontWeight: 600,
} as const;

export const metadata = { title: "denext real-app benchmark" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui,sans-serif",
          maxWidth: "52rem",
          margin: "2rem auto",
          padding: "0 1rem",
        }}
      >
        <nav
          style={{
            paddingBottom: "1rem",
            borderBottom: "1px solid #e5e7eb",
            marginBottom: "1.5rem",
          }}
        >
          <a href="/" style={linkStyle}>Dashboard</a>
          <a href="/form" style={linkStyle}>Form</a>
          <a href="/ui" style={linkStyle}>UI</a>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
