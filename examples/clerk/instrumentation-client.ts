// Runs in the browser before the app's client code (Next's `instrumentation-client`). In the
// Capacitor shell it installs Clerk's native bridge before `<ClerkProvider>` loads clerk-js:
// the client JWT in the Keychain / Keystore, Google / GitHub in the OS's auth session coming back
// to denextclerk://app/, passkeys through Clerk's hosted page. On the web and in the Deno Desktop
// window (whose preload installs its own bridge) it does nothing.
import { installClerkMobileBridge } from "denext/mobile/clerk";

installClerkMobileBridge({ scheme: "denextclerk", nativeClerk: true });
