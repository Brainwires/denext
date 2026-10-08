"use client";
// A root layout rendered by CLIENT code: its <html>/<head>/<body> must hydrate in place (the page
// already has one of each) — no remount, no flash — and its attributes follow its state.
import { useState } from "denext";

export default function RootLayout({ children }: { children: unknown }) {
  const [theme, setTheme] = useState("light");
  return (
    <html lang="en" className={theme}>
      <head>
        <style>{"main { display: block; }"}</style>
      </head>
      <body data-theme={theme}>
        <button
          type="button"
          data-testid="theme"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
        >
          theme: {theme}
        </button>
        <main>{children as never}</main>
      </body>
    </html>
  );
}
