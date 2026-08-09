import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.example.denext-native",
  appName: "denext native",
  // denext's static export (`deno task export`) writes here; Capacitor bundles it.
  webDir: "out",
};

export default config;
