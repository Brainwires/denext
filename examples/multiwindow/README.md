# Multiwindow (keyed windows, a Window menu and counters that outlive their window)

A small denext desktop app with two keyed windows (the main "workspace" and a "notes" window), New
Window and Reopen Closed Window from `desktop.menu.window`, frames and the session that come back at
the next launch (`desktop.app.restoreWindows`), and one ticking counter per window kept in the app's
process with `createOwnedResources`: close a window and its counter keeps going, detached; reopen
the window by its key and the page takes the counter back, replaying the ticks it missed. The
counter logic is plain code over a fake-able host, tested without a window.

## Run it

```sh
denext task desktop    # export + open the windows (denext's pinned Deno Desktop runtime)
denext task dev        # the page in a browser (the desktop calls say "unavailable")
```

## What to try

- Cmd/Ctrl+N opens another workspace window (desktop.ts picks its key, `window-N`); the Window menu
  lists the open windows.
- Close the "notes" window, then Cmd/Ctrl+Shift+T (Reopen Closed Window): the window comes back at
  its last frame, and its counter with the ticks it missed.
- Quit (Cmd+Q) and launch again: the windows open at the last quit come back
  (`desktop.app.restoreWindows`); the counters start afresh (a quit stops them, as `onAppQuit`).

## Where things are

- `denext.config.ts` — the keys, the Window menu, `restoreWindows`, the extension.
- `desktop.ts` — opens the second window, decides New Window's key and page, logs the quit.
- `desktop/counters.ts` — the `counters` extension (`start`, `mine`, `attach`, `stop`).
- `lib/counters.ts` — the counters over `createOwnedResources` (`onOwnerClosed: "detach"`).
- `app/workspace.tsx` — the page: reattach by key, or start a counter, and show its ticks.
