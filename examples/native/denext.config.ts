import type { DenextConfig } from "denext/server";

export default {
  desktop: {
    // Unique per app: keys the desktop runtime's storage dirs and the secureStore keychain
    // service. Kept equal to deno.json's desktop.app.identifier.
    app: { identifier: "com.example.denext-native" },
    // capabilities: { fs: true, secureStore: true, shell: true },  // denext desktop add <cap>
  },
} satisfies DenextConfig;
