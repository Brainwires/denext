"use client";
// Deno Desktop only: who handles this app's deep-link scheme, and a button to take it over.
// Google / GitHub sign-in returns to `denextclerk://app/` — on Windows and Linux as a deep link,
// so when another app handles the scheme the sign-in is refused (`scheme_owned_by_other_app`)
// until the user makes this app the handler. macOS signs in through the OS sheet regardless.
import { useEffect, useState } from "react";
import { runtimePlatform } from "denext/mobile";
import { claimDeepLinkScheme, deepLinkSchemeOwner } from "denext/desktop/client";

const SCHEME = "denextclerk";

export function DesktopPanel() {
  const [desktop, setDesktop] = useState(false);
  const [owner, setOwner] = useState<string>("…");
  useEffect(() => {
    if (runtimePlatform() !== "desktop") return;
    setDesktop(true);
    deepLinkSchemeOwner(SCHEME).then(
      (o) => setOwner(o.owner + (o.handler ? ` (${o.handler})` : "")),
      (err) => setOwner(`unknown: ${(err as Error).message}`),
    );
  }, []);
  if (!desktop) return null;
  return (
    <div class="card" id="desktop-panel">
      <p>
        Deno Desktop. <code>{SCHEME}:</code> links are handled by:{" "}
        <strong id="scheme-owner">{owner}</strong>
      </p>
      {owner.startsWith("other") && (
        <button
          type="button"
          onClick={async () => {
            const r = await claimDeepLinkScheme(SCHEME);
            setOwner(r.registered ? "self" : `other (${r.reason ?? "refused"})`);
          }}
        >
          Make this app the handler of {SCHEME}: links
        </button>
      )}
    </div>
  );
}
