"use client";
// A root layout rendered by CLIENT code: its <html>/<head>/<body> must hydrate in place (the page
// already has one of each) — no remount, no flash — and its attributes follow its state.
import { useState } from "denext";

export default function RootLayout({ children }: { children: unknown }) {
  const [theme, setTheme] = useState("light");
  return (
    <html lang="en" className={theme}>
      <head>
        <style>
          {"main { display: block; }" +
            // The enter class the pair boundary sets: a real animation on each entering host.
            "@keyframes pair-in { from { opacity: 0 } }" +
            "::view-transition-new(.pair-in) { animation: 300ms pair-in; }"}
        </style>
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
        {/* Mounted fresh by the click (not hydrated): form defaults fill the real fields. */}
        {theme === "dark"
          ? (
            <form data-testid="defaults">
              <input name="t" defaultValue="hello" />
              <input type="checkbox" name="c" defaultChecked />
              <textarea name="a" defaultValue="draft" />
              <select name="s" defaultValue="b">
                <option value="a">A</option>
                <option value="b">B</option>
              </select>
              <select name="m" multiple defaultValue={["a", "c"]}>
                <option value="a">A</option>
                <option value="b">B</option>
                <option value="c">C</option>
              </select>
            </form>
          )
          : null}
      </body>
    </html>
  );
}
