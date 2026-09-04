// Deploy adapters: the engine behind `denext deploy`. A `DeployAdapter` turns a
// built denext app into a deployed one for a given provider. The first-party
// adapter targets Deno Deploy by wrapping `deployctl` (Deno's own deploy tool) —
// the reliably-correct path, since a denext app's server is produced by the build
// toolchain (which can't be imported into a zero-npm runtime entry). Third parties
// register more adapters through the plugin surface.
//
// Build-time only; never imported by a shipped bundle.

import { join } from "@std/path";

/** What an adapter needs to deploy a built app. */
export interface DeployTarget {
  /** Absolute project root. */
  readonly projectDir: string;
  /** Server/static entrypoint to deploy (resolved by the CLI). */
  readonly entrypoint: string;
  /** Deploy to production (vs a preview). */
  readonly prod: boolean;
  /** Provider project/site name, when the provider needs one. */
  readonly project?: string;
  /** Print the plan instead of executing it. */
  readonly dryRun: boolean;
  /** Extra provider args forwarded verbatim. */
  readonly args: string[];
}

/** A deployment provider. */
export interface DeployAdapter {
  /** Provider id (e.g. `"deno-deploy"`). */
  readonly name: string;
  /** One-line description for `--help`/listing. */
  readonly summary: string;
  /** Deploy the target (or print the plan when `target.dryRun`). */
  deploy(target: DeployTarget): Promise<void>;
}

/** Candidate server-entry filenames, in priority order, for auto-detection. */
export const ENTRY_CANDIDATES = ["deploy.ts", "main.ts", "server.ts", "serve.ts", "app.ts"];

/** The first existing entry-candidate in `dir`, or null. */
export async function detectEntrypoint(dir: string): Promise<string | null> {
  for (const name of ENTRY_CANDIDATES) {
    try {
      if ((await Deno.stat(join(dir, name))).isFile) return name;
    } catch { /* next */ }
  }
  return null;
}

/**
 * The Deno Deploy adapter: `deployctl deploy` via `deno run -A jsr:@deno/deployctl`,
 * with the resolved entrypoint, optional `--project`/`--prod`, and forwarded args.
 * In dry-run it prints the exact command instead of running it. Auth comes from the
 * user's `DENO_DEPLOY_TOKEN`/`deployctl` login — denext never handles the token.
 */
export const denoDeployAdapter: DeployAdapter = {
  name: "deno-deploy",
  summary: "Deploy to Deno Deploy (wraps deployctl)",
  deploy: async (target) => {
    const args = ["run", "-A", "jsr:@deno/deployctl", "deploy"];
    if (target.project) args.push("--project", target.project);
    if (target.prod) args.push("--prod");
    args.push("--entrypoint", target.entrypoint, ...target.args);

    if (target.dryRun) {
      console.log("  [dry-run] would run:\n    deno " + args.join(" "));
      console.log(`  in ${target.projectDir}`);
      return;
    }

    const child = new Deno.Command("deno", {
      args,
      cwd: target.projectDir,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const { code } = await child.status;
    if (code !== 0) throw new Error(`denext: deploy failed (deployctl exited ${code})`);
  },
};

/** The built-in adapter registry, keyed by name. */
const ADAPTERS = new Map<string, DeployAdapter>([[denoDeployAdapter.name, denoDeployAdapter]]);

/** Resolve an adapter by name; defaults to Deno Deploy. Throws on an unknown name. */
export function resolveAdapter(name?: string): DeployAdapter {
  const adapter = ADAPTERS.get(name ?? denoDeployAdapter.name);
  if (!adapter) {
    throw new Error(
      `denext: unknown deploy provider "${name}". Known: ${[...ADAPTERS.keys()].join(", ")}.`,
    );
  }
  return adapter;
}

/** All registered adapters (for listing). */
export function listAdapters(): DeployAdapter[] {
  return [...ADAPTERS.values()];
}
