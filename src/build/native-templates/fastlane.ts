// The readable source of the native templates in src/build/fastlane-templates.ts. NOT
// published: `deno task gen:native-templates` (scripts/gen-native-templates.ts) packs every
// exported record below into the docs-corpus pack, which the published module reads. Edit the
// templates here, then regenerate; tests/native-templates-packed.test.ts fails while the packed
// copy differs.
// Each `{{=name}}` is a hole the published function fills (`fillTemplate`,
// src/build/packed-text.ts): every hole needs a value, and every value a hole.

/**
 * The files `denext mobile add fastlane` writes, by name. `Appfile`'s and `Matchfile`'s `id` is
 * the app id as a Ruby string literal; `Gemfile`'s `version` is the fastlane release it pins.
 */
export const FASTLANE_TEMPLATES: Readonly<Record<string, string>> = {
  "Appfile": `# Written by \`denext mobile add fastlane\`: who the app is. Identifiers only: every
# credential comes from the environment (a CI secret, or your shell), never from this file.

# The base app's bundle id / package name (capacitor.config appId; \`denext mobile doctor
# --release\` reports a mismatch). A flavor build carries its own id (denext.config
# mobile.flavors), which the lanes read from the build itself.
app_identifier({{=id}})
package_name({{=id}})

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
`,
  "Matchfile":
    `# Written by \`denext mobile add fastlane\`. match keeps the team's distribution certificate
# (and an App Store profile per app id) in one encrypted store that every machine and CI share.
#
# Create it once, from a Mac with access to the Apple account:
#   MATCH_GIT_URL=… denext fastlane match appstore
# The iOS lanes then run match read-only before each build whenever MATCH_GIT_URL (or
# MATCH_STORAGE_MODE) is set, so the build signs with that certificate instead of minting a new
# one. The passphrase is MATCH_PASSWORD; a private git store over HTTPS takes
# MATCH_GIT_BASIC_AUTHORIZATION (base64 of "user:token"). None of them belongs in this file.

git_url(ENV["MATCH_GIT_URL"]) unless ENV["MATCH_GIT_URL"].to_s.empty?
storage_mode(ENV["MATCH_STORAGE_MODE"].to_s.empty? ? "git" : ENV["MATCH_STORAGE_MODE"])
type("appstore")
app_identifier([{{=id}}])
`,
  "Gemfile":
    `# Written by \`denext mobile add fastlane\`. \`denext fastlane …\` runs denext's own pinned fastlane
# (installed on first use; no Ruby setup) and does not read this file. It is for running fastlane
# through your own Ruby instead, which fastlane plugins need: \`bundle install\` (commit
# Gemfile.lock), then \`bundle exec fastlane …\`.
source "https://rubygems.org"

gem "fastlane", "~> {{=version}}"

# \`bundle exec fastlane add_plugin <name>\` records plugins in fastlane/Pluginfile.
plugins_path = File.join(File.dirname(__FILE__), "fastlane", "Pluginfile")
eval_gemfile(plugins_path) if File.exist?(plugins_path)
`,
  ".gitignore": `# Written by \`denext mobile add fastlane\`: what fastlane generates on every run.
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
`,
  "Fastfile":
    `# Written by \`denext mobile add fastlane\`: fastlane lanes over denext's own build pipeline.
#
#   denext fastlane ios build|beta|release     [flavor:staging] [build_number:42] …
#   denext fastlane android build|beta|release [flavor:staging] [track:internal] …
#
# \`denext fastlane\` runs denext's pinned fastlane (installed on first use into denext's toolchain
# cache); with plugins in fastlane/Pluginfile, run \`bundle exec fastlane …\` through the Gemfile.
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
#             submit:true / automatic_release:true (release), unsigned:true (build only: an
#             unsigned .ipa, no certificate or Apple account needed)
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
  args << "--unsigned" if platform.to_s == "ios" && truthy(options[:unsigned])
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
  unsigned = truthy(options[:unsigned])
  UI.user_error!("unsigned:true builds only (the stores take a signed .ipa)") if unsigned && store
  setup_ci if env_value("CI") && !unsigned
  denext_match(denext_plan(:ios, options)["appId"], options) unless unsigned
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
  desc "Signed App Store .ipa with \`denext mobile build ios --release\` (match first when configured; unsigned:true for an unsigned one)"
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
`,
};
