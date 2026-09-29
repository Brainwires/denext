const path = require("path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

/**
 * The bench data and row designs live in ../shared (plain TypeScript shared with the denext
 * app and the adb harness), outside this project root: watch it, and resolve its imports
 * from this project's node_modules.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [path.resolve(__dirname, "../shared")],
  resolver: {
    nodeModulesPaths: [path.resolve(__dirname, "node_modules")],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
