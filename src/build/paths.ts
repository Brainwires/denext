// Resolve the conventional paths and config for a denext project directory.

import { join } from "@std/path";
import { frameworkRoot } from "./bundle.ts";

export interface ProjectPaths {
  projectDir: string;
  appDir: string;
  publicDir: string;
  /** deno.json used for bundling (project's own, else the framework's). */
  configPath: string;
  /** Build output directory. */
  outDir: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveProject(projectDir: string): Promise<ProjectPaths> {
  const appDir = join(projectDir, "app");
  const publicDir = join(projectDir, "public");

  const projectConfig = join(projectDir, "deno.json");
  const configPath = (await exists(projectConfig))
    ? projectConfig
    : join(frameworkRoot(), "deno.json");

  return {
    projectDir,
    appDir,
    publicDir,
    configPath,
    outDir: join(projectDir, ".denext"),
  };
}

/** Stable per-route id used in client bundle URLs and filenames. */
export function routeId(routePath: string): string {
  if (routePath === "/") return "index";
  return routePath
    .slice(1)
    .replace(/\//g, "__")
    .replace(/\[\[?\.\.\./g, "catchall_")
    .replace(/[\[\]]/g, "_");
}
