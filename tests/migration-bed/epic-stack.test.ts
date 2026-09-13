// Migration bed: epicweb-dev/epic-stack at its last Remix commit — Remix 2 + remix-flat-routes
// (`+` folders, `_layout`, `$username_+` break-outs), Prisma + SQLite, session auth with a
// seeded admin, TOTP 2FA, conform + zod, resource routes (images, theme switch, healthcheck),
// Tailwind v3, remix-seo (sitemap/robots), root `Layout` export. The third-party Remix bed
// whose hand migration (2026-09-06) produced ~20 migrator/runtime fixes.
//
// Pin: b667696 is the parent of "migrate to react router 7" (#897, 2025-01-16) — the last
// commit that is a Remix app; `denext migrate --from remix` is the path under test. Later
// commits are React Router 7 apps (a different bed, the `@denext/react-router` plugin).
//
// Setup mirrors the app's README, minus Playwright: copy `.env.example`, `deno task
// prisma:setup` (migrate generated it: prisma generate + migrate deploy), the icon sprite
// build (gitignored output the routes import), and the seed (creates the `kody` admin the
// /users routes render). NETWORK-REQUIRED (GitHub clone + npm install + the Prisma engine
// download): `deno task test:migration-bed`.

import { join } from "@std/path";
import { type Bed, runBed } from "./_bed.ts";

const EPIC_STACK: Bed = {
  name: "epic-stack",
  repo: "https://github.com/epicweb-dev/epic-stack.git",
  sha: "b667696a997b7d5e371039206d97f931ac063513",
  install: [["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"]],
  prepare: (dir) => Deno.copyFile(join(dir, ".env.example"), join(dir, ".env")),
  migrate: ["--from", "remix"],
  kind: "remix",
  afterMigrate: [
    ["$deno", "task", "prisma:setup"],
    ["npm", "run", "build:icons"],
    // The seed does its work in ~3 s and then never exits (an engine handle stays open under
    // Deno), so it gets a short deadline and its own "done" line as the success marker.
    {
      cmd: [
        "$deno",
        "run",
        "-A",
        "--node-modules-dir=manual",
        "--no-lock",
        "--env-file=.env",
        "prisma/seed.ts",
      ],
      timeoutMs: 90_000,
      expect: "Database has been seeded",
    },
  ],
  routes: [
    { path: "/", contains: "Epic Notes" },
    { path: "/login", contains: "Welcome back!" },
    { path: "/signup", contains: "start your journey" },
    // Prisma raw query over the seeded users.
    { path: "/users", contains: "Epic Notes Users" },
    { path: "/users/kody", contains: "Kody" },
    { path: "/users/kody/notes", contains: "Notes" },
    // Session-gated routes redirect to login with the return path (Remix `redirect()`).
    {
      path: "/settings/profile",
      status: 302,
      contains: "",
      location: "/login?redirectTo=%2Fsettings%2Fprofile",
    },
    { path: "/me", status: 302, contains: "", location: "/login?redirectTo=%2Fme" },
    // Resource routes + remix-seo through the generated load context.
    { path: "/resources/healthcheck", contains: "OK" },
    { path: "/sitemap.xml", contains: "<urlset" },
    { path: "/robots.txt", contains: "User-agent" },
    // The app's own root ErrorBoundary renders the 404.
    { path: "/nope", status: 404, contains: "find this page" },
  ],
};

Deno.test({
  name: "migration bed: epicweb-dev/epic-stack (Remix) migrates, builds, and renders",
  sanitizeOps: false,
  sanitizeResources: false,
}, (t) => runBed(t, EPIC_STACK));
