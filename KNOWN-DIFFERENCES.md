# denext — Known differences

Where denext **deliberately** behaves differently from what it is compatible with — React, Next.js,
React Native and Supabase. Each entry
is an observable behavior, documented so a port knows what to expect — not a gap
waiting to be closed. A surface that is missing, throwing, or wrong is a
_limitation_ and lives in [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); an
internal design choice with no observable difference lives in
[the architecture guide](https://denext.dev/docs/architecture).

## React rendering semantics

- **Every function component is implicitly `memo()`-wrapped.** denext's reconciler
  skips re-rendering a component whose props (shallow), context and own state are
  unchanged — the default React only applies under `memo`. Pure components are
  unaffected; a component that reads module-level mutable data, `Date.now()`, or a
  mutated object without a prop/state change will render stale until something it
  depends on changes. Put such inputs in state, a ref read inside an effect, or a
  context. Test suites ported from React that count renders will see fewer renders.
  Deliberate (it is a large part of why denext's runtime is small and fast), not a
  bug — so it is listed here rather than fixed. It applies to the app's own elements only:
  in a compat build (npm React aliased to denext, and React Native mode) an element that
  code inside `node_modules` creates keeps React's semantics — it re-renders whenever its
  parent does, and is skipped only when its parent did not re-render (or it is a `memo()`).
  Libraries written for React may rely on that: React Navigation's `useComponent`, which
  expo-router/ui's tabs use, reads the navigator's latest render function from a ref, and
  skipping it left a tab press changing the URL but not the screen.
- **Errors thrown in DOM event handlers are routed to the nearest error boundary.**
  React lets them reach `window.onerror` and keeps the UI up; denext catches them
  (`onCaughtError` sees them) and shows the boundary's fallback, so one bad click
  swaps out that boundary's subtree. Deliberate — a boundary that never sees the
  most common runtime error in an app is a weak boundary — but it is a behavioral
  difference; wrap the handler body in `try/catch` when you want React's behavior.
- **`useDeferredValue` under `act()` / `flushSync`** — the test renderer's
  synchronous flush collapses the deferred pass, so a test sees the final value at
  once rather than the stale one first. Real event-path rendering defers as React
  does.
- **A state update is applied when it is set, not per lane.** React queues each update with
  its lane, so an urgent re-render of a component leaves that component's pending Transition
  state for the Transition render. denext applies the new value at once, so any re-render of
  the component reads it. You can see this with `<ViewTransition>` and external stores. A
  `useSyncExternalStore` change always renders synchronously, even inside `startTransition`,
  so it never animates, which is also true in React. But when one `startTransition` changes a
  store and also sets state in a component that reads that store, the store's synchronous
  render commits that state too, and the `<ViewTransition>` it reveals does not animate. React
  would animate it in the later Transition render. Keep the animated state in a component
  that doesn't subscribe to the store, or move the value out of the store into state.
  Deliberate: one value per hook, with no update queue, keeps the reconciler small.
- **The class-component runtime loads on demand.** React ships its class support in the
  core; denext ships it as a separate chunk (`denext/class-runtime`) that a page fetches only
  when it needs it. A server-rendered class is preloaded before hydration (the document
  carries a marker), and an app whose own sources name `Component` gets a static import — so
  in both common cases nothing is observable. The one visible case: a class that first
  appears **client-side only**, on a page that server-rendered none (a soft navigation onto a
  class page from a class-free one, a `client:only` island) and with no `<Suspense>` above
  it, renders an empty subtree for one round trip while the chunk loads, then renders
  normally; inside a Suspense boundary it shows the fallback instead. Deliberate — it is
  what keeps a function-only app from paying for class support — and `classComponents:
  true` in `denext.config.ts` opts out by always importing the runtime statically.
- **`useId` values encode the component's tree position, not a counter.** denext emits
  `_d{path}_{n}_` (e.g. `_d0-2-1_0_`) where React 19.2 emits `_r_{n}_`. Both use the same
  character class — a valid CSS identifier, XML 1.0 name and `view-transition-name`, so
  `querySelector("#" + id)` needs no `CSS.escape` — but the values differ, so a snapshot
  test that pins React's literal ids will not match. Deliberate: a position-derived id is
  what lets a streamed PPR hole or an independently-hydrated island reproduce the server's
  ids without a shared global counter. A user-supplied `identifierPrefix` is concatenated
  verbatim, as in React, so keep it selector-safe too.
- **The root `denext` barrel exports React's function-component surface, not its
  class one.** `Component`, `PureComponent`, `version`, `act` and `useMemoCache`
  live on `denext/react` (and `denext/testing` for `act`); on the root barrel
  `Component` is the function-component _type_. Everything else React exposes
  (`cache`, `Children`, `cloneElement`, `forwardRef`, `Activity`, the hook and
  event types, …) is on both.
- **SSR attribute serialization follows ReactDOMServer's tables, with a few differences.**
  `true` on an attribute React doesn't know renders `name=""` (React drops it), matching what the
  client reconciler sets; `autoCapitalize={true}` renders `"true"`; `'` is escaped as `&#39;`
  (React: `&#x27;`, the same character to every parser); an element with both
  `dangerouslySetInnerHTML` and children renders the HTML (React throws); `key` is visible on an
  authored element's `props`; and `defaultProps` on a function component is honored (React 19
  removed it) because popular npm libraries still rely on it.
- **A `redirect()` thrown during a CLIENT render is a full document load**
  (`location.assign`), not a soft navigation — the render is abandoned, the browser
  loads the target. On the server it is the usual 307.
- **Inside a streamed `<Suspense>` hole (the shell has flushed), a control signal can't
  touch the headers — the hole's streamed replacement carries it instead**, matching
  Next's semantics with one deliberate difference in mechanism. `redirect()` /
  `permanentRedirect()` stream a client-side redirect into the hole: a
  `<meta http-equiv="refresh" content="0;url=…">` (destination through the same
  sanitiser as an HTTP `Location`) and **nothing else** — Next also emits an inline
  `<script>` setting `location.href`, which denext omits because a streamed hole is not
  covered by the hashed streaming CSP, so the script would be blocked. The response
  stays a 200 (a soft navigation is never streamed, so there it is a real HTTP redirect).
  `notFound()` / `forbidden()` / `unauthorized()` reveal the nearest enclosing boundary's
  UI (`not-found.tsx` … or the built-in) in place of the hole, status left at 200, as in
  Next. `after()` runs when the **stream ends**, not when the Response object exists
  (Next: the same). `cookies().set()` / `.delete()` after the first flush throw in dev
  ("cookies can only be modified before the response starts …") and are logged once and
  ignored in production; Next throws in both. Same rules on a PPR hole and a Flight-route
  hole.
- **`notFound()` / `forbidden()` / `unauthorized()` are Server-side signals.** Next
  documents them for Server Components, Server Functions, and Route Handlers, and denext
  supports exactly those (plus Server Actions) — the matching `not-found.tsx` /
  `forbidden.tsx` / `unauthorized.tsx` boundary renders with its 404/403/401. Per Next's
  own contract each "throws … and terminates rendering of the route segment," so one
  thrown during a CLIENT render terminates that render (the control signal bubbles past
  `<ErrorBoundary>`) rather than swapping in the boundary — matching the documented
  behavior, a deliberate difference from real Next's undocumented client-boundary catch.
- **`defineAction` handler errors are redacted in production** (`error: "Internal
  Server Error"` + a `digest` that correlates with the server log), exactly like a
  render error handed to `error.tsx`; `ActionValidationError` messages and field
  errors pass through verbatim because they are authored for the user.
- **`defineApi` routes follow the same redaction split.** A thrown `ApiError` (and
  a schema `validation` failure) is authored for the client and passes through
  verbatim as the JSON error envelope; any other throw is a redacted JSON 500
  (`{ error: { code: "internal", message: "Internal Server Error", digest } }`). A
  plain `route.ts` handler's unknown throw keeps the text 500 it always had. Likewise
  a `defineSubscription` resolver failure reaches the client as a redacted `failed`
  frame (with `digest`), while its `invalid-input` field errors are verbatim; a
  channel payload is app-authored and never redacted.
- **`redirect()` / `notFound()` / `forbidden()` / `unauthorized()` thrown in a
  `route.ts` handler are HTTP responses** — the redirect with its status, or
  404/403/401 as a JSON error envelope (plain text when the request prefers
  `text/html`). Next has no equivalent for route handlers.
- **Route handler request bodies are capped** at 1 MiB by default (Next: unbounded),
  matching Server Actions. Raise or lift per route with `export const maxBodyBytes =
  N | false`, app-wide with `apiMaxBodyBytes`; streaming consumers keep streaming.
- **A typed client call made during SSR never goes over the network.** Inside a
  request, `createApiClient` / `useApi` run the call in-process through the full
  pipeline under the caller's identity (and through the tag-aware cache when `cache` /
  `next` options are passed); outside a request, or to a foreign `base`, it is a fetch.
- **`json()` from `denext/server` may add an `x-denext-wire: 1` header** when the body
  carried a Date / Map / Set / BigInt / URL / `undefined` / NaN / ±Infinity / -0 (the wire
  codec); a plain-JSON body
  stays byte-identical to `Response.json()`. Third-party consumers of a route that
  returned a previously-lossy value now see `{ "$": … }` tags plus that header.

## Next.js routing and config

- **Config `rewrites` have one phase.** Next distinguishes `beforeFiles` /
  `afterFiles` / `fallback` rewrites; denext runs its single `rewrites` list after
  middleware and before the filesystem (Next's `beforeFiles` position). Middleware
  matchers therefore always see the URL the client asked for.
- **`proxy.ts` and `middleware.ts` take either export name.** Next 16 requires a `proxy` (or
  default) export in `proxy.ts` and a `middleware` (or default) export in `middleware.ts`, and
  warns that `middleware.ts` is deprecated. denext reads `proxy`, `middleware` or the default
  export from whichever file the app has, and does not warn. Both files at once is an error in
  both. denext finds the file with Next's default extensions (`tsx`, `ts`, `jsx`, `js`) plus
  `mts` / `mjs`; it has no `pageExtensions` option. Two files of the same name
  (`middleware.ts` and `middleware.js`) are an error too, where Next takes one by extension
  order. A file that exports no handler stops the app at startup (dev, `start`, `doctor`); Next
  fails its build, and `denext build` does not import the file.
- **`nodeResolve` is on by default** for the compat (npm React) build — every bare
  npm specifier resolves from the installed `node_modules` through denext's tolerant
  resolver, which is what lets an unmodified pnpm/npm/yarn app build with no
  `package.json` rewrite. Next has no such layer. Set `nodeResolve: false` for
  Deno's strict `npm:` loader.
- **Server-action ids are opaque hashes** of `module#export` (Next's are hashes too,
  but of a build-specific manifest); ids are stable across processes and replicas
  without a build salt.
- **`userAgent().device.type`** is `undefined` for a desktop browser (matching
  ua-parser-js); the older denext value was `"desktop"`.
- **Cron expressions use POSIX weekday numbers** — `0–6` with `0` (or `7`) for Sunday, so
  `0 0 * * 1` is Monday, as every Vixie cron and the userland scheduler read it. `Deno.cron`
  numbers weekdays `1–7` from Sunday and rejects `0` and `?`, so denext never hands it an
  expression verbatim: the day-of-week field is translated into names (`MON`, `MON-FRI`, an
  exact list for a stepped range) and `?` becomes `*`. Write POSIX; the translation is denext's.
  (Next has no scheduler; this differs from `Deno.cron`'s own convention.)
- **`next/head` dedupes conservatively.** Same-`key` `<meta>`/`<link>` collapse last-wins,
  `<meta charSet>` / `<meta name="viewport">` collapse to one and `<title>` is last-wins, but
  keyless `<meta>` sharing a `name`/`httpEquiv`/`itemProp` and duplicate `<base>` are kept: the
  collector also receives React-19-style in-tree `<meta>`, which React never dedupes.
  `<base>`/`<script>`/`<style>`/`<noscript>` inside `<Head>` reach the head on the server render
  only; a client-side navigation does not update them.
- **`client-only` is inert at build time.** Next fails a build that imports `client-only`
  from the `react-server` layer. denext's compat SSR bundle server-renders the `"use client"`
  tree as well, so it has no such layer and treats `client-only` as an empty marker on both
  sides; `server-only` in the client bundle is still a build error, and the runtime
  `clientOnly()` guard still throws on the server.

## Remix and React Router

- **A `clientLoader`'s `serverLoader()` doesn't make its own request on a navigation.** denext
  navigates by rendering the target route on the server, so the server `loader` runs with that
  render and `serverLoader()` resolves its result. React Router calls the server loader only
  when the client loader asks for it. A route a navigation brings in also renders (its server
  data, or its `HydrateFallback` when it hydrates) before its `clientLoader` settles, where
  React Router holds the previous page until it does.

## Browser behaviour

- **On iOS/iPadOS WebKit, denext patches `Element.prototype`'s scroll members** (default on;
  `momentumSafeScroll: false` in `denext.config.ts` opts out). This applies to every iOS
  Safari visitor, not only Capacitor shells. While a finger is down or a fling runs,
  programmatic scroll writes on element scrollers (`scrollBy`, `scrollTo`, `scroll`, the
  `scrollTop` / `scrollLeft` setters) are deferred instead of cancelling the momentum:
  `scrollTop` reads real + pending (clamped to the scroll range), `scrollHeight` /
  `scrollWidth` read as unshifted, and the scroller's children carry a temporary `translate`
  composed with their own until the fling settles. A shifted child is the containing block of
  its `position: fixed` descendants, and sticky headers inside it move with the list for that
  time. The document scroller is never shifted: its writes, `window.scrollTo` included, always
  apply at once. `scrollIntoView` and smooth `scrollTo` drop the pending delta of the scroller
  they move. Documents inside iframes are not covered. React and Next leave scroll writes alone,
  so there a virtualized list's anchoring correction stops an iOS fling dead.

## React Native mode

- **`Platform.OS` is `"web"` in the iOS / Android shells and in Deno Desktop.** react-native-web
  and libraries pick their DOM code paths by it, so React Native code that branches on `ios` /
  `android` for behaviour (not for a native module) takes its web path. `Platform.select`
  still picks the shell's `ios` / `android` key when the spec has no `web` key (and the host
  OS's `macos` / `windows` / `linux` key in Deno Desktop), and `Platform.constants.denextShell`
  tells the shells apart. Deliberate: reporting `ios` would send react-native-web and every
  library down code paths that need a native renderer.
- **`inverted` lists are a logical reversal, not a `scaleY(-1)` flip.** On `VirtualList`'s
  FlatList / SectionList / VirtualizedList, FlashList and LegendList adapters the wheel, the
  keyboard, text selection, copy order and the scrollbar all run the natural way, where
  react-native-web's flipped list reverses them. A style that relied on the flip (a child
  counter-transform) is not needed.

- **`.native.*` files are not resolved by default.** React Native's Metro picks `Name.native.tsx`
  on iOS and Android; denext's iOS and Android exports run in a WebView, where a `.native` file
  is usually native code that cannot run, so they are skipped unless
  `platformExtensions: { native: true }`. `.ios` / `.android` / `.mobile` / `.web` resolve as in
  Metro (see [platform-specific files](https://denext.dev/docs/platform-files)), except in React
  Native mode, where the app's own `.ios` / `.android` files are native code too and are skipped
  unless `platformExtensions: { osFiles: true }`.
- **Platform files are resolved per target build, not per device.** Metro bundles per platform
  too; denext's `denext build`, `start` and a plain `denext export` are the `web` target, and
  `denext dev` serves `web` unless a shell names its target (`mobile dev`, `desktop dev`). An iOS,
  Android or desktop file is used only in that target's export (`denext export --platform`,
  `denext mobile build`, `denext desktop build` / `package`). Packages in `node_modules` keep
  their own resolution: their `.ios.js` files are not picked, since they call native modules. A
  Pages Router app (`@denext/pages-router`) takes the `web` target's files only.

## Lists

- **`lists: "denext"`'s LegendList is `VirtualList`'s engine, not LegendList's.** An item
  size estimate is always confirmed by measuring the rendered item, and the scroll element
  carries the engine's inline `height: 100%`: a `style` height, or a class with a max height, sizes it, where
  the real DOM build's element has no inline height. It applies to apps on npm React (the
  esbuild build path); a denext-native app uses `VirtualList` directly.
- **`waitForInitialLayout` hides the whole list, not only its items.** Until the first items are
  measured the list is invisible (`opacity: 0`, no pointer events), headers, footers and empty
  state included, so it never paints at estimated positions.
- **`itemsAreEqual` keeps an item's rendered element only while its index is unchanged.** An
  item the callback calls equal but that moved to another index renders again.

## Supabase and `@denext/backend`

Where `@denext/backend` deliberately departs from Supabase. See
[Coming from Supabase](https://denext.dev/docs/coming-from-supabase).

- **No table is granted by default.** Supabase grants every table in `public` to `anon` and
  `authenticated`; denext's roles start with no privileges, so a table is private until a
  migration grants it (or sets `alter default privileges`, Supabase's default).
- **Auto-REST serves only what row-level security covers.** PostgREST serves any granted table or
  view; `backend({ rest })` with the default `tables: "*"` serves RLS-enabled tables and views
  created `with (security_invoker = true)`, skips a table with RLS off and an ordinary view (it
  reads as its owner), and lists what it skipped in a startup warning. Naming a relation in
  `rest.tables` serves it as is. A full count (`Prefer: count=exact`) is for signed-in callers by
  default (`rest.exactCount`).
- **Auto-REST has a request budget.** PostgREST (and Supabase's Data API) applies none of its own;
  `backend({ rest })` answers a client past 1200 requests a minute (a signed-in user by id,
  anyone else by address; never the secret key) with `429 over_request_rate_limit` and
  `Retry-After`, so a scraper can't take the database pool. `rest.rateLimit` tunes it, `false`
  turns it off.
- **Realtime tells subscribers about a `TRUNCATE`.** Supabase Realtime's `postgres_changes` never
  delivers one (its change stream asks for inserts, updates and deletes only), leaving clients
  showing rows that are gone. denext sends `eventType: "TRUNCATE"` (empty `new` and `old`) to a
  `*` binding of a subscriber who could see rows of the table, and a binding with
  `event: "TRUNCATE"` — which Supabase turns into `*` — receives only those.
- **Server code needs no service-role key.** With `backend({ supabase })` the secret key
  (`DENEXT_SECRET_KEY`) is the `service_role`, past every policy, as on Supabase — keep it
  server-side. denext additionally gives server code `db.service()` (and a bucket's
  `{ service: true }`), so the key never has to leave the server; without `supabase` there is no
  key at all.
- **A request without the rate-limit header is still limited.** `rateLimitHeader` is Supabase
  Auth's `GOTRUE_RATE_LIMIT_HEADER`, but where Supabase applies no limit to a request that lacks
  the header, denext keys it on the trusted hop or the socket peer (with one warning), so a
  client that reaches the server directly can't skip every limit by leaving the header out.
- **The rate-limit header is believed only from a trusted proxy.** Supabase Auth trusts
  `GOTRUE_RATE_LIMIT_HEADER` from any connection; denext believes `rateLimitHeader` only when the
  socket peer is in `rateLimitTrustedProxies` (or, with none listed, is a loopback/private address
  while `trustForwardedHeaders` is on), and otherwise keys the limit on the peer. Where the origin
  is reachable directly, trusting it blindly would let a client send a fresh value per request and
  get a fresh bucket each time.
- **An SSO user's email is bound only on the IdP's own domains.** Supabase keeps SSO users as
  separate accounts with whatever email the IdP asserts; denext has one user per email, so an
  address outside the provider's `domains` is never put on an account (a provider stored through
  the admin API is refused for it; a config-declared one signs in a user with no email), and an
  SSO user has no `email` identity.
- **An SSO user's address can't start a second account.** Supabase leaves SSO users out of every
  non-SSO lookup and lets a sign-up, a one-time code, an admin magic link or an OAuth sign-in
  create a separate account for the same address. denext excludes SSO users from those lookups
  the same way (nothing is sent; a password or code signs nobody in), but with one user per
  email it answers a sign-up as for a registered address, creates nothing for a one-time code,
  refuses an OAuth / `id_token` sign-in (`account_not_linked` / `email_exists`) and answers
  `generate_link` `magiclink` / `signup` / `invite` and `POST /invite` with `email_exists`.
- **An SSO user signs in through its identity provider only — linked identities included.**
  Supabase lets an OAuth identity linked to an SSO user sign it in and keeps every session it ever
  issued. denext refuses that sign-in (`422 user_sso_managed`), refuses any session of an SSO user
  that no SAML sign-in started (at use and at refresh) — read from the stored session, not the
  hook-writable `amr` claim — as well as an OAuth client's tokens whose grant was approved from
  such a session (Supabase keeps them), refuses `GET /reauthenticate` for an SSO
  user (`422 user_sso_managed`, nothing sent; Supabase sends a nonce `PUT /user` then refuses),
  and never links a `linkExistingAccounts` provider onto another provider's SSO user
  (`email_exists`; Supabase would create a separate account). The reason is offboarding: an
  account a company's identity provider manages must lose access when the provider disables it,
  and a personal OAuth login linked to it would outlive that. Okta, WorkOS, Clerk and Auth0
  Organizations enforce the same rule. Linking still works from an SSO session, so the user keeps
  the provider's tokens for API access; the linked identity only can't sign in.
- **`/auth/v1` mail templates take GoTrue's placeholders only.** `GOTRUE_MAILER_TEMPLATES_*`
  are fetched and rendered with `{{ .ConfirmationURL }}`, `{{ .Token }}`, `{{ .TokenHash }}`,
  `{{ .SiteURL }}`, `{{ .Email }}`, `{{ .NewEmail }}` and `{{ .RedirectTo }}`; a template with any
  other Go template action (`{{ if }}`, `{{ .Data }}`) gets the built-in one instead. SMTP needs
  TLS (implicit on 465, else STARTTLS), where GoTrue falls back to plaintext when the server
  offers no STARTTLS.
- **`/auth/v1` `logout?scope=global` also ends denextAuth cookie sessions.** GoTrue's global
  logout ends the user's token sessions; denext ends their cookie sessions too (stateless ones
  through `sessionsValidAfter`), and `scope=others` ends every cookie session while keeping the
  caller's token session — "sign out everywhere" covers every surface that signed the user in.
- **`/auth/v1/verify` still redeems on GET.** denext's own `magicLink()` opens a confirmation
  page by default, but the GoTrue-compatible `GET /auth/v1/verify` link keeps Supabase's
  behaviour (the link verifies and redirects), because that is the supabase-js contract: a mail
  scanner that pre-fetches it can spend it, as on Supabase. Use `verifyOtp({ token_hash })` from
  a page of your own to put a click in front of it.
- **A magic link, one-time code or recovery link that first confirms an account retires its
  password.** Supabase keeps a password set by an earlier unconfirmed sign-up; denext keeps only
  the one the account's own sign-up confirmation proves.

## `next-auth` (Auth.js v5)

The `next-auth` shim maps Auth.js onto `denextAuth`, which keeps its own, stricter defaults. Each
place it behaves differently from Auth.js:

- **CSRF is checked twice.** A `signin`, `signout`, credentials-callback or `session` POST needs
  Auth.js's double-submit `csrfToken` and must also pass denext's same-origin check (an `Origin`
  or `Referer` matching `AUTH_URL`, or the `Host` without one). A cross-origin POST carrying a
  valid token is refused (`403`); Auth.js accepts it.
- **`AUTH_URL` is required in production.** denext never derives the OAuth `redirect_uri` or its
  origin checks from the `Host` header, so `trustHost` / `AUTH_TRUST_HOST` don't stand in for
  it. Without `AUTH_URL` (or `NEXTAUTH_URL`) `NextAuth()` throws when serving in production.
- **Over plain http the cookies lose their `__Host-` prefix** on a loopback host, and on any host
  outside production, as `denextAuth`'s do (a browser refuses a `__Host-` cookie over http, even
  on `localhost`). Auth.js drops its `__Secure-` prefix on any http origin; denext keeps
  `__Host-` (so no session) for production http on another host, and over https.
- **`AUTH_SECRET` must be at least 32 characters in production** (`npx auth secret` makes 44).
- **Redirects stay on the origin.** The `redirect` callback runs, but whatever it returns is
  kept to a same-origin path: a callback that allows another origin lands on `/` instead.
- **Every OAuth flow uses `state` and PKCE** (and `nonce` for OIDC); a provider's `checks` are
  ignored.
- **The session cookie is denext's** (`__Host-denext_auth`, signed, `SameSite=Lax`; unprefixed
  `denext_auth` over plain http, see below), not `authjs.session-token`; `cookies` and `useSecureCookies` are ignored. A token is sealed with
  AES-256-GCM inside it, in denext's own format: `next-auth/jwt`'s `encode` / `decode` don't read
  an Auth.js JWE (and `jwt.encode` / `jwt.decode` overrides are ignored). The cookie is not
  chunked, so a token near 4 KB fails to set.
- **Sessions have an absolute lifetime:** `session.maxLifetime`, 30 days after sign-in by default,
  however often `updateAge` slides them. Auth.js extends an active session forever.
- **Credentials sign-ins are rate limited** (per address and identifier) and answered with one
  generic refusal; Auth.js has no limits. A thrown `CredentialsSignin` subclass's `code` is not
  passed through: the error is always `CredentialsSignin` with `code=credentials`.
- **`callbacks.signIn` returning a URL refuses the sign-in** and lands on the sign-in page with
  `error=AccessDenied` (or `CredentialsSignin`), instead of redirecting to that URL.
- **An email link opens a confirmation page by default**, so a mail scanner can't spend it;
  `Resend({ confirm: false })` / `Nodemailer({ confirm: false })` signs in on the GET as Auth.js
  does. `callbacks.signIn` runs once, when the link is redeemed (not at the send with
  `email.verificationRequest`).
- **Account linking follows denext's rules:** an OAuth account is linked to an existing user by
  email only when both addresses are verified, unless the provider sets
  `allowDangerousEmailAccountLinking`.
- **The `session` endpoint and `auth()` also run `callbacks.jwt`** on every read, as Auth.js does;
  a changed token is written back only where the response is still open (the `session` endpoint,
  middleware, `auth(handler)` and `unstable_update()`), never from a plain `auth()` call.
- **`session.user` includes `id`** (the token's `sub`, or the user's id).
- **The built-in pages are plain HTML** (no `theme`), and their `?error=` codes are Auth.js's.

## Security posture — safe defaults

Deliberate **safe defaults** that differ from Next's, each with a one-line
opt-in — documented, not surprises. Full checklist in [the deployment guide](https://denext.dev/docs/deploy).

- **`denextAuth`'s cookies follow the transport.** They are `__Host-` (with `Secure`) over https.
  Over plain http, where a browser refuses `__Host-` even on `localhost`, they are plain
  (`denext_auth`, `denext_auth_tx`) on a loopback host and, outside production, on any host — so
  `denext dev` on `http://localhost` holds a session. Production over http on another host keeps
  `__Host-` and so gets no session: a session cookie never travels in clear text there.
- **Strict CSP by default** blocks external `<script>`/stylesheet/`<img>` until
  opted in per route (`csp: "strict" | "off" | {…}`; a route's `csp` export
  overrides). Applies to buffered **and** streamed/PPR responses.
- **Metadata URLs without `metadataBase` are never built on `localhost` or the `Host`
  header in a cacheable page.** Next.js resolves file-convention metadata (`opengraph-image`'s
  `og:image`) against `metadataBase` and falls back to `http://localhost:<port>` (or
  `VERCEL_URL`). denext uses `canonicalOrigin`, then `metadataBase`; with neither, a page that
  may be cached (ISR, `force-static`, a static export) keeps `og:image` relative and omits
  hreflang / canonical, and a per-request page uses the request's origin and is sent `no-store`.
  Set `canonicalOrigin` or `metadataBase` for absolute URLs everywhere.
- **HSTS is host-only by default** (no `includeSubDomains`/`preload`) so it
  can't brick non-HTTPS sibling subdomains. Strengthen via `hsts`, or
  `hsts: false`.
- **Session cookie isn't `__Host-`-locked by default** (would log everyone out
  on upgrade). Opt in with `hostPrefix: true` on `getSession`.
- **`denextAuth` sessions are stateless by default.** With an adapter they are still ended
  early per user (`revokeAllSessions`, a password reset, a ban: the user's
  `sessionsValidAfter`); to revoke one device's session (`revokeSession`), opt in to
  server-side sessions with `sessionStore` (`inMemorySessionStore()` / `sqliteSessionStore()`
  or your own). **Configuring an `AuthAdapter` does not change
  this** — an adapter is a persistence port (users, accounts, tokens), not a session
  mechanism; `session: { strategy: "database" }` is the switch.
- **Multi-tenant Microsoft Entra ignores an unverified address.** Auth.js's Microsoft Entra
  provider keys the account on `sub` and takes the token's `email`, which any tenant's admin can
  set. With `tenant: "common" | "organizations" | "consumers"`, denext keys the account on
  `tid` + `oid` and keeps the email only when the optional claim `xms_edov` is `true` (add it in
  the app registration); otherwise the account has no email, so it can't occupy or link an
  address.
- **`denextAuth` account linking refuses unverified-email matches**, where Auth.js links
  an OAuth account to an existing user on a bare email match. denext links only when the
  provider's email is verified _and_ the local account's email is verified; anything else
  is `?error=account_not_linked` unless the provider opts in with
  `allowDangerousEmailAccountLinking`. The default costs a support ticket; the alternative
  costs an account takeover from any IdP that will mint a token for an unverified address.
- **`magicLink()` / `emailOtp()` are not next-auth's Email provider.** There is no
  nodemailer `server` option — you pass `sendVerificationRequest`, e.g. `smtpMailer({ host,
  user, pass, from })`, which refuses to send without TLS — and a one-time-code mode
  (`emailOtp()`) sits next to the link.
  Link tokens are stored as a SHA-256 and codes as an HMAC keyed by the auth `secret`;
  `allowSignUp: false` refuses unknown addresses; a known address, an unknown one and a list
  (which sends nothing) all get the identical answer; and the redeem is
  `{basePath}/callback/:provider`, not a route of its own. As in Auth.js, an email sign-in
  writes no account row — the address on the user record is the identity — but a first
  email sign-in into an account whose address was never verified first retires the
  password, TOTP factor, bearer tokens and server-side sessions set up without that proof
  (pre-account hijacking), which Auth.js does not do. A magic link opens a confirmation page
  whose button spends it, where Auth.js signs in on the GET (`magicLink({ confirm: false })`
  restores that).
- **`id_token` audience validation is strict by default** (`strictAudience`): OIDC Core
  §3.1.3.7 steps 3–5 — a single `aud` must _be_ this client, a multi-valued `aud` needs an
  `azp` naming this client, and a foreign `azp` is refused. Auth.js accepts plain `aud`
  membership. Set `strictAudience: false` for an IdP that legitimately mints multi-audience
  tokens without an `azp`.
- **The credentials rate limiter keys on the socket peer, not `x-forwarded-for`, unless
  `trustForwardedHeaders: true`.** Behind a proxy without that flag every client shares
  one IP key, so the limit is effectively per account (an attacker can lock an account
  they know the email of for one window); set the flag when a proxy fronts the app, or name
  the proxy's client-address header with `rateLimitHeader`.
- **Graceful shutdown drains up to a deadline** (default 10s;
  `DENEXT_SHUTDOWN_DRAIN_MS`), then force-exits so a stuck client can't pin the
  process (the `services/` stop, plugin teardowns and `instrumentation.ts`'s `onShutdown()` are
  skipped on a forced exit).
- **Scaffolded `dev`/`build` tasks use `-A`** (they compile/spawn tooling); the
  generated `start` task runs least-privilege and spawns nothing (no `--allow-run`).
- **`@denext/og` fetches a missing non-Latin font from `fonts.googleapis.com`**
  at render time — supply a local `fonts` option, or set `offline: true` on the
  `ImageResponse` to refuse the fetch (it raises a clear error instead of
  egressing).
- **The public-env island ships only _referenced_ prefixed vars.** A key read
  via a computed expression can't be detected — force-include it via
  `publicEnv: [...]`. Never give a secret a public prefix.
- **Pages Router Preview Mode signs its cookie with `DENEXT_PREVIEW_SECRET`.**
  Set it to a long random value in production (comma-separated to rotate).
  Without it a random per-process key is used, so preview sessions don't survive
  a restart or span instances (a one-time warning fires). A forged/unsigned
  preview cookie is ignored — it never discloses drafts.
