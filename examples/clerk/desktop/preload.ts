// `desktop.preload`: runs in the window before any page script (Electron's preload). It installs
// the Clerk bridge SYNCHRONOUSLY — no `await` before the call: the bridge reads its per-launch
// preload key while this script runs, and clerk-js must find the bridge when it loads.
//
// `nativeClerk` switches the clerk-js instance `@clerk/nextjs`'s `<ClerkProvider>` loads into
// native mode (the client JWT in the keychain, OAuth through the OS sheet / system browser), so
// the app's own provider signs in here unchanged. `passkeys` (from `@clerk/electron/passkeys`)
// routes passkey ceremonies to the OS where the relying party allows it.
import { installClerkDesktopBridge } from "denext/desktop/clerk";
import { passkeys } from "@clerk/electron/passkeys";

installClerkDesktopBridge({ passkeys: true, nativeClerk: { passkeys } });
