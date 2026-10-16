// tests/fixtures/deploy-app as a project: a temp copy with a fake build (client chunks, a font,
// an emitted file) and the config its `denext.config.ts` would export — for the deploy manifest
// and preset tests.

import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import type { ProjectPaths } from "../../src/build/paths.ts";
import type { DenextConfig } from "../../src/server/config.ts";

const FIXTURE = fromFileUrl(new URL("../fixtures/deploy-app/", import.meta.url));

/** The fixture's config (what `denext.config.ts` would export). */
const DEPLOY_FIXTURE_CONFIG: DenextConfig = {
  scheduledJobs: { "0 0 * * 1": ["digest"], "0 3 * * *": "cleanup" },
  images: { remotePatterns: [{ hostname: "images.example.com" }], domains: ["cdn.example.com"] },
  compile: { permissions: { write: ["data"] } },
};

/**
 * A temp copy of the fixture with a fake build. The caller removes `projectDir`.
 *
 * @param config The config to resolve it with.
 * @returns The project's paths.
 */
export async function fixtureProject(
  config: DenextConfig = DEPLOY_FIXTURE_CONFIG,
): Promise<ProjectPaths> {
  const dir = await Deno.makeTempDir({ prefix: "denext-deploy-" });
  await copy(FIXTURE, dir, { overwrite: true });
  const out = join(dir, ".denext");
  await Deno.mkdir(join(out, "client", "_fonts"), { recursive: true });
  await Deno.mkdir(join(out, "emitted"), { recursive: true });
  await Deno.writeTextFile(join(out, "client", "page-AB12CD34.js"), "export {};");
  await Deno.writeTextFile(join(out, "client", "page-AB12CD34.js.gz"), "gz");
  await Deno.writeTextFile(join(out, "client", "_fonts", "inter-1234.woff2"), "font");
  await Deno.writeTextFile(join(out, "emitted", "licenses.json"), "{}");
  return {
    projectDir: dir,
    appDir: join(dir, "app"),
    publicDir: join(dir, "public"),
    configPath: join(dir, "deno.json"),
    outDir: out,
    middlewarePath: join(dir, "middleware.ts"),
    instrumentationPath: null,
    instrumentationClientPath: null,
    i18n: null,
    config,
  };
}
