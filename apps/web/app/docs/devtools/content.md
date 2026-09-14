---
title: DevTools
slug: devtools
lead: A zero-install glass-box panel that mounts in every dev page — a component tree with named hooks and editor-linked source, render modes, a profiler, the request log, cache counters and the route map — plus an MCP bridge that lets an agent read the live page.
---

In dev, denext mounts its own DevTools panel. There is nothing to install and no
browser extension to keep in step: a small launcher (the denext mascot) sits at
the bottom-left of every dev page, `Ctrl+Shift+D` toggles the panel, and the
browser console says `[denext] devtools ready` once it is installed.

The panel reads everything from the live reconciler through a typed API and
renders with plain DOM in its own tiny update loop — it never re-enters the tree
it inspects, and it builds every node from DOM APIs (no `innerHTML`). It is
**dev-only**: `installDevtools()` no-ops unless `globalThis.__denextDev` is set,
only the dev route/Flight/SPA entries import it, and a production build contains
no reference to the panel, the inspector or the metadata registry at all.

> [!NOTE]
> The panel is styled with inline CSSOM (`element.style`), never a
> runtime-injected `<style>` sheet, so it works unchanged under denext's strict
> `style-src 'self'` dev CSP. Its launcher image is an inlined `data:` URI, which
> the default `img-src 'self' data:` allows.

It mounts on **every** dev path — the native App Router, the Flight/streaming
path, the Next.js drop-in and [SPA mode](/docs/spa). The three tabs that read the
dev server (Network, Cache, Routes) are App-Router-only, and say so in place
rather than showing an empty table.

## The six tabs

The header is a scrollable `role="tablist"`: **Components**, **Render modes**,
**Profiler**, **Network**, **Cache**, **Routes**. `Alt+1`…`Alt+6` jump straight
to one. The panel is `min(620px, 94vw)` wide and `min(460px, 74vh)` tall; below
420 px the `denext · glass-box` title is dropped so the tabs keep the whole
header row.

### Components

A live tree of your app, re-rendered on every commit (coalesced to a frame) and
on every streamed-hole reveal.

- **Element picker** — click `🎯`, then hover the page: the hovered element's
  owning component is outlined with an overlay and a name tooltip; click to
  select it, or press `Escape` to cancel. Hovering a tree row reverse-highlights
  its DOM node.
- **Searchable, collapsible tree** — the `filter…` box keeps every component
  whose name matches plus their ancestors, any subtree collapses from its twisty,
  and `{ }` adds host (DOM) and text nodes as their own rows.
- **Badges** — `memo`, `forwardRef`, `StrictMode`, `Suspense` (+`fallback`),
  `ErrorBoundary` (+`errored`), `Context.Provider`, next to the name in both the
  tree and the detail pane.
- **Live editing** — a `useState` cell holding a string, number, boolean or null
  is an input (a checkbox for a boolean) that writes straight back into the
  running component; a primitive prop is an override you can pin, and
  `reset props` drops every override on that component at once.
- **Deep values** — expand a nested object or array with `▶`, and each level is
  read lazily from the _live_ value, not from a snapshot. Per value: `copy` (the
  preview), `log` (the real value, to the console) and `$d`, which stashes the
  live value on `window.$d`.
- **Why did this render?** — while the panel is open it accrues render reasons,
  so the props, hooks and contexts that changed on the last commit are marked in
  the accent colour and the header carries a `rendered ×N` count.
- **Owner stack** — the component ancestors above the selection, nearest first,
  joined with `←`.
- **Effect annotations** — an effect/memo/callback/deferred cell shows its `deps`
  (`[] (once)` when empty) and a `cleanup ƒ` row when it currently holds one.

#### The Source row

A selected component shows where it was declared:

```text
Source   app/page.tsx:42
```

The path is repo-relative when the module is served from the app root (an
unbundled dev module URL is same-origin with the page); otherwise it is the
URL's last two segments — the browser cannot honestly shorten a `file://` path it
has no project view of. The link's tooltip is always the full
`path:line:column`.

Clicking it **opens your editor on that line**. The click goes to the dev
server's `/_denext/open-in-editor?file=&line=&column=` endpoint, which resolves
the path inside the project (symlinks resolved and containment re-checked, so an
out-of-project path is a 400 and never opened) and spawns the editor with the
right arguments for its family:

| `DENEXT_EDITOR` / `VISUAL` / `EDITOR`                                                      | Arguments                  |
| ------------------------------------------------------------------------------------------ | -------------------------- |
| `code`, `code-insiders`, `codium`, `vscodium`, `cursor`, `windsurf`, `positron`            | `--goto file:line:column`  |
| `subl`, `sublime_text`, `sublime`, `atom`                                                  | `file:line:column`         |
| `webstorm`, `idea`, `pycharm`, `goland`, `rider`, `phpstorm`, `clion`, `rubymine`, `fleet` | `--line N --column N file` |
| `vim`, `nvim`, `nano`, `hx`, `helix`, `kak`, `micro`, `emacs`, `emacsclient`               | `+line file` (best effort) |
| anything else                                                                              | `file`                     |

The first of `DENEXT_EDITOR`, `VISUAL`, `EDITOR` that is set wins; with none set
the default is VS Code's `code`. When no editor can be launched the endpoint
answers `501 no editor` and nothing else happens.

SPA dev serves no `/_denext/*` endpoints. Once any dev read has come back
unavailable, the source row becomes a plain `vscode://file/<path>:<line>:<col>`
link the browser follows instead (only for a `file://` source).

#### Named hooks

A hook row reads as **the variable the call was bound to, plus the hook that
produced the cell**:

```text
Hooks
0 count · useState        3
1 boxRef · useRef         { current: div }
2 total · useMemo         42
3 effect · useEffect      ƒ anonymous
```

The name comes from the build-time metadata pass, which records the binding
pattern of every hook call in the module (see
[below](#how-source-locations-and-hook-names-get-there)). How the label is
chosen:

| In the source                                      | The row reads                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `const [count, setCount] = useState(0)`            | `count · useState`                                                           |
| `const [, setOpen] = useState(false)`              | `setOpen · useState` — the first name the pattern binds                      |
| `const { data } = useApi(…)`                       | `data · useApi`                                                              |
| `const { data: rows } = useApi(…)`                 | `rows · useApi` — the local name                                             |
| `const boxRef = useRef(null)`                      | `boxRef · useRef`                                                            |
| `useEffect(() => {…}, [])`                         | `effect · useEffect` — nothing was bound, so the cell's kind stands in       |
| a custom hook declared in the same module          | the hook's own cells, breadcrumbed: `useAuth › session · useAuth › useState` |
| a composite (`useTransition`, `useActionState`, …) | its first cell is named; its internal extra cells carry the hook alone       |

The join is lockstep and checked: a table of how many cells each hook consumes
(and with which kind tags) is walked against the component's live cells, and
**any** divergence abandons naming for that whole component rather than pairing a
name with the wrong cell. The pane then shows kind labels and says so:

```text
names unavailable (conditional hooks?)
```

That is what you see for a conditionally-called hook, a custom hook imported from
another module (there is no way to know how many cells an opaque hook took), or a
chain of same-module custom hooks nested more than three deep.

### Render modes

The glass-box view of how this page reached the browser — see
[Rendering strategies](/docs/rendering).

- **Page** — the server's verdict for the document: `static`, `dynamic` or
  `streamed`, plus `· cache HIT` / `STALE` / `MISS` when the request was served
  through the page cache. Read from a dev-only JSON island the document renderer
  emits.
- **Suspense boundaries (live waterfall)** — one row per streamed boundary: its
  id, a bar proportional to its server resolve time, `Nms server`, and
  `revealed @Nms` once the hole lands on the client. The swap runtime records
  reveals in real time, so the timeline fills as the stream arrives rather than
  only at end-of-stream, and settles onto the authoritative server times when the
  stream's timing island lands.
- **Client islands (hydration waterfall)** — one row per island: its `client:*`
  strategy (with the parameter, e.g. `media(...)`), its id, and how many
  milliseconds after page load it hydrated. See [Islands](/docs/islands).

A page with neither reads `No client islands — this page is server-rendered
HTML.`

### Profiler

Click **● Record**, interact, then **■ Stop** (**Clear** discards a recording).

- A **commit strip** — one bar per commit, height proportional to its total
  render time; the tooltip is `commit #n · phase · Xms · N rendered`, and
  clicking a bar steps the view to that commit.
- A **flamegraph** of the selected commit — each bar's width is its share of the
  parent's total time, its fill is a warm scale over _self_ time (yellow-green
  through red-orange at ≥ 8 ms), and a component that did not render in this
  commit is dimmed. Clicking a bar jumps to that component in the Components tab.
- A **ranked list** (top 25 by self time) with _why each rendered_ —
  `props: a,b · hooks: 0 · ctx: Theme` — so the commit's most expensive
  components and the reason they ran are one glance apart.

For whole-app CPU and heap profiling outside the browser, see
[`denext profile`](/docs/profile).

### Network

The dev server's completed-request log, read once a second from
`/_denext/dev-state?kind=request&limit=200` while the tab is open.

Each row is the method and path, a status pill coloured by response class
(2xx/3xx/4xx/5xx, `—` when unknown), the duration with a bar scaled to the
slowest visible request, and how long ago it completed. Newest first, capped at
200 rows. Two filters sit in the toolbar: a case-insensitive path substring, and
an **errors** toggle that keeps only responses of status 400 and above; the
counter reads `12 of 200` when a filter is on.

A poll that fails leaves the last good table on screen rather than blanking it.
App Router dev only.

### Cache

The page/data cache's counters and its recent invalidations, read once a second
from `/_denext/dev-cache` — which is `getCacheStats()` verbatim, the same public
snapshot a monitoring hook would read, so polling it costs nothing but the JSON.

The tiles are **hits**, **misses**, **sets**, **invalidations** and the derived
**hit rate**. Below them, every recent `revalidateTag` / `revalidatePath` call is
listed newest first, with a `tag` / `path` pill, the value that was invalidated,
and how long ago it happened. See [Data & caching](/docs/data).

App Router dev only — SPA mode runs no server cache.

### Routes

What actually renders at a path, from the dev server's already-cached route
manifest (`/_denext/dev-routes?path=`). It opens on the page you are looking at
and takes any other path in its box, so you can ask "what would render at
`/blog/hello`?" without navigating there. It is read once per probe, not polled:
the manifest only changes when a file is added or removed, which reloads the page
anyway.

The answer is the matched **Page** pattern, its **Params**, then the **Render
tree** — every layout, then every template, then the page itself, indented by
nesting depth and each carrying a green `server` or amber `client` badge (a
module that declares `"use client"`) — then the **Boundaries** it would use
(`loading`, `error`, `notFound`, `forbidden`, `unauthorized`) and its parallel
**Slots** with how many pages each holds. An **API route** at the same path is
listed too.

Every file printed is a button that opens that file in your editor, through the
same endpoint the Source row uses. A path that matches nothing answers
`nothing renders at /x` — an answer, not an error.

App Router dev only.

## Highlight updates

The `✨` toolbar toggle flashes components **on the page itself** as they
re-render, the way React DevTools' "highlight updates" does.

It works off the inspector's per-component render counter (which the panel is
already accruing while it is open), so a component only flashes when its count
actually moved — a parent re-rendering does not light up children that bailed
out. The outline colour is a streak ramp over consecutive updating commits: blue
for a single update, through yellow, to red for a component that has re-rendered
in five commits in a row. Each flash lasts 350 ms.

Turning the toggle off clears the remembered counts, so switching it back on
re-baselines instead of flashing the whole tree at once; a component's streak
resets as soon as it skips a commit, and an unmounted component is forgotten.

## Keyboard shortcuts

| Chord                           | Does                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Ctrl+Shift+D`                  | Toggle the panel — the only chord that works while it is closed                                  |
| `Alt+1` … `Alt+6`               | Jump to a tab, in strip order (Components, Render modes, Profiler, Network, Cache, Routes)       |
| `Ctrl+Shift+[` / `Ctrl+Shift+]` | Previous / next tab, wrapping at both ends (the shifted `{` / `}` a US layout produces work too) |
| `Escape`                        | Cancel the element picker; with the picker off, close the panel                                  |

Chords carrying the Meta key are ignored outright — `Cmd+…` belongs to the
browser and the OS on macOS, which is also why the toggle is `Ctrl+Shift+D`
rather than something Chrome has already claimed.

## How source locations and hook names get there

Fast Refresh already gives every component a stable family id
(`<fileUrl>#<Export>`) — but that is a _name_, not a position. So the dev
transforms record two more things while they are already parsing the module, and
append them as a sidecar next to the refresh registration:

- the **line and column** each component (and each `use*` custom hook) is
  declared at — 1-based line, 1-based UTF-16 column, exact past multi-byte text,
  emoji, CRLF line endings and a directive/licence prologue;
- the **binding** each hook call's result was given, in source order.

At runtime that lands in a dev-only registry the inspector joins against a live
component type through its family id. Nothing else changes: `registerFamily` is
untouched, and the metadata rides beside it as its own call.

The pass is bounded and switchable:

- at most **64 hooks** are recorded per component;
- a module whose serialised metadata would exceed **16 KB** emits none at all;
- `DENEXT_DEV_META=0` turns emission off entirely (the Fast Refresh
  registrations are untouched — you keep HMR, you lose line numbers and hook
  names);
- a module the parser cannot handle is passed through unchanged.

**Production bundles carry none of it.** The only emitters are the two dev
transforms, so nothing in a production build references the metadata registry and
the whole module — whose only module-level work is creating an empty `Map` — is
tree-shaken away. A test builds an example app and greps the output to prove it.

## Stock React DevTools

If you have the React DevTools browser extension installed, denext lights it up
too: it registers as a renderer and reports a React-fiber-shaped tree, so the
extension's **Components** panel shows your tree and props, and — routed back
through denext's own reconciler — live prop/state editing and element selection
work there as well.

> [!WARNING]
> The extension's _hooks view_ and its _Profiler_ rely on React-internal
> introspection a non-React fiber tree cannot provide. Use denext's own panel for
> hook fidelity and profiling — it is the full-fidelity surface.

## MCP: inspect the live page

An agent cannot reach into your browser, and denext deliberately has no pull
channel from the dev server into the page. So the page **pushes**: after each
settled commit the in-page sink serialises the component tree and POSTs it to the
dev server, which keeps the latest snapshot per page URL. Three
[MCP](/docs/mcp) tools read it back:

| Tool                    | Answers                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `denext_component_tree` | The live tree — every component with its source location, badges and render count (`filter`, `depth`, `maxNodes`)     |
| `denext_why_render`     | Why a component last re-rendered: which props, hooks and contexts changed, and how many renders it has done           |
| `denext_hook_state`     | A component's hook cells — each cell's name, the hook that produced it, its value and its deps (`index` for one cell) |

All three take `url` (which page's tree, default: the most recent) and `dir` (the
project directory). A call and its answer:

```json
{ "name": "denext_why_render", "arguments": { "component": "Counter" } }
```

```text
snapshot 0.4s old · /
Counter #2  app/counter.tsx:5 · rendered 4× while tracking
  props changed: label
  hook changed: [0] count · useState
  contexts changed: Theme
```

`denext_component_tree` renders the same header over an indented tree, and
`denext_hook_state` over the cells:

```text
snapshot 0.4s old · /
Page  app/page.tsx:12
  Counter key="a" [memo]  app/counter.tsx:5  ×4
  Legacy
```

```text
snapshot 0.4s old · /
Counter #2  app/counter.tsx:5
  [0] count · useState = 3
  [1] useEffect = ƒ anonymous  deps [3]  (has cleanup)
```

**Every answer says how old it is.** The age is measured on the server clock, so
a skewed page clock cannot make a stale tree look fresh, and past 5 seconds the
header adds `— interact with the page or reload to refresh`. A tree the page
capped when it posted it says so, and so does one the tool's own `depth` /
`maxNodes` cut.

Three things can be missing, and each gets its own answer rather than one vague
error:

| Situation                      | What the tool says                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| No dev server                  | `no dev server running (deno task dev) for <dir>` — it looked for `.denext/dev.json` |
| Dev server, but nothing pushed | `open the app in a browser — the DevTools sink has posted nothing yet`               |
| A tree, but no such component  | `no component named "X" in this snapshot. Components present: …`                     |

So both preconditions hold at once: the tools need **`deno task dev` running AND
the app open in a browser**. The sink runs whether or not you ever open the
panel — an agent inspecting a page the developer never opened the panel on is the
normal case.

What gets pushed is deliberately bounded and inert:

- a **trailing throttle** of 1.5 s (a burst of commits produces one post), plus a
  final post on `pagehide`;
- the tree is cut at depth 50, 2000 components or a 256 KB body, and flagged
  `truncated` when a cap bit;
- host, text and fragment nodes are spliced out (their component children are
  re-parented), the panel's per-prop override rows are dropped, and every raw
  value is stripped — only previews travel;
- the endpoint is POST + `application/json` only, same-origin gated like every
  `/_denext/*` endpoint, re-validates the shape server-side, refuses an oversized
  body with a 413, and silently drops a malformed one;
- at most one snapshot per page URL, across an 8-URL LRU.

Every failure path in the page is swallowed: the app never notices the sink
exists. `denext mcp --disable devtools` hides all three tools when you want the
context back.

## Using the inspector from your own code

The same surface is a module — `denext/devtools` — and is installed on
`window.__denextDevtools` in dev, for editor integrations, tests and tooling of
your own.

```ts
import { installInspector } from "denext/devtools";

const dt = installInspector(); // null in production / before dev is active
if (dt) {
  const tree = dt.getInspectorTree(); // props, hooks, contexts, badges, source
  dt.setHookState(fiberId, hookIndex, next); // live-edit a useState cell
  dt.dispatchReducer(fiberId, hookIndex, action); // …or dispatch to a reducer
  dt.setRefValue(fiberId, hookIndex, node); // …or set a ref's `current`
  dt.setPropOverride(fiberId, "title", "hi"); // pin a prop
  dt.enableRenderReasons(); // then dt.getRenderReason(fiberId)
  dt.startProfiling(); // then dt.getCommits() / dt.getCommitTree(i)
  dt.getBoundaryTimings(); // the live Suspense-boundary waterfall
}
```

`installDevtools()` — which mounts the panel — is called automatically by the dev
entries; you only need `installInspector()` to read the data yourself. Every
function and type is listed in the [API reference](/docs/api).

## Limitations

- **The owner stack is the render-parent chain**, not React's JSX-owner chain.
  They coincide for the common case; a component passed as `children` through a
  wrapper is reported under the wrapper that rendered it.
- **Custom hooks from another module are opaque.** Naming expands a `use*` hook
  only when the same module declared it (three levels deep, breadcrumbed); an
  imported one consumed an unknowable number of cells, so the component falls
  back to kind labels.
- **A conditional hook drops naming for that component** — the metadata and the
  live cells stop lining up, and the panel prefers kind labels over a wrong name.
- **The bundled App Router dev path names less.** `DENEXT_DEV_UNBUNDLED=0` has no
  per-module transform, so only route-structural modules (page, layouts,
  templates, `loading`, `error`, slots) carry a source at all — without a line or
  column — and no component gets hook names. The unbundled dev loop is the
  default, so this affects an explicitly opted-out session only.
- **Network, Cache, Routes and the MCP bridge need the App Router dev server.**
  SPA dev serves no `/_denext/*` endpoints: those tabs render
  `… is not available in SPA dev (App Router only)`, and the Source row falls
  back to a `vscode://` link. Components, Render modes and the Profiler work
  everywhere.

More in [Known limitations](/docs/limitations).
