/**
 * `denext/preact/compat` — `preact/compat` on denext: the React API (`denext/react`) plus the
 * `react-dom` functions `preact/compat` also exports (`createPortal`, `render`, `hydrate`,
 * `flushSync`, `unstable_batchedUpdates`). `createElement` / `cloneElement` are `denext/preact`'s, so
 * Preact's `options.vnode` / `options.event` hooks see compat's elements too.
 *
 * @module
 */

import React from "../react.ts";
import { cloneElement, createElement } from "./mod.ts";

export * from "../react.ts";
// Preact's own factories, so `options.vnode` / `options.event` see compat's elements too.
export { cloneElement, createElement };
export { type Options, options } from "./options.ts";

/** The default export (`import React from "preact/compat"`), with Preact's factories. */
const PreactCompat: typeof React = { ...React, createElement, cloneElement } as typeof React;
export default PreactCompat;
export { createPortal, flushSync, hydrate, render, unstable_batchedUpdates } from "../react-dom.ts";
