// The UI's single stylesheet, exported as a string and served from the same origin at
// `/_ui/ui.css` — so the strict `style-src 'self'` CSP needs no hashes and no `unsafe-inline`.
//
// The vocabulary is shadcn/ui's, rebuilt for server-rendered markup: semantic colour tokens
// (background/foreground/card/muted/border/ring/destructive), one 4px spacing scale, one radius
// scale and one type scale. There is no framework here and no JavaScript — every component in
// `components.ts` and every control in `form/` is a plain element wearing these classes, so the
// whole UI keeps working with scripting switched off.
//
// Both colour schemes come from `prefers-color-scheme`; `tests/ui-server.test.ts` asserts that.

/** The stylesheet served at `/_ui/ui.css`. */
export const UI_CSS = `:root {
  color-scheme: light dark;

  /* surfaces */
  --background: #ffffff;
  --foreground: #16181d;
  --card: #ffffff;
  --card-foreground: #16181d;
  --muted: #f4f5f7;
  --muted-foreground: #5b6472;
  --border: #e3e6eb;
  --input: #d7dbe2;

  /* intent */
  --primary: #2f6feb;
  --primary-foreground: #ffffff;
  --ring: #2f6feb;
  --destructive: #b3261e;
  --destructive-foreground: #ffffff;
  --success: #1a7f37;
  --warning: #8a5a00;

  /* scales */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --radius: 8px;
  --radius-sm: 6px;
  --radius-full: 999px;
  --text-xs: 12px;
  --text-sm: 13px;
  --text-base: 15px;
  --text-lg: 16px;
  --text-xl: 22px;

  /* legacy aliases — the class rules below still read these names */
  --bg: var(--background);
  --fg: var(--foreground);
  --panel: var(--muted);
  --dim: var(--muted-foreground);
  --line: var(--border);
  --accent: var(--primary);
  --warn: var(--warning);
  --add: var(--success);
  --del: var(--destructive);
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: #0f1115;
    --foreground: #e6e9ef;
    --card: #151821;
    --card-foreground: #e6e9ef;
    --muted: #171a21;
    --muted-foreground: #99a2b3;
    --border: #262b35;
    --input: #333a47;

    --primary: #6c9bff;
    --primary-foreground: #0f1115;
    --ring: #6c9bff;
    --destructive: #ff8080;
    --destructive-foreground: #0f1115;
    --success: #58c470;
    --warning: #e0b050;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--background);
  color: var(--foreground);
  font: var(--text-base)/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  display: grid;
  /* minmax(0, …) rather than a bare 1fr. A bare 1fr means minmax(auto, 1fr), and that auto
     refuses to shrink below its content's min-content width, so one wide table or output block
     in a panel stretched the whole shell past the viewport and the page scrolled sideways. */
  grid-template-columns: 232px minmax(0, 1fr);
  min-height: 100vh;
}
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
:where(a):focus-visible,
:where(button, input, select, textarea, summary):focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}

/* ── shell ─────────────────────────────────────────────────────────────── */
.sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-3);
  border-right: 1px solid var(--border);
  background: var(--muted);
  position: sticky;
  top: 0;
  align-self: start;
  height: 100vh;
  /* The column is pinned to the viewport, so anything past its bottom edge has nowhere to go:
     the page scrolls main, not this. Without a scroll container the surplus simply rendered
     outside the box and could not be reached at all. */
  min-height: 0;
}
.brand { font-weight: 600; letter-spacing: -0.01em; padding: 0 10px; }
/* The list is what scrolls, not the whole column — the brand and the mode badges stay put.
   min-height: 0 is load-bearing: a flex child defaults to min-height: auto and refuses to
   shrink below its content, so without it the nav just overhangs and overflow never engages.
   (The same trap as a bare 1fr grid column, which is minmax(auto, 1fr).) */
.sidebar nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.sidebar nav a {
  color: var(--muted-foreground);
  text-decoration: none;
  padding: var(--space-1) 10px;
  border-radius: var(--radius-sm);
}
/* An item that sits under a heading is its child, and should read as one. */
.sidebar nav a.nested { padding-left: 22px; }
.sidebar nav a:hover { background: var(--background); color: var(--foreground); }
.sidebar nav a[aria-current="page"] {
  background: var(--background);
  color: var(--primary);
  font-weight: 600;
}
/* A heading over a run of nav links. Not a control: the UI ships no inline script, so there is
   nothing here to collapse — it names the group and steps back. */
.nav-section {
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted-foreground);
  padding: var(--space-3) 10px var(--space-1);
}
/* The narrow-layout toggle: a real checkbox, hidden from view but NOT from the keyboard, so the
   drawer opens without a pointer and without any script. */
.nav-toggle {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
/* There is nothing to toggle while the sidebar is a column, so the button only exists narrow. */
.nav-burger { display: none; }

/* margin-top:auto pins the modes to the bottom of the column; the narrow layout below has
   no column, so it resets there. */
.mode { margin: auto 0 0; display: flex; flex-wrap: wrap; gap: var(--space-1); padding: 0 10px; }
main { max-width: 940px; padding: 28px var(--space-5) 64px; }

/* The stylesheet's only breakpoint. Below it the grid collapses to one column and the sidebar
   becomes a bar holding the brand and a button: twelve destinations laid out as a horizontal
   strip cost more of a phone screen than the panel they lead to. The navigation is what the
   button reveals, and it reveals it as the same vertical list the wide layout shows — so the
   section headings mean what they mean there, rather than being dropped. */
@media (max-width: 860px) {
  body { grid-template-columns: minmax(0, 1fr); }
  .sidebar {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    height: auto;
    padding: 10px var(--space-4);
    border-right: 0;
    border-bottom: 1px solid var(--border);
    z-index: 10;
  }
  .nav-burger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: auto;
    width: 38px;
    height: 32px;
    font-size: var(--text-lg);
    line-height: 1;
    color: var(--foreground);
    background: var(--background);
    border: 1px solid var(--input);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  /* The checkbox is what is focused, so the ring has to be drawn on what is seen. */
  .nav-toggle:focus-visible + .sidebar .nav-burger {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  /* Closed by default, and closed again on every load — so a fresh page never opens covered. */
  .sidebar nav,
  .mode { display: none; }
  .nav-toggle:checked + .sidebar nav {
    display: flex;
    flex-direction: column;
    width: 100%;
    gap: 2px;
    /* In the drawer the PAGE scrolls, so the list must not become its own scroll box. */
    flex: 0 1 auto;
    overflow-y: visible;
  }
  .nav-toggle:checked + .sidebar .mode {
    display: flex;
    width: 100%;
    margin: var(--space-2) 0 0;
  }
}
h1 { font-size: var(--text-xl); margin: 0 0 6px; letter-spacing: -0.02em; }
h2 { font-size: var(--text-lg); margin: 28px 0 var(--space-2); }
.lead { color: var(--muted-foreground); margin: 0 0 18px; }

/* ── surfaces ──────────────────────────────────────────────────────────── */
.note {
  border: 1px solid var(--border);
  border-left: 3px solid var(--warning);
  background: var(--muted);
  border-radius: var(--radius);
  padding: 10px 14px;
  color: var(--muted-foreground);
}
.note[role="alert"] { border-left-color: var(--destructive); }
.cards {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
}
.card {
  display: block;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  color: var(--card-foreground);
  padding: 14px var(--space-4);
  text-decoration: none;
}
.card:hover { border-color: var(--primary); }
.card strong { display: block; margin-bottom: 2px; }
.card span { color: var(--muted-foreground); font-size: var(--text-sm); }
.outcome {
  border: 1px solid var(--border);
  border-left: 3px solid var(--primary);
  border-radius: var(--radius);
  background: var(--muted);
  padding: 10px 14px;
  margin: 10px 0 0;
}
.outcome > :first-child { margin-top: 0; }
.outcome > :last-child { margin-bottom: 0; }
.step { border-top: 1px solid var(--border); padding-top: var(--space-2); margin: 0 0 22px; }
.step h2 { margin-top: var(--space-1); }

/* A panel's tab strip: the same vocabulary as the top nav, seated on a rule. */
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin: 0 0 var(--space-5);
  border-bottom: 1px solid var(--border);
}
.tabs a {
  color: var(--muted-foreground);
  text-decoration: none;
  padding: var(--space-2) var(--space-3);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.tabs a:hover { color: var(--foreground); }
.tabs a[aria-current="page"] {
  color: var(--primary);
  border-bottom-color: var(--primary);
  font-weight: 600;
}
/* The heading over a tab's content: the key, and whether it is set. */
.key-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-2);
}

/* A view's plain scalars, in one form with one Save above the grouped keys. */
.band { margin: 0 0 var(--space-5); }
.band > button { margin-top: var(--space-2); }

/* The cron builder: pick a shape, and the server composes the expression. */
.builder {
  border: 1px solid var(--border);
  background: var(--muted);
  border-radius: var(--radius);
  padding: var(--space-3) 14px;
  margin: 0 0 var(--space-4);
}
.builder .row { flex-wrap: wrap; gap: var(--space-2); }
.builder-choice { display: inline-flex; align-items: center; gap: var(--space-1); margin: 0; }
.builder-field { display: inline-flex; align-items: center; gap: var(--space-1); margin: 0; }

/* A panel's one header row: the tabs for what is on this page, and the box that searches
   across every page, sharing a single rule. */
.panel-head {
  display: flex;
  align-items: flex-end;
  gap: var(--space-4);
  flex-wrap: wrap;
  border-bottom: 1px solid var(--border);
  margin: 0 0 var(--space-5);
}
.panel-head .tabs { border-bottom: 0; margin: 0; flex: 1 1 auto; }
.panel-head .filter { margin: 0 0 6px; flex: 0 1 auto; }
.panel-head .filter input[type="search"] { max-width: 15rem; }
.head-aside { text-decoration: none; margin: 0 0 10px; white-space: nowrap; }
/* The standing explanation, out of the way of the thing you came to edit. */
.foot-note {
  margin: var(--space-6) 0 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
  font-size: var(--text-sm);
}

/* A panel's filter box: a plain GET form, so it works with scripting off. */
.filter { display: flex; gap: var(--space-2); align-items: center; margin: 0 0 var(--space-4); }
.filter input[type="search"] { flex: 1; max-width: 26rem; }
.filter-note { color: var(--muted-foreground); font-size: var(--text-sm); margin: 0 0 var(--space-4); }

/* ── controls ──────────────────────────────────────────────────────────── */
fieldset {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin: 0 0 var(--space-3);
}
label { display: block; font-size: var(--text-sm); color: var(--muted-foreground); margin-bottom: var(--space-1); }
input, select, textarea, button {
  font: inherit;
  color: inherit;
  background: var(--background);
  border: 1px solid var(--input);
  border-radius: var(--radius-sm);
  padding: 6px 9px;
}
input:hover, select:hover, textarea:hover { border-color: var(--muted-foreground); }
button {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--primary-foreground);
  cursor: pointer;
  font-weight: 500;
}
button:hover:not(:disabled) { filter: brightness(1.08); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button.ghost {
  background: var(--muted);
  color: var(--foreground);
  border-color: var(--border);
  font-weight: 400;
}
button.ghost:hover:not(:disabled) { background: var(--background); border-color: var(--muted-foreground); filter: none; }
button.destructive { background: var(--destructive); border-color: var(--destructive); color: var(--destructive-foreground); }

/* Spacing the markup used to hard-code inline, now owned by the scale. */
.field { margin: 0 0 14px; }
.field-help { margin: var(--space-1) 0 0; font-size: var(--text-sm); }
.field-error { margin: 6px 0 0; }
.control-wide { width: 100%; }
.op-button { padding: 2px var(--space-2); }
.op-group { display: inline-flex; gap: var(--space-1); }
.group-body { padding: var(--space-2) 0 0 var(--space-3); }
.group-summary { font-weight: 600; margin: 0 0 var(--space-1); }

/* ── disclosure ────────────────────────────────────────────────────────── */
/* A summary's text lines up with its own description and with every other block
   in the panel; the triangle hangs in the gutter beside it. The browser's own
   marker is in-flow, which pushed every key name ~16px right of the column it
   belongs to — its description, its note and its code cell all started further
   left than its name did. Flex also centres the badge, which sat 2px low next to
   the bold name at the inline default. */
details > summary {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
  list-style: none;
}
/* Safari draws its own marker and ignores list-style. */
details > summary::-webkit-details-marker { display: none; }
details > summary::before {
  content: "";
  position: absolute;
  left: -13px;
  top: 50%;
  width: 0;
  height: 0;
  border-left: 5px solid currentColor;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  transform: translateY(-50%);
  opacity: 0.55;
}
details[open] > summary::before { transform: translateY(-50%) rotate(90deg); }
.group-note { font-size: var(--text-sm); }
.pad-box { padding: 10px var(--space-3); }
.flush { margin: 0; }
.flush-sm { margin: 0 0 6px; }

/* ── output ────────────────────────────────────────────────────────────── */
pre.out {
  background: var(--muted);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-3) 14px;
  overflow-x: auto;
  max-height: 24rem;
  overflow-y: auto;
  white-space: pre-wrap;
  font-size: var(--text-sm);
}
.diff { font: inherit; }
.diff .add { color: var(--success); }
.diff .del { color: var(--destructive); }
.diff .meta { color: var(--muted-foreground); }
.checks { list-style: none; margin: var(--space-2) 0; padding: 0; }
.checks li { padding: 3px 0; border-bottom: 1px solid var(--border); }
.checks li:last-child { border-bottom: 0; }
form.op { display: inline-block; margin: var(--space-1) var(--space-2) var(--space-1) 0; }

/* ── data ──────────────────────────────────────────────────────────────── */
.table { width: 100%; border-collapse: collapse; margin: 6px 0 14px; font-size: 14px; }
.table th, .table td {
  text-align: left;
  vertical-align: top;
  padding: 5px 10px 5px 0;
  border-bottom: 1px solid var(--border);
}
.table th { color: var(--muted-foreground); font-weight: 600; }
/* Zebra before hover: equal specificity (0,2,2), so source order is what keeps hover winning. */
.table tbody tr:nth-child(even) { background: color-mix(in srgb, var(--muted) 45%, transparent); }
.table tbody tr:hover { background: var(--muted); }
.row { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; }
.row.top { align-items: flex-start; }
.row .grow { flex: 1; }
.verb { border-top: 1px solid var(--border); padding: 10px 0 var(--space-1); }
.verb h3 { margin: 0 0 var(--space-1); font-size: var(--text-base); font-weight: 600; }
.verb p { margin: 0 0 6px; }
.args { margin: var(--space-1) 0 var(--space-2); padding-left: 18px; color: var(--muted-foreground); font-size: var(--text-sm); }
.badge {
  display: inline-block;
  font-size: var(--text-xs);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  padding: 1px 9px;
  color: var(--muted-foreground);
  background: var(--muted);
}
.badge.ok { color: var(--success); border-color: color-mix(in srgb, var(--success) 40%, var(--border)); }
.badge.todo { color: var(--primary); border-color: color-mix(in srgb, var(--primary) 40%, var(--border)); }
.badge.warn { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 40%, var(--border)); }
.badge.fail { color: var(--destructive); border-color: color-mix(in srgb, var(--destructive) 40%, var(--border)); }
.badge.info { color: var(--muted-foreground); }
`;
