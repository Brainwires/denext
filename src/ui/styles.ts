// The UI's single stylesheet, exported as a string and served from the same origin at
// `/_ui/ui.css` — so the strict `style-src 'self'` CSP needs no hashes and no `unsafe-inline`.
// Deliberately small and unopinionated: system fonts, one accent, both colour schemes from
// `prefers-color-scheme` tokens.

/** The stylesheet served at `/_ui/ui.css`. */
export const UI_CSS = `:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --panel: #f6f7f9;
  --fg: #16181d;
  --dim: #5b6472;
  --line: #dfe3e9;
  --accent: #2f6feb;
  --warn: #8a5a00;
  --radius: 8px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --fg: #e6e9ef;
    --dim: #99a2b3;
    --line: #262b35;
    --accent: #6c9bff;
    --warn: #e0b050;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  position: sticky;
  top: 0;
}
.brand { font-weight: 600; letter-spacing: -0.01em; }
.topbar nav { display: flex; flex-wrap: wrap; gap: 4px; }
.topbar nav a {
  color: var(--dim);
  text-decoration: none;
  padding: 4px 10px;
  border-radius: var(--radius);
}
.topbar nav a:hover { background: var(--bg); color: var(--fg); }
.topbar nav a[aria-current="page"] { background: var(--bg); color: var(--accent); font-weight: 600; }
main { max-width: 940px; margin: 0 auto; padding: 28px 20px 64px; }
h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: -0.02em; }
h2 { font-size: 16px; margin: 28px 0 8px; }
.lead { color: var(--dim); margin: 0 0 18px; }
.note {
  border: 1px solid var(--line);
  border-left: 3px solid var(--warn);
  background: var(--panel);
  border-radius: var(--radius);
  padding: 10px 14px;
  color: var(--dim);
}
.cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); }
.card {
  display: block;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  padding: 14px 16px;
  text-decoration: none;
  color: inherit;
}
.card:hover { border-color: var(--accent); }
.card strong { display: block; margin-bottom: 2px; }
.card span { color: var(--dim); font-size: 13px; }
fieldset { border: 1px solid var(--line); border-radius: var(--radius); margin: 0 0 12px; }
label { display: block; font-size: 13px; color: var(--dim); margin-bottom: 4px; }
input, select, textarea, button {
  font: inherit;
  color: inherit;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 9px;
}
button { background: var(--accent); border-color: var(--accent); color: #fff; cursor: pointer; }
button.ghost { background: var(--panel); color: var(--fg); border-color: var(--line); }
pre.out {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 12px 14px;
  overflow-x: auto;
  white-space: pre-wrap;
  font-size: 13px;
}
.badge {
  display: inline-block;
  font-size: 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 1px 9px;
  color: var(--dim);
}
`;
