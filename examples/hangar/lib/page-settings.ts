// What the settings page may change (no Deno or DOM APIs, so the settings page imports it too).
// The backend checks the page's arguments against it (lib/hangar.ts's `parsePageSettings`).

/**
 * What the settings PAGE may change, and within which bounds: the page's arguments are not trusted
 * with the rest. Each key's kind is checked, and a key not listed here is refused, not ignored.
 * - `qemuPrefix` is not page-writable: Hangar runs `<prefix>/bin/qemu-*`, so a page that set it
 *   could make the app run any program. It is changed in the settings file (README).
 * - `ramBudgetPercent` may be lowered freely but raised only to {@linkcode PAGE_MAX_RAM_BUDGET} from the
 *   page: the budget is the guard against starting VMs that starve the host.
 */
export const PAGE_SETTINGS = {
  libraryRoot: { kind: "folder" },
  ramBudgetPercent: { kind: "int", min: 10, max: 90 },
  shutdownTimeoutSeconds: { kind: "int", min: 5, max: 600 },
} as const;

/** The highest RAM budget the page may set (the settings file may go to 100). */
export const PAGE_MAX_RAM_BUDGET = PAGE_SETTINGS.ramBudgetPercent.max;
