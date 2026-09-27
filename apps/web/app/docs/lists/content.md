---
title: Lists & scrolling
slug: lists
lead: VirtualList and useVirtualList render only the rows near the viewport, so a list of 10 million rows scrolls like one of 100. Rows are measured as they render, the view never jumps when content above it changes, chat lists start at the bottom and stay there, and iOS momentum scrolling is never interrupted.
---

## When to use it

Render a plain list (`items.map(...)`) when it has a few hundred rows or fewer. The browser
handles that well, find-in-page and printing just work, and there is nothing to configure.

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
embeds just work. `estimatedItemSize` (default 48) is only a hint for rows that have not been
measured yet.

Keys come from `keyExtractor`, else `item.key`, else `item.id`, else the index (React Native's
rule). Keys matter: a row keeps its component state and focus across data changes, and the
view is anchored by key, so give rows a stable id.

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

| Prop                                                             | Default      | What it does                                                                               |
| ---------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| `horizontal`                                                     | `false`      | Scroll along x. Right-to-left pages are handled.                                           |
| `anchor`                                                         | `"start"`    | `"end"` for chat: start at the end, bottom-align short content, stay pinned there.         |
| `maintainVisibleContentPosition`                                 | `true`       | Keep the visible rows still when content above them changes.                               |
| `initialScrollIndex` / `initialScrollAlign`                      |              | The row shown first, with no flash of row 0 (also on the server).                          |
| `overscan`                                                       | one viewport | Px rendered beyond the viewport on each side. The side you scroll toward grows with speed. |
| `stickyIndices`                                                  |              | Rows that stick while their section scrolls.                                               |
| `numColumns`, `gap`, `rowGap`, `columnGap`, `columnWrapperStyle` |              | A grid.                                                                                    |
| `scrollElement`                                                  | `"self"`     | `"window"`, an ancestor element, or a ref to one.                                          |
| `viewportSize`                                                   | 800          | Viewport assumed without layout: the server and tests.                                     |
| `keepMounted`                                                    |              | Keys of rows that stay mounted while scrolled away.                                        |

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
  the list lays out a capped height and maps it onto the real one. Small scrolls stay 1:1,
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

FlatList, SectionList, FlashList and LegendList compatibility is coming through the React
Native adapters, which run those components on this list.

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
