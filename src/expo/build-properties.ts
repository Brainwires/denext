/**
 * `expo-build-properties` for denext: a stub. It is an Expo config plugin that sets native
 * build properties (Gradle, CocoaPods) at prebuild time; it never runs in the app, and a
 * denext build has no prebuild step. `withBuildProperties` returns the config unchanged, so
 * an `app.config.ts` that imports it still evaluates. Set native build settings in the
 * Capacitor projects instead.
 *
 * @example
 * ```ts
 * import { withBuildProperties } from "denext/expo/build-properties";
 *
 * export default withBuildProperties(config, { ios: { deploymentTarget: "16.0" } }); // unchanged
 * ```
 *
 * @module
 */

/** The plugin's options (accepted, not applied). */
export interface PluginConfigType {
  /** Android build properties. */
  android?: Record<string, unknown>;
  /** iOS build properties. */
  ios?: Record<string, unknown>;
}

/**
 * The config plugin: returns `config` unchanged.
 *
 * @param config The Expo config.
 * @param _props The build properties (not applied).
 * @returns `config`.
 */
export function withBuildProperties<T>(config: T, _props?: PluginConfigType): T {
  return config;
}

/** The config plugin, as the package's default export. */
export default withBuildProperties;
