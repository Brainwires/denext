---
title: Native-feel navigation
slug: navigation-native
lead: Stacks that keep the screen below, platform push and pop animations, the iOS swipe-back that follows your finger, Android predictive back, tabs that keep their state, and bottom sheets. denext/navigation turns App Router routes into native-feeling navigation, and draws React Navigation and Expo Router in React Native mode.
---

`denext/navigation` gives an App Router app the navigation a native app has:

- **`StackLayout`**: the routes under a layout become a stack. A push keeps the screen below
  mounted, with its state and scroll position, and a pop shows it again at once.
- **`TabsLayout`**: a tab bar whose tabs keep their state and their own stacks.
- **`Sheet`**: a bottom sheet with detents.
- **`HistoryStack`** / **`HistoryTabs`**: the same stack and tab bar for an app on another
  router (TanStack Router, React Router, or none); see
  [Other routers](#other-routers-tanstack-router-react-router).

Everything is DOM and CSS: animations move only `transform`, `opacity` and `filter`, so they
run on the compositor, and no gesture writes a scroll position (iOS momentum scrolling is safe).
An app that does not import `denext/navigation` ships none of it.

Add it to `deno.json`'s `imports` next to your other `denext/*` entries:

```json
{
  "imports": {
    "denext/navigation": "jsr:@denext/denext@^2.11.0/navigation"
  }
}
```

The components use hooks, so render them from a `"use client"` file and use that file from
your layout. A layout can stay a Server Component: its `children` (the page) arrive as
already-rendered output.

## Stacks

```tsx
// app/items/stack.tsx
"use client";
import type { VNodeChildren } from "denext";
import { StackLayout } from "denext/navigation";

export function ItemsStack({ children }: { children: VNodeChildren }) {
  return (
    <StackLayout base="/items" screenOptions={{ headerShown: true }}>
      {children}
    </StackLayout>
  );
}
```

```tsx
// app/items/layout.tsx
import type { VNodeChildren } from "denext";
import { ItemsStack } from "./stack.tsx";

export default function Layout({ children }: { children: VNodeChildren }) {
  return <ItemsStack>{children}</ItemsStack>;
}
```

```tsx
// app/items/[id]/page.tsx
import { Link } from "denext";

export const screenOptions = { title: "Item", headerLargeTitle: true };

export default async function Item({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Link href={`/items/${id}/comments`}>Comments</Link>;
}
```

Every navigation under `/items` is a stack operation:

- **Push**: a link, `router.push()` or `useStackNavigation().push()` to a deeper route adds a
  screen. The screen below stays mounted but hidden (`<Activity>`): its state, its DOM and its
  scroll position survive, and its effects are torn down until it shows again.
- **Pop**: the browser's back button, `history.back()`, the header's back button, a link to a
  screen below, the iOS edge swipe and Android's back all pop. A pop to a kept screen shows it
  at once, without waiting for the network.
- **Replace**: `useStackNavigation().replace(href)` swaps the top screen (a history replace).
- **Depth**: `maxDepth` (default 10) screens stay mounted. Deeper ones are unloaded, but keep
  their history entries: popping back to one loads it again.

Each screen is its own scroll container (the page scrolls inside the screen, not the window),
and the stack is `100dvh` tall by default (`100%` inside `TabsLayout`); pass `style` to change
it.

### Screen options

A page's `export const screenOptions = { … }` sets its options. They are plain JSON, sent with
the page's data; `StackLayout`'s `screenOptions` prop sets the defaults for every screen.

| Option                                                                  | Effect                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`                                                                 | The header title, and the iOS back label on the screen above.                                                                                                                                |
| `animation`                                                             | `"default"` (the platform's), `"ios_from_right"`, `"slide_from_right"`, `"slide_from_bottom"`, `"fade"`, `"fade_from_bottom"`, `"shared_axis_x"`, `"none"`, … (react-native-screens' names). |
| `animationDuration`                                                     | The transition length in ms.                                                                                                                                                                 |
| `gestureEnabled`                                                        | Whether the iOS swipe and Android predictive back can pop it (default `true`).                                                                                                               |
| `presentation`                                                          | `"card"` (default), `"modal"`, `"formSheet"` or `"transparentModal"`. See [Modals and sheets](#modals-and-sheets).                                                                           |
| `headerShown`                                                           | Draw the native-style header (default `false`).                                                                                                                                              |
| `headerLargeTitle`                                                      | iOS: a large title that collapses into the header as the screen scrolls.                                                                                                                     |
| `headerBackTitle`, `headerBackVisible`                                  | The back button's label and visibility.                                                                                                                                                      |
| `headerBackButtonDisplayMode`                                           | iOS: `"default"` (the previous screen's title), `"generic"` ("Back") or `"minimal"` (the chevron alone; the title stays as its `aria-label`).                                                |
| `sheetAllowedDetents`, `sheetInitialDetentIndex`, `sheetGrabberVisible` | A `"formSheet"`'s detents, the one it opens at, and its grabber.                                                                                                                             |

From inside a screen, `useStackNavigation()` gives `push`, `pop(count?)`, `popToTop`,
`replace`, `canGoBack`, `index` and `setOptions`, which also takes the component-valued slots
`headerTitle`, `headerLeft` and `headerRight`:

```tsx
"use client";
import { useEffect } from "denext";
import { useStackNavigation } from "denext/navigation";

export function EditButton({ id, name }: { id: string; name: string }) {
  const nav = useStackNavigation();
  useEffect(() => {
    nav.setOptions({
      title: name,
      headerRight: (
        <button type="button" onClick={() => nav.push(`/items/${id}/edit`)}>Edit</button>
      ),
    });
  }, [id, name]);
  return null;
}
```

### How the URL and the stack stay in step

The URL history is the stack. Every history entry the stack shows is stamped (in
`history.state`) with the stack as it stood, so:

- the browser's back and forward buttons move through the stack;
- a reload keeps the screens below: they come back unloaded and load when popped back to;
- a back to a screen the stack still holds is **claimed**: the stack shows the kept screen,
  its title and its hydration data straight away, and the router re-renders that route in the
  background (so `usePathname()`, `useParams()` and server data catch up without a visible
  change);
- a link to a screen below goes back through history to it rather than pushing a copy, so
  history holds one entry per screen.

`router.replace()` from `useRouter()` counts as a push in the stack; use
`useStackNavigation().replace()` inside a stack.

### Transitions

The default animation is the platform's: on iOS (and desktop browsers) the new screen slides
in from the right while the one below slides a third of the way under and dims; on Android it
is Material's shared-axis fade through. A push to a new screen runs inside the router's View
Transition where the browser has View Transitions (Chromium, Safari 18+); a pop to a kept
screen, and every transition where View Transitions are missing, animates the screens directly
with the Web Animations API. A shared `ViewTransition` name inside two screens still morphs
between them.

With `prefers-reduced-motion: reduce`, every animation becomes a 150 ms fade (and `"none"`
stays none), and sheets appear without sliding.

### Gestures

- **iOS swipe-back.** A touch that starts within 20 px of the stack's left edge and moves
  horizontally (the axis locks after the first 10 px, so vertical scrolling is never taken)
  moves the screen with the finger, with the screen below sliding back in parallax. Letting go
  pops when the screen is past halfway or flung right, and springs back otherwise. On by default
  with the iOS look; `swipeHaptic` adds a light haptic on commit. In mobile Safari the browser's
  own back swipe runs instead; the stack then pops without animating twice.
- **Swipe back from anywhere.** `fullScreenSwipe` (or a screen's `fullScreenGestureEnabled`
  option, react-native-screens' name) lets the swipe start anywhere on the screen, not only at
  the edge. It is stricter about direction, so it never steals a scroll: the axis locks only when
  the movement is at least 1.4 times as horizontal as vertical, and a fling pops only once it has
  travelled 72 px. It yields to text fields, to horizontal scrollers, and to any element marked
  `data-dnx-no-back-swipe`, which a [`SwipeableRow`](/docs/lists#swipe-actions) with leading
  actions (or an open one) sets on itself. Off by default in `StackLayout`, on by default in
  `HistoryStack`.
- **Android predictive back.** In the Capacitor shell with `denext mobile add back`, the back
  gesture previews the pop: the top screen shrinks toward the gesture's edge as the progress
  grows, and the pop commits or springs back when the gesture ends. The back button pops too.

The screens set `touch-action: pan-y pinch-zoom` so the browser leaves horizontal movement to
the swipe. A scroll container of your own inside a screen (a virtualized list's scroller) needs
the same, or Chrome may take the horizontal movement from the swipe.

## Modals and sheets

`presentation` changes how a screen is shown; the screen is still a route and a history entry,
so back and deep links work the same.

```tsx
// app/items/filter/page.tsx: a sheet over the list
export const screenOptions = {
  presentation: "formSheet",
  sheetAllowedDetents: ["medium", "large"],
  title: "Filter",
};
```

- `"formSheet"` shows the route in a [`Sheet`](#sheet) over the screen below, which stays
  visible. Dragging it down or tapping the backdrop pops it.
- `"modal"` is a full-screen modal rising from the bottom.
- `"transparentModal"` draws the route with no background over the screen below.

## Deep links into stacks

Opening `/items/42/comments` directly (a shared link, a push notification, a cold start) puts
the ancestors under it: `StackLayout` writes `/items` and `/items/42` into history below the
current entry, so back goes to `/items/42`, then `/items`. They load when popped back to.

- `base` is the stack's root. It defaults to the layout's own segment when the router provides
  it, else `/`. Pass it: without a known base, the ancestors are built only when `ancestors` is
  set explicitly.
- `ancestors` chooses the screens: `"segments"` (default) every path from `base` down,
  `"root"` just `base` (React Navigation's `initialRouteName`), `false` none, or a function
  `(pathname, base) => hrefs` for routes whose intermediate paths are not pages.

## Other routers (TanStack Router, React Router)

`StackLayout` and `TabsLayout` take the App Router's routes. An app on another router (a SPA on
TanStack Router, a React Router data router, or no router at all) uses `HistoryStack` and
`HistoryTabs`: the same views, bound to a **history source**, with a table of screens.

```tsx
// src/phone-shell.tsx
"use client";
import { HistoryStack, tanstackHistory, useScreenMatch } from "denext/navigation";
import { router } from "./router.ts";

const history = tanstackHistory(router); // once, at module scope

function Thread() {
  const id = useScreenMatch()!.params.threadId; // this screen's own location
  return <ThreadView id={id} />;
}

const screens = [
  { path: "/", render: () => <ThreadList />, options: { title: "Threads" } },
  { path: "/$threadId", render: () => <Thread />, options: { headerShown: true } },
  {
    path: "/$threadId/diff",
    render: (m) => <Diff threadId={m.params.threadId} />,
    options: { presentation: "formSheet", sheetAllowedDetents: ["medium", "large"] },
  },
];

export function PhoneShell() {
  return <HistoryStack history={history} screens={screens} />;
}
```

Render it where the router would render those routes (in TanStack Router, the layout route's
component, in place of its `<Outlet />`). The router keeps owning the URL: its `<Link>`s,
`navigate()`, loaders and the browser's back and forward buttons all work, and the stack follows.

- **History sources.** `tanstackHistory(router)` navigates through `router.navigate({ href })`
  (so loaders and blockers run as for a `<Link>`). `reactRouterHistory(router)` takes a data
  router (`createBrowserRouter`). `browserHistory()` is the plain History API, for an app with
  no router. Anything else implements `HistorySource` in a few lines: `location()`,
  `subscribe()`, `push()`, `replace()`, `go()`.
- **The history is the stack.** A navigation pushes a screen, a back pops to the entry it lands
  on, a forward pushes it again, and a replace swaps the top screen. All three sources report
  each entry's index, so a back of two entries pops exactly two screens. A link to a screen
  already below pops back to it instead of pushing a copy.
- **Each screen renders from its own location.** A kept screen below the top goes on showing
  what it showed; the router's own hooks (`useParams()`, `useSearch()`) follow the top screen,
  so read a screen's params from `useScreenMatch()` (or the `render` argument).
- **Screen paths** are literal segments, `:name` or `$name` params (TanStack Router's
  spelling works) and a trailing `*` or `$` splat; the first match wins. A location under
  `base` that no screen matches leaves the stack as it is.
- **Options and gestures** are `StackLayout`'s: `options` per screen (an object, or a function
  of the match), `screenOptions` for all, `useStackNavigation()` inside a screen. The back swipe
  starts anywhere on the screen by default (`fullScreenSwipe={false}` keeps it to the edge).
- **Deep links** stack the matching ancestors underneath, mounted and hidden, so the swipe back
  works at once. Popping to one replaces the history entry, since it has none of its own.
- **Tabs.** `HistoryTabs` takes tabs with a `render()` each (typically a `HistoryStack` with the
  tab's `base`). The location picks the tab, visited tabs keep their state, a press navigates to
  the tab's last location, and a press on the active tab pops its stack to the root.

Do not turn on TanStack Router's `defaultViewTransition` for these routes: the stack animates
its own pushes and pops.

## Tabs

```tsx
// app/(tabs)/tabs.tsx
"use client";
import type { VNodeChildren } from "denext";
import { TabsLayout } from "denext/navigation";

export function AppTabs({ children }: { children: VNodeChildren }) {
  return (
    <TabsLayout
      hideTabBarOnKeyboard
      tabs={[
        { name: "home", href: "/home", title: "Home", icon: <HomeIcon /> },
        { name: "inbox", href: "/inbox", title: "Inbox", badge: 3 },
        { name: "settings", href: "/settings", title: "Settings", unmountOnBlur: true },
      ]}
    >
      {children}
    </TabsLayout>
  );
}
```

- Every tab visited stays mounted but hidden when another is shown, with its scroll position.
  A `StackLayout` inside a tab's own layout (`app/(tabs)/home/layout.tsx`) is that tab's stack,
  kept with it.
- A tab link points at the tab's last screen, so going back to a tab returns to where you were;
  switching to a visited tab shows it at once while the router catches up.
- Tapping the active tab pops its stack to the root; tapping it again scrolls it to the top.
- `lazy: false` prefetches every tab's first screen; `unmountOnBlur` (per tab, or for all)
  drops a tab's content when you leave it; `badge` shows a count; `position: "top"` moves the
  bar; `hideTabBarOnKeyboard` hides it while the on-screen keyboard is up (pass
  `keyboard={useKeyboard()}` from `denext/mobile`, or let it read the visual viewport).
- `history: "replace"` makes tab switches replace the history entry instead of pushing one.
- Inside the native shell a tab switch plays a selection haptic (`tabHaptics={false}` turns it
  off; the web never vibrates for it). Use [`<SystemIcon>`](/docs/mobile#system-icons) for tab
  icons: the real SF Symbol on iOS, a Material Symbol on Android.

## Platform theme

`StackLayout`, `TabsLayout` (and the `StackView` / `TabsView` under them) take a `theme`:

| `theme`            | Look                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| `"auto"` (default) | the platform theme inside the Capacitor shell, the plain look elsewhere |
| `"platform"`       | the platform theme everywhere, the web included                         |
| `"plain"`          | the plain look everywhere (system colors, opaque bars)                  |

The platform theme is:

- **iOS**: the system font (`-apple-system`); a header that floats over the screen's content,
  transparent at the top (the scroll-edge look) and the translucent bar material with a hairline
  once content scrolls under it; the large title (`headerLargeTitle`) that scrolls under the bar
  while the bar's title fades in over the last 20 px, and stretches when you pull down; a tab bar
  the content scrolls under.
- **iOS 26 Liquid Glass** (`material="glass"`, the default): a floating, rounded tab bar of
  translucent glass (a blurred, saturated backdrop with a light rim and a soft shadow) with a
  highlight behind the active tab, glass capsules for the back button, and a soft scroll-edge
  blur under the header instead of a hairline. `material="blur"` is the iOS 7–18 edge-to-edge
  translucent bars. It is an approximation in CSS (`backdrop-filter`): there is no refraction.
- **Android**: Material 3's small top app bar (64 dp, title-large, the surface color, the
  surface-container color once content scrolls under it) and navigation bar (80 dp, a 64 × 32
  indicator pill behind the active icon, label-medium), in Roboto.
- **Both**: light and dark follow the system (`prefers-color-scheme`), or the app's own switch
  (`<html data-theme="dark">` or `class="dark"`, `data-theme="light"` to force light); Reduce
  Transparency makes the bars opaque; `accentColor` tints back buttons, the active tab and the
  Material indicator.

```tsx
<TabsLayout tabs={tabs} accentColor="#ff2d55" material="glass">{children}</TabsLayout>;
```

It is a stylesheet added through the CSSOM (CSP-safe) on the client, keyed off attributes the
views always render (`data-dnx-theme`, `data-dnx-look`, `data-dnx-material`, and
`data-dnx-scrolled` on a scrolled screen). The markup is the same with or without it, so a server
render and the hydrating client agree, and inside the shell the client marks
`<html data-dnx-shell="ios|android">` so `"auto"` applies. On the web with `theme="platform"`,
the first paint before hydration is the plain look; `platformThemeCss()` returns the stylesheet
for an app that wants it in its own CSS from the start. The themed values are CSS custom
properties on the themed container (`--dnx-accent`, `--dnx-bg`, `--dnx-label`, `--dnx-bar`,
`--dnx-glass`, …), so a class on the layout overrides any of them.

## Sheet

`Sheet` is also a component of its own:

```tsx
"use client";
import { useState } from "denext";
import { Sheet } from "denext/navigation";
import { useKeyboard } from "denext/mobile";

export function Filters() {
  const [open, setOpen] = useState(false);
  const keyboard = useKeyboard();
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Filters</button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        detents={["medium", "large"]}
        keyboard={keyboard}
        aria-label="Filters"
      >
        <FilterForm />
      </Sheet>
    </>
  );
}
```

- **Detents**: `"medium"`, `"large"`, `"fit"` (the content's height) or a number (a fraction of
  the height up to `1`, else px). A drag settles at the detent its momentum carries it to; a
  drag or fling below the lowest dismisses it (unless `dismissible={false}`). The grabber also
  cycles the detents on click or keyboard.
- **Scrolling inside**: until the sheet is at its largest detent, dragging its content moves
  the sheet (it expands before the content scrolls, as on iOS). At the largest detent the
  content scrolls, and dragging down from its top moves the sheet again.
- **Accessibility**: `role="dialog"` with `aria-modal`; the rest of the page is `inert` while
  it is open; Tab stays inside, Escape dismisses, and focus returns where it was. Name it with
  `aria-label` or `aria-labelledby`.
- **Keyboard**: pass `keyboard` (`useKeyboard()` from `denext/mobile`) or it reads the visual
  viewport; the sheet rises above the on-screen keyboard.
- **Android back**: in the shell, the back button or gesture closes the sheet first.
- It renders into `document.body`; `portal={false}` renders it in place.

## React Native mode

On the web, React Navigation's native-stack has no animations or gestures, and Expo Router
renders `presentation: "modal"` and `"formSheet"` screens as plain stack routes. In React
Native mode, `denext/navigation` draws them instead while keeping React Navigation's routers and
state, so `router.push`, `<Link>`, `Stack.Screen` options and deep links behave as before:

- Expo Router's `Stack` and `Tabs` (from `expo-router`, `expo-router/stack` and
  `expo-router/tabs`) are replaced at build time with navigators built on these views: kept
  screens, platform animations, the iOS swipe, Android predictive back, the header, and
  `modal` / `formSheet` / `transparentModal` presentations (`pageSheet` and `fitToContents`
  map to a sheet). They are built over expo-router's own copy of React Navigation
  (`expo-router/build/react-navigation/native`, which expo-router 55 and later carry), falling
  back to `@react-navigation/native`; a real-browser test runs them with expo-router 57.0.23.
- React Navigation's `createNativeStackNavigator` (`@react-navigation/native-stack`) and
  `createBottomTabNavigator` (`@react-navigation/bottom-tabs`) are replaced the same way, with
  the app's imports unchanged, and `@react-navigation/drawer` resolves to a denext drawer
  ([Community packages](/docs/react-native#community-packages); turn one off with
  `reactNative: { aliases: { "@react-navigation/native-stack": false } }`).
- Outside React Native mode, or with the alias turned off, build the navigators from React
  Navigation's core yourself:

```ts
import * as core from "@react-navigation/native";
import {
  createBottomTabNavigatorFactory,
  createNativeStackNavigatorFactory,
} from "denext/navigation";

export const createNativeStackNavigator = createNativeStackNavigatorFactory(core);
export const createBottomTabNavigator = createBottomTabNavigatorFactory(core);
```

Native-stack options mostly carry the same names (`title`, `animation`, `gestureEnabled`,
`presentation`, `headerShown`, `headerLargeTitle`, `headerRight`, `sheetAllowedDetents`); a
press on the active tab emits `tabPress`, which pops a nested stack to its root.

## Limits

- In a `StackLayout`, a screen kept below the top is hidden, not frozen (a `HistoryStack`
  screen renders from its own location, so this does not apply there): while the iOS swipe or a predictive back
  reveals it, it renders with the current URL, so a component there that reads `useParams()`
  sees the top screen's params until the pop lands.
- A claimed pop re-renders the route in the background (the router's normal soft navigation),
  so it still costs a request; the screen itself shows immediately.
- Screens are DOM, not native views: there is no native header or native tab bar, and Liquid
  Glass is approximated with `backdrop-filter` (no refraction, no lensing of the content below).
  The header and tab bar are styled to match (the [platform theme](#platform-theme)) and take CSS
  custom properties (`--dnx-header-bg`, `--dnx-header-tint`, `--dnx-tabbar-bg`,
  `--dnx-tab-active`, `--dnx-screen-bg`, `--dnx-sheet-bg`). Android's large top app bar is not
  drawn: `headerLargeTitle` is iOS only.

See also: [Mobile (Capacitor)](/docs/mobile) for the shell, `denext mobile add back` and the
keyboard; [Coming from React Native](/docs/coming-from-react-native) for the concept map.
