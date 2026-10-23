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
// (relative to that deno.json) and the network. There is no per-host network list in the config
// (the jail allows a node-pre-gyp `binary.host` a package declares by itself, so such packages
// are not listed here) and no per-package opt-out, so each entry below is the narrowest of those
// three that lets the script do its job. `denext migrate` / `create` / `add` write the entries for
// the dependencies they find, and `denext doctor` flags a missing one; nothing here ever turns the
// jail off. Data only: src/build/jail-scripts.ts reads it.

/** One package's exception, in the shape of deno.json's `supplyChain.jailScripts.packages.<name>`. */
export interface JailPackageException {
  /** Environment variables passed through to the package's scripts. */
  readonly env?: readonly string[];
  /** Extra directories the package's scripts may write to, relative to the deno.json. */
  readonly write?: readonly string[];
  /** The network for the package's scripts. */
  readonly net?: boolean;
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
  /** The exception, before {@linkcode writeTargets} are resolved. */
  readonly exception: JailPackageException;
  /**
   * Project directories added to `write` when they are found. An entry with nothing else that
   * finds none needs no exception (msw without a `workerDirectory` copies nothing).
   */
  readonly writeTargets?: readonly JailWriteTarget[];
  /** What the exception cannot fix, and what to do about it. */
  readonly caveat?: string;
}

/** The scratch-HOME caveat of the packages that download into a cache under the user's home. */
const HOME_CACHE =
  "The jail's HOME is a scratch directory removed after the script, so a download into the " +
  "default cache under your home is lost: point the cache variable at a directory in the " +
  "project and list it under `write`, or skip the download here and install the binary after " +
  "the install.";

/** The caveat of the packages that build from source with node-gyp when no prebuilt binary fits. */
const NODE_GYP = "A build from source with node-gyp also downloads the Node.js headers (set " +
  "`npm_config_nodedir` to local headers to avoid it) and needs Python, make and a C++ compiler.";

/** The Playwright browser packages that download their browser at install. */
const PLAYWRIGHT_BROWSERS = ["chromium", "firefox", "webkit"] as const;

/**
 * The built-in exception list, sorted by package name. Reviewed against each package's install
 * script; `tests/jail-scripts.test.ts` checks its shape.
 */
export const JAIL_SCRIPT_EXCEPTIONS: readonly JailExceptionEntry[] = [
  {
    name: "@prisma/client",
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
    caveat: "The project's `.env` is unreadable inside the jail; `prisma generate` does not " +
      "need it, but a schema whose generator block reads `env(...)` does.",
  },
  {
    name: "@prisma/engines",
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
    reason: "install.js downloads the sentry-cli binary into its package when the platform " +
      "package is missing",
    exception: {
      net: true,
      env: ["SENTRYCLI_CDNURL", "SENTRYCLI_SKIP_DOWNLOAD", "SENTRYCLI_USE_LOCAL"],
    },
  },
  {
    name: "@tensorflow/tfjs-node",
    reason: "install script downloads the libtensorflow shared library",
    exception: { net: true },
    caveat: NODE_GYP,
  },
  {
    name: "better-sqlite3",
    reason: "`prebuild-install` fetches a prebuilt binding from GitHub releases, else " +
      "`node-gyp rebuild` fetches the Node.js headers",
    exception: { net: true },
    caveat: "On denext's Deno toolchain better-sqlite3 is served over the built-in SQLite, so " +
      "leaving its install script unapproved works too. " + NODE_GYP,
  },
  {
    name: "canvas",
    reason: "install fetches a prebuilt binding with `prebuild-install` from GitHub (canvas 3; " +
      "canvas 2's declared node-pre-gyp host is allowed by the jail by itself), else builds it",
    exception: { net: true },
    caveat: NODE_GYP,
  },
  {
    name: "chromedriver",
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
    reason: "postinstall downloads the Cypress app into ~/.cache/Cypress",
    exception: {
      net: true,
      env: ["CYPRESS_CACHE_FOLDER", "CYPRESS_DOWNLOAD_MIRROR", "CYPRESS_INSTALL_BINARY"],
    },
    caveat: HOME_CACHE,
  },
  {
    name: "electron",
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
    reason: "install script downloads the ffmpeg binary into its package",
    exception: { net: true, env: ["FFMPEG_BINARIES_URL"] },
  },
  {
    name: "keytar",
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
    name: "msw",
    reason: "postinstall copies mockServiceWorker.js into the directories package.json's " +
      "`msw.workerDirectory` names",
    exception: {},
    writeTargets: ["msw-worker"],
  },
  {
    name: "node-pty",
    reason: "install builds the native module with node-gyp when no prebuilt binary matches",
    exception: { net: true },
    caveat: NODE_GYP,
  },
  {
    name: "node-sass",
    reason: "install downloads the libsass binding from GitHub, else builds it",
    exception: { net: true, env: ["SASS_BINARY_NAME", "SASS_BINARY_PATH", "SASS_BINARY_SITE"] },
    caveat: NODE_GYP,
  },
  ...PLAYWRIGHT_BROWSERS.map((browser): JailExceptionEntry => ({
    name: `playwright-${browser}`,
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
    reason: "postinstall downloads Chrome for Testing into ~/.cache/puppeteer",
    exception: {
      net: true,
      env: ["PUPPETEER_CACHE_DIR", "PUPPETEER_DOWNLOAD_BASE_URL", "PUPPETEER_SKIP_DOWNLOAD"],
    },
    caveat: HOME_CACHE,
  },
  {
    name: "re2",
    reason: "install downloads a prebuilt binding from GitHub (`install-artifact-from-github`), " +
      "else builds it",
    exception: { net: true },
    caveat: NODE_GYP,
  },
  {
    name: "sharp",
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
    reason: "`prebuild-install` fetches a prebuilt binding from GitHub releases, else builds it",
    exception: { net: true },
    caveat: NODE_GYP,
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
    name: "bcrypt",
    why: "bcrypt 6 ships prebuilt binaries; bcrypt 5's node-pre-gyp host is declared, which the " +
      "jail allows by itself",
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
    why: "`node-gyp-build` loads a bundled prebuilt binary",
  },
];
