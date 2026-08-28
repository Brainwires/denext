// `migrate` (generate compat config for a Next.js or Vite-SPA app) and `codemod`
// (the standalone source-import rewrite half). Extracted verbatim from the 1.x
// `cli.ts` switch arms, now reading parsed flags instead of scanning `Deno.args`.

import { resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { migrateProject } from "../../build/migrate.ts";
import { runCodemod } from "../../build/codemod.ts";

/**
 * Print the codemod's planned source-import rewrites, then apply them — either
 * because `force` is set (`--yes`/`--write`), or after an interactive y/N confirm.
 * In a non-interactive shell without `force`, it stays a dry run and says so.
 */
async function applyCodemod(target: string, force: boolean): Promise<void> {
  const report = await runCodemod(target); // dry run — compute the plan first
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
  if (rewrites === 0) {
    console.log("  No next/*+react imports to rewrite.\n");
    return;
  }
  let apply = force;
  if (!apply) {
    if (Deno.stdin.isTerminal()) {
      apply = confirm(
        `  Rewrite these ${rewrites} import(s) to native denext?`,
      );
    } else {
      console.log(
        "  Dry run — re-run with --write (or `denext migrate --yes`) to apply.\n",
      );
      return;
    }
  }
  if (apply) {
    await runCodemod(target, { write: true });
    console.log(`  ✔ Rewrote ${rewrites} import(s).\n`);
  } else {
    console.log(
      "  Skipped — source left as-is (the compat alias still resolves next/*+react).\n",
    );
  }
}

export const migrateCommand: CommandSpec = {
  name: "migrate",
  summary: "Migrate a Next.js, Vite, CRA, or React app (config files)",
  positionals: [{ name: "dir", help: "App directory to migrate (default: .)" }],
  flags: [
    {
      name: "from",
      type: "string",
      valueName: "<framework>",
      help: "Force source: next | vite | cra | generic",
    },
    { name: "desktop", type: "boolean", help: "Also scaffold a desktop entry" },
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
    console.log(`\n  denext migrate  ▸  ${target}\n`);
    const desktop = ctx.flags.desktop === true;
    const proxyCsv = ctx.flags.proxy as string | undefined;
    const r = await migrateProject(target, {
      desktop,
      backend: ctx.flags.backend as string | undefined,
      from: ctx.flags.from as string | undefined,
      proxyPrefixes: proxyCsv
        ? proxyCsv.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      denextLocalPath: ctx.flags["denext-local-path"] as string | undefined,
    });
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

    if (
      (r.kind === "spa" || r.kind === "cra" || r.kind === "generic") && r.spa
    ) {
      const s = r.spa;
      console.log(
        `  ▸ ${r.kind.toUpperCase()} detected — wrote denext.config.ts (mode: "spa").`,
      );
      console.log(
        `    entry ${s.entry} · title ${
          JSON.stringify(s.title)
        } · nodeModulesDir ${s.nodeModulesDir}`,
      );
      console.log(
        `    spa.env keys (${s.envKeys.length}): ${s.envKeys.join(", ") || "—"}`,
      );
      console.log(`    tailwind: ${s.tailwind ? "detected" : "not detected"}`);
      if (desktop) {
        const proxyNote = s.proxy
          ? `proxy ${s.proxy.prefixes.join(",")} → ${s.proxy.target}`
          : "no backend proxy (pass --backend <url> [--proxy /api,/ws])";
        console.log(
          `    desktop: ${
            s.desktopWritten ? "wrote desktop.ts" : "desktop.ts exists"
          } · ${proxyNote}`,
        );
        console.log(
          `    icon: ${s.desktopIcon ? "auto-detected" : "none (deno desktop default)"}` +
            " — override any time via `spa.desktop.icon` in denext.config.ts",
        );
      }
    } else if (r.pagesRouter) {
      console.log(
        "  ▸ pages/ router detected — wired the @denext/pages-router plugin (added to deno.json).",
      );
      if (r.pagesConfigWritten) {
        console.log(
          "    wrote denext.config.ts with `plugins: [pagesRouter()]`.",
        );
      } else if (r.pagesConfigExists) {
        console.log(
          "    ⚠️  denext.config.ts already exists — add `pagesRouter()` from " +
            '"@denext/pages-router" to its `plugins` array.',
        );
      }
    }

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
