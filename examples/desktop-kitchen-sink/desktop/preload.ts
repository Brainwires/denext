// `desktop.preload`: bundled into one classic script and inlined into every top-level page the
// desktop runtime serves, right after the `__denext` global and before any of the page's own
// scripts (Electron's preload). The page's "preload" check reads what this leaves behind, and the
// Clerk checks drive the bridge it installs.

import { installClerkDesktopBridge } from "denext/desktop/clerk";

declare global {
  var __kitchenPreload: {
    ran: true;
    denextGlobal: boolean;
    pageScriptsBefore: number;
    clerkBridge: boolean;
  } | undefined;
}

// `@clerk/electron`'s globals, as an Electron preload's `exposeClerkBridge({ passkeys: true })`
// sets them. No browser fallback after `invalid_rp`: there is no Clerk instance on this page.
const clerk = installClerkDesktopBridge({ passkeys: true, passkeyFallback: "none" });

globalThis.__kitchenPreload = {
  ran: true,
  // The runtime injects `__denext` first, so a preload can already see it.
  denextGlobal: typeof (globalThis as { __denext?: unknown }).__denext === "object",
  // No page script has run yet: only the injected global and this preload are in the document.
  pageScriptsBefore: document.querySelectorAll("script[src]").length,
  clerkBridge: clerk?.passkeys !== undefined,
};

export {};
