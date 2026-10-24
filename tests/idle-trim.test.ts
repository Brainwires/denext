// The production server's idle trim (src/build/idle-trim.ts): which runtimes get it, the opt-outs,
// and where it is turned on — the `denext start` child's environment, the `build --compile` flags,
// the Docker image — and where it is not (`dev`, stock Deno, an older pin, a SPA image).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { FIRST_IDLE_TRIM_RUNTIME, supportsIdleTrim } from "../src/build/deno-version.ts";
import {
  configDisablesIdleTrim,
  configTextDisablesIdleTrim,
  IDLE_TRIM_ENV,
  IDLE_TRIM_FLAG,
  idleTrimCompileFlags,
  idleTrimEnv,
  type IdleTrimInputs,
  idleTrimOn,
  pinnedIdleTrim,
} from "../src/build/idle-trim.ts";
import { renderDockerfile } from "../src/build/docker-template.ts";
import { resolveDocker } from "../src/build/docker-detect.ts";
import { startIdleTrimEnv } from "../src/cli/run-verb.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import toolchainPin from "../src/build/deno-toolchain-pin.json" with { type: "json" };

const noEnv = (_: string) => undefined;
const inputs = (over: Partial<IdleTrimInputs> = {}): IdleTrimInputs => ({
  runtime: "3.0.0-rc.5",
  configOff: false,
  env: noEnv,
  ...over,
});

Deno.test("idle trim: denext's Deno from 3.0.0-rc.5 has it", () => {
  assertEquals(FIRST_IDLE_TRIM_RUNTIME, "3.0.0-rc.5");
  for (const v of ["3.0.0-rc.5", "3.0.0-rc.6", "3.0.0-rc.10", "3.0.0", "3.1.0"]) {
    assert(supportsIdleTrim(v), v);
  }
  for (const v of ["3.0.0-rc.4", "3.0.0-rc.1", "2.9.7-denext.22", "2.9.7", "garbage", ""]) {
    assert(!supportsIdleTrim(v), v);
  }
});

Deno.test("idle trim: on for a new enough toolchain unless an opt-out says otherwise", () => {
  assert(idleTrimOn(inputs()));
  // Stock Deno, a DENEXT_DENO=<path> binary of unknown version, an older runtime: off.
  assert(!idleTrimOn(inputs({ runtime: undefined })));
  assert(!idleTrimOn(inputs({ runtime: "path" })));
  assert(!idleTrimOn(inputs({ runtime: "3.0.0-rc.4" })));
  // `start: { idleTrim: false }`, DENEXT_IDLE_TRIM=0: off. Any other value leaves it on.
  assert(!idleTrimOn(inputs({ configOff: true })));
  assert(!idleTrimOn(inputs({ env: (n) => n === "DENEXT_IDLE_TRIM" ? "0" : undefined })));
  assert(idleTrimOn(inputs({ env: (n) => n === "DENEXT_IDLE_TRIM" ? "1" : undefined })));
});

Deno.test("idle trim: the start child's environment, the user's own value standing", () => {
  assertEquals(idleTrimEnv(inputs()), { [IDLE_TRIM_ENV]: "1" });
  assertEquals(idleTrimEnv(inputs({ runtime: undefined })), {});
  assertEquals(idleTrimEnv(inputs({ runtime: "3.0.0-rc.4" })), {});
  assertEquals(idleTrimEnv(inputs({ configOff: true })), {});
  // DENO_UNSTABLE_IDLE_TRIM already set (to anything, `0` included): nothing is added.
  for (const value of ["0", "1", ""]) {
    assertEquals(
      idleTrimEnv(inputs({ env: (n) => n === IDLE_TRIM_ENV ? value : undefined })),
      {},
      value,
    );
  }
});

Deno.test("idle trim: a compiled executable gets the flag baked in, off the toolchain nothing", () => {
  assertEquals(idleTrimCompileFlags(inputs()), [IDLE_TRIM_FLAG]);
  assertEquals(IDLE_TRIM_FLAG, "--unstable-idle-trim");
  assertEquals(idleTrimCompileFlags(inputs({ runtime: undefined })), []);
  assertEquals(idleTrimCompileFlags(inputs({ runtime: "3.0.0-rc.3" })), []);
  assertEquals(idleTrimCompileFlags(inputs({ configOff: true })), []);
  assertEquals(
    idleTrimCompileFlags(inputs({ env: (n) => n === "DENEXT_IDLE_TRIM" ? "0" : undefined })),
    [],
  );
});

Deno.test("idle trim: generated files follow the pinned toolchain", () => {
  assertEquals(pinnedIdleTrim(false, noEnv), supportsIdleTrim(toolchainPin.version));
  assert(pinnedIdleTrim(false, noEnv, "3.0.0-rc.5"));
  assert(!pinnedIdleTrim(false, noEnv, "3.0.0-rc.4"));
  assert(!pinnedIdleTrim(true, noEnv, "3.0.0-rc.5"));
  assert(!pinnedIdleTrim(false, (n) => n === "DENEXT_IDLE_TRIM" ? "0" : undefined, "3.0.0-rc.5"));
});

Deno.test("idle trim: the config's opt-out is read from its text", async () => {
  assert(configTextDisablesIdleTrim("export default { start: { idleTrim: false } };"));
  assert(configTextDisablesIdleTrim("start: {\n  idleTrim:false,\n}"));
  assert(!configTextDisablesIdleTrim("export default { start: { idleTrim: true } };"));
  assert(!configTextDisablesIdleTrim("export default {};"));
  const dir = await Deno.makeTempDir();
  try {
    assert(!(await configDisablesIdleTrim(dir)), "no config: nothing opts out");
    await Deno.writeTextFile(join(dir, "denext.config.ts"), "export default {};\n");
    assert(!(await configDisablesIdleTrim(dir)));
    await Deno.writeTextFile(
      join(dir, "denext.config.mjs"),
      "export default { start: { idleTrim: false } };\n",
    );
    assert(await configDisablesIdleTrim(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("idle trim: only the `start` verb's child gets it", async () => {
  const dir = await Deno.makeTempDir();
  const verb = (name: string, source?: "core" | "plugin" | "project") => ({
    name,
    summary: "",
    run: () => {},
    ...(source ? { source } : {}),
  });
  try {
    const expected: Record<string, string> = Deno.env.get(IDLE_TRIM_ENV) !== undefined ||
        Deno.env.get("DENEXT_IDLE_TRIM") === "0"
      ? {}
      : { [IDLE_TRIM_ENV]: "1" };
    assertEquals(await startIdleTrimEnv(verb("start"), dir, "3.0.0-rc.5"), expected);
    // Not for dev, profile, test or jobs; not for a project's own `start` verb.
    for (const name of ["dev", "profile", "test", "job", "build"]) {
      assertEquals(await startIdleTrimEnv(verb(name), dir, "3.0.0-rc.5"), {}, name);
    }
    assertEquals(await startIdleTrimEnv(verb("start", "project"), dir, "3.0.0-rc.5"), {});
    // Stock Deno and older runtimes: nothing.
    assertEquals(await startIdleTrimEnv(verb("start"), dir, undefined), {});
    assertEquals(await startIdleTrimEnv(verb("start"), dir, "3.0.0-rc.4"), {});
    // The project's opt-out.
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      "export default { start: { idleTrim: false } };\n",
    );
    assertEquals(await startIdleTrimEnv(verb("start"), dir, "3.0.0-rc.5"), {});
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("idle trim: the Docker server image sets it, the static one never", async () => {
  const on = renderDockerfile({ mode: "server", idleTrim: true });
  assertStringIncludes(on, "\nENV DENO_UNSTABLE_IDLE_TRIM=1\n");
  // After the toolchain is on PATH, before the CMD.
  assert(on.indexOf("ENV DENO_UNSTABLE_IDLE_TRIM=1") > on.indexOf("toolchain-bin:$PATH"), on);
  assert(on.indexOf("ENV DENO_UNSTABLE_IDLE_TRIM=1") < on.indexOf("\nCMD "), on);
  assert(!renderDockerfile({ mode: "server" }).includes(IDLE_TRIM_ENV));
  assert(!renderDockerfile({ mode: "server", idleTrim: false }).includes(IDLE_TRIM_ENV));
  assert(!renderDockerfile({ mode: "static", idleTrim: true }).includes(IDLE_TRIM_ENV));

  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    const expected = pinnedIdleTrim(false, (n) => Deno.env.get(n));
    assertEquals((await resolveDocker(dir, { target: "server" })).options.idleTrim, expected);
    assertEquals((await resolveDocker(dir, { target: "spa" })).options.idleTrim, undefined);
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      "export default { start: { idleTrim: false } };\n",
    );
    assertEquals((await resolveDocker(dir, { target: "server" })).options.idleTrim, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("idle trim: `start.idleTrim` must be a boolean", () => {
  const check = (config: unknown) => () => validateDenextConfig(config as DenextConfig);
  check({ start: {} })();
  check({ start: { idleTrim: false } })();
  check({ start: { idleTrim: true } })();
  let message = "";
  try {
    check({ start: { idleTrim: "no" } })();
  } catch (e) {
    message = (e as Error).message;
  }
  assertStringIncludes(message, "`start.idleTrim` must be a boolean");
  message = "";
  try {
    check({ start: false })();
  } catch (e) {
    message = (e as Error).message;
  }
  assertStringIncludes(message, "`start` must be an object");
});
