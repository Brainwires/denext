// The built-in list of npm packages whose lifecycle scripts legitimately need more than the
// lifecycle-script jail gives them.
//
// denext's Deno runs an approved dependency's `preinstall` / `install` / `postinstall` jailed
// (Brainwires/deno DENEXT.md items 83 and 103; on by default from runtime 3.0.0-rc.5): a scrubbed
// environment, a scratch HOME removed after the script, writes only beneath node_modules, no
// credential files, no network, every `deno` it starts clamped, and OS confinement where the OS
// has it. A package that downloads at install time, or writes outside node_modules, fails there.
//
// The jail's only per-package lever is deno.json's
// `"supplyChain": { "jailScripts": { "packages": { "<name>": { "env": [...], "write": [...],
// "net": true } } } }`: environment variables passed through, extra writable directories
// (relative to that deno.json) and the network. From runtime 3.0.0-rc.6 (DENEXT.md item 108)
// `net` also takes the hosts the scripts may reach, and a `write` path may start with `~` (the
// user's home, resolved when the jail runs); each entry below names its download hosts and, for
// a download cache under the home, the cache directory and its variable, used on runtimes that
// take them (`net: true` and no cache grant on older ones). Also from rc.6 (item 111) a script
// writes only beneath its own package's folder, and executables left in a `~` path are removed
// unless the entry sets `"executables": true`: an entry names the node_modules directories
// outside its package that it writes (`siblingWrite`), and a browser cache gets `executables`.
// From denext.1 (item 124) the download host a package declares for itself (node-pre-gyp's
// `binary.host`) is honoured only when `jailScripts.knownPackages` lists it: `declaredHosts`
// holds the reviewed ones; where the runtime passes on a declared host's redirects, a declared
// `github.com` also gets the hosts GitHub redirects a release download to
// ({@linkcode DECLARED_HOST_REDIRECTS}), which denext grants as a `net` list on a runtime that
// doesn't. There is no per-package opt-out, so
// each entry is the narrowest grant that lets the script do its job. `denext migrate` / `create` / `add` write the entries for
// the dependencies they find, and `denext doctor` flags a missing one; nothing here ever turns the
// jail off. Data only: src/build/jail-scripts.ts reads it. The runtime mirrors this list (its
// `cli/supply_chain/builtin_exceptions.rs`): a change here is a change there too.
//
// Every host grant here is pinned to port 443 ({@linkcode BUILTIN_JAIL_PORT}), as the runtime pins
// its own: the downloads are HTTPS, and a host a script may reach is also a way out for what it
// can read, so a built-in grant opens that host's HTTPS port and no other. A bare host in deno.json
// means every port; a host the project lists itself keeps the meaning it gives it. A declared host
// (`declaredHosts`, written to `knownPackages`) stays a bare name: the runtime matches it by name.

/** The only port a built-in host grant opens: each host below is written `host:443`. */
export const BUILTIN_JAIL_PORT = 443;

/** One package's exception, in the shape of deno.json's `supplyChain.jailScripts.packages.<name>`. */
export interface JailPackageException {
  /** Environment variables passed through to the package's scripts. */
  readonly env?: readonly string[];
  /** Extra directories the package's scripts may write to, relative to the deno.json. */
  readonly write?: readonly string[];
  /**
   * The network for the package's scripts: `true`, or (runtime 3.0.0-rc.6 and later) the hosts
   * they may reach.
   */
  readonly net?: boolean | readonly string[];
  /**
   * Runtime 3.0.0-rc.6 and later: keep the files with an execute bit the scripts leave in a `~`
   * write path (a browser download), which the jail otherwise removes.
   */
  readonly executables?: boolean;
}

/**
 * A download cache under the user's home that the package keeps across installs. It holds the
 * downloaded browser or app, so on a runtime that sweeps executables out of `~` write paths the
 * entry also gets `"executables": true`.
 */
export interface JailCache {
  /** The variable naming the cache directory, passed through (`PUPPETEER_CACHE_DIR`). */
  readonly env: string;
  /** The directory, `~`-relative as the runtime resolves it (`~/.cache/puppeteer`). */
  readonly path: string;
}

/**
 * A project directory an exception's `write` needs, found when the project is read:
 * `git-hooks` is the repository's `.git/hooks`, `msw-worker` each directory package.json's
 * `msw.workerDirectory` names, `prisma-output` each generator `output` of the Prisma schema that
 * lies outside node_modules.
 */
export type JailWriteTarget = "git-hooks" | "msw-worker" | "prisma-output";

/** A package in the built-in list. */
export interface JailExceptionEntry {
  /** The npm package whose lifecycle script needs the exception. */
  readonly name: string;
  /**
   * Direct dependencies that bring it in (besides {@linkcode name} itself): `@prisma/engines`
   * comes with `prisma` and `@prisma/client`.
   */
  readonly via?: readonly string[];
  /** What the script does, and why the jail stops it. */
  readonly reason: string;
  /**
   * The exception, before {@linkcode writeTargets} are resolved, on a runtime without per-package
   * host lists (`net` is `true` there).
   */
  readonly exception: JailPackageException;
  /**
   * The hosts the script downloads from (redirect targets included), each `host:443`
   * ({@linkcode BUILTIN_JAIL_PORT}), the `net` grant on a runtime that takes a host list. A mirror
   * or proxy the user configures needs its own host added.
   */
  readonly hosts?: readonly string[];
  /**
   * A download cache under the home kept across installs on a runtime that takes `~` write
   * paths: written to `write`, its variable to `env`. It takes effect only with the variable set
   * to that directory for the install and the app.
   */
  readonly cache?: JailCache;
  /**
   * Project directories added to `write` when they are found. An entry with nothing else that
   * finds none needs no exception (msw without a `workerDirectory` copies nothing).
   */
  readonly writeTargets?: readonly JailWriteTarget[];
  /**
   * Directories outside the package's own folder that its script writes, relative to the
   * project (`node_modules/.prisma`): added to `write` on a runtime that confines a script's
   * writes to its own package (3.0.0-rc.6 and later), where nothing else is needed before.
   */
  readonly siblingWrite?: readonly string[];
  /**
   * The download hosts the package's own package.json declares (node-pre-gyp's `binary.host`),
   * reviewed: written to `jailScripts.knownPackages` on a runtime that honours a declared host
   * only when that lists it (3.0.0-denext.1 and later). Older runtimes allow a declared host by
   * itself. A declared `github.com` (a release download) redirects to the hosts in
   * {@linkcode DECLARED_HOST_REDIRECTS}: a runtime that passes on a declared host's redirects
   * allows them with it, and on one that doesn't the entry's `net` lists them.
   */
  readonly declaredHosts?: readonly string[];
  /** What the exception cannot fix, and what to do about it. */
  readonly caveat?: string;
}

/** The scratch-HOME caveat of the packages that download into a cache under the user's home. */
const HOME_CACHE =
  "The jail's HOME is a scratch directory removed after the script, so a download into the " +
  "default cache under your home is lost: set the cache variable to the directory the exception " +
  "lists under `write` (on runtimes before 3.0.0-rc.6, to a directory in the project and list " +
  "that under `write`) for the install and the app, or skip the download here and install the " +
  "browser after the install.";

/** GitHub release downloads: the release URL and the hosts it redirects to, on port 443. */
const GITHUB = [
  "github.com:443",
  "objects.githubusercontent.com:443",
  "release-assets.githubusercontent.com:443",
];

/**
 * The hosts a declared download host hands its downloads off to, keyed by that host: a script
 * allowed the declared host needs these too, as its download fails without them. Built-in
 * grants, so pinned to {@linkcode BUILTIN_JAIL_PORT}. Mirrors the runtime's `DECLARED_HOST_REDIRECTS`.
 */
export const DECLARED_HOST_REDIRECTS: Readonly<Record<string, readonly string[]>> = {
  "github.com": GITHUB.slice(1),
};

/**
 * The hosts a declared download host (`host`, any port, any case, a trailing dot allowed)
 * redirects to; empty for a host that serves its files itself.
 *
 * @param host The declared host.
 * @returns The redirect targets.
 */
export function declaredHostRedirects(host: string): readonly string[] {
  const port = /:(\d*)$/.exec(host);
  const name = (port ? host.slice(0, port.index) : host).replace(/\.+$/, "").toLowerCase();
  return Object.hasOwn(DECLARED_HOST_REDIRECTS, name) ? DECLARED_HOST_REDIRECTS[name] : [];
}

/** The reason of the node-pre-gyp packages whose older versions declare a GitHub release host. */
const GITHUB_DECLARED = "install (`node-pre-gyp install`) downloads the prebuilt binding from " +
  "the GitHub release its package.json declares (`binary.host`), else builds it";

/** node-gyp's Node.js headers, for a build from source (port 443). */
const NODE_HEADERS = "nodejs.org:443";

/** The caveat of the packages that build from source with node-gyp when no prebuilt binary fits. */
const NODE_GYP = "A build from source with node-gyp also downloads the Node.js headers (set " +
  "`npm_config_nodedir` to local headers to avoid it) and needs Python, make and a C++ compiler.";

/** The Playwright browser packages that download their browser at install. */
const PLAYWRIGHT_BROWSERS = ["chromium", "firefox", "webkit"] as const;

/** Playwright's browser download CDNs (its built-in mirror list). */
const PLAYWRIGHT_HOSTS = [
  "cdn.playwright.dev:443",
  "playwright.azureedge.net:443",
  "playwright.download.prss.microsoft.com:443",
];

/**
 * The built-in exception list, sorted by package name. Reviewed against each package's install
 * script; `tests/jail-scripts.test.ts` checks its shape.
 */
export const JAIL_SCRIPT_EXCEPTIONS: readonly JailExceptionEntry[] = [
  {
    name: "@discordjs/opus",
    declaredHosts: ["github.com"],
    reason: GITHUB_DECLARED,
    exception: {},
    caveat: NODE_GYP,
  },
  {
    name: "@prisma/client",
    hosts: ["binaries.prisma.sh:443"],
    reason: "postinstall runs `prisma generate`, which may download the engines (from " +
      "binaries.prisma.sh) and writes the client to the generator's `output`",
    exception: {
      net: true,
      env: [
        "PRISMA_ENGINES_MIRROR",
        "PRISMA_GENERATE_SKIP_AUTOINSTALL",
        "PRISMA_SKIP_POSTINSTALL_GENERATE",
      ],
    },
    writeTargets: ["prisma-output"],
    siblingWrite: ["node_modules/.prisma"],
    caveat: "The project's `.env` is unreadable inside the jail; `prisma generate` does not " +
      "need it, but a schema whose generator block reads `env(...)` does. The default " +
      "`prisma-client-js` output is `node_modules/.prisma`; with an isolated `node_modules` " +
      "(a deno.json project's `node_modules/.deno/` layout) it lies beside `@prisma/client`'s " +
      "real folder instead: give the generator an `output` in the project, which is granted.",
  },
  {
    name: "@prisma/engines",
    hosts: ["binaries.prisma.sh:443"],
    via: ["prisma", "@prisma/client"],
    reason: "postinstall downloads the query and schema engines from binaries.prisma.sh into " +
      "its package",
    exception: {
      net: true,
      env: [
        "PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING",
        "PRISMA_ENGINES_MIRROR",
        "PRISMA_QUERY_ENGINE_BINARY",
        "PRISMA_QUERY_ENGINE_LIBRARY",
        "PRISMA_SCHEMA_ENGINE_BINARY",
      ],
    },
  },
  {
    name: "@sentry/cli",
    hosts: ["downloads.sentry-cdn.com:443"],
    reason: "install.js downloads the sentry-cli binary into its package when the platform " +
      "package is missing",
    exception: {
      net: true,
      env: ["SENTRYCLI_CDNURL", "SENTRYCLI_SKIP_DOWNLOAD", "SENTRYCLI_USE_LOCAL"],
    },
  },
  {
    name: "@tensorflow/tfjs-node",
    hosts: ["storage.googleapis.com:443", NODE_HEADERS],
    reason: "install script downloads the libtensorflow shared library",
    exception: { net: true },
    caveat: NODE_GYP,
  },
  {
    name: "argon2",
    declaredHosts: ["github.com"],
    reason: "before 0.28 " + GITHUB_DECLARED + "; from 0.28 the binaries ship in the package " +
      "and `node-gyp-build` loads them at run time",
    exception: {},
    caveat: NODE_GYP,
  },
  {
    name: "bcrypt",
    declaredHosts: ["github.com"],
    reason: "bcrypt 5 " + GITHUB_DECLARED,
    exception: {},
    caveat: "bcrypt 6 ships prebuilt binaries that `node-gyp-build` loads at run time, so leave " +
      "its install script unapproved. Approving it works where the OS confines lifecycle scripts " +
      "(macOS, Linux with Landlock) from runtime 3.0.0-denext.1, which lets the install check " +
      "load the package's own binary; elsewhere, and on older runtimes, the approved check fails. " +
      NODE_GYP,
  },
  {
    name: "better-sqlite3",
    hosts: [...GITHUB, NODE_HEADERS],
    reason: "`prebuild-install` fetches a prebuilt binding from GitHub releases, else " +
      "`node-gyp rebuild` fetches the Node.js headers",
    exception: { net: true },
    caveat: "On denext's Deno toolchain better-sqlite3 is served over the built-in SQLite, so " +
      "leaving its install script unapproved works too. " + NODE_GYP,
  },
  {
    name: "canvas",
    hosts: [...GITHUB, NODE_HEADERS],
    reason: "install fetches a prebuilt binding from GitHub (canvas 3 with `prebuild-install`, " +
      "canvas 2 with node-pre-gyp from its declared GitHub host), else builds it",
    exception: { net: true },
    caveat: NODE_GYP,
  },
  {
    name: "chromedriver",
    hosts: [
      "chromedriver.storage.googleapis.com:443",
      "googlechromelabs.github.io:443",
      "storage.googleapis.com:443",
    ],
    reason: "install.js downloads the chromedriver binary into its package",
    exception: {
      net: true,
      env: [
        "CHROMEDRIVER_CDNBINARIESURL",
        "CHROMEDRIVER_CDNURL",
        "CHROMEDRIVER_FILEPATH",
        "CHROMEDRIVER_SKIP_DOWNLOAD",
        "DETECT_CHROMEDRIVER_VERSION",
      ],
    },
  },
  {
    name: "cypress",
    hosts: ["cdn.cypress.io:443", "download.cypress.io:443"],
    cache: { env: "CYPRESS_CACHE_FOLDER", path: "~/.cache/Cypress" },
    reason: "postinstall downloads the Cypress app into ~/.cache/Cypress",
    exception: {
      net: true,
      env: ["CYPRESS_CACHE_FOLDER", "CYPRESS_DOWNLOAD_MIRROR", "CYPRESS_INSTALL_BINARY"],
    },
    caveat: HOME_CACHE,
  },
  {
    name: "electron",
    hosts: GITHUB,
    reason: "postinstall (install.js) downloads the Electron binary from GitHub and unpacks it " +
      "into its package",
    exception: {
      net: true,
      env: [
        "ELECTRON_CUSTOM_DIR",
        "ELECTRON_CUSTOM_FILENAME",
        "ELECTRON_GET_USE_PROXY",
        "ELECTRON_MIRROR",
        "ELECTRON_SKIP_BINARY_DOWNLOAD",
        "electron_config_cache",
      ],
    },
    caveat: "Its download cache lives in the scratch HOME, so each install downloads again.",
  },
  {
    name: "ffmpeg-static",
    hosts: GITHUB,
    reason: "install script downloads the ffmpeg binary into its package",
    exception: { net: true, env: ["FFMPEG_BINARIES_URL"] },
  },
  {
    name: "grpc",
    declaredHosts: ["node-precompiled-binaries.grpc.io"],
    reason: "install (`node-pre-gyp install`) downloads the prebuilt binding from the host its " +
      "package.json declares (`binary.host`), else builds it",
    exception: {},
    caveat: "Deprecated in favour of the pure-JavaScript `@grpc/grpc-js`, which has no install " +
      "script. " + NODE_GYP,
  },
  {
    name: "keytar",
    hosts: [...GITHUB, NODE_HEADERS],
    reason: "`prebuild-install` fetches a prebuilt binding from GitHub releases, else builds it",
    exception: { net: true },
    caveat: NODE_GYP,
  },
  {
    name: "lefthook",
    reason: "postinstall runs `lefthook install`, which writes the repository's .git/hooks",
    exception: {},
    writeTargets: ["git-hooks"],
    caveat: "A repository whose `.git` is a file (a worktree or submodule) or that sets " +
      "`core.hooksPath` keeps its hooks elsewhere: list that directory under `write` by hand.",
  },
  {
    name: "libxmljs",
    declaredHosts: ["github.com"],
    reason: GITHUB_DECLARED,
    exception: {},
    caveat: NODE_GYP,
  },
  {
    name: "msw",
    reason: "postinstall copies mockServiceWorker.js into the directories package.json's " +
      "`msw.workerDirectory` names",
    exception: {},
    writeTargets: ["msw-worker"],
  },
  {
    name: "node-pty",
    hosts: [NODE_HEADERS],
    reason: "install builds the native module with node-gyp when no prebuilt binary matches",
    exception: { net: true },
    caveat: NODE_GYP,
  },
  {
    name: "node-sass",
    hosts: [...GITHUB, NODE_HEADERS],
    reason: "install downloads the libsass binding from GitHub, else builds it",
    exception: { net: true, env: ["SASS_BINARY_NAME", "SASS_BINARY_PATH", "SASS_BINARY_SITE"] },
    caveat: NODE_GYP,
  },
  {
    name: "nodegit",
    declaredHosts: ["axonodegit.s3.amazonaws.com"],
    reason: "install downloads the prebuilt binding from the host its package.json declares " +
      "(`binary.host`), else builds it",
    exception: {},
    caveat: NODE_GYP,
  },
  ...PLAYWRIGHT_BROWSERS.map((browser): JailExceptionEntry => ({
    name: `playwright-${browser}`,
    hosts: PLAYWRIGHT_HOSTS,
    cache: { env: "PLAYWRIGHT_BROWSERS_PATH", path: "~/.cache/ms-playwright" },
    reason: `install script downloads ${browser} into the Playwright browser cache under the ` +
      "home directory",
    exception: {
      net: true,
      env: [
        "PLAYWRIGHT_BROWSERS_PATH",
        "PLAYWRIGHT_DOWNLOAD_HOST",
        "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
      ],
    },
    caveat: HOME_CACHE,
  })),
  {
    name: "puppeteer",
    hosts: ["storage.googleapis.com:443"],
    cache: { env: "PUPPETEER_CACHE_DIR", path: "~/.cache/puppeteer" },
    reason: "postinstall downloads Chrome for Testing into ~/.cache/puppeteer",
    exception: {
      net: true,
      env: ["PUPPETEER_CACHE_DIR", "PUPPETEER_DOWNLOAD_BASE_URL", "PUPPETEER_SKIP_DOWNLOAD"],
    },
    caveat: HOME_CACHE,
  },
  {
    name: "re2",
    hosts: [...GITHUB, NODE_HEADERS],
    reason: "install downloads a prebuilt binding from GitHub (`install-artifact-from-github`), " +
      "else builds it",
    exception: { net: true },
    caveat: NODE_GYP,
  },
  {
    name: "sharp",
    hosts: [...GITHUB, NODE_HEADERS],
    reason: "before 0.33 install downloads libvips and a prebuilt binding from GitHub; from 0.33 " +
      "the binaries are optional dependencies and the script reaches the network only to build " +
      "from source",
    exception: { net: true, env: ["SHARP_FORCE_GLOBAL_LIBVIPS", "SHARP_IGNORE_GLOBAL_LIBVIPS"] },
    caveat: NODE_GYP,
  },
  {
    name: "simple-git-hooks",
    reason: "postinstall writes the hooks configured in package.json into the repository's " +
      ".git/hooks",
    exception: {},
    writeTargets: ["git-hooks"],
    caveat: "A repository whose `.git` is a file (a worktree or submodule) or that sets " +
      "`core.hooksPath` keeps its hooks elsewhere: list that directory under `write` by hand.",
  },
  {
    name: "sqlite3",
    hosts: [...GITHUB, NODE_HEADERS],
    reason: "`prebuild-install` fetches a prebuilt binding from GitHub releases, else builds it",
    exception: { net: true },
    caveat: NODE_GYP,
  },
  {
    name: "wrtc",
    declaredHosts: ["node-webrtc.s3.amazonaws.com"],
    reason: "install downloads the prebuilt WebRTC binding from the host its package.json " +
      "declares (`binary.host`)",
    exception: {},
  },
];

/**
 * Well-known packages with install scripts that need NO exception, and why: listed so the docs
 * can say so, and so the test keeps them out of {@linkcode JAIL_SCRIPT_EXCEPTIONS}.
 */
export const JAIL_NOT_NEEDED: readonly { readonly name: string; readonly why: string }[] = [
  {
    name: "esbuild",
    why: "its binary is an optional dependency; the install script only checks it",
  },
  {
    name: "playwright",
    why: "no install script: browsers come from `playwright install`, run as your own command",
  },
  {
    name: "husky",
    why: "husky 9 is set up by the project's own `prepare` script, which is not jailed",
  },
  {
    name: "bufferutil",
    why: "`node-gyp-build` loads a bundled prebuilt binary at run time, so leave its install " +
      "script unapproved. Approving it works where the OS confines lifecycle scripts (macOS, " +
      "Linux with Landlock) from runtime 3.0.0-denext.1; elsewhere, and on older runtimes, the " +
      "approved install check can't load the binary and fails",
  },
];
