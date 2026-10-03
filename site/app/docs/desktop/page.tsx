import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Desktop apps",
  description:
    "Ship a denext app as a native desktop app (a signed/notarized macOS .app with a .dmg or .pkg, Linux .deb/.rpm/AppImage, a Windows .msi) with the denext desktop command: live reload in the window, native capabilities, OS sign-in sessions, and signed full-app and UI self-updates. iOS/Android is on the Mobile (Capacitor) page.",
};

export default function Desktop() {
  return (
    <DocsShell
      active="desktop"
      title="Desktop apps"
      lead="denext exports a self-contained static app, and deno desktop wraps it in a native window and compiles it to a single binary. The denext desktop verb drives it — run to open a dev window, build to export, and package to produce the app and its installers: a macOS .app (code-signed and, with a Developer ID identity and notarytool credentials, notarized + stapled) with a .dmg and optionally a .pkg; a Linux .tar.gz and .deb, plus an .rpm or an AppImage on request; a Windows .msi (Authenticode-signed when DENEXT_WINDOWS_CERT is set) or .zip. The same export ships to iOS and Android in a Capacitor shell: see Mobile (Capacitor)."
    >
      <h2>The desktop target</h2>
      <p>
        Scaffold with the desktop target (<code>denext create --desktop</code>, or add it to an
        existing project) and you get a <code>desktop.ts</code> entry, a <code>desktop</code>{" "}
        block in <code>deno.json</code> (the app name and identifier), a{" "}
        <code>denext.config.ts</code> (its <code>desktop.capabilities</code>{" "}
        is the native allowlist), an <code>icons/</code>{" "}
        folder, and the packaging scripts (<code>scripts/package-macos.ts</code>,{" "}
        <code>scripts/package-linux.ts</code> and{" "}
        <code>scripts/package-windows.ts</code>). Drive it all with the <code>denext desktop</code>
        {" "}
        verb:
      </p>
      <ul>
        <li>
          <code>denext desktop run</code> — export, build the app with <code>deno desktop</code>
          {" "}
          into a temporary directory (never the project folder) with the same least-privilege
          permissions the packaging scripts derive from{" "}
          <code>desktop.capabilities</code>, then open it and stream its output until it quits
          (<kbd>Ctrl-C</kbd> quits it too). On macOS it launches the{" "}
          <code>.app</code>&apos;s executable directly so the output reaches your terminal. A bare
          {" "}
          <code>deno desktop desktop.ts</code>{" "}
          only compiles: it writes a bundle into the current folder, opens no window, and that build
          has no permissions.
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
        {`import config from "./denext.config.ts";
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";

await runDesktop({
  importMetaUrl: import.meta.url,
  // the enabled native capabilities (desktop.capabilities), served through the gated bridge
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
});`}
      </Code>
      <p>
        An entry written before 2.11 (or by <code>denext migrate --desktop</code>, which writes{" "}
        <code>{"runDesktop({ importMetaUrl: import.meta.url, proxy: config.spa?.proxy })"}</code>)
        has no <code>resolveDesktopCapabilities</code> spread, so every capability answers{" "}
        <code>unavailable</code>{" "}
        and the page keeps its web path; add the spread to serve the ones you enable. To
        reverse-proxy a backend, pass <code>proxy: config.spa?.proxy</code> too.
      </p>
      <p>
        <code>runDesktop</code> resolves once the server is up to{" "}
        <code>{"{ window, trust, emit }"}</code>: <code>window</code> is the adopted{" "}
        <code>Deno.BrowserWindow</code> (<code>undefined</code> outside the desktop runtime),{" "}
        <code>trust</code> is the world the gates enforce (<code>loopback</code>{" "}
        under the stock runtime, <code>memory</code>{" "}
        at the app origin under denext&apos;s pinned one; see{" "}
        <a href="#desktop-security">Security model</a>), and <code>emit(cap, event, data)</code>
        {" "}
        pushes an event to the page, where <code>onDesktopEvent(cap, event, handler)</code> from
        {" "}
        <code>denext/desktop/client</code>{" "}
        receives it. An event emitted before the page subscribes is kept and delivered then:
      </p>
      <Code lang="ts">
        {`const { emit } = await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
});
watchScanner((id) => emit("scanner", "attached", { id })); // an OS event of your own

// in the page
import { onDesktopEvent } from "denext/desktop/client";
const stop = onDesktopEvent<{ id: string }>("scanner", "attached", ({ id }) => refresh(id));`}
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
        <code>--include out</code>,{" "}
        <code>--allow-net=127.0.0.1,localhost --allow-read --allow-env</code>,{" "}
        <code>--exclude-unused-npm</code>, and (for a pnpm/yarn app pinning{" "}
        <code>nodeModulesDir: "manual"</code>) <code>--node-modules-dir=none</code>{" "}
        so the runtime's own npm dep resolves from Deno's global cache.{" "}
        <code>denext migrate --desktop</code>{" "}
        writes that task for you, and writes the two resolution flags to{" "}
        <code>desktop.denoFlags</code> in the generated <code>denext.config.ts</code> so{" "}
        <code>denext desktop run</code>, <code>dev</code> and <code>package</code> pass them too.
      </Callout>
      <h3 id="desktop-app-identity">The app's name, identifier and icon</h3>
      <p>
        The package scripts name, identify and decorate the bundle from <code>desktop.app</code> in
        {" "}
        <code>denext.config.ts</code>, falling back to <code>deno.json</code>&apos;s{" "}
        <code>desktop.app</code> for anything it leaves out:
      </p>
      <Code lang="ts">
        {`// denext.config.ts
export default {
  desktop: {
    app: {
      name: "My App", // MyApp.app, the executable, the .desktop entry, the installers
      identifier: "com.example.myapp", // CFBundleIdentifier, the app's storage and keychain
      icons: {
        macos: "./icons/app.icns", // or a 1024² .png
        windows: "./icons/app.ico",
        linux: "./icons/app.png", // 512² or larger
      },
    },
  },
};`}
      </Code>
      <ul>
        <li>
          <code>deno desktop</code> reads the name and identifier from <code>deno.json</code>
          , so the scripts (and <code>denext desktop run</code> /{" "}
          <code>dev</code>) write the configured ones into <code>deno.json</code>&apos;s{" "}
          <code>desktop.app</code>{" "}
          before they build, keeping its comments and other keys, the same way they write{" "}
          <code>desktop.app.deepLinks</code>.
        </li>
        <li>
          The icon is passed as <code>deno desktop --icon</code> on all three OSes:{" "}
          <code>desktop.app.icons.&lt;macos|windows|linux&gt;</code>, else the same key in{" "}
          <code>deno.json</code>, else <code>icons/app.icns</code> / <code>icons/app.ico</code> /
          {" "}
          <code>icons/app.png</code>, else the <code>desktop-icon.png</code>{" "}
          an export composes. A configured icon that does not exist fails the build. The macOS
          script picks this up with <code>denext desktop package --regenerate-scripts</code>.
        </li>
      </ul>
      <h3 id="desktop-deno-flags">Extra deno desktop flags</h3>
      <p>
        A project that needs extra <code>deno desktop</code> flags to build at all lists them in
        {" "}
        <code>desktop.denoFlags</code>. <code>denext desktop run</code>,{" "}
        <code>denext desktop dev</code>{" "}
        and the package scripts pass them before the entry (the macOS script once{" "}
        <code>denext desktop package --regenerate-scripts</code>{" "}
        has rewritten it; the Linux and Windows builds read them through{" "}
        <code>denext/desktop</code>). The usual case is a pnpm workspace (deno.json{" "}
        <code>nodeModulesDir: "manual"</code>), where <code>deno desktop</code>{" "}
        would otherwise type-check against the workspace&apos;s <code>node_modules</code>{" "}
        and rewrite the root <code>package.json</code>:
      </p>
      <Code lang="ts">
        {`// denext.config.ts
export default {
  desktop: {
    denoFlags: ["--node-modules-dir=none", "--exclude-unused-npm"],
  },
};`}
      </Code>
      <ul>
        <li>
          One flag per entry, <code>--flag</code> or <code>--flag=value</code>, from an allow-list:
          {" "}
          <code>--node-modules-dir</code>, <code>--node-modules-linker</code>,{" "}
          <code>--exclude-unused-npm</code>, <code>--no-check</code>, <code>--check</code>,{" "}
          <code>--no-lock</code>, <code>--lock</code>, <code>--frozen-lockfile</code>,{" "}
          <code>--cached-only</code>, <code>--no-remote</code>, <code>--no-npm</code>,{" "}
          <code>--no-code-cache</code>, <code>--conditions</code> and <code>--unstable-*</code>.
        </li>
        <li>
          Permission flags (<code>-A</code>, <code>--allow-*</code>,{" "}
          <code>--deny-*</code>, …) are refused: the packaged app&apos;s permissions come from{" "}
          <code>desktop.capabilities</code> and{" "}
          <code>desktop.extraPermissions</code>. So are the flags denext sets itself (
          <code>--output</code>, <code>--target</code>, <code>--include</code>, <code>--icon</code>,
          {" "}
          <code>--config</code>, …). Config validation, the commands and the scripts all refuse
          them.
        </li>
        <li>
          denext does not add <code>--node-modules-dir=none</code>{" "}
          on its own: it moves npm resolution from the workspace&apos;s <code>node_modules</code>
          {" "}
          to Deno&apos;s cache, so pnpm patches, overrides and linked packages stop applying. In a
          pnpm workspace with <code>nodeModulesDir: "manual"</code> and no{" "}
          <code>--node-modules-dir</code> in <code>desktop.denoFlags</code>,{" "}
          <code>denext desktop run</code>, <code>dev</code> and <code>package</code>{" "}
          print the line to add instead.
        </li>
      </ul>

      <h2 id="desktop-dev">Live reload (the Metro model)</h2>
      <p>
        During development the window can load straight from <code>denext dev</code>{" "}
        instead of the bundled export, the way a React Native app attaches to Metro: every edit
        hot-reloads in the native window. <code>denext desktop dev</code>{" "}
        starts the dev server (or attaches to one already answering on the port) and opens the
        window with its runtime in <strong>proxy mode</strong>: the window reverse-proxies{" "}
        <em>everything</em> — HTTP <em>and</em>{" "}
        the HMR WebSocket — over loopback to the dev server, so <code>location.origin</code>{" "}
        stays loopback and neither the CSP nor the dev origin gate has to be relaxed.
      </p>
      <Code lang="bash">
        {`denext desktop dev                 # start (or attach to) denext dev on :3000, open the window
denext desktop dev --port 4000     # a different dev server port
denext desktop dev --lan           # attach to a dev server elsewhere on your network`}
      </Code>
      <p>
        The proxy path is a <strong>dev-only</strong> seam: <code>denext desktop dev</code> sets the
        {" "}
        <code>DENEXT_DESKTOP_DEV_URL</code>{" "}
        environment variable on the window process, and that is the only switch that turns proxy
        mode on. Like <code>run</code>, <code>desktop dev</code>{" "}
        builds the app into a temporary directory and launches it, but from a generated entry
        (<code>.denext/desktop-dev-entry.ts</code>) that marks the build as a dev build before your
        {" "}
        <code>desktop.ts</code>{" "}
        runs. The runtime honours the variable only in such a build or under the <code>deno</code>
        {" "}
        CLI (a packaged app ignores it), only for an <code>http:</code> loopback URL unless{" "}
        <code>--lan</code> also set its own opt-in, so a <code>denext desktop run</code>{" "}
        or a packaged build serves the static export exactly as before, whatever its environment.
        Ctrl-C stops the window; a dev server that <code>desktop dev</code>{" "}
        started is stopped too, and one it merely attached to is left running.
      </p>
      <Callout kind="note">
        The target is <strong>loopback-only</strong> (<code>127.0.0.1</code> / <code>[::1]</code> /
        {" "}
        <code>localhost</code>) unless you pass <code>--lan</code>{" "}
        — the desktop window and its dev server normally run on the same machine. Attaching to a dev
        server elsewhere on the network (only with <code>--lan</code>; a non-loopback{" "}
        <code>--host</code>{" "}
        without it is refused) exposes the app and its source to anyone who can reach that address,
        so use it only on a network you trust. The token-gated <code>/_denext/desktop/*</code>{" "}
        endpoints (the capability bridge, the OAuth loopback sheet and the updater boot beacon) are
        always served locally and are never proxied to the dev server, and the per-launch desktop
        token is stripped from a request before it is forwarded.
      </Callout>
      <Callout kind="note">
        <strong>No extra permissions.</strong> <code>denext desktop dev</code>{" "}
        builds with the app&apos;s own <code>--allow-*</code>{" "}
        flags, the ones the scaffolded packaging scripts derive from its enabled capabilities (see
        {" "}
        <a href="#desktop-capabilities">Native capabilities</a>): the window talks only to the local
        dev server, which the baseline <code>--allow-net=127.0.0.1,localhost</code>{" "}
        already reaches. Only <code>--lan</code> adds the dev server&apos;s LAN address to{" "}
        <code>--allow-net</code>.
      </Callout>
      <Callout kind="note">
        In proxy mode the runtime injects its <code>globalThis.__denext</code>{" "}
        marker into the HTML the dev server returns, so <code>runtimePlatform()</code> reports{" "}
        <code>"desktop"</code> as in a real window, and <code>openAuthSession</code>{" "}
        and the OTA boot beacon work against the local runtime. With <code>--lan</code>{" "}
        the per-launch token is not injected (the page comes from another machine), so those
        token-gated features are refused; live-reloading the UI itself is unaffected.
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
        signature). Everything lands in <code>dist/</code>: each <code>.app</code>{" "}
        and, by default, a <code>.dmg</code> of it (see <a href="#desktop-installers">Installers</a>
        {" "}
        for the <code>.pkg</code> and <code>--format</code>). Pass <code>--no-export</code>{" "}
        to reuse an existing <code>out/</code>.
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
deno task desktop:package --arch universal`}
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
        launcher — which the script wraps in a <code>.tar.gz</code> and a <code>.deb</code>{" "}
        per architecture (an <code>.rpm</code> and an AppImage on request; see{" "}
        <a href="#desktop-installers">Installers</a>). It cross-builds from any OS and takes an{" "}
        <code>--arch host|x86_64|arm64|both</code>{" "}
        flag, so the same distribution flow works from a Mac or in CI:
      </p>
      <Code lang="bash">
        {`# host arch (default); on macOS this cross-builds a Linux bundle
denext desktop package --target-os linux

# both Linux arches, with every installer
deno task desktop:package:linux --arch both --format tar.gz,deb,rpm,appimage`}
      </Code>
      <Callout kind="note">
        The end user's Linux desktop needs a <strong>WebKitGTK</strong> runtime (<code>
          webkit2gtk
        </code>) for the window. The <code>.deb</code> and <code>.rpm</code>{" "}
        declare it (<code>libwebkit2gtk-4.1-0</code> /{" "}
        <code>libwebkit2gtk-4.1.so.0</code>), so apt and dnf install it with the app; the{" "}
        <code>.tar.gz</code>{" "}
        and the AppImage leave it to the machine. There is no code-signing/notarization step on
        Linux.
      </Callout>

      <h2 id="desktop-installers">Installers</h2>
      <p>
        Each package script wraps the bundle it finished in the installers for its OS. Pick them per
        OS in <code>denext.config.ts</code>, or for one run with <code>--format</code>{" "}
        (comma-separated; it replaces the list). An empty list (<code>macos: []</code>) builds just
        the bundle — the <code>.app</code> or the app directory — with no installer:
      </p>
      <Code lang="ts">
        {`// denext.config.ts
export default {
  desktop: {
    installers: {
      macos: ["dmg", "pkg"], // default ["dmg"]
      linux: ["tar.gz", "deb", "rpm"], // default ["tar.gz", "deb"]
      windows: ["msi", "zip"], // default ["msi"]
      publisher: "Acme Inc.", // MSI Manufacturer, .deb Maintainer, .rpm Vendor
      description: "Acme's desktop app",
    },
  },
};`}
      </Code>
      <Code lang="bash">
        {`denext desktop package --format dmg,pkg
denext desktop package --target-os windows --format msi,zip`}
      </Code>
      <ul>
        <li>
          <strong>macOS</strong> — the <code>.app</code> always; <code>dmg</code>{" "}
          (a drag-to-Applications disk image, <code>hdiutil</code>) and <code>pkg</code>{" "}
          (<code>productbuild</code>, installing into <code>/Applications</code>{" "}
          — what MDM tools and <code>installer -pkg</code> deploy). Set{" "}
          <code>DENEXT_INSTALLER_IDENTITY</code> to a <em>Developer ID Installer</em>{" "}
          identity to sign the <code>.pkg</code>; with <code>DENEXT_NOTARY_PROFILE</code>{" "}
          it is notarized and stapled like the app. Without one the <code>.pkg</code>{" "}
          is unsigned, which Gatekeeper and MDM reject.
        </li>
        <li>
          <strong>Linux</strong> — <code>tar.gz</code>, <code>deb</code>{" "}
          (written by denext itself, no tool, cross-builds anywhere), <code>rpm</code> (needs{" "}
          <code>rpmbuild</code>: Fedora/RHEL, <code>apt install rpm</code>,{" "}
          <code>brew install rpm</code>) and <code>appimage</code> (needs{" "}
          <code>appimagetool</code>). The <code>.deb</code> and <code>.rpm</code> install the app to
          {" "}
          <code>/usr/lib/&lt;app&gt;</code> with a <code>/usr/bin/&lt;app&gt;</code> link, a{" "}
          <code>.desktop</code> entry named after{" "}
          <code>desktop.app.identifier</code>, the icon (pixmaps and the hicolor theme), and every
          {" "}
          <code>desktop.app.deepLinks</code> scheme as an <code>x-scheme-handler</code>.
        </li>
        <li>
          <strong>Windows</strong> — <code>msi</code> (needs WiX 5 on a Windows host:{" "}
          <code>dotnet tool install --global wix --version 5.0.2</code>) and <code>zip</code>. The
          {" "}
          <code>.msi</code> installs per-user into <code>%LOCALAPPDATA%\Programs\&lt;App&gt;</code>
          {" "}
          with no administrator rights, or per-machine into <code>Program Files</code> with{" "}
          <code>msiexec /i app.msi ALLUSERS=1</code>{" "}
          (what an MDM or a software-deployment tool runs). It adds a Start-menu shortcut, an
          Add/Remove Programs entry with the app's icon, and the deep-link schemes under the
          install's own hive; a newer version upgrades in place (the UpgradeCode is derived from
          {" "}
          <code>desktop.app.identifier</code>, the same one{" "}
          <code>deno desktop</code>'s own MSI uses), and uninstalling removes all of it. It is
          Authenticode-signed with the <code>.exe</code> when <code>DENEXT_WINDOWS_CERT</code>{" "}
          is set. Without WiX the default <code>.msi</code> falls back to the <code>.zip</code>.
        </li>
      </ul>
      <p>
        The package version is deno.json's <code>version</code> (an MSI keeps its numeric{" "}
        <code>major.minor.build</code>; the <code>.deb</code>/<code>
          .rpm
        </code>{" "}
        turn a <code>-rc.1</code> prerelease into{" "}
        <code>~rc.1</code>, which sorts before the release). A default installer whose tool is
        missing is skipped with a warning; one you asked for — in <code>--format</code>{" "}
        or the config — fails the run.
      </p>
      <Callout kind="note">
        The installers wrap the bundle the script <em>finished</em>, not a second{" "}
        <code>deno desktop --output app.msi|.deb|.rpm</code>{" "}
        build: that one-step path stages its own copy, so it would miss the{" "}
        <code>laufey-launch.json</code>{" "}
        that turns DevTools off in a packaged app, the app-local VC++ runtime and the signed{" "}
        <code>.exe</code>; its MSI is also per-machine only with no major upgrade. MSIX and Flatpak
        are not built: MSIX needs a trusted signing certificate even to sideload and runs the app in
        a container that the runtime's per-app storage and deep-link registration do not account
        for; Flatpak needs a runtime/SDK manifest and a portal-aware WebKitGTK sandbox. Both are
        better served by the formats above today.
      </Callout>

      <h2 id="desktop-sign-in">Sign-in on Deno Desktop</h2>
      <p>
        In a Deno Desktop window (<code>runtimePlatform()</code> is{" "}
        <code>"desktop"</code>), the same{" "}
        <a href="/docs/mobile#auth-sessions">
          <code>openAuthSession</code>
        </a>{" "}
        call runs the RFC 8252 loopback flow instead, once the <code>auth-session</code>{" "}
        capability is on (<code>denext desktop add auth-session</code>; the runtime refuses it until
        then): the desktop runtime opens the provider's page in the system browser, listens once on
        an ephemeral <code>127.0.0.1</code>{" "}
        port, rewrites the host and port of the authorization URL's <code>redirect_uri</code>{" "}
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
  // callbackScheme is required by the type, and ignored with a loopback redirect_uri.
  const { url } = await openAuthSession(authorize.href, { callbackScheme: "myapp" });
  const params = new URL(url).searchParams;
  if (params.get("state") !== state) throw new Error("state mismatch");
  // exchange params.get("code") with the PKCE verifier
}`}
      </Code>
      <ul>
        <li>
          <strong>
            <code>callbackScheme</code> is ignored with a loopback <code>redirect_uri</code>,
          </strong>{" "}
          and the <code>redirect_uri</code> must be a loopback <code>http</code>{" "}
          URI with no fragment: <code>http://127.0.0.1/...</code> (<code>localhost</code> and{" "}
          <code>[::1]</code> are accepted and rewritten to <code>127.0.0.1</code>, unless{" "}
          <code>loopbackPort</code> is set). The authorization URL itself must be{" "}
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
          <strong>The browser reports no cancel, so denext shows one.</strong>{" "}
          The app cannot see the user close the browser tab. While the session waits, a small modal
          over the app says "Finish signing in in your browser." with a Cancel button (Escape works
          too), which ends the session with <code>cancelled</code>. Aborting <code>signal</code>
          {" "}
          does the same. Pass <code>cancelOverlay: false</code> to render your own button wired to
          {" "}
          <code>signal</code>, or <code>{"{ message, cancelLabel }"}</code>{" "}
          to translate it. The timeout stays the backstop: <code>timeoutMs</code>{" "}
          (default 5 minutes on desktop), then <code>timeout</code>. One session runs at a time (
          <code>busy</code>), and outside a desktop window the call takes the web path.
        </li>
        <li>
          <strong>
            A provider with a fixed loopback redirect: <code>loopbackPort</code>.
          </strong>{" "}
          Some providers accept only the exact loopback redirect they registered (OpenAI&apos;s
          Codex sign-in uses{" "}
          <code>http://localhost:1455/auth/callback</code>). Pass the port, and the runtime listens
          on it instead of an ephemeral one; the <code>redirect_uri</code>{" "}
          then keeps its host as written (<code>localhost</code> stays{" "}
          <code>localhost</code>) and must name that port or none:
          <Code lang="ts">
            {`const { url } = await openAuthSession(authorize.href, {
  callbackScheme: "myapp", // ignored with a loopback redirect_uri
  loopbackPort: 1455,      // redirect_uri: http://localhost:1455/auth/callback
});`}
          </Code>
          The listener binds <code>127.0.0.1</code> (<code>::1</code> for a <code>[::1]</code>{" "}
          redirect; browsers reach a <code>localhost</code>{" "}
          redirect over IPv4 when nothing answers on IPv6). If another program holds the port, the
          call rejects <code>port_in_use</code>{" "}
          before the browser opens: ask the user to quit the other program (often another sign-in
          tool for the same provider) and retry. RFC 8252 allows a fixed port, but a known port is
          easier for a local program to take first, so <code>state</code>{" "}
          and PKCE matter even more here.
        </li>
      </ul>
      <p>
        The runtime's local endpoint only answers a <code>POST</code>{" "}
        carrying the per-launch token it injects into the page (compared in constant time), from the
        app's own origin (over the in-process transport under denext&apos;s pinned runtime, the
        loopback origin under the stock one; see{" "}
        <a href="#desktop-security">Security model</a>), and it never logs the authorization or
        callback URL.
      </p>

      <h3 id="desktop-scheme-callback">A custom-scheme callback</h3>
      <p>
        Under denext's pinned runtime, the callback can come back to the app's own URL scheme
        instead, for a provider whose redirect allowlist holds it: give the authorization URL a{" "}
        <code>redirect_uri</code> with a scheme from <code>desktop.app.deepLinks</code> (or pass
        {" "}
        <code>callbackPrefix</code>{" "}
        when the provider redirects through its own server first). A loopback{" "}
        <code>redirect_uri</code> keeps the loopback flow above.
      </p>
      <Code lang="ts">
        {`// denext.config.ts → desktop: { app: { deepLinks: ["myapp"] }, capabilities: { authSession: true } }
import { openAuthSession } from "denext/mobile";

const base64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = base64url(
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
);
const state = crypto.randomUUID();
const authorize = new URL("https://auth.example.com/authorize");
authorize.searchParams.set("redirect_uri", "myapp://auth/callback");
authorize.searchParams.set("code_challenge", challenge); // 43 characters, base64url
authorize.searchParams.set("code_challenge_method", "S256"); // mandatory here
authorize.searchParams.set("state", state);

const { url } = await openAuthSession(authorize.href, {
  callbackScheme: "myapp", // must be in desktop.app.deepLinks
  preferEphemeral: true, // macOS: a private sheet
  cancelOverlay: { message: "Finish signing in in your browser.", cancelLabel: "Cancel" },
});
// state is already checked; exchange new URL(url).searchParams.get("code") with the verifier`}
      </Code>
      <p>
        On macOS the custom-scheme sign-in runs in the OS's own auth session (
        <code>ASWebAuthenticationSession</code>{" "}
        through denext's pinned runtime): a sheet on the app's window that shares Safari's cookies
        (or not, with{" "}
        <code>preferEphemeral: true</code>, which also skips the "Wants to Use … to Sign In"
        prompt), closes itself when the provider redirects to the scheme, and rejects{" "}
        <code>cancelled</code>{" "}
        when the user closes it. Windows and Linux have no OS equivalent, so there the system
        browser opens and the callback comes back as a deep link, with the Cancel overlay above. The
        checks below apply to both. The custom scheme is not owned by anyone — any program of the
        user can register for it and receive the callback (RFC 8252 §8.6) — so every check fails
        closed:
      </p>
      <ul>
        <li>
          <code>callbackScheme</code> must be in <code>desktop.app.deepLinks</code>{" "}
          (<code>scheme_not_declared</code>).
        </li>
        <li>
          <strong>PKCE S256 is mandatory:</strong> the URL carries <code>code_challenge</code> and
          {" "}
          <code>code_challenge_method=S256</code>{" "}
          (<code>pkce_required</code>), each once, the challenge a 43-character base64url SHA-256.
          The only exception is an explicit <code>pkce: "not-applicable"</code> with a{" "}
          <code>reason</code>, for a provider that binds the callback another way, and then a{" "}
          <code>state</code>{" "}
          is required too (Clerk's native flow, below, is bound by the macOS sheet or by Clerk's own
          client nonce instead).
        </li>
        <li>
          The callback must match the <code>redirect_uri</code> (or{" "}
          <code>callbackPrefix</code>) exactly on scheme, host and path, and carry the URL's{" "}
          <code>state</code> (with <code>callbackPrefix</code>, the <code>state</code>{" "}
          option you pass; given both, they must agree). A callback with a missing or different{" "}
          <code>state</code>{" "}
          is dropped and the session keeps waiting. While the macOS sheet is up, only the sheet can
          finish the session: the same callback arriving as a deep link is dropped.
        </li>
        <li>
          Before the system browser opens, the runtime asks the OS who handles the scheme (the macOS
          sheet skips this: it catches its own callback, whoever handles the scheme's links). Nobody
          → it registers the app (never forcing) and checks again. Another app →{" "}
          <code>scheme_owned_by_other_app</code>, with that app in <code>err.handler</code>{" "}
          (for display; any program can write it). Fall back to the loopback flow, or ask the user
          and call <code>claimDeepLinkScheme(scheme)</code> from <code>denext/desktop/client</code>
          {" "}
          — only on an explicit user action, since the other app loses the scheme. It must run in
          that click (<code>user_activation_required</code>{" "}
          otherwise), and takes a scheme over at most once per launch (<code>claim_limit</code>).
          This check is advisory (a program can re-register at any time); PKCE and{" "}
          <code>state</code> are the defence. An unpackaged dev run cannot register (<code>
            scheme_not_registered
          </code>).
        </li>
        <li>
          One session at a time (<code>session_in_progress</code>), a 10-minute default timeout, and
          {" "}
          <code>signal</code>{" "}
          to cancel. The system browser on Windows and Linux reports no cancellation, so the Cancel
          overlay covers it there (<code>cancelOverlay</code>). The session belongs to the page that
          started it: reloading or leaving that page ends it, a navigation in another window does
          not, and only that page can cancel it. The OS sheet on macOS cannot be closed from code: a
          cancel or timeout settles your promise, and the sheet stays until the user closes it.
        </li>
        <li>
          On macOS the sheet's callback is held to the same exact <code>redirect_uri</code> and{" "}
          <code>state</code>; one that ends anywhere else rejects <code>invalid</code>.
        </li>
        <li>
          The callback is consumed before deep-link routing: it never reaches{" "}
          <code>onDeepLink</code> or the router.
        </li>
      </ul>

      <h3 id="desktop-clerk">Clerk on Deno Desktop</h3>
      <p>
        <code>denext/desktop/clerk</code> fills the bridge <code>@clerk/electron</code>{" "}
        reads, so an app's <code>ClerkProvider</code> from <code>@clerk/electron/react</code> and
        {" "}
        <code>passkeys</code> from <code>@clerk/electron/passkeys</code>{" "}
        run unchanged in a Deno Desktop window. Call it from the{" "}
        <a href="#desktop-preload">preload</a>:
      </p>
      <Code lang="ts">
        {`// desktop/preload.ts
import { installClerkDesktopBridge } from "denext/desktop/clerk";
installClerkDesktopBridge({ passkeys: true });

// denext.config.ts
export default {
  desktop: {
    app: {
      identifier: "com.example.myapp",
      origin: "myapp://app", // the page origin Clerk's FAPI sees and allows
      deepLinks: ["myapp"], // OAuth comes back to myapp://app/
      singleInstance: true,
    },
    preload: "./desktop/preload.ts",
    capabilities: {
      secureStore: true, // the client JWT, in the OS keychain
      authSession: true,
      passkeys: { rpIds: ["clerk.example.com"] },
    },
  },
};`}
      </Code>
      <ul>
        <li>
          <code>window.__clerk_internal_electron</code> gets{" "}
          <code>exposeClerkBridge</code>'s shape: a <code>tokenCache</code> over{" "}
          <code>secureStore</code> (keys prefixed{" "}
          <code>clerk.</code>; in memory, with a warning, when <code>secure-store</code>{" "}
          is off) and an <code>oauthTransport</code> with{" "}
          <code>@clerk/electron</code>'s main-process semantics: the redirect is the page origin
          plus <code>/</code>{" "}
          (<code>myapp://app/</code>), one flow at a time, 3 minutes, resolved by a callback with
          that scheme, host and path — through the custom-scheme flow above, owner check included.
        </li>
        <li>
          When another app handles the scheme (an Electron build of the same app, say), macOS still
          signs in through its sheet. On Windows and Linux the callback would reach the other app,
          so the transport rejects <code>scheme_owned_by_other_app</code>{" "}
          with a message naming the fix: a "Make this app the handler" button that calls{" "}
          <code>claimDeepLinkScheme(scheme)</code>. Clerk has no fallback without the scheme: its
          native redirect allowlist takes <code>https://</code>{" "}
          or custom-scheme URLs, not a loopback one. <a href="/docs/examples">examples/clerk</a>
          {" "}
          shows the button.
        </li>
        <li>
          Add <code>myapp://app/</code>{" "}
          to the Clerk instance's allowed redirect URLs (Clerk dashboard → Native applications), and
          the origin <code>myapp://app</code> to its allowed origins (<code>allowed_origins</code>
          {" "}
          through the Backend API's{" "}
          <code>PATCH /v1/instance</code>). The second is required: the window sends the client JWT
          as <code>Authorization</code> and the WebView adds{" "}
          <code>Origin</code>, and the Frontend API refuses both together from an origin it does not
          allow ("Setting both the 'Origin' and 'Authorization' headers is forbidden").
        </li>
        <li>
          An app whose provider is <code>@clerk/nextjs</code>'s or <code>@clerk/react</code>'s{" "}
          <code>&lt;ClerkProvider&gt;</code> (the same component as on the web) passes{" "}
          <code>nativeClerk: true</code> (or <code>{"{ passkeys }"}</code>, the adapter from{" "}
          <code>@clerk/electron/passkeys</code>): the clerk-js instance that provider loads from the
          Frontend API is switched to native mode as <code>@clerk/electron/react</code>{" "}
          does with its bundled one — the client JWT from the token cache as{" "}
          <code>Authorization</code>, no cookies, <code>standardBrowser: false</code>{" "}
          and this bridge's OAuth transport. Leave it off with{" "}
          <code>@clerk/electron/react</code>. See{" "}
          <a href="https://github.com/Brainwires/denext/tree/main/examples/clerk">
            examples/clerk
          </a>: one Next.js-style app (<code>clerkMiddleware</code>,{" "}
          <code>&lt;ClerkProvider&gt;</code>,{" "}
          <code>auth()</code>) signing in on the web and in a Deno Desktop window.
        </li>
        <li>
          Clerk's OAuth URL carries no PKCE (it is the provider's), so the transport uses{" "}
          <code>pkce: "not-applicable"</code>: clerk-js redeems the callback's{" "}
          <code>rotating_token_nonce</code> with{" "}
          <code>signIn.reload()</code>, a request signed by this client's own client JWT on this
          client's sign-in. Whether Clerk's servers refuse that nonce from another client cannot be
          read from the client code, so the custom scheme is used only when this app handles it.
        </li>
        <li>
          <code>window.__clerk_internal_electron_passkeys</code> runs ceremonies through the{" "}
          <code>passkeys</code> capability (Touch ID / iCloud Keychain, Windows Hello).{" "}
          <code>rpIds</code>{" "}
          is required and must name the relying party your passkeys belong to (the instance's
          application domain, which is not the Frontend API host the publishable key encodes, so
          denext does not guess it); <code>passkeys: true</code>{" "}
          is a config error, and an empty list refuses every request. On macOS the app's signature
          needs the <code>com.apple.developer.associated-domains</code> entitlement{" "}
          (<code>webcredentials:&lt;rp-id&gt;</code>) with a provisioning profile, and the RP's{" "}
          <code>apple-app-site-association</code> must list{" "}
          <code>&lt;TeamID&gt;.&lt;bundle id&gt;</code>
          ; otherwise every request is{" "}
          <code>invalid_rp</code>. Then the bridge stops offering native passkeys for that launch
          (Clerk hides them; a custom-scheme page cannot use the webview's WebAuthn either) and
          continues a passkey sign-in in the system browser through Clerk's hosted pages (<code>
            startClerkBrowserSignIn
          </code>: <code>@clerk/expo</code>'s hosted-auth protocol, with <code>state</code>{" "}
          and S256 PKCE bound to this page), where the RP's own domain makes passkeys work.{" "}
          <code>passkeyFallback: "none"</code> turns that off.
        </li>
        <li>
          Linux has no native passkeys: <code>capabilities()</code>{" "}
          reports none, Clerk does not offer them, and the hosted browser sign-in is the way to use
          one.
        </li>
      </ul>

      <h2 id="desktop-updates">Desktop UI self-updates</h2>
      <p>
        <code>denext/desktop/updater</code> does for a Deno Desktop app what{" "}
        <a href="/docs/mobile#over-the-air-ui-updates">OTA</a>{" "}
        does for a phone: it pulls a newer signed UI (the export the window serves) without a new
        app build. It updates the UI only, never the binary: the code-signed bundle is left
        untouched, and the verified files go to an overlay in the app-support directory (macOS{" "}
        <code>~/Library/Application Support/&lt;appId&gt;/ui-updates</code>, Linux{" "}
        <code>$XDG_DATA_HOME</code> or <code>~/.local/share/&lt;appId&gt;/ui-updates</code>, Windows
        {" "}
        <code>%APPDATA%\&lt;appId&gt;\ui-updates</code>, or <code>dataDir</code>). A change to{" "}
        <code>desktop.ts</code>, its Deno-side code, or the denext runtime needs a new binary, which
        a <a href="#desktop-app-updates">full-app self-update</a> delivers.
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
        or any server that follows the{" "}
        <a href="/docs/mobile#over-the-air-ui-updates">OTA serving rules</a>. <code>publicKey</code>
        {" "}
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

      <h2 id="desktop-app-updates">Full-app self-updates</h2>
      <p>
        When the binary itself changes (<code>desktop.ts</code>, its Deno-side code, the runtime),
        the whole signed app is replaced: the macOS{" "}
        <code>.app</code>, the Windows or Linux app directory, or a Linux AppImage. Nothing is
        patched in place, because changing a file inside a signed bundle breaks its code signature
        and notarization. It needs denext&apos;s pinned Deno Desktop runtime (<code>
          Deno.desktop.updater
        </code>), and every update is signed: there is no unsigned path.
      </p>
      <Code lang="ts">
        {`// denext.config.ts
desktop: {
  app: { identifier: "com.example.app" }, // every manifest names the app it is for
  update: {
    publicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE…", // ota.key.pub: baked into the app
    manifestUrl: "https://updates.example.com/myapp/app-update.json", // added to --allow-net
    hosts: ["cdn.example.com"], // other download hosts (the archive's, a redirect's): --allow-net too
    // autoConfirm: false, // confirm yourself (default: confirmed once the window has loaded)
  },
},`}
      </Code>
      <Code lang="ts">
        {`// desktop.ts (the Deno process)
import {
  checkForAppUpdate,
  downloadAppUpdate,
  installAppUpdateAndRelaunch,
} from "denext/desktop/updater";

const updates = { manifestUrl: "https://updates.example.com/myapp/app-update.json" };
const found = await checkForAppUpdate(updates);
if (found.available) {
  await downloadAppUpdate(updates, { onProgress: (p) => console.log(p.transferred, p.total) });
  installAppUpdateAndRelaunch(); // quits; the new version starts
}`}
      </Code>
      <p>
        <strong>Publishing.</strong> Make the key pair once with <code>denext ota keygen</code>{" "}
        (the over-the-air UI updates&apos; key: one signing key per app). After packaging each
        platform, run{" "}
        <code>
          denext desktop publish-update --artifact dist/MyApp.app --url-base
          https://updates.example.com/myapp/
        </code>{" "}
        with <code>--key ota.key</code> or{" "}
        <code>DENEXT_OTA_SIGNING_KEY</code>: it writes the archive and a signed{" "}
        <code>app-update.json</code>, adding each platform of the same version to it. Upload both.
        The version comes from deno.json, the identifier from{" "}
        <code>desktop.app.identifier</code>, the platform key (<code>
          &lt;rust target&gt;-&lt;webview|cef&gt;
        </code>, <code>-appimage</code> for an AppImage) from the artifact;{" "}
        <code>--min-version</code> marks older versions as <code>required</code>,{" "}
        <code>--notes</code> sets the release notes.
      </p>
      <p>
        <strong>What the runtime checks before it writes anything at the install.</strong>{" "}
        The manifest&apos;s ECDSA P-256 signature against the baked key (<code>signature</code>),
        the app identifier (<code>wrong_app</code>), a version strictly newer than the running one
        (<code>downgrade</code>; the same version is simply not available), not a version that was
        rolled back (<code>rejected</code>), this platform&apos;s entry (<code>no_platform</code>),
        an https URL (<code>insecure_url</code>), a download that stops at the declared size (
        <code>size_exceeded</code>) and matches its SHA-256 (<code>integrity</code>), an archive
        without traversal, escaping links or special files (<code>unsafe_archive</code>) that holds
        this app (<code>bundle_mismatch</code>), and the operating system&apos;s code signature
        (<code>os_signature</code>): on macOS{" "}
        <code>codesign --verify --deep --strict</code>, Gatekeeper and the same Team ID as the
        running app; on Windows a trusted Authenticode signature with the same signer as the running
        executable. Linux has no OS signature; the manifest signature and the hash are the whole
        check there.
      </p>
      <p>
        <strong>Dev builds.</strong>{" "}
        An ad-hoc signed or unsigned app (a local build) cannot tell who may replace it, so it
        refuses updates unless you pass <code>allowUnsignedDev: true</code>, and{" "}
        <code>allowInsecureLoopback: true</code> accepts <code>http://</code>{" "}
        to a loopback test server. Both are for development only; a signed app ignores{" "}
        <code>allowUnsignedDev</code>.
      </p>
      <p>
        <strong>Swap, confirm, roll back.</strong>{" "}
        A helper (the app&apos;s own executable in a hidden mode) waits for the app to exit, swaps
        the install (one atomic exchange on macOS and Linux, two renames on Windows), keeps the
        previous app as <code>&lt;name&gt;.old</code>{" "}
        next to it and relaunches the new version. That first launch is a trial: once it is
        confirmed, <code>.old</code>{" "}
        is deleted, and a version that is still unconfirmed when the app is next launched (it
        crashed or never confirmed) is rolled back and refused from then on. <code>runDesktop</code>
        {" "}
        confirms the trial for you as soon as the window has loaded (the page&apos;s{" "}
        <code>load</code>{" "}
        event reached the Deno process), so a version that crashes before its window renders still
        rolls back. When your app has a better health check (its backend answered, the user is still
        signed in), set <code>desktop.update.autoConfirm: false</code> and call{" "}
        <code>confirmAppUpdate()</code> from <code>denext/desktop/updater</code>{" "}
        yourself; it is a no-op when no update is pending, so it is safe on every launch.{" "}
        <code>appUpdateStatus()</code>{" "}
        reports the running version, whether updates can run here (and why not), the update phase, a
        version on trial, the last one rolled back and where this launch came from (<code>
          null
        </code>{" "}
        outside the pinned runtime). A refusal throws an <code>AppUpdateError</code> whose{" "}
        <code>code</code> is one of those above.
      </p>
      <p>
        <strong>Where it cannot update.</strong>{" "}
        No privilege escalation: an install this user cannot write (a <code>.pkg</code>{" "}
        in a root-owned <code>/Applications</code> folder, an MSI in Program Files, a{" "}
        <code>.deb</code>) fails with <code>install_not_writable</code>{" "}
        and is updated by its installer. A macOS app running translocated (launched from Downloads
        without being moved) and a <code>deno desktop --compress</code> self-extracting app are{" "}
        <code>unsupported_layout</code>.
      </p>

      <h2 id="desktop-capabilities">Native capabilities</h2>
      <p>
        A desktop app's native side is the Deno process <code>denext/desktop</code>{" "}
        runs beside the window. The same <code>denext/mobile</code>{" "}
        functions an iOS or Android app calls work in the window: when{" "}
        <code>runtimePlatform()</code> is <code>"desktop"</code>{" "}
        they ask the runtime over its token-gated bridge, loading the desktop code lazily (web and
        mobile bundles never fetch it). Each is off until you enable it:
      </p>
      <Code lang="bash">
        {`denext desktop add secure-store fs context-menu   # writes desktop.capabilities
denext desktop add --list                          # every capability, its trust level
denext desktop add dialogs --dry-run               # the config diff + permissions, no write`}
      </Code>
      <p>
        <code>denext desktop add</code> splices the capability into{" "}
        <code>desktop.capabilities</code> in <code>denext.config.ts</code>{" "}
        (comments and the rest of the file keep their bytes; a key you already customised is kept)
        and prints the Deno permissions it adds per OS. That one object is both the runtime's
        allowlist (a call to a capability that is not listed is refused{" "}
        <code>unavailable</code>, and the function keeps its web path) and the source the package
        scripts derive the app's <code>--allow-*</code> flags from.
      </p>
      <Callout kind="note">
        <strong>Packaging permissions.</strong> The scaffolded packaging scripts derive the app's
        {" "}
        <code>--allow-*</code> from its enabled capabilities (the table below) in place of{" "}
        <code>-A</code>: a loopback <code>--allow-net</code>, broad <code>--allow-read</code> /{" "}
        <code>--allow-env</code> for the app's own bundle and support directory, and only the{" "}
        <code>--allow-run</code> / <code>--allow-ffi</code> / <code>--allow-sys</code> (plus a broad
        {" "}
        <code>--allow-write</code>{" "}
        when a capability writes) that the enabled capabilities actually need. A project scaffolded
        before 2.11 keeps its older scripts until you refresh them —{" "}
        <code>denext desktop package --regenerate-scripts</code> rewrites{" "}
        <code>scripts/package-*.ts</code> from the current template, keeping a <code>.bak</code>
        {" "}
        of any file it changes.
      </Callout>
      <Callout kind="note">
        <strong>What is verified.</strong>{" "}
        The bridge is tested end to end against the real runtime (the wire, and a headless Chromium
        page: token, origin, preflight, frames, event replay, fallback), and every capability runs
        in a packaged window:{" "}
        <a href="https://github.com/Brainwires/denext/tree/main/examples/desktop-kitchen-sink">
          examples/desktop-kitchen-sink
        </a>{" "}
        turns each one on, calls it from the page and asserts the result, on Linux, macOS (arm64 and
        Intel) and Windows in CI (<code>.github/workflows/desktop-window.yml</code>); a check a
        hosted runner can't run reports why it skipped.
      </Callout>
      <table class="table">
        <thead>
          <tr>
            <th>Capability</th>
            <th>Page APIs</th>
            <th>Permissions (macOS · Windows · Linux)</th>
            <th>Trust</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>secure-store</code>
            </td>
            <td>
              <code>secureStore</code> (Keychain · PasswordVault · libsecret)
            </td>
            <td>
              <code>--allow-run</code>: security · powershell.exe · secret-tool
            </td>
            <td>full</td>
          </tr>
          <tr>
            <td>
              <code>fs</code>
            </td>
            <td>
              <code>readFile</code>, <code>writeFile</code>, <code>deleteFile</code>,{" "}
              <code>listDir</code>, <code>downloadToFile</code>
            </td>
            <td>
              broad <code>--allow-write</code>{" "}
              (the runtime confines it to the app-support / cache folders)
            </td>
            <td>broad</td>
          </tr>
          <tr>
            <td>
              <code>sqlite</code>
            </td>
            <td>
              <code>openSqlite</code>, <code>deleteSqlite</code> (<code>node:sqlite</code>)
            </td>
            <td>
              broad <code>--allow-write</code> (runtime-confined to the app-support folder)
            </td>
            <td>broad</td>
          </tr>
          <tr>
            <td>
              <code>context-menu</code>
            </td>
            <td>
              <code>showContextMenu</code>, <code>useContextMenu</code>{" "}
              (the OS&apos;s own menu with submenus and a real dismissal; pinned runtime, the
              in-page menu otherwise)
            </td>
            <td>none (a runtime API)</td>
            <td>none</td>
          </tr>
          <tr>
            <td>
              <code>shell</code>
            </td>
            <td>
              <code>openExternal</code>, <code>openPath</code>, <code>revealInFileManager</code>,
              {" "}
              <code>moveToTrash</code>
            </td>
            <td>
              <code>--allow-run</code>: open, osascript · explorer, rundll32, powershell · xdg-open,
              gio, dbus-send
            </td>
            <td>full</td>
          </tr>
          <tr>
            <td>
              <code>auth-session</code>
            </td>
            <td>
              <code>openAuthSession</code>{" "}
              (system-browser OAuth, loopback or custom-scheme callback; default-deny until enabled)
            </td>
            <td>
              <code>--allow-run</code>: open · rundll32 · xdg-open
            </td>
            <td>full</td>
          </tr>
          <tr>
            <td>
              <code>dialogs</code>
            </td>
            <td>
              <code>pickDocument</code>, <code>saveFile</code>, <code>pickFolder</code>{" "}
              (the OS&apos;s own panels under the pinned runtime, filtered by <code>types</code>)
            </td>
            <td>
              unscoped <code>--allow-read</code> /{" "}
              <code>--allow-write</code>, plus osascript · PowerShell · zenity/kdialog
            </td>
            <td>full</td>
          </tr>
          <tr>
            <td>
              <code>notifications</code>
            </td>
            <td>
              <code>scheduleNotification</code>, <code>cancelNotification</code>,{" "}
              <code>pendingNotifications</code>, <code>setNotificationCategories</code>,{" "}
              <code>onLocalNotificationTapped</code>,{" "}
              <code>requestPermission("notifications")</code>, <code>requestPushPermission</code>
              {" "}
              (the OS&apos;s own notifications, scheduled and repeating; pinned runtime, the WebView
              Notification API otherwise)
            </td>
            <td>none (a runtime API)</td>
            <td>none</td>
          </tr>
          <tr>
            <td>
              <code>keep-awake</code>
            </td>
            <td>
              <code>useKeepAwake</code>
            </td>
            <td>
              <code>--allow-run</code>: caffeinate · <code>--allow-ffi</code>: kernel32.dll ·{" "}
              <code>--allow-run</code>: systemd-inhibit
            </td>
            <td>full</td>
          </tr>
          <tr>
            <td>
              <code>clipboard</code>
            </td>
            <td>
              <code>readClipboard</code>, <code>writeClipboard</code>, <code>clipboardFormats</code>
              {" "}
              (text, HTML and PNG images; the WebView clipboard under the stock runtime)
            </td>
            <td>none (a runtime API)</td>
            <td>none</td>
          </tr>
          <tr>
            <td>
              <code>device</code>
            </td>
            <td>
              <code>deviceInfo</code> (OS and release)
            </td>
            <td>
              <code>--allow-sys=osRelease</code>
            </td>
            <td>scoped</td>
          </tr>
          <tr>
            <td>
              <code>global-shortcuts</code>
            </td>
            <td>
              <code>registerShortcut</code>, <code>unregisterShortcut</code>,{" "}
              <code>listShortcuts</code> (<code>denext/desktop/app</code>; pinned runtime)
            </td>
            <td>none (a runtime API)</td>
            <td>none</td>
          </tr>
          <tr>
            <td>
              <code>launch-at-login</code>
            </td>
            <td>
              <code>getLaunchAtLogin</code>, <code>setLaunchAtLogin</code>{" "}
              (<code>denext/desktop/app</code>; login item · <code>Run</code>{" "}
              value · XDG autostart; pinned runtime)
            </td>
            <td>none (a runtime API)</td>
            <td>none</td>
          </tr>
          <tr>
            <td>
              <code>passkeys</code>
            </td>
            <td>
              native passkeys for <code>denext/desktop/clerk</code>{" "}
              (Touch ID / iCloud Keychain · Windows Hello · none on Linux; pinned runtime)
            </td>
            <td>
              none (a runtime API; pin the RP IDs with <code>{"{ rpIds }"}</code>)
            </td>
            <td>none</td>
          </tr>
        </tbody>
      </table>
      <Callout kind="note">
        <strong>What the runtime refuses.</strong>{" "}
        The page is untrusted, so each capability has limits beyond its Deno flags.{" "}
        <code>downloadToFile</code> fetches only <code>http</code>/<code>https</code>{" "}
        URLs, refuses loopback and link-local targets (<code>localhost</code>,{" "}
        <code>127.0.0.0/8</code>, <code>::1</code>, <code>169.254.0.0/16</code>,{" "}
        <code>fe80::/10</code>, checked after DNS and again on every redirect), stops after 100 MiB
        or 10 minutes, and leaves nothing behind on failure. LAN addresses (<code>
          192.168.x.x
        </code>, <code>10.x.x.x</code>, …) stay allowed, so a download from a NAS works.{" "}
        <code>openPath</code> refuses programs, scripts and launchers (<code>.exe</code>,{" "}
        <code>.bat</code>, <code>.command</code>, <code>.terminal</code>,{" "}
        <code>.desktop</code>, an executable file, …), because the default app would run them.{" "}
        <code>fs</code>, <code>shell</code>{" "}
        and drag-out never reach the runtime's own folders in the data directory (the updater's{" "}
        <code>ui-updates</code>, and the web engine's profile: <code>CEF</code>,{" "}
        <code>WebKitGTK</code>,{" "}
        <code>WebView2</code>, in any letter case): no read, list, write, delete, open, reveal,
        trash or drag. SQLite connections cannot <code>ATTACH</code> another file, and a{" "}
        <code>query</code>{" "}
        stops after 20 seconds of producing rows (a single long statement still blocks the app,
        since <code>node:sqlite</code>{" "}
        cannot be interrupted). A reload releases the previous page's keep-awake holds.
      </Callout>
      <Callout kind="note">
        <strong>Native vs the WebView on Deno Desktop.</strong>{" "}
        Most capabilities run in the Deno process: <code>fs</code>, <code>sqlite</code> and{" "}
        <code>secure-store</code> keep data that survives a relaunch (<code>secure-store</code>{" "}
        uses the <code>security</code> / <code>secret-tool</code> tools and, on Windows, WinRT{" "}
        <code>PasswordVault</code> via <code>powershell.exe</code>{" "}
        — the Windows backend is verified by the Windows CI round-trip); <code>shell</code>,{" "}
        <code>dialogs</code> and <code>keep-awake</code>{" "}
        drive OS programs. Under denext&apos;s pinned runtime, <code>dialogs</code>{" "}
        shows the OS&apos;s own panels (<code>NSOpenPanel</code> as a sheet on the window,{" "}
        <code>IFileOpenDialog</code>, <code>GtkFileChooserNative</code>{" "}
        — the portal under Flatpak / Snap) with the page&apos;s MIME <code>types</code>{" "}
        as file-type filters, and <code>clipboard</code>{" "}
        reads and writes the OS clipboard — text, HTML (<code>
          {`readClipboard({ format: "html" })`}
        </code>, <code>{`writeClipboard({ html, text })`}</code>) and PNG images (base64,{" "}
        <code>{`{ format: "image" }`}</code> / <code>{`{ image }`}</code>), with{" "}
        <code>clipboardFormats()</code> listing what it holds. Under the stock runtime{" "}
        <code>dialogs</code>{" "}
        drives the OS dialog programs instead (osascript · PowerShell · zenity/kdialog) and{" "}
        <code>clipboard</code> answers <code>unavailable</code> so the page keeps the WebView&apos;s
        {" "}
        <code>navigator.clipboard</code>. A handle from either dialog path has the same scope. Under
        the pinned runtime <code>notifications</code> are the OS&apos;s own and{" "}
        <code>context-menu</code> is the OS&apos;s native menu (see{" "}
        <a href="#desktop-notifications">Notifications and menus</a>); under the stock runtime they
        answer <code>unavailable</code>{" "}
        and the page keeps the WebView Notification API (immediate only) and its in-page menu.{" "}
        <code>dialogs</code> answers <code>unavailable</code>{" "}
        under the stock runtime on a headless Linux with no{" "}
        <code>zenity</code>/<code>kdialog</code>, so the page&apos;s{" "}
        <code>&lt;input type=&quot;file&quot;&gt;</code> runs.
      </Callout>
      <p>
        The new desktop-only functions reject with code <code>unavailable</code> elsewhere:{" "}
        <code>openPath</code>, <code>revealInFileManager</code> and <code>moveToTrash</code>;{" "}
        <code>saveFile</code> downloads in a browser and <code>pickFolder</code> uses{" "}
        <code>showDirectoryPicker</code> where the browser has it. Storage matters most: without
        {" "}
        <a href="#desktop-app-origin">
          <code>desktop.app.origin</code>
        </a>{" "}
        (or under the stock runtime) a Deno Desktop window gets a new origin each launch, so browser
        storage starts empty every time. Enable <code>secure-store</code>, <code>fs</code> and{" "}
        <code>sqlite</code>{" "}
        for anything that must survive a relaunch; without them the functions fall back to browser
        storage and warn once.
      </p>

      <h3 id="picked-files-and-folders">Picked files and folders</h3>
      <p>
        A page never reaches a file outside the app&apos;s own folders by path. The dialogs{" "}
        <code>pickDocument</code>, <code>saveFile</code> and <code>pickFolder</code> resolve{" "}
        <code>{"{ path, handle }"}</code> (or <code>null</code> when cancelled): the{" "}
        <code>handle</code>{" "}
        is an opaque string the runtime issued for exactly the item the user chose, and the{" "}
        <code>path</code> is for display only; it is never accepted back as authority. Pass{" "}
        <code>{"{ picked: handle }"}</code> as the <code>directory</code> of <code>readFile</code> /
        {" "}
        <code>writeFile</code> / <code>deleteFile</code> / <code>listDir</code> /{" "}
        <code>downloadToFile</code> (paths relative to a picked folder, <code>""</code>{" "}
        for a picked file), and the result or <code>{"{ handle }"}</code> to <code>openPath</code> /
        {" "}
        <code>revealInFileManager</code> / <code>moveToTrash</code>.
      </p>
      <Code lang="ts">
        {`import { listDir, openPath, pickFolder, writeFile } from "denext/mobile";

const folder = await pickFolder(); // { name, path (display only), handle } | null
if (folder) {
  const directory = { picked: folder.handle };
  await writeFile("export/report.csv", csv, { directory, recursive: true });
  const names = (await listDir("export", { directory })).map((e) => e.name);
  await openPath(folder); // the handle travels, not the path
}`}
      </Code>
      <ul>
        <li>
          An open-panel handle (<code>pickDocument</code>) is read-only; a <code>saveFile</code>
          {" "}
          handle reads and writes that one file; a <code>pickFolder</code>{" "}
          handle reads and writes inside the folder (a <code>..</code>{" "}
          or a symlink out of it is refused). Trashing needs a writable handle.
        </li>
        <li>
          <code>listDir</code> on a picked folder returns entry names, never absolute paths.
        </li>
        <li>
          Handles last for the launch. An unknown, forged or expired handle, or a write through a
          read-only one, rejects with code <code>forbidden</code>; narrow it with{" "}
          <code>isDesktopBridgeError</code> from <code>denext/desktop/client</code>. Without the
          {" "}
          <code>fs</code> capability a picked handle rejects <code>unavailable</code>{" "}
          rather than falling back to browser storage.
        </li>
        <li>
          In a browser with the File System Access API (Chromium), the same calls use{" "}
          <code>showDirectoryPicker</code> / <code>showOpenFilePicker</code> /{" "}
          <code>showSaveFilePicker</code>{" "}
          and the handle lasts until the page unloads (the browser asks once before the first
          write). Elsewhere the old fallbacks run: a file input, a download, and{" "}
          <code>unavailable</code> for <code>pickFolder</code>. Inside the iOS/Android shell{" "}
          <code>{"{ picked }"}</code> rejects <code>unavailable</code>.
        </li>
      </ul>

      <h2 id="desktop-window">The window</h2>
      <p>
        <code>denext/desktop/window</code>{" "}
        is the page&apos;s control over its own window: maximize, minimize, fullscreen and their
        events, size and size limits, the displays, the title bar, a backdrop, a cancelable close,
        quitting, and files dragged in and out. It needs no <code>denext desktop add</code>{" "}
        (the runtime registers it for every app). The basics (size, position, title, show / hide)
        work on every runtime; the rest needs denext&apos;s pinned runtime and otherwise rejects
        {" "}
        <code>unsupported</code> — ask <code>windowCapabilities()</code>{" "}
        what this OS and backend can do. Off desktop every call rejects <code>unavailable</code>.
      </p>
      <Code lang="ts">
        {`import {
  getWindowState,
  makeWindowDraggable,
  onCloseRequested,
  onWindowStateChange,
  setWindowBackdrop,
  setWindowBounds,
} from "denext/desktop/window";

// Reopen where the user left it.
const saved = JSON.parse(localStorage.getItem("bounds") ?? "null");
if (saved) await setWindowBounds(saved);
onWindowStateChange(async () => {
  const { normalBounds } = await getWindowState();
  if (normalBounds) localStorage.setItem("bounds", JSON.stringify(normalBounds));
});

// A hidden title bar needs a drag region; vibrancy shows where the page is transparent.
makeWindowDraggable(document.querySelector("header")!);
await setWindowBackdrop("vibrancy", { material: "sidebar" });

// Ask before closing (the close button, Cmd+W / Alt+F4, or quitApp()).
onCloseRequested(() => !hasUnsavedChanges() || confirm("Discard your changes?"));`}
      </Code>
      <ul>
        <li>
          <strong>State</strong>: <code>maximizeWindow</code>, <code>unmaximizeWindow</code>,{" "}
          <code>minimizeWindow</code>, <code>restoreWindow</code>, <code>setFullScreen</code>,{" "}
          <code>getWindowState</code> (with <code>normalBounds</code>, what to persist) and{" "}
          <code>onWindowStateChange</code>.
        </li>
        <li>
          <strong>Size and place</strong>: <code>setWindowSize</code>,{" "}
          <code>setWindowPosition</code>, <code>setWindowBounds</code>,{" "}
          <code>setMinimumWindowSize</code> / <code>setMaximumWindowSize</code> (<code>0</code>{" "}
          = no limit), <code>getScreens</code> and{" "}
          <code>onDisplayChanged</code>. Sizes are CSS pixels; screen positions are points on macOS
          and Linux and physical pixels on Windows&apos; WebView2 backend. Wayland cannot move a
          window.
        </li>
        <li>
          <strong>Chrome</strong>: <code>setTitleBarStyle</code> (<code>"hidden"</code> /{" "}
          <code>"hiddenInset"</code>, macOS), <code>setWindowButtonPosition</code>{" "}
          (the traffic lights), <code>setWindowBackdrop</code> (<code>"mica"</code>,{" "}
          <code>"acrylic"</code>, <code>"tabbed"</code> on Windows 11; <code>"vibrancy"</code>{" "}
          on macOS; none on the CEF backend), each resolving whether it applied, plus{" "}
          <code>setWindowTitle</code>, <code>setWindowResizable</code>, <code>setAlwaysOnTop</code>,
          {" "}
          <code>showWindow</code> / <code>hideWindow</code> / <code>focusWindow</code>.{" "}
          <code>makeWindowDraggable(element)</code> turns a toolbar into a drag region: CSS{" "}
          <code>app-region: drag</code>{" "}
          (native on CEF) and, on the system WebView backends, the window follows the pointer.
          Buttons, links and inputs inside it keep working.
        </li>
        <li>
          <strong>Closing</strong>: while an <code>onCloseRequested</code>{" "}
          handler is registered, the runtime holds every close and asks the page; the window closes
          unless a handler returns{" "}
          <code>false</code>. A page that never answers loses its hold: a close requested again 5
          seconds later goes through. <code>closeWindow()</code> closes without asking;{" "}
          <code>quitApp()</code> asks first (Electron&apos;s{" "}
          <code>app.quit()</code>). Cmd+Q from the macOS app menu is never held. A reload drops the
          hold.
        </li>
      </ul>
      <p>
        The same settings for the first window go in{" "}
        <code>denext.config.ts</code>; the runtime applies them when it adopts the window:
      </p>
      <Code lang="ts">
        {`export default {
  desktop: {
    window: { width: 1200, height: 800, title: "Notes", resizable: true },
    titleBar: "hiddenInset", // macOS: the page under the title bar, the traffic lights inset
    backdrop: "vibrancy", // or "mica" / "acrylic" (Windows 11), "none"
    minSize: { width: 640, height: 480 },
    maxSize: { width: 2560, height: 1600 },
  },
};`}
      </Code>
      <h3 id="desktop-drag-and-drop">Files dragged in and out</h3>
      <p>
        <code>onFileDrop</code>{" "}
        calls its handler once per drop with a READ-ONLY handle for each file or folder (a folder
        handle reads recursively inside it), plus where it was dropped in the page&apos;s CSS
        pixels. A dropped path is untrusted input like an opened file, so the page reads it through
        the handle (with the <code>fs</code>{" "}
        capability), never by path. The page keeps its own DOM drag events for a hover style; on
        Windows&apos; WebView2 the paths arrive only with the drop.{" "}
        <code>startFileDrag(items)</code>{" "}
        drags files out to another app or the desktop, as a copy: call it from the page&apos;s{" "}
        <code>dragstart</code> (after{" "}
        <code>preventDefault()</code>) while the button is held. It takes picked handles or files in
        the app&apos;s own folders (<code>"data"</code>, <code>"cache"</code>,{" "}
        <code>"documents"</code>), never a raw path, and resolves <code>"dropped"</code>,{" "}
        <code>"cancelled"</code> or <code>"failed"</code>.
      </p>
      <Code lang="ts">
        {`import { onFileDrop, startFileDrag } from "denext/desktop/window";
import { readFile } from "denext/mobile";

onFileDrop(async ({ files }) => {
  for (const f of files.filter((f) => f.kind === "file")) {
    show(f.name, await readFile("", { directory: { picked: f.handle } }));
  }
});

exportRow.addEventListener("dragstart", (e) => {
  e.preventDefault();
  void startFileDrag([{ directory: "cache", path: "export/report.pdf" }]);
});`}
      </Code>

      <h2 id="desktop-notifications">Notifications and menus</h2>
      <p>
        With <code>denext desktop add notifications</code> and denext&apos;s pinned runtime,{" "}
        <code>denext/mobile</code>&apos;s local notifications are the OS&apos;s own (macOS{" "}
        <code>UNUserNotificationCenter</code>, Windows toasts, Linux{" "}
        <code>org.freedesktop.Notifications</code>): <code>scheduleNotification</code>{" "}
        shows one now or at its trigger&apos;s time, every trigger kind included;{" "}
        <code>cancelNotification</code> and <code>pendingNotifications</code> work on them;{" "}
        <code>setNotificationCategories</code>{" "}
        gives a notification its action buttons; and a click, on the notification or a button,
        reaches <code>onLocalNotificationTapped</code> with the same <code>data.path</code> /{" "}
        <code>data.url</code>{" "}
        routing as on a phone, including the click that launched the app (macOS, Windows).{" "}
        <code>requestPermission("notifications")</code> and <code>requestPushPermission()</code>
        {" "}
        report the OS setting (a refusal reads <code>blocked</code>: the OS does not ask twice).
      </p>
      <Code lang="ts">
        {`import { onLocalNotificationTapped, requestPermission, scheduleNotification,
  setNotificationCategories } from "denext/mobile";

await setNotificationCategories([{ id: "review", actions: [{ id: "open", title: "Open" }] }]);
if ((await requestPermission("notifications")) === "granted") {
  await scheduleNotification({
    title: "Stand-up",
    body: "In 10 minutes",
    trigger: { type: "weekly", weekday: 2, hour: 9, minute: 50 },
    categoryId: "review",
    data: { path: "/standup" }, // a click opens /standup
  });
}
onLocalNotificationTapped(({ actionId }) => console.log(actionId)); // "tap" or "open"`}
      </Code>
      <ul>
        <li>
          A repeating notification is scheduled for its next 16 occurrences, and the app tops the
          series up whenever it runs (at launch, and as occurrences fire). An app that is not opened
          for longer than those 16 occurrences stops showing it until it runs again.
        </li>
        <li>
          Linux has no notification scheduler: the app delivers a scheduled notification while it
          runs, and one whose time passed while it was closed shows at the next launch. A click on a
          Linux notification after the app quit does not start it.
        </li>
        <li>
          macOS asks the user once (from an app bundle; an unbundled process has no notifications),
          and a refusal can be changed only in System Settings. A notification stores at most 4 KiB
          of <code>data</code> (JSON).
        </li>
      </ul>
      <h3 id="desktop-web-notification">The web Notification API</h3>
      <p>
        A webview has no working <code>Notification</code>{" "}
        (WKWebView has none at all), so code written for a browser or Electron would show nothing.
        With the <code>notifications</code> capability on, denext&apos;s pinned runtime injects a
        {" "}
        <code>Notification</code>{" "}
        into every top-level page, before the page&apos;s own scripts, backed by the same OS
        notifications:
      </p>
      <Code lang="ts">
        {`if ((await Notification.requestPermission()) === "granted") {
  const n = new Notification("Build finished", { body: "main is green", tag: "build" });
  n.onclick = () => window.focus();
}`}
      </Code>
      <ul>
        <li>
          <code>new Notification(title, {"{ body, tag, data }"})</code> posts it now;{" "}
          <code>show</code> fires when it is posted and <code>error</code>{" "}
          when the permission is not <code>granted</code>. A second notification with the same{" "}
          <code>tag</code> replaces the first, in the OS too, and the replaced one gets no{" "}
          <code>close</code>. <code>close()</code> removes it and fires <code>close</code>.
        </li>
        <li>
          A click on it in the OS fires <code>onclick</code> and <code>click</code>{" "}
          on the object that posted it. It never reaches{" "}
          <code>onLocalNotificationTapped</code>, and a click after the page reloaded reaches
          nothing.
        </li>
        <li>
          <code>Notification.permission</code> starts as <code>"default"</code>{" "}
          and holds the OS&apos;s answer a moment after the page loads (a notification created
          before then waits for it); <code>Notification.requestPermission()</code>{" "}
          asks the OS, which prompts only while undecided.
        </li>
        <li>
          Differences from a browser: <code>icon</code>, <code>image</code>, <code>badge</code>,
          {" "}
          <code>silent</code>, <code>requireInteraction</code>, <code>actions</code> and{" "}
          <code>vibrate</code>{" "}
          are kept on the object but not shown (the OS notification has the app&apos;s icon, the
          default sound and no buttons; <code>maxActions</code> is{" "}
          <code>0</code>); a dismissal in the OS fires nothing; there is no service-worker{" "}
          <code>showNotification</code>. For buttons, schedules and launch clicks use{" "}
          <code>scheduleNotification</code>. Under the stock runtime nothing is injected.
        </li>
      </ul>
      <p>
        With <code>denext desktop add context-menu</code>, <code>showContextMenu</code> and{" "}
        <code>useContextMenu</code>{" "}
        open the OS&apos;s native menu at the pointer: submenus nest, disabled items show, a
        subtitle is appended to its label, and the call resolves <code>null</code>{" "}
        when the user dismisses the menu. Under the stock runtime (or without the capability) the
        accessible in-page menu runs instead.
      </p>

      <h2 id="desktop-app-menu">App menu, tray and Dock</h2>
      <p>
        <code>denext/desktop/app</code> drives the app&apos;s own chrome. It needs no capability:
        {" "}
        <code>runDesktop</code>{" "}
        registers it for every app, and it works under the stock runtime too (denext&apos;s pinned
        runtime adds keyboard accelerators on every OS, and menu icons and tooltips; ask{" "}
        <code>appCapabilities()</code>).
      </p>
      <Code lang="ts">
        {`import { bounce, createTray, onAppMenuItem, setAppMenu, setBadge } from "denext/desktop/app";
import { focusWindow, showWindow } from "denext/desktop/window";

await setAppMenu([
  { label: "File", submenu: [
    { id: "new", label: "New Window", accelerator: "CommandOrControl+N" },
    "separator",
    { role: "quit" },
  ] },
  { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, "separator",
    { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
]);
onAppMenuItem((id) => id === "new" && openWindow());

const icon = new Uint8Array(await (await fetch("/tray.png")).arrayBuffer());
const tray = await createTray({ icon, tooltip: "Acme",
  menu: [{ id: "show", label: "Show Acme" }, "separator", { role: "quit" }] });
tray.onMenuItem(async (id) => {
  if (id === "show") await showWindow().then(() => focusWindow());
});

await setBadge(3);                // the Dock / taskbar badge; null clears it
await bounce({ critical: true }); // until the app is focused`}
      </Code>
      <ul>
        <li>
          <code>setAppMenu</code>{" "}
          sets the macOS menu bar, or the window&apos;s menu bar on Windows and Linux. Items take an
          {" "}
          <code>id</code>, <code>label</code>, <code>accelerator</code>{" "}
          (<code>"CommandOrControl+Shift+K"</code>), <code>disabled</code>, <code>checked</code>,
          {" "}
          <code>tooltip</code> and a PNG <code>icon</code>; <code>{"{ label, submenu }"}</code>{" "}
          nests; <code>{"{ role }"}</code> is a standard item the OS handles (<code>copy</code>,
          {" "}
          <code>paste</code>, <code>selectAll</code>, <code>undo</code>, <code>redo</code>,{" "}
          <code>quit</code>, <code>about</code>, <code>hide</code>, <code>minimize</code>,{" "}
          <code>toggleFullScreen</code>, …).
        </li>
        <li>
          <code>createTray</code>{" "}
          adds a status icon (the macOS menu bar, the Windows notification area, Linux&apos;s
          AppIndicator area) with a tooltip, a menu and click events; <code>update</code>,{" "}
          <code>getBounds</code> and <code>destroy</code>{" "}
          are on the handle. A page load removes the trays the previous page created (their handlers
          went with it), so create them at startup.
        </li>
        <li>
          <code>setBadge</code>{" "}
          badges the Dock icon (macOS) or the taskbar button (Windows), and prefixes the window
          title on Linux. <code>bounce</code>{" "}
          bounces the Dock icon, flashes the taskbar button or marks the window urgent.
        </li>
        <li>
          The Dock menu is <code>denext/mobile</code>&apos;s <code>setQuickActions</code> /{" "}
          <code>onQuickAction</code>: the same calls that set an iOS or Android app&apos;s
          home-screen quick actions set the Dock icon&apos;s menu on macOS (Windows and Linux have
          none, and the call does nothing there).
        </li>
      </ul>

      <h3 id="desktop-shortcuts">Global shortcuts and launch at login</h3>
      <p>
        Two opt-in capabilities, each needing denext&apos;s pinned runtime.{" "}
        <code>denext desktop add global-shortcuts</code> enables <code>registerShortcut</code>{" "}
        (macOS hot keys with no Accessibility prompt, Windows{" "}
        <code>RegisterHotKey</code>, X11 key grabs, and the XDG GlobalShortcuts portal on Wayland,
        where the user approves each shortcut). A registered combination reaches the app whichever
        app has the focus, and the other app no longer sees it, so register only what the user asked
        for. <code>denext desktop add launch-at-login</code> enables <code>getLaunchAtLogin</code> /
        {" "}
        <code>setLaunchAtLogin</code> (a macOS 13+ login item, a Windows <code>Run</code>{" "}
        value, a Linux XDG autostart entry, named after{" "}
        <code>desktop.app.identifier</code>); turn it on from a setting the user controls. Neither
        adds a Deno permission.
      </p>
      <Code lang="ts">
        {`import {
  registerShortcut,
  setLaunchAtLogin,
  shortcutCapabilities,
  unregisterAllShortcuts,
} from "denext/desktop/app";

const quick = await registerShortcut("CommandOrControl+Shift+Space", () => toggleQuickEntry());
// rejects with code "conflict" (another app holds it), "denied" (Wayland), "unsupported", …
await quick.unregister();

await unregisterAllShortcuts(); // e.g. when the user turns the feature off
const { globalShortcuts, userBinds } = await shortcutCapabilities(); // userBinds: Wayland's portal

const state = await setLaunchAtLogin(true);
if (state === "requires-approval") hint("Allow Acme in System Settings › Login Items");`}
      </Code>

      <h3 id="desktop-devtools">DevTools</h3>
      <p>
        The web inspector (F12, the context menu, Safari&apos;s Develop menu, remote debugging) is
        on in <code>denext desktop dev</code> and{" "}
        <code>denext desktop run</code>, and OFF in a packaged app.{" "}
        <code>desktop.inspectable: true</code> ships an inspectable build; <code>false</code>{" "}
        also turns it off in <code>run</code>. The package scripts write it to the app&apos;s{" "}
        <code>laufey-launch.json</code> (<code>"inspectable"</code>), and <code>run</code> /{" "}
        <code>dev</code> pass{" "}
        <code>LAUFEY_INSPECTABLE</code>. It needs denext&apos;s pinned runtime: the stock runtime
        ignores it.
      </p>

      <h2 id="desktop-extensions">Your own native extensions</h2>
      <p>
        When a built-in is not enough, write an extension: TypeScript that runs in the Deno process,
        with FFI (<code>Deno.dlopen</code>{" "}
        of a C-ABI library) or a sidecar binary when it needs native code. Each method declares
        Standard Schemas for its input and output; the runtime validates the page's arguments before
        the handler runs and strips the result after it. List it in{" "}
        <code>desktop.capabilities.extensions</code>, then call it from the page through{" "}
        <code>denext/desktop/client</code>. The page half (<code>desktopExtension</code>,{" "}
        <code>onDesktopEvent</code>) is in <code>denext/desktop/client</code>;{" "}
        <code>defineDesktopExtension</code> is exported from <code>denext/desktop</code>:
      </p>
      <Code lang="tsx">
        {`// desktop/extensions/scanner.ts: runs in the Deno process only
import { defineDesktopExtension } from "denext/desktop";
import { z } from "zod";
export default defineDesktopExtension({
  name: "scanner",
  events: ["attached"],
  methods: {
    listDevices: {
      input: z.object({ kind: z.string().optional() }),
      output: z.array(z.string()),
      permissions: { ffi: ["./native/libscanner.dylib"] }, // documents it; grant it below
      // args are validated by input but typed unknown here (the page is typed from the schemas)
      handler: (args) => listDevices((args as { kind?: string }).kind), // FFI, a sidecar, or Deno
    },
  },
});

// a "use client" component
import { desktopExtension, isDesktopBridgeError, onDesktopEvent } from "denext/desktop/client";
import type scanner from "../desktop/extensions/scanner.ts";

const scan = desktopExtension<typeof scanner>("scanner");
const devices = await scan.listDevices({ kind: "usb" }); // string[], typed from the schemas
const stop = onDesktopEvent<{ id: string }>("scanner", "attached", ({ id }) => refresh(id));
// Off desktop (the web, iOS, Android) a call rejects without a request:
// isDesktopBridgeError(err) && err.code === "unavailable"`}
      </Code>
      <p>
        Add <code>"denext/desktop/client"</code> to your <code>deno.json</code> imports next to{" "}
        <code>denext/mobile</code>. A call rejects with a <code>DesktopBridgeError</code> whose{" "}
        <code>code</code> is <code>unavailable</code> (not a desktop window, or not enabled),{" "}
        <code>forbidden</code> (the gate refused it), <code>validation</code>, <code>timeout</code>
        {" "}
        (30 s by default; pass <code>{"{ timeoutMs }"}</code>), <code>too_large</code>{" "}
        (a request over 4 MiB), or the extension's own code (throw a <code>DesktopCapError</code>
        {" "}
        from <code>denext/desktop</code> with a code and a safe message). A method's{" "}
        <code>permissions</code>{" "}
        document what it needs, but the package scripts derive flags from the built-in catalog only:
        grant an extension&apos;s permissions in <code>desktop.extraPermissions</code>{" "}
        (the same keys: <code>read</code>, <code>write</code>, <code>net</code>, <code>env</code>,
        {" "}
        <code>sys</code>, <code>run</code>, <code>ffi</code>; <code>"*"</code>{" "}
        bakes the unscoped flag). The scripts union it into the flags they bake, and{" "}
        <code>--regenerate-scripts</code>{" "}
        keeps it because it lives in the config, not in the script. Events that fire before a
        handler subscribes (a notification click that launched the app, a deep link) are kept by the
        runtime and delivered to the first subscriber.
      </p>
      <Code lang="ts">
        {`// denext.config.ts
desktop: {
  capabilities: { extensions: ["./desktop/extensions/scanner.ts"] },
  extraPermissions: { ffi: ["./native/libscanner.dylib"] }, // baked into the package
},`}
      </Code>

      <h3 id="desktop-main-thread">Native code on the UI thread</h3>
      <p>
        AppKit, Win32 windows and GTK objects belong to the app's UI thread, and a handler runs on
        the JavaScript thread. <code>ctx.runOnMainThread(fn, context?)</code> calls a C function
        {" "}
        <code>void* fn(void* context)</code> (a <code>Deno.UnsafeFnPointer</code>, a{" "}
        <code>Deno.UnsafeCallback</code>, or a pointer from{" "}
        <code>dlsym</code>) on the UI thread, queued behind the UI work already posted, and resolves
        with its pointer-sized return value as a <code>bigint</code> (the pointer&apos;s type is
        {" "}
        <code>DesktopMainThreadFn</code>, from{" "}
        <code>denext/desktop</code>). It is FFI, so it is full trust: grant <code>ffi</code> in{" "}
        <code>desktop.extraPermissions</code>, and a wrong pointer or signature crashes the app. A
        {" "}
        <code>Deno.UnsafeCallback</code>{" "}
        runs on the JavaScript thread while the UI thread waits for it, so it must not wait for the
        UI thread itself. It needs denext's pinned runtime: on the stock runtime it rejects with a
        {" "}
        <code>DesktopCapError</code> whose code is{" "}
        <code>unsupported</code>, and once the app is quitting it rejects without calling{" "}
        <code>fn</code>.
      </p>
      <Code lang="ts">
        {`// desktop/extensions/dock.ts: runs in the Deno process only (macOS)
import { defineDesktopExtension } from "denext/desktop";
const c = (s: string) => new TextEncoder().encode(s + "\\0");
const dl = Deno.dlopen("/usr/lib/libSystem.B.dylib", {
  dlopen: { parameters: ["buffer", "i32"], result: "pointer" },
  dlsym: { parameters: ["pointer", "buffer"], result: "pointer" },
});
// void* dock_refresh(void* context) touches AppKit, so it must run on the UI thread
const lib = dl.symbols.dlopen(c("/path/to/libdock.dylib"), 2 /* RTLD_NOW */);
const refresh = dl.symbols.dlsym(lib, c("dock_refresh"))!;
export default defineDesktopExtension({
  name: "dock",
  methods: {
    refresh: { handler: async (_args, ctx) => String(await ctx.runOnMainThread(refresh)) },
  },
});`}
      </Code>

      <h3 id="desktop-node-api">Node-API addons</h3>
      <p>
        An extension can also load a Node-API addon: an npm package that ships a prebuilt{" "}
        <code>.node</code>{" "}
        per platform (the napi-rs and node-gyp-build packages: database drivers, hashing, image
        codecs). It loads in the packaged app on macOS, Windows and Linux under denext&apos;s pinned
        runtime, which on Windows gives the app&apos;s executable the <code>napi_*</code>{" "}
        exports an addon looks for there. Import it in the extension (never in the page), and grant
        {" "}
        <code>ffi: ["*"]</code> in{" "}
        <code>desktop.extraPermissions</code>: the packaged app loads the addon from its embedded
        file system, whose path cannot be named at package time, so a path-scoped{" "}
        <code>--allow-ffi</code> never matches it.
      </p>
      <Code lang="ts">
        {`// denext.config.ts
desktop: {
  capabilities: { extensions: ["./desktop/hash.ts"] },
  extraPermissions: { ffi: ["*"] }, // the package scripts bake --allow-ffi
},

// desktop/hash.ts: runs in the Deno process only
import { defineDesktopExtension } from "denext/desktop";
import { crc32 } from "@node-rs/crc32"; // deno.json: "npm:@node-rs/crc32@1.10.8"
export default defineDesktopExtension({
  name: "hash",
  methods: { crc32: { handler: (args) => crc32(String((args as { text?: unknown }).text)) } },
});`}
      </Code>
      <p>
        Package on each target OS: Deno resolves the host&apos;s prebuilt binary from the
        package&apos;s per-platform dependencies, and the package script embeds it.{" "}
        <a href="https://github.com/Brainwires/denext/tree/main/examples/desktop-kitchen-sink">
          examples/desktop-kitchen-sink
        </a>{" "}
        loads <code>@node-rs/crc32</code>{" "}
        this way, and its window test checks it on all three OSes along with every other capability.
      </p>

      <h2 id="desktop-runtime">The denext Deno Desktop runtime</h2>
      <p>
        <code>denext desktop run</code>, <code>dev</code>, <code>package</code> and the scaffolded
        {" "}
        <code>scripts/package-*.ts</code>{" "}
        build on denext&apos;s pinned Deno Desktop runtime: a prebuilt <code>libdenort</code>{" "}
        and laufey backend hosts from{" "}
        <a href="https://github.com/Brainwires/deno/releases">Brainwires/deno</a>{" "}
        (Deno 2.9.7 plus the patches behind the stable app origin, per-app web storage, deep links
        and single instance). Your stock <code>deno</code>{" "}
        CLI does the build; denext points it at the runtime through <code>DENORT_DESKTOP_BIN</code>
        {" "}
        and <code>LAUFEY_DEV_DIR</code>.
      </p>
      <p>
        Every change the runtime makes to stock Deno Desktop and why, how it is tested and verified,
        and how it retires upstream:{" "}
        <a href="/docs/desktop-runtime">Our Deno Desktop runtime: what we ship and why</a>.
      </p>
      <ul>
        <li>
          <strong>Deno 2.9.7 exactly.</strong> The runtime is built from Deno 2.9.7, and{" "}
          <code>deno desktop</code>{" "}
          embeds it, so any other version fails before the build with the fix:{" "}
          <code>deno upgrade --version 2.9.7</code>.
        </li>
        <li>
          <strong>Downloaded once, verified before use.</strong>{" "}
          The archive for your target and backend (<code>desktop.backend</code> in{" "}
          <code>deno.json</code>, <code>webview</code> by default, or{" "}
          <code>cef</code>) is pinned in denext by URL, size and SHA-256. It streams to a temp file,
          is refused the moment it outgrows its pinned size, and is extracted only after its size
          and SHA-256 match. Extraction refuses absolute paths, <code>..</code>{" "}
          entries, links that leave the directory and special files. The result moves into{" "}
          <code>denext-desktop-runtime/&lt;version&gt;/&lt;target&gt;-&lt;backend&gt;/</code>{" "}
          in Deno&apos;s cache (<code>DENO_DIR</code>, else its default) in one rename, with a
          marker holding every file&apos;s size and SHA-256. Two builds at once are safe.
        </li>
        <li>
          <strong>Offline after the first download.</strong>{" "}
          A cached runtime is reused without the network (a size check against the marker;{" "}
          <code>--verify-runtime</code>{" "}
          re-hashes every file). With no cache and no network the build stops and says so.
        </li>
        <li>
          <strong>Provenance, optionally.</strong> <code>--attest-runtime</code> also runs{" "}
          <code>gh attestation verify</code>{" "}
          on a fresh download (it needs the GitHub CLI; the SHA-256 pin is enforced either way).
        </li>
        <li>
          <strong>Targets.</strong>{" "}
          macOS (arm64, x86_64), Linux (x86_64, arm64) and Windows (x86_64), each with the{" "}
          <code>webview</code> and <code>cef</code>{" "}
          backends. The stock CLI finds a prebuilt backend with the host&apos;s executable suffix,
          so a Windows app is packaged on Windows, and a Linux app on macOS or Linux.
        </li>
        <li>
          <code>denext doctor</code>{" "}
          reports the pinned runtime version, whether it is cached and verified for this machine,
          and whether <code>deno</code> is the version it needs.
        </li>
      </ul>
      <Code lang="sh">
        {`DENEXT_DESKTOP_RUNTIME=stock denext desktop package   # the stock runtime (no app origin,
                                                      # deep links or single instance)
DENEXT_DESKTOP_RUNTIME_DIR=~/src/deno-runtime denext desktop run   # a local runtime build,
                                                      # unverified (runtime development)`}
      </Code>
      <p>
        An existing project adopts the runtime with{" "}
        <code>denext desktop package --regenerate-scripts</code> (its scripts gain the{" "}
        <code>desktopRuntimeEnv</code> call from <code>denext/desktop</code>). The baked{" "}
        <code>--allow-*</code>{" "}
        of the packaged app do not change: the download happens in the packaging script, not in the
        app.
      </p>

      <h2 id="desktop-app-origin">A stable app origin</h2>
      <p>
        The stock Deno Desktop runtime serves the window from{" "}
        <code>http://127.0.0.1:&lt;port&gt;</code>{" "}
        with a new port every launch, so the page's origin changes each time. Set{" "}
        <code>desktop.app.origin</code>{" "}
        to give the window one origin that never changes, on every launch and machine:
      </p>
      <Code lang="ts">
        {`// denext.config.ts
export default {
  desktop: {
    app: {
      identifier: "com.example.myapp", // required with an origin
      origin: "myapp://app",
    },
  },
};`}
      </Code>
      <ul>
        <li>
          The origin is <code>&lt;scheme&gt;://&lt;host&gt;</code> with a custom scheme.{" "}
          <code>http</code>, <code>https</code>, <code>file</code>, <code>ws</code>,{" "}
          <code>wss</code>, <code>ftp</code>, <code>blob</code>, <code>data</code>,{" "}
          <code>about</code>{" "}
          and the browser-internal schemes are refused, as are a port, a path and userinfo. Scheme
          and host are lower-cased.
        </li>
        <li>
          An origin needs <code>desktop.app.identifier</code>{" "}
          (a reverse-DNS id): web storage is keyed by origin, so two apps sharing an origin would
          otherwise share it. Config validation, <code>denext doctor</code>{" "}
          and the desktop entry all refuse an origin without one.
        </li>
        <li>
          The packaging scripts write <code>.deno-desktop/app.json</code>{" "}
          (the origin and identifier), add it to <code>compile.include</code> in{" "}
          <code>deno.json</code> (keeping your other entries), and put a{" "}
          <code>laufey-launch.json</code> in the packaged app (<code>Contents/Resources</code>{" "}
          on macOS, next to the executable on Windows and Linux) with the app id and the origin's
          scheme. <code>denext desktop run</code> and <code>dev</code> write the same{" "}
          <code>app.json</code>. Run <code>denext desktop package --regenerate-scripts</code>{" "}
          to adopt this in an older project.
        </li>
        <li>
          In the window, the app's server code reads the origin from{" "}
          <code>DENO_DESKTOP_APP_ORIGIN</code>. WebSockets cannot use the custom scheme: the page
          dials the loopback relay in <code>DENO_DESKTOP_WS_ORIGIN</code>{" "}
          (<code>ws://127.0.0.1:&lt;port&gt;</code>), which admits only requests whose{" "}
          <code>Origin</code> is the app origin.
        </li>
        <li>
          The desktop runtime hands the relay to the page as{" "}
          <code>__denext.wsOrigin</code>. denext&apos;s Live client (<code>&lt;Live&gt;</code>,{" "}
          <code>useLive</code>,{" "}
          <code>usePresence</code>, channels and subscriptions) dials it on its own; for your own
          sockets, <code>desktopWebSocketUrl(path)</code> from <code>denext/desktop/client</code>
          {" "}
          returns the relay URL in such a window and <code>ws(s)://&lt;host&gt;</code>{" "}
          everywhere else (<code>desktopWsOrigin()</code> returns just the relay origin):
          <Code lang="ts">
            {`import { desktopWebSocketUrl } from "denext/desktop/client";

const socket = new WebSocket(desktopWebSocketUrl("/api/events"));`}
          </Code>
          The socket carries the page&apos;s own <code>Origin</code> (the app origin, e.g.{" "}
          <code>myapp://app</code>), and the desktop runtime checks it again before your{" "}
          <code>onRequest</code> or a proxied backend sees the upgrade. A backend behind{" "}
          <code>spa.proxy</code> that checks the WebSocket <code>Origin</code>{" "}
          must accept the app origin.
        </li>
        <li>
          A denext backend accepts the app&apos;s own <code>desktop.app.origin</code>{" "}
          wherever it accepts same-origin: Server Actions, the typed-API batch, the Live socket,
          {" "}
          <code>denextAuth</code>&apos;s POSTs and the <code>denext dev</code>{" "}
          origin gate. The match is exact (the normalized{" "}
          <code>myapp://app</code>); another scheme or host is refused, and nothing changes while
          {" "}
          <code>desktop.app.origin</code>{" "}
          is unset. A separate backend project lists the desktop app&apos;s origin in{" "}
          <a href="/docs/config#dev-server">
            <code>allowedDevOrigins</code>
          </a>{" "}
          (dev) or <code>createApp</code>&apos;s{" "}
          <code>allowedOrigins</code>. Any local program can send any{" "}
          <code>Origin</code>, so these checks guard against browsers, and a web page cannot produce
          a custom-scheme origin: accepting the app&apos;s own origin does not widen browser-borne
          CSRF.
        </li>
      </ul>
      <Callout kind="note">
        The custom origin needs{" "}
        <a href="#desktop-runtime">
          denext&apos;s pinned Deno Desktop runtime
        </a>, which <code>denext desktop</code>{" "}
        and the package scripts use by default. A packaged app with an origin and an identifier
        keeps its <code>localStorage</code>{" "}
        across launches (checked on macOS, Linux and Windows with the webview backend). Under{" "}
        <code>DENEXT_DESKTOP_RUNTIME=stock</code>{" "}
        the stock runtime ignores the origin and serves the window on a loopback port (the desktop
        entry logs that the origin is not in effect). Nothing breaks either way: the security gates
        detect which runtime they are under.
      </Callout>

      <h2 id="desktop-preload">A preload script</h2>
      <p>
        <code>desktop.preload</code>{" "}
        is Electron's preload for Deno Desktop: a module that runs in the window before any of the
        page's scripts, to expose bridges such as <code>window.desktopBridge</code>{" "}
        or Clerk's before the app reads them.
      </p>
      <Code lang="ts">
        {`// denext.config.ts
export default { desktop: { preload: "./desktop/preload.ts" } };`}
      </Code>
      <ul>
        <li>
          The export bundles it into one classic script (<code>out/_denext/desktop-preload.js</code>
          , imports and dynamic imports inlined). The runtime inlines it right after the{" "}
          <code>__denext</code>{" "}
          global, before the page's first script, into every top-level document it serves over the
          memory transport, and adds its <code>sha256</code> hash to a strict CSP's{" "}
          <code>script-src</code>. <code>denext desktop dev</code>{" "}
          bundles it per session (restart the session after editing it).
        </li>
        <li>
          It is not injected into an iframe, and not under the stock runtime (loopback). It needs
          {" "}
          <a href="#desktop-runtime">denext's pinned runtime</a>.
        </li>
        <li>
          <strong>It is trusted app code with the page's privileges.</strong>{" "}
          A webview has no isolated world, so unlike an Electron preload under{" "}
          <code>contextIsolation</code> it shares <code>window</code>{" "}
          with the page: it is a way to run early, not a sandbox.
        </li>
      </ul>

      <h2 id="desktop-deep-links">Deep links and opened files</h2>
      <p>
        <code>desktop.app.deepLinks</code>{" "}
        (<code>["myapp"]</code>) registers URL schemes with the OS (packaging writes them to
        deno.json <code>desktop.app.deepLinks</code>, where <code>deno desktop</code>{" "}
        puts them in the bundle, and to <code>.deno-desktop/app.json</code>{" "}
        for the runtime). Under denext's pinned runtime a link with one of these schemes reaches
        {" "}
        <a href="/docs/mobile#deep-links">
          <code>onDeepLink</code> / <code>useDeepLink</code>
        </a>{" "}
        from{" "}
        <code>denext/mobile</code>, unchanged: the link that started the app (cold start), one
        opened while it runs (macOS), and one a second launch forwards (Windows and Linux, with{" "}
        <code>desktop.app.singleInstance: true</code>{" "}
        — the second process hands its arguments to the first, which comes to the front, and exits).
        The same <code>accept</code>{" "}
        filter and once-only routing apply; the runtime delivers each link once (a cold-start link
        waits for the first subscriber, none is replayed after a reload), and a link whose scheme is
        not declared is dropped.
      </p>
      <p>
        Files opened with the app arrive through <code>onOpenFile</code> / <code>useOpenFile</code>
        {" "}
        as <strong>read-only</strong> picked handles (read with{" "}
        <code>readFile("", {"{ directory: { picked: handle } }"})</code>, which needs the{" "}
        <code>fs</code>{" "}
        capability). Any program of the user can open any path with the app, so a link or a file is
        untrusted input. <code>denext desktop run</code> and <code>dev</code>{" "}
        windows never take the single-instance lock.
      </p>
      <Code lang="ts">
        {`// denext.config.ts → desktop: { app: { deepLinks: ["myapp"], singleInstance: true },
//                               capabilities: { fs: true } }
import { onDeepLink, onOpenFile, readFile } from "denext/mobile";
import { claimDeepLinkScheme, deepLinkSchemeOwner } from "denext/desktop/client";

// Once, at startup (the app shell; useDeepLink / useOpenFile are the hook forms).
// myapp://threads/42 navigates to /threads/42 (route: false leaves it to you).
onDeepLink(({ url, launch }) => console.log(launch ? "launched by" : "opened", url), {
  accept: { schemes: ["myapp"] },
});
onOpenFile(async ({ handle, name }) => {
  openDocument(name, await readFile("", { directory: { picked: handle } }));
});

// Advisory: which app gets myapp: links right now ("self" | "other" | "none").
if ((await deepLinkSchemeOwner("myapp")).owner === "other") {
  // claimDeepLinkScheme must run in the user's click on this banner's button
  showBanner("Open myapp: links in this app", () => claimDeepLinkScheme("myapp"));
}`}
      </Code>
      <p>
        <code>deepLinkSchemeOwner(scheme)</code> (from{" "}
        <code>denext/desktop/client</code>) reports which app the OS hands the scheme to (<code>
          self
        </code>, <code>other</code> with its <code>handler</code> for display, or{" "}
        <code>none</code>), a snapshot any program can change.{" "}
        <code>claimDeepLinkScheme(scheme)</code>{" "}
        takes it over, only from the user&apos;s click (<code>user_activation_required</code>{" "}
        otherwise) and at most once per scheme per launch (<code>claim_limit</code>); a Windows{" "}
        &quot;UserChoice&quot; cannot be overridden (<code>registered: false</code>).
      </p>

      <h2 id="desktop-security">Security model</h2>
      <p>
        Under the stock runtime any local process can reach the app's loopback port, so the page's
        only power is one gated bridge, and every request must pass all of: the per-launch token in
        {" "}
        <code>x-denext-desktop-token</code>, an <code>Origin</code> exactly equal to the window's,
        {" "}
        <code>content-type: application/json</code>{" "}
        (a foreign page cannot send that cross-origin without a preflight, which the runtime
        refuses), and <code>POST</code>{" "}
        for calls. Then the capability allowlist, then the method's input schema. There are no
        bridge endpoints outside the desktop runtime, and off desktop the page never requests one.
      </p>
      <ul>
        <li>
          <strong>With a stable app origin.</strong>{" "}
          Under the denext-pinned runtime the page is served in-process, with no loopback port for
          HTTP. The gates then trust a request only when it arrived over that in-process transport
          (as <code>Deno.serve</code>{" "}
          reports it, never from the URL, which a client can forge) and carries the token; an{" "}
          <code>Origin</code>, when present, must be the app origin exactly, and a request without
          one is accepted only over the in-process transport. A WebSocket upgrade must carry the app
          origin, checked by the runtime's relay and again by the app. The runtime is detected at
          startup from{" "}
          <code>DENO_DESKTOP_APP_ORIGIN</code>; without it the loopback rules above apply unchanged.
        </li>
        <li>
          <strong>The token and the page.</strong>{" "}
          The runtime injects the token into the top-level document only (never into frames), behind
          a hash-based CSP, and strips it before anything is proxied. It is per launch and never
          leaves the machine. But any script running in the page can read it: an XSS in your UI can
          use every capability you enabled. Keep the strict CSP, do not load remote scripts into the
          window, and enable only what you use.
        </li>
        <li>
          <strong>Permissions are honest about their reach.</strong> <code>fs</code> and{" "}
          <code>sqlite</code> stay inside the app's folders. <code>dialogs</code>{" "}
          needs unscoped read and write, because Deno bakes permissions at build time and the user
          picks paths at run time; the runtime narrows file calls to the paths picked this session.
          {" "}
          <code>--allow-run</code> and <code>--allow-ffi</code> (<code>shell</code>,{" "}
          <code>keep-awake</code>, <code>secure-store</code>, <code>dialogs</code> — whose{" "}
          <code>osascript</code> / <code>powershell.exe</code>{" "}
          are script interpreters — and your extensions) are full trust: that program or library can
          do anything the user can.
        </li>
        <li>
          <strong>Errors carry codes, not internals.</strong>{" "}
          A failure reaches the page as a code and a short message; arguments, paths from the
          handler's stack, and the token never appear in it.
        </li>
      </ul>

      <h2 id="desktop-react-native">React Native on desktop</h2>
      <p>
        A <a href="/docs/react-native">React Native / Expo app</a> (<code>reactNative: true</code>,
        {" "}
        <code>mode: "spa"</code>) runs in a Deno Desktop window like any SPA:{" "}
        <code>denext desktop run</code>{" "}
        exports it (react-native-web renders it to the DOM) and opens it natively, and{" "}
        <code>denext desktop package</code> ships it. The platform APIs are the{" "}
        <code>denext/mobile</code>{" "}
        ones above, so one component tree persists to the OS keychain on desktop (with the desktop
        runtime and the <code>secure-store</code>{" "}
        capability), the iOS Keychain in the Capacitor shell, and IndexedDB on the web. See{" "}
        <a href="https://github.com/Brainwires/denext/tree/main/examples/rn-desktop">
          <code>examples/rn-desktop</code>
        </a>.
      </p>
      <ul>
        <li>
          <code>Platform.OS</code> stays <code>"web"</code>{" "}
          in the window, on purpose: react-native-web and RN libraries choose their DOM code paths
          from it. Tell desktop apart with <code>Platform.constants.denextDesktop</code> (and{" "}
          <code>Platform.constants.os</code>: <code>"macos"</code>, <code>"windows"</code> or{" "}
          <code>"linux"</code>, when the runtime reports it) or <code>runtimePlatform()</code> from
          {" "}
          <code>denext/mobile</code>. Without a <code>web</code> key, <code>Platform.select</code>
          {" "}
          picks the host OS key (<code>macos</code>, <code>windows</code>,{" "}
          <code>linux</code>) in the window, then <code>default</code>.
        </li>
        <li>
          Coming from <code>react-native-windows</code> or{" "}
          <code>react-native-macos</code>: shared RN code runs; their C++, C# and Objective-C native
          modules do not. Rewrite a native module as a{" "}
          <a href="#desktop-extensions">desktop extension</a>{" "}
          (the TurboModule's methods become schema-typed methods; its events become{" "}
          <code>onDesktopEvent</code>).
        </li>
      </ul>
      <p>
        In React Native mode an import of <code>react-native-windows</code> or{" "}
        <code>react-native-macos</code> resolves to <code>react-native</code>{" "}
        (react-native-web with the shell overlay) plus what the package adds, so the real packages
        are never read or needed. A deep <code>Libraries/</code> import resolves as the same{" "}
        <code>react-native</code> path.
      </p>
      <p>
        An app written for one desktop package usually imports <code>react-native</code>{" "}
        and lets Metro swap in the desktop build. Do the same with{" "}
        <code>reactNative: {"{"} desktopPackage: "react-native-macos" {"}"}</code> (or{" "}
        <code>"react-native-windows"</code>): a bare <code>react-native</code>{" "}
        import in your own source then resolves as that package, with its <code>View</code>{" "}
        props and components, while <code>node_modules</code> keep plain <code>react-native</code>.
        {" "}
        <code>denext migrate --from expo</code>{" "}
        writes it when the app depends on one of the two packages (on both, it leaves the choice
        commented).
      </p>
      <table class="table">
        <thead>
          <tr>
            <th>Package API</th>
            <th>In React Native mode</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>Flyout</code>, <code>Popup</code> (Windows)
            </td>
            <td>
              A popover over react-native-web's <code>Modal</code> while{" "}
              <code>isOpen</code>, against <code>target</code>{" "}
              (an element or a ref; centred without one) at <code>placement</code>{" "}
              with the offsets; a tap outside (<code>isLightDismissEnabled</code>) or Escape calls
              {" "}
              <code>onDismiss</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>Glyph</code> (Windows)
            </td>
            <td>
              A <code>Text</code> of <code>glyph</code> at{" "}
              <code>emSize</code>, in the font family named by the <code>fontUri</code>{" "}
              <code>#fragment</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>AppTheme</code> (Windows)
            </td>
            <td>
              High contrast from <code>forced-colors</code>, its palette as CSS system colors, and
              {" "}
              <code>highContrastChanged</code>; light and dark are <code>Appearance</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>supportKeyboard</code>, <code>EventPhase</code> (Windows)
            </td>
            <td>The component itself; the phase constants</td>
          </tr>
          <tr>
            <td>
              <code>DynamicColorMacOS</code>, <code>ColorWithSystemEffectMacOS</code> (macOS)
            </td>
            <td>
              A light / dark CSS color (as <code>DynamicColorIOS</code>); a CSS{" "}
              <code>color-mix()</code> per effect. <code>PlatformColor</code>{" "}
              knows the NSColor and Windows system color names
            </td>
          </tr>
          <tr>
            <td>
              <code>View</code> props
            </td>
            <td>
              <code>tooltip</code> → <code>title</code>; <code>onDoubleClick</code> → a{" "}
              <code>dblclick</code> listener; <code>keyDownEvents</code> / <code>keyUpEvents</code>
              {" "}
              / <code>validKeysDown</code>{" "}
              → a key filter (listed keys are handled; macOS passes only those to{" "}
              <code>onKeyDown</code>, Windows every key); <code>enableFocusRing</code> → the{" "}
              <code>:focus-visible</code>{" "}
              ring. In a Deno Desktop window (denext&apos;s pinned runtime):{" "}
              <code>mouseDownCanMoveWindow</code>{" "}
              → a window drag region (<code>makeWindowDraggable</code>); <code>allowsVibrancy</code>
              {" "}
              → the window&apos;s macOS vibrancy; <code>draggedTypes</code>{" "}
              (<code>"fileUrl"</code>) → <code>onDragEnter</code> / <code>onDragLeave</code> /{" "}
              <code>onDrop</code> with read-only handles (the DOM&apos;s{" "}
              <code>File</code>s in a browser). <code>acceptsFirstMouse</code>{" "}
              → accepted, with a dev warning
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        The desktop <code>View</code> props apply to a <code>View</code>{" "}
        imported from the desktop package; one imported from <code>react-native</code>{" "}
        is react-native-web's. <code>deno task parity:native -- desktop</code>{" "}
        checks both aliases against the pinned packages (react-native-windows 0.84.0,
        react-native-macos 0.81.9).
      </p>

      <h2 id="mobile-capacitor">Mobile (Capacitor)</h2>
      <p>
        The iOS/Android material moved to its own page,{" "}
        <a href="/docs/mobile">Mobile (Capacitor)</a>. Each section keeps its anchor there:
      </p>
      <ul>
        <li id="live-reload-on-a-device">
          <a href="/docs/mobile#live-reload-on-a-device">Live reload on a device</a>
        </li>
        <li id="the-denextmobile-runtime">
          <a href="/docs/mobile#the-denextmobile-runtime">
            The <code>denext/mobile</code> runtime
          </a>
        </li>
        <li id="native-capabilities">
          <a href="/docs/mobile#native-capabilities">Native capabilities</a>
        </li>
        <li id="context-menus">
          <a href="/docs/mobile#context-menus">Context menus</a>
        </li>
        <li id="deep-links">
          <a href="/docs/mobile#deep-links">Deep links</a>
        </li>
        <li id="auth-sessions">
          <a href="/docs/mobile#auth-sessions">Auth sessions</a>
        </li>
        <li id="push-notifications">
          <a href="/docs/mobile#push-notifications">Push notifications</a>
        </li>
        <li id="app-extensions">
          <a href="/docs/mobile#app-extensions">App extensions</a>
        </li>
        <li id="over-the-air-ui-updates">
          <a href="/docs/mobile#over-the-air-ui-updates">Over-the-air UI updates</a>
        </li>
        <li id="native-fingerprint">
          <a href="/docs/mobile#native-fingerprint">Native fingerprint</a>
        </li>
        <li id="building-in-ci">
          <a href="/docs/mobile#building-in-ci">Building in CI</a>
        </li>
      </ul>

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
          <code>DENEXT_INSTALLER_IDENTITY</code> — a{" "}
          <code>"Developer ID Installer: … (TEAMID)"</code> identity that signs the macOS{" "}
          <code>.pkg</code> (unsigned without it).
        </li>
        <li>
          <code>DENEXT_WINDOWS_CERT</code> — a code-signing <code>.pfx</code> for Authenticode (the
          {" "}
          <code>.exe</code> and the <code>.msi</code>); unset, nothing is signed.{" "}
          <code>DENEXT_WINDOWS_CERT_PASSWORD</code> is its password (redacted from errors) and{" "}
          <code>DENEXT_SIGN_TIMESTAMP_URL</code>{" "}
          an RFC 3161 timestamp server (default DigiCert&apos;s).
        </li>
        <li>
          <code>DENEXT_APP_NAME</code> — output base name (defaults to <code>desktop.app.name</code>
          {" "}
          from <code>denext.config.ts</code>, else from <code>deno.json</code>).
        </li>
        <li>
          <code>DENEXT_OTA_SIGNING_KEY</code> — the private signing key for{" "}
          <code>denext ota manifest --sign</code> and{" "}
          <code>denext desktop publish-update</code>, in place of <code>--key</code>.
        </li>
        <li>
          <code>DENEXT_DESKTOP_RUNTIME</code>, <code>DENEXT_DESKTOP_RUNTIME_DIR</code>,{" "}
          <code>DENEXT_DESKTOP_RUNTIME_VERIFY</code>, <code>DENEXT_DESKTOP_RUNTIME_ATTEST</code>
          {" "}
          — which Deno Desktop runtime builds the app and how it is checked; see{" "}
          <a href="/docs/desktop-runtime#how-it-works">the runtime page</a>.
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
