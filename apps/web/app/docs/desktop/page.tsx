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

      <h3>Live reload on a device</h3>
      <p>
        During development the app can load straight from <code>denext dev</code>{" "}
        instead of the bundled export, the way a React Native app attaches to Metro: every edit
        reloads on the phone. <code>denext mobile dev</code>{" "}
        starts the dev server (or attaches to one already answering on the port), writes{" "}
        <code>{"server: { url, cleartext: true }"}</code> into <code>capacitor.config.*</code>{" "}
        and runs <code>npx cap copy</code>:
      </p>
      <Code lang="bash">
        {`denext mobile dev --lan            # a physical device on the same Wi-Fi
denext mobile dev                  # localhost: the iOS simulator (or Android + adb reverse)
denext mobile dev web --dir mobile # the denext project in web/, Capacitor in mobile/`}
      </Code>
      <p>
        Then run the app from Xcode (or{" "}
        <code>npx cap run ios</code>/<code>android</code>). The page origin <em>is</em>{" "}
        the dev server, so the reload stream and the dev origin check work unchanged. The config
        edit is temporary: Ctrl-C, <code>SIGTERM</code>{" "}
        or an error writes the original bytes back and runs <code>cap copy</code>{" "}
        again, so a release build never ships the dev URL. A run killed outright leaves a backup in
        {" "}
        <code>.denext/</code>; the next <code>mobile dev</code> (or{" "}
        <code>mobile dev --restore</code>) restores it first. <code>cap copy</code> needs the{" "}
        <code>webDir</code>{" "}
        built once. The restore does not depend on it: it takes the dev URL out of the native config
        copies (<code>ios/App/App/capacitor.config.json</code>,{" "}
        <code>android/app/src/main/assets/capacitor.config.json</code>) itself, so they stop
        pointing at the dev server even when the closing <code>cap copy</code>{" "}
        fails; then run your export and <code>npx cap copy</code> before a release build.
      </p>
      <p>
        On iOS, <code>cleartext</code> does nothing (it is Android's{" "}
        <code>usesCleartextTraffic</code>, which <code>cap copy</code>{" "}
        writes for you). A WebView reaches a LAN dev server only when{" "}
        <code>ios/App/App/Info.plist</code> has <code>NSAppTransportSecurity</code> →{" "}
        <code>NSAllowsLocalNetworking</code> (App Transport Security) and a{" "}
        <code>NSLocalNetworkUsageDescription</code>{" "}
        (without one, iOS 14+ silently denies local-network requests and the app hangs on its splash
        screen). <code>mobile dev</code>{" "}
        adds both for the session, merging into an existing ATS dict and keeping an existing
        description, and puts the plist back with the config. A changed Info.plist is a native
        change: rebuild and run the app from Xcode (it prints so). Xcode opens{" "}
        <code>ios/App/App.xcworkspace</code> for a CocoaPods project and{" "}
        <code>ios/App/App.xcodeproj</code>{" "}
        for a Swift Package Manager one (Capacitor 8's default), and the printed steps name
        whichever exists.
      </p>
      <p>
        Without the helper, <code>denext dev --lan</code>{" "}
        binds the machine's LAN IPv4, allows it through the dev origin gate, and prints its URL with
        a QR code to scan. By default the dev assets (<code>/_denext/*</code>) answer only a
        loopback{" "}
        <code>Host</code>: that is the DNS-rebinding defense, and it is why a phone pointed at{" "}
        <code>--host 0.0.0.0</code> used to render a dead page. An explicit <code>--host</code>{" "}
        now allows the host it binds (<code>0.0.0.0</code> allows this machine's own addresses), and
        {" "}
        <a href="/docs/config#dev-server">
          <code>allowedDevOrigins</code>
        </a>{" "}
        (or{" "}
        <code>--allowed-dev-origin</code>) lists any other host. Anything on the network that can
        reach an allowed address can load the dev app and its source, so use <code>--lan</code>{" "}
        on a network you trust.
      </p>

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
        major other than 8, adds the packages with the package manager the nearest lockfile names
        (looking up to the repository root, so a pnpm / yarn / bun workspace's lockfile counts; else
        a <code>packageManager</code>{" "}
        field; else npm), declares any Android permissions they need, and runs{" "}
        <code>npx cap sync</code>. The install runs in the Capacitor project folder.
      </p>
      <Code lang="bash">
        {`denext mobile add --list                    # the capabilities and their plugins
denext mobile add haptics share network --dry-run   # print the plan, change nothing
denext mobile add haptics share network secure-store`}
      </Code>
      <Callout kind="warn">
        Running the CLI straight from JSR inside a Node workspace? Pass{" "}
        <code>--node-modules-dir=none</code>: without it Deno reads the workspace's{" "}
        <code>package.json</code>, fails to resolve denext's own <code>npm:</code> imports from its
        {" "}
        <code>node_modules</code>, and (with a <code>pnpm-workspace.yaml</code>) rewrites the root
        {" "}
        <code>package.json</code>.
        <Code lang="bash">
          {`deno run -A --node-modules-dir=none jsr:@denext/denext/cli mobile add haptics --dry-run`}
        </Code>
      </Callout>
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
        <li>
          <code>readFile</code> / <code>writeFile</code> / <code>deleteFile</code> /{" "}
          <code>listDir</code> / <code>downloadToFile(url, path)</code>{" "}
          (<code>filesystem</code>): the app's files in <code>"data"</code>,{" "}
          <code>"documents"</code> or{" "}
          <code>"cache"</code>, as text or base64; the Origin Private File System on the web (a
          top-level folder per directory).
        </li>
        <li>
          <code>pickImage({"{ source }"})</code>{" "}
          (<code>camera</code>, which also writes the camera and photo-library usage strings) and
          {" "}
          <code>pickDocument({"{ types }"})</code> (<code>document-picker</code>): resolve{" "}
          <code>null</code> when the user cancels; a hidden file input on the web.
        </li>
        <li>
          <code>scanBarcode({"{ formats }"})</code>{" "}
          (<code>barcode</code>): the value and format of one code; <code>BarcodeDetector</code>
          {" "}
          over the camera on the web where the browser has it. The install raises Android's{" "}
          <code>minSdkVersion</code> to 26, which the scanner needs.
        </li>
        <li>
          <code>setQuickActions([...])</code> / <code>onQuickAction</code> /{" "}
          <code>useQuickAction</code>{" "}
          (<code>quick-actions</code>): home-screen shortcuts on a long press of the app icon, the
          one that cold-started the app included (the install wires{" "}
          <code>SceneDelegate.swift</code>); nothing on the web.
        </li>
      </ul>
      <p>
        Audio, video and image editing need no plugin: Expo's <code>expo-audio</code> and{" "}
        <code>expo-video</code> map to <code>&lt;audio&gt;</code>, <code>&lt;video&gt;</code>{" "}
        and Web Audio in the WebView, and <code>expo-image-manipulator</code> to Canvas /{" "}
        <code>OffscreenCanvas</code>.
      </p>
      <p>
        <code>browser</code> installs the plugin <code>openExternal</code>{" "}
        uses for its in-app browser. A new plugin is native code: ship a new app binary afterwards.
      </p>

      <h3 id="context-menus">Context menus</h3>
      <p>
        <code>showContextMenu(items, options)</code>{" "}
        opens a menu and resolves with the chosen item's <code>id</code>, or <code>null</code>{" "}
        when it is dismissed. Inside the shell it hands every item to a native{" "}
        <code>DenextContextMenu</code>{" "}
        plugin when the app registers one (denext ships none: it is feature-detected by that name
        and a <code>show({"{ items, title, x, y }"})</code> method resolving{" "}
        <code>{"{ selectedId }"}</code>). Everywhere else, the shell without that plugin, the web
        and a Deno Desktop window, it renders an accessible popover in the page: a{" "}
        <code>role="menu"</code> with a <code>role="menuitem"</code> per item, opened at{" "}
        <code>x</code> / <code>y</code> or under an <code>anchor</code>{" "}
        rect. Up / Down move, Enter or Space choose, Escape or a press outside dismisses it, and it
        removes every node and listener it added when it resolves.
      </p>
      <Code lang="tsx">
        {`"use client";
import { showContextMenu } from "denext/mobile";

export function Row({ id, onDelete }: { id: string; onDelete: (id: string) => void }) {
  return (
    <button
      type="button"
      onContextMenu={async (e) => {
        e.preventDefault();
        const choice = await showContextMenu(
          [
            { id: "open", label: "Open" },
            { id: "archive", label: "Archive", disabled: true },
            { id: "delete", label: "Delete", destructive: true },
          ],
          { x: e.clientX, y: e.clientY, title: "Thread" },
        );
        if (choice === "delete") onDelete(id);
      }}
    >
      {id}
    </button>
  );
}`}
      </Code>
      <p>
        The popover always lists every item: a <code>disabled</code>{" "}
        one is shown but not selectable (<code>aria-disabled</code>), a <code>destructive</code>
        {" "}
        one carries <code>data-destructive</code>, and <code>icon</code>{" "}
        is a glyph before the label. It sets only its position, so style it through{" "}
        <code>[role="menu"]</code> and <code>[role="menuitem"]</code>{" "}
        in your CSS. It is SSR-safe: importing it runs nothing, and called without a DOM (or with no
        items) it renders nothing and resolves <code>null</code>.
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

      <h3>Auth sessions</h3>
      <p>
        <code>openAuthSession(url, {"{ callbackScheme }"})</code>{" "}
        signs in with an OAuth 2 / OpenID Connect provider in a system browser sheet and resolves
        with the full callback URL the provider redirected to. <code>auth-session</code>{" "}
        has no npm package: it installs denext's own <code>DenextAuthSession</code>{" "}
        plugin (Swift and Java sources, the Xcode target entry, and its registration in{" "}
        <code>DenextBridgeViewController</code> and <code>MainActivity</code>, which it shares with
        {" "}
        <code>add-ota</code>; either can run first). <code>--scheme</code>{" "}
        registers the callback scheme the way <code>deep-links</code> does.
      </p>
      <Code lang="bash">
        {`denext mobile add auth-session --scheme myapp`}
      </Code>
      <Code lang="tsx">
        {`"use client";
import { openAuthSession } from "denext/mobile";

export async function signIn() {
  const state = crypto.randomUUID(); // and a PKCE verifier + code_challenge
  const authorize = new URL("https://auth.example.com/authorize");
  authorize.searchParams.set("redirect_uri", "myapp://auth/callback");
  authorize.searchParams.set("state", state);
  const { url } = await openAuthSession(authorize.href, { callbackScheme: "myapp" });
  const params = new URL(url).searchParams;
  if (params.get("state") !== state) throw new Error("state mismatch");
  await fetch("/api/auth/exchange", { method: "POST", body: params.get("code") });
}`}
      </Code>
      <ul>
        <li>
          <strong>iOS:</strong> an <code>ASWebAuthenticationSession</code>{" "}
          sheet. It shares Safari's cookies (an existing provider login is reused) unless{" "}
          <code>preferEphemeral: true</code>, and it catches the redirect to <code>myapp:</code>
          {" "}
          itself, so the scheme needs no Info.plist entry.
        </li>
        <li>
          <strong>Android:</strong>{" "}
          a Custom Tab. The redirect comes back through the app's intent filter for the scheme (so
          {" "}
          <code>--scheme</code>{" "}
          is required there), and the plugin resolves with it. Coming back without a callback (back
          button, closing the tab) rejects <code>cancelled</code>{" "}
          after a short delay, so a redirect racing the return still wins. The tab is requested
          through the Custom Tabs intent extra, with no <code>androidx.browser</code>{" "}
          dependency; a browser without Custom Tabs opens a normal page. While a session waits,{" "}
          <code>onDeepLink</code> leaves its callback alone.
        </li>
        <li>
          <strong>Web:</strong> a popup (call it from a click handler, or it is blocked:{" "}
          <code>unsupported</code>). Use an https page of your origin as the redirect URI and call
          {" "}
          <code>completeAuthSession()</code>{" "}
          there: it posts the page's URL to the opener, addressed to this origin only, and closes
          the popup. A popup closed without a callback rejects{" "}
          <code>cancelled</code>. A provider that sends{" "}
          <code>Cross-Origin-Opener-Policy: same-origin</code>{" "}
          cuts the popup off from the page; use a full-page redirect for it.
        </li>
      </ul>
      <p>
        Only one session is open at a time (<code>busy</code>); <code>timeoutMs</code> gives up with
        {" "}
        <code>timeout</code>, and a non-https <code>url</code> or a bad scheme is{" "}
        <code>invalid</code>.{" "}
        <strong>
          PKCE and <code>state</code> stay your job:
        </strong>{" "}
        denext only opens the page and hands back the callback URL. Check <code>state</code>{" "}
        and exchange the <code>code</code> on your server.
      </p>

      <h3 id="desktop-sign-in">Sign-in on Deno Desktop</h3>
      <p>
        In a Deno Desktop window (<code>runtimePlatform()</code> is{" "}
        <code>"desktop"</code>), the same <code>openAuthSession</code>{" "}
        call runs the RFC 8252 loopback flow instead, with nothing to install: the desktop runtime
        opens the provider's page in the system browser, listens once on an ephemeral{" "}
        <code>127.0.0.1</code> port, rewrites the host and port of the authorization URL's{" "}
        <code>redirect_uri</code>{" "}
        to that listener (keeping its path and query), and resolves with the callback URL when the
        provider redirects there. The browser tab then shows a static "You can close this tab."
        page.
      </p>
      <Code lang="tsx">
        {`"use client";
import { openAuthSession, runtimePlatform } from "denext/mobile";

export async function signIn() {
  const state = crypto.randomUUID(); // and a PKCE verifier + code_challenge
  const desktop = runtimePlatform() === "desktop";
  const authorize = new URL("https://auth.example.com/authorize");
  authorize.searchParams.set(
    "redirect_uri",
    desktop ? "http://127.0.0.1/auth/callback" : "myapp://auth/callback",
  );
  authorize.searchParams.set("state", state);
  // callbackScheme is required by the type, and ignored on desktop.
  const { url } = await openAuthSession(authorize.href, { callbackScheme: "myapp" });
  const params = new URL(url).searchParams;
  if (params.get("state") !== state) throw new Error("state mismatch");
  // exchange params.get("code") with the PKCE verifier
}`}
      </Code>
      <ul>
        <li>
          <strong>
            <code>callbackScheme</code> is ignored,
          </strong>{" "}
          and the <code>redirect_uri</code> must be a loopback <code>http</code>{" "}
          URI with no fragment: <code>http://127.0.0.1/...</code> (<code>localhost</code> and{" "}
          <code>[::1]</code> are accepted and rewritten to{" "}
          <code>127.0.0.1</code>). The authorization URL itself must be{" "}
          <code>https</code>. Anything else rejects <code>invalid</code>. Register the loopback{" "}
          redirect with the provider as a desktop / native client that allows any port, since the
          port changes on every sign-in.
        </li>
        <li>
          <strong>
            PKCE and <code>state</code> are your job,
          </strong>{" "}
          here more than anywhere. Any process on the machine can connect to the loopback port, and
          the first request to the callback path wins, so a local program that finds the port can
          race a forged redirect in before the real browser. Generate <code>state</code>{" "}
          and re-check it on the callback, and use PKCE so an intercepted <code>code</code>{" "}
          is useless without your verifier.
        </li>
        <li>
          <strong>Cancel is only a timeout.</strong>{" "}
          The app cannot see the user close the browser tab, so the session waits until{" "}
          <code>timeoutMs</code> (default 5 minutes on desktop) and then rejects{" "}
          <code>timeout</code>. Pass a shorter <code>timeoutMs</code>{" "}
          if your UI offers a retry. One session runs at a time (<code>busy</code>), and outside a
          desktop window the call takes the web path.
        </li>
      </ul>
      <p>
        The runtime's local endpoint only answers a <code>POST</code>{" "}
        carrying the per-launch token it injects into the page (compared in constant time), from the
        app's own loopback origin, and it never logs the authorization or callback URL.
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

      <h3 id="app-extensions">App extensions</h3>
      <p>
        Three generators add native app extensions to a Capacitor project, each with a{" "}
        <code>denext/mobile</code>{" "}
        API behind it. None installs an npm package: they write denext's own Swift and Java sources,
        add the Xcode targets, and register the plugins through{" "}
        <code>DenextBridgeViewController</code> and <code>MainActivity</code> (which they share with
        {" "}
        <code>add-ota</code> and{" "}
        <code>auth-session</code>, in any order). Run them again after a denext upgrade: unedited
        templates are upgraded, and a file you edited is kept and listed as a manual step (<code>
          --force
        </code>{" "}
        replaces it).
      </p>
      <Code lang="bash">
        {`denext mobile add share-extension --app-group group.com.example.app
denext mobile add widget --name Status --app-group group.com.example.app
denext mobile add widget --name Usage --configurable period:enum=auto|session|weekly
denext mobile add live-activity --name Delivery`}
      </Code>
      <ul>
        <li>
          <strong>
            <code>share-extension</code>
          </strong>: iOS gets a Share Extension target (<code>ios/App/DenextShareExtension/</code>:
          {" "}
          <code>ShareViewController.swift</code>, <code>DenextShareInbox.swift</code>, its{" "}
          <code>Info.plist</code>{" "}
          with an activation rule for one web URL, text and up to ten images, and its entitlements),
          embedded in the app's <code>PlugIns</code>{" "}
          and built before it. The extension copies what was shared into the App Group container,
          queues it, and opens the app with <code>&lt;scheme&gt;://denext-share</code>{" "}
          (the scheme is <code>--scheme</code>, else the app's first <code>CFBundleURLSchemes</code>
          {" "}
          entry; with neither it stops before changing anything). Android gets <code>SEND</code> and
          {" "}
          <code>SEND_MULTIPLE</code> intent filters (<code>text/plain</code>,{" "}
          <code>image/*</code>) on the launcher activity. Both get the{" "}
          <code>DenextShareReceive</code> plugin.
        </li>
        <li>
          <strong>
            <code>widget --name &lt;Name&gt;</code>
          </strong>: iOS gets a WidgetKit extension target (<code>ios/App/DenextWidgets/</code>,
          created once) with <code>&lt;Name&gt;Widget.swift</code>{" "}
          (a static widget whose timeline reads the JSON snapshot the app stored) and{" "}
          <code>DenextWidgetsBundle.swift</code> listing every widget. Android gets{" "}
          <code>&lt;Name&gt;Widget.java</code> (an{" "}
          <code>AppWidgetProvider</code>), its RemoteViews layout, its{" "}
          <code>appwidget-provider</code> XML and the manifest receiver. Both get the{" "}
          <code>DenextWidgets</code> plugin.
        </li>
        <li>
          <strong>
            <code>widget --name &lt;Name&gt; --configurable &lt;param:enum=a|b,…&gt;</code>
          </strong>: on iOS 17 and later the widget is configurable. The generated{" "}
          <code>&lt;Name&gt;Widget.swift</code> declares an App Intents{" "}
          <code>WidgetConfigurationIntent</code>{" "}
          with one enum per parameter (the first value is the default) and a provider that reads the
          snapshot stored for the values the user chose, falling back to the one stored without
          parameters. On iOS 14–16 the same file's static configuration (kind{" "}
          <code>&lt;Name&gt;.static</code>) shows the defaults' snapshot, and hides itself on iOS
          17. The parameters are recorded in the file, so re-running without{" "}
          <code>--configurable</code>{" "}
          keeps them; delete the file to make the widget static again. Android widgets stay static
          and show the snapshot stored without parameters.
        </li>
        <li>
          <strong>
            <code>live-activity --name &lt;Name&gt;</code>
          </strong>{" "}
          (iOS only): the ActivityKit attributes (<code>DenextActivityAttributes.swift</code>,
          compiled into the app and the widget extension),{" "}
          <code>&lt;Name&gt;LiveActivity.swift</code>{" "}
          (the Lock Screen and Dynamic Island UI) in the widget extension, which is created when
          absent, <code>NSSupportsLiveActivities</code> in the app's Info.plist, and the{" "}
          <code>DenextLiveActivity</code> plugin. ActivityKit needs iOS 16.1: everything is behind
          {" "}
          <code>#available</code>{" "}
          and ActivityKit is weak-linked, so the app keeps its iOS 15 deployment target. On iOS 17.2
          and later the plugin also hands out the app's push-to-start token, so a server can start
          an activity while the app is not running.
        </li>
      </ul>
      <Code lang="tsx">
        {`"use client";
import { useRouter } from "denext";
import {
  liveActivityPushToken,
  liveActivityPushToStartToken,
  onLiveActivityPushToStartToken,
  setWidgetData,
  startLiveActivity,
  updateLiveActivity,
  useShareReceived,
} from "denext/mobile";

export function ShareTarget() {
  const router = useRouter();
  // Includes the share that opened the app: mount it early (the root layout).
  useShareReceived(({ url, text, files }) => {
    router.push(\`/new?link=\${encodeURIComponent(url ?? text ?? "")}&files=\${files?.length ?? 0}\`);
  });
  return null;
}

export async function publish(running: number) {
  // The generated widget shows title and body; edit its view to show more.
  await setWidgetData("Status", { title: \`\${running} agents running\`, body: "Updated just now" });
  // A configurable widget: one snapshot per value you tailor, plus the fallback.
  await setWidgetData("Usage", { title: "Weekly", body: "41% left" }, { params: { period: "weekly" } });
  await setWidgetData("Usage", { title: "Usage", body: "41% weekly, 80% session" });
}

export async function registerDevice() {
  // iOS 17.2+: null below it and off iOS. Later rotations arrive as events.
  const start = await liveActivityPushToStartToken();
  if (start) await fetch("/api/devices", { method: "POST", body: start.token });
  onLiveActivityPushToStartToken(({ token }) => void fetch("/api/devices", { method: "POST", body: token }));
}

export async function track(order: string) {
  const id = await startLiveActivity("Delivery", { order }, { title: "Packing", progress: 0.1 }, {
    push: true, // needs the push entitlement: denext mobile add push
  });
  await fetch("/api/live-activity", { method: "POST", body: await liveActivityPushToken(id) });
  await updateLiveActivity(id, { title: "On the way", progress: 0.6 });
}`}
      </Code>
      <p>
        <code>onShareReceived</code> / <code>useShareReceived</code> deliver{" "}
        <code>{"{ text?, url?, files?: [{ path, mimeType }] }"}</code>{" "}
        for a cold start and a warm one; shares wait natively for the first subscriber.{" "}
        <code>onDeepLink</code> leaves the <code>denext-share</code> hand-off URL alone. A file's
        {" "}
        <code>path</code>{" "}
        is on the device (the App Group container on iOS, kept seven days; the app's cache on
        Android), readable through{" "}
        <code>Capacitor.convertFileSrc</code>; copy what you keep. Android copies only{" "}
        <code>content:</code> streams, never a <code>file:</code> path another app names.{" "}
        <code>setWidgetData(kind, data, {"{ params? }"})</code>{" "}
        stores the JSON (iOS: the App Group's shared defaults; Android: shared preferences) and
        refreshes that kind; <code>params</code> (a configurable widget's values, such as{" "}
        <code>{'{ period: "weekly" }'}</code>) stores it for exactly those values.{" "}
        <code>reloadWidgets(kind?)</code> only refreshes. The Live Activity functions reject with a
        {" "}
        <code>code</code>: <code>unsupported</code>, <code>disabled</code>, <code>invalid</code>,
        {" "}
        <code>not_found</code>, <code>timeout</code> or <code>failed</code>.{" "}
        <code>endLiveActivity</code> also takes a <code>Date</code> as its{" "}
        <code>dismissal</code>, and <code>listLiveActivities()</code>{" "}
        returns the running activities, including those started in an earlier session or by a push.
      </p>
      <p>
        <strong>Live Activity pushes.</strong> Both kinds need the push entitlement (<code>
          denext mobile add push
        </code>) and an APNs push with <code>apns-push-type: liveactivity</code> (topic{" "}
        <code>&lt;bundle id&gt;.push-type.liveactivity</code>). To update a running activity, start
        it with <code>{"{ push: true }"}</code>{" "}
        and push to its token (<code>liveActivityPushToken(id)</code>, or{" "}
        <code>onLiveActivityPushToken</code> for each token and rotation) with{" "}
        <code>"event": "update"</code> and a <code>content-state</code> that is the same object{" "}
        <code>updateLiveActivity</code>{" "}
        takes. To start one remotely (iOS 17.2 and later), push to the app's push-to-start token (
        <code>liveActivityPushToStartToken()</code>, which resolves <code>null</code>{" "}
        below 17.2 and off iOS, or <code>onLiveActivityPushToStartToken</code>) with{" "}
        <code>"event": "start"</code>, <code>"attributes-type": "DenextActivityAttributes"</code>,
        {" "}
        <code>{'"attributes": { "name": "Delivery", "values": { … } }'}</code> and a{" "}
        <code>content-state</code>. Tokens issued before your first listener are kept for it.
      </p>
      <p>
        <strong>On the web</strong>{" "}
        (and in a shell without the plugin) the share listener never fires and the widget functions
        resolve doing nothing, so shared code can call them; the Live Activity functions reject with
        {" "}
        <code>unsupported</code>, as they do on Android, except{" "}
        <code>liveActivityPushToStartToken</code> (<code>null</code>),{" "}
        <code>listLiveActivities</code> (<code>[]</code>) and the <code>on…</code>{" "}
        listeners (never called). React Native mode's <code>expo-widgets</code>{" "}
        shim runs on these same functions.
      </p>
      <p>
        <strong>App Groups.</strong>{" "}
        The share extension and the widgets exchange data with the app through an App Group:{" "}
        <code>--app-group</code>, by default{" "}
        <code>group.&lt;the app's bundle id&gt;</code>. denext writes{" "}
        <code>com.apple.security.application-groups</code>{" "}
        into the app's entitlements (setting the App target's Code Signing Entitlements to{" "}
        <code>App/App.entitlements</code> when it has none) and into each extension's, and{" "}
        <code>DenextAppGroup</code>{" "}
        into each Info.plist, where the native code reads it. The group must also exist in your
        Apple Developer account (Identifiers → App Groups) and be enabled on the app's App ID and
        the extensions' (<code>&lt;bundle id&gt;.share</code>,{" "}
        <code>&lt;bundle id&gt;.widgets</code>). Xcode's automatic signing, in the Signing &amp;
        Capabilities tab or with{" "}
        <code>xcodebuild -allowProvisioningUpdates</code>, usually registers the group and the
        extension App IDs for you. A Personal Team cannot sign App Groups or these extensions.
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
        <code>native_too_old</code>). <code>--native-fingerprint &lt;fp|auto&gt;</code>{" "}
        goes further: it names the exact native layer the UI was built for, and a binary that embeds
        a different one refuses it (code <code>native_mismatch</code>); see{" "}
        <a href="#native-fingerprint">Native fingerprint</a>.
      </p>
      <Code lang="bash">
        {`denext ota manifest out --sign ota.key --min-native 42   # sequence = now
denext ota manifest out --sign ota.key --sequence 1758700000`}
      </Code>
      <p>
        The signature is ECDSA P-256 / SHA-256, as standard base64 of the raw 64-byte{" "}
        <code>r‖s</code>, over these UTF-8 bytes (<code>\n</code>{" "}
        is one 0x0A byte, with no trailing newline). A manifest with a <code>sequence</code> and a
        {" "}
        <code>nativeFingerprint</code> is signed as v3, one with a <code>sequence</code>{" "}
        alone as v2 (byte-for-byte what denext 2.9 signed), one without as v1 (what denext 2.8
        signed); all three are accepted:
      </p>
      <Code lang="text">
        {`v3: denext-ota-v3\\n<version>\\n<1|0>\\n<sha256hex(notes)>\\n<sequence>\\n<minNative or empty>\\n<nativeFingerprint>
v2: denext-ota-v2\\n<version>\\n<1|0>\\n<sha256hex(notes)>\\n<sequence>\\n<minNative or empty>
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
          refuses an older <code>sequence</code> (code <code>downgrade</code>), a{" "}
          <code>minNative</code> above its build (code <code>native_too_old</code>), and a{" "}
          <code>nativeFingerprint</code> other than the one the binary embeds (code{" "}
          <code>native_mismatch</code>; only when both carry one).
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
          <code>native_too_old</code>: the app build is below the manifest's <code>minNative</code>;
        </li>
        <li>
          <code>native_mismatch</code>: the manifest's <code>nativeFingerprint</code>{" "}
          differs from the one the app binary embeds: the UI was built for another native layer.
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

      <h3 id="desktop-updates">Desktop UI self-updates</h3>
      <p>
        <code>denext/desktop/updater</code>{" "}
        does for a Deno Desktop app what OTA does for a phone: it pulls a newer signed UI (the
        export the window serves) without a new app build. It updates the UI only, never the binary:
        the code-signed bundle is left untouched, and the verified files go to an overlay in the
        app-support directory (macOS{" "}
        <code>~/Library/Application Support/&lt;appId&gt;/ui-updates</code>, Linux{" "}
        <code>$XDG_DATA_HOME</code> or <code>~/.local/share/&lt;appId&gt;/ui-updates</code>, Windows
        {" "}
        <code>%APPDATA%\&lt;appId&gt;\ui-updates</code>, or <code>dataDir</code>). A change to{" "}
        <code>desktop.ts</code>, its Deno-side code, or the denext runtime still needs a new binary.
      </p>
      <p>
        Pass the same config to <code>runDesktop({"{ updater }"})</code>{" "}
        and to the update calls. All of them run in the Deno process (<code>desktop.ts</code>), not
        in the page:
      </p>
      <Code lang="ts">
        {`import { runDesktop } from "denext/desktop";
import {
  applyDesktopUpdate,
  checkForDesktopUpdate,
  type DesktopUpdaterConfig,
  prepareDesktopUpdate,
} from "denext/desktop/updater";
import config from "./denext.config.ts";

const updater: DesktopUpdaterConfig = {
  feedUrl: "https://updates.example.com/desktop-ui", // serves the signed export
  publicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE…", // the contents of ota.key.pub
  appId: "com.example.app",
};

await runDesktop({ importMetaUrl: import.meta.url, proxy: config.spa?.proxy, updater });

// Stage a newer UI in the background; the window switches to it at the next launch.
try {
  const update = await checkForDesktopUpdate(updater);
  if (update.available) {
    const staged = await prepareDesktopUpdate(updater);
    await applyDesktopUpdate(staged.version, updater);
  }
} catch (err) {
  console.error("UI update failed:", err); // a DesktopUpdateError with a .code
}`}
      </Code>
      <ul>
        <li>
          <code>checkForDesktopUpdate(config)</code> fetches{" "}
          <code>{"${feedUrl}/_denext/ota.json"}</code>, verifies it, and resolves{" "}
          <code>{"{ available: false }"}</code> for the running version, else{" "}
          <code>available: true</code> with <code>version</code>, <code>required</code> and{" "}
          <code>notes</code>.
        </li>
        <li>
          <code>prepareDesktopUpdate(config)</code>{" "}
          downloads every file into a staging directory (copying the unchanged ones from the active
          overlay), checks each SHA-256, and resolves{" "}
          <code>{"{ version, required, notes }"}</code>. Any failure discards the staging directory.
        </li>
        <li>
          <code>applyDesktopUpdate(version, config)</code>{" "}
          re-verifies the staged files and flips the active pointer with an atomic rename. The page
          that is running keeps running; the next launch serves the new UI.
        </li>
        <li>
          <code>desktopUpdateStatus(config)</code> reports <code>current</code>,{" "}
          <code>pending</code>, <code>staged</code>, <code>rejected</code> and{" "}
          <code>highestSequence</code>; <code>desktopUpdateReset(config)</code>{" "}
          deletes the overlay and its state and goes back to the bundled export.
        </li>
      </ul>
      <p>
        <strong>Signing.</strong>{" "}
        The feed is the mobile OTA format, signed with the same ECDSA P-256 keys and tools:{" "}
        <code>denext ota keygen</code>, then <code>denext ota manifest out --sign ota.key</code> (or
        {" "}
        <code>DENEXT_OTA_SIGNING_KEY</code>), served by <code>createOtaHandler</code>{" "}
        or any server that follows the serving rules above. <code>publicKey</code>{" "}
        takes the base64 SPKI from <code>ota.key.pub</code> or a <code>PUBLIC KEY</code>{" "}
        PEM, and a signature is always required: an unsigned manifest is refused (
        <code>unsigned</code>), and so is one that does not verify (<code>signature</code>) or whose
        {" "}
        <code>version</code>{" "}
        does not match its file list (<code>integrity</code>). The updater sends no request headers,
        so the feed cannot sit behind the app's auth; it honours <code>HTTPS_PROXY</code> /{" "}
        <code>NO_PROXY</code>.
      </p>
      <p>
        <strong>The sequence only moves forward.</strong> A manifest whose <code>sequence</code>
        {" "}
        is not strictly greater than the highest one accepted, or that has none after a sequenced
        release, is refused (<code>downgrade</code>), so every release needs a new sequence (the
        default Unix time does that).
      </p>
      <p>
        <strong>Rollback.</strong> An applied version starts{" "}
        <em>pending</em>. The next launch serves it once and arms a boot marker; the script{" "}
        <code>runDesktop</code>{" "}
        injects into the page then sends a boot beacon when the page has loaded (a <code>POST</code>
        {" "}
        to <code>/_denext/desktop/booted</code>{" "}
        with the per-launch token), and that confirms it. If the app dies or quits before the
        beacon, the launch after rolls back to the previous overlay or the bundled export before
        serving anything, deletes the bad version, and refuses it (<code>rejected</code>, until{" "}
        <code>desktopUpdateReset</code>) along with its sequence. Unlike mobile, a pending version
        gets one trial launch.
      </p>

      <h3 id="native-fingerprint">Native fingerprint</h3>
      <p>
        Whether a change can ship over the air depends on whether it touched the native layer.{" "}
        <code>denext mobile fingerprint</code> answers that with one hash (the Expo equivalent is
        {" "}
        <code>@expo/fingerprint</code>): the same value means the installed binaries can run the new
        UI; a different one means a new app build.
      </p>
      <Code lang="bash">
        {`denext mobile fingerprint                         # the SHA-256, one line
denext mobile fingerprint --json > native.json    # { fingerprint, inputs: [...] }
denext mobile fingerprint --diff native.json      # which inputs changed since, and the verdict
denext mobile fingerprint --write                 # embed it in the native projects`}
      </Code>
      <p>
        It reads the Capacitor project at <code>--dir</code>{" "}
        (default: the current directory) and hashes:
      </p>
      <ul>
        <li>
          every file under <code>ios/</code> and{" "}
          <code>android/</code>, except build output and caches (<code>build/</code>,{" "}
          <code>DerivedData</code>, <code>Pods</code>, <code>.gradle</code>,{" "}
          <code>.cxx</code>, SwiftPM&apos;s{" "}
          <code>.build</code>), per-user and machine-local files (<code>xcuserdata</code>,{" "}
          <code>*.xcuserstate</code>, <code>local.properties</code>, <code>.idea</code>,{" "}
          <code>*.iml</code>,{" "}
          <code>.DS_Store</code>), signing material and build products (<code>*.jks</code>,{" "}
          <code>*.keystore</code>, <code>*.p12</code>, <code>*.mobileprovision</code>,{" "}
          <code>*.apk</code>, <code>*.aab</code>, <code>*.ipa</code>), and what{" "}
          <code>cap sync</code> copies in (the web UI in <code>App/public</code> and{" "}
          <code>assets/public</code>, the copied <code>capacitor.config.json</code>,{" "}
          <code>capacitor.plugins.json</code>,{" "}
          <code>config.xml</code>, and the generated Cordova plugin projects). Text files (no NUL
          byte in their first 8000 bytes) are hashed with CRLF turned into LF, so git&apos;s{" "}
          <code>autocrlf</code> on Windows does not change the result;
        </li>
        <li>
          <code>capacitor.config.*</code> without its <code>server</code> block, which{" "}
          <code>denext mobile dev</code>{" "}
          edits (a JSON config is compared by content, whatever its formatting);
        </li>
        <li>
          the installed version of <code>@capacitor/core</code>, <code>ios</code>,{" "}
          <code>android</code>, <code>cli</code>, and of every dependency or dev dependency in{" "}
          <code>package.json</code> that is a Capacitor plugin (a <code>@capacitor/</code>{" "}
          package, a <code>capacitor</code> field in its <code>package.json</code>, or a Cordova
          {" "}
          <code>plugin.xml</code>), resolved in <code>node_modules</code>{" "}
          from the project upwards as Node does. Other dependencies never count. Install packages
          first: a missing one prints a warning (and a missing <code>@capacitor/</code>{" "}
          package counts as <code>not installed</code>).
        </li>
      </ul>
      <p>
        The fingerprint is lowercase hex SHA-256 over the line{" "}
        <code>denext-native-fingerprint-v1</code> followed by one{" "}
        <code>&lt;key&gt;&lt;TAB&gt;&lt;sha256&gt;</code>{" "}
        line per input, sorted by key as the OTA version is: a file&apos;s key is its
        project-relative path, a package&apos;s is <code>npm:&lt;name&gt;</code>{" "}
        with the SHA-256 of its version. The same checkout gives the same value on any machine and
        in any directory.
      </p>
      <p>
        <strong>The gate.</strong> <code>--write</code>{" "}
        stores the fingerprint as the Info.plist string <code>DenextNativeFingerprint</code>{" "}
        and the AndroidManifest{" "}
        <code>
          {'<meta-data android:name="dev.denext.native.FINGERPRINT" android:value="…" />'}
        </code>, replacing an earlier value. Those two entries are left out of the hash, so writing
        them never changes it and a second run changes nothing. Stamp the matching manifest with
        {" "}
        <code>--native-fingerprint</code>, either the value itself or <code>auto</code>{" "}
        (computed for <code>--dir</code>):
      </p>
      <Code lang="bash">
        {`denext mobile fingerprint --write          # before building the binary
denext ota manifest out --sign ota.key --native-fingerprint auto --dir .`}
      </Code>
      <p>
        A binary whose embedded fingerprint differs from the manifest&apos;s refuses the UI before
        downloading (code <code>native_mismatch</code>, returned by <code>checkForUiUpdate</code>
        {" "}
        and{" "}
        <code>prepareUiUpdate</code>). When either side has no fingerprint, the check is skipped, so
        apps and manifests from before it keep working. In a signed manifest the fingerprint is part
        of the signed payload (v3), so it cannot be stripped or swapped.
      </p>
      <Callout kind="warn">
        <strong>Binaries built before the gate.</strong>{" "}
        An app binary whose OTA plugin predates the gate (template generation 3 or older, as written
        by denext 2.10.0-rc.2 and earlier) does not know the v3 payload: with a key embedded, it
        refuses a signed manifest that carries a fingerprint as <code>signature</code> (not{" "}
        <code>native_mismatch</code>), and it ignores the fingerprint of an unsigned one. Refusing
        is right (re-running <code>add-ota</code>{" "}
        to get the gate changes the native sources, so such a binary is on another native layer
        anyway); only the code differs. A version or build number committed to the native sources
        counts as a native change: set them on the build command line instead (see{" "}
        <a href="#building-in-ci">Building in CI</a>).
      </Callout>

      <h3 id="building-in-ci">Building in CI</h3>
      <p>
        <a href="https://github.com/Brainwires/denext/tree/main/examples/capacitor-ci">
          <code>examples/capacitor-ci</code>
        </a>{" "}
        is a GitHub Actions template built on the fingerprint. A <code>decide</code> job compares
        {" "}
        <code>denext mobile fingerprint</code>{" "}
        with the one recorded for the last binary release (the <code>native-fingerprint.json</code>
        {" "}
        asset of the newest <code>native-*</code> GitHub release) and picks one path:
      </p>
      <ul>
        <li>
          <strong>ota</strong> (unchanged): <code>denext export</code>, then{" "}
          <code>denext ota manifest --native-fingerprint &lt;fp&gt;</code> signed with the{" "}
          <code>DENEXT_OTA_SIGNING_KEY</code> secret, then your deploy step;
        </li>
        <li>
          <strong>binary</strong>{" "}
          (changed, or the first run): a macOS job imports the distribution certificate into a
          temporary keychain and runs <code>xcodebuild archive</code> and{" "}
          <code>-exportArchive</code>{" "}
          with an App Store Connect API key (<code>-authenticationKeyPath</code>), so automatic
          signing works without an Apple ID signed in to Xcode; an Ubuntu job runs{" "}
          <code>./gradlew bundleRelease</code>{" "}
          signed from a keystore secret. Both embed the fingerprint with{" "}
          <code>--write</code>, set the build number from the run on the command line, and a last
          job records the new fingerprint (with the <code>.ipa</code> and{" "}
          <code>.aab</code>) as a release.
        </li>
      </ul>
      <p>
        The example&apos;s README lists every secret and the one-time project changes. The run
        summary includes{" "}
        <code>denext mobile fingerprint --diff</code>, so a &quot;binary&quot; verdict shows which
        native input caused it.
      </p>

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
