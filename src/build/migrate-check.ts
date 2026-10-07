// `denext migrate --check`: what `denext migrate` would do to a project, without doing it.
//
// The check runs the real migrate planners (`migrateProject`) inside a dry run
// (`migrate-io.ts`), so the report can't drift from the migration itself: the changes listed
// are the files the real run would create, modify, move or delete, and the findings come from
// the same result object the real run prints. Nothing is written, so read permission is
// enough (`deno run --allow-read --allow-env …/cli migrate --check`).

import { VERSION } from "../../mod.ts";
import { type MigrateOptions, migrateProject, type MigrateResult } from "./migrate.ts";
import { dryRunMigration, type PlannedChange } from "./migrate-io.ts";

/** The source framework a check detected. */
export type MigrateSource =
  | "next-app-router"
  | "next-pages-router"
  | "remix"
  | "react-router"
  | "vite"
  | "cra"
  | "generic-react"
  | "expo";

/** Something the migration leaves to the user, with the reason. */
export interface MigrateFinding {
  /** What it concerns: a package, a config key, a file. */
  item: string;
  /** Why, and what to do about it. */
  reason: string;
}

/**
 * The overall verdict: `ready` (nothing left to the user), `review` (the migration runs, but
 * the findings need a look), or `blocked` (the migration would fail; see `error`).
 */
export type MigrateVerdict = "ready" | "review" | "blocked";

/** The `denext migrate --check --json` report. */
export interface MigrateCheckReport {
  /** The report format; bumped on an incompatible change. */
  schema: "denext.migrate-check/1";
  /** The project directory (absolute). */
  target: string;
  /** The denext version that produced the report. */
  denext: string;
  /** The detected source framework; null when the migration could not start. */
  source: MigrateSource | null;
  verdict: MigrateVerdict;
  /** The files `denext migrate` would create, modify, move or delete (relative paths). */
  changes: Array<Omit<PlannedChange, "content">>;
  /** What will not migrate, with the reason for each. */
  wontMigrate: MigrateFinding[];
  /** What migrates but needs a human look or a follow-up step. */
  review: MigrateFinding[];
  /** How the app's dependencies are handled; null when blocked. */
  dependencies: Pick<MigrateResult, "aliased" | "passthrough" | "dropped" | "flagged"> | null;
  /** Why the migration would fail (verdict `blocked`). */
  error?: string;
  /** The command that performs this migration. */
  command: string;
}

/** The detected source framework for a migration result. */
function migrateSource(r: MigrateResult): MigrateSource {
  switch (r.kind) {
    case "next":
      return r.pagesRouter ? "next-pages-router" : "next-app-router";
    case "remix":
      return r.remix ? "remix" : "react-router";
    case "spa":
      return "vite";
    case "generic":
      return "generic-react";
    default:
      return r.kind;
  }
}

/** The `denext migrate` command line that runs the checked migration. */
function migrateCommandLine(options: MigrateOptions): string {
  const parts = ["denext migrate"];
  if (options.from) parts.push(`--from ${options.from}`);
  if (options.desktop) parts.push("--desktop");
  if (options.backend) parts.push(`--backend ${options.backend}`);
  if (options.proxyPrefixes?.length) parts.push(`--proxy ${options.proxyPrefixes.join(",")}`);
  return parts.join(" ");
}

/** Dependencies migrate flags as unrunnable. */
function dependencyFindings(r: MigrateResult): MigrateFinding[] {
  return r.flagged.map((item) => ({
    item,
    reason: "a native or engine dependency denext cannot run (no web or Deno build); " +
      "replace it or move it behind a service",
  }));
}

/** Hand-authored config files migrate leaves in place. */
function existingConfigFindings(r: MigrateResult): MigrateFinding[] {
  const out: MigrateFinding[] = [];
  if (r.denoJsonExists) {
    out.push({
      item: "deno.json",
      reason: "a hand-authored deno.json exists and is left untouched; merge the generated " +
        "import map and tasks into it by hand (or remove it and re-run migrate)",
    });
  }
  const configKept = r.pagesConfigExists || (r.spa !== undefined && !r.spa.configWritten);
  if (configKept) {
    const plugins = [
      ...(r.pagesRouter ? ['pagesRouter() from "@denext/pages-router"'] : []),
      ...(r.effect ? ['effect() from "@denext/effect"'] : []),
    ];
    out.push({
      item: "denext.config.ts",
      reason: "a hand-authored denext.config.ts exists and is left untouched" +
        (plugins.length ? `; add ${plugins.join(" and ")} to its plugins` : ""),
    });
  }
  return out;
}

/** next.config keys that are not carried over. */
function nextConfigFindings(
  r: MigrateResult,
): { wont: MigrateFinding[]; review: MigrateFinding[] } {
  const n = r.nextConfig;
  if (!n) return { wont: [], review: [] };
  if (!n.evaluated) {
    return {
      wont: [{
        item: n.file,
        reason: "could not be evaluated" + (n.reason ? ` (${n.reason})` : "") +
          "; port basePath, trailingSlash, assetPrefix, images, i18n, redirects, rewrites " +
          "and headers into denext.config.ts by hand",
      }],
      review: [],
    };
  }
  const wont: MigrateFinding[] = [];
  const review: MigrateFinding[] = [];
  for (const d of n.dropped) {
    const item = `${n.file}: ${d.key}`;
    if (d.note) wont.push({ item, reason: d.note });
    else review.push({ item, reason: "dropped; denext needs no equivalent" });
  }
  return { wont, review };
}

/** The assisted Remix transform and the Prisma rewiring leave notes for a human. */
function transformFindings(r: MigrateResult): MigrateFinding[] {
  const out: MigrateFinding[] = [];
  for (const w of r.remix?.warnings ?? []) out.push({ item: "remix route tree", reason: w });
  if (r.prisma) {
    out.push({
      item: "prisma",
      reason: `run \`deno task ${r.prisma.setupTask}\` once before \`deno task dev\` / \`build\``,
    });
    for (const w of r.prisma.warnings) out.push({ item: "prisma", reason: w });
  }
  return out;
}

/** What an Expo app leaves to the user: unreadable config, native-only packages, Metro. */
function expoFindings(r: MigrateResult): { wont: MigrateFinding[]; review: MigrateFinding[] } {
  const e = r.expo;
  if (!e) return { wont: [], review: [] };
  const wont: MigrateFinding[] = [
    ...e.config.unresolved.map((key) => ({
      item: `app config: ${key}`,
      reason: "computed in code, so not statically readable; set it by hand",
    })),
    ...e.deps.nativeOnly.map((p) => ({
      item: p.name,
      reason: `native-only (${p.kind}); no web build, so give the importing module a .web.ts ` +
        'or map the package to a web stub in deno.json "imports"',
    })),
    ...e.deps.expo.filter((p) => p.status === "none" && p.advice).map((p) => ({
      item: p.name,
      reason: `no denext/expo shim: ${p.advice}`,
    })),
    ...e.metro.extraModules.map((m) => ({
      item: `${e.metro.file}: ${m}`,
      reason: 'a module only Metro provides (extraNodeModules); map it in deno.json "imports"',
    })),
  ];
  if (e.metro.resolveRequest) {
    wont.push({
      item: `${e.metro.file}: resolveRequest`,
      reason: "the denext build does not run a custom resolver; carry its redirects over as " +
        'deno.json "imports"',
    });
  }
  const review: MigrateFinding[] = [
    ...e.missingPackages.map((p) => ({ item: p, reason: "the web build needs it; install it" })),
    ...e.prebuildFolders.map((f) => ({
      item: `${f}/`,
      reason:
        "Expo prebuild output; Capacitor creates its own, so move it aside before `npx cap add`",
    })),
    ...(e.capacitor.placeholderId
      ? [{ item: "capacitor.config.ts", reason: `placeholder appId ${e.capacitor.appId}; set it` }]
      : []),
    ...(e.mobile.command
      ? [{ item: "native capabilities", reason: `run \`${e.mobile.command}\`` }]
      : []),
    ...Object.keys(e.mobile.manualPlist).map((key) => ({
      item: `Info.plist: ${key}`,
      reason: "an iOS usage string no capability writes; copy it into ios/App/App/Info.plist",
    })),
    ...e.mobile.manualPermissions.map((perm) => ({
      item: perm,
      reason: "an Android permission no capability declares; add it to AndroidManifest.xml",
    })),
    ...(e.tailwindInput
      ? [{
        item: e.tailwindInput,
        reason: "uniwind / NativeWind styling is not wired automatically; follow the guide's " +
          "uniwind recipe",
      }]
      : []),
  ];
  return { wont, review };
}

/** A desktop proxy whose prefixes migrate could not read (built in code in vite.config). */
function spaProxyFindings(r: MigrateResult): MigrateFinding[] {
  const file = r.spa?.proxyUnresolved;
  if (!file) return [];
  return [{
    item: `${file}: server.proxy`,
    reason: "built in code, so its prefixes could not be read; spa.proxy falls back to " +
      `${r.spa?.proxy?.prefixes.join(",") ?? "/api"}. Pass every backend prefix with --proxy ` +
      "(e.g. --proxy /api,/ws), or the desktop app cannot reach the rest",
  }];
}

/** Every finding for a successful dry run, split into won't-migrate and review. */
function findings(r: MigrateResult): { wont: MigrateFinding[]; review: MigrateFinding[] } {
  const next = nextConfigFindings(r);
  const expo = expoFindings(r);
  return {
    wont: [
      ...dependencyFindings(r),
      ...existingConfigFindings(r),
      ...next.wont,
      ...expo.wont,
    ],
    review: [...next.review, ...spaProxyFindings(r), ...transformFindings(r), ...expo.review],
  };
}

/**
 * Report what `denext migrate` would do to the project at `dir` with `options`, writing
 * nothing. A migration that would throw (no package.json, a Yarn PnP install, no Expo web
 * entry) is reported as `blocked` with the reason instead of throwing.
 */
export async function checkMigration(
  dir: string,
  options: MigrateOptions = {},
): Promise<MigrateCheckReport> {
  const base = {
    schema: "denext.migrate-check/1" as const,
    target: dir,
    denext: VERSION,
    command: migrateCommandLine(options),
  };
  let run: Awaited<ReturnType<typeof dryRunMigration<MigrateResult>>>;
  try {
    run = await dryRunMigration(dir, () => migrateProject(dir, options));
  } catch (err) {
    return {
      ...base,
      source: null,
      verdict: "blocked",
      changes: [],
      wontMigrate: [],
      review: [],
      dependencies: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const r = run.result;
  const { wont, review } = findings(r);
  return {
    ...base,
    source: migrateSource(r),
    verdict: wont.length || review.length ? "review" : "ready",
    changes: run.changes.map(({ content: _content, ...c }) => c),
    wontMigrate: wont,
    review,
    dependencies: {
      aliased: r.aliased,
      passthrough: r.passthrough,
      dropped: r.dropped,
      flagged: r.flagged,
    },
  };
}
