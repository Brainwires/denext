import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Desktop apps (macOS)",
  description:
    "Package a denext app as a native macOS .app with deno desktop: build (single-arch or universal), code-sign with a Developer ID identity, and notarize + staple for distribution.",
};

export default function Desktop() {
  return (
    <DocsShell
      active="desktop"
      title="Desktop apps (macOS)"
      lead="denext exports a self-contained static app, and deno desktop wraps it in a native window and compiles it to a single binary. Scaffolding with the desktop target adds a packaging script that builds for one or more architectures, code-signs, and — with a Developer ID identity and notarytool credentials — notarizes and staples the bundle so it opens cleanly on other Macs."
    >
      <h2>The desktop target</h2>
      <p>
        Scaffold with the desktop target (<code>denext create --desktop</code>,
        or add it to an existing project) and you get a <code>desktop.ts</code>
        {" "}
        entry, a <code>desktop</code> block in <code>deno.json</code>, an{" "}
        <code>icons/</code> folder, and two tasks:
      </p>
      <ul>
        <li>
          <code>deno task desktop</code>{" "}
          — export and open the app in a native window (dev).
        </li>
        <li>
          <code>deno task desktop:package</code> — run{" "}
          <code>scripts/package-macos.ts</code>: export, build (embedding{" "}
          <code>out/</code>), and code-sign into <code>dist/</code>.
        </li>
      </ul>
      <Callout kind="note">
        The scaffolded <code>desktop.ts</code>{" "}
        quits the whole app when its window is closed (the macOS red button /
        {" "}
        <kbd>⌘W</kbd>). <code>deno desktop</code>{" "}
        only auto-exits when no windows are open <em>and</em>{" "}
        there are no live async tasks — and <code>Deno.serve()</code>{" "}
        is always live — so the entry adopts the window via{" "}
        <code>Deno.BrowserWindow</code> and calls <code>Deno.exit(0)</code>{" "}
        on its <code>close</code> event.
      </Callout>

      <h2>Building for one or more architectures</h2>
      <p>
        macOS runs on Apple Silicon (<code>arm64</code>) and Intel (<code>
          x86_64
        </code>). <code>deno desktop</code>{" "}
        builds one architecture at a time and can cross-compile, so the
        packaging script exposes an <code>--arch</code> flag:
      </p>
      <Code lang="bash">
        {`# the machine's own architecture (default)
deno task desktop:package

# a specific architecture (cross-compiles if needed)
deno task desktop:package --arch arm64
deno task desktop:package --arch x86_64

# both, as two separate .app bundles
deno task desktop:package --arch both

# one universal .app whose binaries are lipo-merged (runs natively on both)
deno task desktop:package --arch universal`}
      </Code>
      <p>
        A universal bundle is built by compiling both architectures and merging
        each Mach-O binary with{" "}
        <code>lipo</code>; the merged bundle is then re-signed (merging
        invalidates the previous signature). Everything lands in{" "}
        <code>dist/</code>. Pass <code>--dmg</code> to also wrap each
        <code>.app</code> in a <code>.dmg</code>, and <code>--no-export</code>
        {" "}
        to reuse an existing <code>out/</code>.
      </p>

      <h2>Code signing</h2>
      <p>
        By default the bundle is <strong>ad-hoc</strong> signed (the{" "}
        <code>-</code>{" "}
        identity): it runs on your machine, but Gatekeeper blocks it on other
        Macs. To distribute, sign with a
        <strong>Developer ID Application</strong>{" "}
        certificate. This is a specific certificate type — not the{" "}
        <em>Apple Development</em>{" "}
        certificate Xcode creates for on-device testing, and being signed into
        Xcode does not make the tooling use it automatically.
      </p>
      <Callout kind="warn">
        You need a <strong>Developer ID Application</strong>{" "}
        certificate, issued from a paid Apple Developer account (you must be the
        Account Holder or an Admin). Create it in{" "}
        <strong>
          Xcode → Settings → Accounts → your team → Manage Certificates → + →
          Developer ID Application
        </strong>{" "}
        (or on developer.apple.com). Confirm it is installed with{" "}
        <code>security find-identity -p codesigning -v</code>.
      </Callout>
      <p>
        Point the packaging script at it with an environment variable — no
        secret is written into the repo:
      </p>
      <Code lang="bash">
        {`export DENEXT_CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
deno task desktop:package --arch universal`}
      </Code>
      <p>
        With a real identity the bundle is signed inside-out with the Hardened
        Runtime and a secure timestamp (both required for notarization). Provide
        a custom entitlements plist with{" "}
        <code>DENEXT_ENTITLEMENTS=/path/to/entitlements.plist</code>{" "}
        if your app needs specific capabilities.
      </p>

      <h2>Notarization</h2>
      <p>
        Notarization is a separate step: Apple scans the signed bundle and
        issues a ticket that you staple into the app so it opens without a
        warning offline. First store your notary credentials once in a keychain
        profile:
      </p>
      <Code lang="bash">
        {`xcrun notarytool store-credentials "denext-notary" \\
  --apple-id "you@example.com" \\
  --team-id  "TEAMID" \\
  --password "app-specific-password"   # from appleid.apple.com`}
      </Code>
      <p>
        Then set the profile name; the script submits the bundle, waits for the
        result, and staples the ticket:
      </p>
      <Code lang="bash">
        {`export DENEXT_CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export DENEXT_NOTARY_PROFILE="denext-notary"
deno task desktop:package --arch universal --dmg`}
      </Code>
      <p>
        The resulting <code>.app</code> (and <code>.dmg</code>) in{" "}
        <code>dist/</code>{" "}
        is signed, notarized, and stapled — ready to distribute.
      </p>

      <h2>Environment variables</h2>
      <ul>
        <li>
          <code>DENEXT_CODESIGN_IDENTITY</code> — the{" "}
          <code>"Developer ID Application: … (TEAMID)"</code>{" "}
          identity. Omit for an ad-hoc, local-only build.
        </li>
        <li>
          <code>DENEXT_NOTARY_PROFILE</code> — a{" "}
          <code>notarytool store-credentials</code>{" "}
          profile name. Set (with a real identity) to notarize + staple.
        </li>
        <li>
          <code>DENEXT_ENTITLEMENTS</code> — path to an entitlements{" "}
          <code>.plist</code> (optional).
        </li>
        <li>
          <code>DENEXT_APP_NAME</code> — output base name (defaults to{" "}
          <code>desktop.app.name</code> from <code>deno.json</code>).
        </li>
      </ul>

      <Callout kind="note">
        Signing and notarization shell out to <code>codesign</code> and{" "}
        <code>xcrun notarytool</code>, so <code>desktop:package</code>{" "}
        must run on a macOS host — even when cross-compiling to the other Mac
        architecture. Windows and Linux bundles are produced by the same{" "}
        <code>--target</code>{" "}
        mechanism but are signed with their own platform tooling.
      </Callout>
    </DocsShell>
  );
}
