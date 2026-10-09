# Writing denext apps (for AI coding agents)

**denext is a complete, lightweight framework for Deno: write an app once and ship it to the web,
iOS, Android and the desktop. Its API is surface compatible with React and Next.js's App Router,
with its own small React core.** If you know Next.js, you already know denext — the file conventions,
hooks, and `app/` router are the same. This file lists ONLY what differs, so you
emit correct denext instead of Next.js.

## The 6 rules that make code denext, not Next

1. **Imports come from `denext`, not `react`.**
   `import { useState } from "denext"`. Server-only helpers come from
   `denext/server`; client-only from `denext/client`. There is **no `react` or
   `react-dom` package** — do not import them (in a _compat_ drop-in, `react` is
   aliased to denext, but new code should import `denext`).
2. **No `package.json`, no `npm install`.** A denext project has a
   **`deno.json`**. Dependencies are URL/`jsr:`/`npm:` imports in `deno.json`'s
   `imports` map. Run it with `deno task dev` / `deno task build` /
   `deno task start`. Migrating a Next app? `denext migrate` does it in one pass
   — writes the `deno.json` alias map so `next/*`+`react` resolve to denext with
   your source unchanged (add `--codemod` to rewrite imports to native `denext`). A **`pages/` (Pages
   Router) app** is migrated too: migrate wires the `@denext/pages-router`
   plugin (`denext.config.ts` + `deno.json`) and rewrites
   `next/router`/`next/head`/`next/link` to the plugin's compat modules.
   `denext migrate --check [--json]` previews it (changes, what won't migrate, a verdict) and
   writes nothing; problems denext handles are listed at https://denext.dev/docs/fixed.
   `--desktop` adds a Deno Desktop target; `--enable-capacitor [--app-id <id>] [--platform
   ios,android]` adds an iOS / Android one (a SPA, App Router or Expo app): `capacitor.config.ts`,
   the `mobile:*` tasks, `spa.precompress: false` + `mobile.icon`, Capacitor 8 installed with the
   app's package manager, and review items for what it can't know (a hosted-mode env switch, a
   backend URL a phone can reach, CORS for `capacitor://localhost` / `https://localhost`).
   `denext upgrade [--to <v>] [--dry-run | --check]` moves the `jsr:@denext/denext` pin, the
   pinned CLI tasks and every first-party `@denext/*` package together.
3. **File conventions are the same as Next App Router:** `app/page.tsx`,
   `app/layout.tsx`, `app/loading.tsx`, `app/error.tsx`, `app/not-found.tsx`,
   `app/api/x/route.ts`, `app/blog/[slug]/page.tsx`, `middleware.ts`. Server
   Components by default; add `"use client"` at the top of a file for
   interactivity. Keep hooks and event handlers in that `"use client"` file and
   render it from the page — a `page.tsx`/layout that calls a hook itself turns
   the whole route into a client bundle (a compatibility path for migrated apps),
   and that build fails the moment the route reaches a server-only module such as
   `lib/db.ts`.
4. **Async Server Components work**
   (`export default async function Page() { const d =
   await db.query(); ... }`).
   Data fetching stays on the server.
5. **`next/*` still works in a drop-in** (aliased), but for NEW code prefer the
   denext equivalents (see the map). `cookies()`, `headers()`, `redirect()`,
   etc. come from **`denext/server`** (or the `denext/next/*` compat — e.g.
   `denext/next/navigation`, `denext/next/headers`), not `next/*`.
6. **Everything is a web standard.** `Request`/`Response`, `fetch`, `URL`,
   `crypto.subtle`, `Deno.env.get(...)`. Route handlers return a `Response`.

## Next.js → denext import map

| Next.js                                                | denext                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import { useState, useEffect, ... } from "react"`     | `from "denext"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `import { cookies, headers } from "next/headers"`      | `import { cookies, headers } from "denext/server"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `import { redirect, notFound } from "next/navigation"` | `from "denext"` — `redirect`, `permanentRedirect`, `notFound`, `forbidden`, `unauthorized`, `RedirectType` work in Server and Client Components alike (`denext migrate` rewrites `next/navigation` to `denext`). `denext/server` re-exports the same throwing helpers (`redirect` from `denext/server` throws, as in Next); its **middleware** helper that RETURNS a `Response` is `redirectResponse` (`return redirectResponse("/login", 307)` from `middleware.ts`), and inside middleware a thrown `redirect()` / `permanentRedirect()` is turned into that response (307 / 308) |
| `import Link from "next/link"`                         | `import { Link } from "denext"` (or `denext/client`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `import Image from "next/image"`                       | `import { Image } from "denext"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `unstable_cache`, `revalidatePath`, `revalidateTag`    | `from "denext/server"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Route handler `export async function GET(req) {}`      | identical — returns a `Response`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Common tasks

**A page with data (Server Component):**

```tsx
// app/page.tsx
export default async function Home() {
  const posts = await getPosts();
  return <ul>{posts.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}
```

**An interactive component:**

```tsx
// app/counter.tsx
"use client";
import { useState } from "denext";
export function Counter() {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>Clicked {n}</button>;
}
```

Branch on a value in JSX with `choose` from `denext` (Lit-style, lazy; own keys only):
`choose(status, { loading: () => <Spinner />, error: () => <Oops /> }, () => null)`.

In SPA mode a `client:*` directive defers the mount and code-splits the component:
`<Chart client:visible client:placeholder={<Spinner />} />` (`load`/`idle`/`visible`/`interaction`/
`media`/`only`); under `@types/react`, `ClientDirectives` from `denext/jsx-directives` types them.

**A route handler (API):**

```ts
// app/api/hello/route.ts
export function GET(_req: Request): Response {
  return Response.json({ ok: true });
}
```

**A validated route handler + calling it with end-to-end types (no tRPC):** `defineApi`
takes Standard Schemas (Zod/Valibot/ArkType/TypeBox/hand-rolled) for `params` / `query` /
`body` / `response` plus the `errors` it may fail with; the handler gets parsed, typed input
and a schema mismatch is a structured 400 before it runs. `denext dev`/`build` generate
`.denext/api.ts` from the route modules' TYPES and register it, so `createApiClient()` and
`useApi` type-check every call — path, method, params, query, body, response, error codes.

```ts
// app/api/user/[id]/route.ts
import { createApi, defineApi, requireSession } from "denext/server";
import { z } from "zod";
export const GET = defineApi({
  params: z.object({ id: z.string() }),
  response: z.object({ id: z.string(), name: z.string() }), // strips undeclared keys, in prod too
  errors: { not_found: 404 },
}, async ({ params, fail }) => (await db.users.get(params.id)) ?? fail("not_found"));
export const PATCH = createApi().use(requireSession()).define({
  params: z.object({ id: z.string() }),
  body: z.object({ name: z.string().min(1) }),
  errors: { not_owner: 403 },
}, async ({ params, body, ctx, fail }) => {
  if (ctx.session.user.id !== params.id) fail("not_owner");
  return db.users.update(params.id, body);
});
```

```ts
// anywhere (server component, client component, or a test)
import { createApiClient, isApiClientError } from "denext";
import type {} from "./.denext/api.ts"; // registers the schema (type-only; nothing ships)
const api = createApiClient(); // typed against THIS app's routes
const user = await api("/api/user/[id]", "GET", { params: { id: "1" } }); // user is typed
try {
  await api("/api/user/[id]", "PATCH", { params: { id: "1" }, body: { name: "" } });
} catch (err) {
  if (isApiClientError(err) && err.code === "not_owner") { /* narrowed to the declared codes */ }
}
```

```tsx
// a client component — the hook; GETs in one tick ride ONE batched request
"use client";
import { useApi } from "denext";
export function User({ id }: { id: string }) {
  const { data, error, pending } = useApi("/api/user/[id]", "GET", { params: { id } });
  return pending ? <p>…</p> : error ? <p>{error.code}</p> : <p>{data?.name}</p>;
}
```

Add the `@denext/openapi` plugin (`plugins: [openapi()]` in `denext.config.ts`) and those same
definitions serve `GET /openapi.json` (OpenAPI 3.1) + a docs page at `GET /docs`, write
`openapi.json` at build, and back `denext openapi emit | diff | lint | types` — zero extra annotation.
Schemas that implement Standard JSON Schema (Zod ≥ 4.2, ArkType, Valibot) or TypeBox are
described in full; others are `{}` + a lint warning.
Need GraphQL? `@denext/graphql` mounts GraphQL Yoga at `/graphql` (any `GraphQLSchema`;
Pothos recommended, no decorators) and `fromChannel(channel, key)` turns a `createChannel`
into a subscription source — the same push the Live socket delivers.

A plain handler still works and is still typed: return `TypedResponse<T>` / take a
`TypedRequest<B>` from `denext/server`. A plain `route.ts` body is capped at 1 MiB
(`export const maxBodyBytes = N | false`); `redirect()`/`notFound()` inside one are HTTP
responses; a thrown `ApiError(status, code, { data })` is a typed JSON error envelope.
`createApi().use(…)` stacks middlewares from `denext/server`: `requireSession({ role })`,
`requireBearer({ scope })`, `rateLimit(…)`, `cors(policy)` (the app `cors` shape, scoped to the
method it guards: its preflight is answered before `middleware.ts`, and it replaces the route's
and the app's policy there) and `csrf()` (a cookie-carrying cross-origin mutation is a 403
`csrf_failed`, the Server Actions rule; `{ doubleSubmit: true }` also wants an `x-csrf-token`
header echoing its `denext-csrf` cookie).

**Typed live data (validated subscription + server push):**

```ts
// app/live.ts
"use server";
import { createChannel, defineSubscription } from "denext/server";
export const orderStatus = defineSubscription({
  input: z.object({ id: z.string() }), // validated on every subscribe
  tags: ({ id }) => [`order:${id}`], // server-derived; re-pushed on revalidateTag
  authorize: async ({ id }) => (await auth())?.user.id === (await db.orders.owner(id)),
  resolve: ({ id }) => db.orders.status(id),
});
export const orderEvents = createChannel<{ status: string }>({
  authorize: async (_ctx, key) => key === `user:${(await auth())?.user.id}`, // REQUIRED
});
// anywhere on the server: await orderEvents.publish(`user:${userId}`, { status: "shipped" });
```

```tsx
"use client";
import { useChannel, useSubscription } from "denext/live";
import { orderEvents, orderStatus } from "./live.ts";
const { data } = useSubscription(orderStatus, { id }, { initial });
const { data: event } = useChannel(orderEvents, `user:${userId}`);
```

**A typed Server Action (the mutation side, also type-checked):** `defineAction` validates
`FormData` into a typed input (a parser, or a Zod/Valibot/any Standard Schema) and its `Out`
flows into `useActionState`.

```ts
// app/actions.ts
"use server";
import { ActionValidationError, defineAction } from "denext/server";
export const createPost = defineAction({
  input: (f) => ({ title: String(f.title ?? "").trim() }), // typed input: { title: string }
  handler: async ({ title }) => {
    if (!title) throw new ActionValidationError("bad", { title: "Title is required" });
    return { id: await db.posts.insert({ title }) }; // Out inferred: { id: string }
  },
});
```

```tsx
// app/new-post.tsx
"use client";
import { idleActionState, useActionState } from "denext";
import { createPost } from "./actions.ts";
export function NewPost() {
  const [state, action] = useActionState(createPost, idleActionState<{ id: string }>());
  return (
    <form action={action}>
      <input name="title" />
      {!state.ok && state.fieldErrors?.title} {/* typed */}
      {state.ok && `created ${state.data.id}`} {/* typed */}
    </form>
  );
}
```

**Reading cookies / a session (auth):**

```ts
import { redirect } from "denext";
import { auth, cookies, createApi, getSession, requireAuth, requireSession } from "denext/server";
// cookies are Secure + httpOnly + SameSite=Lax by DEFAULT; pass { httpOnly: false } to opt out.
const session = await getSession<{ userId: string }>({
  secret: Deno.env.get("SESSION_SECRET")!,
});
if (!session.data) redirect("/login");
await session.set({ userId: user.id }); // sign in

// With the `denextAuth({ … })` plugin the same three calls cover server, middleware and API:
const s = await auth(); // anywhere on the server; null while a second factor is pending
// middleware.ts — a Response to redirect (302 + ?error=forbidden), or null to continue:
export const middleware = (request: Request) => requireAuth(request, { role: "admin" });
// a route handler — requireSession({ role }) refuses with 403:
export const GET = createApi().use(requireSession({ role: "admin" })).define(/* … */);
```

**Clerk (hosted auth):** `@clerk/nextjs` runs unchanged in compat mode: `clerkMiddleware()` +
`createRouteMatcher` in `middleware.ts`, `<ClerkProvider>` in the root layout, `auth()` /
`currentUser()` from `@clerk/nextjs/server` in Server Components and route handlers. In a Deno Desktop
window the same provider signs in via `installClerkDesktopBridge({ nativeClerk: true })` from
`desktop.preload`; the Clerk instance's `allowed_origins` must include `desktop.app.origin`. In the Capacitor shell:
`installClerkMobileBridge({ scheme, nativeClerk: true })` from `denext/mobile/clerk` in
`instrumentation-client.ts`; `denext mobile add clerk --scheme <s>` sets it up (add
`capacitor://localhost` + `https://localhost` to `allowed_origins`). See
[`examples/clerk`](https://github.com/Brainwires/denext/tree/main/examples/clerk).

Persist users with an adapter (`sqliteAuthAdapter({ path })` on `node:sqlite`, or
`inMemoryAuthAdapter()`), and gate a machine-to-machine API with
`requireBearer({ scope: "pets:write" })` (it reads the config `denextAuth()` was built with;
pass `authConfig` first to be explicit) — it self-documents as `bearerAuth`
for `@denext/openapi` (declare the matching `securitySchemes: { bearerAuth: … }` once in the
`openapi()` options). `credentials()` with no `authorize` verifies against the adapter
(`getUserByEmail` + `getCredential` + the hasher). Passwordless: `providers: [magicLink(),
emailOtp()]` plus `sendVerificationRequest` (denext ships no mailer);
`magicLink({ confirm: true })` puts a click-to-confirm page in front of the redeem, so a mail
scanner's pre-fetch can't spend the link. Passkeys: `passkeys: true` (or `{ rpId, rpName, userVerification }`) mounts
`/auth/passkey/*`, and `registerPasskey()` / `signInWithPasskey()` from `denext/client` (check
`passkeysSupported()`) sign in usernameless or complete a pending second factor. An OAuth / OIDC
provider takes `responseMode: "form_post"` (the callback is then a POST). Second factor: an
enrolled user's sign-in comes back pending; your `pages.mfa` page renders when
`pendingMfaSession()` returns a session and posts `{ code }` to `/auth/mfa`; enrollment is
`/auth/mfa/enroll` → `/auth/mfa/confirm` (from a complete session it needs a recent sign-in,
`session.authTime`); `totpQrSvg(uri)` renders the enrollment QR code as SVG. TOTP secrets are
sealed at rest under `secret`; with `secret: [current, previous]` a factor sealed under the
retired one opens and is re-sealed on its next passing check, so keep a retired secret listed until
then. A session ends `session.maxLifetime` after its sign-in (default 30 days) however often it
slides. `events.apiTokenIssued` / `apiTokenRevoked` report every bearer token minted or retired
(id and owner, never the token). Full guide: https://denext.dev/docs/auth

Per-request facts from anywhere on the server (`denext/server`): `clientIp()` (the proxy's last
`x-forwarded-for` hop only with `trustForwardedHeaders` / `DENEXT_TRUST_PROXY=1`, else the socket
peer; a dynamic read like `headers()`), `requestId()` (the log / `x-request-id` correlation id —
an inbound one is reused only behind a trusted proxy) and `requestSignal()` (the disconnect /
timeout `AbortSignal` to thread into `fetch()`; `undefined` inside `use cache`). `denextAuth`
inherits the app's `trustForwardedHeaders` unless it sets its own.

**A project-local CLI verb (no plugin):** put it in `denext.config.ts` and run it as a verb.

```ts
// denext.config.ts
export default {
  commands: [{ name: "seed", summary: "Load fixtures", run: (ctx) => seed() }],
};
// `denext seed` — same flag parsing, --help and did-you-mean as a built-in. List this
// project's own verbs with `denext commands [--json]`; they are in shell completions too.
// `denext --help` lists them from the cache `denext commands` wrote (`.denext/commands.json`,
// fingerprinted against denext.config.* / deno.json / deno.lock) without importing your
// config; before the first run, or once one of those files changes, it points at `denext commands`.
```

**Code health and concurrency:** `denext create --fallow` (or `denext fallow init` in an existing
app) adds the fallow gate denext itself uses — `fallow.toml` with the path-loaded files as entry
points, `deno task fallow:audit` / `coverage:fallow` / `hooks:install` (a pinned `npm:fallow`
through Deno, nothing global). Commands that write `.denext/`, `out/`, `dist/` or a coverage dir
take Cargo-style OS locks: `Blocking waiting for file lock on …` means another denext command
holds that directory — wait; never delete `.denext/.denext-lock*` (the OS releases a lock when its
holder exits).

**A GUI over the project:** `denext ui` serves a loopback (127.0.0.1) project-management
page — schema-driven `denext.config.ts` editing (a comment-preserving splice: outside the
value span it replaces, the file keeps its bytes), a Cron page (every schedule, when it
next fires, an editor with a shape builder, and run history when `tasks.history` is on),
plugins with option forms for the first-party ones and JSR search, every `generate` kind,
Docker files plus in-place `docker-compose.yml` editing, a Desktop panel that composes the
signing setup from the identities the keychain holds, a Setup page that readies a fresh
clone, a Dev page that starts and stops the dev server, a Tasks page for the scripts
`deno.json` declares, and the project's own verbs. It works with JavaScript disabled, and
**project code never runs in the UI's process** — every project-touching operation,
including verb discovery (`denext commands --json`), is a `deno` subprocess.
`--read-only` prevents writes by the UI, not execution of your config inside that
discovery child. `--offline` keeps the UI and every process it starts off the network.
Docs: https://denext.dev/docs/ui

**A Capacitor shell:** `denext/mobile` (client-only) — `isNativeShell()`, `runtimePlatform()`
(`"ios" | "android" | "desktop" | "web"`), `useAppResume`, `openExternal`, `useKeyboardInset`,
`useBackSwipe`, `SAFE_AREA_CSS`, `installMomentumSafeScroll` / `useMomentumSafeScroll`. It talks
to Capacitor through `window.Capacitor`, so no `@capacitor/*` import. iOS momentum scrolling
survives virtualized-list scroll corrections automatically (the runtime installs the shim on iOS
WebKit; `momentumSafeScroll: false` opts out). Native capabilities with web fallbacks: `haptic`,
`readClipboard`/`writeClipboard`, `share`, `deviceInfo`, `networkStatus`/`useNetworkStatus`,
`useKeepAwake`, `hideSplash`, `secureStore` (NOT secret on the web), `readFile`/`writeFile`/
`listDir`/`downloadToFile` (OPFS on the web), `pickImage`/`pickDocument`/`scanBarcode` (`null`
when cancelled), `setQuickActions`/`useQuickAction` (home-screen shortcuts), `openSqlite` (the
app's own `@sqlite.org/sqlite-wasm` on OPFS on the web) and `showContextMenu` /
`useContextMenu` (native in the shell once `denext mobile add context-menu` installs the plugin:
`UIMenu` with the lifted preview on iOS, `PopupMenu` on Android; an in-page menu elsewhere,
Deno Desktop included); `denext mobile add <capability...> [--dry-run] [--list]`
installs their plugins, and `deep-links --scheme/--domain` / `push` add
`onDeepLink`/`useDeepLink` (filtered by `accept`, routed once) and
`requestPushPermission`/`registerForPush`/`onPushTapped` (no web push; your server sends via
APNs/FCM; Android needs `google-services.json`). Your own native code: `nativeModule<Spec,
Events>(name)` is a typed async client for the Capacitor plugin `name` (the desktop extension on
Deno Desktop, `null` on the web), `native-module --name <Name>` generates one (Swift + Kotlin +
`native/Native<Name>.ts`), and React Native mode's `TurboModuleRegistry` / `NativeModules` /
Expo `requireNativeModule` resolve to it (every call async; no JSI). Native views:
`<NativeViewSlot type="video" | "map" | …>` / `useNativeViewSlot` keep a native view on a DOM
box (children are the web fallback); `denext mobile add native-views` (built-in `video`) /
`native-map` (MapKit / osmdroid). `placement: "auto"` is `"embed"` (inside the page's scroll
view) on iOS except `video`, which is `"under"` (AVPlayerViewController with system controls,
the page painting over it), and `"over"` on Android; `scrollPassthrough` (`"vertical"` by
default for `video`) lets a drag on the view scroll the list. In React Native mode `expo-maps` /
`react-native-maps` → the map view, `expo-video` / `react-native-video` → the video view,
`expo-symbols` → `<SystemIcon>`. `auth-session --scheme myapp` adds
`openAuthSession(url, { callbackScheme })` (OAuth in an iOS ASWebAuthenticationSession / Android
Custom Tab / web popup finished by `completeAuthSession()`, and in a Deno Desktop window the
system browser with a loopback redirect; resolves the callback URL, PKCE + `state` are yours).
App extensions: `denext mobile add share-extension | widget --name <N> [--configurable
<param:enum=a|b>] | live-activity --name <N>` generate the native targets behind
`onShareReceived`, `setWidgetData`/`reloadWidgets` and
`startLiveActivity`/`updateLiveActivity`/`endLiveActivity` (iOS only; they share an App Group).
Live reload on a device: `denext mobile dev --lan` points the app's `server.url` at
`denext dev` for the session (restored on exit); a non-loopback host loads the dev assets only
when opted in (`denext dev --lan`, `--host`, `allowedDevOrigins`), and a network bind requires its
per-run token from other machines (the printed URL carries `?__denext_dev=…`). Docs:
https://denext.dev/docs/mobile

The momentum shim is not Capacitor-only: it installs for every iOS/iPadOS WebKit visitor,
Safari included, whenever `momentumSafeScroll` is on (the default).

More `denext mobile add` capabilities (a pinned Capacitor 8 plugin, or denext's own native plugin
for `permissions`, `accessibility`, `storage` and `system-icons`; `system-bars` uses Capacitor
core and `offline-screen` writes a page; web fallback where one exists): `keyboard`
(`useKeyboard`, `<KeyboardAvoidingView>`, `<KeyboardStickyView>`), `back`
(`onBack`/`useBackHandler`, `useBackProgress` for Android predictive back), `system-bars`
(`setSystemBars`, `useSystemBarsFollowTheme`; `useSafeAreaInsets()` needs nothing),
`permissions` (`checkPermission`/`requestPermission`/`usePermission` → granted | limited |
prompt | prompt-with-rationale | denied | blocked; `openAppSettings`), `local-notifications` (`scheduleNotification`),
`biometrics` (`authenticateBiometric`; `secureStore.set(k, v, { requireBiometric: true })`),
`social-login` (`signInWithApple`/`signInWithGoogle` → `signInNative`), `geolocation` /
`background-location`, `purchases` (RevenueCat), `app-review`, `app-update`,
`screen-orientation`, `media-library`, `privacy-screen`, `tracking` (ATT), `background`
(`defineBackgroundTask` in `background/`, no DOM), `restore` (Android process death),
`accessibility` (`useScreenReader`, `getFontScale` / `applyFontScale` for Dynamic Type),
`storage` (`openKeyValueStore`: durable SQLite, behind React Native mode's AsyncStorage / MMKV),
`system-icons` (`<SystemIcon>`: SF Symbols in the iOS shell, Material Symbols elsewhere),
`sentry` (`initCrashReporting`) and `offline-screen`; `useReducedMotion()` needs nothing. An exported multi-page app in the shell needs `export-routes` (Capacitor serves the root `index.html` for every extensionless path; any denext native plugin includes it, and `denext mobile doctor --release` checks it).
`dialog` / `toast` / `action-sheet` back React Native mode's `Alert` / `ToastAndroid` / `ActionSheetIOS`. `<PullToRefresh>` needs no plugin; `readSafeAreaInsets()` / `watchSafeAreaInsets(cb)` read the insets outside a component. Store tooling: `denext mobile privacy` (the iOS privacy
manifest), `denext mobile doctor --store | --release`, `denext mobile inspect`.
Ship without a hosted service: `denext mobile assets` (every icon + splash from one image; with
no `--icon` it takes `mobile.icon`, `assets/icon.png`, an Expo app config's icon (a sibling
monorepo app's too, read statically), the web manifest's icon, the apple-touch-icon, then a PNG
favicon, and says which; `migrate` records it as `mobile.icon`, `mobile build` replaces Capacitor's
placeholder icon), `denext mobile build ios|android [--release] [--flavor <name>]` (export → `cap sync` → a signed
`.ipa` / `.aab` in `dist/mobile/`; flavors in `mobile.flavors`), `denext mobile submit
ios|android [--dry-run]` (App Store Connect / Google Play). Teams already on fastlane keep it:
`denext mobile add fastlane [--ci]` writes `fastlane/` (Appfile from capacitor.config, Matchfile,
`ios|android build|beta|release` lanes that run `denext mobile build --release` and hand the
artifact to match / TestFlight / Play tracks; `flavor:` / `build_number:` pass through), a pinned
Gemfile and, with `--ci`, a GitHub Actions workflow; `denext mobile doctor --release` checks it.
Credentials are env-only. App backend:
`cors` in config, `denextAuth({ native })` sessions, `createApiClient({ base, auth:
nativeSession(…) })`, `sendPush` from `denext/server`. Docs: https://denext.dev/docs/mobile,
https://denext.dev/docs/app-backend

**Platform-specific files:** `BigButton.ios.tsx`, `.android`, `.mobile` (any phone), `.macos` /
`.windows` / `.linux`, `.desktop` (any desktop OS) and `.web` beside a plain `BigButton.tsx`, as in
React Native. Import the plain module (`./BigButton`, `./BigButton.tsx`, or an alias such as
`@/components/BigButton`); each target's export picks its file (ios: `.ios` → `.mobile` → `.web`
→ plain) and drops the rest. `build`, `start` and a plain `export` are the `web` target; `denext dev`
serves `web` unless a shell names its target (`mobile dev`, `desktop dev`). `denext export
--platform <t>` (or `DENEXT_PLATFORM=<t>`), `denext mobile build` and `denext desktop build` /
`package` build the others. `createOtaHandler({ platforms })` serves each target its own export;
a shell refuses another target's UI (`platform_mismatch`). `.native` is opt-in (`platformExtensions: { native: true }`);
only the app's own modules take a variant; keep a plain file so type checking resolves.
Docs: https://denext.dev/docs/platform-files

**A long list:** `VirtualList` / `useVirtualList` from `denext` (rows measured as they render,
10M rows, exact `scrollToIndex`, `anchor="end"` for chat, sticky headers, grids,
`onEndReached`, React Native's viewability and scroll props); `VirtualMasonry` from
`denext/virtual-masonry`, `useVirtualReorder` for drag-to-reorder. `lists: "denext"` (config)
makes every `@legendapp/list/react` import a LegendList built on `VirtualList`. Swipe actions:
`<SwipeableRow leading={[…]} trailing={[{ label, tone, onPress }]}>` from `denext` (transform-only,
VirtualList-safe, full swipe runs the first action, real buttons; RNGH `Swipeable` /
`ReanimatedSwipeable` resolve to it in React Native mode). Docs: https://denext.dev/docs/lists

**Native-feel navigation:** `denext/navigation` (client) — `StackLayout` in a `layout.tsx`
keeps pushed screens mounted with platform animations and the iOS swipe back, `TabsLayout`
keeps each tab's state, `Sheet` is a bottom sheet with detents; a page sets
`export const screenOptions = { title, presentation }`; `useStackNavigation()` pushes and
pops. On another router (TanStack Router, React Router, none): `<HistoryStack
history={tanstackHistory(router)} screens={[{ path: "/$id", render, options }]} />` (screens read
`useScreenMatch()`, not the router's hooks) and `HistoryTabs`; the back swipe starts anywhere
there (`fullScreenSwipe`, or a screen's `fullScreenGestureEnabled`). Docs:
https://denext.dev/docs/navigation-native

**Deno Desktop capabilities:** the same `denext/mobile` functions reach the desktop runtime when
`runtimePlatform() === "desktop"`, once enabled with `denext desktop add <capability...>`
(`secure-store`, `fs`, `sqlite`, `context-menu`, `shell`, `dialogs`, `notifications`,
`keep-awake`, `clipboard`, `device`, `auth-session`, `passkeys`, `global-shortcuts`, `launch-at-login`; written to
`desktop.capabilities`), plus desktop-only
`openPath`, `revealInFileManager`, `moveToTrash`, `saveFile`, `pickFolder`, and
`desktopExtension<typeof ext>(name)` from `denext/desktop/client` for your own native code
(`desktopOs()` there returns the window's OS — `"darwin"` / `"windows"` / `"linux"` — with no capability).
The runtime answers `fs`, `sqlite`, `device`, `dialogs`, `shell`, `keep-awake`, `secure-store`
(macOS Keychain, written by the app's own process so another program gets macOS's prompt, not the
secret; items an older denext wrote through `/usr/bin/security` move over during the first launch
only; an unsigned build has no protection against another program's writes; Linux libsecret inside the runtime — no `secret-tool`; the `.deb` / `.rpm` depend
on `libsecret-1-0` / `libsecret` — Windows PasswordVault; on Linux a missing Secret Service provider
or a locked keyring rejects `backend_unavailable` with the reason) and your `defineDesktopExtension` modules (from
`denext/desktop`, listed in `desktop.capabilities.extensions`; a handler's
`ctx.runOnMainThread(fnPtr, context?)` calls a C function on the UI thread — full trust, grant `ffi`
in `desktop.extraPermissions`, `unsupported` on the stock runtime) — but only when `desktop.ts`
spreads `...(await resolveDesktopCapabilities(config, { base: import.meta.url }))` into
`runDesktop` (a new scaffold and a `migrate --desktop` entry do; an entry from before 2.11 must
add it, else every call answers `unavailable`). Under the pinned runtime `notifications` are the OS's own: scheduled
(repeating ones 16 occurrences ahead, topped up while the app runs), cancel / pending, category action
buttons, and clicks (the launch click too) routed to `onLocalNotificationTapped`;
`requestPermission("notifications")` / `requestPushPermission()` report the OS setting. `context-menu`
is the native menu (submenus, `null` on dismiss). `denext/desktop/app` (no `add`): `setAppMenu([...])` +
`onAppMenuItem(id => …)` with accelerators and roles, `createTray({ icon, tooltip, menu })`,
`setBadge(n)`, `bounce()`; `setQuickActions` sets the macOS Dock menu. With no tray host (stock GNOME)
`createTray` rejects `unsupported` with `error.data.reason` (a hidden window is shown); `appCapabilities()`
reports `trayHost` / `secretService` / `sessionType` / `cookieEncryption` (`"basic"` — obfuscated,
not OS-protected — always on macOS CEF, Chromium's mock keychain) / `sandbox` / `fileChooser` from the
runtime's probe (`"unknown"` before the runtime that added each), and `denext desktop doctor [--linux]`
lists what the session lacks, with fixes. `desktop.linux.requireSandbox: true` makes a Linux CEF app
exit 78 instead of running without Chromium's sandbox (a tarball / AppImage on Ubuntu 23.10+). `registerShortcut(accel, fn)`
needs `global-shortcuts`; `setLaunchAtLogin(on)` needs `launch-at-login`. DevTools are on in
`desktop dev` / `run` and off when packaged unless `desktop.inspectable: true`. `denext desktop run` / `dev` build the app into a temp dir with the
packaging scripts' least-privilege flags and launch it (a bare `deno desktop` only compiles). An extension's
`--allow-*` goes in `desktop.extraPermissions`, never in `scripts/package-*.ts`. Under the stock
runtime these answer `unavailable` and the page keeps its web path. Under the pinned runtime `clipboard` reaches the OS clipboard
(`readClipboard({ format: "html" | "image" })`, `writeClipboard({ html, text? } | { image })` with
base64 PNG, `clipboardFormats()`) and `dialogs` uses the OS's own panels (MIME `types` → filters).
The window: `denext/desktop/window` (no `desktop add`) — `maximizeWindow` / `minimizeWindow` /
`restoreWindow` / `setFullScreen` + `onWindowStateChange`, `getWindowState` (persist `normalBounds`),
`setWindowBounds` / `setMinimumWindowSize` / `setMaximumWindowSize`, `getScreens` + `onDisplayChanged`,
`setTitleBarStyle` / `setWindowButtonPosition` / `setWindowBackdrop` (Mica / Acrylic / vibrancy),
`makeWindowDraggable(el)` for a hidden title bar (a double click does the user's title-bar action),
`getTitleBarPreferences()` / `onTitleBarPreferencesChange` (the user's button side and order,
double-click action, colour scheme — for an app-drawn title bar), `onCloseRequested(() => boolean)` (cancelable close),
`closeWindow` / `quitApp`, `onFileDrop` (read-only picked handles) and
`startFileDrag([{ directory: "cache", path } | { directory: { picked } }])`; first-window config is
`desktop.window` / `titleBar` / `backdrop` / `minSize` / `maxSize`. All but size, position, title and
show / hide need the pinned runtime (`unsupported` elsewhere; ask `windowCapabilities()`). React Native desktop
`View`'s `mouseDownCanMoveWindow`, `allowsVibrancy` and `draggedTypes` + `onDrop` work in the window. Node-API addons (an npm package's prebuilt `.node`) load in a
packaged app on macOS, Windows and Linux: import them in a `defineDesktopExtension` module and set
`desktop.extraPermissions: { ffi: ["*"] }` (`"*"` bakes the unscoped flag). A full-app update is
confirmed automatically once the new version's window loads; `desktop.update.autoConfirm: false`
leaves it to `confirmAppUpdate()`. Packaging is least-privilege: `scripts/package-*.ts` derive
`--allow-*` from `desktop.capabilities` instead of `-A` (`clipboard`, `global-shortcuts`,
`launch-at-login`, `notifications` and declared `desktop.app.deepLinks` bake an unscoped
`--allow-sys`, which the pinned runtime requires for them), and
`denext desktop package --regenerate-scripts` rewrites them from the current template (a `.bak`
and a diff for each changed file). Installers: `desktop.installers.{macos,linux,windows}` (or
`denext desktop package --format …`) — macOS `.dmg` (+ a signed `.pkg`), Linux `.tar.gz` + `.deb`
(+ `.rpm`, AppImage), Windows a per-user-or-machine `.msi` (+ `.zip`); an empty list builds just
the bundle.
A stable window origin: `desktop.app.origin: "myapp://app"` (a custom scheme; it requires
`desktop.app.identifier`) — the scripts write `.deno-desktop/app.json` + `compile.include` and the
packaged `laufey-launch.json` (its `bridgeOrigins` limits the window's native JS bridge to the app
origin; `desktop.app.bridgeOrigins` adds others). It takes effect under denext's pinned Deno Desktop runtime, which
`denext desktop` and the package scripts download and SHA-256-verify (Deno 2.9.7 exactly; denext pins runtime 2.9.7-denext.13 and needs at least 2.9.7-denext.9; what it changes and why: https://denext.dev/docs/desktop-runtime;
`DENEXT_DESKTOP_RUNTIME=stock` opts out, and the stock runtime keeps the loopback origin); the gates
detect which one they run under. Packaging is per target, not per host: Linux and Windows apps
package from any host under the pinned runtime; macOS apps package on a Mac. `denext desktop run` /
`dev` warn and use the stock runtime when `deno` is not 2.9.7 (`DENO_BIN` points them at a 2.9.7
binary); `package` refuses. A default installer that can't be built (missing tool, WiX other than 5,
a version MSI/Debian can't express) is skipped with a warning; an asked-for one fails.
`DENEXT_LOCK_TIMEOUT=<seconds>` bounds a build-lock wait. `runDesktop` resolves to `{ window, trust, emit }`: `emit(cap, event, data)` pushes an OS event the page receives with `onDesktopEvent(cap, event, fn)` from `denext/desktop/client` (kept until the page subscribes).
Under the pinned runtime: `desktop.preload` (Electron's preload: bundled and inlined first into every
top-level page; trusted, same world as the page); `desktop.app.deepLinks` / `singleInstance` deliver
links to `onDeepLink` and opened files to `onOpenFile` (read-only handles); `openAuthSession` takes a
custom-scheme callback (a declared scheme, PKCE S256 mandatory, exact redirect + `state`, owner-checked;
`claimDeepLinkScheme` only on a user action) — on macOS it runs in `ASWebAuthenticationSession` (a real
`cancelled`; `preferEphemeral` for a private session; a page cancel, the timeout or leaving the page closes the sheet), and where the system browser has the sign-in
(Windows, Linux, the loopback flow) denext shows a Cancel overlay (`cancelOverlay: false` to render
your own wired to `signal`); `installClerkDesktopBridge()` from `denext/desktop/clerk`
makes `@clerk/electron`'s React provider and `passkeys` run unchanged
(`denext desktop add secure-store auth-session passkeys`).
Native passkeys are macOS (needs the associated-domains entitlement: `desktop.macos: {
provisioningProfile, entitlements }` signs it in with the profile) and Windows only; Linux has no OS
passkey API, so `denext/desktop/clerk` signs in through the browser. On Linux a `.deb` / `.rpm` install
(xdg-desktop-portal 1.19+, systemd user manager) posts scheduled notifications while the app is closed
and a click starts it; an AppImage or tarball delivers only while the app runs. OS limits:
https://denext.dev/docs/limitations
Under the pinned runtime the page's own WebSockets dial the runtime's loopback relay with its
per-launch token (`DENO_DESKTOP_WS_URL`, injected into the app's top-level page; where the engine
omits `Sec-Fetch-Dest`, the `Origin` check still holds, so only a same-origin frame could get it): denext's Live
client does this itself; for your own sockets use `desktopWebSocketUrl(path)` from
`denext/desktop/client` (never the bare relay origin: it answers 403). With `notifications` enabled, the web `new Notification(...)` /
`Notification.requestPermission()` / `onclick` work, backed by the OS (no icons or buttons).
`openAuthSession(url, { loopbackPort: 1455 })` uses a fixed loopback port for a provider with a
registered `http://localhost:<port>/…` redirect (`port_in_use` when taken). `desktop.denoFlags`
passes allow-listed `deno desktop` flags (a pnpm workspace: `["--node-modules-dir=none",
"--exclude-unused-npm"]`; never permission flags). The bundle's name, identifier and icon come from
`desktop.app.name` / `identifier` / `icons.{macos,windows,linux}`, falling back to deno.json.
A denext backend (`denext start` / `denext dev`) accepts the app's own `desktop.app.origin` as
same-origin (Server Actions, the API batch, Live, `denextAuth` POSTs, the dev origin gate) by exact
match; a separate backend lists the origin in `allowedDevOrigins` (custom-scheme entries are allowed)
or `createApp({ allowedOrigins })`. `denext migrate --desktop` writes `desktop.denoFlags`.
Docs: https://denext.dev/docs/desktop#desktop-capabilities

Over-the-air UI updates (Capacitor): `spa.ota: true` (or `denext ota manifest <dir>`) stamps
`_denext/ota.json`; `denext ota keygen` + `--sign` / `DENEXT_OTA_SIGNING_KEY` sign it;
`denext mobile add-ota [--public-key <file>]` installs the native plugin (and embeds the key);
`checkForUiUpdate` / `prepareUiUpdate` / `applyUiUpdate` / `otaBooted` from `denext/mobile`
drive it; `createOtaHandler` from `denext/server` serves the export. A downloaded UI is
re-verified at every launch and on each file's first serve: one changed on the device is refused
(the bundled UI is served, `onOtaRejected` fires, `otaStatus().tampered` names it), and
`denext mobile doctor --release` flags a plugin from before re-verification. An unsigned manifest over
plain `http` is refused beyond loopback. Whether a change can ship over the air:
`denext mobile fingerprint [--diff old.json] [--write]` hashes the native layer, and
`denext ota manifest --native-fingerprint auto` makes a binary with another fingerprint refuse
the UI (`native_mismatch`). A Deno Desktop app gets the same signed updates from
`denext/desktop/updater` (`checkForDesktopUpdate` / `prepareDesktopUpdate` /
`applyDesktopUpdate`), and full-app updates under the pinned runtime (`checkForAppUpdate` /
`downloadAppUpdate` / `installAppUpdateAndRelaunch` / `confirmAppUpdate`: a signed manifest from
`denext desktop publish-update`, no downgrades, the same code-signing identity required (on macOS: the same Team ID and a notarized build; on
Windows: on every PE file, which the package script signs), an atomic
bundle swap that rolls back if the new version never confirms). The manifest expires (`expiresAt`,
default 30 days, `expired`) and carries a growing `sequence` (`replayed`): re-sign it before it
expires with `denext desktop publish-update --resign` (`publish-update` warns when the manifest in
`--out` expires within 7 days); the artifact must be built as the version
published (`version_mismatch`).

**An Expo / React Native app on the web:** `reactNative: true` (with `mode: "spa"`) builds the
app's own source through `react-native-web` (`react-native` → react-native-web, `.web.*` first,
expo-router's routes), and every `expo-*` import resolves to a `denext/expo/*` shim over
`denext/mobile` (`denext/expo/manifest` lists what each omits; the synchronous JSI APIs are not
provided). React Native's mocked APIs (`Keyboard`, `BackHandler`, `StatusBar`, `Alert`,
`RefreshControl`, `Linking`, …) are replaced with shell-backed ones, `FlatList` / `SectionList` /
FlashList / LegendList run on `VirtualList`, expo-router's and React Navigation's stacks and
tabs on `denext/navigation`, Reanimated needs no Babel plugin, and popular native libraries
(react-native-webview, -keychain, -permissions, safe-area-context, …) resolve to denext
implementations (`reactNative: { aliases: { "<pkg>": false } }` restores one).
`Platform.OS` stays `"web"`; read `Platform.constants.denextShell`. `reactNative.desktopPackage: "react-native-macos" | "react-native-windows"` builds the app's own `react-native` imports as that desktop package. `denext migrate --from expo`
writes the `deno.json`, the config and a `capacitor.config.ts`, and reports native-only packages;
`denext mobile add app-config` carries the app config's usage strings, Android permissions and
`expo-build-properties` into the shell, and the shims over a plugin have their capability
(`text-to-speech`, `contacts`, `calendar`, `print`, `brightness`, `intent-launcher`; migrate
suggests them).
`denext dev` hot-swaps an edited component with its state kept (Fast Refresh); a top-level
`requireNativeModule` loads off-device and throws only when called. Native-only SDKs
(`@react-native-firebase/*`, `react-native-iap`, `@stripe/stripe-react-native`) have no alias:
https://denext.dev/docs/native-sdk-recipes. Docs: https://denext.dev/docs/react-native

**A database (zero-npm, server-only module):**

```ts
// lib/db.ts — Deno's built-in SQLite; no install.
// KV / Postgres recipes: https://denext.dev/docs/database
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(Deno.env.get("DB_PATH") ?? "app.db");
export const listNotes = () => db.prepare("SELECT * FROM notes").all();
```

Open the connection once at module scope; do writes in Server Actions.
`denext generate migration <name>` writes `migrations/<timestamp>_<name>.sql` and a
`tasks/migrate.ts` that applies pending ones on `node:sqlite` (`denext task migrate`; a Prisma or
Drizzle project is pointed at its own tool); `generate seed` an idempotent `tasks/seed.ts`;
`generate ci` a GitHub Actions workflow. `denext routes [--json]` lists the app's pages and API
routes.

**A scheduled / background task (cron):** put it in `tasks/<name>.ts`; schedule it in
`denext.config.ts` (`scheduledTasks`) or per-task; run it on demand with `runTask(name)`
or `denext task <name>`. Uses `Deno.cron` where available (Deno Deploy), else a userland
tick — no npm cron dependency. **Cron expressions are evaluated in UTC** (matching `Deno.cron`),
weekdays are **POSIX** (`0–6`, `0` = Sunday; denext translates them to names for `Deno.cron`),
and a schedule never fires on startup nor overlaps a still-running instance of the same task.
`tasks: { history: true }` records every run to `.denext/tasks.db` (`historyMaxRuns` per task,
14 days); the Cron page of `denext ui` shows it. `defineTask({ retry: { attempts, backoff } })`
re-runs a failed task (exponential from 1 s by default; the handler's context has `attempt`).

```ts
// tasks/cleanup.ts
import { defineTask } from "denext/server";
export default defineTask({
  description: "purge expired sessions",
  schedule: "0 3 * * *", // optional; or list it in config.scheduledTasks
  handler: async ({ payload }) => {
    await db.exec("DELETE FROM sessions WHERE expires_at < now()");
  },
});
// denext.config.ts → scheduledTasks: { "0 0 * * 1": ["digest", "warm-cache"] }
// anywhere on the server: import { runTask } from "denext/server"; await runTask("cleanup");
```

**A content collection (typed MD/MDX/YAML/JSON — the `@denext/content-collections` plugin):** add
`plugins: [contentCollections()]` to `denext.config.ts`, declare collections in `content.config.ts`
with a Standard Schema + a loader, then query them typed from a Server Component. The plugin
validates entries and generates types — live in `denext dev`, and at `denext build`.

```ts
// content.config.ts
import { defineCollection, defineContentConfig, glob } from "@denext/content-collections/config";
import { z } from "zod";
export default defineContentConfig({
  collections: {
    blog: defineCollection({
      loader: glob({ pattern: "**/*.md", base: "content/blog" }),
      schema: z.object({ title: z.string(), date: z.string(), draft: z.boolean().default(false) }),
    }),
  },
});
```

```tsx
// app/page.tsx — server-only query, typed to the schema
import "../.denext/content.ts"; // registers the collection types (generated)
import { getCollection } from "@denext/content-collections/runtime";
export default async function Blog() {
  const posts = await getCollection("blog", (p) => !p.data.draft); // p.data is typed
  return <ul>{posts.map((p) => <li key={p.id}>{p.data.title}</li>)}</ul>;
}
// Render an entry's body: `<Content entry={post} />` (or `await renderContent(post)`) from the
// same module — `.md` through the first-party renderer, `.mdx` through a module compiled at build.
// CLI: `denext content build | list | validate` (validate exits 1 on a schema failure — a CI gate).
```

**A compile-time feature flag (dead-code-eliminated):** `feature("KEY")` from `denext/feature`
folds to a boolean literal at build time for any KEY in `features` — denext's
`feature()` (cf. Bun's `bun:bundle`). `feature()` always returns the configured value; the untaken
branch is dead-code eliminated where it folds (native App Router component modules, SPA, dev), and
read at runtime on the compat drop-in App Router path. Keep the argument a string literal; a key
not listed reads `false`. Flag names/states are embedded in the client bundle (don't encode secrets).

```tsx
import { feature } from "denext/feature";
export function Checkout() {
  return feature("NEW_CHECKOUT") ? <NewCheckout /> : <LegacyCheckout />;
}
// denext.config.ts → features: { NEW_CHECKOUT: false }
```

**Inspect / shrink the client bundle:** `denext analyze` breaks the bundle down by chunk + role;
`denext analyze --md` writes a markdown report (per-module on the esbuild path) to pipe into CI.
Imports of one export from a `"sideEffects": false` dep (lucide-react, Radix) are tree-shaken
automatically on the esbuild path. `optimizePackageImports` (Next's key, top-level) goes further:
barrel imports of listed packages are rewritten to the defining modules, so the barrel is never
loaded. A built-in list (lucide-react, date-fns, lodash-es, …) is on by default; add packages,
drop one with `"!pkg"`, or disable it with `false`. Listing a package asserts it is side-effect
free. A package whose own `package.json` declares `sideEffects` (`false`, or an array naming none of
the barrel's modules) is rewritten unlisted too, so a lazy route's modules stay out of the startup
chunks (`"!*"` turns that automatic mode off). Applied by the esbuild bundles only (not unbundled
dev or the native `deno bundle` path).

**Testing an app (no browser, JS-disabled path):**

```ts
import { createTestApp, createTestClient } from "denext/testing";
const client = createTestClient(await createTestApp("./"));
const res = await client.submit(
  client.form((await client.get("/login")).text),
  {
    email,
    password,
  },
);
// res.status, client.cookies — a cookie jar persists the session across requests.
```

**Testing a component (hooks/effects/events, no browser):**

```ts
import { fireEvent, render } from "denext/testing";
import { h } from "denext/jsx-runtime";
const screen = await render(h(Counter, null)); // async — await it
await screen.fireEvent.click(screen.getByRole("button"));
// getByRole/getByText/getByLabelText/getByTestId; fireEvent.change wires to onChange.
```

**Conformance-probing every route (CI gate):**

```ts
import { formatReport, probeApp } from "denext/testing";
const report = await probeApp("./"); // renders every route, asserts valid HTML docs
if (!report.ok) throw new Error(formatReport(report)); // or run `denext doctor`
```

**Config:** `denext.config.ts` exports `{ ... }` (redirects, rewrites, headers,
i18n, images, `cacheComponents`, `streaming`, `live`, `reactCompiler`, `features`, `plugins`,
`tailwind`, `csp` (strict by default; `frameSrc` / `mediaSrc` / `workerSrc` / `fontSrc` /
`scriptSrc` / `styleSrc` / `imgSrc` / `connectSrc` opt-ins, e.g. `{ frameSrc:
["https://js.stripe.com"] }`), `compress` (gzip, on by default; `{ encodings: ["br", "gzip"] }`
adds brotli; `false`, or `export const compress = false` in a route), `cors`, `cdnCacheHeaders`
(opt-in: ISR pages answer `Cache-Control: public, s-maxage=…` for a CDN, never for a request
with a cookie or `Authorization`, a negotiated locale or a `middleware.ts` match, unless
`{ evenWithMiddleware: true }`), `compatibilityMode`,
`optimizePackageImports`, `momentumSafeScroll`, `desktop`, `mobile`, `appLinks`;
`mode: "spa"` + `spa: { entry, … }` for SPA mode). Not `next.config.js`.
Every key: https://denext.dev/docs/config

SPA Vite build parity (`denext migrate` sets what vite.config had): `spa.assetsDir: "assets"`
serves and exports the client under `/assets/` as `name-HASH8.ext`; `spa.viteManifest: true`
writes `.vite/manifest.json`; `spa.tanstackRouter: { autoCodeSplitting: true }` splits routes;
a failed chunk load dispatches cancelable `vite:preloadError` (+ `denext:chunkError`); a plugin
build step's `emitFile()` (or `viteEmitterPlugin(vitePlugin)`) publishes files at the site root.

**Writing a plugin:** a `DenextPlugin` (`{ name, setup(ctx) }` from
`denext/plugin-kit`, the semver-stable toolkit) hooks six seams — `addRouteSynthesizer` (add/adjust routes),
`addRequestHandler` (claim unmatched requests), `addBuildStep` (emit assets at build and export;
its `emitFile({ fileName, source })` publishes a file at the site root like Vite's
`this.emitFile`, and `viteEmitterPlugin(vitePlugin)` runs a Vite `generateBundle` emitter as one),
`addPrepareStep` (codegen the app imports — runs at build AND dev startup, and re-runs on
`watch`-glob changes in dev), `addTeardown` (dispose on drain), and `addCommand` (contribute a
CLI verb). Declare it as `plugins: [myPlugin()]`. See
the [plugin guide](https://denext.dev/docs/plugins) and
[`examples/plugin-aliases`](https://github.com/Brainwires/denext/tree/main/examples/plugin-aliases).

## What's different to keep in mind

- **Pages Router** is not built in — it's the opt-in `@denext/pages-router`
  plugin (`plugins: [pagesRouter()]` in `denext.config.ts`).
- **Cache Components / PPR** are a stable **opt-in**: `cacheComponents: true`
  (top-level) in `denext.config.ts`. Not `experimental.cacheComponents` — that
  Next.js spelling still works but dev-warns, as do Next's
  `experimental.reactCompiler` and `experimental.optimizePackageImports`.
  `reactCompiler`, `asyncContext`, `features` and `nodeResolve` are top-level
  fields; denext's own `experimental.compiler` / `asyncContext` / `features` /
  `nodeResolve` were removed in 3.0 and are a config error.
- **Zero runtime npm**: nothing the framework ships to the runtime pulls npm
  (CI-enforced). The build-time toolchain still uses a few npm tools — `esbuild`
  (core) plus opt-in `sass` / `@mdx-js/mdx` / `ws` / `@tanstack/router-plugin`; the CSS + swc-AST tooling is
  the first-party `@denext/lightningcss` / `@denext/swc` wasm. Your app may still
  use `npm:`/`jsr:` libraries.
- Run checks with `deno task check` (fmt `--check` + lint + tests; type-checking
  happens transitively via `deno test`, there's no separate type-check step).
  `deno task
  check:fix` auto-fixes formatting + fixable lint, then reports the
  rest. The `denext/*` lint rules (rules-of-hooks, hooks-in-component,
  no-hooks-in-async, directive-placement) are **correctness** rules with **no
  auto-fix** — resolve them by hand;
  [the contributing guide](https://denext.dev/docs/contributing) says how.

When unsure, write it the Next.js App Router way and change only the imports per
the map above — that is almost always correct denext.

## Tooling for AI agents (MCP + llms.txt)

denext ships tooling so agents get it right the first time:

- **MCP server** — `denext mcp` (or, with nothing installed,
  `deno run -A jsr:@denext/denext/cli mcp`). It speaks
  MCP over stdio; configure it as an MCP server in your client. Tools:
  `denext_check_snippet` (lint a code string for Next-isms before you write it),
  `denext_import_map` (map a Next/React import to denext), `denext_generate` (scaffold —
  takes `force` and `dryRun`),
  `denext_doctor`, `denext_codemod`, `denext_list_routes` (an app's pages + API routes),
  `denext_dev_logs` (the RUNNING dev server's recent events — server errors, server +
  browser console, completed requests, and HMR — so you can see what actually happened at
  runtime), `denext_render` (render a route or component server-side, no browser, and get
  the HTML/error — SEE what your edit produces), `denext_route_map` (the full render
  tree at a path: layouts, boundaries, server/client split), `denext_component_tree` /
  `denext_why_render` / `denext_hook_state` (the LIVE component tree from a running dev
  page — props, named hooks, why a component re-rendered; these need `deno task dev`
  AND the app open in a browser, and each answer states how stale its snapshot is. The
  page starts pushing only once one of them has been called, so the FIRST call may say
  "posted nothing yet" — call it again after the page's next commit, or start dev with
  `DENEXT_DEV_INSPECT=1`. String values arrive redacted as `string(n)`),
  `denext_profile` (build
  unminified, serve, and profile a route in headless Chromium — CPU self-time by
  function + heap growth + a leak check; pass `interact` to profile a re-render, `budget`
  to gate a regression), `denext_search_docs` (BM25
  over ALL of the denext docs, offline — every docs-site page by section plus the API reference;
  `kind: "guide" | "api"` narrows it) and `denext_read_docs` (a whole page, one `slug#anchor`
  section, or `api:<module>/<name>` as Markdown — use it instead of fetching denext.dev), and the codebase tools `denext_index_codebase` /
  `denext_query_codebase` / `denext_find_definition` / `denext_find_references`.
  `denext mcp --disable rag,docs` hides tool groups or individual tools to trim an
  agent's context. Resources: `denext://guide`, `denext://import-map`, `denext://docs`
  (`denext://docs/<slug>`). Install it in a project with `denext create --mcp` (pre-checked in the
  picker) or `denext mcp init`: a `deno task mcp` that runs the denext the project pins, registered
  in `.mcp.json` (Claude Code), `.vscode/mcp.json` and `.cursor/mcp.json` (`--clients all` adds
  `.gemini/settings.json` and `.codex/config.toml`).
- **`llms.txt`** — [denext.dev/llms.txt](https://denext.dev/llms.txt) (concise) and
  [llms-full.txt](https://denext.dev/llms-full.txt) (this guide + an API summary).
- **Docs pages worth pointing an agent at:** the generated [CLI reference](https://denext.dev/docs/cli), [Troubleshooting](https://denext.dev/docs/troubleshooting) (symptom → cause → fix), the [changelog](https://denext.dev/docs/changelog) (every change per version), the [Project UI](https://denext.dev/docs/ui) and the [examples index](https://denext.dev/docs/examples).

---

## Releasing: `main` always equals the published release

All work lands on `development`, and releases are cut there with
`deno task release <version>` (which tags `v<version>` and pushes). The script
first refuses unless ci.yml's heavy jobs (`integration`, `next-compat`, `coverage`,
with `check` and `ios-export-router`) are green on HEAD: a push to `development`
skips them, so dispatch ci.yml on the commit first
(`gh workflow run ci.yml --ref development`, then wait for it). Active
`development` runs ahead of `main` by design.

**`main` must always be exactly what is published.** So **cutting a version is not
done until `development` is merged into `main`** — the release flow is: tag
`v<version>` → verify the JSR publish succeeded → open a `development → main` PR
(`gh pr create --base main --head development`, same flow as PRs #5–#11) → **merge
it** (`gh pr merge <n> --merge`). "Cut a version" _implies_ this merge; do it as part
of the release, not as a separate maintainer step. A tag without `main` merged to it
is an incomplete release. The PR may batch several rc tags since the previous merge;
that's fine.

---

## Before committing: measured coverage first

Run `deno task coverage:fallow` before `git commit` whenever `coverage/coverage-final.json`
is missing (it is git-ignored, so a fresh clone or a disk sweep removes it) or when your change
touches a function with cyclomatic complexity ≥ 10. The fallow gate below scores CRAP with that
measured map; without it fallow estimates coverage from the import graph and can block a commit
on internals that tests reach only transitively (the fiber reconciler, the request pipeline).
The task runs the unit suite (~10 min) and needs no other setup. See
[CONTRIBUTING.md](./CONTRIBUTING.md) → _The Fallow gate_.

<!-- fallow:setup-hooks:start -->

## Fallow local gate

Before any `git commit` or `git push`, run `fallow audit --format json --quiet --explain --gate-marker agent` (add `--coverage coverage/coverage-final.json` when that file exists — `deno task coverage:fallow` generates it, and it turns fallow's estimated CRAP coverage into measured coverage; see CONTRIBUTING.md). If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking.

Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict. Inherited findings on touched files are reported under `attribution` and annotated with `introduced: false`, but do not block the commit. Set `[audit] gate = "all"` in `fallow.toml` to gate every finding in changed files.

For non-skill agents, treat the task map below as the local onboarding source: run the listed fallow command before destructive edits, before commits, and before pull request handoff.

## Fallow task map

| When the agent is about to...                                     | Run                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| delete an "unused" export or file                                 | `fallow dead-code --trace <file>:<export>`                                           |
| prove a TypeScript symbol's exact consumers before refactoring    | `fallow dead-code --type-aware --symbol-impact <file>:<export-or-class.method>`      |
| delete an "unused" dependency                                     | `fallow dead-code --trace-dependency <name>`                                         |
| commit or open a PR                                               | `fallow audit --base <ref>`                                                          |
| prioritize refactoring                                            | `fallow health --hotspots --targets`                                                 |
| ask who owns code                                                 | `fallow health --ownership`                                                          |
| check untested-but-reachable code                                 | `fallow health --coverage-gaps`                                                      |
| consolidate duplication                                           | `fallow dupes --trace dup:<fingerprint>`                                             |
| find feature flags                                                | `fallow flags`                                                                       |
| check which architecture rules apply to a file before changing it | `fallow guard <files>`                                                               |
| surface security candidates                                       | `fallow security`                                                                    |
| understand a finding                                              | `fallow explain <issue-type>`                                                        |
| scope a monorepo                                                  | `--workspace <glob> / --changed-workspaces <ref>` (global flags, prefix any command) |

<!-- fallow:setup-hooks:end -->
