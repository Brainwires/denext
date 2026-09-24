import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Desktop & mobile",
  description:
    "Ship a denext app as a native desktop app (a signed/notarized macOS .app, a Linux bundle, a Windows zip) with the denext desktop command, and as an iOS/Android Capacitor app with denext/mobile and over-the-air UI updates.",
};

export default function Desktop() {
  return (
    <DocsShell
      active="desktop"
      title="Desktop & mobile"
      lead="denext exports a self-contained static app, and deno desktop wraps it in a native window and compiles it to a single binary. The denext desktop verb drives it — run to open a dev window, build to export, and package to produce a distributable bundle: a macOS .app (code-signed and, with a Developer ID identity and notarytool credentials, notarized + stapled) or a Linux bundle (.tar.gz, plus an AppImage when appimagetool is present). Windows packages to a zip via denext desktop package --target-os windows (Authenticode-signed when DENEXT_WINDOWS_CERT is set). The same export ships in a Capacitor iOS/Android shell, driven by denext/mobile, and can update its UI over the air (signed manifests) without a new app build."
    >
      <h2>The desktop target</h2>
      <p>
        Scaffold with the desktop target (<code>denext create --desktop</code>, or add it to an
        existing project) and you get a <code>desktop.ts</code> entry, a <code>desktop</code>{" "}
        block in <code>deno.json</code>, an <code>icons/</code>{" "}
        folder, and the packaging scripts (<code>scripts/package-macos.ts</code> and{" "}
        <code>scripts/package-linux.ts</code>). Drive it all with the <code>denext desktop</code>
        {" "}
        verb:
      </p>
      <ul>
        <li>
          <code>denext desktop run</code> — export and open the app in a native window (dev).
        </li>
        <li>
          <code>denext desktop build</code> — export the app to <code>out/</code>{" "}
          (what the window serves).
        </li>
        <li>
          <code>denext desktop package</code>{" "}
          — build a distributable bundle for the host OS (macOS or Linux);{" "}
          <code>--target-os linux</code>{" "}
          cross-builds the Linux bundle from any OS. It runs the matching{" "}
          <code>scripts/package-*.ts</code>: export, build (embedding{" "}
          <code>out/</code>), and — on macOS — code-sign into <code>dist/</code>.
        </li>
      </ul>
      <p>
        The scaffolded <code>deno task desktop</code> / <code>deno task desktop:package</code> (and
        {" "}
        <code>desktop:package:linux</code>) tasks still work and wrap the same scripts; the verbs
        above are the first-class equivalents.
      </p>
      <p>
        The generated <code>desktop.ts</code>{" "}
        is a thin call to denext's desktop runtime — the serve + window plumbing lives in{" "}
        <code>denext/desktop</code>, so a fix reaches every app:
      </p>
      <Code lang="tsx">
        {`import { runDesktop } from "denext/desktop";
import config from "./denext.config.ts";

await runDesktop({ importMetaUrl: import.meta.url, proxy: config.spa?.proxy });`}
      </Code>
      <Callout kind="note">
        <code>runDesktop</code> serves the static export (with a history-API fallback and{" "}
        <code>no-store</code>{" "}
        caching so a repackaged app never serves a stale bundle), optionally reverse-proxies a
        backend (<a href="/docs/spa">
          <code>spa.proxy</code>
        </a>), and quits the whole app when its window is closed (the macOS red button /{" "}
        <kbd>⌘W</kbd>). <code>deno desktop</code> only auto-exits when no windows are open{" "}
        <em>and</em>{" "}
        there are no live async tasks — and the server is always live — so the runtime adopts the
        window via <code>Deno.BrowserWindow</code> and calls <code>Deno.exit(0)</code> on its{" "}
        <code>close</code> event. Pass <code>onRequest</code>{" "}
        to intercept requests before the default serve/proxy.
      </Callout>
      <Callout kind="note">
        For a migrated SPA (Vite/CRA), package with the generated <code>deno task desktop</code>
        {" "}
        rather than a bare <code>deno desktop desktop.ts</code> — it bakes the required flags:{" "}
        <code>--include out</code>, <code>--allow-net --allow-read --allow-env</code>,{" "}
        <code>--exclude-unused-npm</code>, and (for a pnpm/yarn app pinning{" "}
        <code>nodeModulesDir: "manual"</code>) <code>--node-modules-dir=none</code>{" "}
        so the runtime's own npm dep resolves from Deno's global cache.{" "}
        <code>denext migrate --desktop</code> writes that task for you.
      </Callout>

      <h2>Building for one or more architectures (macOS)</h2>
      <p>
        macOS runs on Apple Silicon (<code>arm64</code>) and Intel (<code>
          x86_64
        </code>). <code>deno desktop</code>{" "}
        builds one architecture at a time and can cross-compile, so the packaging script exposes an
        {" "}
        <code>--arch</code>{" "}
        flag. Pass it (and the other packaging flags) straight to the scaffolded task, or forward it
        to the verb after a literal <code>--</code>:
      </p>
      <Code lang="bash">
        {`# the machine's own architecture (default)
denext desktop package

# a specific architecture (cross-compiles if needed)
deno task desktop:package --arch arm64
deno task desktop:package --arch x86_64

# both, as two separate .app bundles
deno task desktop:package --arch both

# one universal .app whose binaries are lipo-merged (runs natively on both)
deno task desktop:package --arch universal
# …the same, forwarded through the verb:
denext desktop package -- --arch universal`}
      </Code>
      <p>
        A universal bundle is built by compiling both architectures and merging each Mach-O binary
        with{" "}
        <code>lipo</code>; the merged bundle is then re-signed (merging invalidates the previous
        signature). Everything lands in <code>dist/</code>. Pass <code>--dmg</code>{" "}
        to also wrap each
        <code>.app</code> in a <code>.dmg</code>, and <code>--no-export</code> to reuse an existing
        {" "}
        <code>out/</code>.
      </p>

      <h2>Code signing</h2>
      <p>
        By default the bundle is <strong>ad-hoc</strong> signed (the <code>-</code>{" "}
        identity): it runs on your machine, but Gatekeeper blocks it on other Macs. To distribute,
        sign with a
        <strong>Developer ID Application</strong>{" "}
        certificate. This is a specific certificate type — not the <em>Apple Development</em>{" "}
        certificate Xcode creates for on-device testing, and being signed into Xcode does not make
        the tooling use it automatically.
      </p>
      <Callout kind="warn">
        You need a <strong>Developer ID Application</strong>{" "}
        certificate, issued from a paid Apple Developer account (you must be the Account Holder or
        an Admin). Create it in{" "}
        <strong>
          Xcode → Settings → Accounts → your team → Manage Certificates → + → Developer ID
          Application
        </strong>{" "}
        (or on developer.apple.com). Confirm it is installed with{" "}
        <code>security find-identity -p codesigning -v</code>.
      </Callout>
      <p>
        Point the packaging script at it with an environment variable — no secret is written into
        the repo:
      </p>
      <Code lang="bash">
        {`export DENEXT_CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
deno task desktop:package --arch universal`}
      </Code>
      <p>
        With a real identity the bundle is signed inside-out with the Hardened Runtime and a secure
        timestamp (both required for notarization). Provide a custom entitlements plist with{" "}
        <code>DENEXT_ENTITLEMENTS=/path/to/entitlements.plist</code>{" "}
        if your app needs specific capabilities.
      </p>
      <h3>
        Set up signing from <code>denext ui</code>
      </h3>
      <p>
        You do not have to know the identity string. The{" "}
        <a href="/docs/ui#desktop">Desktop panel</a> of <code>denext ui</code>{" "}
        lists the Developer ID Application identities actually in your keychain (and only those — an
        {" "}
        <em>Apple Development</em> certificate is filtered out on purpose), shows which{" "}
        <code>DENEXT_*</code> variables are already set, and composes the{" "}
        <code>denext desktop package</code>{" "}
        invocation with one copy-paste line per variable still unset — for the identity, a
        shell-quoted{" "}
        <code>export DENEXT_CODESIGN_IDENTITY='Developer ID Application: Your Name (TEAMID)'</code>.
        It runs no build and writes no file, and it never reads{" "}
        <code>DENEXT_WINDOWS_CERT_PASSWORD</code>, only whether it is set.
      </p>

      <h2>Notarization</h2>
      <p>
        Notarization is a separate step: Apple scans the signed bundle and issues a ticket that you
        staple into the app so it opens without a warning offline. First store your notary
        credentials once in a keychain profile:
      </p>
      <Code lang="bash">
        {`xcrun notarytool store-credentials "denext-notary" \\
  --apple-id "you@example.com" \\
  --team-id  "TEAMID" \\
  --password "app-specific-password"   # from appleid.apple.com`}
      </Code>
      <p>
        Then set the profile name; the script submits the bundle, waits for the result, and staples
        the ticket:
      </p>
      <Code lang="bash">
        {`export DENEXT_CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export DENEXT_NOTARY_PROFILE="denext-notary"
deno task desktop:package --arch universal --dmg`}
      </Code>
      <p>
        The resulting <code>.app</code> (and <code>.dmg</code>) in <code>dist/</code>{" "}
        is signed, notarized, and stapled — ready to distribute.
      </p>

      <h2>Linux</h2>
      <p>
        <code>denext desktop package</code> on a Linux host (or <code>--target-os linux</code>{" "}
        from any OS) runs <code>scripts/package-linux.ts</code>. <code>deno desktop</code>{" "}
        produces a complete bundle directory — the executable, its{" "}
        <code>.so</code>, and a freedesktop <code>.desktop</code>{" "}
        launcher — which the script wraps as a <code>.tar.gz</code> per architecture (and an{" "}
        <code>AppImage</code> when <code>appimagetool</code> is on{" "}
        <code>PATH</code>). It cross-builds from any OS and takes an{" "}
        <code>--arch host|x86_64|arm64|both</code>{" "}
        flag, so the same distribution flow works from a Mac or in CI:
      </p>
      <Code lang="bash">
        {`# host arch (default); on macOS this cross-builds a Linux bundle
denext desktop package --target-os linux

# both Linux arches, with an AppImage each
deno task desktop:package:linux --arch both --appimage`}
      </Code>
      <Callout kind="note">
        The end user's Linux desktop needs a <strong>WebKitGTK</strong> runtime (<code>
          webkit2gtk
        </code>) installed for the window — that's a deploy-environment dependency, not baked into
        the bundle. There is no code-signing/notarization step on Linux.
      </Callout>

      <h2>Mobile (Capacitor)</h2>
      <p>
        The same app ships to iOS and Android through{" "}
        <a href="https://capacitorjs.com">Capacitor</a>{" "}
        — like the desktop target, it serves denext's static export (<code>
          deno task export
        </code>{" "}
        → <code>out/</code>). Scaffold both native targets up front:
      </p>
      <Code lang="bash">
        {`deno run -A jsr:@denext/denext/cli create my-app --desktop --capacitor`}
      </Code>
      <p>
        You get a <code>capacitor.config.ts</code> that bundles the export (<code>
          webDir: "out"
        </code>) into the native iOS/Android shells, a <code>package.json</code>{" "}
        pinning Capacitor 8 (<code>^8.5.2</code>), plus the <code>mobile:*</code>{" "}
        tasks. Add each platform once, then sync after every change:
      </p>
      <Code lang="bash">
        {`deno install                # Capacitor's CLI + platforms are npm packages
deno run -A --node-modules-dir npm:@capacitor/cli@^8.5.2 add ios       # once
deno run -A --node-modules-dir npm:@capacitor/cli@^8.5.2 add android   # once
deno task mobile:sync       # export, then copy out/ into the native projects
deno task mobile:ios        # open in Xcode
deno task mobile:android    # open in Android Studio`}
      </Code>
      <p>
        Commit <code>ios/</code> and{" "}
        <code>android/</code>: Capacitor 8 builds iOS with Swift Package Manager, and the native
        projects are yours to edit. The scaffolded <code>.gitignore</code>{" "}
        ignores only their build outputs and the web assets <code>mobile:sync</code>{" "}
        copies in; Capacitor's own generated <code>.gitignore</code>{" "}
        files cover the rest. The webview loads files straight from the app bundle, so the export
        ships no precompressed <code>.gz</code>{" "}
        siblings — the App Router export never writes them, and a SPA-mode app turns them off with
        {" "}
        <code>{"spa: { precompress: false }"}</code>.
      </p>
      <Callout kind="note">
        A complete project wired for web + desktop + mobile is{" "}
        <a href="https://github.com/Brainwires/denext/tree/main/examples/native">
          <code>examples/native</code>
        </a>. Native builds are experimental, and the mobile targets need the platform toolchains
        installed (Xcode for iOS, Android Studio for Android).
      </Callout>

      <h3>
        The <code>denext/mobile</code> runtime
      </h3>
      <p>
        A webview inside a native shell needs a few things a browser tab doesn't: knowing it is in
        the shell, recovering when the app returns from the background, opening links outside the
        webview, a swipe-back gesture, and room for the notch and home indicator.{" "}
        <code>denext/mobile</code> is a small client runtime for exactly that — import it from{" "}
        <code>"use client"</code> modules (add <code>denext/mobile</code> to <code>deno.json</code>
        's <code>imports</code> next to your other <code>denext/*</code> entries):
      </p>
      <Code lang="tsx">
        {`"use client";
import { useRouter } from "denext";
import { isNativeShell, openExternal, useAppResume, useBackSwipe } from "denext/mobile";

export function Shell({ children }: { children: unknown }) {
  const router = useRouter();
  // Time away decides: under 10 s the connection is likely alive — probe it;
  // 10 s or more, reconnect and refetch. (probe/reconnect are your app's own.)
  useAppResume((awayMs) => (awayMs < 10_000 ? probe() : reconnect()));
  const swipeRef = useBackSwipe(() => router.back(), { enabled: isNativeShell() });
  return (
    <main ref={swipeRef} style={{ touchAction: "pan-y" }}>
      <button type="button" onClick={() => openExternal("https://denext.dev/docs")}>Docs</button>
      {children}
    </main>
  );
}`}
      </Code>
      <ul>
        <li>
          <code>isNativeShell()</code> / <code>nativePlatform()</code>{" "}
          — whether the page runs in the shell, and which one (<code>"ios"</code>,{" "}
          <code>"android"</code> or <code>"web"</code>).
        </li>
        <li>
          <code>useAppResume(cb)</code> (or <code>onAppResume</code> outside components) — calls
          {" "}
          <code>cb(awayMs)</code>{" "}
          when the app returns to the foreground, with the time it spent in the background.
        </li>
        <li>
          <code>openExternal(url)</code>{" "}
          — opens the in-app browser through Capacitor's native Browser plugin, else{" "}
          <code>window.open</code> with <code>noopener</code>. Only http(s), <code>mailto:</code>
          {" "}
          and <code>tel:</code> URLs are allowed.
        </li>
        <li>
          <code>useBackSwipe(onBack)</code>{" "}
          — returns a ref callback; a rightward swipe of at least 72 px, at least 1.4× as horizontal
          as vertical, calls{" "}
          <code>onBack</code>. It yields to text editing and horizontal scrollers. Give the element
          {" "}
          <code>touch-action: pan-y</code>{" "}
          so the browser keeps vertical scrolling and leaves horizontal movement to the gesture.
          {" "}
          <code>isBackSwipe(dx, dy)</code> is the pure test behind it.
        </li>
        <li>
          <code>installKeyboardInset()</code> / <code>useKeyboardInset()</code>{" "}
          — the on-screen keyboard's height, as the <code>--denext-keyboard-inset</code>{" "}
          custom property (or a number of px), for shells that set the Keyboard plugin's{" "}
          <code>resize: "none"</code>.
        </li>
        <li>
          <code>installMomentumSafeScroll()</code> / <code>useMomentumSafeScroll()</code>{" "}
          — keep iOS momentum scrolling alive; see below. The denext client runtime already installs
          it, so call these only from a page that does not run on denext's runtime.
        </li>
      </ul>
      <p>
        <strong>Momentum-safe scrolling is automatic on iOS.</strong>{" "}
        In iOS WebKit (Safari, WKWebView, Capacitor) any programmatic scroll write during a touch
        fling — <code>scrollBy</code>, <code>scrollTo</code>, assigning <code>scrollTop</code>{" "}
        — stops the fling dead, and virtualized lists (LegendList, react-virtuoso, TanStack Virtual)
        make exactly such writes to correct for rows measured taller or shorter than estimated. On
        iOS/iPadOS WebKit the client runtime defers those writes while a gesture is in flight,
        shifts the list's children with a CSS <code>translate</code>{" "}
        so nothing moves on screen, and applies the offset in one step once the scroller rests.
        Other platforms pay one user-agent check (the shim is its own lazily loaded chunk). Opt out
        with <code>momentumSafeScroll: false</code> in{" "}
        <code>denext.config.ts</code>; outside denext's runtime, install it yourself:
      </p>
      <Code lang="ts">
        {`import { installMomentumSafeScroll } from "denext/mobile";
installMomentumSafeScroll(); // once at startup; a no-op off iOS WebKit`}
      </Code>
      <p>
        What to expect while a list is shifted: deferred targets are clamped to the scroll range, so
        {" "}
        <code>el.scrollTop = el.scrollHeight</code> lands on the bottom, and the children&apos;s
        {" "}
        <code>translate</code> is composed with their own (a Tailwind <code>translate-*</code>{" "}
        class keeps its offset). A transformed child becomes the containing block of its{" "}
        <code>position: fixed</code> descendants, and <code>position: sticky</code>{" "}
        headers inside it move with the list until the fling settles, so keep fixed overlays outside
        the scroller. Only element scrollers are deferred: the document scroller is never shifted,
        and its writes, <code>window.scrollTo</code> included, always go straight through. A{" "}
        <code>scrollIntoView</code> or smooth <code>scrollTo</code>{" "}
        drops the pending delta of the scroller it moves. Documents inside iframes are not covered.
      </p>
      <p>
        <code>SAFE_AREA_CSS</code> defines <code>--denext-safe-top</code>/<code>-right</code>/
        <code>-bottom</code>/<code>-left</code>{" "}
        from the device's safe-area insets. They are only non-zero with{" "}
        <code>viewport-fit=cover</code>{" "}
        in the viewport meta — export it from the root layout (in SPA mode, put the meta tag in{" "}
        <code>spa.head</code>):
      </p>
      <Code lang="tsx">
        {`// app/layout.tsx
import { SAFE_AREA_CSS } from "denext/mobile";

export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html>
      <head><style>{SAFE_AREA_CSS}</style></head>
      <body style={{ paddingTop: "var(--denext-safe-top)" }}>{children}</body>
    </html>
  );
}`}
      </Code>
      <Callout kind="note">
        <code>denext/mobile</code> talks to Capacitor only through the <code>window.Capacitor</code>
        {" "}
        global the shell injects before page scripts — there is no <code>@capacitor/core</code>{" "}
        dependency, and it costs nothing on the web: importing it runs no code, every export
        tree-shakes on its own, and on the web (and during SSR) each function takes its
        plain-browser path.
      </Callout>

      <h3>Native capabilities</h3>
      <p>
        <code>denext/mobile</code>{" "}
        also wraps the common Capacitor plugins. Each function calls the official plugin inside the
        shell and falls back to a browser API (or does nothing) on the web, so the same code runs in
        both places. <code>denext mobile add</code>{" "}
        installs the plugins: it finds the project (the folder with{" "}
        <code>capacitor.config.*</code>, or <code>--dir</code>), refuses a{" "}
        <code>@capacitor/core</code>{" "}
        major other than 8, adds the packages with the package manager your lockfile names, declares
        any Android permissions they need, and runs <code>npx cap sync</code>.
      </p>
      <Code lang="bash">
        {`denext mobile add --list                    # the capabilities and their plugins
denext mobile add haptics share network --dry-run   # print the plan, change nothing
denext mobile add haptics share network secure-store`}
      </Code>
      <ul>
        <li>
          <code>haptic(kind)</code>{" "}
          (<code>haptics</code>): an impact, notification or selection tick; falls back to{" "}
          <code>navigator.vibrate</code>.
        </li>
        <li>
          <code>readClipboard()</code> / <code>writeClipboard(text)</code>{" "}
          (<code>clipboard</code>): falls back to <code>navigator.clipboard</code>.
        </li>
        <li>
          <code>share({"{ title, text, url }"})</code> (<code>share</code>): resolves{" "}
          <code>"shared"</code>, <code>"cancelled"</code>, or <code>"copied"</code>{" "}
          when there is no share sheet and the text went to the clipboard.
        </li>
        <li>
          <code>deviceInfo()</code>{" "}
          (<code>device</code>): platform, model, OS version; a best-effort user-agent read on the
          web.
        </li>
        <li>
          <code>networkStatus()</code> / <code>useNetworkStatus()</code>{" "}
          (<code>network</code>): connected and the connection type; <code>navigator.onLine</code>
          {" "}
          on the web.
        </li>
        <li>
          <code>useKeepAwake(active)</code>{" "}
          (<code>keep-awake</code>): keeps the screen on; the Screen Wake Lock API on the web.
        </li>
        <li>
          <code>hideSplash()</code> (<code>splash</code>): hides the launch splash when{" "}
          <code>launchAutoHide</code> is off.
        </li>
        <li>
          <code>secureStore.get / set / delete</code>{" "}
          (<code>secure-store</code>): the iOS Keychain / Android Keystore. On the web it is a plain
          IndexedDB database, which is <strong>not</strong> secret.
        </li>
      </ul>
      <p>
        <code>browser</code> installs the plugin <code>openExternal</code>{" "}
        uses for its in-app browser. A new plugin is native code: ship a new app binary afterwards.
      </p>

      <h3>Deep links</h3>
      <p>
        <code>deep-links</code> installs <code>@capacitor/app</code>{" "}
        and registers what opens the app: <code>--scheme</code> adds a custom URL scheme (
        <code>CFBundleURLTypes</code>{" "}
        in Info.plist, a VIEW intent filter on the launcher activity) and <code>--domain</code>{" "}
        a universal link / app link domain (<code>applinks:</code> in the entitlements, an{" "}
        <code>android:autoVerify</code>{" "}
        https intent filter). Several are comma-separated, and running it again merges instead of
        duplicating. A domain also has to serve <code>/.well-known/apple-app-site-association</code>
        {" "}
        and <code>/.well-known/assetlinks.json</code>, or the OS opens the link in the browser.
      </p>
      <Code lang="bash">
        {`denext mobile add deep-links --scheme myapp --domain app.example.com`}
      </Code>
      <Code lang="tsx">
        {`"use client";
import { useDeepLink } from "denext/mobile";

export function DeepLinks() {
  // myapp://threads/42 and https://app.example.com/threads/42 both open /threads/42.
  useDeepLink(({ url, launch }) => console.log("opened", url, launch), {
    accept: { schemes: ["myapp"], hosts: ["app.example.com"] },
  });
  return null;
}`}
      </Code>
      <p>
        The link that cold-started the app arrives once per page with{" "}
        <code>launch: true</code>, to the subscribers registered by then (so mount it in the root
        layout); links opened while the app runs follow with <code>launch: false</code>.{" "}
        <strong>Only accepted links reach your code.</strong>{" "}
        The default accepts the app's custom schemes (the OS only delivers the ones you registered)
        and no <code>https</code> host, so list your domains in <code>accept.hosts</code>{" "}
        or pass a predicate. Anyone can craft a deep link, so treat its path and query as untrusted
        input. An accepted link's in-app path is navigated once: pushed onto the history with a{" "}
        <code>popstate</code>, which denext's router and history-based SPA routers follow. Pass{" "}
        <code>route: (path) =&gt; router.push(path)</code> to use your own router, or{" "}
        <code>route: false</code>{" "}
        to handle it yourself. On the web it does nothing: the browser already loaded the URL.
      </p>

      <h3>Push notifications</h3>
      <p>
        <code>push</code> installs <code>@capacitor/push-notifications</code>, writes{" "}
        <code>aps-environment</code>{" "}
        (development) into the entitlements, adds the token forwarding the plugin needs to{" "}
        <code>AppDelegate.swift</code>, and declares <code>POST_NOTIFICATIONS</code>{" "}
        (Android 13+). Android also needs your Firebase project's{" "}
        <code>android/app/google-services.json</code>: without it the install warns and registration
        fails at runtime. iOS push needs a paid Apple Developer team with the Push Notifications
        capability; an archive exported for TestFlight or the App Store is signed with{" "}
        <code>production</code>. When the Xcode project has no entitlements file yet, denext writes
        {" "}
        <code>App/App.entitlements</code>{" "}
        and prints the one manual step: select it as the App target's Code Signing Entitlements.
      </p>
      <Code lang="tsx">
        {`"use client";
import { registerForPush, requestPushPermission, usePushTapped } from "denext/mobile";

export async function enablePush() {
  if ((await requestPushPermission()) !== "granted") return;
  const { platform, token } = await registerForPush(); // APNs (hex) or FCM token
  await fetch("/api/devices", { method: "POST", body: JSON.stringify({ platform, token }) });
}

export function PushRouting() {
  // A tap on a notification whose data is { "path": "/threads/42" } opens that thread.
  usePushTapped(({ notification }) => console.log("tapped", notification.id));
  return null;
}`}
      </Code>
      <p>
        <strong>denext ships no push relay.</strong>{" "}
        Your server stores each token with its user and platform and sends through APNs (iOS, with
        the app's bundle id as the topic, sandbox for development builds) or FCM (Android).{" "}
        <code>onPushReceived</code> fires for a notification that arrives in the foreground;{" "}
        <code>onPushTapped</code>{" "}
        for a tap, including the one that launched the app, which the shell keeps for the first
        listener. The tap navigates to <code>data.path</code> (an in-app path) or{" "}
        <code>data.url</code> (under the same acceptance rules as deep links). Call{" "}
        <code>registerForPush()</code>{" "}
        on every launch, since the token can change. There is no web-push fallback.
      </p>

      <h3>Over-the-air UI updates</h3>
      <p>
        A Capacitor app can pull a newer web UI from a server without a new app build: the shell
        downloads the files, verifies each SHA-256 (and, with a key embedded, the manifest's
        signature), switches its web root to them and reloads. It is off until you install the
        native <code>DenextOta</code> plugin, and a UI that fails to boot rolls itself back.
      </p>
      <p>
        <strong>1. Stamp the export.</strong> The manifest <code>_denext/ota.json</code>{" "}
        lists every file of the export with its SHA-256 and size, plus a <code>version</code>{" "}
        (the SHA-256 over the sorted <code>path&lt;TAB&gt;sha256</code> lines; <code>*.gz</code>
        {" "}
        siblings and the manifest itself are left out). A SPA-mode app sets{" "}
        <code>{"spa: { ota: true }"}</code> and <code>denext export</code>{" "}
        writes it as its last step. Any export can run <code>denext ota manifest out</code>{" "}
        instead, and must re-run it after anything that changes the export afterwards (swapping
        brand icons in, say). The scaffolded <code>mobile:sync</code> task stamps <code>out/</code>
        {" "}
        before{" "}
        <code>cap sync</code>, so the bundled UI knows its version. A file whose path holds a
        control character (a tab or newline could forge the lines the version hashes) makes the
        stamp fail, and every other side refuses such a manifest.
      </p>
      <p>
        <strong>2. Install the native plugin.</strong> After <code>cap add ios</code> /{" "}
        <code>cap add android</code>, run once (it is safe to re-run):
      </p>
      <Code lang="bash">
        {`deno task mobile:add-ota     # = denext mobile add-ota .`}
      </Code>
      <p>
        On iOS it writes <code>DenextOtaPlugin.swift</code>, <code>DenextOtaStore.swift</code> and
        {" "}
        <code>DenextBridgeViewController.swift</code> into{" "}
        <code>ios/App/App/</code>, adds them to the App target in{" "}
        <code>project.pbxproj</code>, and switches <code>Main.storyboard</code> and{" "}
        <code>SceneDelegate</code> to <code>DenextBridgeViewController</code>{" "}
        while they still name the stock{" "}
        <code>CAPBridgeViewController</code>. An app with its own bridge subclass changes that
        subclass's superclass to <code>DenextBridgeViewController</code>. On Android it writes{" "}
        <code>dev/denext/ota/*.java</code> and makes a stock <code>MainActivity</code> call{" "}
        <code>DenextOta.prepare(this, bridgeBuilder)</code> before <code>super.onCreate</code>
        . Anything customised is left alone and printed as a one-line manual step.
      </p>
      <p>
        <strong>After upgrading denext, re-run it and ship a new app binary.</strong>{" "}
        The native plugin is compiled into the app, so a denext release that changes it reaches
        devices only through a store build (the CHANGELOG says when one does). Each generated file
        starts with a <code>denext-ota-template: N sha256=…</code> marker comment;{" "}
        <code>add-ota</code>{" "}
        upgrades a file in place when that hash still matches its body, or when it is byte for byte
        a template an earlier denext wrote, and keeps a file you edited (<code>--force</code>{" "}
        replaces it, edits included).
      </p>
      <p>
        <strong>3. Call it from the app.</strong>{" "}
        After the first render, confirm the boot, then check a server:
      </p>
      <Code lang="tsx">
        {`"use client";
import { useEffect } from "denext";
import { checkForUiUpdate, onAppResume, otaBooted } from "denext/mobile";

const check = () =>
  checkForUiUpdate({
    baseUrl: "https://api.example.com/mobile-ui", // serves out/ (see below)
    headers: { authorization: \`Bearer \${token}\` },
  });

export function OtaUpdates() {
  useEffect(() => {
    void otaBooted().then(check); // confirm first: a trial UI has 15 s (foreground) to do so
    return onAppResume((awayMs) => awayMs >= 10_000 && void check());
  }, []);
  return null;
}`}
      </Code>
      <p>
        <code>checkForUiUpdate</code> fetches <code>{"${baseUrl}/_denext/ota.json"}</code>{" "}
        and, when its version differs from the running UI, has the plugin fetch{" "}
        <code>{"${baseUrl}/<path>"}</code>{" "}
        for every file (with the same headers), copying the files it already has from the running or
        bundled UI. It never throws: it resolves <code>current</code>, <code>applied</code>,{" "}
        <code>skipped</code> (<code>rejected</code> / <code>busy</code>), <code>error</code>, or
        {" "}
        <code>unsupported</code>{" "}
        on the web. The running UI is the one on its trial launch if any, else the confirmed
        download, else the bundled one, and a version the native side finds already running also
        resolves <code>current</code>. <code>otaStatus()</code> and <code>otaReset()</code>{" "}
        report and undo it; a reset during a download cancels the download first.
      </p>
      <p>
        <strong>Build your own update prompt.</strong> <code>checkForUiUpdate</code>{" "}
        switches as soon as the download verifies. To ask first, split it in two:{" "}
        <code>prepareUiUpdate</code> downloads and verifies the new UI and leaves it <em>staged</em>
        {" "}
        (the running UI is untouched), and <code>applyUiUpdate(version)</code>{" "}
        switches to it when the user agrees. A staged UI is never switched to on its own, not even
        at the next launch.
      </p>
      <Code lang="tsx">
        {`"use client";
import { useEffect, useState } from "denext";
import { applyUiUpdate, otaBooted, type OtaPrepareResult, prepareUiUpdate } from "denext/mobile";

type Ready = Extract<OtaPrepareResult, { kind: "ready" }>;

export function UpdatePrompt() {
  const [update, setUpdate] = useState<Ready | null>(null);
  useEffect(() => {
    void otaBooted()
      .then(() => prepareUiUpdate({ baseUrl: "https://api.example.com/mobile-ui" }))
      .then((r) => r.kind === "ready" && setUpdate(r));
  }, []);
  if (!update) return null;
  return (
    <dialog open>
      <p>Update available{update.notes ? \`: \${update.notes}\` : ""}</p>
      <button type="button" onClick={() => void applyUiUpdate(update.version)}>Restart</button>
      {!update.required && <button type="button" onClick={() => setUpdate(null)}>Later</button>}
    </dialog>
  );
}`}
      </Code>
      <p>
        <code>prepareUiUpdate</code> resolves <code>ready</code> (with <code>version</code>,{" "}
        <code>required</code> and <code>notes</code>), <code>current</code>, <code>skipped</code>,
        {" "}
        <code>error</code> or <code>unsupported</code>, and never throws. <code>applyUiUpdate</code>
        {" "}
        starts the same trial launch as an automatic update (the new page still calls{" "}
        <code>otaBooted()</code>); on success the page reloads, so its promise only settles with a
        failure. Mark a release required, and give it notes, when you stamp it:
      </p>
      <Code lang="bash">
        {`denext ota manifest out --required --notes "Fixes sign-in on iOS 26"`}
      </Code>
      <p>
        Both are hints for your prompt, not enforced by the shell, and neither is part of the{" "}
        <code>version</code>, so re-stamping with different notes does not make phones download the
        same files again. Notes are at most 2,000 characters: a longer <code>--notes</code>{" "}
        fails the stamp, and a longer served <code>notes</code>{" "}
        fails the check as malformed. A newer prepare replaces a staged UI; <code>otaReset()</code>
        {" "}
        and a new app binary drop it. <code>otaStatus()</code> reports it as <code>staged</code>.
      </p>
      <p>
        <strong>Serving rules.</strong> Serving the UI is the app's job, and any server must:
      </p>
      <ul>
        <li>
          serve <code>_denext/ota.json</code> and <em>only</em> the files it lists;
        </li>
        <li>put it behind the same auth as the app's API;</li>
        <li>
          send <code>Cache-Control: no-store</code>.
        </li>
      </ul>
      <p>
        A Deno server can use <code>createOtaHandler({"{ dir, basePath }"})</code> from{" "}
        <code>denext/server</code>, which does exactly that (wrap it in your auth check). A Node
        server writes the same three rules as its own route.
      </p>
      <p>
        The manifest request comes from the webview's own origin (<code>capacitor://localhost</code>
        {" "}
        on iOS, <code>https://localhost</code> on Android), and an <code>Authorization</code>{" "}
        header makes it a CORS preflighted request. Pass <code>cors: true</code>{" "}
        to allow those origins (plus{" "}
        <code>http://localhost</code>), or a string or list of exact origins: the handler then
        answers an allowed <code>OPTIONS</code> preflight with <code>204</code>{" "}
        and tags its responses with{" "}
        <code>Access-Control-Allow-Origin</code>. A preflight carries no credentials, so route{" "}
        <code>OPTIONS</code>{" "}
        to the handler before your auth check. The native file downloads are not subject to CORS.
      </p>
      <Code lang="ts">
        {`const ota = createOtaHandler({ dir: "out", basePath: "/mobile-ui", cors: true });
Deno.serve(async (req) => {
  if (new URL(req.url).pathname.startsWith("/mobile-ui/")) {
    if (req.method === "OPTIONS") return (await ota(req)) ?? new Response(null, { status: 404 });
    if (!(await isAuthorized(req))) return new Response("Unauthorized", { status: 401 });
    return (await ota(req)) ?? new Response("Not Found", { status: 404 });
  }
  return app(req);
});`}
      </Code>
      <p>
        Publish a release atomically. <code>denext ota manifest</code>{" "}
        writes the manifest last, through a temporary file and a rename, and the handler re-reads it
        when it changes. Rewriting the files of a directory that is being served is not atomic,
        though: a phone could fetch the new manifest and an old file, which then fails its hash.
        Export each release into a new directory and switch the server to it once its manifest is
        written (a symlink you swap, or the directory setting the server reads).
      </p>
      <p>
        <strong>Signed manifests.</strong>{" "}
        Without a signature, anyone who can answer the app's manifest request can serve a matching
        manifest and files, and that UI then runs with the app's stored credentials. Sign each
        release with a key only you hold, and embed the public half in the app binary:
      </p>
      <Code lang="bash">
        {`denext ota keygen ota.key                        # ota.key (PKCS#8 PEM, 0600) + ota.key.pub
denext mobile add-ota --public-key ota.key.pub   # Info.plist + AndroidManifest.xml
denext ota manifest out --sign ota.key           # adds "signature" to _denext/ota.json`}
      </Code>
      <p>
        Keep <code>ota.key</code> out of the repository. In CI, put its PEM <em>contents</em> in the
        {" "}
        <code>DENEXT_OTA_SIGNING_KEY</code> secret instead: <code>denext ota manifest</code> and a
        {" "}
        <code>spa.ota</code> export both sign with it when it is set (<code>--sign</code>{" "}
        wins over it). <code>add-ota --public-key</code> takes that <code>.pub</code> file or a{" "}
        <code>PUBLIC KEY</code> PEM, writes the Info.plist string <code>DenextOtaPublicKey</code>
        {" "}
        and the <code>dev.denext.ota.PUBLIC_KEY</code>{" "}
        meta-data, and replaces an earlier key when re-run. It exits non-zero when it could not
        embed the key on an installed platform, or kept an edited template there. The key only ever
        comes from the app binary, never from the server, so changing it takes an app release:{" "}
        <code>denext ota keygen --force</code>{" "}
        replaces a key pair (the new key is written before the old one goes) and warns that every
        installed binary embedding the old public key refuses the new signatures.
      </p>
      <p>
        <strong>Release order and the native gate.</strong> Signing also stamps a{" "}
        <code>sequence</code>: the current Unix time in seconds, or{" "}
        <code>--sequence N</code>. Each device remembers the highest sequence it has accepted and
        refuses a lower one, or a manifest with none once it has seen one (code{" "}
        <code>downgrade</code>), so an old signed release cannot be replayed. It survives{" "}
        <code>otaReset()</code>{" "}
        and new binaries; only a reinstall clears it. Keep sequences growing: going from Unix times
        to a small counter locks installed apps out. <code>--min-native N</code>{" "}
        marks a UI that needs native code from app build <code>N</code>{" "}
        on: an app whose build number (iOS{" "}
        <code>CFBundleVersion</code>, as an integer or its first dot-separated part; Android{" "}
        <code>versionCode</code>) is lower refuses it before downloading (code{" "}
        <code>native_too_old</code>).
      </p>
      <Code lang="bash">
        {`denext ota manifest out --sign ota.key --min-native 42   # sequence = now
denext ota manifest out --sign ota.key --sequence 1758700000`}
      </Code>
      <p>
        The signature is ECDSA P-256 / SHA-256, as standard base64 of the raw 64-byte{" "}
        <code>r‖s</code>, over these UTF-8 bytes (<code>\n</code>{" "}
        is one 0x0A byte, with no trailing newline). A manifest with a <code>sequence</code>{" "}
        is signed as v2, one without as v1 (what denext 2.8 signed, still accepted):
      </p>
      <Code lang="text">
        {`v2: denext-ota-v2\\n<version>\\n<1|0>\\n<sha256hex(notes)>\\n<sequence>\\n<minNative or empty>
v1: denext-ota-v1\\n<version>\\n<1|0>\\n<sha256hex(notes)>`}
      </Code>
      <p>
        <code>1</code> means{" "}
        <code>required: true</code>; the notes hash is lowercase hex of the SHA-256 of their UTF-8
        (of the empty string without notes); the integers are plain decimal.{" "}
        <code>otaSignaturePayload(manifest)</code> from <code>denext/mobile</code>{" "}
        builds exactly these bytes, for a server that signs on its own.
      </p>
      <p>Before it downloads anything, the native plugin:</p>
      <ul>
        <li>
          checks the manifest: well-formed paths (no{" "}
          <code>..</code>, backslash or control character), at most 20,000 files and 512 MiB in
          total (code <code>invalid</code>);
        </li>
        <li>
          recomputes the <code>version</code>{" "}
          from the manifest's file list and refuses a mismatch (code{" "}
          <code>integrity</code>), so the chain is files → version → signature;
        </li>
        <li>
          with a public key embedded, refuses a missing or invalid signature (code{" "}
          <code>signature</code>), over <code>https</code> and <code>http</code> alike;
        </li>
        <li>
          with no key, refuses plain <code>http</code> (code{" "}
          <code>insecure</code>) unless the host is loopback: <code>localhost</code>,{" "}
          <code>127.0.0.1</code>, <code>::1</code>, or the Android emulator's <code>10.0.2.2</code>
          {" "}
          in a debuggable Android build. Unsigned updates over <code>https</code> still work;
        </li>
        <li>
          refuses an older <code>sequence</code> (code <code>downgrade</code>) and a{" "}
          <code>minNative</code> above its build (code <code>native_too_old</code>).
        </li>
      </ul>
      <p>
        Then it streams each file to disk while hashing it, refuses it as soon as it grows past its
        manifest <code>size</code> (code{" "}
        <code>integrity</code>), gives each file 30 s plus the time a 32 KiB/s link needs, and the
        whole update 30 minutes. It follows a redirect only within the <code>baseUrl</code>{" "}
        origin, so your headers never reach another host. Files verified before a failure are kept,
        so the next attempt resumes.
      </p>
      <p>
        <strong>Transport.</strong>{" "}
        A signature protects integrity, not confidentiality. With a key embedded, plain{" "}
        <code>http</code>{" "}
        stays allowed (an app whose own API is LAN http can serve its UI the same way), but the
        request headers, bearer tokens included, and the UI's files then cross the network in the
        clear. Use <code>https</code> wherever the network is not yours.
      </p>
      <p>
        A refusal leaves the running UI and any staged one as they were, and reaches the app as{" "}
        <code>{'{ kind: "error", code }'}</code> (<code>OtaErrorCode</code> in{" "}
        <code>denext/mobile</code>). The web side only forwards the signature; the native side is
        the authority. Every code:
      </p>
      <ul>
        <li>
          <code>invalid</code>: a malformed request or manifest, or one over the caps;
        </li>
        <li>
          <code>busy</code>: a download or a trial launch is in progress (a <code>skipped</code>
          {" "}
          result);
        </li>
        <li>
          <code>rejected</code>: this version was rolled back on this device (a <code>skipped</code>
          {" "}
          result, until <code>otaReset()</code>);
        </li>
        <li>
          <code>download</code>: a file could not be fetched (HTTP error, timeout, a cross-origin
          redirect, a reset, the 30-minute deadline);
        </li>
        <li>
          <code>integrity</code>: a file, or the manifest's <code>version</code>, does not match;
        </li>
        <li>
          <code>not_staged</code>: <code>applyUiUpdate</code> named a version that is not staged;
        </li>
        <li>
          <code>signature</code>: a key is embedded and the signature is missing or wrong (or the
          embedded key does not parse);
        </li>
        <li>
          <code>insecure</code>: no key, and plain <code>http</code> to a non-loopback host;
        </li>
        <li>
          <code>downgrade</code>: an older <code>sequence</code>, or none after a sequenced release;
        </li>
        <li>
          <code>native_too_old</code>: the app build is below the manifest's <code>minNative</code>.
        </li>
      </ul>
      <p>
        <strong>Rollback rules.</strong>
      </p>
      <ul>
        <li>
          A new UI starts as a <em>trial</em>. <code>otaBooted()</code>{" "}
          makes it current and deletes every other download. Without it, a watchdog rolls back to
          the previous download or the bundled UI, and deletes the bad version. The watchdog counts
          foreground time only (it pauses while the app is inactive) and defaults to 15 s: set the
          Info.plist number <code>DenextOtaBootTimeout</code> or the Android{" "}
          <code>
            {'<meta-data android:name="dev.denext.ota.BOOT_TIMEOUT" android:value="30" />'}
          </code>{" "}
          (seconds, 1 to 600) to change it.
        </li>
        <li>
          <code>otaBooted()</code> sends the page's own UI version (read from the{" "}
          <code>_denext/ota.json</code>{" "}
          it was served with), and the native side confirms only the version on trial, so a late
          call from the page being replaced confirms nothing.
        </li>
        <li>
          A trial gets two launches: if the app dies before the UI confirms (the OS may kill it in
          the background), the next launch tries again; if it dies again, the launch after rolls
          back before the first page.
        </li>
        <li>
          A rolled-back version is refused (<code>skipped: rejected</code>) until{" "}
          <code>otaReset()</code>, so a broken server UI cannot loop.
        </li>
        <li>
          While a download or trial is in progress, another apply is <code>busy</code>.
        </li>
        <li>
          A new app binary drops every download and starts from its bundled UI, as does a missing
          version directory.
        </li>
      </ul>
      <Callout kind="warn">
        <strong>Limits.</strong>{" "}
        Downgrade protection covers sequenced (v2) releases: a device that never accepted a
        sequenced manifest still takes an older v1 one. Without an embedded key, the transport (TLS)
        is the only thing standing between the app and a hostile UI. Rotating the key takes an app
        release, and a leaked key is valid until then. Downloaded files are verified once, when they
        arrive: tampering with the app's data directory afterwards (which needs a jailbroken or
        rooted device, or a debug build) is not detected at the next launch. On iOS, a web content
        process that dies during a trial is reloaded by Capacitor itself; if that leaves the page
        blank, the watchdog rolls it back. On Android, a renderer crash takes the app down, and the
        next launch counts it as a failed trial attempt.
      </Callout>

      <h2>Environment variables</h2>
      <ul>
        <li>
          <code>DENEXT_CODESIGN_IDENTITY</code> — the{" "}
          <code>"Developer ID Application: … (TEAMID)"</code>{" "}
          identity. Omit for an ad-hoc, local-only build.
        </li>
        <li>
          <code>DENEXT_NOTARY_PROFILE</code> — a <code>notarytool store-credentials</code>{" "}
          profile name. Set (with a real identity) to notarize + staple.
        </li>
        <li>
          <code>DENEXT_ENTITLEMENTS</code> — path to an entitlements <code>.plist</code> (optional).
        </li>
        <li>
          <code>DENEXT_APP_NAME</code> — output base name (defaults to <code>desktop.app.name</code>
          {" "}
          from <code>deno.json</code>).
        </li>
      </ul>

      <Callout kind="note">
        Signing and notarization shell out to <code>codesign</code> and{" "}
        <code>xcrun notarytool</code>, so macOS packaging (<code>
          denext desktop package
        </code>{" "}
        with{" "}
        <code>--target-os macos</code>, the default on a Mac) must run on a macOS host — even when
        cross-compiling to the other Mac architecture. Linux bundles cross-build from any OS (<code>
          --target-os linux
        </code>). Windows packages from any OS with{" "}
        <code>denext desktop package --target-os windows</code> (the scaffolded{" "}
        <code>scripts/package-windows.ts</code> / <code>desktop:package:windows</code>{" "}
        task): a zip per architecture, Authenticode-signed when <code>DENEXT_WINDOWS_CERT</code> (+
        {" "}
        <code>DENEXT_WINDOWS_CERT_PASSWORD</code>, optional{" "}
        <code>DENEXT_SIGN_TIMESTAMP_URL</code>) is set.
      </Callout>
    </DocsShell>
  );
}
