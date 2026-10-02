import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Mobile (Capacitor)",
  description:
    "Ship a denext app to iOS and Android in a Capacitor shell: a quickstart, live reload on a device, the denext/mobile runtime and native capabilities, deep links and their association files, auth sessions, push (and sending it), store prompts, background tasks, process death, app extensions, signed over-the-air UI updates with channels and staged rollouts, the native fingerprint, the privacy manifest, App Store review, crash reporting, debugging on a device, CI, and testing.",
};

export default function Mobile() {
  return (
    <DocsShell
      active="mobile"
      title="Mobile (Capacitor)"
      lead="denext exports a static app, and a Capacitor shell ships that export to iOS and Android. denext/mobile is the client runtime for the shell (native capabilities with web fallbacks), denext mobile installs the native side, and the app can update its UI over the air from signed manifests without a new app build. For the Deno Desktop target, see Desktop apps; coming from React Native or Expo, start with the concept map."
    >
      <p>
        Coming from React Native or Expo? Read{" "}
        <a href="/docs/coming-from-react-native">Coming from React Native</a> for the concept map,
        {" "}
        <a href="/docs/vs-react-native">denext vs React Native</a>{" "}
        for who should switch (and who should not), and{" "}
        <a href="/docs/react-native">React Native / Expo apps</a> to build an existing Expo app with
        {" "}
        <code>denext migrate --from expo</code>. The desktop target (<code>denext desktop</code>,
        {" "}
        <code>denext/desktop/updater</code>) is on <a href="/docs/desktop">Desktop apps</a>.
      </p>
      <Callout kind="note">
        <strong>Platform status.</strong> iOS is verified on a physical iPhone: live reload with
        {" "}
        <code>denext mobile dev</code>, the capabilities{" "}
        <a href="https://github.com/Brainwires/denext/tree/main/examples/mobile">
          <code>examples/mobile</code>
        </a>{" "}
        exercises, push, deep links, auth sessions, the share extension, a configurable widget, a
        Live Activity (including one started by a push-to-start push) and a signed over-the-air
        update. The 2.11 surface ran on an iPhone 16e on 2026-09-27: the keyboard (a chat composer
        and a form), system bars following the theme, the system and in-page dialogs,
        pull-to-refresh, permissions and opening Settings, local notifications (actions and tap
        routing), geolocation, orientation lock, the privacy screen, the tracking prompt, the review
        sheet, saving to Photos, <code>VirtualList</code> (an exact <code>scrollToIndex</code>{" "}
        on 100,000 rows, flings without blank frames, a chat list, sticky headers) and the stack,
        tabs and sheet of{" "}
        <a href="/docs/navigation-native">native-feel navigation</a>. On 2026-09-28{" "}
        <a href="https://github.com/Brainwires/denext/tree/main/examples/native-views">
          <code>examples/native-views</code>
        </a>{" "}
        ran there: <a href="#native-views">native views</a> in a{" "}
        <code>VirtualList</code>, the video drawn under the page with AVKit&apos;s controls, a
        vertical swipe on it scrolling the list (<code>scrollPassthrough</code>), and the views kept
        across a Fast Refresh edit. The same day an Expo SDK 57 app in{" "}
        <a href="/docs/react-native">React Native mode</a>{" "}
        (<code>examples/expo-app</code>) ran there: its tabs, deep links (cold start and running),
        haptics, alerts and share, AsyncStorage kept across launches (on{" "}
        <a href="#durable-storage">durable storage</a>), a focused field scrolled above the
        keyboard, and the top safe-area inset applied after first paint. Built and unit-tested but
        not yet run on the phone: native modules, native context menus,{" "}
        <code>SystemIcon</code>, font scaling, biometrics, native sign-in, in-app purchases, crash
        reporting, background tasks and background location, and the bottom safe-area inset. Android
        is compiled and unit-tested, not run on a device: its halves of <code>denext/mobile</code>
        {" "}
        and of the generators have not run on Android at all, and a whole-app comparison ran on an
        emulator only. The details, and every open limit, are in{" "}
        <a href="/docs/limitations">Known limitations</a> (Desktop &amp; mobile) and{" "}
        <a href="https://github.com/Brainwires/denext/blob/main/REACT-NATIVE-EXPO.md">
          REACT-NATIVE-EXPO.md
        </a>.
      </Callout>

      <h2 id="quickstart">Quickstart: from an empty directory to a phone</h2>
      <p>
        You need Deno, Node.js (Capacitor&apos;s CLI is an npm package, and{" "}
        <code>denext mobile</code> runs it through{" "}
        <code>npx</code>), and the platform toolchains: Xcode for iOS, Android Studio for Android.
        The shell loads denext&apos;s static export (
        <code>denext export</code> →{" "}
        <code>out/</code>), so the app inside it is static files: route handlers, Server Actions and
        per-request rendering need a server the app calls over the network.
      </p>
      <p>
        <strong>1. Scaffold.</strong> <code>--capacitor</code> adds a{" "}
        <code>capacitor.config.ts</code>{" "}
        that bundles the export (<code>webDir: "out"</code>) into the native shells, a{" "}
        <code>package.json</code> pinning Capacitor 8 (<code>^8.5.2</code>), an <code>export</code>
        {" "}
        task and the <code>mobile:*</code> tasks. Add <code>--desktop</code>{" "}
        to scaffold the desktop target too. Change <code>appId</code> and <code>appName</code> in
        {" "}
        <code>capacitor.config.ts</code>{" "}
        before you add the platforms: the app id becomes the bundle id and the Android package name.
      </p>
      <Code lang="bash">
        {`deno run -A jsr:@denext/denext/cli create my-app --capacitor
cd my-app`}
      </Code>
      <p>
        <strong>2. Optional: a client-only app.</strong>{" "}
        The scaffold is an App Router app, exported to static HTML. An app that renders everything
        in the browser can use <a href="/docs/spa">SPA mode</a> instead, as{" "}
        <a href="https://github.com/Brainwires/denext/tree/main/examples/mobile">
          <code>examples/mobile</code>
        </a>{" "}
        does:
      </p>
      <Code lang="ts">
        {`// denext.config.ts
import type { DenextConfig } from "denext/server";

export default {
  mode: "spa",
  spa: {
    entry: "./src/main.tsx",
    // viewport-fit=cover lets the page draw under the notch; SAFE_AREA_CSS pads it back.
    head: \`<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />\`,
    precompress: false, // the webview loads files from the app bundle, never the .gz siblings
    ota: true, // stamp out/_denext/ota.json for over-the-air updates
  },
} satisfies DenextConfig;`}
      </Code>
      <p>
        <strong>3. Add the native platforms.</strong> Install the npm packages, export once so the
        {" "}
        <code>webDir</code> exists when Capacitor copies it, then add each platform once:
      </p>
      <Code lang="bash">
        {`deno install                # Capacitor's CLI + platforms are npm packages
deno task export            # out/
deno run -A --node-modules-dir npm:@capacitor/cli@^8.5.2 add ios       # once
deno run -A --node-modules-dir npm:@capacitor/cli@^8.5.2 add android   # once`}
      </Code>
      <p>
        <strong>4. Run it on a phone.</strong>{" "}
        Sync after every change to the web app, then run from the IDE:
      </p>
      <Code lang="bash">
        {`deno task mobile:sync       # export, stamp the OTA manifest, copy out/ into ios/ and android/
deno task mobile:ios        # open in Xcode: pick your team under Signing, choose the phone, Run
deno task mobile:android    # open in Android Studio`}
      </Code>
      <p>
        <strong>5. Live reload.</strong> Point the installed app at <code>denext dev</code>{" "}
        instead of the bundled export, so every edit reloads on the phone (the phone and the
        computer on the same Wi-Fi). On iOS the first session changes <code>Info.plist</code>
        , so run the app from Xcode once more;{" "}
        <a href="#live-reload-on-a-device">Live reload on a device</a> has the details.
      </p>
      <Code lang="bash">
        {`denext mobile dev --lan     # Ctrl-C puts capacitor.config back`}
      </Code>
      <p>
        <strong>6. Add native capabilities.</strong>{" "}
        Each one installs a Capacitor plugin (or writes denext&apos;s own native plugin) and wires
        the native project; the matching function in <code>denext/mobile</code>{" "}
        then works in the shell and falls back to a browser API on the web. A plugin is native code,
        so build and run the app again afterwards.
      </p>
      <Code lang="bash">
        {`denext mobile add --list
denext mobile add haptics share secure-store`}
      </Code>
      <p>
        Commit <code>ios/</code> and{" "}
        <code>android/</code>: Capacitor 8 builds iOS with Swift Package Manager, and the native
        projects are yours to edit. The scaffolded <code>.gitignore</code>{" "}
        ignores only their build outputs and the web assets <code>mobile:sync</code>{" "}
        copies in; Capacitor&apos;s own generated <code>.gitignore</code>{" "}
        files cover the rest. The webview loads files straight from the app bundle, so the export
        ships no precompressed <code>.gz</code>{" "}
        siblings: the App Router export never writes them, and a SPA-mode app turns them off with
        {" "}
        <code>{"spa: { precompress: false }"}</code>.
      </p>
      <Callout kind="note">
        A complete project wired for web + desktop + mobile is{" "}
        <a href="https://github.com/Brainwires/denext/tree/main/examples/native">
          <code>examples/native</code>
        </a>, and{" "}
        <a href="https://github.com/Brainwires/denext/tree/main/examples/mobile">
          <code>examples/mobile</code>
        </a>{" "}
        exercises every <code>denext/mobile</code>{" "}
        capability on one page, with the commands that made its shell. Native builds are
        experimental.
      </Callout>

      <h2 id="live-reload-on-a-device">Live reload on a device</h2>
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

      <h2 id="the-denextmobile-runtime">
        The <code>denext/mobile</code> runtime
      </h2>
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
import { useRouter, type VNodeChildren } from "denext";
import { isNativeShell, openExternal, useAppResume, useBackSwipe } from "denext/mobile";

export function Shell({ children }: { children: VNodeChildren }) {
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
          <code>"android"</code> or <code>"web"</code>). <code>runtimePlatform()</code>{" "}
          also tells a Deno Desktop window apart (<code>"desktop"</code>).
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
          <code>window.open</code> with <code>noopener</code> (in a Deno Desktop window with the
          {" "}
          <code>shell</code> capability, the OS opens it). Only http(s), <code>mailto:</code> and
          {" "}
          <code>tel:</code> URLs are allowed.
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
          <code>isBackSwipe(dx, dy)</code>{" "}
          is the pure test behind it. For a stack whose screen follows the finger (with the previous
          screen underneath), use <code>StackLayout</code> from <code>denext/navigation</code>; see
          {" "}
          <a href="/docs/navigation-native">Native-feel navigation</a>.
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
import type { VNodeChildren } from "denext";
import { SAFE_AREA_CSS } from "denext/mobile";

export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: VNodeChildren }) {
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

      <h2 id="native-capabilities">Native capabilities</h2>
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
        <code>npx cap sync</code>. The install runs in the Capacitor project folder. Before the web
        export exists (no <code>index.html</code> in the config&apos;s{" "}
        <code>webDir</code>), sync would stop at the missing folder, so it runs{" "}
        <code>npx cap update</code> instead (the native half of sync) and says what is left:{" "}
        <code>denext export</code>, then <code>npx cap sync</code>.
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
          web. <code>application</code> installs <code>@capacitor/app</code> and{" "}
          <code>@capacitor/device</code> together, the pair <code>expo-application</code>{" "}
          reads (name, id, version, build, and the vendor / Android id).
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
          <code>openSqlite(name)</code> (<code>sqlite</code>): a SQLite database with{" "}
          <code>exec</code> / <code>run</code> / <code>query</code>;{" "}
          <code>@capacitor-community/sqlite</code> on the device, and on the web the app&apos;s own
          {" "}
          <code>@sqlite.org/sqlite-wasm</code>{" "}
          on the Origin Private File System (install it yourself; without it <code>openSqlite</code>
          {" "}
          reports the engine is missing).
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
          (<code>camera</code>, which also writes the camera, photo-library and microphone usage
          strings; the microphone one is for video recorded in the page) and{" "}
          <code>pickDocument({"{ types }"})</code> (<code>document-picker</code>): resolve{" "}
          <code>null</code> when the user cancels; a hidden file input on the web.
        </li>
        <li id="picked-files-and-folders">
          Picked files and folders: in a Deno Desktop window and in browsers with the File System
          Access API, <code>pickDocument</code>, <code>saveFile</code> and <code>pickFolder</code>
          {" "}
          return an opaque <code>handle</code> (the <code>path</code>{" "}
          is display-only), and the file functions reach the item with{" "}
          <code>{"{ directory: { picked: handle } }"}</code> (see{" "}
          <a href="/docs/desktop#picked-files-and-folders">Picked files and folders</a>). The
          iOS/Android pickers return a copy's <code>path</code> and no handle, and a{" "}
          <code>{"{ picked }"}</code> directory rejects <code>unavailable</code>{" "}
          in the shell: read a picked document with <code>readData: true</code>.
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
        uses for its in-app browser. Three capabilities install the plugins behind{" "}
        <a href="/docs/react-native#react-native-apis">React Native mode</a>&apos;s system UI, each
        with an in-page fallback when its plugin is missing: <code>dialog</code>{" "}
        (<code>@capacitor/dialog</code>: <code>Alert.alert</code> and <code>Alert.prompt</code>),
        {" "}
        <code>toast</code> (<code>@capacitor/toast</code> ^8.0.1: <code>ToastAndroid.show</code>
        {" "}
        as the system toast on Android) and <code>action-sheet</code>{" "}
        (<code>@capacitor/action-sheet</code> ^8.1.1:{" "}
        <code>ActionSheetIOS.showActionSheetWithOptions</code>{" "}
        as a native sheet). None needs a usage string, a permission or a privacy-manifest entry. A
        new plugin is native code: ship a new app binary afterwards.
      </p>

      <h2 id="keyboard-back-system-bars">Keyboard, back, system bars and safe areas</h2>
      <p>
        Four things a phone app needs that a browser tab mostly doesn&apos;t: staying clear of the
        on-screen keyboard, Android&apos;s back button and back gesture, the status and navigation
        bars, and the insets around the notch and the home indicator. Each works in the browser too,
        so the same component runs everywhere.
      </p>
      <Code lang="bash">
        {`denext mobile add keyboard back system-bars`}
      </Code>

      <h3 id="keyboard">Keyboard</h3>
      <p>
        <code>useKeyboard()</code> returns <code>{"{ visible, height, animationDuration? }"}</code>
        {" "}
        (and <code>onKeyboardChange(cb)</code>{" "}
        does the same outside components). In the shell it follows{" "}
        <code>@capacitor/keyboard</code>&apos;s <code>keyboardWillShow</code> /{" "}
        <code>keyboardWillHide</code>, so it knows before the keyboard moves; iOS reports
        UIKit&apos;s 250 ms animation, Android fires its will- and did- events together and reports
        none. On the web it reads <code>navigator.virtualKeyboard</code> when the page set its{" "}
        <code>overlaysContent</code>, else the visual viewport (a loss of 100 px or more counts as a
        keyboard), which only changes once the keyboard is up.
      </p>
      <ul>
        <li>
          <code>&lt;KeyboardAvoidingView behavior="padding"&gt;</code>{" "}
          (React Native&apos;s component) makes room for the keyboard: <code>"padding"</code>{" "}
          adds bottom padding, <code>"height"</code> shrinks the view (from its{" "}
          <code>style.height</code>, else <code>100%</code>), <code>"position"</code>{" "}
          moves it up with a <code>translateY</code>. <code>keyboardVerticalOffset</code>{" "}
          ignores a fixed amount, such as a bottom bar the keyboard hides anyway.
        </li>
        <li>
          <code>&lt;KeyboardStickyView offset={"{{ closed, opened }}"}&gt;</code>{" "}
          rides on top of the keyboard. Position it at the bottom yourself; the view only adds a
          {" "}
          <code>translateY</code>. <code>offset</code> works as in{" "}
          <code>react-native-keyboard-controller</code>: positive values move it down (give{" "}
          <code>opened</code> the height of a tab bar the keyboard covers).
        </li>
        <li>
          <code>hideKeyboard()</code> dismisses it (the plugin, else blurring the focused element);
          {" "}
          <code>setKeyboardResizeMode(mode)</code> changes how the iOS shell resizes (iOS only).
        </li>
      </ul>
      <p>
        Both views move only by the part of the keyboard that <em>covers</em>{" "}
        the page. Where the WebView resizes itself around the keyboard (always on Android, and on
        iOS with the plugin&apos;s default{" "}
        <code>resize: "native"</code>) that is zero and they leave layout alone, so nothing is
        lifted twice. For a composer that moves in step with the iOS keyboard, set{" "}
        <code>resize: "none"</code>{" "}
        (the keyboard then covers the page, and the views follow its will-show events with its own
        duration):
      </p>
      <Code lang="ts">
        {`// capacitor.config.ts
plugins: { Keyboard: { resize: "none" } },`}
      </Code>
      <p>
        While a <code>KeyboardAvoidingView</code> or <code>KeyboardStickyView</code>{" "}
        is mounted (React Native mode&apos;s <code>KeyboardAvoidingView</code>{" "}
        too), the focused text field is kept above the keyboard. WebKit scrolls a field into view
        when it gains focus, before the keyboard is up, so a field near the bottom of an inner
        scroller could end under the keyboard. The views re-check after every viewport resize,
        keyboard change and focus, and scroll a covered field up through its scrolling ancestors
        (innermost first, then the page), leaving a 12 px gap. The scroll is smooth and runs with
        the keyboard&apos;s own animation; it is instant when the user asked for reduced motion. A
        field taller than the visible area keeps its top in view. Without one of these views
        mounted, nothing scrolls on the keyboard&apos;s behalf.
      </p>
      <p>
        <strong>Recipe: a chat composer.</strong>{" "}
        The message list fills the screen and scrolls; the composer sits on the keyboard.
      </p>
      <Code lang="tsx">
        {`"use client";
import { KeyboardStickyView, useKeyboard, useSafeAreaInsets } from "denext/mobile";

export function Chat({ messages }: { messages: { id: string; text: string }[] }) {
  const { visible } = useKeyboard();
  const { bottom } = useSafeAreaInsets();
  const composer = 56; // px
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      {/* column-reverse keeps the list anchored at the newest message */}
      <ol style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column-reverse",
                   paddingBottom: composer + (visible ? 0 : bottom) }}>
        {[...messages].reverse().map((m) => <li key={m.id}>{m.text}</li>)}
      </ol>
      <KeyboardStickyView
        style={{ position: "fixed", left: 0, right: 0, bottom: 0, height: composer,
                 paddingBottom: visible ? 0 : bottom }}
      >
        <textarea enterKeyHint="send" placeholder="Message" />
      </KeyboardStickyView>
    </div>
  );
}`}
      </Code>
      <p>
        The list stays pinned to its end with <code>column-reverse</code>{" "}
        here; for long histories use <code>VirtualList</code> with <code>anchor="end"</code> and
        {" "}
        <code>keyboardInset</code>{" "}
        (<a href="/docs/lists#chat">Lists &amp; scrolling</a>). The iMessage-style swipe-down that
        drags the keyboard away is not available to a WebView&apos;s inner scrollers.
      </p>

      <h3 id="android-back">Android back and predictive back</h3>
      <p>
        <code>StackLayout</code> and <code>Sheet</code> from <code>denext/navigation</code>{" "}
        already use these: back pops the stack (or closes the sheet), and the predictive-back
        gesture previews the pop. See{" "}
        <a href="/docs/navigation-native#gestures">Native-feel navigation</a>. The APIs below are
        for your own screens and overlays.
      </p>
      <p>
        <code>onBack(handler)</code> / <code>useBackHandler(handler, enabled?)</code>{" "}
        register a handler on a stack, like React Native&apos;s{" "}
        <code>BackHandler</code>: the newest runs first, and returning <code>true</code>{" "}
        consumes the back. When none does, the default runs: history back when there is somewhere to
        go, else the app leaves the foreground (<code>@capacitor/app</code>&apos;s{" "}
        <code>minimizeApp</code>, <code>exitApp</code> where that is missing).
      </p>
      <Code lang="tsx">
        {`"use client";
import type { VNodeChildren } from "denext";
import { useBackHandler, useBackProgress } from "denext/mobile";

export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: VNodeChildren }) {
  useBackHandler(() => (onClose(), true), open); // back closes the sheet first
  const gesture = useBackProgress(); // { progress, edge } while a predictive back is in flight
  const scale = gesture ? 1 - gesture.progress * 0.1 : 1;
  return open ? <div role="dialog" style={{ transform: \`scale(\${scale})\` }}>{children}</div> : null;
}`}
      </Code>
      <ul>
        <li>
          <strong>Android</strong>: <code>denext mobile add back</code> installs{" "}
          <code>@capacitor/app</code> and denext&apos;s <code>DenextBack</code>{" "}
          plugin, registered from the MainActivity denext composes, and sets{" "}
          <code>android:enableOnBackInvokedCallback="true"</code> on{" "}
          <code>&lt;application&gt;</code>{" "}
          (Android 13 to 15 need it; an app&apos;s own value is kept). Its{" "}
          <code>OnBackPressedCallback</code>{" "}
          is enabled only while a handler (or a progress listener) is registered, so otherwise the
          system&apos;s predictive back-to-home animation plays. <code>onBackProgress(cb)</code> /
          {" "}
          <code>useBackProgress()</code>{" "}
          report the gesture on Android 14+: start, progress from 0 to 1 with the edge it started
          from, then cancel or commit. With only <code>@capacitor/app</code>{" "}
          installed, the handlers still run, from its <code>backButton</code>{" "}
          event, without progress.
        </li>
        <li>
          <strong>iOS</strong>: nothing is registered; there is no back button, and swipe-back
          belongs to the navigation.
        </li>
        <li>
          <strong>Web</strong>: while a handler is registered, a same-URL history entry sits on top
          of the page&apos;s, so the browser&apos;s back button pops it and the handlers run before
          the router sees anything. An unconsumed back then goes back for real. Browsers with the
          Navigation API re-add the entry after a soft navigation; elsewhere, register handlers in
          the page that uses them.
        </li>
      </ul>

      <h3 id="system-bars">System bars</h3>
      <p>
        <code>setSystemBars({"{ style, hidden, animation, bar }"})</code> drives Capacitor 8&apos;s
        {" "}
        <code>SystemBars</code>, which ships in <code>@capacitor/core</code>. <code>style</code>
        {" "}
        names the theme the bars sit over: <code>"dark"</code> for a dark app (light icons),{" "}
        <code>"light"</code> for a light one, <code>"auto"</code>{" "}
        for the device&apos;s appearance. (<code>expo-status-bar</code>&apos;s <code>style</code>
        {" "}
        names the icons&apos; color instead, the other way round.) <code>hidden</code>{" "}
        hides or shows them, <code>animation</code> (<code>"fade"</code> /{" "}
        <code>"none"</code>) is iOS only, and <code>bar</code> (<code>"status"</code> /{" "}
        <code>"navigation"</code>) limits the change to one bar. On the web it does nothing.
      </p>
      <p>
        <code>useSystemBarsFollowTheme()</code>{" "}
        keeps the bars on the page&apos;s theme, re-applied on every change: the root element&apos;s
        {" "}
        <code>color-scheme</code> when it names one (a theme toggle that sets it, or{" "}
        <code>Appearance.setColorScheme</code> in react-native mode), else{" "}
        <code>prefers-color-scheme</code>. Pass the theme instead when the app decides it:{" "}
        <code>useSystemBarsFollowTheme(theme)</code>.
      </p>
      <p>
        <code>denext mobile add system-bars</code> installs no package. It sets{" "}
        <code>UIViewControllerBasedStatusBarAppearance</code>{" "}
        in Info.plist (SystemBars needs it) and adds <code>EdgeToEdge.enable(this)</code>{" "}
        to the MainActivity, so the app draws edge to edge with transparent bars on every Android
        version, as Android 15 and 16 enforce for current target SDKs. Pad for the bars with the
        safe areas below.
      </p>

      <h3 id="safe-areas">Safe areas</h3>
      <p>
        <code>SAFE_AREA_CSS</code> (above) and <code>useSafeAreaInsets()</code>{" "}
        read the same values: the <code>--safe-area-inset-*</code>{" "}
        custom properties Capacitor 8 injects on Android (its default{" "}
        <code>insetsHandling: "css"</code>) when they are set, else{" "}
        <code>env(safe-area-inset-*)</code>. The injected values matter because Android WebView
        before 140 reports wrong <code>env()</code> insets; on iOS and the web they are unset and
        {" "}
        <code>env()</code> applies.
      </p>
      <ul>
        <li>
          For layout, use <code>SAFE_AREA_CSS</code>&apos;s <code>--denext-safe-*</code>{" "}
          variables: CSS applies them without a render.
        </li>
        <li>
          When JavaScript needs the numbers (a sheet&apos;s resting height, a canvas, a
          gesture&apos;s edge zone), <code>useSafeAreaInsets()</code> returns{" "}
          <code>{"{ top, right, bottom, left }"}</code>{" "}
          in px, updated on rotation, resizes and when Capacitor updates its values (on Android the
          bottom inset drops to 0 while the keyboard is up).
        </li>
        <li>
          Outside a component (a store, an imperative animation), <code>readSafeAreaInsets()</code>
          {" "}
          returns the same numbers once (zeros during server rendering), and{" "}
          <code>watchSafeAreaInsets(cb)</code> calls <code>cb</code>{" "}
          at once with the current insets, then on rotation, resizes, visual-viewport changes and
          Capacitor&apos;s inset updates, at most once per frame and only when a value changed. It
          returns a function that stops it.
        </li>
      </ul>
      <p>
        Both need <code>viewport-fit=cover</code> in the viewport meta.
      </p>

      <h2 id="pull-to-refresh">Pull to refresh</h2>
      <p>
        <code>&lt;PullToRefresh&gt;</code> is a scrolling <code>&lt;div&gt;</code>{" "}
        with the pull-to-refresh gesture and spinner. Pull down from the top past{" "}
        <code>threshold</code> (default 64 px) and let go to call <code>onRefresh</code>; set{" "}
        <code>refreshing</code> to <code>true</code> there and back to <code>false</code>{" "}
        when the data arrives, as with React Native&apos;s{" "}
        <code>RefreshControl</code>. It needs no plugin and works the same in a browser. In the
        native shell, arming the pull plays a light haptic tick.
      </p>
      <Code lang="tsx">
        {`"use client";
import { useState } from "denext";
import { PullToRefresh } from "denext/mobile";

export function Inbox({ load }: { load: () => Promise<void> }) {
  const [refreshing, setRefreshing] = useState(false);
  return (
    <PullToRefresh
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
      }}
      style={{ height: "100dvh" }}
    >
      <ul>…</ul>
    </PullToRefresh>
  );
}`}
      </Code>
      <ul>
        <li>
          The component is the scroll container (<code>overflow-y: auto</code>, with{" "}
          <code>overscroll-behavior-y: contain</code>{" "}
          so the browser&apos;s own pull-to-refresh stays out of the way), so give it a height:{" "}
          <code>100dvh</code> or a flex parent.
        </li>
        <li>
          The gesture reads touch events only. Mouse and keyboard users get no gesture, so give them
          a refresh button too. It never writes the scroll position and cancels a touch only while
          it is pulling at the top, so momentum scrolling and rubber-banding elsewhere are
          untouched.
        </li>
        <li>
          Options: <code>enabled</code>, <code>offset</code>{" "}
          (where the spinner rests, default 16 px), <code>color</code>, <code>background</code>,
          {" "}
          <code>title</code> / <code>titleColor</code> (a line under the spinner) and{" "}
          <code>label</code> (the accessible name while refreshing, default{" "}
          <code>"Refreshing"</code>). Any other prop goes to the <code>&lt;div&gt;</code>.
        </li>
      </ul>
      <p>
        For a list, pass <code>RefreshControl</code>{" "}
        (the same gesture and spinner, with React Native&apos;s prop names:{" "}
        <code>progressViewOffset</code>, <code>tintColor</code>, <code>colors</code>, …) to{" "}
        <code>VirtualList</code>&apos;s <code>refreshControl</code>{" "}
        prop. The list renders it around its scroller and passes it <code>refreshing</code>,{" "}
        <code>onRefresh</code> and <code>progressViewOffset</code>{" "}
        (<a href="/docs/lists#pull-to-refresh">Lists &amp; scrolling</a>). React Native mode&apos;s
        {" "}
        <code>RefreshControl</code> is this component.
      </p>

      <h2 id="native-views">Native views in the layout</h2>
      <p>
        <code>NativeViewSlot</code>{" "}
        reserves a box in the page and keeps a native view on it: a map, a video player with the
        system controls, a camera preview, or any view type your app registers natively. The page
        scrolls, clips and covers the slot like any other box; its children are the web fallback,
        rendered on the web, during SSR, and in a shell without the plugin or without that view
        type. <code>denext mobile add native-views</code> installs the{" "}
        <code>DenextNativeViews</code>{" "}
        plugin (Swift and Java, registered like the other denext plugins) with the built-in{" "}
        <code>video</code> view; <code>denext mobile add native-map</code> adds <code>map</code>
        {" "}
        (MapKit on iOS, OpenStreetMap through osmdroid on Android, neither with an API key).
      </p>
      <Code lang="tsx">
        {`import { NativeViewSlot } from "denext/mobile";

<NativeViewSlot
  type="map"
  props={{ latitude: 51.5, longitude: -0.12, zoom: 12, markers: [{ latitude: 51.5, longitude: -0.12, title: "Here" }] }}
  onEvent={(name, data) => name === "regionChange" && console.log(data)}
  onCommand={(command) => (recenter.current = command)} // command("setRegion", { … })
  overlay={<button style={{ position: "absolute", right: 8, bottom: 8, pointerEvents: "auto" }}>Recenter</button>}
  style={{ height: 280, borderRadius: 12, overflow: "hidden" }}
>
  <img src="/static-map.png" alt="Map of London" /> {/* the web fallback */}
</NativeViewSlot>`}
      </Code>
      <p>
        <code>overlay</code>{" "}
        is DOM drawn over the native view; touches on its elements stay in the page, and every other
        touch over the slot&apos;s visible part reaches the native view.{" "}
        <code>useNativeViewSlot(type, options)</code>{" "}
        is the same as a hook for a slot element you render yourself (it returns the refs,{" "}
        <code>status</code>, <code>placement</code> and <code>command</code>).
      </p>
      <p>
        <code>scrollPassthrough</code> (iOS and Android) decides which drags that start on an{" "}
        <code>"under"</code> or <code>"over"</code> view scroll the page instead:{" "}
        <code>"vertical"</code> (the default for{" "}
        <code>video</code>: a mostly vertical drag scrolls the list, with the page&apos;s own
        momentum and bounce, while taps and horizontal scrubs stay the player&apos;s),{" "}
        <code>"horizontal"</code>, or <code>"none"</code>{" "}
        (the default otherwise, so a map pans on any drag). The slot gets the matching CSS{" "}
        <code>touch-action</code>. On Android a drag that passes the touch slop along that axis is
        handed to the WebView from where it started, so the page scrolls with its own fling
        (compile-verified, not yet run on an Android device).
      </p>
      <p>
        Where the view is drawn (<code>placement</code>, default <code>"auto"</code>):
      </p>
      <ul>
        <li>
          <code>"embed"</code>{" "}
          (iOS, the default there): the view is added to the native scroll view WebKit backs the
          slot&apos;s <code>overflow: scroll</code> element with, the approach of{" "}
          <code>@capacitor/google-maps</code>. The compositor moves, clips and transforms it with
          the page (scrolling, CSS transforms and animations included, with no lag), and page
          content drawn later (a sticky header, a modal) covers it. If WebKit does not back the
          element with a scroll view within 2 s, it falls back to <code>"over"</code>.
        </li>
        <li>
          <code>"over"</code>{" "}
          (the default on Android): the view is drawn above the WebView, clipped to the part of the
          slot its scrolling ancestors and the viewport leave visible. It needs nothing from the
          page, but no DOM can draw over it: while page content covers any part of the slot (a
          sheet, a modal, a sticky header) the view hides.
        </li>
        <li>
          <code>"under"</code>{" "}
          : the view is drawn behind the WebView, which is made transparent, and seen through the
          slot. DOM over the slot draws above it. The slot and every ancestor must be transparent
          where the slot is (a dev warning names the first one that is not); a touch over the
          visible part is handed to the view unless page content covers the slot.
        </li>
      </ul>
      <p>
        For <code>"under"</code> and <code>"over"</code>{" "}
        the page sends each slot&apos;s box in the content coordinates of the container it scrolls
        with (its nearest scrolling ancestor, or the document), which scrolling does not change. On
        iOS the plugin finds that container&apos;s native scroll view and follows its offset itself,
        in the same frame as the scroll, so fling and momentum keep the view on its slot with no
        message from the page. On Android the WebView&apos;s own scroll is followed the same way,
        but a scrolling element inside the page has no native scroll view there: the page sends its
        measurement each frame it scrolls, and the view trails its slot by a frame or two (see{" "}
        <a href="/docs/limitations">Known limitations</a>). Layout changes (a resize, the keyboard,
        content inserted above, a CSS transition) are measured each animation frame while they
        happen and every 250 ms otherwise. A slot unmounted by a virtualized list destroys its view,
        and a new one is made when it scrolls back.
      </p>
      <p>
        The built-in views. <code>video</code>: props <code>src</code> (an absolute URL),{" "}
        <code>autoplay</code>, <code>loop</code>, <code>muted</code>, <code>controls</code>{" "}
        (default true), <code>fit</code> (<code>"contain"</code> or{" "}
        <code>"cover"</code>, iOS); events <code>ready</code>, <code>play</code>,{" "}
        <code>pause</code>, <code>ended</code>, <code>error</code>; commands <code>play</code>,{" "}
        <code>pause</code>, <code>seek</code>, <code>status</code>. On iOS it is an{" "}
        <code>AVPlayerViewController</code>{" "}
        with the system controls, contained in the app&apos;s view controller, and{" "}
        <code>"auto"</code> draws it <code>"under"</code>{" "}
        the WebView (a plain UIKit hierarchy that follows the page&apos;s scrolling in the same
        frame), so page content drawn over the slot covers it and its full-screen button and exit
        are AVKit&apos;s own; controls inside WebKit&apos;s scroll view (<code>"embed"</code>) do
        not complete a tap. The slot and its ancestors must be transparent there (a dev warning
        names an opaque one). On Android it is a <code>VideoView</code> with the system{" "}
        <code>MediaController</code>. <code>map</code>: props <code>latitude</code>,{" "}
        <code>longitude</code>, <code>zoom</code> (0 to 20), <code>markers</code>,{" "}
        <code>mapType</code> (iOS), <code>interactive</code>; events <code>regionChange</code>,{" "}
        <code>markerPress</code>; command <code>setRegion</code>. The map moves only when{" "}
        <code>latitude</code>, <code>longitude</code> or <code>zoom</code>{" "}
        change, so a pan is not undone by other props. OpenStreetMap&apos;s tile servers are for
        light use: point a production Android app at its own tile source.
      </p>
      <h3 id="your-own-native-view">Your own native view</h3>
      <p>
        A view type is a factory registered with the plugin. On iOS, a class conforming to{" "}
        <code>DenextNativeViewFactory</code> (every method runs on the main thread):
      </p>
      <Code lang="swift">
        {`import UIKit

@objc(ChartViewFactory)
final class ChartViewFactory: NSObject, DenextNativeViewFactory {
    func makeView(context: DenextNativeViewContext, props: [String: Any]) -> UIView {
        let chart = ChartView()
        chart.onSelect = { index in context.emit("select", ["index": index]) }
        chart.values = props["values"] as? [Double] ?? []
        return chart
    }
    func updateView(_ view: UIView, props: [String: Any]) {
        (view as? ChartView)?.values = props["values"] as? [Double] ?? []
    }
    // Optional: command(_:name:args:) -> [String: Any]? and destroyView(_:).
}`}
      </Code>
      <p>
        On Android, a class implementing <code>DenextNativeViewFactory</code>:
      </p>
      <Code lang="java">
        {`package com.example.app;

import android.view.View;
import com.getcapacitor.JSObject;
import dev.denext.nativeviews.DenextNativeViewContext;
import dev.denext.nativeviews.DenextNativeViewFactory;

public class ChartViewFactory implements DenextNativeViewFactory {
    @Override public View create(DenextNativeViewContext context, JSObject props) {
        ChartView chart = new ChartView(context.getActivity());
        chart.setValues(props.optJSONArray("values"));
        return chart;
    }
    @Override public void update(View view, JSObject props) {
        ((ChartView) view).setValues(props.optJSONArray("values"));
    }
    // Optional: command(view, name, args), lifecycle(view, resumed), destroy(view).
}`}
      </Code>
      <p>
        Register it by name in <code>capacitor.config</code>{" "}
        (the plugin creates it with its no-argument constructor), or in code before the page makes a
        view (<code>DenextNativeViews.register("chart", ChartViewFactory())</code> in{" "}
        <code>AppDelegate</code>;{" "}
        <code>DenextNativeViews.register("chart", new ChartViewFactory())</code> in{" "}
        <code>MainActivity.onCreate</code>):
      </p>
      <Code lang="json">
        {`{
  "plugins": {
    "DenextNativeViews": {
      "factories": { "chart": "ChartViewFactory" }
    }
  }
}`}
      </Code>
      <p>
        On iOS the name is the class&apos;s Objective-C name (give it{" "}
        <code>@objc(Name)</code>); on Android the fully qualified class name (<code>
          com.example.app.ChartViewFactory
        </code>). Then <code>&lt;NativeViewSlot type="chart" props=…&gt;</code>{" "}
        places it. The example app{" "}
        <a href="https://github.com/Brainwires/denext/tree/main/examples/native-views">
          <code>examples/native-views</code>
        </a>{" "}
        puts two maps and a video in a scrolling <code>VirtualList</code>.
      </p>

      <h2 id="context-menus">Context menus</h2>
      <p>
        <code>denext mobile add context-menu</code> installs denext&apos;s native{" "}
        <code>DenextContextMenu</code>{" "}
        plugin (no npm package). With it, the shell shows the platform&apos;s own menus:
      </p>
      <ul>
        <li>
          <strong>
            <code>useContextMenu(items, onSelect)</code>
          </strong>{" "}
          (or{" "}
          <code>attachContextMenu(el, items, onSelect)</code>) binds a menu to an element. On iOS it
          is the system{" "}
          <code>UIContextMenuInteraction</code>: a press arms the native side with the
          element&apos;s rect and items, and the system long press lifts a snapshot of the element
          (clipped to its corner radius), plays the system haptic and shows the{" "}
          <code>UIMenu</code>; a secondary click on iPad opens it too. On Android a 500 ms long
          press opens a Material <code>PopupMenu</code>{" "}
          at the finger with the long-press haptic. On the web a long press or a right click opens
          the in-page popover.
        </li>
        <li>
          <strong>
            <code>showContextMenu(items, {"{ x, y }"})</code>
          </strong>{" "}
          opens a menu from code and resolves the chosen <code>id</code> (<code>null</code>{" "}
          when dismissed): a <code>UIMenu</code>{" "}
          at the point on iOS 16+ (the edit-menu presentation; an action sheet on iOS 15), the{" "}
          <code>PopupMenu</code> on Android, the popover elsewhere.
        </li>
      </ul>
      <p>
        An item is <code>{"{ id, label }"}</code> plus <code>systemIcon</code>{" "}
        (an SF Symbol name for the iOS menu), <code>icon</code> (a glyph for the popover),{" "}
        <code>subtitle</code>, <code>destructive</code>, <code>disabled</code> and{" "}
        <code>children</code>{" "}
        (a submenu). iOS nests submenus; Android and the popover list a submenu&apos;s items as a
        labelled group (a Deno Desktop window shows the popover too), so no item is ever out of
        reach.
      </p>
      <Code lang="tsx">
        {`"use client";
import { useContextMenu } from "denext/mobile";

export function MessageRow({ message, act }: {
  message: { id: string; text: string };
  act: (action: string, id: string) => void;
}) {
  const menu = useContextMenu(
    [
      { id: "reply", label: "Reply", systemIcon: "arrowshape.turn.up.left" },
      { id: "copy", label: "Copy", systemIcon: "doc.on.doc" },
      {
        id: "move",
        label: "Move to",
        systemIcon: "folder",
        children: [
          { id: "inbox", label: "Inbox" },
          { id: "archive", label: "Archive", subtitle: "Out of the inbox, kept" },
        ],
      },
      { id: "delete", label: "Delete", systemIcon: "trash", destructive: true },
    ],
    (id) => act(id, message.id),
    { title: "Message" },
  );
  return <div ref={menu} style={{ borderRadius: 12 }}>{message.text}</div>;
}`}
      </Code>
      <p>
        The items and the handler are read when the menu opens, so they can change every render.
        While bound, the element has <code>-webkit-touch-callout</code> and <code>user-select</code>
        {" "}
        set to <code>none</code>{" "}
        (WebKit&apos;s own link preview and text selection would fight the menu). The popover
        renders <code>role="menu"</code> with a <code>role="menuitem"</code>{" "}
        per item (a submenu is a <code>role="group"</code>{" "}
        labelled by its item), is keyboard navigable (Up / Down, Enter or Space, Escape), dismisses
        on a press outside, and sets only its position: style it through <code>[role="menu"]</code>
        {" "}
        and <code>[role="menuitem"]</code> in your CSS (a <code>disabled</code> item carries{" "}
        <code>aria-disabled</code>, a <code>destructive</code> one{" "}
        <code>data-destructive</code>). Both are SSR-safe: importing them runs nothing.
      </p>

      <h2 id="system-icons">System icons</h2>
      <p>
        <code>{'<SystemIcon name="square.and.arrow.up" android="share" />'}</code>{" "}
        draws the platform&apos;s own icon. In the iOS shell with{" "}
        <code>denext mobile add system-icons</code> it is the real SF Symbol: the{" "}
        <code>DenextSystemIcon</code> plugin renders it with <code>UIImage(systemName:)</code>{" "}
        at the requested weight and scale and the device&apos;s pixel density, and the page uses it
        as a mask filled with the CSS <code>color</code>{" "}
        (so it follows the text color, dark mode and hover). Every render is cached natively and in
        the page. Everywhere else (Android, the web, a desktop window, SSR) it is a Material Symbol
        drawn as inline SVG.
      </p>
      <Code lang="tsx">
        {`"use client";
import { SystemIcon } from "denext/mobile";

<SystemIcon name="house.fill" size={26} />                 // Material: home-fill (mapped)
<SystemIcon name="bell" weight="semibold" label="Alerts" /> // role="img" with a name
<SystemIcon name="cloud.sun.fill" mode="multicolor" android="partly_cloudy_day" />`}
      </Code>
      <ul>
        <li>
          <code>size</code> (CSS px, default 24), <code>weight</code> (<code>ultralight</code> …
          {" "}
          <code>black</code>), <code>scale</code>, <code>color</code>, and <code>mode</code>:{" "}
          <code>monochrome</code> (the default mask), <code>hierarchical</code>,{" "}
          <code>palette</code> (<code>colors</code>) or <code>multicolor</code>.
        </li>
        <li>
          Without{" "}
          <code>android</code>, the Material Symbol is mapped from the SF Symbol name for the common
          icons (<code>house</code> → <code>home</code>, <code>square.and.arrow.up</code> →{" "}
          <code>share</code>, a <code>.fill</code> suffix to the <code>-fill</code>{" "}
          variant). denext ships about 75 common Material Symbols (Apache 2.0);{" "}
          <code>registerSystemIcons({"{ name: pathData }"})</code> adds any other from{" "}
          <code>@material-symbols/svg-400</code>.
        </li>
        <li>
          The server renders the Material Symbol, so the markup always hydrates; in the iOS shell
          the SF Symbol replaces it before paint once cached, and the box is hidden for the one
          bridge round trip of a first render. <code>preloadSystemIcons([...])</code>{" "}
          at startup warms the icons of the first screen.
        </li>
        <li>
          <strong>Why no SF Symbols SVGs:</strong>{" "}
          Apple licenses SF Symbols for use in apps on Apple platforms only, so denext ships none of
          their artwork; iOS draws them itself, and every other platform gets Material Symbols.
        </li>
      </ul>

      <h2 id="deep-links">Deep links</h2>
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

      <h3 id="app-links">Serving the association files</h3>
      <p>
        When the link domain is served by denext, the config’s <code>appLinks</code> makes{" "}
        <code>denext start</code> and <code>denext dev</code> serve{" "}
        <code>/.well-known/apple-app-site-association</code> and{" "}
        <code>/.well-known/assetlinks.json</code> (<code>application/json</code>,{" "}
        <code>200</code>, answered before redirects, <code>basePath</code>,{" "}
        <code>trailingSlash</code> and middleware, since iOS and Android refuse a redirect), and
        {" "}
        <code>denext export</code>{" "}
        writes both into the export (give the extensionless Apple file a JSON content type on your
        host). <code>createAppLinksHandler</code> from <code>denext/server</code>{" "}
        does the same in a custom server.
      </p>
      <Code lang="ts">
        {`// denext.config.ts
export default {
  appLinks: {
    apple: { appIds: ["ABCDE12345.com.example.app"], paths: ["/orders/*", "!/admin/*"] },
    android: {
      packageName: "com.example.app",
      sha256CertFingerprints: ["14:6D:E9:…:44:E5"], // the Play app signing key + your upload key
    },
  },
};`}
      </Code>
      <p>
        <code>paths</code> defaults to every path; a leading <code>!</code>{" "}
        excludes one. The Apple file also lists the apps under{" "}
        <code>webcredentials</code>, and the Android one delegates{" "}
        <code>get_login_creds</code>, so saved passwords and passkeys are shared with the app
        (<code>webcredentials: false</code> / <code>loginCredentials: false</code> turn that off).
      </p>

      <h2 id="auth-sessions">Auth sessions</h2>
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
      <p>
        In a Deno Desktop window the same <code>openAuthSession</code>{" "}
        call runs the RFC 8252 loopback flow instead, with nothing to install: see{" "}
        <a href="/docs/desktop#desktop-sign-in">Sign-in on Deno Desktop</a>.
      </p>

      <h2 id="push-notifications">Push notifications</h2>
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

      <h3 id="sending-push">Sending push from your server</h3>
      <p>
        Sending to the token <code>registerForPush()</code>{" "}
        returns needs no npm package and no push service: <code>createPushSender</code> in{" "}
        <code>denext/server</code> talks to APNs (HTTP/2, token-based <code>.p8</code>{" "}
        auth, an ES256 JWT cached for 50 minutes) and FCM HTTP v1 (a service-account OAuth token,
        cached until it expires) with <code>fetch</code> and WebCrypto.
      </p>
      <Code lang="ts">
        {`// lib/push.ts (server-only)
import { createPushSender } from "denext/server";

export const push = createPushSender({
  apns: {
    keyId: Deno.env.get("APNS_KEY_ID")!, // Apple Developer → Keys (APNs enabled)
    teamId: Deno.env.get("APNS_TEAM_ID")!,
    p8: Deno.env.get("APNS_P8")!, // the contents of the .p8 file
    topic: "com.example.app", // the bundle id
    production: Deno.env.get("APNS_PRODUCTION") === "1",
  },
  fcm: { serviceAccount: JSON.parse(Deno.env.get("FCM_SERVICE_ACCOUNT")!) },
});

const result = await push.send({ platform: device.platform, token: device.token }, {
  title: "Your order shipped",
  body: "Order #42 is on its way",
  data: { orderId: "42" }, // arrives in onPushTapped / onPushReceived
  channelId: "orders", // Android 8+ channel
  threadId: "orders", // iOS grouping
});
if (!result.ok && result.error === "invalid-token") await db.devices.delete(device.token);`}
      </Code>
      <ul>
        <li>
          <code>ios</code> tokens go to APNs, <code>android</code>{" "}
          tokens to FCM; a platform without credentials answers{" "}
          <code>error: "config"</code>. Development builds register sandbox tokens: set{" "}
          <code>production: true</code>{" "}
          for TestFlight and App Store builds (a token sent to the wrong environment is{" "}
          <code>invalid-token</code>).
        </li>
        <li>
          The payload also takes <code>subtitle</code>, <code>badge</code>, <code>sound</code>,{" "}
          <code>category</code>, <code>mutableContent</code>, <code>collapseId</code>,{" "}
          <code>priority</code> and <code>ttl</code>.{" "}
          <code>&#123; contentAvailable: true, data &#125;</code>{" "}
          alone is a background push (<code>apns-push-type: background</code>, priority 5; a
          data-only FCM message). FCM data values are strings, so other values are sent as JSON.
        </li>
        <li>
          <code>&#123; liveActivity: &#123; event: "update", contentState &#125; &#125;</code>{" "}
          goes to a Live Activity’s push token with the <code>.push-type.liveactivity</code> topic;
          {" "}
          <code>event: "start"</code> (iOS 17.2+, the push-to-start token) also needs{" "}
          <code>attributesType</code> and <code>attributes</code>; <code>"end"</code> takes{" "}
          <code>dismissalDate</code>.
        </li>
        <li>
          Failures are results, never throws: <code>invalid-token</code>{" "}
          (BadDeviceToken, Unregistered, FCM UNREGISTERED: prune it), <code>auth</code>{" "}
          (retried once with a fresh token first), <code>rate-limited</code> (with{" "}
          <code>retryAfter</code>), <code>payload</code>{" "}
          (an APNs payload over 4 KB is refused before sending), <code>server</code>,{" "}
          <code>network</code>, and <code>rejected</code> for any other refusal (see{" "}
          <code>reason</code>). Both keys must be PKCS#8 PEMs (convert an older one with{" "}
          <code>openssl pkcs8 -topk8 -nocrypt</code>).
        </li>
      </ul>

      <h2 id="permissions">Permissions</h2>
      <p>
        <code>checkPermission(name)</code> and <code>requestPermission(name)</code>{" "}
        report one status on iOS, Android and the web, whichever plugin answers underneath (each
        capability's own <code>checkPermissions</code> /{" "}
        <code>requestPermissions</code>; the browser's Permissions and Notifications APIs on the
        web). Names: <code>camera</code>, <code>photos</code>, <code>microphone</code>,{" "}
        <code>location</code>, <code>location-background</code>, <code>notifications</code>,{" "}
        <code>contacts</code>, <code>calendar</code>, <code>biometrics</code>.{" "}
        <code>usePermission(name)</code>{" "}
        keeps the status live: it checks again each time the app comes back to the foreground, so it
        follows a change the user made in Settings. <code>openAppSettings()</code>{" "}
        opens the app's own page in the system settings (iOS{" "}
        <code>UIApplication.openSettingsURLString</code>, Android's App info screen) through
        denext's <code>DenextSettings</code> plugin, which{" "}
        <code>denext mobile add permissions</code> installs (as do <code>local-notifications</code>,
        {" "}
        <code>biometrics</code> and <code>geolocation</code>). On iOS without the plugin it hands
        {" "}
        <code>app-settings:</code> to the OS; on Android without it, and on the web, it rejects.
      </p>
      <ul>
        <li>
          <code>granted</code> / <code>limited</code>{" "}
          (iOS selected photos or limited contacts, Android approximate location, write-only
          calendar).
        </li>
        <li>
          <code>prompt</code>: never asked. <code>prompt-with-rationale</code>{" "}
          (Android): refused once, a request prompts again; explain why first.
        </li>
        <li>
          <code>denied</code>: the request just shown was refused, but the app may ask again later
          (Android's first refusal; a browser refusal).
        </li>
        <li>
          <code>blocked</code>: the OS will not prompt again (iOS after any refusal, Android after
          the second one). Only Settings can change it: offer <code>openAppSettings()</code>.
        </li>
      </ul>
      <Code lang="tsx">
        {`"use client";
import type { VNodeChildren } from "denext";
import { openAppSettings, usePermission } from "denext/mobile";

export function CameraGate({ children }: { children: VNodeChildren }) {
  const camera = usePermission("camera");
  if (camera.status === "granted" || camera.status === "limited") return <>{children}</>;
  return camera.status === "blocked"
    ? <button type="button" onClick={() => openAppSettings()}>Allow the camera in Settings</button>
    : <button type="button" onClick={() => camera.request()}>Allow the camera</button>;
}`}
      </Code>
      <p>
        A name nothing can answer for rejects with a <code>PermissionError</code>{" "}
        (<code>code: "unsupported"</code>): a plugin that is not installed with no browser API
        behind it (contacts needs a contacts plugin with <code>checkPermissions</code>, such as{" "}
        <code>@capacitor-community/contacts</code>; calendar <code>@capacitor/calendar</code>).{" "}
        <code>location-background</code> is answered by the{" "}
        <a href="#background-location">background-location</a> plugin: <code>granted</code>{" "}
        with Always authorization, <code>denied</code>{" "}
        with When In Use only (request it to ask for the upgrade). Biometrics have no separate
        prompt: iOS asks for Face ID the first time a prompt runs, so its status is{" "}
        <code>granted</code> when a prompt can run and <code>blocked</code>{" "}
        when the user turned Face ID off for the app.
      </p>

      <h2 id="local-notifications">Local notifications</h2>
      <p>
        <code>local-notifications</code> installs <code>@capacitor/local-notifications</code>{" "}
        and declares <code>POST_NOTIFICATIONS</code>. Ask with{" "}
        <code>requestPermission("notifications")</code>, then schedule:
      </p>
      <Code lang="ts">
        {`import { onLocalNotificationTapped, scheduleNotification } from "denext/mobile";

const id = await scheduleNotification({
  title: "Stand-up",
  body: "In 10 minutes",
  trigger: { type: "weekly", weekday: 2, hour: 9, minute: 50 }, // Mondays (1 = Sunday)
  data: { path: "/standup" }, // a tap opens /standup
  channelId: "reminders", // Android
  categoryId: "reminder", // its action buttons
});
onLocalNotificationTapped(({ actionId }) => console.log(actionId)); // "tap" or an action id`}
      </Code>
      <p>
        Triggers: <code>date</code>, <code>interval</code> (<code>seconds</code>, optionally{" "}
        <code>repeats</code>, at least 60 s when repeating), <code>daily</code>,{" "}
        <code>weekly</code>, <code>monthly</code>, <code>yearly</code>, and <code>calendar</code>
        {" "}
        (any date components; <code>repeats: false</code>{" "}
        for the next match only); none means now. Months are 1–12 and times are local.{" "}
        <code>cancelNotification(id | ids)</code>, <code>cancelAllNotifications()</code> and{" "}
        <code>pendingNotifications()</code> manage them; <code>createNotificationChannel</code> /
        {" "}
        <code>deleteNotificationChannel</code> / <code>listNotificationChannels</code>{" "}
        are Android's channels (a no-op elsewhere). A tap routes through the same rules as a push
        tap (<code>data.path</code>, or <code>data.url</code>{" "}
        under the deep-link acceptance rules), once per tap, cold start included;{" "}
        <code>useLocalNotificationTapped</code> is the hook form.
      </p>
      <p>
        <code>setNotificationCategories([...])</code>{" "}
        registers the action buttons (text-input actions included) a notification shows with{" "}
        <code>categoryId</code>. The call replaces every earlier category, so pass the full set.
        {" "}
        <strong>On iOS the categories also apply to remote pushes</strong>: they live in the app's
        one <code>UNUserNotificationCenter</code>, so a push whose <code>aps.category</code>{" "}
        names one shows its buttons, and the tapped button reaches <code>onPushTapped</code> as{" "}
        <code>actionId</code>. On Android they apply to local notifications only (FCM draws its own
        notification). On the web a notification without a trigger shows through the Notifications
        API; anything later rejects (no scheduler). Android 12+ may deliver an exact time a few
        minutes late unless the user allows exact alarms, and Google Play allows the plugin's{" "}
        <code>SCHEDULE_EXACT_ALARM</code> only for alarm and calendar apps.
      </p>

      <h2 id="biometrics">Biometrics</h2>
      <p>
        <code>biometrics</code> installs <code>@aparajita/capacitor-biometric-auth</code>{" "}
        (the author of the secure-storage plugin <code>secureStore</code> uses), writes{" "}
        <code>NSFaceIDUsageDescription</code>{" "}
        (without it a Face ID prompt crashes the app, so the plugin reports Face ID unavailable) and
        declares <code>USE_BIOMETRIC</code>.
      </p>
      <Code lang="ts">
        {`import { authenticateBiometric, isBiometricAvailable, secureStore } from "denext/mobile";

const { available, type } = await isBiometricAvailable(); // type: "face" | "fingerprint" | "iris"
if (available) {
  await authenticateBiometric({ reason: "Unlock your notes", allowDeviceCredential: true });
}
// A value only a verified user can read back:
await secureStore.set("refreshToken", token, { requireBiometric: true });
const saved = await secureStore.get("refreshToken", { reason: "Sign in" }); // prompts first`}
      </Code>
      <p>
        <code>authenticateBiometric</code> rejects with a <code>BiometricError</code> whose{" "}
        <code>code</code> is <code>cancelled</code>, <code>fallback</code>, <code>lockout</code>,
        {" "}
        <code>not-enrolled</code>, <code>unavailable</code>, <code>passcode-not-set</code>,{" "}
        <code>failed</code> or <code>unsupported</code> (the web, which has no biometric API).
      </p>
      <Callout kind="warn">
        <strong>
          What <code>requireBiometric</code> guarantees.
        </strong>{" "}
        The secure-storage plugin has no biometric access control on its Keychain / Keystore items,
        so the gate is denext's code: <code>secureStore.get</code>{" "}
        runs the prompt before it returns a gated value. The item is stored "when passcode set, this
        device only" on iOS (never backed up or migrated, deleted if the passcode is removed), but
        native code in the app could still read it without a prompt. It protects against someone
        picking up an unlocked phone, not against a compromised app. On the web a gated value cannot
        be read at all. The <code>expo-secure-store</code> shim's <code>requireAuthentication</code>
        {" "}
        maps to it.
      </Callout>

      <h2 id="native-sign-in">Sign in with Apple and Google</h2>
      <p>
        <code>social-login</code> installs <code>@capgo/capacitor-social-login</code>{" "}
        (Capacitor 8, MPL-2.0), writes the Sign in with Apple entitlement (
        <code>com.apple.developer.applesignin</code>), and with{" "}
        <code>--scheme com.googleusercontent.apps.&lt;id&gt;</code>{" "}
        registers Google's reversed iOS client id as a URL type. <code>signInWithApple()</code>{" "}
        (iOS only) and <code>signInWithGoogle({"{ webClientId, iosClientId }"})</code>{" "}
        show the native sheets and resolve the provider's <code>idToken</code> (plus Apple's{" "}
        <code>authorizationCode</code>, and the name and email when the sheet returns them; Apple
        sends the name only on the first sign-in). A denext server verifies it:{" "}
        <code>signInNative(session, provider)</code>{" "}
        fetches a single-use nonce (<code>POST /auth/native/nonce</code>), shows the sheet with it
        (Apple gets its SHA-256), and posts the token to <code>POST /auth/native/:provider</code>
        {" "}
        through the native session client, which stores the refresh token in{" "}
        <code>secureStore</code>.
      </p>
      <Code lang="ts">
        {`import { nativeSession } from "denext";
import { secureStore, signInNative } from "denext/mobile";

const session = nativeSession({
  base: "https://api.example.com",
  redirectUri: "com.example.app://auth/callback",
  storage: secureStore,
});
const user = await signInNative(session, "apple");
// or: await signInNative(session, "google", { webClientId, iosClientId });`}
      </Code>
      <p>
        Setup: in <code>capacitor.config</code> set <code>plugins.SocialLogin.providers</code> to
        {" "}
        <code>{"{ apple: true, google: true, facebook: false, twitter: false }"}</code>{" "}
        (a disabled provider is not bundled; Facebook's SDK adds the <code>AD_ID</code>{" "}
        permission Play asks about); enable Sign in with Apple on the App ID; create Google OAuth
        clients of type iOS, Android (package plus signing SHA-1) and Web application, and list the
        web and iOS ids in the server's Google provider. Apple on Android and on the web has no
        native sheet: sign in through the server's browser flow (
        <code>session.signIn(open, {'{ provider: "apple" }'})</code>). Apple's guideline 4.8
        requires Sign in with Apple (or an equivalent) in an app that offers other social logins.
        The <code>expo-apple-authentication</code> shim maps to the same call;{" "}
        <code>expo-auth-session/providers/google</code> is not shimmed (use{" "}
        <code>signInWithGoogle</code>).
      </p>

      <h2 id="geolocation">Geolocation</h2>
      <p>
        <code>geolocation</code> installs <code>@capacitor/geolocation</code>, writes{" "}
        <code>NSLocationWhenInUseUsageDescription</code> and declares{" "}
        <code>ACCESS_COARSE_LOCATION</code> /{" "}
        <code>ACCESS_FINE_LOCATION</code>. On the web the same calls use{" "}
        <code>navigator.geolocation</code>.
      </p>
      <Code lang="tsx">
        {`import { getCurrentPosition, useLocation, watchPosition } from "denext/mobile";

const here = await getCurrentPosition({ accuracy: "balanced", timeoutMs: 10_000 });
const stop = watchPosition((p) => marker.move(p.latitude, p.longitude), { accuracy: "high" });

function Here() {
  const { position, error } = useLocation();
  return <p>{error ? error.code : position ? \`\${position.latitude}, \${position.longitude}\` : "…"}</p>;
}`}
      </Code>
      <p>
        Failures are a <code>GeolocationError</code> with <code>code</code> <code>denied</code>,
        {" "}
        <code>unavailable</code> (location services off), <code>timeout</code> or{" "}
        <code>unsupported</code>. The <code>expo-location</code> shim covers the foreground API; its
        {" "}
        <code>geocodeAsync</code> / <code>reverseGeocodeAsync</code>{" "}
        need a geocoding service a WebView does not have, so they call the geocoder you pass to{" "}
        <code>setGeocoder</code> (any HTTP geocoding API) and reject without one.
      </p>

      <h2 id="background-location">Background location</h2>
      <p>
        <code>background-location</code> installs <code>@capgo/background-geolocation</code>{" "}
        (Capacitor 8, MPL-2.0), writes <code>NSLocationWhenInUseUsageDescription</code>,{" "}
        <code>NSLocationAlwaysAndWhenInUseUsageDescription</code> and the <code>location</code>{" "}
        background mode, and declares <code>FOREGROUND_SERVICE_LOCATION</code>{" "}
        with its companions. iOS keeps the fixes coming with Always authorization; Android runs a
        foreground service with a visible notification, which needs no{" "}
        <code>ACCESS_BACKGROUND_LOCATION</code>{" "}
        (denext does not declare it). Without the plugin (the web, or a shell without it) the same
        call is the foreground <code>watchPosition</code>.
      </p>
      <Code lang="tsx">
        {`import { isBackgroundLocationAvailable, stopBackgroundLocation, watchPositionInBackground } from "denext/mobile";

const stop = watchPositionInBackground((p) => route.push([p.longitude, p.latitude]), {
  notification: { title: "Recording your run", message: "Tap to return to the app." }, // Android
  distanceFilterM: 10,
  url: "https://api.example.com/locations", // optional: native POSTs, alive while the WebView sleeps
});
// later: stop(), or stopBackgroundLocation() from anywhere (one watch runs at a time)`}
      </Code>
      <Callout kind="warn">
        <strong>Store review.</strong>{" "}
        Apple and Google both scrutinise background location. The App Store (Guidelines 2.5.4 and
        5.1.1) wants a visible feature that needs it (navigation, fitness, delivery tracking), named
        in the usage string and in the review notes. Google Play wants the <code>location</code>
        {" "}
        foreground service type declared in the Play Console with a short video, and{" "}
        <code>ACCESS_BACKGROUND_LOCATION</code>{" "}
        (only for background geofencing) adds a location permissions declaration and a prominent
        in-app disclosure. On Android, also set <code>android.useLegacyBridge: true</code>{" "}
        in the Capacitor config, or updates stop after about five minutes in the background.
      </Callout>

      <h2 id="screen-readers">Screen readers</h2>
      <p>
        <code>accessibility</code> has no npm package: it writes denext&apos;s{" "}
        <code>DenextAccessibility</code>{" "}
        plugin (Swift and Java, registered like the other denext plugins), which reports whether
        VoiceOver or TalkBack is on and when that changes. React Native mode&apos;s{" "}
        <code>AccessibilityInfo.isScreenReaderEnabled</code>{" "}
        reads the same plugin. The web has no API that reveals a screen reader, so there it is
        always <code>false</code>.
      </p>
      <Code lang="tsx">
        {`import { isScreenReaderEnabled, onScreenReaderChange, useScreenReader } from "denext/mobile";

if (await isScreenReaderEnabled()) carousel.stopAutoplay();
const stop = onScreenReaderChange((on) => document.body.classList.toggle("sr", on));

function Slides({ items }: { items: string[] }) {
  const screenReader = useScreenReader(); // false until the first answer
  return screenReader ? <ol>{items.map((i) => <li key={i}>{i}</li>)}</ol> : <Carousel items={items} />;
}`}
      </Code>

      <h3 id="text-size">Text size (Dynamic Type)</h3>
      <p>
        The same plugin reports the OS text size: Dynamic Type on iOS, the font scale on Android.
        {" "}
        <code>getFontScale()</code> / <code>useFontScale()</code> / <code>onFontScaleChange()</code>
        {" "}
        answer the factor the page still has to apply itself, 1 at the default size. iOS&apos;s
        WKWebView ignores Dynamic Type, so there it is the whole factor (React Native&apos;s table:
        0.823 at the smallest size, 1.353 at the largest standard one, up to 3.571 with the larger
        accessibility sizes). Android&apos;s WebView already zooms all text by the system font scale
        (its{" "}
        <code>textZoom</code>), so there it is the system scale divided by that zoom, usually 1. In
        a browser it is 1: the browser applies its user&apos;s text size to <code>rem</code> itself.
      </p>
      <p>
        <code>applyFontScale()</code>{" "}
        opts the whole page in: it scales the root font size (as your stylesheet sets it) by the
        factor and keeps it current, so everything sized in <code>rem</code> follows, and sets{" "}
        <code>--dnx-font-scale</code>{" "}
        for sizes you compute. Call it once, early; the function it returns undoes it. React Native
        mode applies the factor to <code>Text</code> itself (<code>allowFontScaling</code>,{" "}
        <code>maxFontSizeMultiplier</code>), and <code>PixelRatio.getFontScale()</code> and{" "}
        <code>useWindowDimensions().fontScale</code> report it.
      </p>
      <Code lang="tsx">
        {`import { applyFontScale, useFontScale } from "denext/mobile";

applyFontScale({ max: 2 }); // rem-based CSS follows the OS text size, at most 2x

function Price({ amount }: { amount: string }) {
  const scale = useFontScale(); // 1 until the first answer
  return <span style={{ fontSize: 17 * Math.min(scale, 1.5) }}>{amount}</span>;
}`}
      </Code>

      <h3 id="reduced-motion">Reduced motion</h3>
      <p>
        <code>useReducedMotion()</code>{" "}
        returns whether the user asked for reduced motion (iOS Reduce Motion, Android Remove
        animations, the desktop setting) and re-renders when that changes. It reads{" "}
        <code>prefers-reduced-motion</code>, which the iOS and Android WebViews report from the OS,
        so it needs no plugin; it is <code>false</code>{" "}
        during server rendering. In React Native mode,{" "}
        <code>AccessibilityInfo.isReduceMotionEnabled()</code>{" "}
        reads the same query, as does Reanimated&apos;s own <code>useReducedMotion</code>{" "}
        on the web. denext&apos;s own motion follows it too: the keyboard focus-reveal scrolls at
        once instead of smoothly.
      </p>
      <Code lang="tsx">
        {`"use client";
import { useReducedMotion } from "denext/mobile";

export function Banner() {
  const reduce = useReducedMotion();
  return <div style={{ transition: reduce ? "none" : "transform 300ms" }} />;
}`}
      </Code>

      <h2 id="durable-storage">Durable storage</h2>
      <p>
        A WebView&apos;s <code>localStorage</code>{" "}
        and IndexedDB belong to the web view, and iOS and Android may clear them when the device
        runs low on space; Capacitor&apos;s own guidance calls them transient.{" "}
        <code>openKeyValueStore(name)</code> keeps strings where the OS does not clear them:{" "}
        <code>denext mobile add storage</code> writes denext&apos;s <code>DenextStorage</code>{" "}
        plugin (Swift and Java, no npm package), one SQLite file in the app&apos;s own data folder
        (<code>Library/Application Support</code> on iOS, the app&apos;s <code>databases/</code>
        {" "}
        on Android), opened with the system SQLite. Every call is one batch over the bridge, so a
        thousand keys cost one round trip.
      </p>
      <table>
        <thead>
          <tr>
            <th>Where the page runs</th>
            <th>Where the data goes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>iOS / Android shell</td>
            <td>
              <code>DenextStorage</code> (<code>backend()</code> is{" "}
              <code>
                &quot;native&quot;
              </code>); without it, an installed <code>@capacitor-community/sqlite</code>{" "}
              (<code>&quot;sqlite&quot;</code>); with neither, IndexedDB and a console warning
            </td>
          </tr>
          <tr>
            <td>Deno Desktop</td>
            <td>
              the runtime&apos;s SQLite (<code>denext desktop add sqlite</code>); without that
              capability, IndexedDB with the desktop storage warning
            </td>
          </tr>
          <tr>
            <td>Browser</td>
            <td>IndexedDB</td>
          </tr>
        </tbody>
      </table>
      <Code lang="ts">
        {`import { openKeyValueStore } from "denext/mobile";

const drafts = openKeyValueStore("drafts");
await drafts.setMany([["post-1", body], ["post-2", other]]);
const [first, second] = await drafts.getMany(["post-1", "post-2"]);
await drafts.remove("post-2");
console.log(await drafts.backend()); // "native" in the shell after denext mobile add storage`}
      </Code>
      <p>
        Values are strings (<code>JSON.stringify</code>{" "}
        anything else), not encrypted: tokens and passwords go in{" "}
        <code>secureStore</code>. React Native mode&apos;s{" "}
        <code>@react-native-async-storage/async-storage</code> and <code>react-native-mmkv</code>
        {" "}
        run on this store (see <a href="/docs/react-native#durable-storage">React Native mode</a>).
        {" "}
        <code>denext mobile doctor --store</code> (and{" "}
        <code>--release</code>) warns about app code that keeps data in <code>localStorage</code>
        {" "}
        / IndexedDB, and about AsyncStorage, MMKV or <code>openKeyValueStore</code>{" "}
        in a project without a durable native store.
      </p>

      <h2 id="in-app-purchases">In-app purchases</h2>
      <p>
        <code>purchases</code> installs RevenueCat's <code>@revenuecat/purchases-capacitor</code>
        {" "}
        (StoreKit on iOS, Play Billing on Android; a RevenueCat project is required, with a free
        tier). There is no web fallback: every call rejects with <code>unsupported</code>{" "}
        outside the shell.
      </p>
      <Code lang="tsx">
        {`import { configurePurchases, getOfferings, purchasePackage, restorePurchases, useEntitlement } from "denext/mobile";

await configurePurchases({ apiKey: { ios: "appl_…", android: "goog_…" }, appUserId: user.id });
const { current } = await getOfferings();
try {
  await purchasePackage(current!.availablePackages[0]);
} catch (err) {
  if ((err as { code?: string }).code !== "cancelled") throw err;
}

function ProBadge() {
  const { active } = useEntitlement("pro"); // follows purchases, restores and app resume
  return active ? <span>PRO</span> : null;
}`}
      </Code>
      <p>
        Grant access on your server, not from the app's own report: point a RevenueCat webhook at a
        route that calls <code>verifyRevenueCatWebhook</code> from <code>denext/server</code>{" "}
        (a constant-time check of the <code>Authorization</code>{" "}
        header set in the dashboard, then the typed event). It rejects with a{" "}
        <code>RevenueCatWebhookError</code> whose <code>status</code>{" "}
        (401, 400, 413) is the answer to give.
      </p>
      <Code lang="ts">
        {`// app/api/revenuecat/route.ts
import { RevenueCatWebhookError, verifyRevenueCatWebhook } from "denext/server";

export async function POST(request: Request): Promise<Response> {
  try {
    const { event } = await verifyRevenueCatWebhook(request, {
      authorization: Deno.env.get("REVENUECAT_WEBHOOK_AUTH")!,
    });
    await applyEntitlementEvent(event); // deduplicate on event.id; RevenueCat retries
    return new Response(null, { status: 200 });
  } catch (err) {
    if (err instanceof RevenueCatWebhookError) return new Response(null, { status: err.status });
    throw err;
  }
}`}
      </Code>
      <Callout kind="warn">
        <strong>Store rules.</strong>{" "}
        Digital goods and features used in the app must be sold through the store's in-app purchase:
        {" "}
        <a href="https://developer.apple.com/app-store/review/guidelines/#in-app-purchase">
          App Store Review Guideline 3.1.1
        </a>{" "}
        and the{" "}
        <a href="https://support.google.com/googleplay/android-developer/answer/9858738">
          Google Play Payments policy
        </a>. A paywall also needs a "Restore purchases" button (<code>restorePurchases()</code>).
        Physical goods and services used outside the app use your own payments.
      </Callout>

      <h2 id="store-screen-privacy">Store prompts, orientation, photos and privacy</h2>
      <p>
        Six more capabilities, each a pinned Capacitor 8 plugin. <code>app-review</code>{" "}
        (<code>@capawesome/capacitor-app-review</code>), <code>app-update</code>{" "}
        (<code>@capawesome/capacitor-app-update</code>, free, not an Insiders plugin),{" "}
        <code>screen-orientation</code> (<code>@capacitor/screen-orientation</code>),{" "}
        <code>media-library</code> (<code>@capacitor-community/media</code>{" "}
        9.x, which also writes the photo-library usage strings), <code>privacy-screen</code>{" "}
        (<code>@capacitor/privacy-screen</code> 2.x) and <code>tracking</code>{" "}
        (<code>capacitor-plugin-app-tracking-transparency</code>, which writes{" "}
        <code>NSUserTrackingUsageDescription</code>).
      </p>
      <Code lang="tsx">
        {`import {
  getAppUpdateInfo, lockOrientation, openStoreReview, promptStoreUpdate, requestReview,
  requestTrackingPermission, saveToLibrary, unlockOrientation, useOrientation, usePrivacyScreen,
} from "denext/mobile";

await requestReview();                                  // the OS rating sheet (rate-limited)
await openStoreReview({ appStoreId: "123456789" });     // "Rate this app": always opens the store

const info = await getAppUpdateInfo();                  // { available, availableVersion, … }
await promptStoreUpdate({ appStoreId: "123456789" });   // Play in-app update, or the store

await lockOrientation("landscape");                     // a video player
await unlockOrientation();
const orientation = useOrientation();                   // "portrait-primary" | …, live

await saveToLibrary("https://cdn.example.com/poster.jpg", { album: "Posters" });

function Statement() {
  usePrivacyScreen();                                   // hidden in the app switcher while mounted
  return <Transactions />;
}

const status = await requestTrackingPermission();       // "authorized" | "denied" | …`}
      </Code>
      <ul>
        <li>
          <strong>Review.</strong> <code>requestReview()</code>{" "}
          asks for the sheet; iOS shows it at most three times a year (never in TestFlight), Play
          applies its own quota, and neither says whether it appeared. It resolves{" "}
          <code>"unsupported"</code> on the web. <code>openStoreReview</code>{" "}
          opens the App Store’s write-a-review page (iOS needs{" "}
          <code>appStoreId</code>) or the Play listing, natively or on the web.
        </li>
        <li>
          <strong>Store updates.</strong> <code>getAppUpdateInfo()</code>{" "}
          reads the App Store lookup API on iOS (by bundle id; pass <code>country</code>{" "}
          outside the US) and Play Core on Android (a Play-installed build only).{" "}
          <code>performImmediateUpdate()</code> / <code>startFlexibleUpdate()</code> +{" "}
          <code>onFlexibleUpdateProgress</code> / <code>completeFlexibleUpdate()</code>{" "}
          are Android’s in-app updates. <code>promptStoreUpdate(&#123; confirm &#125;)</code>{" "}
          checks, optionally asks, then runs Play’s update or opens the store. Pass it as{" "}
          <code>checkForUiUpdate</code>’s <code>onNativeUpdateRequired</code>{" "}
          so an over-the-air UI that needs a newer binary (<code>native_too_old</code>,{" "}
          <code>native_mismatch</code>) sends the user to the store.
        </li>
        <li>
          <strong>Orientation.</strong> <code>getOrientation</code>,{" "}
          <code>onOrientationChange</code> and <code>useOrientation</code>{" "}
          read the plugin natively and <code>screen.orientation</code> (else the{" "}
          <code>(orientation: portrait)</code>{" "}
          media query) on the web. Locking on the web works only where the browser allows it
          (fullscreen, installed apps; not Safari). An iPad that allows multitasking cannot lock
          (set{" "}
          <code>UIRequiresFullScreen</code>), and Android 16 ignores locks on large screens for apps
          targeting SDK 36.
        </li>
        <li>
          <strong>Photos.</strong> <code>saveToLibrary(src, &#123; kind, album &#125;)</code>{" "}
          takes an https URL, a <code>data:</code>{" "}
          URL or a file path. iOS saves to the camera roll (or{" "}
          <code>album</code>) with add-only access; Android saves into an album the app owns
          (default <code>"Saved"</code>) with no permission. <code>getAlbums</code> /{" "}
          <code>createAlbum</code> work on both; <code>getRecentMedia</code>{" "}
          (thumbnails) is iOS only. On the web, saving downloads the file.
        </li>
        <li>
          <strong>Privacy screen.</strong> <code>setPrivacyScreen(on, options)</code>{" "}
          or the ref-counted <code>usePrivacyScreen()</code>{" "}
          cover the app-switcher snapshot (a blur on iOS; on Android{" "}
          <code>FLAG_SECURE</code>, which also blocks screenshots unless{" "}
          <code>preventScreenshots: false</code>). A browser owns its tab snapshots, so there is no
          web version: it resolves <code>false</code>.
        </li>
        <li>
          <strong>App Tracking Transparency.</strong> <code>getTrackingStatus()</code> /{" "}
          <code>requestTrackingPermission()</code> return <code>authorized</code>,{" "}
          <code>denied</code>, <code>restricted</code>, <code>not-determined</code>, or{" "}
          <code>unavailable</code>{" "}
          off iOS. Ask before any tracking (App Store guideline 5.1.2) and after launch settles (iOS
          ignores a request while the app is inactive). The <code>expo-tracking-transparency</code>
          {" "}
          shim calls these.
        </li>
      </ul>

      <h2 id="background-tasks">Background tasks</h2>
      <p>
        <code>denext mobile add background</code> installs Capacitor’s official{" "}
        <code>@capacitor/background-runner</code> (3.x) and wires it:{" "}
        <code>plugins.BackgroundRunner</code> in <code>capacitor.config</code>,{" "}
        <code>UIBackgroundModes</code> (fetch, processing) and the{" "}
        <code>dev.denext.background</code> BGTask identifier in Info.plist, the registration in{" "}
        <code>AppDelegate.swift</code>, and the runner’s library folder in{" "}
        <code>android/app/build.gradle</code>. Write each task as a module in{" "}
        <code>background/</code>; <code>denext export</code> bundles them into{" "}
        <code>denext-background.js</code> in the export.
      </p>
      <Code lang="ts">
        {`// background/sync-inbox.ts
import { defineBackgroundTask } from "denext/mobile";

export default defineBackgroundTask({
  name: "sync-inbox",
  interval: 30, // minutes, at least 15
  handler: async ({ kv, deadline }) => {
    const since = kv.get("inbox:since") ?? "0";
    const res = await fetch(\`https://api.example.com/inbox?since=\${since}\`);
    kv.set("inbox:since", String((await res.json()).cursor));
  },
});

// from the page, to run one now: await runBackgroundTask("sync-inbox", { reason: "login" });`}
      </Code>
      <ul>
        <li>
          The runner is a separate headless JavaScript engine: no DOM, no{" "}
          <code>window</code>, no page state. It has <code>fetch</code>, timers,{" "}
          <code>crypto</code>, <code>TextEncoder</code>/<code>TextDecoder</code>,{" "}
          <code>console</code> and the runner’s <code>CapacitorKV</code>,{" "}
          <code>CapacitorNotifications</code>, <code>CapacitorDevice</code> and{" "}
          <code>CapacitorGeolocation</code> globals. <code>ctx.kv</code> is <code>CapacitorKV</code>
          {" "}
          (UserDefaults / SharedPreferences), the only state kept between runs.
        </li>
        <li>
          The OS wakes the runner; denext then runs every task whose <code>interval</code>{" "}
          has passed (90% of it, since wakes are never exact), records the run, and retries a failed
          task at the next wake. Work stops being started after <code>ctx.deadline</code>{" "}
          (about 25 s).
        </li>
        <li>
          <strong>iOS</strong>{" "}
          (BGTaskScheduler) decides when from how the app is used, may not run it for days, gives a
          run about 30 s, and never runs it in the simulator. <strong>Android</strong>{" "}
          (WorkManager) runs it at least 15 minutes apart, allows up to 10 minutes, and some
          vendors’ battery savers stop it (<a href="https://dontkillmyapp.com">
            dontkillmyapp.com
          </a>).
        </li>
      </ul>

      <h2 id="process-death">Android process death</h2>
      <p>
        Android may kill a backgrounded app to free memory, including while the camera or a picker
        (a separate activity) is open. The relaunched page starts from scratch and the waiting{" "}
        <code>pickImage()</code> promise is gone; Capacitor keeps the result and hands it over as
        {" "}
        <code>@capacitor/app</code>’s <code>appRestoredResult</code>.{" "}
        <code>denext mobile add restore</code> installs <code>@capacitor/app</code>.
      </p>
      <Code lang="tsx">
        {`import { onRestoredResult, restoreRouteOnRelaunch } from "denext/mobile";

// At startup (the SPA entry, or the root layout client provider):
onRestoredResult((result) => {
  if (result.kind === "image") draft.setPhoto(result.image.webPath); // pickImage / the camera
  if (result.kind === "documents") uploads.queue(result.documents);  // pickDocument
});
await restoreRouteOnRelaunch({ navigate: (path) => router.replace(path) });`}
      </Code>
      <p>
        Results come as <code>image</code>, <code>documents</code>, <code>cancelled</code>,{" "}
        <code>error</code> or <code>other</code>{" "}
        (any other plugin’s call, raw). Capacitor holds a result until a listener takes it, so
        registering during startup is enough. <code>restoreRouteOnRelaunch()</code>{" "}
        saves the route each time the app goes to the background (in{" "}
        <code>@capacitor/preferences</code> when installed, else{" "}
        <code>localStorage</code>) and, when the app cold-starts on its start page within{" "}
        <code>maxAgeMs</code>{" "}
        (30 minutes), navigates back. Only the route returns: component state, scroll positions and
        the back stack do not.
      </p>

      <h2 id="app-extensions">App extensions</h2>
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

      <h2 id="over-the-air-ui-updates">Over-the-air UI updates</h2>
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
      <p>
        A Deno Desktop app takes the same signed manifests through{" "}
        <code>denext/desktop/updater</code>: see{" "}
        <a href="/docs/desktop#desktop-updates">Desktop UI self-updates</a>.
      </p>

      <h3 id="ota-channels">Channels and staged rollouts</h3>
      <p>
        One <code>createOtaHandler</code>{" "}
        can serve several release tracks. Each release is a normal export with its own{" "}
        <code>_denext/ota.json</code>{" "}
        (signed as usual); a channels file says which release each channel serves, and a staged
        rollout sends a candidate to a percentage of installs.
      </p>
      <Code lang="bash">
        {`denext ota channel production releases/2026-09-20   # creates ota-channels.json
denext ota channel beta releases/2026-09-27
denext ota promote --channel beta --to production --percent 20   # staged rollout
denext ota promote --channel beta --to production --percent 50   # widen it
denext ota promote --channel beta --to production                # 100%: the new stable release
denext ota promote --to production --halt                        # stop a bad rollout`}
      </Code>
      <Code lang="ts">
        {`// the server
const ota = createOtaHandler({ channels: "ota-channels.json", basePath: "/mobile-ui", cors: true });

// the app
await checkForUiUpdate({
  baseUrl: "https://api.example.com/mobile-ui",
  channel: "beta",
  onNativeUpdateRequired: () => promptStoreUpdate({ appStoreId: "123456789" }),
});`}
      </Code>
      <ul>
        <li>
          The app sends <code>x-denext-ota-channel</code> (absent: the file’s{" "}
          <code>default</code>) and <code>x-denext-ota-install-id</code>{" "}
          (<code>otaInstallId()</code>, a random id kept in{" "}
          <code>localStorage</code>) with the manifest request and every file download, so one check
          is served from one release. An unknown channel is not served, never swapped for another.
        </li>
        <li>
          A candidate goes to the installs whose bucket (SHA-256 of the channel, the candidate’s
          version and the install id) falls under{" "}
          <code>percent</code>. Each candidate picks a fresh cohort, raising the percent only adds
          devices, and no install id means the stable release. Manifests pass through untouched, so
          signatures verify exactly as before.
        </li>
        <li>
          <code>promote</code>{" "}
          refuses what devices would refuse anyway: an unsigned release onto a channel serving
          signed ones (<code>signature</code>), or a lower <code>sequence</code>{" "}
          than the channel’s devices may run (<code>downgrade</code>); <code>--force</code>{" "}
          overrides both. Halting a rollout does not downgrade devices that took the candidate: fix
          forward with a higher sequence. The channels file is re-read when it changes, so a promote
          needs no restart.
        </li>
      </ul>

      <h2 id="native-fingerprint">Native fingerprint</h2>
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

      <h2 id="privacy-manifest">iOS privacy manifest</h2>
      <p>
        Since May 1, 2024, App Store Connect refuses an app that calls one of Apple&apos;s{" "}
        <a href="https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api">
          required-reason APIs
        </a>{" "}
        without declaring an approved reason in its{" "}
        <code>PrivacyInfo.xcprivacy</code>. None of the plugins <code>denext mobile add</code>{" "}
        pins ships a manifest of its own, so their use goes in the app&apos;s (as Capacitor&apos;s
        {" "}
        <a href="https://capacitorjs.com/docs/ios/privacy-manifest">privacy manifest guide</a>{" "}
        says). Each capability declares what its iOS code calls, read from the pinned plugin&apos;s
        sources and denext&apos;s own templates, and <code>mobile add</code> merges it into{" "}
        <code>ios/App/App/PrivacyInfo.xcprivacy</code>{" "}
        (creating it, and adding it to the App target&apos;s Copy Bundle Resources). The merge only
        adds: your own categories, reasons, collected-data rows, <code>NSPrivacyTracking</code>{" "}
        and tracking domains stay as they are.
      </p>
      <ul>
        <li>
          <code>filesystem</code>: FileTimestamp <code>C617.1</code> (<code>stat()</code>{" "}
          returns the times of files in the app container).
        </li>
        <li>
          <code>document-picker</code>: FileTimestamp <code>3B52.1</code>{" "}
          (the picked file&apos;s modification date).
        </li>
        <li>
          <code>social-login</code>: UserDefaults <code>CA92.1</code>{" "}
          (the plugin keeps provider state there). <code>background</code>: UserDefaults{" "}
          <code>CA92.1</code> (the runner&apos;s key-value store). <code>add-ota</code>{" "}
          (not a capability, same merge): UserDefaults <code>CA92.1</code>.
        </li>
        <li>
          <code>widget</code>: UserDefaults <code>1C8F.1</code> (App Group) in the app and in the
          {" "}
          <code>DenextWidgets</code> extension&apos;s own manifest.{" "}
          <code>share-extension</code>: FileTimestamp <code>C617.1</code> in the app and in{" "}
          <code>DenextShareExtension</code> (old shared files are pruned by date).
        </li>
        <li>
          <code>sentry</code>: no API (sentry-cocoa ships its own manifest), but the collected data:
          crash, performance and other diagnostic data, not linked, not tracking, App Functionality.
        </li>
        <li>
          <code>@capacitor/preferences</code> (which <code>restore</code>{" "}
          uses when you add it): UserDefaults <code>CA92.1</code>, merged by{" "}
          <code>mobile privacy --write</code>. <code>tracking</code>{" "}
          needs no reason, but an app that asks for tracking permission tracks: the check warns
          until <code>NSPrivacyTracking</code> is true, with your tracking domains listed.
        </li>
        <li>
          Every other capability was checked and uses none. None of them reads disk space or boot
          time; if your own native code does, add <code>E174.1</code> / <code>35F9.1</code>{" "}
          yourself (the merge keeps them).
        </li>
      </ul>
      <Code lang="bash">
        {`denext mobile privacy            # print the manifest and what is wrong with it
denext mobile privacy --write    # merge the entries of every installed capability (never removes)
denext mobile privacy --check    # exit 1 on an error: a CI gate`}
      </Code>
      <p>
        The check validates each category and reason against Apple&apos;s list (and refuses the
        SDK-only <code>0A2A.1</code> / <code>C56D.1</code>{" "}
        in an app), the collected-data types and purposes, tracking without tracking domains, the
        entries the installed capabilities need, and whether Xcode copies the file into the app.
        {" "}
        <code>denext doctor</code>{" "}
        reports the same as an advisory line when the project is a Capacitor project. The App Store
        &quot;nutrition label&quot; (what your server collects about users) is yours to fill in App
        Store Connect; the manifest covers what the app itself does.
      </p>

      <h2 id="app-store-review">App Store review</h2>
      <p>
        Apple&apos;s guideline{" "}
        <a href="https://developer.apple.com/app-store/review/guidelines/#minimum-functionality">
          4.2 (Minimum Functionality)
        </a>{" "}
        rejects an app that is &quot;a repackaged website&quot;, and a WebView shell is where
        reviewers look for one; a Capacitor app with location and sharing{" "}
        <a href="https://developer.apple.com/forums/thread/812889">was still rejected</a>{" "}
        as not robust enough. What reviewers can see decides it:
      </p>
      <ul>
        <li>
          <strong>It is an app, not a site.</strong> The UI ships in the binary (the export,{" "}
          <code>webDir: &quot;out&quot;</code>), never a <code>server.url</code>{" "}
          pointing at your website. Native navigation (a tab bar, stack transitions, the back
          gesture), system bars and safe areas, haptics and the keyboard behave like the
          platform&apos;s.
        </li>
        <li>
          <strong>Native capabilities that matter to the app&apos;s job</strong>, visible in the
          review build: push, widgets, Live Activities, a share extension, quick actions, biometric
          unlock, the camera or document picker, deep links. Name them in the review notes.
        </li>
        <li>
          <strong>Offline behaviour.</strong>{" "}
          The app opens without a network and says what is going on: cached data where it has some,
          otherwise a proper screen, never a blank page or a browser error.{" "}
          <code>denext mobile add offline-screen</code> writes <code>public/offline.html</code>{" "}
          and points Capacitor&apos;s <code>server.errorPath</code>{" "}
          at it (shown when the content cannot load), and <code>installOfflineScreen()</code> from
          {" "}
          <code>denext/mobile</code> covers the page while the device is offline.
        </li>
        <li>
          <strong>No flow that only works in an external browser.</strong> Sign-in uses{" "}
          <code>openAuthSession</code>{" "}
          (a system sheet that returns to the app) or the native Apple / Google sheets; links to
          other sites open in the in-app browser (<code>openExternal</code>), not by leaving the
          app.
        </li>
        <li>
          <strong>Sign-in requirements.</strong>{" "}
          An app that offers Google (or another third-party) sign-in also offers Sign in with Apple
          (guideline 4.8; <code>signInWithApple()</code>). The review notes carry a demo account.
        </li>
        <li>
          <strong>Account deletion.</strong>{" "}
          An app that creates accounts lets users delete them in the app (5.1.1(v)):{" "}
          <code>session.deleteAccount()</code> from <code>nativeSession</code>, or{" "}
          <code>POST /auth/account/delete</code> (denextAuth serves it when the adapter has{" "}
          <code>deleteUser</code>).
        </li>
        <li>
          <strong>Privacy.</strong>{" "}
          A valid privacy manifest, a usage string for every permission the plugins ask for, and
          purchases of digital goods through in-app purchase (3.1.1).
        </li>
      </ul>
      <h3 id="guideline-4-2-checklist">Guideline 4.2 checklist</h3>
      <p>
        What reviewers look for when they test a WebView app against 4.2, and what denext gives you
        for each. A reviewer uses the app for a few minutes: the first screen, the tab bar, a long
        press, going back, airplane mode.
      </p>
      <table class="table">
        <thead>
          <tr>
            <th>Reviewers look for</th>
            <th>What denext provides</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              It behaves like an app, not a website: no browser chrome, no pinch-zoom of the page,
              no text selection or link callouts on controls, no rubber-banding of the whole page.
            </td>
            <td>
              The export ships in the binary; <code>StackLayout</code> / <code>TabsLayout</code>
              {" "}
              own the scrolling (each screen scrolls, the bars stay put);{" "}
              <code>useContextMenu</code>{" "}
              turns off WebKit&apos;s callout on its element; the platform theme turns off tap
              highlights and selection on the bars.
            </td>
          </tr>
          <tr>
            <td>
              Native navigation: a tab bar, pushed screens with the platform transition, the iOS
              edge swipe, Android back and predictive back.
            </td>
            <td>
              <code>denext/navigation</code>: <code>StackLayout</code>, <code>TabsLayout</code>,
              {" "}
              <code>Sheet</code>, <code>denext mobile add back</code>.
            </td>
          </tr>
          <tr>
            <td>
              It looks like the platform: system font, large titles, translucent (iOS 26: Liquid
              Glass) bars, Material 3 on Android, dark mode.
            </td>
            <td>
              The <a href="/docs/navigation-native#platform-theme">platform theme</a>{" "}
              (the default in the shell), <code>useSystemBarsFollowTheme</code>, safe areas.
            </td>
          </tr>
          <tr>
            <td>Native menus and icons, not web look-alikes.</td>
            <td>
              <code>denext mobile add context-menu</code> (<code>UIContextMenuInteraction</code>
              {" "}
              with the lifted preview, <code>PopupMenu</code>) and{" "}
              <code>denext mobile add system-icons</code>{" "}
              (<code>&lt;SystemIcon&gt;</code>: real SF Symbols).
            </td>
          </tr>
          <tr>
            <td>Haptics where the platform has them.</td>
            <td>
              Tab switches and long-press menus play them in the shell by default;{" "}
              <code>haptic()</code> for your own (<code>denext mobile add haptics</code>).
            </td>
          </tr>
          <tr>
            <td>Features a website cannot offer, visible in the review build.</td>
            <td>
              Push, widgets, Live Activities, a share extension, quick actions, biometrics, the
              camera and document picker, deep links, background tasks: each a{" "}
              <code>denext mobile add</code> capability. Name them in the review notes.
            </td>
          </tr>
          <tr>
            <td>It works offline and fails gracefully.</td>
            <td>
              <code>denext mobile add offline-screen</code>,{" "}
              <code>installOfflineScreen()</code>, durable storage, OTA UI that never leaves a blank
              screen.
            </td>
          </tr>
          <tr>
            <td>
              No flow that only works in an external browser; the account rules (Sign in with Apple,
              account deletion).
            </td>
            <td>
              <code>openAuthSession</code>, <code>signInWithApple</code>,{" "}
              <code>openExternal</code>&apos;s in-app browser, denextAuth&apos;s account deletion;
              {" "}
              <code>denext mobile doctor --store</code> checks the last two.
            </td>
          </tr>
          <tr>
            <td>
              Content and value beyond your website: an app that only shows what your site shows is
              still at risk.
            </td>
            <td>
              Nothing a framework can supply. Give the app a job the site does not do (offline use,
              notifications, device features, widgets).
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        <code>denext mobile doctor --store</code>{" "}
        checks what it can, each finding with its fix, and exits 1 on an error:
      </p>
      <ul>
        <li>
          a <code>server.url</code> left in <code>capacitor.config.*</code> or in the native copies
          {" "}
          <code>cap sync</code> wrote (what actually ships);
        </li>
        <li>
          cleartext: <code>server.cleartext</code>, App Transport Security exceptions (<code>
            NSAllowsArbitraryLoads
          </code>, <code>NSAllowsLocalNetworking</code>, insecure exception domains), and{" "}
          <code>usesCleartextTraffic</code>;
        </li>
        <li>
          WebView debugging enabled for release (<code>
            ios/android.webContentsDebuggingEnabled: true
          </code>);
        </li>
        <li>a missing usage string for an installed plugin (Info.plist);</li>
        <li>a missing or invalid privacy manifest (the check above);</li>
        <li>missing app icons (iOS asset catalog, Android launcher) and launch screens;</li>
        <li>
          <code>server.allowNavigation</code> containing <code>&quot;*&quot;</code>;
        </li>
        <li>
          no Content-Security-Policy meta tag in the export&apos;s <code>index.html</code>;
        </li>
        <li>
          source maps (or{" "}
          <code>sourceMappingURL</code>) and secret-shaped strings (private keys, live Stripe keys,
          cloud and API tokens) in the export;
        </li>
        <li>
          sign-in without account deletion, and Google sign-in without Sign in with Apple (read from
          the app&apos;s sources; <code>--app &lt;dir&gt;</code>{" "}
          when the denext app is not the Capacitor folder);
        </li>
        <li>
          app code that keeps data in{" "}
          <code>localStorage</code>, IndexedDB or redux-persist&apos;s web storage, which the OS may
          clear (a warning, in both profiles; see{" "}
          <a href="#durable-storage">Durable storage</a>), and AsyncStorage, MMKV or{" "}
          <code>openKeyValueStore</code> without <code>denext mobile add storage</code>.
        </li>
      </ul>
      <p>
        <code>denext mobile doctor --release</code>{" "}
        runs the release security profile of the same checks: a debuggable WebView, cleartext and
        mixed content (<code>android.allowMixedContent</code>), <code>allowNavigation *</code>,{" "}
        <code>android:debuggable</code>, <code>android.useLegacyBridge</code>{" "}
        (its bridge answers plugin calls from every frame), a missing CSP and secrets in the export
        are errors, and <code>loggingBehavior: &quot;production&quot;</code>{" "}
        is a warning. Run both after <code>denext export</code> and <code>npx cap sync</code>{" "}
        (the CI recipe does). Both profiles also report a{" "}
        <code>DenextBridgeViewController.swift</code>{" "}
        written before the main-frame guard: the one every <code>denext mobile add</code>{" "}
        of a denext native plugin now writes accepts native plugin calls from the page&apos;s main
        frame only, never from an iframe (Capacitor&apos;s own iOS handler answers every frame).
        With a <code>fastlane/</code> folder, <code>--release</code>{" "}
        also checks it (<a href="/docs/mobile-build#fastlane">fastlane</a>). Not checked: whether
        icons are still Capacitor&apos;s placeholders, and anything about the content itself.
      </p>

      <h2 id="crash-reporting">Crash reporting</h2>
      <p>
        <code>denext mobile add sentry</code> installs <code>@sentry/capacitor</code>{" "}
        4.4.0 with its sibling web SDK <code>@sentry/browser</code>{" "}
        10.69.0 (the exact version it depends on; keep the two in step). Native crashes are reported
        by sentry-cocoa and sentry-android, JavaScript errors by the web SDK. It supports Capacitor
        8; on iOS it installs through Swift Package Manager only (a CocoaPods project moves to SPM
        first).
      </p>
      <Code lang="ts">
        {`import { initCrashReporting } from "denext/mobile";

await initCrashReporting({
  dsn: "https://<key>@o0.ingest.sentry.io/<project>",
  sdk: () => import("@sentry/capacitor"),
  sibling: () => import("@sentry/browser"), // or @sentry/react
  environment: "production",
  options: { tracesSampleRate: 0.1 },
});`}
      </Code>
      <p>
        The SDKs load only when this runs. The release is the UI version the page was served with,
        the <code>version</code> of its <code>_denext/ota.json</code>{" "}
        (<code>spa.ota: true</code>), so every over-the-air UI reports under its own release and its
        stack traces match its own source maps. No <code>dist</code>{" "}
        is set by default: one UI version runs on several binaries, and Sentry matches uploaded
        files only when the dist is equal.
      </p>
      <p>
        <strong>Hidden source maps.</strong> <code>denext export --sourcemaps hidden</code> (or{" "}
        <code>DENEXT_SOURCEMAPS=hidden</code>) builds external source maps, then moves them out of
        the export into <code>.denext/sourcemaps/</code>{" "}
        next to a copy of the JavaScript they map, at the same paths. Nothing in <code>out/</code>
        {" "}
        references or contains a map, and the OTA manifest never lists one. Upload them under the
        same release:
      </p>
      <Code lang="bash">
        {`denext export --sourcemaps hidden
npx @sentry/cli sourcemaps upload \\
  --org "$SENTRY_ORG" --project "$SENTRY_PROJECT" \\
  --release "$(jq -r .version out/_denext/ota.json)" \\
  --url-prefix "~/" .denext/sourcemaps   # SENTRY_AUTH_TOKEN in the environment`}
      </Code>
      <p>
        <code>~/</code>{" "}
        matches any origin, so the same upload serves iOS (<code>capacitor://localhost</code>) and
        Android (<code>https://localhost</code>
        ). The <code>examples/capacitor-ci</code> workflow runs this step when the{" "}
        <code>SENTRY_AUTH_TOKEN</code> secret is set.
      </p>

      <h2 id="debugging-on-a-device">Debugging on a device</h2>
      <p>
        The app is a web page in the system WebView, so the browsers&apos; own inspectors attach to
        it: elements, console, network, breakpoints, performance. <code>denext mobile inspect</code>
        {" "}
        prints the steps below and opens what it can (Safari on a Mac, Chrome at{" "}
        <code>chrome://inspect/#devices</code>, after listing <code>adb devices</code>);{" "}
        <code>--platform ios|android</code> narrows it.
      </p>
      <ul>
        <li>
          <strong>iOS</strong> (
          <a href="https://developer.apple.com/documentation/safari-developer-tools/inspecting-ios">
            Safari Web Inspector
          </a>, macOS only): on the device, Settings → Apps → Safari → Advanced → Web Inspector; on
          the Mac, Safari → Settings → Advanced → &quot;Show features for web developers&quot;.
          Connect the device, run a debug build, then Safari → Develop → the device → the page.
        </li>
        <li>
          <strong>Android</strong> (
          <a href="https://developer.chrome.com/docs/devtools/remote-debugging/webviews">
            Chrome remote debugging
          </a>): enable Developer options and USB debugging, connect and accept the prompt, run a
          debug build, then <code>chrome://inspect/#devices</code> in Chrome.
        </li>
      </ul>
      <p>
        Debug builds are inspectable by default. A release or TestFlight build is inspectable only
        with <code>ios.webContentsDebuggingEnabled</code> /{" "}
        <code>android.webContentsDebuggingEnabled</code>{" "}
        set in the Capacitor config, which must not ship: <code>denext mobile dev</code>{" "}
        turns the platform&apos;s flag on for its session only, in the native config copies{" "}
        <code>cap copy</code> wrote (never in{" "}
        <code>capacitor.config.*</code>, so the native fingerprint does not change), puts them back
        when it ends, and scrubs a killed session&apos;s copies on the next run; and{" "}
        <code>denext mobile doctor --release</code> fails a build that still has them.
      </p>
      <p>
        <strong>Logs without an inspector.</strong> During <code>denext mobile dev</code>{" "}
        the page is served by <code>denext dev</code>, and an App Router app reports{" "}
        <code>console.error</code>, <code>console.warn</code>{" "}
        and uncaught errors back to it: read them with the <code>denext_dev_logs</code> MCP tool or
        {" "}
        <code>GET /_denext/dev-state</code>. A SPA-mode app does not forward its console yet; use
        the inspector. Xcode&apos;s console and <code>adb logcat</code>{" "}
        show the native side and, with Capacitor&apos;s default{" "}
        <code>loggingBehavior: &quot;debug&quot;</code>, the page&apos;s console in debug builds. In
        release, send errors to a service instead (<a href="#crash-reporting">crash reporting</a>).
      </p>

      <h2 id="building-in-ci">Building in CI</h2>
      <p>
        <code>denext mobile assets</code>, <code>denext mobile build ios|android</code> and{" "}
        <code>denext mobile submit ios|android</code>{" "}
        generate every icon and splash, build signed store binaries (with flavors) and upload them
        to App Store Connect and Google Play, locally or in CI: see{" "}
        <a href="/docs/mobile-build">Mobile builds &amp; store submission</a>. A team already on
        fastlane keeps it: <code>denext mobile add fastlane</code>{" "}
        writes lanes over the same build (match, TestFlight, Play tracks, metadata) and, with{" "}
        <code>--ci</code>, a GitHub Actions workflow (see{" "}
        <a href="/docs/mobile-build#fastlane">fastlane</a>).
      </p>
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

      <h2 id="performance-notes">Performance notes</h2>
      <p>
        The shell renders the app in the system WebView (WKWebView on iOS, Android System WebView on
        Android), so what makes a web page fast makes the app fast: ship less JavaScript (
        <a href="/docs/bundling">Bundling &amp; flags</a>), keep long lists virtualized, and animate
        with CSS transforms and opacity (or{" "}
        <a href="/docs/api/denext/ViewTransition">
          <code>ViewTransition</code>
        </a>) rather than layout properties.
      </p>
      <ul>
        <li>
          <strong>Long lists.</strong> Use <code>VirtualList</code> from <code>denext</code>{" "}
          (<a href="/docs/lists">Lists &amp; scrolling</a>): it never writes the scroll offset
          during a fling, keeps a chat pinned above the keyboard, and has a <code>progressive</code>
          {" "}
          mode for heavy rows. Third-party virtualized lists (LegendList, react-virtuoso, TanStack
          Virtual) work too: on iOS WebKit denext keeps the momentum fling alive while such a list
          corrects its scroll offset (<a href="#the-denextmobile-runtime">
            momentum-safe scrolling
          </a>, on by default).
        </li>
        <li>
          <strong>iOS.</strong>{" "}
          WKWebView holds up well for the app the mobile work is measured against (T3 Code). No
          side-by-side iOS numbers are published.
        </li>
        <li>
          <strong>Android.</strong>{" "}
          Measured on an emulator only: the Capacitor build started in less than half the time and
          used less memory than the React Native build of the same app, and scrolled a long list
          clearly worse (it missed vsync on more than twice as many frames). The emulator composites
          on a weak host GPU, which costs a WebView more than native views, so this is not settled
          until a real-device run. The numbers and method are in{" "}
          <a href="https://github.com/Brainwires/denext/blob/main/REACT-NATIVE-EXPO.md">
            REACT-NATIVE-EXPO.md
          </a>{" "}
          (gap 5).
        </li>
      </ul>
      <p>
        <a href="/docs/profile">
          <code>denext profile</code>
        </a>{" "}
        profiles a route in headless Chromium (CPU self-time, heap growth, a leak check), so a slow
        render or a leak shows up before it reaches a phone.
      </p>

      <h2 id="testing-mobile-code">Testing mobile code</h2>
      <p>
        Everything in <code>denext/mobile</code>{" "}
        decides at call time: inside the shell it calls the native plugin, anywhere else it takes
        its web fallback. So code that uses it needs no special setup in a test. A component that
        calls <code>useNetworkStatus</code> or <code>isNativeShell</code> renders with{" "}
        <a href="/docs/testing">
          <code>render</code> from <code>denext/testing</code>
        </a>{" "}
        exactly as in a browser (<code>isNativeShell()</code> is <code>false</code>
        ). Where a fallback needs a browser API that Deno does not have (the clipboard, Web Share,
        IndexedDB), install a fake on <code>navigator</code> or <code>globalThis</code>{" "}
        for the test and restore it afterwards.
      </p>
      <p>
        To test the native path, fake the <code>Capacitor</code> global the shell injects:{" "}
        <code>isNativePlatform()</code> returning <code>true</code>, <code>getPlatform()</code>{" "}
        returning <code>"ios"</code> or <code>"android"</code>, and <code>Plugins</code>{" "}
        keyed by the plugin&apos;s JavaScript name with the methods the function calls. A function
        checks for <em>every</em> method it may call (<code>haptic</code> needs <code>impact</code>,
        {" "}
        <code>notification</code>, <code>selectionStart</code>, <code>selectionChanged</code> and
        {" "}
        <code>selectionEnd</code> on{" "}
        <code>Haptics</code>); a plugin missing one counts as not installed and the web fallback
        runs. The plugin names and methods are in each function&apos;s source, and{" "}
        <a href="https://github.com/Brainwires/denext/blob/main/tests/mobile-capabilities.test.ts">
          <code>tests/mobile-capabilities.test.ts</code>
        </a>{" "}
        fakes every capability this way.
      </p>
      <Code lang="ts">
        {`// share.test.ts
import { assertEquals } from "@std/assert";
import { share } from "denext/mobile";

Deno.test("share opens the native share sheet inside the shell", async () => {
  const calls: unknown[] = [];
  const g = globalThis as { Capacitor?: unknown };
  g.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    Plugins: {
      Share: {
        share: (options: unknown) => {
          calls.push(options);
          return Promise.resolve({});
        },
      },
    },
  };
  try {
    assertEquals(await share({ url: "https://example.com/" }), "shared");
    assertEquals(calls, [{ url: "https://example.com/" }]);
  } finally {
    delete g.Capacitor; // the next test runs on the web path again
  }
});`}
      </Code>
      <p>
        A test like this checks what your code asks of the plugin, not the plugin itself: run the
        app on a device (or a simulator) for that.
      </p>
    </DocsShell>
  );
}
