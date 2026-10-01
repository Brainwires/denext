// `desktop.preload`: bundled into one classic script and inlined into every top-level page the
// desktop runtime serves, right after the `__denext` global and before any of the page's own
// scripts (Electron's preload). The page's "preload" check reads what this leaves behind.

declare global {
  var __kitchenPreload: {
    ran: true;
    denextGlobal: boolean;
    pageScriptsBefore: number;
  } | undefined;
}

globalThis.__kitchenPreload = {
  ran: true,
  // The runtime injects `__denext` first, so a preload can already see it.
  denextGlobal: typeof (globalThis as { __denext?: unknown }).__denext === "object",
  // No page script has run yet: only the injected global and this preload are in the document.
  pageScriptsBefore: document.querySelectorAll("script[src]").length,
};

export {};
