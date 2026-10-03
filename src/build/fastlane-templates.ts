// The files `denext mobile add fastlane` writes into a Capacitor project: fastlane's Appfile,
// Fastfile and Matchfile, a Gemfile pinning fastlane, fastlane/.gitignore for what a run
// generates, and (with `--ci`) a GitHub Actions workflow. Build-time only; never imported by a
// shipped bundle.
//
// Interop, not a second pipeline: every lane builds with `denext mobile build <platform>
// --release` (export → flavor edits → cap sync → Xcode / Gradle) and reads the artifact record
// it prints, so the binary, its app id (a flavor's included), version and build number are
// denext's. fastlane adds what teams already use it for: match signing, TestFlight and the Play
// tracks, store metadata, its plugins. No credential is ever written into these files: they
// name environment variables.

/** The fastlane release the Gemfile pins (`~>`: any 2.x from this one on). */
export const FASTLANE_VERSION = "2.240";

/** The Ruby the generated workflow installs. */
const FASTLANE_RUBY = "3.3";

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
  const id = rubyString(appId);
  return `# Written by \`denext mobile add fastlane\`: who the app is. Identifiers only: every
# credential comes from the environment (a CI secret, or your shell), never from this file.

# The base app's bundle id / package name (capacitor.config appId; \`denext mobile doctor
# --release\` reports a mismatch). A flavor build carries its own id (denext.config
# mobile.flavors), which the lanes read from the build itself.
app_identifier(${id})
package_name(${id})

# An environment variable, nil when unset or empty (an unset CI secret is an empty string).
env = ->(name) { ENV[name].to_s.empty? ? nil : ENV[name] }

# Apple: the Developer Portal team and, when it differs, the App Store Connect team.
apple_team = env.call("DENEXT_IOS_TEAM") || env.call("APPLE_TEAM_ID")
team_id(apple_team) if apple_team
itc_team_id(env.call("FASTLANE_ITC_TEAM_ID")) if env.call("FASTLANE_ITC_TEAM_ID")
apple_id(env.call("FASTLANE_APPLE_ID")) if env.call("FASTLANE_APPLE_ID")

# Google Play: the service-account key file. In CI set SUPPLY_JSON_KEY_DATA (the key's
# contents) instead, which supply reads itself.
play_key = env.call("SUPPLY_JSON_KEY") || env.call("DENEXT_PLAY_SERVICE_ACCOUNT")
json_key_file(play_key) if play_key && !env.call("SUPPLY_JSON_KEY_DATA")
`;
}

/**
 * The Matchfile: match's store (from the environment) and the App Store certificate type for
 * the base app id. Flavor builds pass their own id to match from the lane.
 *
 * @param appId The bundle id.
 */
export function matchfileTemplate(appId: string): string {
  return `# Written by \`denext mobile add fastlane\`. match keeps the team's distribution certificate
# (and an App Store profile per app id) in one encrypted store that every machine and CI share.
#
# Create it once, from a Mac with access to the Apple account:
#   MATCH_GIT_URL=… bundle exec fastlane match appstore
# The iOS lanes then run match read-only before each build whenever MATCH_GIT_URL (or
# MATCH_STORAGE_MODE) is set, so the build signs with that certificate instead of minting a new
# one. The passphrase is MATCH_PASSWORD; a private git store over HTTPS takes
# MATCH_GIT_BASIC_AUTHORIZATION (base64 of "user:token"). None of them belongs in this file.

git_url(ENV["MATCH_GIT_URL"]) unless ENV["MATCH_GIT_URL"].to_s.empty?
storage_mode(ENV["MATCH_STORAGE_MODE"].to_s.empty? ? "git" : ENV["MATCH_STORAGE_MODE"])
type("appstore")
app_identifier([${rubyString(appId)}])
`;
}

/** The Gemfile: fastlane pinned, and fastlane's Pluginfile (written by `fastlane add_plugin`). */
export function gemfileTemplate(): string {
  return `# Written by \`denext mobile add fastlane\`. Run fastlane through bundler so every machine and CI
# use the same version: \`bundle install\` (commit Gemfile.lock), then \`bundle exec fastlane …\`.
source "https://rubygems.org"

gem "fastlane", "~> ${FASTLANE_VERSION}"

# \`bundle exec fastlane add_plugin <name>\` records plugins in fastlane/Pluginfile.
plugins_path = File.join(File.dirname(__FILE__), "fastlane", "Pluginfile")
eval_gemfile(plugins_path) if File.exist?(plugins_path)
`;
}

/** fastlane/.gitignore: what a fastlane run generates (and key files that must stay local). */
export function gitignoreTemplate(): string {
  return `# Written by \`denext mobile add fastlane\`: what fastlane generates on every run.
report.xml
README.md
Preview.html
test_output/
screenshots/**/*.png
# Credentials belong in the environment (CI secrets); never commit a key file.
*.p8
*.p12
*.cer
*.mobileprovision
*.jks
*.keystore
# Play Console service-account keys (supply's json_key_file) are JSON; nothing fastlane needs
# committed here is.
*.json
.env
.env.*
`;
}

/** The Fastfile: helpers over `denext mobile build`, and the ios / android lanes. */
export function fastfileTemplate(): string {
  return FASTFILE;
}

const FASTFILE =
  `# Written by \`denext mobile add fastlane\`: fastlane lanes over denext's own build pipeline.
#
#   bundle exec fastlane ios build|beta|release     [flavor:staging] [build_number:42] …
#   bundle exec fastlane android build|beta|release [flavor:staging] [track:internal] …
#
# Every lane builds with \`denext mobile build <platform> --release\`, which runs \`denext export\`,
# the flavor's edits and \`npx cap sync\` before Xcode / Gradle, so the binary always carries the
# current web UI, and reads the artifact record it prints (path, app id, version, build number).
# Signing inputs, versions and flavors are denext's (https://denext.dev/docs/mobile-build);
# fastlane adds match, TestFlight, the Play tracks, store metadata and its plugins.
# Credentials come from the environment only.
#
# Options the lanes take (fastlane's key:value arguments):
#   flavor:<name>           a flavor from denext.config mobile.flavors (its own app id and name)
#   build_number:<n>        this build's build number (the sources are left as they are)
#   version_name:<x.y.z>    this build's version (the sources are left as they are)
#   bump:true               increment the build number in the native sources first (commit it)
#   store_build_number:false
#                           beta / release use the store's latest build number + 1 (or the
#                           sources' when higher) unless build_number or bump is given; false
#                           keeps the sources' number
#   skip_export:true        the web export is already there
#   app:<dir>               the denext app, when it is not the Capacitor project ($DENEXT_APP_DIR)
#   ios:      match:false (skip match), export_options:<plist>, changelog:<text>, wait:true
#             (wait for TestFlight processing), metadata:true / screenshots:true /
#             submit:true / automatic_release:true (release)
#   android:  track:<name>, draft:true, rollout:<0..1>, apk:true, metadata:true (release)
#
# The denext CLI: $DENEXT_CLI (e.g. "deno run -A jsr:@denext/denext/cli"), else \`denext\` on PATH.

require "base64"
require "fileutils"
require "json"
require "shellwords"
require "tmpdir"

# The Capacitor project: the folder that holds this fastlane/ folder.
def denext_root
  File.expand_path("..", __dir__)
end

def truthy(value)
  value == true || %w[true yes 1].include?(value.to_s.downcase)
end

# An environment variable, nil when unset or empty (an unset CI secret is an empty string).
def env_value(name)
  value = ENV[name].to_s
  value.empty? ? nil : value
end

# The denext CLI as argv.
def denext_cli
  cli = env_value("DENEXT_CLI").to_s.strip
  Shellwords.split(cli.empty? ? "denext" : cli)
end

# Run \`denext <args>\` with \`env\` added for this call only; returns its output.
def denext(args, env = {})
  saved = env.keys.to_h { |key| [key, ENV[key]] }
  env.each { |key, value| ENV[key] = value }
  sh(*denext_cli, *args, log: true)
ensure
  (saved || {}).each { |key, value| value.nil? ? ENV.delete(key) : ENV[key] = value }
end

# The last JSON object \`denext … --json\` printed (the build's own output comes before it).
def denext_json(output)
  line = output.to_s.lines.reverse.find { |l| l.strip.start_with?("{") }
  UI.user_error!("denext printed no JSON result") unless line
  JSON.parse(line)
end

# \`denext mobile build <platform> --release\`'s arguments for the lane options.
def denext_build_args(platform, options, dry_run: false)
  args = ["mobile", "build", platform.to_s, "--release", "--dir", denext_root, "--json"]
  args << "--dry-run" if dry_run
  app = options[:app] || env_value("DENEXT_APP_DIR")
  args += ["--app", File.expand_path(app.to_s, denext_root)] unless app.to_s.empty?
  args += ["--flavor", options[:flavor].to_s] if options[:flavor]
  args += ["--build-number", options[:build_number].to_s] if options[:build_number]
  args += ["--version-name", options[:version_name].to_s] if options[:version_name]
  args << "--bump" if truthy(options[:bump]) && !dry_run
  args << "--skip-export" if truthy(options[:skip_export])
  args << "--apk" if platform.to_s == "android" && truthy(options[:apk])
  if platform.to_s == "ios" && options[:export_options]
    args += ["--export-options", File.expand_path(options[:export_options].to_s, denext_root)]
  end
  args
end

# The build plan (app id, version, the sources' build number), without building anything.
def denext_plan(platform, options)
  denext_json(denext(denext_build_args(platform, options, dry_run: true)))
end

# Whether a store lane should take its build number from the store.
def store_build_number?(options)
  !options[:build_number] && !truthy(options[:bump]) &&
    options[:store_build_number].to_s != "false"
end

# Build with denext; \`next_build\` (a block given the plan) picks a store build number.
def denext_build(platform, options, env = {})
  options = options.dup
  if block_given? && store_build_number?(options)
    plan = denext_plan(platform, options)
    number = [yield(plan), plan["buildNumber"].to_i].max
    # Only when it differs: the sources already carry their own number.
    options[:build_number] = number unless number == plan["buildNumber"].to_i
  end
  artifact = denext_json(denext(denext_build_args(platform, options), env))
  UI.success("denext built #{artifact["path"]} (#{artifact["appId"]} #{artifact["version"]} (#{artifact["buildNumber"]}))")
  artifact
end

# fastlane's App Store Connect API key from the environment (nil without one: an Apple ID login).
def asc_api_key
  return @asc_api_key if defined?(@asc_api_key)
  id = env_value("APP_STORE_CONNECT_API_KEY_KEY_ID") || env_value("DENEXT_ASC_KEY_ID")
  issuer = env_value("APP_STORE_CONNECT_API_KEY_ISSUER_ID") || env_value("DENEXT_ASC_ISSUER_ID")
  path = env_value("APP_STORE_CONNECT_API_KEY_KEY_FILEPATH") || env_value("DENEXT_ASC_KEY_PATH")
  content = env_value("APP_STORE_CONNECT_API_KEY_KEY")
  @asc_api_key = if id && issuer && path
    app_store_connect_api_key(key_id: id, issuer_id: issuer, key_filepath: path)
  elsif id && issuer && content
    app_store_connect_api_key(
      key_id: id,
      issuer_id: issuer,
      key_content: content,
      is_key_content_base64: truthy(ENV["APP_STORE_CONNECT_API_KEY_IS_KEY_CONTENT_BASE64"])
    )
  end
end

# What \`denext mobile build ios\` signs with: the team and the API key as a file (xcodebuild's
# -authenticationKeyPath), written to a private temporary file when only its contents are set.
def denext_ios_env
  env = {}
  team = env_value("DENEXT_IOS_TEAM") || env_value("FASTLANE_TEAM_ID") ||
         CredentialsManager::AppfileConfig.try_fetch_value(:team_id)
  env["DENEXT_IOS_TEAM"] = team.to_s if team
  id = env_value("DENEXT_ASC_KEY_ID") || env_value("APP_STORE_CONNECT_API_KEY_KEY_ID")
  issuer = env_value("DENEXT_ASC_ISSUER_ID") || env_value("APP_STORE_CONNECT_API_KEY_ISSUER_ID")
  path = env_value("DENEXT_ASC_KEY_PATH") || env_value("APP_STORE_CONNECT_API_KEY_KEY_FILEPATH")
  content = env_value("APP_STORE_CONNECT_API_KEY_KEY")
  if path.nil? && content && id
    dir = Dir.mktmpdir("denext-asc-")
    at_exit { FileUtils.remove_entry(dir, true) }
    path = File.join(dir, "AuthKey_#{id}.p8")
    content = Base64.decode64(content) if truthy(ENV["APP_STORE_CONNECT_API_KEY_IS_KEY_CONTENT_BASE64"])
    File.write(path, content, perm: 0o600)
  end
  env["DENEXT_ASC_KEY_PATH"] = path if path
  env["DENEXT_ASC_KEY_ID"] = id if id
  env["DENEXT_ASC_ISSUER_ID"] = issuer if issuer
  env
end

# match, read-only, for the app id the build carries (when a match store is configured).
def denext_match(app_id, options)
  return if options[:match].to_s == "false"
  return unless env_value("MATCH_GIT_URL") || env_value("MATCH_STORAGE_MODE") || truthy(options[:match])
  match(
    {
      type: "appstore",
      app_identifier: [app_id],
      readonly: true,
      api_key: asc_api_key
    }.compact
  )
end

def denext_ios_build(options, store: false)
  setup_ci if env_value("CI")
  denext_match(denext_plan(:ios, options)["appId"], options)
  next_build = lambda do |plan|
    unless asc_api_key || env_value("FASTLANE_USER")
      UI.important("No App Store Connect API key: keeping the sources' build number")
      next 0
    end
    latest_testflight_build_number(
      { app_identifier: plan["appId"], api_key: asc_api_key, initial_build_number: 0 }.compact
    ).to_i + 1
  end
  artifact = if store
    denext_build(:ios, options, denext_ios_env) { |plan| next_build.call(plan) }
  else
    denext_build(:ios, options, denext_ios_env)
  end
  lane_context[SharedValues::IPA_OUTPUT_PATH] = artifact["path"]
  artifact
end

def denext_android_build(options, store: false)
  next_build = lambda do |plan|
    unless env_value("SUPPLY_JSON_KEY_DATA") || env_value("SUPPLY_JSON_KEY") ||
           CredentialsManager::AppfileConfig.try_fetch_value(:json_key_file)
      UI.important("No Play service-account key: keeping the sources' build number")
      next 0
    end
    codes = %w[internal alpha beta production].flat_map do |track|
      google_play_track_version_codes(package_name: plan["appId"], track: track)
    rescue StandardError
      []
    end
    (codes.map(&:to_i).max || 0) + 1
  end
  artifact = if store
    denext_build(:android, options) { |plan| next_build.call(plan) }
  else
    denext_build(:android, options)
  end
  key = artifact["path"].end_with?(".apk") ? SharedValues::GRADLE_APK_OUTPUT_PATH : SharedValues::GRADLE_AAB_OUTPUT_PATH
  lane_context[key] = artifact["path"]
  artifact
end

# upload_to_play_store's parameters for a denext artifact.
def play_upload(artifact, options, track)
  metadata = truthy(options[:metadata])
  params = {
    package_name: artifact["appId"],
    track: track,
    release_status: truthy(options[:draft]) ? "draft" : (options[:rollout] ? "inProgress" : "completed"),
    rollout: options[:rollout]&.to_s,
    skip_upload_metadata: !metadata,
    skip_upload_changelogs: !metadata,
    skip_upload_images: !metadata,
    skip_upload_screenshots: !metadata
  }
  params[artifact["path"].end_with?(".apk") ? :apk : :aab] = artifact["path"]
  params.compact
end

platform :ios do
  desc "Signed App Store .ipa with \`denext mobile build ios --release\` (match first when configured)"
  lane :build do |options|
    denext_ios_build(options)
  end

  desc "Build, then upload to TestFlight"
  lane :beta do |options|
    artifact = denext_ios_build(options, store: true)
    upload_to_testflight(
      {
        ipa: artifact["path"],
        app_identifier: artifact["appId"],
        api_key: asc_api_key,
        changelog: options[:changelog],
        skip_waiting_for_build_processing: !truthy(options[:wait])
      }.compact
    )
  end

  desc "Build, then upload to the App Store (metadata:true screenshots:true submit:true)"
  lane :release do |options|
    artifact = denext_ios_build(options, store: true)
    upload_to_app_store(
      {
        ipa: artifact["path"],
        app_identifier: artifact["appId"],
        api_key: asc_api_key,
        skip_metadata: !truthy(options[:metadata]),
        skip_screenshots: !truthy(options[:screenshots]),
        submit_for_review: truthy(options[:submit]),
        automatic_release: truthy(options[:automatic_release]),
        precheck_include_in_app_purchases: false,
        force: true
      }.compact
    )
  end
end

platform :android do
  desc "Signed .aab (apk:true for an .apk) with \`denext mobile build android --release\`"
  lane :build do |options|
    denext_android_build(options)
  end

  desc "Build, then upload to a Play testing track (track:internal by default)"
  lane :beta do |options|
    artifact = denext_android_build(options, store: true)
    upload_to_play_store(play_upload(artifact, options, (options[:track] || "internal").to_s))
  end

  desc "Build, then upload to Play production (rollout:0.1 for a staged rollout, metadata:true)"
  lane :release do |options|
    artifact = denext_android_build(options, store: true)
    upload_to_play_store(play_upload(artifact, options, (options[:track] || "production").to_s))
  end
end

# Your own lanes and helpers: fastlane/Lanes*.rb, imported here. Keeping them out of this file
# lets \`denext mobile add fastlane\` keep upgrading it (an edited Fastfile is left alone).
Dir[File.join(__dir__, "Lanes*.rb")].sort.each { |file| import(file) }
`;

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

/** The setup step (if any) and the install command for a package manager. */
function installSteps(install: WorkflowInstall, locked: boolean): string {
  const step = (name: string, run: string) => `      - name: ${name}\n        run: ${run}\n`;
  switch (install) {
    case "pnpm":
      return "      - uses: pnpm/action-setup@v4\n" +
        step("Install the Capacitor packages", "pnpm install --frozen-lockfile");
    case "bun":
      return "      - uses: oven-sh/setup-bun@v2\n" +
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
 * The GitHub Actions workflow: a manual dispatch that runs `bundle exec fastlane <platform>
 * <lane>` for Android on Ubuntu and iOS on macOS, with every credential a repository secret.
 *
 * @param opts Where the project is and how its packages install.
 */
export function workflowTemplate(opts: WorkflowOptions): string {
  const wd = yamlPath(opts.workingDirectory);
  const setup = (java: boolean) =>
    "      - uses: actions/checkout@v5\n" +
    "      - uses: denoland/setup-deno@v2\n" +
    "        with:\n" +
    '          deno-version: "v2.x"\n' +
    "      - uses: actions/setup-node@v4\n" +
    "        with:\n" +
    '          node-version: "22"\n' +
    (java
      ? "      - uses: actions/setup-java@v4\n" +
        "        with:\n" +
        "          distribution: temurin\n" +
        '          java-version: "21"\n'
      : "") +
    "      # Gemfile + Gemfile.lock: the pinned fastlane, cached between runs.\n" +
    "      - uses: ruby/setup-ruby@v1\n" +
    "        with:\n" +
    `          ruby-version: "${FASTLANE_RUBY}"\n` +
    "          bundler-cache: true\n" +
    `          working-directory: ${wd}\n` +
    installSteps(opts.install, opts.locked);
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
  # The denext CLI the lanes run (pin it to the version the app uses).
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
        run: echo "$ANDROID_KEYSTORE_BASE64" | base64 --decode > "$RUNNER_TEMP/upload.jks"
        env:
          ANDROID_KEYSTORE_BASE64: \${{ secrets.ANDROID_KEYSTORE_BASE64 }}
      - name: fastlane android
        run: bundle exec fastlane android "$LANE" \${FLAVOR:+"flavor:$FLAVOR"}
        env:
          SUPPLY_JSON_KEY_DATA: \${{ secrets.SUPPLY_JSON_KEY_DATA }}
          DENEXT_ANDROID_KEYSTORE: \${{ runner.temp }}/upload.jks
          DENEXT_ANDROID_KEY_ALIAS: \${{ secrets.ANDROID_KEY_ALIAS }}
          DENEXT_ANDROID_KEYSTORE_PASSWORD: \${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          DENEXT_ANDROID_KEY_PASSWORD: \${{ secrets.ANDROID_KEY_PASSWORD }}

  ios:
    if: inputs.platforms != 'android'
    runs-on: macos-15
    timeout-minutes: 90
    defaults:
      run:
        working-directory: ${wd}
    steps:
${setup(false)}      - name: fastlane ios
        run: bundle exec fastlane ios "$LANE" \${FLAVOR:+"flavor:$FLAVOR"}
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
