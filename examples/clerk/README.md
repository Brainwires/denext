# examples/clerk — Clerk on denext: the web and Deno Desktop, written once

One Next.js-style app, written the way Clerk's Next.js quickstart writes it, that signs in with
[Clerk](https://clerk.com) on the web and in a Deno Desktop window, with tests against a Clerk
development instance in test mode. What runs where:

- `middleware.ts` — `clerkMiddleware()` with `createRouteMatcher`, from `@clerk/nextjs/server`;
- `app/layout.tsx` — `<ClerkProvider>` from `@clerk/nextjs`, with `<Show>`, `<SignInButton>` and
  `<UserButton>` in the header;
- `app/protected/page.tsx` — a static page whose content (`ProtectedContent` in
  `app/account-panel.tsx`) runs in the browser, so it is also in the export the Capacitor shell and
  the Deno Desktop window load: signed out it offers Clerk's sign-in modal, signed in it shows the
  user and the server's verdict on the session token from `GET /api/me`;
- `app/api/me/route.ts` — a `defineApi` route whose user id comes from the verified session token
  (`auth()`); signed out, it answers 401;
- `desktop/preload.ts` — the same `<ClerkProvider>` in a Deno Desktop window, through
  `installClerkDesktopBridge` from `denext/desktop/clerk`.

Clerk now prints a deprecation notice for `createRouteMatcher` (it recommends checking at the
resource): the example does both — the matcher in `middleware.ts` (which keeps signed-out browsers
off `/protected` on the web), and `auth()` in the route the protected page calls.

`@clerk/nextjs` runs unchanged: denext's compat pipeline aliases its `next/*` and `react` imports to
denext, renders its `"use client"` components as islands and serves its `"use server"` action.
Nothing here imports `next` itself.

## What each surface supports

| Sign-in                        | Web                                         | Deno Desktop (pinned runtime)                                                                                      | Capacitor shell                                                  |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Email + code                   | yes (keyed e2e)                             | yes                                                                                                                | yes (on-device check)                                            |
| Email + password               | yes (keyed e2e)                             | yes                                                                                                                | yes                                                              |
| Google / GitHub (OAuth)        | yes (manual check)                          | yes: macOS `ASWebAuthenticationSession`; Windows / Linux the system browser with a Cancel overlay (manual check)   | yes: iOS `ASWebAuthenticationSession`, Android Custom Tab        |
| Passkey                        | yes, on HTTPS or `localhost` (manual check) | through Clerk's hosted pages in the browser sheet (a development instance); native with your own RP (manual check) | through Clerk's hosted page in the auth session                  |
| Sign-out                       | yes (keyed e2e)                             | yes                                                                                                                | yes                                                              |
| Session kept across a relaunch | the cookie                                  | the client JWT in the OS keychain (`secure-store`)                                                                 | the client JWT in the Keychain / Keystore                        |
| Protected page / API           | cookie session                              | `Authorization: Bearer` session token (the window's `/api/*` is proxied to the web server)                         | `Authorization: Bearer` to `NEXT_PUBLIC_CLERK_API_ORIGIN` (CORS) |

Every Deno Desktop row needs dashboard step 3 (allowed origins). `deno task test:desktop` automates
email code, the relaunch and sign-out once it is set.

The Capacitor column needs dashboard steps 2 and 3 (the redirect and the shell's origins) and has
not been run on a device yet (README → Capacitor).

## Setup

1. `cd examples/clerk && deno install` (npm: `@clerk/nextjs`, `@clerk/electron`; Deno also installs
   their `next` / `react` peers, which denext aliases away).
2. Create a Clerk application (a development instance) and copy `.env.example` to `.env.local` with
   its keys. `.env` and `.env.local` are git-ignored; never commit keys. Without keys the app shows
   a setup screen. Optionally add `CLERK_JWT_KEY` (the dashboard's JWT public key, PEM): the
   middleware then verifies session tokens without a network call.
3. `deno task dev` → <http://localhost:3000>.

`deno task build && deno task start` is the production server. The keys are read from the
environment or `.env` / `.env.local` here; only `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` reaches the
page.

## Clerk dashboard

For the web on `localhost` a new development instance needs nothing. For the rest:

1. **Sign-in methods** (Configure → User & authentication): enable _Email address_ with _Email
   verification code_ and _Password_, the _Google_ and _GitHub_ social connections, and _Passkeys_.
2. **Native redirect** (Configure → Native applications → _Allowlist for mobile SSO redirect_): add
   `denextclerk://app/` — where Google / GitHub return to the desktop app.
3. **Allowed origins — required for the desktop and mobile apps** (Backend API only, no dashboard
   field). In the window clerk-js sends its client JWT as `Authorization` and the WebView adds
   `Origin`; the Frontend API refuses a request carrying both ("Setting both the 'Origin' and
   'Authorization' headers is forbidden") unless the origin is allowed. Add `denextclerk://app` (and
   anything else you need):

   ```sh
   curl -X PATCH https://api.clerk.com/v1/instance \
     -H "Authorization: Bearer $CLERK_SECRET_KEY" -H "Content-Type: application/json" \
     -d '{"allowed_origins": ["denextclerk://app", "capacitor://localhost", "https://localhost"]}'
   ```

   (`allowed_origins` replaces the list: include every origin you need. Read it back with
   `GET /v1/instance`.) A development instance accepts the web app on any host — `localhost` and
   your `*.ts.net` name — without an entry.
4. **Passkeys and the RP ID.** On a development instance a passkey belongs to the host the page ran
   on: one created on `localhost` works only on `localhost`, one created on your `*.ts.net` host
   only there, and one created in the hosted Account Portal (`*.accounts.dev`) only there. A desktop
   build cannot be entitled for Clerk's domains, so on desktop a passkey sign-in continues in the
   browser sheet on the hosted pages. With a production instance on your own domain, list that RP in
   `DENEXT_CLERK_PASSKEY_RP_IDS` when packaging, entitle the app (`webcredentials:<rp-id>`) and
   serve the `apple-app-site-association` for it (see the
   [desktop docs](https://denext.dev/docs/desktop#desktop-clerk)).

The automated tests use **test mode**, on by default in a development instance: an address with the
`+clerk_test` subaddress (`jane+clerk_test@example.com`) verifies with the code `424242` and gets no
email, and phone numbers `+1 (XXX) 555-0100` to `555-0199` the same.

## Other devices over Tailscale

Clerk (cookies, passkeys) and the browser's secure-context APIs need HTTPS off `localhost`, so serve
the dev server on your Mac's MagicDNS name with `tailscale serve`:

```sh
# on the Mac
echo "DENEXT_CLERK_DEV_HOST=mac.tail1234.ts.net" >> .env.local   # your machine's name
deno task dev                       # http://localhost:3000
tailscale serve --bg 3000           # https://mac.tail1234.ts.net → localhost:3000
```

`DENEXT_CLERK_DEV_HOST` adds the name to `allowedDevOrigins`: without it the dev server answers a
non-loopback `Host` with HTML only (its assets are loopback-only by default). Then, from any device
on the tailnet:

- **iPhone / Android browser, Windows, Linux:** open `https://mac.tail1234.ts.net`. Email code,
  password and OAuth work as on the Mac; a passkey made there belongs to that host (step 4 above).
- **Deno Desktop on Windows / Linux:** package on that machine (`deno task desktop:package`) and
  launch it with `DENEXT_CLERK_API_ORIGIN=https://mac.tail1234.ts.net`: the window's `/api/*` goes
  to the Mac.
- **Capacitor shell:** build it with `NEXT_PUBLIC_CLERK_API_ORIGIN=https://mac.tail1234.ts.net`
  (README → Capacitor): the app's pages are its own, its API calls go to the Mac.

Without Tailscale, `deno task dev:lan` serves on the LAN (plain HTTP: email code and password work
from other devices; passkeys and some Clerk features need HTTPS).

## Deno Desktop

```sh
deno task build && deno task start   # the API the window calls (http://127.0.0.1:3000)
DENEXT_APP_NAME=ClerkExample deno task desktop:package   # dist/ClerkExample.app (macOS)
open dist/ClerkExample.app
```

The packaged app is what the desktop e2e drives. Its `/api/*` goes to `DENEXT_CLERK_API_ORIGIN`
(default `http://127.0.0.1:3000`; a non-loopback origin, like the Mac's `https://*.ts.net` name from
another machine, is allowed explicitly).

- `desktop.app.origin: "denextclerk://app"` is the page origin Clerk sees (step 3), and
  `deepLinks: ["denextclerk"]` brings Google / GitHub back (step 2).
- `desktop/preload.ts` installs the bridge **synchronously** (no `await` before
  `installClerkDesktopBridge`): it must read its per-launch key while the preload runs, and clerk-js
  must find it when it loads. `nativeClerk` switches the clerk-js instance `<ClerkProvider>` loads
  into native mode — the client JWT in the keychain (`secure-store`), so the session survives a
  relaunch; no cookies; OAuth through the OS.
- When another app handles `denextclerk:` links (another build of this example, say), macOS still
  signs in through its sheet; on Windows and Linux the sign-in is refused with a message, and the
  home page offers **Make this app the handler** (`claimDeepLinkScheme`, on your click).

## Capacitor (iOS / Android)

The same app in the Capacitor shell: `instrumentation-client.ts` calls
`installClerkMobileBridge({ scheme: "denextclerk", nativeClerk: true })` from `denext/mobile/clerk`,
so `<ClerkProvider>` signs in natively — the client JWT in the Keychain / Keystore, Google / GitHub
in the OS's auth session back to `denextclerk://app/`, passkeys through Clerk's hosted page. The
shell serves the static export itself (`capacitor://localhost` on iOS, `https://localhost` on
Android), so `/api/*` calls go to `NEXT_PUBLIC_CLERK_API_ORIGIN` with a bearer token, and the
server's `cors` lets those origins in.

```sh
deno install
# The API the app calls: the Mac over Tailscale (tailscale serve --bg 3000 + deno task start).
echo "NEXT_PUBLIC_CLERK_API_ORIGIN=https://mac.tail1234.ts.net" >> .env.local
deno run -A --node-modules-dir=none ../../cli.ts export .
./node_modules/.bin/cap add ios                                     # once (and/or android)
deno run -A --node-modules-dir=none ../../cli.ts mobile add clerk --scheme denextclerk  # + cap sync
cd ios/App && xcodebuild -scheme App -sdk iphoneos -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath ../build \
  DEVELOPMENT_TEAM=<your team id> -allowProvisioningUpdates build
xcrun devicectl device install app --device <device id> ../build/Build/Products/Debug-iphoneos/App.app
```

`deno task mobile:export` repeats the export + `cap sync` after an edit. Clerk side: dashboard step
2 (`denextclerk://app/`) and step 3 (`capacitor://localhost`, `https://localhost`).

## Tests

- `tests/clerk-example.test.ts` (unit, every CI run, no keys): the config (CSP, desktop origin, deep
  links, passkey RP pinning, the preload), the setup screen, the Frontend API host decoding.
- `tests/e2e/clerk.e2e.test.ts` (keyed, web): creates a `+clerk_test` user through the Backend API,
  signs in with the code `424242` and with the password in headless Chromium against `denext start`
  and against `denext dev`, calls `/api/me`, loads the protected page (it shows the email and a 200
  from `/api/me`), signs out, refuses a forged token, and deletes the user. It reads
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` (or `CLERK_TEST_*`, the CI secret names)
  from the environment or `.env` / `.env.local`, and is skipped without them:

  ```sh
  deno test -A tests/e2e/clerk.e2e.test.ts      # from the repo root
  ```
- `tests/e2e/clerk-keyless.e2e.test.ts` (no Clerk account): session tokens signed with a local key
  (`CLERK_JWT_KEY`) — valid ones pass, missing / expired / tampered / foreign ones get 401 — the
  middleware turning a signed-out browser away from `/protected`, and `denext export` writing
  `out/protected/index.html`.
- `e2e/desktop-test.ts` (keyed, desktop): packages the app, launches it, signs in with the code in
  the real window, calls `/api/me` through the proxy, relaunches and checks the session survived
  (the keychain), signs out. Skipped until the instance allows `denextclerk://app` (step 3). It
  passes on Linux (WebKitGTK) and macOS:

  ```sh
  deno task test:desktop                        # from examples/clerk, in a logged-in session
  # Linux, headless: a display and an unlocked Secret Service (needs secret-tool, libsecret-tools)
  sh ../desktop-kitchen-sink/e2e/linux-session.sh deno task test:desktop
  ```

### Manual checks (no automation can do these)

Real Google / GitHub accounts and a person at the fingerprint reader:

1. Web: sign in with Google, then GitHub; `/protected` shows your email.
2. Web on `https://<mac>.ts.net` (phone): create a passkey (UserButton → Manage account → Security),
   sign out, sign in with it.
3. Desktop, macOS: Google sign-in opens the system sheet and returns signed in; quit and relaunch —
   still signed in.
4. Desktop, Windows / Linux: Google sign-in in the system browser; the Cancel overlay cancels; with
   another app handling `denextclerk:`, the sign-in is refused and "Make this app the handler" fixes
   it.
5. Desktop passkey: the sign-in continues in the browser sheet on Clerk's hosted page (development
   instance), or natively with a production RP set up as above.
6. iPhone / Android app: email code, Google, a passkey (hosted page), quit and relaunch (still
   signed in), `/api/me`, sign-out.
