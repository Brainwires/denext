// `spa.shell`: the app-facing half of the prerendered static shell. The shell's inline capture
// script (src/build/spa/shell.ts) owns `globalThis.__denextShell` and records what the user typed
// into each `data-denext-shell-key` field; the adopt runtime (./shell-runtime.ts, installed by the
// generated SPA entry only when `spa.shell` is configured) adds `ready`. These functions only read
// that global, so they cost nothing in an app that does not call them and are inert (null / no-op)
// wherever no shell was rendered: an App Router page, a test, the server.

import { useState } from "../runtime/hooks.ts";

/**
 * What the user did in one shell field before the app took over: the field's text, its selection
 * (character offsets into `text`), whether it had focus, and its scroll position.
 *
 * For a `contenteditable` field, `text` is its plain text with a line break for each `<br>` and
 * each block (`<div>`, `<p>`) after the first, and the offsets count into that text.
 */
export interface ShellHandoff {
  /** The field's text. */
  text: string;
  /** Selection start, as a character offset into {@linkcode ShellHandoff.text}. */
  selectionStart: number;
  /** Selection end, as a character offset into {@linkcode ShellHandoff.text}. */
  selectionEnd: number;
  /** Whether the field (or, for `contenteditable`, something inside it) had focus. */
  focused: boolean;
  /** The field's `scrollTop`. */
  scrollTop: number;
}

/** The page-global the shell's capture script and the adopt runtime share. */
export interface ShellGlobal {
  /** Per-key field state, kept current as the user types. */
  s: Record<string, ShellHandoff>;
  /** Keys whose state the app (or the swap) has taken. */
  t: Record<string, 1>;
  /** Capture every shell field now; returns {@linkcode ShellGlobal.s}. */
  c?: () => Record<string, ShellHandoff>;
  /** Set once the app has replaced the shell. */
  d?: 1;
  /** Swap the app in now (installed by the adopt runtime). */
  ready?: () => void;
  /** `shellReady()` ran before the adopt runtime was installed. */
  r?: 1;
  /** Resolvers of the `shellReady()` promises, run once the app has replaced the shell. */
  q?: (() => void)[];
}

/** The shell global, or undefined when the page carries no `spa.shell`. */
export function shellGlobal(): ShellGlobal | undefined {
  return (globalThis as { __denextShell?: ShellGlobal }).__denextShell;
}

/**
 * Tell denext the app is ready to replace the prerendered `spa.shell`: the app, rendered
 * off-screen meanwhile, is swapped in before the next paint (in a microtask, so a call from a
 * render or an effect lands after the commit in progress), and the text, selection, focus and
 * scroll of each `data-denext-shell-key` field carry over. With `spa.shell.readyOn: "shellReady"`
 * this is the only trigger besides `maxHoldMs`; with the default (`"first-settled-commit"`) it
 * swaps early.
 *
 * @returns Resolves once the app has replaced the shell (at once when the page has no shell or
 *   it was already replaced): the moment to restore an editor's selection, now that its element
 *   is visible and focusable.
 */
export function shellReady(): Promise<void> {
  const g = shellGlobal();
  if (!g || g.d) return Promise.resolve();
  return new Promise((resolve) => {
    (g.q ??= []).push(resolve);
    if (g.ready) g.ready();
    else g.r = 1;
  });
}

/**
 * Take what the user typed into the shell field marked `data-denext-shell-key={key}`, once.
 * The first call returns the field's state at that moment and later calls return `null`, as
 * does a page with no shell or no such field. For code outside React (an editor's `onCreate`)
 * that restores the text and selection itself; call {@linkcode shellReady} right after applying
 * it, so nothing typed in between is lost. A key taken here is not filled in by denext at the
 * swap, but its field is still focused there when the shell field had focus.
 *
 * @param key The field's `data-denext-shell-key`.
 * @returns The field's state, or `null`.
 */
export function consumeShellHandoff(key: string): ShellHandoff | null {
  const g = shellGlobal();
  if (!g || g.t[key]) return null;
  if (!g.d) g.c?.();
  const state = g.s[key];
  if (!state) return null;
  g.t[key] = 1;
  return state;
}

/**
 * {@linkcode consumeShellHandoff} as a hook: the shell field's state on the component's first
 * render (then the same value for the component's lifetime), or `null`.
 *
 * @param key The field's `data-denext-shell-key`.
 * @returns The field's state, or `null`.
 */
export function useShellHandoff(key: string): ShellHandoff | null {
  return useState(() => consumeShellHandoff(key))[0];
}
