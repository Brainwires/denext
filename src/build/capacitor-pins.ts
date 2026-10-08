// The Capacitor release and native build outputs every denext Capacitor path shares:
// `denext create --capacitor`, `denext migrate --enable-capacitor` and `--from expo`.
// A leaf module, so the scaffolder does not load the migration code to read two constants.

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
