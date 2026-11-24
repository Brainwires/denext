// `denext doctor` names the deploy files generated before denext 4.21 (`denext … toolchain
// path`, a verb 4.21 removed), which fail the image build or the host's build.sh, and says how to
// regenerate them; current files (`runtime path`) and projects without any pass silently.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { staleDeployFilesCheck } from "../src/cli/commands/doctor.ts";
import { renderDockerfile } from "../src/build/docker-template.ts";

const OLD_DOCKER_LINE =
  'RUN mkdir -p /deno-dir/toolchain-bin && \\\n  ln -sf "$(deno run -A jsr:@denext/denext/cli toolchain path)" /deno-dir/toolchain-bin/deno\n';
const OLD_BUILD_SH =
  `ln -sf "$(deno run -A 'jsr:@denext/denext@4.20.0/cli' toolchain path)" "/srv/app/.toolchain"\n`;

Deno.test("doctor: deploy files that still run the removed `toolchain` verb are named, with the fix", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_doctor_deploy_" });
  const outDir = join(dir, ".denext");
  try {
    assertEquals(await staleDeployFilesCheck(dir, outDir), null, "no deploy files");
    // What this denext generates passes.
    await Deno.writeTextFile(join(dir, "Dockerfile"), renderDockerfile({ mode: "server" }));
    assertEquals(await staleDeployFilesCheck(dir, outDir), null, "a current Dockerfile");
    // One generated before 4.21, and a preset's build.sh from then.
    await Deno.writeTextFile(join(dir, "Dockerfile"), `FROM denoland/deno\n${OLD_DOCKER_LINE}`);
    await Deno.mkdir(join(outDir, "deploy", "generic-host"), { recursive: true });
    const buildSh = join(outDir, "deploy", "generic-host", "build.sh");
    await Deno.writeTextFile(buildSh, OLD_BUILD_SH);
    const check = await staleDeployFilesCheck(dir, outDir);
    assert(check);
    assertEquals([check.name, check.ok, check.critical], ["deploy files", false, false]);
    assertStringIncludes(check.detail, join(dir, "Dockerfile"));
    assertStringIncludes(check.detail, buildSh);
    assertStringIncludes(check.detail, "denext generate docker --force");
    assertStringIncludes(check.detail, "denext deploy prepare");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
