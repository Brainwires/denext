---
title: Updates everywhere
slug: updates
lead: One "update everything" button for every platform the app ships to — checkForUpdates and applyUpdates from denext/updates install a phone's over-the-air UI, a Deno Desktop app's UI overlay and full app, or a newer web deploy, with one progress shape.
---

Each platform already has its own update path: [over-the-air UI updates](/docs/mobile#over-the-air-ui-updates)
on iOS and Android, the [UI overlay](/docs/desktop#desktop-updates) and the
[full-app update](/docs/desktop#desktop-app-updates) on Deno Desktop, and a reload in a browser.
`denext/updates` puts one page-side API over all of them, so an app's settings screen or "update
available" banner is written once:

```tsx
"use client";
import { useState } from "denext";
import { applyUpdates, checkForUpdates, type UpdateProgress } from "denext/updates";

const config = { ota: { baseUrl: "https://api.example.com/mobile-ui" } };

export function UpdateBanner() {
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const update = async () => {
    const found = await checkForUpdates(config);
    if (found.needsStoreUpdate) return alert("Update the app from the store to continue.");
    if (!found.available) return;
    const result = await applyUpdates(config, setProgress);
    if (result.restartRequired) alert("Restart to finish updating.");
  };
  return (
    <button type="button" onClick={update}>
      {progress ? `${progress.target}: ${progress.stage} ${progress.percent ?? ""}` : "Update"}
    </button>
  );
}
```

The module is opt-in: nothing runs at import, and each platform's code loads on the first call
that needs it, so a page that never calls it ships none of it.

## What each platform does

| `runtimePlatform()` | Targets          | Check                                            | Apply                                                          |
| ------------------- | ---------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `ios` / `android`   | `ui`             | `prepareUiUpdate`: download, verify and stage    | `applyUiUpdate`: the webview reloads into the new UI           |
| `desktop`           | `app`, else `ui` | the `updates` capability verifies each manifest  | download, install and relaunch; else stage + apply the overlay |
| `web`               | `web`            | the deployed build's version against this page's | `location.reload()`                                            |

Every safety check stays where it was: signatures, the sequence that refuses a downgrade or a
replayed manifest, a full-app manifest's expiry and the same code signer, the native fingerprint.
A target that is refused is listed in `failures` with the updater's own code (`signature`,
`downgrade`, `expired`, `replayed`, `integrity`, `network`, …); nothing throws.

## The config

```ts
import type { UpdatesConfig } from "denext/updates";

const config: UpdatesConfig = {
  // iOS / Android: checkForUiUpdate's options (baseUrl, headers, channel, …).
  ota: { baseUrl: "https://api.example.com/mobile-ui", channel: "production" },
  // Deno Desktop: which targets (both by default). The feeds are in denext.config.ts.
  desktop: { ui: true, app: true },
  // A browser tab: where the deployed version is read (default "/_denext/ota.json").
  web: { versionUrl: "/_denext/ota.json" },
};
```

Only the running platform's part is read, so one object serves the web, phone and desktop builds.

## Progress

`applyUpdates(config, onProgress)` calls `onProgress` with the same shape everywhere:

```ts
interface UpdateProgress {
  target: "ui" | "app" | "web";
  stage: "checking" | "downloading" | "ready" | "applying" | "done" | "up-to-date" | "failed";
  version?: string;
  percent?: number; // a desktop download, 0–100
  error?: string;
  code?: string; // why it failed
}
```

- **A phone** reports `checking` (one native step that also downloads and verifies a newer UI),
  then `ready`, then `applying`, and the page is replaced: the promise does not settle. The new
  page calls `otaBooted()` as usual.
- **Deno Desktop** installs the full app when a newer one is on offer: `checking`, `downloading`
  with `percent`, `ready`, then `applying` is the last report (the app answers, then quits, swaps
  itself and relaunches). Its UI comes with it, so the overlay is skipped: `up-to-date` with
  `code: "superseded"` (and `checkForUpdates` does not list it). Without a newer app, the UI
  overlay goes through the same stages and ends `done`: it is served from the next launch (the
  result says `restartRequired`; offer a restart with `quitApp()` from `denext/desktop/window`).
  An overlay is tied to the app it was installed over: once a new app is installed, every
  overlay of the old one is dropped at launch and the new app's own UI is served.
- **A browser** reports `checking`, then `ready` and `applying` before it reloads.

A target with nothing newer ends `up-to-date`; one that failed ends `failed`.

## A store update

On a phone, a UI built for another native layer (`native_mismatch`, a different
`denext mobile fingerprint`) or a newer binary (`native_too_old`, the manifest's `minNative`) can
only arrive with a new app from the store. `checkForUpdates` and `applyUpdates` set
`needsStoreUpdate: true` then; prompt with `promptStoreUpdate()` from `denext/mobile`.

## Deno Desktop setup

The checks and downloads run in the app's Deno side, so the page needs the `updates` capability:

```sh
denext desktop add updates
```

and the feeds in `denext.config.ts`:

```ts
desktop: {
  app: { identifier: "com.example.app" },
  capabilities: { updates: true },
  update: {
    // The UI overlay: a signed export (`denext ota manifest out --sign ota.key`).
    ui: { feedUrl: "https://updates.example.com/ui", publicKey: "MFkwEwYHKoZIzj0CAQYI…" },
    // The full app (`denext desktop publish-update`), under denext's pinned runtime.
    manifestUrl: "https://updates.example.com/app/app-update.json",
    publicKey: "MFkwEwYHKoZIzj0CAQYI…",
  },
},
```

`desktop.update.ui` also makes the generated `desktop.ts` serve the active overlay (rolled back
if it never boots), and its host joins the packaged app's `--allow-net` like `manifestUrl`'s. A
target without its config is skipped (reported `up-to-date`); without the capability every
target fails `unavailable`. Download progress reaches the page as the capability's `progress`
events, tagged with the run that asked, so a replayed event from an earlier run is ignored.

## A browser tab

The page compares the deployed build's version with its own: by default the `version` in
`/_denext/ota.json`, which a SPA export writes with `spa.ota: true` (or `denext ota manifest out`).
`web.versionUrl` points elsewhere: JSON with a string `version` or `buildId`, or plain text. The
page's own version is `web.currentVersion` when given, else the first one it reads, so check once
at startup and again later (on focus, on a timer). A build with no version to read reports
`no_version`.
