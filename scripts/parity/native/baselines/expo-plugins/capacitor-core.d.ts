// The @capacitor/core 8 types the vendored plugin declarations import (as the package defines them).
export type PermissionState = "prompt" | "prompt-with-rationale" | "granted" | "denied";
export interface PluginListenerHandle {
  remove: () => Promise<void>;
}
