// `denext migrate --check`: what `denext migrate` would do to a project, without doing it.
//
// The check runs the real migrate planners (`migrateProject`) inside a dry run
// (`migrate-io.ts`), so the report can't drift from the migration itself: the changes listed
// are the files the real run would create, modify, move or delete, and the findings come from
// the same result object the real run prints. Nothing is written, so it needs read access plus
// run access for the `next.config.*` evaluator, which is a `deno` subprocess
// (`deno run --allow-read --allow-env --allow-run …/cli migrate --check`). Without
// `--allow-run` the config is reported as not evaluated, not as unportable.

import { VERSION } from "../../mod.ts";
import { type MigrateOptions, migrateProject, type MigrateResult } from "./migrate.ts";
import { dryRunMigration, type PlannedChange } from "./migrate-io.ts";
import { NEXT_CONFIG_NEEDS_RUN } from "./next-config-eval.ts";
import { COMPUTED_ICON_FIX } from "./mobile-icon-source.ts";

/** The source framework a check detected. */
export type MigrateSource =
  | "next-app-router"
  | "next-pages-router"
  | "remix"
  | "react-router"
  | "vite"
  | "cra"
  | "generic-react"
  | "expo"
  | "tanstack-start"
  | "fresh"
  | "preact"
  | "lustre";

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
  /**
   * The app icon `denext mobile assets` / `mobile build` would use and where it was found
   * (`icon` null: none), for an SPA / Expo migration.
   */
  appIcon?: { icon: string | null; kind: string | null; size?: string; lines: string[] };
  /**
   * The commands `denext migrate` would run after writing (`--enable-capacitor`: the package
   * install, and with `--platform` the export and `npx cap add`), including ones it would only
   * print for the user to run.
   */
  commands?: string[];
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

/**
 * `path` as one argument of a command line the user pastes into this OS's shell. A Windows path
 * keeps its backslashes (cmd and PowerShell read them literally; JSON-escaping doubled them), in
 * double quotes when it has a space; elsewhere it is single-quoted when anything in it is special.
 *
 * @internal
 * @param path The path.
 * @param os The OS whose shell reads the line (`Deno.build.os`).
 * @returns The argument.
 */
export function shellPathArg(path: string, os: string): string {
  if (os === "windows") return /[\s&()^%!;,]/.test(path) ? `"${path}"` : path;
  return /[^\w@%+=:,./-]/.test(path) ? `'${path.replaceAll("'", `'\\''`)}'` : path;
}

/** The `denext migrate` command line that runs the checked migration. */
function migrateCommandLine(options: MigrateOptions): string {
  const parts = ["denext migrate"];
  if (options.from) parts.push(`--from ${options.from}`);
  if (options.desktop) parts.push("--desktop");
  if (options.backend) parts.push(`--backend ${options.backend}`);
  if (options.proxyPrefixes?.length) parts.push(`--proxy ${options.proxyPrefixes.join(",")}`);
  parts.push(...capacitorFlags(options));
  if (options.denextLocalPath) {
    const path = options.denextLocalPath;
    parts.push(`--denext-local-path ${shellPathArg(path, Deno.build.os)}`);
  }
  return parts.join(" ");
}

/** The `--enable-capacitor` flags of a migrate command line. */
function capacitorFlags(options: MigrateOptions): string[] {
  if (!options.capacitor) return [];
  return [
    "--enable-capacitor",
    ...(options.appId ? [`--app-id ${options.appId}`] : []),
    ...(options.platforms?.length ? [`--platform ${options.platforms.join(",")}`] : []),
  ];
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
      ...(r.tanstackStart ? ['tanstackStart() from "@denext/tanstack-start"'] : []),
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
  if (!n.evaluated && n.reason === NEXT_CONFIG_NEEDS_RUN) {
    // The check itself lacked run permission: the config may port fine, so say so.
    return {
      wont: [],
      review: [{
        item: n.file,
        reason: `${NEXT_CONFIG_NEEDS_RUN}; re-run the check with --allow-run to see which ` +
          "keys carry over (`denext migrate` itself evaluates it)",
      }],
    };
  }
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
      reason:
        `run \`denext task ${r.prisma.setupTask}\` once before \`denext task dev\` / \`build\``,
    });
    for (const w of r.prisma.warnings) out.push({ item: "prisma", reason: w });
  }
  for (const note of r.nextAuth?.notes ?? []) out.push({ item: "next-auth", reason: note });
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
    ...e.deps.nativeSdks.map((p) => ({
      item: p.name,
      reason: `native-only, with no alias in React Native mode; ${p.advice}`,
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
    ...e.mobile.manualLinks.map((reason) => ({ item: "deep links", reason })),
    ...e.mobile.manualPermissions.map((perm) => ({
      item: perm,
      reason: "an Android permission no capability declares; add it to AndroidManifest.xml",
    })),
    ...(e.tailwindInput
      ? [{
        item: e.tailwindInput,
        reason: "compile it with `tailwind: { input, output }` (uniwind runs built in: set " +
          "`reactNative.uniwind.extraThemes`, run `uniwind generate-artifacts`; NativeWind: the " +
          "guide's recipe)",
      }]
      : []),
  ];
  return { wont, review };
}

/** The Start options left behind, and the notes on the app's Start config. */
function tanstackStartFindings(r: MigrateResult): MigrateFinding[] {
  const t = r.tanstackStart;
  if (!t) return [];
  return [
    ...t.dropped.map((d) => ({ item: `${t.file}: ${d.key}`, reason: d.note })),
    ...t.notes.map((reason) => ({ item: t.file ?? "TanStack Start", reason })),
  ];
}

/** What a Fresh, Preact or Lustre app leaves to the user (the migration's findings). */
function freshFindings(r: MigrateResult): { wont: MigrateFinding[]; review: MigrateFinding[] } {
  const infos = [r.fresh, r.preact, r.lustre];
  return {
    wont: infos.flatMap((i) => i?.wontMigrate ?? []),
    review: infos.flatMap((i) => i?.review ?? []),
  };
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

/** File-emitting Vite plugins migrate could not carry into denext.config.ts. */
function viteEmitterFindings(r: MigrateResult): MigrateFinding[] {
  return r.spa?.viteEmitterReview ?? [];
}

/**
 * A Capacitor / Expo app with no icon to generate the native icons from, a small one, or an Expo
 * app whose icon is computed in code (so `mobile.icon` must be set by hand).
 */
function appIconFindings(r: MigrateResult): MigrateFinding[] {
  const icon = r.spa?.appIcon;
  if (!icon?.mobile) return [];
  const computed: MigrateFinding[] = icon.computedIcon
    ? [{
      item: "mobile.icon",
      reason: `${icon.computedIcon}${icon.recorded ? " (recorded as mobile.icon for now)" : ""}: ` +
        COMPUTED_ICON_FIX,
    }]
    : [];
  if (icon.icon) {
    const warning = icon.lines.find((l) =>
      l.startsWith("warning: ") && !l.includes(COMPUTED_ICON_FIX)
    );
    return [
      ...computed,
      ...(warning ? [{ item: `app icon ${icon.icon}`, reason: warning.slice(9) }] : []),
    ];
  }
  if (computed.length > 0) return computed;
  return [{
    item: "app icon",
    reason: "none found (no mobile.icon, Expo icon, web manifest icon, apple-touch-icon or PNG " +
      "favicon); add a 1024×1024 PNG and set `mobile.icon` to it in denext.config.ts, or the " +
      "native app keeps Capacitor's placeholder icon",
  }];
}

/** The Capacitor target's review items, or why `--enable-capacitor` did not apply. */
function capacitorFindings(r: MigrateResult): { wont: MigrateFinding[]; review: MigrateFinding[] } {
  if (r.capacitorSkipped) {
    return { wont: [{ item: "--enable-capacitor", reason: r.capacitorSkipped }], review: [] };
  }
  return { wont: [], review: r.capacitor?.review ?? [] };
}

/**
 * The lifecycle-script jail exceptions to review: each one written into deno.json (or a package.json
 * project's `"deno"` object; it widens the jail for that package) or left for the user to add.
 */
function jailFindings(r: MigrateResult): MigrateFinding[] {
  const j = r.jailScripts;
  if (j?.action !== "written" && j?.action !== "manual") return [];
  return j.missing.map((req) => ({
    item: `lifecycle-script jail: ${req.entry.name}`,
    reason:
      (j.action === "written"
        ? `exception ${JSON.stringify(req.exception)} written to ${j.home}`
        : `add the exception ${JSON.stringify(req.exception)} to ${j.home} by hand`) +
      `: ${req.entry.reason}`,
  }));
}

/**
 * The pnpm / Bun patches: each one carried into deno.json's `patchedDependencies` (or to add by
 * hand), and each one the runtime can't apply.
 */
function patchFindings(r: MigrateResult): MigrateFinding[] {
  const p = r.patches;
  if (!p) return [];
  return [
    ...p.carried.map((c) => ({
      item: `npm patch: ${c.key}`,
      reason: `${c.from} copied to ${c.to}${
        p.action === "manual" ? "; add it to deno.json's patchedDependencies by hand" : " and " +
          "registered in deno.json's patchedDependencies (the runtime applies it on install)"
      }`,
    })),
    ...p.review.map((c) => ({ item: `npm patch: ${c.key}`, reason: `${c.from}: ${c.reason}` })),
  ];
}

/** Every finding for a successful dry run, split into won't-migrate and review. */
function findings(r: MigrateResult): { wont: MigrateFinding[]; review: MigrateFinding[] } {
  const next = nextConfigFindings(r);
  const expo = expoFindings(r);
  const cap = capacitorFindings(r);
  const fresh = freshFindings(r);
  return {
    wont: [
      ...dependencyFindings(r),
      ...existingConfigFindings(r),
      ...next.wont,
      ...expo.wont,
      ...fresh.wont,
      ...cap.wont,
    ],
    review: [
      ...next.review,
      ...fresh.review,
      ...spaProxyFindings(r),
      ...viteEmitterFindings(r),
      ...transformFindings(r),
      ...tanstackStartFindings(r),
      ...expo.review,
      ...appIconFindings(r),
      ...cap.review,
      ...jailFindings(r),
      ...patchFindings(r),
    ],
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
    ...(r.capacitor ? { commands: r.capacitor.steps.map((s) => s.line) } : {}),
    wontMigrate: wont,
    review,
    ...(r.spa?.appIcon
      ? {
        appIcon: {
          icon: r.spa.appIcon.icon,
          kind: r.spa.appIcon.kind,
          ...(r.spa.appIcon.size ? { size: r.spa.appIcon.size } : {}),
          lines: r.spa.appIcon.lines,
        },
      }
      : {}),
    dependencies: {
      aliased: r.aliased,
      passthrough: r.passthrough,
      dropped: r.dropped,
      flagged: r.flagged,
    },
  };
}
