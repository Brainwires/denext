// The production server's idle trim (src/build/idle-trim.ts): the opt-outs, and where it is turned
// on — the `denext start` child's environment, the `build --compile` flags, the Docker image — and
// where it is not (`dev`, a SPA image). Every runtime denext 5.0 runs on (3.0.0-rc.5 or later)
// has it, so no runtime gate remains.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  configDisablesIdleTrim,
  configTextDisablesIdleTrim,
  holdOffBakedIdleTrim,
  IDLE_TRIM_ENV,
  IDLE_TRIM_FLAG,
  idleTrimCompileFlags,
  idleTrimEnv,
  type IdleTrimInputs,
  idleTrimOn,
  pinnedIdleTrim,
} from "../src/build/idle-trim.ts";
import { entrySource } from "../src/build/compile-app.ts";
import { renderDockerfile } from "../src/build/docker-template.ts";
import { resolveDocker } from "../src/build/docker-detect.ts";
import { startIdleTrimEnv } from "../src/cli/run-verb.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";

const noEnv = (_: string) => undefined;
const inputs = (over: Partial<IdleTrimInputs> = {}): IdleTrimInputs => ({
  configOff: false,
  env: noEnv,
  ...over,
});

Deno.test("idle trim: on unless an opt-out says otherwise", () => {
  assert(idleTrimOn(inputs()));
  // `start: { idleTrim: false }`, DENEXT_IDLE_TRIM=0: off. Any other value leaves it on.
  assert(!idleTrimOn(inputs({ configOff: true })));
  assert(!idleTrimOn(inputs({ env: (n) => n === "DENEXT_IDLE_TRIM" ? "0" : undefined })));
  assert(idleTrimOn(inputs({ env: (n) => n === "DENEXT_IDLE_TRIM" ? "1" : undefined })));
});

Deno.test("idle trim: the start child's environment, the user's own value standing", () => {
  assertEquals(idleTrimEnv(inputs()), { [IDLE_TRIM_ENV]: "1" });
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

Deno.test("idle trim: a compiled executable gets the flag baked in unless opted out", () => {
  assertEquals(idleTrimCompileFlags(inputs()), [IDLE_TRIM_FLAG]);
  assertEquals(IDLE_TRIM_FLAG, "--unstable-idle-trim");
  assertEquals(idleTrimCompileFlags(inputs({ configOff: true })), []);
  assertEquals(
    idleTrimCompileFlags(inputs({ env: (n) => n === "DENEXT_IDLE_TRIM" ? "0" : undefined })),
    [],
  );
});

Deno.test("idle trim: generated files turn it on unless opted out", () => {
  assert(pinnedIdleTrim(false, noEnv));
  assert(!pinnedIdleTrim(true, noEnv));
  assert(!pinnedIdleTrim(false, (n) => n === "DENEXT_IDLE_TRIM" ? "0" : undefined));
});

Deno.test("idle trim: the config's opt-out is read from its text before a build, comments ignored", async () => {
  assert(configTextDisablesIdleTrim("export default { start: { idleTrim: false } };"));
  assert(configTextDisablesIdleTrim("start: {\n  idleTrim:false,\n}"));
  assert(!configTextDisablesIdleTrim("export default { start: { idleTrim: true } };"));
  assert(!configTextDisablesIdleTrim("export default {};"));
  // A commented-out opt-out opts out of nothing.
  assert(!configTextDisablesIdleTrim("export default { start: {\n  // idleTrim: false,\n} };"));
  assert(!configTextDisablesIdleTrim("export default { /* idleTrim: false */ };"));
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

Deno.test("idle trim: after a build, the evaluated config (the deploy manifest) decides, not the text", async () => {
  const dir = await Deno.makeTempDir();
  const manifest = (idleTrim: boolean) =>
    Deno.writeTextFile(
      join(dir, ".denext", "deploy-manifest.json"),
      JSON.stringify({ server: { idleTrim } }),
    );
  try {
    await Deno.mkdir(join(dir, ".denext"));
    // `start: { idleTrim: isProd ? false : true }`: no literal `idleTrim: false` in the text.
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      "const isProd = true;\nexport default { start: { idleTrim: isProd ? false : true } };\n",
    );
    assert(!(await configDisablesIdleTrim(dir)), "the text alone can't tell");
    await manifest(false);
    assert(await configDisablesIdleTrim(dir), "the build recorded the evaluated opt-out");
    // A commented-out opt-out in the text, the build says on: on.
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      "// idleTrim: false\nexport default {};\n",
    );
    await manifest(true);
    assert(!(await configDisablesIdleTrim(dir)));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("idle trim: DENEXT_IDLE_TRIM=0 when a compiled binary runs holds a baked trim off", () => {
  const timers: number[] = [];
  const every = (_fn: () => void, ms: number) => void timers.push(ms);
  const env = (vars: Record<string, string>) => (n: string) => vars[n];
  assertEquals(holdOffBakedIdleTrim(true, env({ DENEXT_IDLE_TRIM: "0" }), every), true);
  assertEquals(timers, [500], "woken twice per default 1 s idle delay");
  assertEquals(
    holdOffBakedIdleTrim(
      true,
      env({ DENEXT_IDLE_TRIM: "0", DENO_IDLE_TRIM_DELAY_MS: "300" }),
      every,
    ),
    true,
  );
  assertEquals(timers.at(-1), 150, "half the delay the runtime was given");
  assertEquals(holdOffBakedIdleTrim(true, env({}), every), false, "no opt-out: the trim runs");
  assertEquals(holdOffBakedIdleTrim(false, env({ DENEXT_IDLE_TRIM: "0" }), every), false);
  assertEquals(timers.length, 2);
  // The compiled entry tells the binary whether the trim was baked in.
  const baked = entrySource("file:///p/.denext/compile/main.ts", "file:///p/", true);
  assertStringIncludes(baked, "Deno.args, { idleTrimBaked: true });");
  assert(!entrySource("file:///p/.denext/compile/main.ts", "file:///p/").includes("idleTrimBaked"));
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
    assertEquals(await startIdleTrimEnv(verb("start"), dir), expected);
    // Not for dev, profile, test or jobs; not for a project's own `start` verb.
    for (const name of ["dev", "profile", "test", "job", "build"]) {
      assertEquals(await startIdleTrimEnv(verb(name), dir), {}, name);
    }
    assertEquals(await startIdleTrimEnv(verb("start", "project"), dir), {});
    // The project's opt-out.
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      "export default { start: { idleTrim: false } };\n",
    );
    assertEquals(await startIdleTrimEnv(verb("start"), dir), {});
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
