// The "instances changed" notice the pages refresh on (app/use-overview.ts). The tray starts and
// stops VMs from desktop.ts with no page call in flight, so the notice goes out through the host the
// `hangar` extension's `setup` received at launch (denext's `DesktopExtensionHost`), not a method
// call's `ctx.emit`. No Deno or denext imports, so the tests drive it with a fake host.

/** The event the pages subscribe to (`onDesktopEvent("hangar", CHANGED_EVENT, …)`). */
export const CHANGED_EVENT = "changed";

/** The slice of `DesktopExtensionHost` the notice uses. */
export interface ChangeHost {
  emit(event: string, data: unknown): void;
}

/** The notice: `attach` takes the extension's host, `changed` tells the pages (once attached). */
export interface ChangeNotifier {
  attach(host: ChangeHost): void;
  changed(): void;
}

/** A notice that sends nothing until the extension's `setup` attached the host. */
export function createChangeNotifier(): ChangeNotifier {
  let host: ChangeHost | undefined;
  return {
    attach: (h) => {
      host = h;
    },
    changed: () => host?.emit(CHANGED_EVENT, null),
  };
}
