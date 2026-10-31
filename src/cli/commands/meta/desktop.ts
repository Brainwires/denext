// The help text of `denext desktop` (the verb's summary, usage, flags and positionals: what
// `--help`, `denext --help`, shell completions and the CLI reference print), implemented in
// ../desktop.ts. Edit it here, then run `deno task gen:command-table` (or `deno task regen`). Not
// published: scripts/gen-command-table.ts packs it into src/cli/command-meta.packed.ts, and the
// verb's spec reads it back with `...commandMeta("<verb>")` (src/cli/command-meta.ts).

import type { CommandMeta } from "../../lazy-command.ts";
import { OTA_SIGNING_KEY_ENV } from "../../../build/ota-signing.ts";
import { APP_UPDATE_DEFAULT_EXPIRY_DAYS } from "../../../build/app-update.ts";
import type { FlagSpec } from "../../command.ts";

/** The flags `desktop add` reads (declared on the `desktop` command). */
export const DESKTOP_ADD_FLAGS: readonly FlagSpec[] = [
  { name: "list", type: "boolean", help: "add: list the desktop capabilities and what they need" },
  { name: "dry-run", type: "boolean", help: "add: print the config diff and permissions only" },
  {
    name: "name",
    type: "string",
    valueName: "<name>",
    help: "add sidecar: the sidecar's name (lower-case letters, digits and -)",
  },
  {
    name: "node-modules",
    type: "string",
    valueName: "<dir>",
    help: "add sidecar: the --entry module's node_modules (a Node backend, bundled at packaging)",
  },
  {
    name: "exec",
    type: "string",
    valueName: "<program>",
    help: "add sidecar: a program to spawn instead of a module",
  },
  {
    name: "ready",
    type: "string",
    valueName: "<path>",
    help: "add sidecar: a path polled on its port until it answers 2xx (e.g. /health)",
  },
  { name: "proxy", type: "boolean", help: "add sidecar: point spa.proxy at it" },
  {
    name: "rp-id",
    type: "string",
    valueName: "<domain>",
    repeatable: true,
    help: "add passkeys: a relying party's domain for desktop.capabilities.passkeys.rpIds " +
      "(repeatable)",
  },
];

/** The flags `desktop publish-update` adds to the `desktop` verb. */
export const PUBLISH_UPDATE_FLAGS: FlagSpec[] = [
  {
    name: "artifact",
    type: "string",
    valueName: "<path>",
    help:
      "publish-update: the packaged app (.app, app directory or .AppImage); a macOS .app must be notarized",
  },
  {
    name: "url-base",
    type: "string",
    valueName: "<url>",
    help: "publish-update: the https URL the archives will be served under",
  },
  {
    name: "app-version",
    type: "string",
    valueName: "<semver>",
    help:
      "publish-update: the version being published (default: deno.json version, else package.json's)",
  },
  {
    name: "app-id",
    type: "string",
    valueName: "<id>",
    help: "publish-update: the app identifier (default: desktop.app.identifier)",
  },
  {
    name: "platform",
    type: "string",
    valueName: "<key>",
    help:
      "publish-update: <rust-target>-<webview|cef>[-appimage] (default: detected for this host)",
  },
  {
    name: "min-version",
    type: "string",
    valueName: "<semver>",
    help: "publish-update: older versions are told the update is required",
  },
  {
    name: "notes",
    type: "string",
    valueName: "<text>",
    help: "publish-update: release notes",
  },
  {
    name: "key",
    type: "string",
    valueName: "<file>",
    help: `publish-update: the signing key PEM (default: ${OTA_SIGNING_KEY_ENV})`,
  },
  {
    name: "out",
    type: "string",
    valueName: "<dir>",
    help: "publish-update: where the archive and app-update.json go (default: dist/updates)",
  },
  {
    name: "expires-in",
    type: "string",
    valueName: "<days>",
    help:
      `publish-update: days until installed apps refuse the manifest (default ${APP_UPDATE_DEFAULT_EXPIRY_DAYS}); re-sign before`,
  },
  {
    name: "expires-at",
    type: "string",
    valueName: "<rfc3339>",
    help: "publish-update: an explicit expiry time instead of --expires-in",
  },
  {
    name: "sequence",
    type: "string",
    valueName: "<n>",
    help:
      "publish-update: the release counter (default: Unix seconds, never below the existing manifest's)",
  },
  {
    name: "resign",
    type: "boolean",
    help:
      "publish-update: re-sign the existing app-update.json in --out with a fresh expiry (no artifact)",
  },
];

/** The flags only `desktop doctor` reads. */
export const DESKTOP_DOCTOR_FLAGS: readonly FlagSpec[] = [
  {
    name: "linux",
    type: "boolean",
    help: "doctor: run the Linux session checks (tray host, Secret Service, portals, …); the " +
      "default on a Linux host",
  },
];

/** `denext desktop`. */
export const desktopMeta: CommandMeta = {
  name: "desktop",
  summary: "Build/run/package the app as a native desktop app",
  loadsModules: true,
  usage:
    "  denext desktop run                     Export, build into a temp dir and open the window\n" +
    "  denext desktop build                   Export the SPA to out/\n" +
    "  denext desktop dev                     Live reload: open a window proxied to `denext dev`\n" +
    "  denext desktop dev --lan               …attach to a dev server on your network (loopback else)\n" +
    "  denext desktop dev --inspect-renderer  …and open the window's renderer to a debugger (CDP on\n" +
    "                                         a free loopback port; --inspect-renderer=127.0.0.1:9229)\n" +
    "  denext desktop package                 Build a distributable bundle for the host OS\n" +
    "  denext desktop package --target-os windows  Cross-build (Linux and Windows from any OS)\n" +
    "  denext desktop package --format msi,zip    Pick the installers (dmg|pkg, tar.gz|deb|rpm|appimage, msi|zip)\n" +
    "  denext desktop package --regenerate-scripts  Rewrite scripts/package-*.ts from the current template\n" +
    "  denext desktop add secure-store fs     Enable capabilities in desktop.capabilities (--list, --dry-run)\n" +
    "  denext desktop add sidecar --name api --entry server/main.mjs --node-modules server/node_modules\n" +
    "                                         Run a backend next to the window (desktop.sidecars)\n" +
    "  denext desktop publish-update --artifact dist/MyApp.app --url-base https://updates.example.com/myapp/\n" +
    "                                         Sign a full-app update (archive + app-update.json)\n" +
    "  denext desktop publish-update --resign Re-sign the published manifest before it expires\n" +
    "  denext desktop doctor                  The pinned runtime, and on Linux the session's tray host,\n" +
    "                                         Secret Service and portals, each with a fix (--json)\n" +
    "  Deno's own `deno desktop` (compile a script into a desktop app): `denext deno desktop`.",
  positionals: [
    {
      name: "action",
      help: "run | build | dev | package | add | publish-update | doctor (default: run)",
    },
    { name: "dir", help: "Project directory (default: .)" },
  ],
  flags: [
    {
      name: "entry",
      type: "string",
      valueName: "<file>",
      help: "Desktop entry (default: desktop.ts)",
    },
    {
      name: "target-os",
      type: "string",
      valueName: "<os>",
      help: "package for: macos | linux | windows (default: the host OS; Linux and Windows " +
        "cross-build from any OS, macOS packages on a Mac)",
    },
    {
      name: "port",
      alias: "p",
      type: "number",
      valueName: "<port>",
      help: "dev: the dev server port to start or attach to (default: 3000)",
    },
    {
      name: "host",
      type: "string",
      valueName: "<host>",
      help: "dev: the host to bind and proxy to (default: localhost; non-loopback needs --lan)",
    },
    {
      name: "lan",
      type: "boolean",
      help: "dev: attach to a dev server on the LAN (a non-loopback target; opt in explicitly)",
    },
    {
      name: "inspect-renderer",
      type: "string",
      optionalValue: true,
      valueName: "[=<addr>]",
      help: "dev: open the window's renderer to a debugger — the Chrome DevTools Protocol on CEF " +
        "and WebView2, WebKit's inspector on WebKitGTK (default: 127.0.0.1 and a free port)",
    },
    {
      name: "inspect-renderer-allow-remote",
      type: "boolean",
      help: "dev: let --inspect-renderer take a non-loopback address (the port is full control " +
        "of the page)",
    },
    {
      name: "format",
      type: "string",
      valueName: "<list>",
      help: "package: the installers to build, comma-separated — macOS dmg | pkg; Linux tar.gz | " +
        "deb | rpm | appimage; Windows msi | zip (default: desktop.installers.<os>, else " +
        "dmg / tar.gz,deb / msi)",
    },
    {
      name: "regenerate-scripts",
      type: "boolean",
      help:
        "package: rewrite scripts/package-*.ts from the current template (least-privilege flags), " +
        "keeping a .bak of any file that differs",
    },
    {
      name: "verify-runtime",
      type: "boolean",
      help: "run | dev | package: re-hash the cached Deno Desktop runtime before use " +
        "(DENEXT_DESKTOP_RUNTIME_VERIFY=1)",
    },
    {
      name: "attest-runtime",
      type: "boolean",
      help: "run | dev | package: require the build provenance check of a downloaded runtime " +
        "(`gh attestation verify`, run by default whenever gh is signed in; " +
        "DENEXT_DESKTOP_RUNTIME_ATTEST=1, =0 turns it off)",
    },
    ...DESKTOP_ADD_FLAGS,
    ...PUBLISH_UPDATE_FLAGS,
    ...DESKTOP_DOCTOR_FLAGS,
  ],
};
