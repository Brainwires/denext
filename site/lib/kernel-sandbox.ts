// The kernel-sandbox section: one sidebar entry (`kernel-sandbox`) whose own pages nest under
// it while one of them is shown, as the examples do. The pages are flat routes
// (`/docs/kernel-sandbox-<page>`) because the docs tooling (corpus, anchor check) reads one
// directory level under `app/docs/`.

import type { NavChild } from "../components/ui.tsx";

/** The section's sub-pages, in reading order: route suffix and sidebar label. */
export const KERNEL_SANDBOX_PAGES: readonly { page: string; label: string }[] = [
  { page: "modes", label: "Modes & configuration" },
  { page: "warn", label: "Warn mode" },
  { page: "migrating", label: "Preparing for enforcement" },
  { page: "doctor", label: "Doctor & dry run" },
  { page: "rollout", label: "Rollout & defaults" },
  { page: "guarantees", label: "Guarantee matrix" },
  { page: "linux", label: "Linux" },
  { page: "macos", label: "macOS" },
  { page: "windows", label: "Windows" },
  { page: "desktop-and-compiled", label: "Desktop & compiled apps" },
  { page: "troubleshooting", label: "Troubleshooting" },
  { page: "threat-model", label: "Threat model" },
];

/** The nested links under "Kernel sandbox"; `current` marks the sub-page being shown. */
export function kernelSandboxNav(current?: string): NavChild[] {
  return KERNEL_SANDBOX_PAGES.map(({ page, label }) => ({
    href: `/docs/kernel-sandbox-${page}`,
    label,
    current: page === current,
  }));
}
