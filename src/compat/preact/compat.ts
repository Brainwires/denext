/**
 * `denext/preact/compat` — `preact/compat` on denext: the React API (`denext/react`) plus the
 * `react-dom` functions `preact/compat` also exports (`createPortal`, `render`, `hydrate`,
 * `flushSync`, `unstable_batchedUpdates`).
 *
 * @module
 */

export * from "../react.ts";
export { default } from "../react.ts";
export { createPortal, flushSync, hydrate, render, unstable_batchedUpdates } from "../react-dom.ts";
