import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Desktop apps",
  description:
    "Run, build, and package a denext app as a native desktop app with the denext desktop command: a signed/notarized macOS .app, a Linux bundle (.tar.gz / AppImage), or a Windows zip (Authenticode-signed when a certificate is configured).",
};

export default function Desktop() {
  return (
    <DocsShell
      active="desktop"
      title="Desktop apps"
      lead="denext exports a self-contained static app, and deno desktop wraps it in a native window and compiles it to a single binary. The denext desktop verb drives it — run to open a dev window, build to export, and package to produce a distributable bundle: a macOS .app (code-signed and, with a Developer ID identity and notarytool credentials, notarized + stapled) or a Linux bundle (.tar.gz, plus an AppImage when appimagetool is present). Windows packages to a zip via denext desktop package --target-os windows (Authenticode-signed when DENEXT_WINDOWS_CERT is set)."
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
      </ul>
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
        before <code>cap sync</code>, so the bundled UI knows its version.
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
    void otaBooted().then(check); // confirm first: a trial UI has 15 s to do so
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
        <code>unsupported</code> on the web. <code>otaStatus()</code> and <code>otaReset()</code>
        {" "}
        report and undo it.
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
        same files again. A newer prepare replaces a staged UI; <code>otaReset()</code>{" "}
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
        wins over it). The signature is ECDSA P-256 / SHA-256 over <code>denext-ota-v1</code>, the
        {" "}
        <code>version</code>, the <code>required</code> flag and a SHA-256 of the{" "}
        <code>notes</code>, so none of them can be changed under a valid signature.{" "}
        <code>add-ota --public-key</code> takes that <code>.pub</code> file or a{" "}
        <code>PUBLIC KEY</code> PEM, writes the Info.plist string <code>DenextOtaPublicKey</code>
        {" "}
        and the <code>dev.denext.ota.PUBLIC_KEY</code>{" "}
        meta-data, and replaces an earlier key when re-run. The key only ever comes from the app
        binary, never from the server, so changing it takes an app release.
      </p>
      <p>Before it downloads anything, the native plugin:</p>
      <ul>
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
          <code>127.0.0.1</code>, <code>::1</code> or the Android emulator's{" "}
          <code>10.0.2.2</code>. Unsigned updates over <code>https</code> still work.
        </li>
      </ul>
      <p>
        A refusal leaves the running UI and any staged one as they were, and reaches the app as{" "}
        <code>{'{ kind: "error", code }'}</code> (<code>OtaErrorCode</code> in{" "}
        <code>denext/mobile</code>). The web side only forwards the signature; the native side is
        the authority.
      </p>
      <p>
        <strong>Rollback rules.</strong>
      </p>
      <ul>
        <li>
          A new UI starts as a <em>trial</em>. <code>otaBooted()</code>{" "}
          makes it current and deletes every other download. Without it, a 15 s watchdog rolls back
          to the previous download or the bundled UI, and deletes the bad version.
        </li>
        <li>If the app dies during the trial, the next launch rolls back before the first page.</li>
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
        There is no downgrade protection: the device installs whatever version its server offers,
        older ones included, and a signed old release stays valid, so an attacker who can answer the
        manifest request can roll a device back to any UI you ever signed. Without an embedded key,
        the transport (TLS) is the only thing standing between the app and a hostile UI. Rotating
        the key takes an app release, and a leaked key is valid until then.
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
