import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Desktop apps",
  description:
    "Ship a denext app as a native desktop app (a signed/notarized macOS .app, a Linux bundle, a Windows zip) with the denext desktop command: live reload in the window, sign-in through the system browser, and signed UI self-updates. iOS/Android is on the Mobile (Capacitor) page.",
};

export default function Desktop() {
  return (
    <DocsShell
      active="desktop"
      title="Desktop apps"
      lead="denext exports a self-contained static app, and deno desktop wraps it in a native window and compiles it to a single binary. The denext desktop verb drives it — run to open a dev window, build to export, and package to produce a distributable bundle: a macOS .app (code-signed and, with a Developer ID identity and notarytool credentials, notarized + stapled) or a Linux bundle (.tar.gz, plus an AppImage when appimagetool is present). Windows packages to a zip via denext desktop package --target-os windows (Authenticode-signed when DENEXT_WINDOWS_CERT is set). The same export ships to iOS and Android in a Capacitor shell: see Mobile (Capacitor)."
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
        <code>--include out</code>,{" "}
        <code>--allow-net=127.0.0.1,localhost --allow-read --allow-env</code>,{" "}
        <code>--exclude-unused-npm</code>, and (for a pnpm/yarn app pinning{" "}
        <code>nodeModulesDir: "manual"</code>) <code>--node-modules-dir=none</code>{" "}
        so the runtime's own npm dep resolves from Deno's global cache.{" "}
        <code>denext migrate --desktop</code> writes that task for you.
      </Callout>

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
        mode on. The runtime honours it only when the window runs under the <code>deno</code>{" "}
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
        endpoints (the OAuth loopback sheet and the updater boot beacon) are always served locally
        and are never proxied to the dev server, and the per-launch desktop token is stripped from a
        request before it is forwarded.
      </Callout>
      <Callout kind="note">
        <strong>No extra permissions.</strong> <code>denext desktop dev</code>{" "}
        needs network access to the loopback dev port only — exactly what the{" "}
        <code>--allow-net=127.0.0.1,localhost</code> a migrated SPA bakes into its{" "}
        <code>deno task desktop</code>{" "}
        already grants, because the window talks only to the local dev server. (The scaffolded
        packaging scripts still build with <code>-A</code>; see{" "}
        <a href="#desktop-capabilities">Native capabilities</a>.)
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

      <h2 id="desktop-sign-in">Sign-in on Deno Desktop</h2>
      <p>
        In a Deno Desktop window (<code>runtimePlatform()</code> is{" "}
        <code>"desktop"</code>), the same{" "}
        <a href="/docs/mobile#auth-sessions">
          <code>openAuthSession</code>
        </a>{" "}
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
        scripts will derive the app's <code>--allow-*</code> flags from.
      </p>
      <Callout kind="warn">
        <strong>The desktop runtime lands in 2.11.</strong> The page side described here (the{" "}
        <code>denext/mobile</code> desktop branches, <code>denext desktop add</code> and{" "}
        <code>denext/desktop/client</code>) has shipped and is tested against a fake of the bridge.
        The runtime that answers it is still being built. Until it ships, a real window answers{" "}
        <code>unavailable</code>{" "}
        and every function keeps its web path, so browser storage is still wiped on every relaunch,
        and the scaffolded packaging scripts build with <code>-A</code>{" "}
        instead of the permissions in the table below.
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
              <code>secureStore</code> (Keychain / Credential Manager / libsecret)
            </td>
            <td>
              <code>--allow-ffi</code>: Security.framework · advapi32.dll · libsecret-1.so.0
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
              <code>--allow-read</code> /{" "}
              <code>--allow-write</code>: the app-support and cache folders
            </td>
            <td>scoped</td>
          </tr>
          <tr>
            <td>
              <code>sqlite</code>
            </td>
            <td>
              <code>openSqlite</code>, <code>deleteSqlite</code> (<code>node:sqlite</code>)
            </td>
            <td>the app-support folder</td>
            <td>scoped</td>
          </tr>
          <tr>
            <td>
              <code>context-menu</code>
            </td>
            <td>
              <code>showContextMenu</code> (the OS menu)
            </td>
            <td>none</td>
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
              <code>dialogs</code>
            </td>
            <td>
              <code>pickDocument</code>, <code>saveFile</code>, <code>pickFolder</code> (paths)
            </td>
            <td>
              unscoped <code>--allow-read</code> /{" "}
              <code>--allow-write</code>, plus osascript · comdlg32 · zenity/kdialog
            </td>
            <td>broad</td>
          </tr>
          <tr>
            <td>
              <code>notifications</code>
            </td>
            <td>
              <code>scheduleNotification</code>, <code>cancelNotification</code>,{" "}
              <code>pendingNotifications</code>, <code>onLocalNotificationTapped</code>
            </td>
            <td>none</td>
            <td>none</td>
          </tr>
          <tr>
            <td>
              <code>keep-awake</code>
            </td>
            <td>
              <code>useKeepAwake</code>
            </td>
            <td>caffeinate · kernel32.dll · systemd-inhibit</td>
            <td>full</td>
          </tr>
          <tr>
            <td>
              <code>clipboard</code>
            </td>
            <td>
              <code>readClipboard</code>, <code>writeClipboard</code> (no user gesture)
            </td>
            <td>none</td>
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
        </tbody>
      </table>
      <p>
        The new desktop-only functions reject with code <code>unavailable</code> elsewhere:{" "}
        <code>openPath</code>, <code>revealInFileManager</code> and <code>moveToTrash</code>;{" "}
        <code>saveFile</code> downloads in a browser and <code>pickFolder</code> uses{" "}
        <code>showDirectoryPicker</code>{" "}
        where the browser has it. Storage matters most: a Deno Desktop window gets a new origin each
        launch, so browser storage starts empty every time. Enable <code>secure-store</code>,{" "}
        <code>fs</code> and <code>sqlite</code>{" "}
        for anything that must survive a relaunch; without them the functions fall back to browser
        storage and warn once.
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
        <code>onDesktopEvent</code>) is available now; <code>defineDesktopExtension</code> ships in
        {" "}
        <code>denext/desktop</code> with the desktop runtime in 2.11:
      </p>
      <Code lang="tsx">
        {`// desktop/extensions/scanner.ts: runs in the Deno process only
import { defineDesktopExtension } from "denext/desktop";
import { z } from "zod";
export default defineDesktopExtension({
  name: "scanner",
  permissions: { ffi: ["./native/libscanner.dylib"] },
  events: ["attached"],
  methods: {
    listDevices: {
      input: z.object({ kind: z.string().optional() }),
      output: z.array(z.string()),
      handler: ({ kind }) => listDevices(kind), // FFI, a sidecar, or plain Deno
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
        (a request over 4 MiB), or the extension's own code. Events that fire before a handler
        subscribes (a notification click that launched the app, a deep link) are kept by the runtime
        and delivered to the first subscriber.
      </p>

      <h2 id="desktop-security">Security model</h2>
      <p>
        Any local process can reach the app's loopback port, so the page's only power is one gated
        bridge, and every request must pass all of: the per-launch token in{" "}
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
          <code>keep-awake</code>,{" "}
          <code>secure-store</code>, your extensions) are full trust: that program or library can do
          anything the user can.
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
              <code>:focus-visible</code> ring; <code>acceptsFirstMouse</code>,{" "}
              <code>mouseDownCanMoveWindow</code>, <code>allowsVibrancy</code>,{" "}
              <code>draggedTypes</code> → accepted, with a dev warning
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
