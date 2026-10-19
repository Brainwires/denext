// The deployment guide's Dockerfile (site/app/docs/deploy/content.md, "### Docker") must be
// byte-for-byte what `denext generate docker` writes for a `denext create` project: the same
// dependency-cache layer, least-privilege `start` line, `PORT` handling and shutdown wiring. The
// guide pins the CLI to the major range every other guide uses (`@^<major>.0.0`) and the image to
// the Deno release denext's toolchain is built from, so the comparison holds across patch bumps.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resolveDocker } from "../src/build/docker-detect.ts";
import { renderDockerfile } from "../src/build/docker-template.ts";
import { denoReleaseVersion } from "../src/build/deno-version.ts";
import { denoJson } from "../src/build/scaffold.ts";
import { VERSION } from "../src/version.ts";
import toolchainPin from "../src/build/deno-toolchain-pin.json" with { type: "json" };

const GUIDE = new URL("../site/app/docs/deploy/content.md", import.meta.url);

/** The first ```dockerfile block after the guide's `### Docker` heading. */
function guideDockerfile(text: string): string {
  const section = text.slice(text.indexOf("\n### Docker\n"));
  const m = /```dockerfile\n([\s\S]*?)```/.exec(section);
  if (!m) throw new Error("the deployment guide has no ```dockerfile block under ### Docker");
  return m[1];
}

/** What `denext generate docker` renders for a freshly scaffolded project. */
async function generatedDockerfile(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-docs-docker-" });
  try {
    const major = VERSION.split(".")[0];
    const json = denoJson({ dir }).replaceAll(`@^${VERSION}/`, `@^${major}.0.0/`);
    await Deno.writeTextFile(join(dir, "deno.json"), json);
    const { options } = await resolveDocker(dir, {
      denoTag: denoReleaseVersion(toolchainPin.version),
    });
    return renderDockerfile(options);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("docs: the deployment guide's Dockerfile is `denext generate docker`'s output", async () => {
  assertEquals(
    guideDockerfile(await Deno.readTextFile(GUIDE)),
    await generatedDockerfile(),
    "site/app/docs/deploy/content.md's Dockerfile drifted from src/build/docker-template.ts — " +
      "paste the generator's output into the guide",
  );
});
