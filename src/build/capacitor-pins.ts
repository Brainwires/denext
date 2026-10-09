// The Capacitor release and native build outputs every denext Capacitor path shares:
// `denext create --capacitor`, `denext migrate --enable-capacitor` and `--from expo`.
// A leaf module, so the scaffolder does not load the migration code to read two constants.

/**
 * Yarn's switches for "run no lifecycle scripts", for the installs `denext migrate` and
 * `denext mobile add` run: Yarn Berry rejects `--ignore-scripts`, so both majors are told through
 * the environment — `npm_config_ignore_scripts` (Yarn 1 reads the npm config) and
 * `YARN_ENABLE_SCRIPTS` (Berry's `enableScripts`). The Capacitor packages need no install script,
 * and a `yarn add` would otherwise run the project's own (a monorepo's `prepare`, a
 * `postinstall`) and its dependencies'.
 */
export const YARN_NO_SCRIPTS_ENV: Readonly<Record<string, string>> = {
  npm_config_ignore_scripts: "true",
  YARN_ENABLE_SCRIPTS: "0",
};

/** The Capacitor release the shell targets (Capacitor 8, as every `mobile add` plugin). */
export const CAPACITOR_VERSION = "^8.5.2";

/**
 * The Capacitor build outputs and copied web assets a project ignores. Capacitor 8 builds iOS
 * with Swift Package Manager, and the `ios/` + `android/` projects are meant to be committed —
 * so only their build outputs and the web assets `cap sync` copies in are ignored (the
 * platforms' own generated `.gitignore` files cover the rest).
 */
export const CAPACITOR_BUILD_IGNORES: readonly string[] = [
  "ios/App/App/public/",
  "ios/App/build/",
  "ios/DerivedData/",
  "android/app/src/main/assets/public/",
  "android/app/build/",
  "android/build/",
  "android/.gradle/",
];
