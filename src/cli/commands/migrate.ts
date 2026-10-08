// `migrate` (generate compat config for a Next.js or Vite-SPA app) and `codemod`
// (the standalone source-import rewrite half). Extracted verbatim from the 1.x
// `cli.ts` switch arms, now reading parsed flags instead of scanning `Deno.args`.

import { resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { type AppIconReport, type MigrateOptions, migrateProject } from "../../build/migrate.ts";
import {
  checkMigration,
  type MigrateCheckReport,
  type MigrateFinding,
} from "../../build/migrate-check.ts";
import { runCodemod } from "../../build/codemod.ts";
import {
  type CapacitorMigrateInfo,
  type CapacitorStepsOutcome,
  runCapacitorSteps,
} from "../../build/migrate-capacitor.ts";
import type { CommandRunner } from "../../build/mobile-capabilities.ts";

/**
 * Print the codemod's planned source-import rewrites, then apply them — either
 * because `force` is set (`--yes`/`--write`), or after an interactive y/N confirm.
 * In a non-interactive shell without `force`, it stays a dry run and says so.
 */
async function applyCodemod(target: string, force: boolean): Promise<void> {
  const report = await runCodemod(target); // dry run — compute the plan first
  const rewrites = printCodemodPlan(report);
  if (rewrites === 0) {
    console.log("  No next/*+react imports to rewrite.\n");
    return;
  }
  const apply = force || confirmCodemod(rewrites);
  if (apply === null) return; // non-interactive dry run (already explained)
  if (apply) {
    await runCodemod(target, { write: true });
    console.log(`  ✔ Rewrote ${rewrites} import(s).\n`);
  } else {
    console.log(
      "  Skipped — source left as-is (the compat alias still resolves next/*+react).\n",
    );
  }
}

/** Print every planned rewrite + warning per file; returns the rewrite count. */
function printCodemodPlan(
  report: Awaited<ReturnType<typeof runCodemod>>,
): number {
  let rewrites = 0;
  let warnings = 0;
  for (const f of report.files) {
    if (f.rewrites.length === 0 && f.warnings.length === 0) continue;
    console.log(`  ${f.path}`);
    for (const r of f.rewrites) {
      rewrites++;
      console.log(`    ${r.from} → ${r.to}${r.note ? `  (${r.note})` : ""}`);
    }
    for (const w of f.warnings) {
      warnings++;
      console.log(`    ⚠️  ${w.specifier}: ${w.message}`);
    }
  }
  console.log(
    `\n  ${rewrites} import rewrite(s), ${warnings} warning(s) across ${report.files.length} file(s) (of ${report.scanned} scanned).`,
  );
  return rewrites;
}

/**
 * Ask whether to apply the plan. On a TTY this is an interactive y/N; in a
 * non-interactive shell it stays a dry run, says so, and returns null.
 */
function confirmCodemod(rewrites: number): boolean | null {
  if (Deno.stdin.isTerminal()) {
    return confirm(`  Rewrite these ${rewrites} import(s) to native denext?`);
  }
  console.log(
    "  Dry run — re-run with --write (or `denext migrate --yes`) to apply.\n",
  );
  return null;
}

type MigrateResult = Awaited<ReturnType<typeof migrateProject>>;

/** The dependency summary every migration prints. */
function reportDeps(r: MigrateResult): void {
  for (const f of r.wrote) console.log(`  Wrote ${f}`);
  console.log(
    `  - aliased to denext (${r.aliased.length}): ${r.aliased.join(", ") || "—"}`,
  );
  console.log(
    `  - npm passthrough (${r.passthrough.length}): ${r.passthrough.join(", ") || "—"}`,
  );
  console.log(
    `  - dropped (${r.dropped.length}): ${r.dropped.join(", ") || "—"}`,
  );
  if (r.flagged.length) {
    console.log(`  ⚠️  unsupported native deps: ${r.flagged.join(", ")}`);
  }
}

/** What a SPA/CRA/generic migration wrote (mode "spa", optional desktop entry). */
function reportSpa(r: MigrateResult, desktop: boolean): void {
  const s = r.spa!;
  console.log(
    `  ▸ ${r.kind.toUpperCase()} detected — wrote denext.config.ts (mode: "spa").`,
  );
  console.log(
    `    entry ${s.entry} · title ${JSON.stringify(s.title)} · nodeModulesDir ${s.nodeModulesDir}`,
  );
  console.log(
    `    spa.env keys (${s.envKeys.length}): ${s.envKeys.join(", ") || "—"}`,
  );
  console.log(
    `    tailwind: ${s.tailwindInput ? `detected (${s.tailwindInput})` : "not detected"}` +
      (s.rootId ? ` · mount #${s.rootId}` : ""),
  );
  reportAppIcon(s.appIcon);
  if (!desktop) return;
  const proxyNote = s.proxy
    ? `proxy ${s.proxy.prefixes.join(",")} → ${s.proxy.target}`
    : "no backend proxy (pass --backend <url> [--proxy /api,/ws])";
  console.log(
    `    desktop: ${s.desktopWritten ? "wrote desktop.ts" : "desktop.ts exists"} · ${proxyNote}`,
  );
  if (s.proxyUnresolved) {
    console.log(
      `    ⚠ ${s.proxyUnresolved} builds its proxy in code, so its prefixes could not be read;` +
        " re-run with --proxy listing every backend prefix (e.g. --proxy /api,/ws)",
    );
  }
  console.log(
    s.desktopIcon
      ? "    icon: auto-detected (--icon wired) — override via `spa.desktop.icon`" +
        " in denext.config.ts, then rebuild"
      : "    icon: none (deno desktop default) — set `spa.desktop.icon` in" +
        " denext.config.ts, then re-run migrate to wire --icon",
  );
}

/** The app icon migrate found for `denext mobile assets` / `mobile build`, and where it went. */
function reportAppIcon(icon: AppIconReport | undefined): void {
  if (!icon) return;
  const where = icon.recorded
    ? " — recorded as `mobile.icon` in denext.config.ts"
    : icon.icon && icon.kind !== "config"
    ? " — denext.config.ts was kept, so set `mobile.icon` there to pin it"
    : "";
  const [first, ...rest] = icon.lines;
  console.log(`    ${first}${where}`);
  for (const line of rest) console.log(`      ${line}`);
}

/** What the Remix route-tree transform did. */
function reportRemix(m: NonNullable<MigrateResult["remix"]>): void {
  console.log(
    "  ▸ Remix detected — route tree transformed to run on the denext/remix runtime.",
  );
  console.log(
    `    routes converted: ${m.routesConverted}` +
      (m.rootConverted ? " · app/root.tsx → app/layout.tsx" : "") +
      ` · loaders: ${m.loaders}, actions: ${m.actions} (preserved & wired)`,
  );
  console.log(
    "    each route → a server wrapper + a client component + a server data module " +
      "(loader/action run on denext).",
  );
  if (m.entriesDeleted.length) {
    console.log(`    removed: ${m.entriesDeleted.join(", ")}`);
  }
  printReviewNotes(m.warnings, 12);
  console.log(
    "    `useLoaderData`/`useActionData`/`<Form>`/navigation map to denext primitives — " +
      "the app should run; review any notes above.",
  );
}

/** Up to `max` review notes (and a count of the rest); nothing when there are none. */
function printReviewNotes(warnings: string[], max: number): void {
  if (warnings.length === 0) return;
  console.log(`    ⚠️  review notes (${warnings.length}):`);
  for (const w of warnings.slice(0, max)) console.log(`      · ${w}`);
  if (warnings.length > max) {
    console.log(`      · …and ${warnings.length - max} more`);
  }
}

/** The pages/ router plugin wiring. */
function reportPagesRouter(r: MigrateResult): void {
  console.log(
    "  ▸ pages/ router detected — wired the @denext/pages-router plugin (added to deno.json).",
  );
  if (r.pagesConfigWritten) {
    console.log("    wrote denext.config.ts with `plugins: [pagesRouter()]`.");
  } else if (r.pagesConfigExists) {
    console.log(
      "    ⚠️  denext.config.ts already exists — add `pagesRouter()` from " +
        '"@denext/pages-router" to its `plugins` array.',
    );
  }
}

/** The app uses `effect` → migrate mapped @denext/effect; the plugin is written only when no denext.config.ts existed. */
function reportEffect(r: MigrateResult): void {
  console.log(
    "  ▸ effect detected — mapped @denext/effect (bridge for runEffect/effectHandler/DenextRequest).",
  );
  console.log(
    r.pagesConfigExists
      ? '    ⚠️  denext.config.ts already exists — add `effect()` from "@denext/effect" to its ' +
        "`plugins` array (pass your app Layer: `effect({ layer: AppLayer })`)."
      : "    wired the effect() plugin (empty layer) into denext.config.ts — add your app " +
        "Layer via `effect({ layer: AppLayer })`.",
  );
}

/** The Prisma rewiring (ESM/Deno client + better-sqlite3 driver adapter). */
function reportPrisma(p: NonNullable<MigrateResult["prisma"]>): void {
  console.log(
    "  ▸ Prisma detected — wired to the ESM/Deno client + better-sqlite3 driver adapter " +
      "(no native Rust engine).",
  );
  console.log(
    `    schema generator → prisma-client (deno) · ${p.refsRewritten.length} @prisma/client ` +
      `import(s) repointed · adapter injected in ${p.clientModules.length} module(s)` +
      (p.packageJsonEdited ? " · dropped @prisma/client+prisma from package.json" : ""),
  );
  printReviewNotes(p.warnings, 8);
  console.log(
    `    ‼️  run \`deno task ${p.setupTask}\` ONCE (bundles the compat, installs, ` +
      "`prisma generate` + `db push`) before `deno task build`/`dev`.",
  );
}

/** The Expo app config's static reading: where from, what it could not read. */
function reportExpoConfig(e: NonNullable<MigrateResult["expo"]>): void {
  console.log(
    `    app config: ${e.config.source ?? "none found"} (read statically — project code is ` +
      "never run)",
  );
  if (e.config.unresolved.length) {
    console.log(
      `    ⚠️  not statically readable (computed in code): ${e.config.unresolved.join(", ")}`,
    );
  }
  for (const note of e.config.notes) console.log(`    · ${note}`);
  if (e.generatedEntry) {
    console.log(
      `    wrote ${e.generatedEntry.path}: ` +
        (e.generatedEntry.kind === "expo-router"
          ? "expo-router's web entry, without Metro's runtime"
          : "Expo's default entry (expo/AppEntry) mounts ./App"),
    );
  }
  if (e.metro.extraModules.length) {
    console.log(
      `    ⚠️  ${e.metro.file} maps modules Metro alone provides (extraNodeModules): ` +
        `${e.metro.extraModules.join(", ")} — map each in deno.json "imports".`,
    );
  }
  if (e.metro.resolveRequest) {
    console.log(
      `    ⚠️  ${e.metro.file} sets a custom resolveRequest, which the denext build does not ` +
        'run: carry its redirects over as deno.json "imports".',
    );
  }
  if (e.expoRouter) {
    console.log(
      "    expo-router: React Native mode generates its route context from app/ (Metro's " +
        "require.context is not needed); routes, deep links and <Link> work as on Expo web.",
    );
  }
}

/** The `expo-*` shim status and the native-only packages. */
function reportExpoDeps(d: NonNullable<MigrateResult["expo"]>["deps"]): void {
  const shimmed = d.expo.filter((p) => p.status !== "none");
  const plain = d.expo.filter((p) => p.status === "none");
  console.log(
    `  ▸ expo-* packages (${d.expo.length}): ${shimmed.length} resolve to denext/expo shims` +
      (plain.length ? `; ${plain.length} resolve to the real package` : ""),
  );
  for (const p of shimmed) console.log(`      ${p.name.padEnd(24)} ${shimLine(p)}`);
  for (const p of plain) {
    console.log(
      `      ${p.name.padEnd(24)} ` +
        (p.advice
          ? `⚠️  no shim: ${p.advice}`
          : "no shim (the real package, which must have a web build)"),
    );
  }
  reportCommunityDeps(d.community);
  if (d.nativeOnly.length) {
    console.log(`  ⚠️  native-only packages, no web build (${d.nativeOnly.length}):`);
    for (const p of d.nativeOnly) console.log(`      ${p.name} — ${p.kind}`);
    console.log(
      "      Their native parts do not exist in a WebView: some load and do nothing (their JS " +
        "tolerates the missing module), others throw when used. Give each importing module a " +
        '.web.ts, or map the package to a web stub in deno.json "imports".',
    );
  }
  if (d.notInstalled.length) {
    console.log(`    not installed, so not classified: ${d.notInstalled.join(", ")}`);
  }
}

/** How many omitted exports a status line names before it counts the rest. */
const NAMED_OMISSIONS = 6;

/** An `expo-*` shim's status line: the status, what it omits (by name), and its shimmed subpaths. */
function shimLine(p: NonNullable<MigrateResult["expo"]>["deps"]["expo"][number]): string {
  const named = p.omittedExports.slice(0, NAMED_OMISSIONS).join(", ");
  const more = p.omitted > NAMED_OMISSIONS ? `, +${p.omitted - NAMED_OMISSIONS} more` : "";
  const omitted = p.omitted ? ` (${p.omitted} export(s) not provided: ${named}${more})` : "";
  const subpaths = p.subpaths ? ` — shims for ${p.subpaths.join(", ")}; the rest is real` : "";
  return `${p.status}${omitted}${subpaths}`;
}

/** The community packages React Native mode replaces with denext implementations. */
function reportCommunityDeps(
  community: NonNullable<MigrateResult["expo"]>["deps"]["community"],
): void {
  if (community.length === 0) return;
  console.log(
    `  ▸ community packages React Native mode replaces (${community.length}; ` +
      '`reactNative: { aliases: { "<package>": false } }` keeps the real one):',
  );
  for (const p of community) {
    const omitted = p.omitted ? `, ${p.omitted} export(s) not provided` : "";
    console.log(`      ${p.name.padEnd(24)} → ${p.implementation} (${p.status}${omitted})`);
  }
}

/** An Expo app's next steps (with --enable-capacitor, the install and `cap add` are its steps). */
function expoNextSteps(e: NonNullable<MigrateResult["expo"]>, capacitor: boolean): string[] {
  return [
    ...(e.missingPackages.length ? [`install ${e.missingPackages.join(" ")}`] : []),
    ...(capacitor ? [] : [
      "install @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android (^8)",
      "deno task export && npx cap add ios && npx cap add android",
    ]),
    ...(e.mobile.command ? [e.mobile.command] : []),
  ];
}

/** The Capacitor shell and the next steps. */
function reportExpoShell(e: NonNullable<MigrateResult["expo"]>, capacitor: boolean): void {
  const c = e.capacitor;
  console.log(
    `  ▸ Capacitor shell: ${c.configWritten ? "wrote" : "kept"} capacitor.config.ts — appId ` +
      `${c.appId}${c.placeholderId ? " (placeholder: set it)" : ""} · appName ` +
      JSON.stringify(c.appName),
  );
  if (e.prebuildFolders.length) {
    console.log(
      `    ⚠️  ${e.prebuildFolders.join("/ and ")}/ exist (Expo prebuild output): Capacitor ` +
        "creates its own — move them aside before `npx cap add`.",
    );
  }
  const steps = expoNextSteps(e, capacitor);
  console.log("    next steps:");
  steps.forEach((step, i) => console.log(`      ${i + 1}. ${step}`));
  for (const c2 of e.mobile.capabilities) console.log(`         · ${c2.capability}: ${c2.because}`);
  const plist = Object.entries(e.mobile.manualPlist);
  if (plist.length) {
    console.log(
      "    the app's iOS usage strings — `mobile add app-config` writes them into " +
        "ios/App/App/Info.plist (each only when the key is absent; a computed one by hand):",
    );
    for (const [k, v] of plist) {
      console.log(`      ${k} = ${v === null ? "(computed in code)" : JSON.stringify(v)}`);
    }
  }
  if (e.mobile.manualPermissions.length) {
    console.log(
      "    Android permissions `mobile add app-config` declares in AndroidManifest.xml: " +
        e.mobile.manualPermissions.join(", "),
    );
  }
  e.mobile.manualLinks.forEach((item) => console.log(`    ${item}`));
  for (const { plugin, note } of e.mobile.unmappedPlugins) {
    console.log(`    config plugin ${plugin}: ${note}`);
  }
  if (e.tailwindInput) {
    console.log(
      `    Tailwind (${e.tailwindInput}): uniwind / NativeWind styling needs the guide's ` +
        "uniwind recipe; it is not wired automatically.",
    );
  }
}

/** What an Expo migration wrote and found. */
function reportExpo(r: MigrateResult): void {
  const s = r.spa!;
  const e = r.expo!;
  console.log(
    '  ▸ Expo app detected — wrote denext.config.ts (mode: "spa", reactNative: true).',
  );
  console.log(
    `    entry ${s.entry} · title ${JSON.stringify(s.title)} · nodeModulesDir ${s.nodeModulesDir}`,
  );
  reportExpoConfig(e);
  reportAppIcon(s.appIcon);
  reportExpoDesktop(e.desktopPackages);
  reportExpoDeps(e.deps);
  reportExpoShell(e, r.capacitor !== undefined);
}

/** The React Native desktop package(s) the app's `react-native` imports resolve as. */
function reportExpoDesktop(packages: readonly string[]): void {
  if (packages.length === 1) {
    console.log(
      `  ▸ ${packages[0]}: reactNative.desktopPackage resolves the app's \`react-native\` ` +
        "imports as it (as Metro does), so its View props and additions resolve.",
    );
  } else if (packages.length > 1) {
    console.log(
      `  ▸ ${packages.join(" and ")}: pick one as reactNative.desktopPackage in ` +
        "denext.config.ts (commented there) for the app's `react-native` imports.",
    );
  }
}

/** The framework-specific section of the report, if any. */
function reportFramework(r: MigrateResult, desktop: boolean): void {
  if (r.kind === "expo" && r.expo) {
    reportExpo(r);
  } else if ((r.kind === "spa" || r.kind === "cra" || r.kind === "generic") && r.spa) {
    reportSpa(r, desktop);
  } else if (r.kind === "remix" && r.remix) {
    reportRemix(r.remix);
  } else if (r.pagesRouter) {
    reportPagesRouter(r);
  }
}

/** The migration options the parsed flags select. */
function migrateOptions(ctx: CommandContext): MigrateOptions {
  const proxyCsv = ctx.flags.proxy as string | undefined;
  return {
    desktop: ctx.flags.desktop === true,
    backend: ctx.flags.backend as string | undefined,
    from: ctx.flags.from as string | undefined,
    proxyPrefixes: proxyCsv ? proxyCsv.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    denextLocalPath: ctx.flags["denext-local-path"] as string | undefined,
    capacitor: ctx.flags["enable-capacitor"] === true,
    appId: ctx.flags["app-id"] as string | undefined,
    platforms: listFlag(ctx.flags.platform),
  };
}

/** A comma-separated list flag (`--platform ios,android`), undefined when absent. */
function listFlag(value: string | number | boolean | undefined): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const items = value.split(",").map((v) => v.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

/** The Capacitor target: the config, the review items (printed before the steps run). */
function reportCapacitor(c: CapacitorMigrateInfo): void {
  const config = c.configWritten
    ? "wrote capacitor.config.ts"
    : `kept ${c.existingConfig ?? "capacitor.config.ts"}`;
  console.log(
    `  ▸ Capacitor: ${config} — appId ${c.appId} (${c.appIdSource}) · appName ` +
      `${JSON.stringify(c.appName)} · webDir ${c.webDir}`,
  );
  console.log(
    "    tasks: mobile:sync · mobile:ios · mobile:android · mobile:build:ios · " +
      "mobile:build:android",
  );
  if (c.review.length) {
    console.log(`    ⚠️  review (${c.review.length}):`);
    for (const f of c.review) console.log(`      · ${f.item}: ${f.reason}`);
  }
}

/** What running the Capacitor steps did, and what is left to run by hand. */
function reportCapacitorSteps(outcome: CapacitorStepsOutcome): void {
  for (const line of outcome.ran) console.log(`    ran: ${line}`);
  if (outcome.failed) {
    console.log(`    ✗ failed (exit ${outcome.failed.code}): ${outcome.failed.line}`);
  }
  if (outcome.pending.length) {
    console.log("    still to run:");
    for (const p of outcome.pending) console.log(`      ${p.line}    # ${p.reason}`);
  }
}

/** Run the Capacitor steps (human mode prints as it goes; JSON mode returns the outcome). */
async function capacitorSteps(
  r: MigrateResult,
  run: CommandRunner,
  json: boolean,
): Promise<CapacitorStepsOutcome | undefined> {
  if (!r.capacitor) {
    if (r.capacitorSkipped && !json) {
      console.log(`  ⚠️  --enable-capacitor not applied: ${r.capacitorSkipped}`);
    }
    return undefined;
  }
  if (!json) reportCapacitor(r.capacitor);
  const outcome = await runCapacitorSteps(r.capacitor.steps, run);
  if (!json) reportCapacitorSteps(outcome);
  return outcome;
}

/** Print a list of findings under a heading (nothing when empty). */
function printFindings(heading: string, list: MigrateFinding[]): void {
  if (list.length === 0) return;
  console.log(`\n  ${heading} (${list.length}):`);
  for (const f of list) console.log(`    · ${f.item}: ${f.reason}`);
}

/** The commands a check says migrate would run (nothing when there are none). */
function printCommands(commands: string[]): void {
  if (commands.length === 0) return;
  console.log(`\n  would run (${commands.length}):`);
  for (const line of commands) console.log(`    ${line}`);
}

/** The human-readable `migrate --check` report. */
function printCheck(report: MigrateCheckReport): void {
  console.log(`\n  denext migrate --check  ▸  ${report.target}\n`);
  if (report.verdict === "blocked") {
    console.log(`  ✗ blocked: ${report.error}\n`);
    return;
  }
  console.log(`  source: ${report.source}`);
  console.log(`\n  would change (${report.changes.length}):`);
  for (const c of report.changes) {
    console.log(`    ${c.action.padEnd(6)} ${c.path}${c.from ? `  (from ${c.from})` : ""}`);
  }
  printCommands(report.commands ?? []);
  const d = report.dependencies!;
  console.log(
    `\n  dependencies: ${d.aliased.length} aliased to denext · ${d.passthrough.length} npm ` +
      `passthrough · ${d.dropped.length} dropped · ${d.flagged.length} unsupported`,
  );
  if (report.appIcon) {
    console.log("\n  app icon (for `denext mobile assets` / `mobile build`):");
    for (const line of report.appIcon.lines) console.log(`    ${line}`);
  }
  printFindings("won't migrate", report.wontMigrate);
  printFindings("review", report.review);
  const verdict = report.verdict === "ready"
    ? "ready: nothing is left to do by hand"
    : "ready with findings: the migration runs; review the items above";
  console.log(`\n  verdict: ${verdict}`);
  console.log(`  Nothing was written. To migrate: ${report.command}\n`);
}

/** Why a Remix app's `--check --codemod` plan names files at their pre-migration paths. */
const REMIX_CODEMOD_NOTE = "the codemod plan lists files at their current paths; migrate " +
  "first moves the Remix route modules, and the real run rewrites them at their new paths";

/**
 * `migrate --check`: run the migration as a dry run and report it. Exits 1 when the migration
 * would fail. With `--codemod`, the source-import rewrite plan is reported too (dry run).
 */
async function runCheck(
  target: string,
  options: MigrateOptions,
  json: boolean,
  codemod: boolean,
): Promise<void> {
  const report = await checkMigration(target, options);
  const plan = codemod && report.verdict !== "blocked" ? await runCodemod(target) : undefined;
  // The codemod plan reads the tree as it is now; a Remix migration first moves and rewrites
  // the route modules, so its paths are the pre-migration ones (the real run rewrites the moved
  // files at their new paths).
  const codemodNote = plan && report.source === "remix" ? REMIX_CODEMOD_NOTE : undefined;
  if (json) console.log(JSON.stringify(checkJson(report, plan, codemodNote), null, 2));
  else {
    printCheck(report);
    if (plan) printCheckCodemod(plan, codemodNote);
  }
  if (report.verdict === "blocked") Deno.exit(1);
}

/** The `--check --json` document: the report, plus the codemod plan (and note) with --codemod. */
function checkJson(
  report: MigrateCheckReport,
  plan: Awaited<ReturnType<typeof runCodemod>> | undefined,
  note: string | undefined,
): unknown {
  if (!plan) return report;
  return { ...report, codemod: plan, ...(note ? { codemodNote: note } : {}) };
}

/** The `--check --codemod` plan in the human report, with the Remix note when there is one. */
function printCheckCodemod(
  plan: Awaited<ReturnType<typeof runCodemod>>,
  note: string | undefined,
): void {
  console.log("  With --codemod, these source imports would be rewritten:\n");
  printCodemodPlan(plan);
  if (note) console.log(`\n  Note: ${note}`);
  console.log("");
}

/**
 * Run a planned command with the terminal attached, resolving its exit code. `toStderr` sends
 * its stdout to stderr, so `migrate --json` keeps stdout for the JSON document.
 */
function terminalRunner(toStderr: boolean): CommandRunner {
  return async ({ cmd, args, cwd }) => {
    const child = new Deno.Command(cmd, {
      args: [...args],
      cwd,
      stdin: "inherit",
      stdout: toStderr ? "piped" : "inherit",
      stderr: "inherit",
    }).spawn();
    if (toStderr) await child.stdout.pipeTo(Deno.stderr.writable, { preventClose: true });
    const { code } = await child.status;
    return { code };
  };
}

/**
 * The `migrate` command. `run` runs the commands `--enable-capacitor` plans (the package
 * install, the export and `npx cap add`); tests pass a recorder. By default they run with the
 * terminal attached.
 */
export function createMigrateCommand(run?: CommandRunner): CommandSpec {
  return {
    name: "migrate",
    summary: "Migrate a Next.js, Remix, Vite, CRA, Expo, or React app (config files)",
    positionals: [{ name: "dir", help: "App directory to migrate (default: .)" }],
    flags: [
      {
        name: "from",
        type: "string",
        valueName: "<framework>",
        help: "Force source: next | remix | vite | cra | generic | expo",
      },
      {
        name: "check",
        type: "boolean",
        help: "Report what migrate would change and what won't migrate; writes nothing " +
          "(needs read access, plus --allow-run to evaluate next.config; add --json for the " +
          "machine-readable report)",
      },
      { name: "desktop", type: "boolean", help: "Also scaffold a desktop entry" },
      {
        name: "enable-capacitor",
        type: "boolean",
        help: "Also add an iOS/Android Capacitor target: capacitor.config.ts, the mobile:* tasks " +
          "and config keys, and install the pinned Capacitor 8 packages (SPA, App Router, Expo)",
      },
      {
        name: "app-id",
        type: "string",
        valueName: "<id>",
        help: "With --enable-capacitor: the app id (reverse-DNS, e.g. com.example.app); else " +
          "derived from the desktop identifier or the package name",
      },
      {
        name: "platform",
        type: "string",
        valueName: "<ios,android>",
        help: "With --enable-capacitor: export, then run `npx cap add` for these platforms",
      },
      {
        name: "backend",
        type: "string",
        valueName: "<url>",
        help: "Backend URL for SPA proxy",
      },
      {
        name: "proxy",
        type: "string",
        valueName: "<paths>",
        help: "Comma-separated proxy prefixes",
      },
      {
        name: "codemod",
        type: "boolean",
        help: "Also rewrite source imports to native denext",
      },
      {
        name: "yes",
        alias: "y",
        type: "boolean",
        help: "Apply the codemod without prompting",
      },
      {
        name: "denext-local-path",
        type: "string",
        valueName: "<path>",
        help: "Point the generated config at a LOCAL denext checkout (file://) instead of JSR — " +
          "for testing an unreleased/dev denext against a real app",
      },
    ],
    run: async (ctx: CommandContext) => {
      const target = resolve(ctx.global.cwd ?? ctx.positionals[0] ?? ".");
      const json = ctx.global.json;
      const options = migrateOptions(ctx);
      if (ctx.flags.check === true) {
        await runCheck(target, options, json === true, ctx.flags.codemod === true);
        return;
      }
      if (!json) console.log(`\n  denext migrate  ▸  ${target}\n`);
      const desktop = options.desktop === true;
      const r = await migrateProject(target, options);
      if (json) {
        // Machine-readable: the result object only (no banner, no prompts). `--codemod`
        // applies with `--yes`, else reports its plan as a dry run. The Capacitor steps'
        // output goes to the terminal; their outcome is in the JSON.
        const capacitorRun = await capacitorSteps(r, run ?? terminalRunner(true), true);
        const codemod = ctx.flags.codemod === true
          ? await runCodemod(target, { write: ctx.flags.yes === true })
          : undefined;
        console.log(JSON.stringify({ target, ...r, capacitorRun, codemod }, null, 2));
        return;
      }
      reportDeps(r);
      reportFramework(r, desktop);
      if (r.effect) reportEffect(r);
      if (r.prisma) reportPrisma(r.prisma);
      await capacitorSteps(r, run ?? terminalRunner(false), false);

      if (r.denoJsonExists) {
        console.log(
          "\n  ⚠️  deno.json already exists (hand-authored) — left untouched. Merge the " +
            "generated import map + tasks into it by hand, or remove it and re-run migrate.",
        );
      }

      // Migrate creates config files only. Source rewriting is opt-in via `--codemod`
      // (imports otherwise resolve through the generated alias map).
      if (ctx.flags.codemod === true) {
        console.log("\n  Rewriting source imports to native denext:\n");
        await applyCodemod(target, ctx.flags.yes === true);
      } else {
        console.log(
          "\n  Source unchanged (imports resolve via the alias map). " +
            "Run `denext migrate --codemod` to rewrite to native denext.",
        );
      }
      console.log(
        "  Next: `deno install` (or ensure node_modules), then `deno task dev`.\n",
      );
    },
  };
}

export const migrateCommand: CommandSpec = createMigrateCommand();

export const codemodCommand: CommandSpec = {
  name: "codemod",
  summary: "(advanced) Rewrite next/*+react imports to native denext",
  positionals: [{ name: "dir", help: "App directory (default: .)" }],
  flags: [{
    name: "write",
    type: "boolean",
    help: "Apply without prompting (CI)",
  }],
  run: async (ctx) => {
    // The source-rewrite half of `migrate`, standalone (advanced). `--write` applies
    // without a prompt (CI); otherwise it confirms interactively.
    const target = resolve(ctx.global.cwd ?? ctx.positionals[0] ?? ".");
    console.log(`\n  denext codemod  ▸  ${target}\n`);
    await applyCodemod(target, ctx.flags.write === true);
  },
};
