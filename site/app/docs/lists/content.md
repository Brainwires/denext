---
title: Lists & scrolling
slug: lists
lead: VirtualList and useVirtualList render only the rows near the viewport, so a list of 10 million rows scrolls like one of 100. Rows are measured as they render, the view never jumps when content above it changes, chat lists start at the bottom and stay there, and iOS momentum scrolling is never interrupted.
---

## When to use it

Render a plain list (`items.map(...)`) when it has up to about 1,000 fixed-height rows or 500
rich, variable-height ones (more on phones, where the list's script costs more; see
[the measurements](#server-rendered-lists-and-islands-vs-virtuallist)). The browser handles
that well, find-in-page and printing just work, and there is nothing to configure.

Use `VirtualList` when any of these is true:

- the list can grow to thousands of rows (a feed, a log, a table, search results);
- rows are expensive to render (rich text, images, embeds);
- it is a chat or a timeline that loads history as you scroll up;
- the rows scroll inside a Capacitor app on a phone.

`VirtualList` renders only the rows in and near the viewport. Everything below comes from
`denext` in a `"use client"` component:

```tsx
"use client";
import { VirtualList } from "denext";

export function Inbox({ mail }: { mail: { id: string; subject: string }[] }) {
  return (
    <VirtualList
      style={{ height: "100dvh" }}
      data={mail}
      renderItem={(m) => <div className="row">{m.subject}</div>}
    />
  );
}
```

Rows need no size. The list measures each row as it renders, so text of any length, images and
embeds just work. `estimatedItemSize` is only a hint for rows that have not been measured yet;
without one, the first render shows at most 10 rows and the list learns the typical row size
from the ones it measures. A row measured taller or shorter than its estimate never moves what
you see, so scrolling up into rows not measured yet does not jump.

Keys come from `keyExtractor`, else `item.key`, else `item.id`, else the index (React Native's
rule). Keys matter: a row keeps its component state and focus across data changes, and the
view is anchored by key, so give rows a stable id.

## Server-rendered lists and islands vs VirtualList

On a server-rendered page, a list whose rows are plain HTML costs no JavaScript, and
find-in-page, search engines, screen readers, text selection and printing all see every row. A
`VirtualList` renders a window, so none of that reaches the rows outside it. The scroll
benchmark's server-rendered app (`examples/scroll-bench/ssr`) measures where one stops paying
off. Both kinds of row were measured: 56 px contact rows, and chat messages of 20–2000 px with
prose and code. Each list was loaded cold in headless Chromium, 3 runs per cell. Desktop is
1280×800 with no throttling. Mobile is 412×915 with 4× CPU throttling and a 9 Mbps, 60 ms
network.

Time to interactive (ms), desktop / mobile:

| rows                                  | 1,000     | 2,000      | 5,000      | 10,000      | 50,000       |
| ------------------------------------- | --------- | ---------- | ---------- | ----------- | ------------ |
| HTML + `content-visibility`, 56 px    | 90 / 235  | 136 / 304  | 339 / 712  | 861 / 1265  | 3078 / 7929  |
| `VirtualList` island, 56 px           | 111 / 717 | 102 / 657  | 114 / 643  | 110 / 862   | 124 / 662    |
| HTML + `content-visibility`, chat     | 210 / 319 | 336 / 633  | 821 / 1576 | 1542 / 3065 | 7073 / 15611 |
| `VirtualList` island, chat            | 103 / 666 | 95 / 652   | 96 / 651   | 94 / 647    | 100 / 629    |
| HTML + a `client:load` island per row | 249 / 877 | 372 / 1217 | 811 / 2424 | 1428 / 4477 | 6979 / 24783 |

Measured 2026-09-27 on denext 2.10 and Chromium 125, on an AMD EPYC-Milan Linux VM (8 vCPU,
16 GB, median load 1.8). The full tables (FCP, LCP, blocking time, bytes, memory, frame
times, find-in-page, the accessibility tree) are in
`examples/scroll-bench/results/ssr-2026-09-27/results.md`.

What the numbers say:

- **Up to about 1,000 rows, render them as HTML.** With `content-visibility: auto` on each row,
  the page is interactive as fast as the `VirtualList` island on desktop, and 2–4× faster on
  the mobile profile, where the island first has to download and run its script. It uses about
  the same memory (within 5 MB), blocks the main thread for 0 ms, and every row stays findable
  and in the accessibility tree.
- **From 1,000 to 5,000 short rows (1,000 to 2,000 rich rows), it depends on what matters
  more.** HTML still wins on the mobile profile up to 2,000 rows of either kind, ties at
  5,000 56 px rows, and keeps find-in-page and the accessibility tree. On desktop the island is
  already faster, and a fast fling through 5,000 `content-visibility` rows starts dropping
  frames (p90 33 ms).
- **Past 5,000 rows, use `VirtualList` as one island.** Its time to interactive stays flat, at
  about 100 ms on desktop and 650 ms on mobile, at any size. HTML grows with every row: at
  10,000 56 px rows it takes 1.3 s on mobile and 145 MB of renderer memory (the island takes
  103 MB), and a fling runs at 67 ms frames on desktop. At 50,000 it takes 8–16 s on mobile.
- **Keep `content-visibility: auto` on large HTML lists.** Without it, 10,000 chat messages
  take 9.6 s to become interactive on mobile instead of 3.1 s, and 425 MB of memory instead of
  162 MB.

Put the island where the list is: `client:load` when the list is on screen at load, and
`client:visible` when it sits below the fold, which loads 29 KB of script with the page
instead of 54 KB and hydrates the list when the visitor scrolls to it. Server-render its first
window (the default) so the rows paint before the script arrives. Add `findInPage` if people
search the list: rows outside the window are then in the page as hidden, findable text, but
only the `findInPage.limit` rows around the viewport (2,000 by default; the benchmark finds
the last row up to 2,000 rows and not beyond). For larger lists, pair it with your own
search. See [Islands & hydration](/docs/islands).

In a single-page app or a Capacitor app there is no server HTML to keep, so use `VirtualList`
directly. The SPA's own `VirtualList` in this benchmark had the same flat curve, at about
100 ms on desktop and 550 ms on mobile.

### Row controls on a server-rendered list

A like button or checkbox on every row is where server-rendered lists get expensive. How much
depends on how the buttons become interactive, not on the list. Extra time to interactive per
1,000 rows, compared with the same HTML list without controls (desktop / mobile, 56 px rows):

| per-row control                                                 | extra per 1,000 rows | first click → paint at 1,000 rows |
| --------------------------------------------------------------- | -------------------- | --------------------------------- |
| one listener for the whole list, as a plain script in `public/` | ≈ 0 / 110 ms         | 15 / 11 ms                        |
| one listener for the whole list, as one `client:load` island    | 5 / 130 ms           | 17 / 17 ms                        |
| the row's button as a component in a `resumable` route          | 6 / 180 ms           | 31 / 178 ms                       |
| the row's button as a `client:load` island per row              | 57 / 320 ms          | 12 / 24 ms                        |

The cheapest correct control is one delegated listener. Render each row's button as plain HTML
(`<button data-like aria-pressed="false">`) and handle every click in one `click` listener on
the list, keeping the row's state on the element and sending changes to your server with
`fetch`. Ship the listener as one `"use client"` component with `client:load`, or as a small
script from `public/`: both cost about the same, because a page whose only client components
are islands sends no Server Component payload.

That was not always so. Up to denext 2.10, any island made the page also send its whole
Server Component tree. With one delegating island at 10,000 rows, that meant 10.4 MB of HTML
instead of 4.0 MB, 106 MB of JavaScript heap instead of 1 MB, and 1.9 s to interactive on
desktop instead of 0.9 s.

An island per row still costs the most, because every row carries its own island entry and
hydrates on load. [Resumability](/docs/resumability) keeps the per-row component and skips the
hydration: its time to interactive matches the single listener's on desktop and is about 20%
higher on the mobile profile. The price is a first click on each row that waits for the row's
code (about 180 ms on the mobile profile).

## The API

### Props

Data and sizes:

| Prop                                | Default                        | What it does                                                                          |
| ----------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| `data`                              |                                | The rows. Pass a new array when they change.                                          |
| `count` + `getItem(i)`              |                                | A lazy or huge source instead of `data` (10M rows cost almost nothing until visited). |
| `renderItem(item, index, { type })` | required                       | Renders one row.                                                                      |
| `keyExtractor(item, index)`         | `item.key` / `item.id` / index | A stable key per row.                                                                 |
| `estimatedItemSize`                 | 48                             | Size assumed for rows not yet measured.                                               |
| `getEstimatedItemSize(item, i)`     |                                | A per-row estimate. Rows are still measured.                                          |
| `getItemSize(item, i)`              |                                | An exact size. Those rows are never measured.                                         |
| `estimateText`                      |                                | Predict text rows' heights from font metrics (see [huge lists](#huge-lists)).         |
| `getItemType(item, i)`              |                                | A row type, passed to `renderItem`. Recycling reuses cells only within a type.        |
| `recycle`                           | `false`                        | Reuse row DOM for new rows of the same type. Only safe for rows with no state.        |

Layout and position:

| Prop                                                             | Default      | What it does                                                                                                                                        |
| ---------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `horizontal`                                                     | `false`      | Scroll along x. Right-to-left pages are handled.                                                                                                    |
| `anchor`                                                         | `"start"`    | `"end"` for chat: start at the end, bottom-align short content, stay pinned there.                                                                  |
| `maintainVisibleContentPosition`                                 | `true`       | Keep the visible rows still when rows are added or removed above them. See below.                                                                   |
| `initialScrollIndex` / `initialScrollAlign`                      |              | The row shown first, with no flash of row 0 (also on the server).                                                                                   |
| `overscan`                                                       | one viewport | Px rendered beyond the viewport on each side. The side you scroll toward grows with speed.                                                          |
| `initialNumToRender`                                             | `undefined`  | When set, the first commit renders at most N rows and the rest after the first paint, like React Native. Unset: one commit, a faster time-to-ready. |
| `stickyIndices`                                                  |              | Rows that stick while their section scrolls.                                                                                                        |
| `numColumns`, `gap`, `rowGap`, `columnGap`, `columnWrapperStyle` |              | A grid.                                                                                                                                             |
| `scrollElement`                                                  | `"self"`     | `"window"`, an ancestor element, or a ref to one.                                                                                                   |
| `viewportSize`                                                   | 800          | Viewport assumed without layout: the server and tests.                                                                                              |
| `keepMounted`                                                    |              | Keys of rows that stay mounted while scrolled away.                                                                                                 |
| `scrollSnap`                                                     |              | Snap points: every `interval` px or at `offsets` ([scroll snapping](#scroll-snapping)).                                                             |

What `maintainVisibleContentPosition` covers: only data changes above the view (rows inserted,
prepended or removed there). On, the row you are looking at stays put, found by key. Off, the
content shifts, as in React Native, and a view at the very top shows the new first rows. Size
changes are not data changes: a row measured taller or shorter than its estimate, or a resize,
never moves the view with either setting, and `scrollToIndex` lands exactly either way.

Slots and styles (React Native's names):

| Prop                                                              | What it does                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| `ListHeaderComponent` / `ListFooterComponent`                     | Before and after the rows (a component or an element).               |
| `ListHeaderComponentStyle` / `ListFooterComponentStyle`           | Style of their wrappers.                                             |
| `ListEmptyComponent`                                              | Shown when there are no rows. It fills the viewport.                 |
| `ItemSeparatorComponent`                                          | Between rows.                                                        |
| `contentContainerStyle` / `contentContainerClass`                 | The element around the header, rows and footer: padding, `flexGrow`. |
| `class` / `className`, `style`                                    | The outer element. Give it a height when the list scrolls itself.    |
| `refreshControl`, `refreshing`, `onRefresh`, `progressViewOffset` | [Pull-to-refresh](#pull-to-refresh).                                 |
| `keyboardInset`                                                   | Px of the list covered by the on-screen keyboard ([chat](#chat)).    |

Callbacks:

| Prop                                                                                      | What it does                                                                                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `onEndReached` / `onEndReachedThreshold`                                                  | Load more at the end ([semantics](#infinite-loading)). Threshold in viewports, default 0.5.                         |
| `onStartReached` / `onStartReachedThreshold`                                              | The same at the start (chat history).                                                                               |
| `onRangeChange(first, last)`                                                              | The visible rows changed.                                                                                           |
| `onViewableItemsChanged`, `viewabilityConfig`, `viewabilityConfigCallbackPairs`           | React Native's viewability, with its token shape.                                                                   |
| `onScroll`, `scrollEventThrottle`                                                         | React Native's scroll event (`nativeEvent.contentOffset`, `contentSize`, `layoutMeasurement`), plus `programmatic`. |
| `onScrollBeginDrag` / `onScrollEndDrag` / `onMomentumScrollBegin` / `onMomentumScrollEnd` | The drag and momentum lifecycle, on the web too.                                                                    |
| `onBlankArea`                                                                             | Development only: blank space the rendered rows did not cover.                                                      |

Behaviour switches:

| Prop                             | Default      | What it does                                                                   |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------ |
| `keyboardNavigation`             | `true`       | Arrow, Page, Home and End move focus between rows, into rows not rendered yet. |
| `typeahead`                      | `false`      | Typing a letter jumps to the next row starting with it.                        |
| `announceChanges`                | `false`      | Announce row-count changes to screen readers.                                  |
| `findInPage`                     | `false`      | Make rows outside the window findable with Ctrl/Cmd+F (Chromium).              |
| `itemLayoutAnimation`            | `false`      | Animate rows when the data changes.                                            |
| `progressive`                    | `false`      | Render entering rows as a placeholder first, then their content.               |
| `renderPlaceholder(index)`       | an empty box | The placeholder.                                                               |
| `printLimit`                     | 1000         | Rows rendered when the page is printed.                                        |
| `restoreKey`                     |              | Save and restore the scroll position across navigation.                        |
| `aria-label` / `aria-labelledby` |              | The list's accessible name.                                                    |

### The handle

Pass a ref to get a `VirtualListHandle`:

```tsx
const list = useRef<VirtualListHandle>(null);
// …
<VirtualList ref={list} … />;
list.current?.scrollToIndex(500, { align: "center" });
```

| Method                                              | What it does                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `scrollToIndex(i, { align, behavior, viewOffset })` | Lands exactly on the row, even when it and every row above it were never measured. `align`: `start`, `center`, `end`, `auto`. |
| `scrollToOffset(px, { behavior })`                  | Scroll to a list offset.                                                                                                      |
| `scrollToEnd({ behavior })`                         | Scroll to the end. With `anchor="end"` the list stays pinned there.                                                           |
| `getRange()`                                        | The visible rows.                                                                                                             |
| `isAtEnd()`                                         | Whether the view is at the end (within 4 px).                                                                                 |
| `getScrollOffset()`                                 | The current list offset.                                                                                                      |
| `indexAtPoint(x, y)`                                | The row under a viewport point, or −1.                                                                                        |
| `keyAt(i)`                                          | Row `i`'s key.                                                                                                                |
| `recordInteraction()`                               | Counts as a user interaction for `waitForInteraction`.                                                                        |
| `getScrollableNode()`                               | The element that scrolls the list (null before mount and with `scrollElement="window"`).                                      |
| `getItemLayout(i)`                                  | Row `i`'s `{ offset, size }`: measured, else estimated.                                                                       |
| `getScrollMetrics()`                                | `{ offset, viewport, min, max, rows }`: the scroll position and extent, in list offsets.                                      |

`scrollToIndex` never gives up, so there is no `onScrollToIndexFailed`. It scrolls to the
estimate, measures what rendered, and corrects until the row sits where you asked.

### useVirtualList

`useVirtualList` is the same engine without the markup: it returns props for two elements and
the rows to render, each with its offset. Use it for layouts `VirtualList` does not render, such
as a table ([recipe](#tables)).

```tsx
"use client";
import { useVirtualList } from "denext";

export function Log({ lines }: { lines: string[] }) {
  const list = useVirtualList({ data: lines, estimatedItemSize: 20 });
  return (
    <div {...list.scrollProps} style={{ ...list.scrollProps.style, height: 400 }}>
      <div {...list.innerProps}>
        {list.items.map((row) => (
          <div
            key={row.key}
            ref={row.measureRef}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${row.offset}px)`,
            }}
          >
            {lines[row.index]}
          </div>
        ))}
      </div>
    </div>
  );
}
```

`items` also contains rows kept mounted outside the window (the focused row, `keepMounted`
keys, a text selection's ends). Each has its own `offset`, so they need no special handling.

## Recipes

### Chat

`anchor="end"` is the whole chat behaviour:

- the list starts at the newest message, already there in the server-rendered HTML;
- a short conversation sits at the bottom of the viewport;
- while you are at the bottom, new messages and a streaming last message keep it pinned;
- scrolled up, nothing moves when messages arrive;
- `onStartReached` loads older messages, and prepending them does not move the view, even
  when they are much taller than estimated.
- `pinEndOn` picks which changes keep it pinned (`data`, `items`, `layout`, `footer`; all by
  default). `pinEndOn={{ footer: false }}` leaves the visible messages where they are while a
  composer in the footer grows.

```tsx
"use client";
import { useKeyboard } from "denext/mobile";
import { VirtualList } from "denext";

export function Thread({ messages, loadOlder }: Props) {
  const keyboard = useKeyboard(); // { visible, height } of the on-screen keyboard
  return (
    <VirtualList
      style={{ height: "100%" }}
      data={messages}
      keyExtractor={(m) => m.id}
      anchor="end"
      onStartReached={loadOlder}
      keyboardInset={keyboard.height}
      renderItem={(m) => <Message message={m} />}
    />
  );
}
```

There is no `inverted` transform. The data stays in natural order, so the wheel, the
scrollbar, keyboard scrolling and copy-paste all go the right way.

**The keyboard.** When the keyboard covers the page (`resize: "none"` in the Capacitor Keyboard
plugin, or `navigator.virtualKeyboard.overlaysContent`), pass its height as `keyboardInset`.
The list makes that much room after the last row, and a list at its end stays at its end,
so the last message sits right above the keyboard after one adjustment. When the WebView
resizes for the keyboard instead (the default), the viewport shrinks and a pinned list stays
pinned without the prop. The list never imports `denext/mobile` itself, so an app that does
not use it pays nothing.

### Huge lists

A list of 1M–10M rows works with `count` and `getItem`:

```tsx
<VirtualList
  count={10_000_000}
  getItem={(i) => i}
  getItemSize={() => 32}
  renderItem={(i) => <div>Row {i}</div>}
/>;
```

- **Sizes are stored in a tree over blocks of 256 rows.** Finding a row's offset, or the row at
  an offset, is O(log n). A block that was never visited costs nothing, and far-away measured
  blocks are folded into their average, so memory stays bounded.
- **Past the browser's height limit** (Firefox stops at about 17.2M px, Chromium at about 33.5M px),
  a list cannot be laid out 1:1. Past 8M px, with a wide margin under both, the list lays out a
  capped height and maps it onto the real one. Small scrolls stay 1:1,
  dragging the scrollbar jumps proportionally, and both ends are reachable.
- **Exact sizes.** `getItemSize` gives an exact size per row. Those rows are never measured, and
  the scrollbar is exact from the start. A uniform list of any length samples 32 rows to find
  its size.
- **Estimates.** `getEstimatedItemSize` seeds a row's size until it is measured.
- **Text estimation.** For rows that are mostly text, `estimateText` predicts the height from
  font metrics (canvas `measureText`) before the row renders. Scroll positions and
  `scrollToIndex` targets are then close from the start:

```tsx
<VirtualList
  data={messages}
  estimateText={{
    font: "15px system-ui",
    lineHeight: 20,
    padding: 16, // vertical padding + borders
    text: (m) => m.body,
  }}
  renderItem={(m) => <Message message={m} />}
/>;
```

### Infinite loading

`onEndReached` behaves the way React Native users asked for it to:

- never on mount, unless the content is shorter than the viewport (then once, so a short first
  page loads the next one);
- at most once per data change: it re-arms when the data changes (the row count, or the first
  or last key);
- only while scrolling toward the end: scrolling up near the end does not fire it;
- never while iOS rubber-bands past the edge.

`onStartReached` is the same at the start. Show loading rows by rendering `count` larger than
what is loaded and returning a skeleton from `renderItem` for rows you do not have yet.

### Sticky sections

```tsx
<VirtualList
  data={rows} // headers and items in one array
  stickyIndices={headerIndices}
  renderItem={(r) => (r.type === "header" ? <h3>{r.title}</h3> : <Item item={r} />)}
/>;
```

The sticky row is the real row element, not a copy, so an input inside it keeps focus and it
stays clickable. It sticks even after its section scrolled far out of the rendered window.
When the next header reaches it, it pushes it up, as on iOS. It works with `anchor="end"` too.

### Grids

`numColumns` lays items out in equal columns. Each line is as tall as its tallest item.

```tsx
<VirtualList
  data={photos}
  numColumns={3}
  gap={8} // between rows and columns; rowGap / columnGap set one of them
  renderItem={(p) => <img src={p.src} style={{ width: "100%", aspectRatio: 1 }} />}
/>;
```

Index APIs stay item indices: `scrollToIndex(50)` scrolls to item 50, and `getRange`,
`onRangeChange`, `initialScrollIndex`, `stickyIndices` and viewability all speak in items. The
arrow keys move by cell.

### Masonry

`VirtualMasonry` (from `denext/virtual-masonry`, a separate entry so lists that do not use it do
not bundle it) places variable-height items in balanced columns:

```tsx
"use client";
import { VirtualMasonry } from "denext/virtual-masonry";

export function Pins({ pins, more }: Props) {
  return (
    <VirtualMasonry
      style={{ height: "100dvh" }}
      data={pins}
      numColumns={3}
      gap={8}
      getEstimatedItemSize={(p) => 240 / p.aspect}
      onEndReached={more}
      renderItem={(p) => <img src={p.src} style={{ width: "100%", aspectRatio: p.aspect }} />}
    />
  );
}
```

Each new item goes into the shortest column. A placed item keeps its column, so an image that
loads late moves only the items below it in that column, and appends never reshuffle
anything. It is built for up to about 100k items. For uniform grids of millions, use
`numColumns`.

### Tables

Keep real table semantics (`<table>`, `<thead>`, column widths) with `useVirtualList` and two
spacer rows:

```tsx
"use client";
import { useVirtualList } from "denext";

export function Orders({ orders }: { orders: Order[] }) {
  const list = useVirtualList({ data: orders, estimatedItemSize: 36 });
  const first = list.items[0];
  const last = list.items[list.items.length - 1];
  const before = first ? first.offset : 0;
  const after = last ? list.totalSize - (last.offset + last.size) : 0;
  return (
    <div {...list.scrollProps} style={{ ...list.scrollProps.style, height: 480 }}>
      <table style={{ tableLayout: "fixed", width: "100%", borderCollapse: "collapse" }}>
        <colgroup>
          <col style={{ width: 120 }} />
          <col />
          <col style={{ width: 100 }} />
        </colgroup>
        <thead style={{ position: "sticky", top: 0, background: "Canvas" }}>
          <tr>
            <th>Order</th>
            <th>Customer</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody ref={list.innerProps.ref}>
          <tr style={{ height: before }} />
          {list.items.map((row) => {
            const o = orders[row.index];
            return (
              <tr key={row.key} ref={row.measureRef}>
                <td>{o.id}</td>
                <td>{o.customer}</td>
                <td>{o.total}</td>
              </tr>
            );
          })}
          <tr style={{ height: after }} />
        </tbody>
      </table>
    </div>
  );
}
```

`table-layout: fixed` with a `<colgroup>` keeps the column widths stable as different rows
render. The sticky `<thead>` stays at the top of the scroller.

### Horizontal lists and right-to-left

`horizontal` scrolls along x. On a right-to-left page (`dir="rtl"` on the list or an ancestor)
row 0 starts at the right edge, rows run leftward, and `scrollToIndex`, `onEndReached`, sticky
rows and the arrow keys follow the reading direction. The browser's negative `scrollLeft` in
RTL is handled for you.

### Window scroll and scroll parents

By default the list scrolls itself, so give it a height. `scrollElement="window"` makes the
page scroll the list, for a feed under a site header. Pass an element (or a ref to one) to
virtualize against an ancestor scroller, such as a list inside a scrollable panel or a
horizontal carousel inside a vertical page. The list tracks its offset in the page and
re-reads it only when the layout around it changes, not on every scroll.

### Scroll snapping

`scrollSnap` makes the scroll come to rest on snap points, React Native's way: `interval` (a
snap point every so many px, `snapToInterval`), `align` (where each interval-wide slot meets the
viewport: `"start"`, `"center"`, `"end"`, `snapToAlignment`), `offsets` (snap points at these
content offsets, `snapToOffsets`, with the content's start and end unless `snapToStart` /
`snapToEnd` is `false`), and `stop: "always"` (a fling stops at the next snap point,
`decelerationRate="fast"`).

```tsx
<VirtualList
  horizontal
  data={cards}
  getItemSize={() => 312}
  scrollSnap={{ interval: 312, align: "center", stop: "always" }}
  renderItem={(card) => <Card card={card} />}
/>;
```

It is CSS scroll snap: the scroller gets `scroll-snap-type: <axis> mandatory` and each snap point
an invisible marker, drawn only near the viewport, so the platform's own momentum ends on one
with no JavaScript during the fling. Offsets are content px from the scroller's start (a header
included). A list whose scroll space is scaled (past about 8M px) does not snap.

### Pull-to-refresh

`refreshControl` works as in React Native. The control is rendered around the list's
scroller and gets the list's `class` and `style`. `RefreshControl` from `denext/mobile` is one:

```tsx
"use client";
import { useState, VirtualList } from "denext";
import { RefreshControl } from "denext/mobile";

export function Feed({ posts, reload }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  return (
    <VirtualList
      style={{ height: "100dvh" }}
      data={posts}
      renderItem={(p) => <Post post={p} />}
      refreshControl={RefreshControl}
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await reload();
        setRefreshing(false);
      }}
    />
  );
}
```

Pass the component, and the list hands it `refreshing`, `onRefresh` and `progressViewOffset`.
Or pass an element (`refreshControl={<RefreshControl refreshing={r} onRefresh={f} />}`), React
Native's form. The gesture is touch only, so give mouse and keyboard users a refresh button.
`VirtualList` never imports `denext/mobile`: an app that does not pass a control pays nothing.

### Reordering

`useVirtualReorder` adds drag-to-reorder:

```tsx
"use client";
import { useRef, useVirtualReorder, VirtualList, type VirtualListHandle } from "denext";

export function Playlist({ songs, move }: Props) {
  const list = useRef<VirtualListHandle>(null);
  const reorder = useVirtualReorder({ list, count: songs.length, onReorder: move });
  return (
    <>
      <VirtualList
        ref={list}
        data={songs}
        keepMounted={reorder.keepMounted}
        style={{ height: 480 }}
        renderItem={(s, i) => (
          <div {...reorder.itemProps(i)}>
            <button {...reorder.handleProps(i)} aria-label={`Move ${s.title}`}>⠿</button>
            {s.title}
          </div>
        )}
      />
      {reorder.liveRegion}
    </>
  );
}
```

- **Pointer.** Drag the handle with a mouse, pen or finger. Near the top or bottom edge the list
  scrolls on its own, and the dragged row stays mounted however far it is carried.
- **Keyboard.** Space or Enter picks the row up, the arrow keys move it (into rows not rendered
  yet), Space or Enter drops it, and Escape cancels. Each step is announced.
- **`onReorder(from, to)`** uses splice semantics: remove the item at `from`, insert it at `to`.
- `itemProps(i)` marks the drop position with `data-vl-drop="before" | "after"` and a default
  inset line. Style it however you like.

### Swipe actions

`SwipeableRow` (from `denext`) is a row that swipes sideways to reveal actions, like Mail on
iOS: leading actions under a rightward swipe, trailing actions under a leftward one, and a full
swipe that runs a side's first action.

```tsx
"use client";
import { SwipeableRow, VirtualList } from "denext";

<VirtualList
  data={threads}
  renderItem={(item) => (
    <SwipeableRow
      leading={[{ label: "Unread", tone: "accent", onPress: () => markUnread(item.id) }]}
      trailing={[
        { label: "Archive", tone: "warning", onPress: () => archive(item.id) },
        { label: "Mute", onPress: () => mute(item.id) },
      ]}
    >
      <ThreadRow thread={item} />
    </SwipeableRow>
  )}
/>;
```

- **Safe in a scrolling list.** A drag writes only `transform`s and never reads layout (sizes
  come from one shared `ResizeObserver`), so a row inside a `VirtualList` never forces a layout,
  even mid-scroll. The axis locks after 10 px and only on a horizontal movement: a vertical drag
  stays a scroll (the row is `touch-action: pan-y`), and a scroll closes an open row.
- **Actions.** Each side's actions are listed outermost first; `tone` (`"neutral"`,
  `"accent"`, `"destructive"`, `"warning"`, `"success"`) or `background` / `color` colour them,
  and `icon` goes above the label. `fullSwipe` (default `true`; `false`, `"leading"` or
  `"trailing"`) chooses which sides run their first action on a full swipe, past
  `fullSwipeThreshold` (55% of the row's width). A press runs the action and closes the row.
- **One open row.** Opening a row closes the one that was open; a tap elsewhere, a tap on the
  open row, or Escape closes it. `rowRef` gets `open(side)` / `close()`, and `onOpenChange`
  reports the open side.
- **Haptics.** Inside the native shell a full swipe arming plays a haptic through
  `denext/mobile` (`haptics={false}` turns it off).
- **Accessibility.** Every action is a real `<button>` in the tab order and the accessibility
  tree, named by `accessibilityLabel` or its label; focusing one opens its side so it is visible.
- **With a stack.** A row with leading actions (or an open one) marks itself
  `data-dnx-no-back-swipe`, so `denext/navigation`'s back swipe from anywhere leaves its
  rightward swipe alone; a row with only trailing actions lets the back swipe through.
- `leadingPanel` / `trailingPanel` reveal custom content instead of buttons, `mouse` lets a
  mouse drag swipe, `disabled` turns the gesture off.

In React Native mode, `react-native-gesture-handler/ReanimatedSwipeable` and
`react-native-gesture-handler/Swipeable` resolve to it (see
[community packages](/docs/react-native#community-packages)).

### Animations

`itemLayoutAnimation` animates rows when the data changes. Moved rows glide from where they
were, inserted rows fade in, and removed rows fade out:

```tsx
<VirtualList data={todos} itemLayoutAnimation={{ duration: 180, easing: "ease-out" }} … />
```

Only rows in the rendered window animate, and only for data changes, never for scrolling.
Positions are taken after the list re-anchors, so a row the anchor kept still does not move.
With the prop off, none of this code runs. For whole-page transitions, wrap the data update in
[`ViewTransition`](/docs/api/denext/ViewTransition) instead.

### Keeping rows mounted

A row normally unmounts when it scrolls out of the window. Three kinds of rows stay mounted
anyway:

- the row holding focus, so a half-typed input or a focused button survives scrolling;
- the first and last rows of a text selection, while the selection exists;
- the keys in `keepMounted`, for a playing video, a form in progress, or a dragged row.

```tsx
<VirtualList data={clips} keepMounted={playingId ? [playingId] : []} … />
```

### Find in page

Ctrl/Cmd+F only finds text that is in the page, and a virtual list renders a window. With
`findInPage`, rows outside the window are rendered as cheap `hidden="until-found"` text stubs
(up to `limit`, default 2000, around the viewport). When the browser finds a match in one, the
list scrolls that row into view. This works in Chromium; elsewhere the prop does nothing.

```tsx
<VirtualList data={docs} findInPage={{ text: (d) => d.title + " " + d.summary }} … />
```

### Accessibility

- The list is `role="list"` and every row is `role="listitem"` with `aria-setsize` (the full
  count) and `aria-posinset`, so screen readers announce "item 5,001 of 1,000,000".
- The arrow keys, Page Up/Down, Home and End move focus between rows, including rows not
  rendered yet, with a roving `tabindex` (one Tab stop for the whole list).
- `typeahead` jumps to the next row whose text starts with the typed letters. Pressing the same
  letter again cycles.
- `announceChanges` reports row-count changes politely ("12 items", or your own message).
- Give the list a name with `aria-label` or `aria-labelledby`.

### Scroll restoration

```tsx
<VirtualList restoreKey="inbox" data={mail} … />
```

The list saves the row at the top, its offset, and the sizes around it when it unmounts or
the page is hidden. It restores that view when it mounts again for the same history entry:
back and forward (through denext's router, or a reload), or a remount on the same page. A new
navigation to the page starts at the top. The snapshot is keyed by the history entry and the
`restoreKey`, and lives in `sessionStorage`. A chat that was at its end comes back at its new
end.

You don't need `restoreKey` for development. An edit normally updates the list in place, so it
keeps its position, its measured sizes and its rows' state. When an edit does remount it (a
change to a component's hooks, which reloads the page, or a whole-entry refresh), a list without
`restoreKey` lands back on the same row in dev by itself. Its snapshot is keyed by the list's
position in the page. Other remounts, navigations and back/forward start where they would in
production.

### Printing

When the page is printed, the list renders up to `printLimit` rows (default 1000) in normal
flow, starting from the first visible row, and the scroller stops clipping them, so they
paginate. After printing it goes back to a window. Raise the limit for longer printouts,
knowing each row is real DOM for the duration.

### Server rendering

The server renders the first window: at `initialScrollIndex`, or the last rows for
`anchor="end"`. That window is laid out so it shows correctly with scripts disabled. The client
adopts those rows during hydration without re-creating them or moving them. Without layout,
the server assumes a viewport of `viewportSize` px (default 800).

### Testing

`render` from `denext/testing` has no layout engine, and the list is built for that. Without a
`ResizeObserver` nothing is measured: sizes come from `getItemSize` or the estimates, and the
viewport from `viewportSize`. The rendered rows are therefore deterministic:

```ts
import { render } from "denext/testing";
import { h } from "denext/jsx-runtime";

const screen = await render(h(Inbox, { mail }));
// With getItemSize={() => 40} and viewportSize={400}: rows 0–9 plus overscan.
screen.getByText("Welcome!");
```

To drive scrolling in a test, set `scrollTop` on the element with the
`data-denext-virtual-list` attribute and dispatch `scroll`.

## Performance

What the list does for you:

- **No React work while you scroll inside the window.** A passive scroll listener updates the
  window's offset. The component re-renders only when the rendered range has to change, and
  rows whose props did not change are skipped.
- **No scroll writes during an iOS fling.** WebKit stops a momentum fling on any scroll write.
  When a row above the viewport is measured taller than estimated, the list absorbs the
  difference in the window's offset and writes the scroll position once, after the fling ends.
  It sets `overflow-anchor: none` and does its own anchoring, so the browser's anchoring (Safari
  27, Chromium, Firefox) cannot double-correct.
- **Overscan grows in the scroll direction** with scroll speed, so fast flings show fewer blank
  frames.
- **Scaled height** past the browser's element-size limit (see [huge lists](#huge-lists)).
- **`progressive`** renders rows that enter during a fast scroll as placeholders first, then
  their content in small slices between frames (visible rows first), so heavy rows never block
  a frame on a whole window of them.

How to keep rows cheap:

- Keep `renderItem` light, and put the row in its own component so it re-renders only when its
  item changes.
- Give images fixed dimensions (`width` + `height`, or `aspect-ratio`) so a late load does not
  resize the row.
- Avoid expensive CSS on rows: `backdrop-filter`, large `box-shadow` blurs and `filter` cost
  a repaint per row per frame, especially in Android WebViews.
- Use `getItemSize` when rows really are all the same size: nothing is measured.
- Use `onBlankArea` in development to see whether the overscan keeps up.

## React Native

In React Native mode (`reactNative: true`), an app's lists run on this engine with no code
changes:

- `FlatList`, `SectionList` and `VirtualizedList` from `react-native`. denext replaces them
  inside react-native-web, so a deep `react-native/Libraries/Lists/…` import and
  `Animated.FlatList` get them too.
- `@shopify/flash-list` (v2).
- `@legendapp/list` and `@legendapp/list/react-native`. `@legendapp/list/react`, the DOM
  build, stays the real package unless the top-level `lists: "denext"` is set (see
  [LegendList on the web](#legendlist-on-the-web)).
- `@legendapp/list/reanimated` and `@legendapp/list/keyboard`, which wrap LegendList's native
  scroll view: `AnimatedLegendList` is the list with `sharedValues` kept current
  (`itemLayoutAnimation` and `animatedProps` have no effect), and `KeyboardAwareLegendList` the
  list with room after the last item for the composer (`contentInsetEndAdjustment`, a shared
  value from `useKeyboardChatComposerInset`, plus `contentInsetEndStaticAdjustment`); the web
  view's layout follows the keyboard, so its keyboard props have no effect.
  `useKeyboardScrollToEnd` scrolls to the end (closing the keyboard when asked). The ref's
  `reportContentInset({ bottom })` adds room after the last item too.

The adapters render with the app's own react-native-web `View`, `StyleSheet` and
`RefreshControl`, so `style`, `contentContainerStyle`, `columnWrapperStyle` and the header
styles resolve as they would on a `View`.

| Prop or method                                                                                                                                                                                                                            | FlatList / SectionList / VirtualizedList                                                                                                                                                                                                                                                                                                                        | FlashList v2                                                                                                                                                     | LegendList                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `data`, `renderItem`, `keyExtractor`, `extraData`                                                                                                                                                                                         | Yes. `renderItem` gets `{ item, index, separators }`. Keys fall back to `item.key`, then `item.id`, then the index. Rows re-render when `extraData` changes.                                                                                                                                                                                                    | Yes. `renderItem` gets `{ item, index, target: "Cell", extraData }`.                                                                                             | Yes. `renderItem` gets `{ item, index, type, data, extraData }`. `children` mode works.                     |
| `getItem` / `getItemCount`                                                                                                                                                                                                                | `VirtualizedList`: any data source.                                                                                                                                                                                                                                                                                                                             | —                                                                                                                                                                | —                                                                                                           |
| `getItemLayout`                                                                                                                                                                                                                           | Exact. The item's `length`, separator included, is its size and it is never measured.                                                                                                                                                                                                                                                                           | Not in v2.                                                                                                                                                       | `getFixedItemSize` and `getEstimatedItemSize` are estimates the engine confirms by measuring.               |
| `inverted`                                                                                                                                                                                                                                | A logical reversal. Item 0 sits at the bottom and the view starts and stays there. Wheel, keys, scrollbar, selection and copy order are natural; there is no `scaleY(-1)`. The header renders at the bottom and the footer at the top. `onEndReached` fires at the visual top. Offsets and `viewPosition` use React Native's inverted coordinates.              | The same, logical.                                                                                                                                               | Not in LegendList. Use `alignItemsAtEnd` + `maintainScrollAtEnd`.                                           |
| `numColumns`, `columnWrapperStyle`                                                                                                                                                                                                        | React Native's rows: a `flexDirection: "row"` `View` with `columnWrapperStyle`. Row indices for `scrollToIndex` / `getItemLayout`, one viewability token per item.                                                                                                                                                                                              | Fixed-width cells. `overrideItemLayout` sets `span`. `masonry` uses `VirtualMasonry`.                                                                            | The same, plus `columnWrapperStyle` gaps.                                                                   |
| `initialScrollIndex`                                                                                                                                                                                                                      | Yes; at the bottom when `inverted`.                                                                                                                                                                                                                                                                                                                             | Yes, plus `initialScrollIndexParams.viewOffset`.                                                                                                                 | Yes (number or `{ index, viewOffset, viewPosition }`), plus `initialScrollOffset` and `initialScrollAtEnd`. |
| `onEndReached`, `onStartReached` (+ thresholds)                                                                                                                                                                                           | Yes, with `{ distanceFromEnd }` / `{ distanceFromStart }`. React Native's default threshold is 2 viewports. Each fires once per data change.                                                                                                                                                                                                                    | Yes (default 0.5).                                                                                                                                               | Yes (default 0.5).                                                                                          |
| `maintainVisibleContentPosition`                                                                                                                                                                                                          | As in React Native: off by default, so items inserted above the view shift it (a view at the very top shows them); with the prop, the visible items stay put and `autoscrollToTopThreshold` scrolls to new first items near the start. Items measured taller or shorter than estimated never move the view either way, and `scrollToIndex` is exact either way. | v2's object form, on by default: `disabled`, `autoscrollToTopThreshold`, `autoscrollToBottomThreshold`, `animateAutoScrollToBottom`, `startRenderingFromBottom`. | On by default, plus `maintainScrollAtEnd` (+ threshold) and `alignItemsAtEnd`.                              |
| `onViewableItemsChanged`, `viewabilityConfig`, `viewabilityConfigCallbackPairs`                                                                                                                                                           | Yes. SectionList tokens carry `section`, and headers and footers have `index: null`.                                                                                                                                                                                                                                                                            | Yes.                                                                                                                                                             | Yes, plus `start` / `end`. The cell hooks `useViewability` and `useViewabilityAmount` work too.             |
| `refreshing`, `onRefresh`, `refreshControl`, `progressViewOffset`                                                                                                                                                                         | `onRefresh` alone gets denext's `RefreshControl`, as React Native does.                                                                                                                                                                                                                                                                                         | Yes.                                                                                                                                                             | Yes.                                                                                                        |
| `ListHeaderComponent`, `ListFooterComponent`, `ListEmptyComponent` (+ `Style`)                                                                                                                                                            | Yes. The empty state fills the viewport.                                                                                                                                                                                                                                                                                                                        | Yes, plus `ListEmptyComponentStyle`.                                                                                                                             | Yes.                                                                                                        |
| `ItemSeparatorComponent`                                                                                                                                                                                                                  | Between items, with `highlighted` and `leadingItem`. `separators.highlight()` / `unhighlight()` / `updateProps()` work. SectionList adds `SectionSeparatorComponent`.                                                                                                                                                                                           | `leadingItem`, `trailingItem`.                                                                                                                                   | `leadingItem`.                                                                                              |
| `stickyHeaderIndices`, `stickySectionHeadersEnabled`                                                                                                                                                                                      | The real row sticks. SectionList headers stick by default, except on Android-like platforms, as in React Native.                                                                                                                                                                                                                                                | Yes, plus `onChangeStickyIndex`.                                                                                                                                 | Yes, plus `onStickyHeaderChange`.                                                                           |
| `CellRendererComponent`                                                                                                                                                                                                                   | Wraps each item (`cellKey`, `index`, `item`).                                                                                                                                                                                                                                                                                                                   | Yes.                                                                                                                                                             | —                                                                                                           |
| `horizontal`, `style`, `contentContainerStyle`                                                                                                                                                                                            | Yes.                                                                                                                                                                                                                                                                                                                                                            | Yes.                                                                                                                                                             | Yes.                                                                                                        |
| `onScroll`, `scrollEventThrottle`, drag / momentum callbacks, `onLayout`                                                                                                                                                                  | Yes, with React Native's event shapes.                                                                                                                                                                                                                                                                                                                          | Yes.                                                                                                                                                             | Yes.                                                                                                        |
| `scrollEnabled`, `showsVerticalScrollIndicator` / `showsHorizontalScrollIndicator`, `pagingEnabled` / `snapToAlignment`, `snapToInterval` / `snapToOffsets` / `snapToStart` / `snapToEnd`, `decelerationRate` / `disableIntervalMomentum` | Yes. Hidden indicators are CSS; paging and snapping are CSS scroll snap ([scroll snapping](#scroll-snapping)); `decelerationRate="fast"` stops a fling at the next snap point, the momentum curve is the platform's.                                                                                                                                            | Yes.                                                                                                                                                             | Yes.                                                                                                        |
| `keyboardDismissMode`                                                                                                                                                                                                                     | `"on-drag"` (and `"interactive"`) dismisses the keyboard as a drag starts.                                                                                                                                                                                                                                                                                      | Yes.                                                                                                                                                             | Yes.                                                                                                        |
| `keyboardShouldPersistTaps`                                                                                                                                                                                                               | Accepted, best effort. On the web, a tap on a focusable control keeps the keyboard up, and the browser decides the rest.                                                                                                                                                                                                                                        | Same.                                                                                                                                                            | Same.                                                                                                       |
| `initialNumToRender`                                                                                                                                                                                                                      | When set, the first commit renders at most N items and the rest after the first paint, like React Native. Unset (React Native defaults to 10): one commit renders the whole window, a faster time-to-ready.                                                                                                                                                     | `drawDistance` sets the overscan.                                                                                                                                | `drawDistance` sets the overscan.                                                                           |
| `windowSize`, `maxToRenderPerBatch`, `updateCellsBatchingPeriod`, `removeClippedSubviews`                                                                                                                                                 | Accepted, no effect. The window follows the viewport and the scroll speed.                                                                                                                                                                                                                                                                                      | `drawDistance` sets the overscan.                                                                                                                                | `drawDistance` sets the overscan.                                                                           |
| `disableVirtualization`                                                                                                                                                                                                                   | Renders every item.                                                                                                                                                                                                                                                                                                                                             | —                                                                                                                                                                | —                                                                                                           |
| Recycling                                                                                                                                                                                                                                 | Off.                                                                                                                                                                                                                                                                                                                                                            | Off unless the app sets `recycleItems`, a denext extra. `useRecyclingState` still resets on its deps, and `useLayoutState` is `useState`.                        | `recycleItems` turns it on. `useRecyclingState` / `useRecyclingEffect` follow the cell's item.              |
| `scrollToIndex` (`viewPosition`, `viewOffset`, `animated`)                                                                                                                                                                                | Exact, measured or not. An index out of range throws, as in React Native.                                                                                                                                                                                                                                                                                       | Returns a promise.                                                                                                                                               | Returns a promise, plus `scrollIndexIntoView`.                                                              |
| `scrollToItem`, `scrollToOffset`, `scrollToEnd`                                                                                                                                                                                           | Yes. `scrollToEnd` goes to the visual top when `inverted`.                                                                                                                                                                                                                                                                                                      | Yes, plus `scrollToTop`.                                                                                                                                         | Yes.                                                                                                        |
| `scrollToLocation`                                                                                                                                                                                                                        | SectionList: `itemIndex` counts from the header (0 is the header), as in React Native. The item lands below its sticky header.                                                                                                                                                                                                                                  | —                                                                                                                                                                | —                                                                                                           |
| `getScrollableNode`, `getNativeScrollRef`, `getScrollResponder`                                                                                                                                                                           | The scroll element, and a `ScrollView`-like object over it.                                                                                                                                                                                                                                                                                                     | Yes, plus `getLayout`, `getFirstVisibleIndex`, `computeVisibleIndices` and `getWindowSize`.                                                                      | Yes, plus `getState()`.                                                                                     |
| `recordInteraction`, `flashScrollIndicators`                                                                                                                                                                                              | `recordInteraction` counts for `waitForInteraction`. `flashScrollIndicators` does nothing on the web.                                                                                                                                                                                                                                                           | Same.                                                                                                                                                            | Same.                                                                                                       |
| `onBlankArea`                                                                                                                                                                                                                             | —                                                                                                                                                                                                                                                                                                                                                               | Development only.                                                                                                                                                | —                                                                                                           |

**`onScrollToIndexFailed` never fires.** `scrollToIndex` does not need `getItemLayout` to land:
the engine scrolls to the estimate, measures, and corrects. Code that uses the callback to
retry keeps working; the retry never runs.

**Custom scroll views.** `renderScrollComponent` (all five lists) renders the list inside the
app's own scroll view, a `ScrollView`, `Animated.ScrollView` or a keyboard-aware one: the
element it returns gets the list's ref and the items as children, as React Native's
`VirtualizedList` clones it, and its scroll node becomes the list's scroller. It receives the
list's props (`style`, `horizontal`, `refreshControl`, the indicator and keyboard props) without
the scroll callbacks, `onLayout` and `onContentSizeChange`, which the list reports itself, so
none fires twice. FlashList takes a component or a function, as v2 does.

**The keyboard.** `automaticallyAdjustKeyboardInsets` adds room after the last item for the part
of a vertical list the on-screen keyboard covers (at the bottom, also when `inverted`), so every
item scrolls above it, and a list resting at its end stays there. Where the web view resizes
around the keyboard (Android, the iOS shell's default) nothing overlaps and nothing is added.

**LegendList's layout reports.** `anchoredEndSpace` keeps an anchor item at the viewport's start
by adding room after the last item (the viewport minus the items from the anchor on, the footer
and the content's end padding), with `onSizeChanged` and `onReady` as LegendList calls them; the
items from the anchor on stay rendered. `onItemSizeChanged` reports each measured size change
with the item, `onMetricsChange` the header's and footer's sizes, and `snapToIndices` makes those
items snap points (with the content's start and end, unless `snapToStart` / `snapToEnd` is
`false`).

**FlashList's benchmark.** `useBenchmark`, `useFlatListBenchmark`, `useDataMultiplier`,
`JSFPSMonitor`, `autoScroll` and `Cancellable` run as on a device: the list scrolls to its end and
back at a fling's speed while animation frames are counted, then the callback gets the frame
rate and FlashList's suggestions. For a profile of a route, use `denext profile`.

`deno task parity:native` checks every adapter's props, ref methods and exports against the
pinned React Native 0.86.3, react-native-web 0.21.2, FlashList 2.3.2 and LegendList 3.4.0. None
is missing: `scripts/parity/native/baselines/lists.known-gaps.json` is empty. SectionList's
`data`, `getItem` and `getItemCount` are waived: its type inherits them, but React Native's
`SectionList` never reads them (the items come from `sections`).

### The escape hatch

To keep the libraries' own engines app-wide:

```ts
// denext.config.ts
export default {
  mode: "spa",
  spa: { entry: "./index.ts" },
  reactNative: { lists: "library" }, // default: "denext"
};
```

For a single list, import react-native-web's original FlatList directly:
`import FlatList from "react-native-web/dist/vendor/react-native/FlatList"`. This is a deep
path, stable in react-native-web 0.19 to 0.21. The scroll benchmark runs both engines in one
app this way (`rnw-flatlist-denext` against `rnw-flatlist-rnw`).

## LegendList on the web

An app that uses `@legendapp/list/react` (LegendList's DOM build) runs it on this engine with
one config line and no code changes, in SPA mode and on the App Router (the server render
too):

```ts
// denext.config.ts
export default {
  lists: "denext", // default: "library" (the real package)
};
```

Every `@legendapp/list/react` import, the app's own and its packages', resolves to a
`LegendList` built from the same adapter React Native mode uses, over plain DOM elements. The
props, ref methods and cell hooks are LegendList 3.4's; `deno task parity:native` checks them
against the pinned package (`@legendapp/list/react#LegendList`, none missing). What the web
build adds over the React Native one:

- `className` and `contentContainerClassName` style the scroll element and the content
  container; `style`, `contentContainerStyle` and the header and footer styles are CSS objects.
- The other DOM attributes (`id`, `data-*`, `aria-*`, `tabIndex`, event handlers such as
  `onKeyDown`) land on the scroll element.
- `getScrollableNode()`, `getNativeScrollRef()`, `getAnimatableRef()`, `getScrollResponder()`
  and `refScrollView` give the scroll element itself.
- `contentInsetEndAdjustment` and the end of `contentInset` add room after the last item.

Chat lists keep LegendList's behaviour: `initialScrollAtEnd` starts at the end,
`maintainScrollAtEnd` (with `maintainScrollAtEndThreshold` and its `{ animated }` form) follows
new items and size changes while the view is at the end (its `on` keys pick which, as in
LegendList: `dataChange`, `itemLayout`, `layout`, `footerLayout`; given `on`, only the keys set
to `true` keep the end pinned), `alignItemsAtEnd` bottom-aligns a
short conversation, and `anchoredEndSpace` keeps a sent message at the top while the reply
streams in. The ref's `scrollToEnd`, `scrollToIndex`, `scrollToOffset`, `scrollToItem` and
`scrollIndexIntoView` return promises, and `getState()` reports the scroll position, the
visible range and each item's position and size. Its `listen` calls back with `totalSize`,
`headerSize`, `footerSize`, `anchoredEndSpaceSize`, `isAtEnd`, `isAtStart`, `isNearEnd`,
`isNearStart`, `isWithinMaintainScrollAtEndThreshold`, `lastItemKeys`, `numContainers`,
`otherAxisSize`, `readyToRender` and `activeStickyIndex` when they change, and
`listenToPosition` with an item's position; the other listener types never call back.

The differences from the real DOM build: the engine's own (estimates are confirmed by
measuring, `waitForInitialLayout` and `itemsAreEqual` have no effect, `adaptiveRender` is always
`"normal"`), the start insets of `contentInset` have no effect, and the scroll element carries
the engine's inline `height: 100%` (a `style` height, or a class with a max height, still sizes
it). The switch applies to apps on npm React (the esbuild build path); a denext-native app uses
`VirtualList` directly.

## Limitations

- **Masonry** (`VirtualMasonry`) is a separate, simpler engine: vertical only, its own scroller
  or the window, no scaled height, no sticky items. It is built for up to about 100k items.
- **Find-in-page** works only in Chromium (`hidden="until-found"`), and only for the
  `findInPage.limit` rows around the viewport.
- **Printing** is capped at `printLimit` rows.
- **Text selection** keeps its first and last rows mounted. Rows in between that scrolled out
  of the window are not in the DOM, so copying a selection larger than the rendered window
  misses them.
- **Pull-to-refresh** is a touch gesture. There is no mouse or keyboard equivalent.
- **Grids** size each line by its tallest item, and cells in a line share one height.
- **Drag and scroll events on the web** are inferred from touch events, `scrollend` and a short
  quiet period. The web has no drag or momentum events of its own.
- **Very large jumps in a scaled list** (dragging the scrollbar across 10M rows) move
  proportionally, not row-exactly. `scrollToIndex` is exact.
- **`recycle`** reuses row DOM and component state. Use it only for rows with no state.
- **`useVirtualList`** positions rows absolutely and does not render grids, sticky rows,
  placeholders or print mode itself. Those are `VirtualList` features.
