// The files `denext mobile add fastlane` writes into a Capacitor project: fastlane's Appfile,
// Fastfile and Matchfile, a Gemfile pinning fastlane (for `bundle exec` and plugins; the lanes run
// with `denext fastlane`, denext's managed fastlane), fastlane/.gitignore for what a run
// generates, and (with `--ci`) a GitHub Actions workflow. Build-time only; never imported by a
// shipped bundle.
//
// Interop, not a second pipeline: every lane builds with `denext mobile build <platform>
// --release` (export → flavor edits → cap sync → Xcode / Gradle) and reads the artifact record
// it prints, so the binary, its app id (a flavor's included), version and build number are
// denext's. fastlane adds what teams already use it for: match signing, TestFlight and the Play
// tracks, store metadata, its plugins. No credential is ever written into these files: they
// name environment variables. The texts ship packed (native-templates/fastlane.ts is their
// readable source); the GitHub Actions workflow is composed here.

import { fastlanePinHash } from "./fastlane-toolchain.ts";
import { NATIVE_TEMPLATES } from "./native-templates.packed.ts";
import { fillTemplate } from "./packed-text.ts";

/**
 * The texts of the files below. Their readable source is native-templates/fastlane.ts (not
 * published), packed into the docs-corpus pack by `deno task gen:native-templates`.
 */
const TEMPLATES = NATIVE_TEMPLATES.fastlane.FASTLANE_TEMPLATES;

/** The fastlane release the Gemfile pins (`~>`: any 2.x from this one on). */
export const FASTLANE_VERSION = "2.240";

/** Where each file lands, relative to the Capacitor project. */
export const FASTLANE_FILES = {
  appfile: "fastlane/Appfile",
  fastfile: "fastlane/Fastfile",
  matchfile: "fastlane/Matchfile",
  gitignore: "fastlane/.gitignore",
  gemfile: "Gemfile",
} as const;

/** The workflow `--ci` writes, relative to the repository root. */
export const FASTLANE_WORKFLOW = ".github/workflows/mobile-release.yml";

/**
 * A Ruby double-quoted string literal for `value`: escapes `\`, `"` and every `#` that would start
 * an interpolation (`#{expr}`, and the short forms `#@ivar`, `#@@cvar`, `#$global`).
 */
export function rubyString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/#(?=[{@$])/g, "\\#")}"`;
}

/**
 * The Appfile: the base app's identifiers (capacitor.config `appId`) and where the Apple team
 * and the Play key come from (the environment).
 *
 * @param appId The bundle id / package name.
 */
export function appfileTemplate(appId: string): string {
  return fillTemplate(TEMPLATES.Appfile, { id: rubyString(appId) });
}

/**
 * The Matchfile: match's store (from the environment) and the App Store certificate type for
 * the base app id. Flavor builds pass their own id to match from the lane.
 *
 * @param appId The bundle id.
 */
export function matchfileTemplate(appId: string): string {
  return fillTemplate(TEMPLATES.Matchfile, { id: rubyString(appId) });
}

/** The Gemfile: fastlane pinned, and fastlane's Pluginfile (written by `fastlane add_plugin`). */
export function gemfileTemplate(): string {
  return fillTemplate(TEMPLATES.Gemfile, { version: FASTLANE_VERSION });
}

/** fastlane/.gitignore: what a fastlane run generates (and key files that must stay local). */
export function gitignoreTemplate(): string {
  return TEMPLATES[".gitignore"];
}

/** The Fastfile: helpers over `denext mobile build`, and the ios / android lanes. */
export function fastfileTemplate(): string {
  return TEMPLATES.Fastfile;
}

/** The package-manager install step the workflow runs before the build. */
export type WorkflowInstall = "npm" | "pnpm" | "yarn" | "bun";

/** Options for {@linkcode workflowTemplate}. */
export interface WorkflowOptions {
  /** The Capacitor project relative to the repository root (`.` when it is the root). */
  readonly workingDirectory: string;
  /** The package manager the project's lockfile names. */
  readonly install: WorkflowInstall;
  /** Whether a lockfile exists (npm: `npm ci` needs one). */
  readonly locked: boolean;
  /** The denext CLI the jobs run (`$DENEXT_CLI`). */
  readonly cli: string;
}

/**
 * The actions the workflow uses, each pinned to a full commit SHA with its release tag in a
 * comment (a tag can be moved to other code; a SHA cannot), as denext's own workflows pin them.
 * https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions
 */
export const WORKFLOW_ACTIONS = {
  checkout: "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0",
  setupDeno: "denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed # v2.0.5",
  setupNode: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0",
  setupJava: "actions/setup-java@cf277c60eb25467037889841efdb72551f06f6c3 # v4.9.1",
  cache: "actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0",
  pnpm: "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0",
  bun: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0",
} as const;

/** The setup step (if any) and the install command for a package manager. */
function installSteps(install: WorkflowInstall, locked: boolean): string {
  const step = (name: string, run: string) => `      - name: ${name}\n        run: ${run}\n`;
  switch (install) {
    case "pnpm":
      return `      - uses: ${WORKFLOW_ACTIONS.pnpm}\n` +
        step("Install the Capacitor packages", "pnpm install --frozen-lockfile");
    case "bun":
      return `      - uses: ${WORKFLOW_ACTIONS.bun}\n` +
        step("Install the Capacitor packages", "bun install --frozen-lockfile");
    case "yarn":
      return step("Install the Capacitor packages", "yarn install --frozen-lockfile");
    default:
      return step(
        "Install the Capacitor packages",
        locked ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund",
      );
  }
}

/**
 * A path as a YAML double-quoted scalar (a JSON string is one), so `#`, `: `, a leading `*` / `&`
 * or quotes in a directory name stay text. GitHub evaluates `${{ … }}` inside any string, so a
 * path containing it is refused rather than quoted.
 */
function yamlPath(path: string): string {
  if (path.includes("${{") || /[\r\n]/.test(path)) {
    throw new Error(`the project path ${JSON.stringify(path)} cannot be written into a workflow`);
  }
  return JSON.stringify(path);
}

/**
 * The `actions/cache` step for denext's managed fastlane (the portable Ruby + the built gems) under
 * the runner's Deno cache (`denoDir`: Linux and macOS defaults), keyed on the fastlane pin this
 * workflow is written for, so a run after the first skips the install (minutes of C builds). A
 * newer denext with another pin re-installs (the stamp no longer matches) until this file is
 * regenerated with the new key.
 */
function fastlaneCacheStep(denoDir: string): string {
  return "      # denext's managed fastlane (Ruby + gems), keyed on the pin it was written for.\n" +
    `      - uses: ${WORKFLOW_ACTIONS.cache}\n` +
    "        with:\n" +
    `          path: ${denoDir}/denext-deno/fastlane\n` +
    "          key: denext-fastlane-${{ runner.os }}-${{ runner.arch }}-" +
    `${fastlanePinHash()}\n`;
}

/**
 * The GitHub Actions workflow: a manual dispatch that runs `denext fastlane <platform> <lane>`
 * (denext's managed fastlane) for Android on Ubuntu and iOS on macOS, with every credential a repository secret.
 *
 * @param opts Where the project is and how its packages install.
 */
export function workflowTemplate(opts: WorkflowOptions): string {
  const wd = yamlPath(opts.workingDirectory);
  const setup = (java: boolean) =>
    `      - uses: ${WORKFLOW_ACTIONS.checkout}\n` +
    `      - uses: ${WORKFLOW_ACTIONS.setupDeno}\n` +
    "        with:\n" +
    '          deno-version: "v2.x"\n' +
    `      - uses: ${WORKFLOW_ACTIONS.setupNode}\n` +
    "        with:\n" +
    '          node-version: "22"\n' +
    (java
      ? `      - uses: ${WORKFLOW_ACTIONS.setupJava}\n` +
        "        with:\n" +
        "          distribution: temurin\n" +
        '          java-version: "21"\n'
      : "") +
    installSteps(opts.install, opts.locked) +
    fastlaneCacheStep(java ? "~/.cache/deno" : "~/Library/Caches/deno");
  return `# Written by \`denext mobile add fastlane --ci\`: denext builds, fastlane ships.
#   Actions → "Mobile release" → Run workflow: the lane (beta: TestFlight / a Play testing
#   track; release: the App Store / Play production), a flavor (optional) and the platforms.
#
# Repository secrets (Settings → Secrets and variables → Actions); nothing secret is committed:
#   iOS      MATCH_GIT_URL, MATCH_PASSWORD, MATCH_GIT_BASIC_AUTHORIZATION (base64 "user:token"),
#            APP_STORE_CONNECT_API_KEY_KEY_ID, APP_STORE_CONNECT_API_KEY_ISSUER_ID,
#            APP_STORE_CONNECT_API_KEY_KEY (the .p8 file's contents), APPLE_TEAM_ID
#   Android  SUPPLY_JSON_KEY_DATA (the Play service-account JSON), ANDROID_KEYSTORE_BASE64
#            (base64 of the upload keystore), ANDROID_KEY_ALIAS, ANDROID_KEYSTORE_PASSWORD,
#            ANDROID_KEY_PASSWORD
name: Mobile release

on:
  workflow_dispatch:
    inputs:
      lane:
        description: "beta (TestFlight / Play internal) or release (App Store / Play production)"
        type: choice
        options: [beta, release]
        default: beta
      flavor:
        description: "A flavor from denext.config mobile.flavors (empty: the base app)"
        type: string
        default: ""
      platforms:
        description: "Which stores"
        type: choice
        options: [both, ios, android]
        default: both

permissions:
  contents: read

concurrency:
  group: mobile-release-\${{ github.ref }}
  cancel-in-progress: false

env:
  # The denext CLI that runs fastlane and that the lanes run (pin it to the version the app uses).
  # Its \`fastlane\` verb installs denext's pinned fastlane on the runner (a few minutes: the gems
  # build C extensions).
  DENEXT_CLI: ${opts.cli}
  FASTLANE_SKIP_UPDATE_CHECK: "1"
  FASTLANE_HIDE_CHANGELOG: "1"
  LANE: \${{ inputs.lane }}
  FLAVOR: \${{ inputs.flavor }}

jobs:
  android:
    if: inputs.platforms != 'ios'
    runs-on: ubuntu-latest
    timeout-minutes: 60
    defaults:
      run:
        working-directory: ${wd}
    steps:
${setup(true)}      - name: Upload keystore
        run: (umask 077 && echo "$ANDROID_KEYSTORE_BASE64" | base64 --decode > "$RUNNER_TEMP/upload.jks")
        env:
          ANDROID_KEYSTORE_BASE64: \${{ secrets.ANDROID_KEYSTORE_BASE64 }}
      - name: fastlane android
        run: $DENEXT_CLI fastlane android "$LANE" \${FLAVOR:+"flavor:$FLAVOR"}
        env:
          SUPPLY_JSON_KEY_DATA: \${{ secrets.SUPPLY_JSON_KEY_DATA }}
          DENEXT_ANDROID_KEYSTORE: \${{ runner.temp }}/upload.jks
          DENEXT_ANDROID_KEY_ALIAS: \${{ secrets.ANDROID_KEY_ALIAS }}
          DENEXT_ANDROID_KEYSTORE_PASSWORD: \${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          DENEXT_ANDROID_KEY_PASSWORD: \${{ secrets.ANDROID_KEY_PASSWORD }}
      # The decoded keystore never outlives the job, even when a step failed.
      - name: Remove the upload keystore
        if: always()
        run: rm -f "$RUNNER_TEMP/upload.jks"

  ios:
    if: inputs.platforms != 'android'
    runs-on: macos-15
    timeout-minutes: 90
    defaults:
      run:
        working-directory: ${wd}
    steps:
${setup(false)}      - name: fastlane ios
        run: $DENEXT_CLI fastlane ios "$LANE" \${FLAVOR:+"flavor:$FLAVOR"}
        env:
          MATCH_GIT_URL: \${{ secrets.MATCH_GIT_URL }}
          MATCH_PASSWORD: \${{ secrets.MATCH_PASSWORD }}
          MATCH_GIT_BASIC_AUTHORIZATION: \${{ secrets.MATCH_GIT_BASIC_AUTHORIZATION }}
          APP_STORE_CONNECT_API_KEY_KEY_ID: \${{ secrets.APP_STORE_CONNECT_API_KEY_KEY_ID }}
          APP_STORE_CONNECT_API_KEY_ISSUER_ID: \${{ secrets.APP_STORE_CONNECT_API_KEY_ISSUER_ID }}
          APP_STORE_CONNECT_API_KEY_KEY: \${{ secrets.APP_STORE_CONNECT_API_KEY_KEY }}
          DENEXT_IOS_TEAM: \${{ secrets.APPLE_TEAM_ID }}
`;
}
